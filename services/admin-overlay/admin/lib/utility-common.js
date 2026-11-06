"use strict";

class ToolError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function invalid(message) { throw new ToolError("INVALID_INPUT", message); }
function bodyObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Request body must be an object");
}
function text(value, label, maximum = 200) {
  if (typeof value !== "string" || value.length > maximum || !value.trim()) invalid(`Invalid ${label}`);
  return value.trim();
}

// An instance holds at most maxEntries bounded responses; errors are never cached.
function createSourceClient({ fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 10000, maxBytes = 2 * 1024 * 1024, maxEntries = 64 } = {}) {
  const cache = new Map();
  async function get(url, { ttl, allowed, format = "json" }) {
    if (!allowed(new URL(url))) throw new ToolError("SOURCE_URL_REJECTED", "Source URL is not allowed", 502);
    const cached = cache.get(url);
    if (cached && now() - cached.at < ttl) return { ...cached.result, cache: { hit: true, ttl_seconds: ttl / 1000 } };
    cache.delete(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let current = url;
      let response;
      for (let redirects = 0; redirects <= 3; redirects++) {
        response = await fetchImpl(current, { signal: controller.signal, redirect: "manual", headers: { Accept: format === "json" ? "application/json" : "application/rss+xml, application/xml, text/xml" } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || redirects === 3) throw new ToolError("SOURCE_REDIRECT_REJECTED", "Invalid source redirect", 502);
          const next = new URL(location, current);
          if (!allowed(next)) throw new ToolError("SOURCE_REDIRECT_REJECTED", "Unsafe source redirect", 502);
          current = next.href;
          continue;
        }
        break;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ToolError("SOURCE_HTTP_ERROR", `Source returned HTTP ${response.status}`, 502);
      }
      if (Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        throw new ToolError("SOURCE_TOO_LARGE", "Source response exceeds size limit", 502);
      }
      if (!response.body) throw new ToolError("SOURCE_INVALID_RESPONSE", "Empty source response", 502);
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new ToolError("SOURCE_TOO_LARGE", "Source response exceeds size limit", 502);
        }
        chunks.push(Buffer.from(value));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let data;
      try { data = format === "json" ? JSON.parse(raw) : raw; }
      catch { throw new ToolError("SOURCE_INVALID_RESPONSE", "Source returned invalid JSON", 502); }
      const result = { data, source: current, fetched_at: new Date(now()).toISOString(), cache: { hit: false, ttl_seconds: ttl / 1000 } };
      while (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(url, { at: now(), result });
      return result;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(controller.signal.aborted ? "SOURCE_TIMEOUT" : "SOURCE_UNAVAILABLE", controller.signal.aborted ? "Source request timed out" : "Source request failed", 502);
    } finally { clearTimeout(timer); }
  }
  return { get };
}

module.exports = { ToolError, invalid, bodyObject, text, createSourceClient };
