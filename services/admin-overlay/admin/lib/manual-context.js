"use strict";

// Delegate access-token verification/revocation/tenant handling to pinned LibreChat.
// Do not reuse the older refresh-token-only helper: it cannot establish current rights.
function createManualContext({ baseUrl, fetchImpl = fetch, minimal = false, readTools = () => null, readApps = () => null, readFeatures = () => ({}) }) {
  async function request(path, authorization) {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, { headers: { authorization, accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error("Trusted LibreChat context unavailable");
    const body = await response.text(); if (body.length > 250000) throw new Error("Context too large");
    // The pinned /api/files/config sends an empty 200 body for undefined YAML
    // fileConfig. That means its known default, NOT a transport failure.
    return body.trim() ? JSON.parse(body) : null;
  }
  function general() {
    const capabilities = ["chat", "history"];
    // UI visibility cannot override disabled/unknown effective upload configuration.
    // The agent has no authenticated file configuration; keep these passages closed.
    // These are trusted, existing backend product configurations, not manual settings.
    try { for (const [key, enabled] of Object.entries(readTools()?.tools || {})) if (enabled === true && ["nos_news", "l1_news", "time", "holidays", "calculator"].includes(key)) capabilities.push(key); } catch { /* safe subset */ }
    return { capabilities, rights: [] };
  }
  const object = value => value && typeof value === "object" && !Array.isArray(value);
  const validIdentity = identity => object(identity) && typeof identity.id === "string" && identity.id.length > 0 && identity.id.length <= 200 &&
    typeof identity.role === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(identity.role) &&
    identity.disabled !== true && identity.banned !== true && identity.active !== false;
  async function agent() {
    // Public product configuration proves visibility, NOT anyone's PROMPTS.USE.
    // Grant only the generic capability; all guidance comes from the compiler.
    const context = general();
    let state = "unknown";
    try {
      const config = await request("/api/config", "");
      if (object(config) && object(config.interface) && typeof config.interface.prompts === "boolean") state = config.interface.prompts ? "user-dependent" : "disabled";
      if (state === "user-dependent") context.capabilities.push("prompts");
    } catch { /* availability remains unknown; no cached privilege fallback */ }
    return { ...context, scope: "common", availability: { promptLibrary: { state } } };
  }
  async function user(req) {
    const authorization = req.get("authorization");
    if (!/^Bearer [^\s]{1,8192}$/i.test(authorization || "")) return null;
    let identity;
    try { identity = await request("/api/user", authorization); } catch { return null; }
    if (!validIdentity(identity)) return null;
    let context = general();
    try {
      const [config, role, files] = await Promise.all([request("/api/config", authorization), request(`/api/roles/${encodeURIComponent(identity.role)}`, authorization), request("/api/files/config", authorization)]);
      if (!object(config) || !object(role) || (role.name !== undefined && role.name !== identity.role)) throw new Error("Effective context missing");
      // Build separately: failures below must not retain partially granted rights.
      const effective = general();
      const ui = config.interface || {};
      if (!object(ui)) throw new Error("Invalid interface context");
      if (ui.prompts === true) effective.capabilities.push("prompts");
      for (const key of ["temporaryChat", "sharedLinks", "webSearch", "fileSearch"]) if (!minimal && ui[key] === true) effective.capabilities.push(key);
      if (!minimal && ui.modelSelect === true) effective.capabilities.push("models");
      if (files !== null && (!object(files) || (files.disabled !== undefined && typeof files.disabled !== "boolean") || (files.endpoints !== undefined && !object(files.endpoints)))) throw new Error("Invalid file context");
      const endpoint = files?.endpoints?.["govchat-orchestrator"] ?? files?.endpoints?.custom ?? files?.endpoints?.default;
      if (endpoint !== undefined && (!object(endpoint) || (endpoint.disabled !== undefined && typeof endpoint.disabled !== "boolean"))) throw new Error("Invalid endpoint context");
      if (files?.disabled !== true && endpoint?.disabled !== true) effective.capabilities.push("upload", "files");
      const permissions = role.permissions?.PROMPTS || role.PROMPTS || {};
      if (!object(permissions)) throw new Error("Invalid role context");
      for (const [key, right] of [["USE", "use"], ["CREATE", "create"], ["CREATE", "edit"], ["SHARE", "share"], ["SHARE_PUBLIC", "sharePublic"]]) if (ui.prompts === true && permissions[key] === true) effective.rights.push(`prompts.${right}`);
      // Apps are visible only from existing trusted app config; no webhook tokens leave here.
      const apps = readApps();
      if (apps?.enabled === true) for (const app of apps.apps || []) if (app.enabled !== false) {
        const key = { beleidskompas: "beleidskompas", versimpelaar: "simplifier", transcriptie: "transcript", "afbeelding-generator": "image" }[app.id];
        // A launcher entry is not sufficient evidence that an optional backend works.
        if (key && key !== "transcript" && (key !== "image" || readFeatures().image === true)) effective.capabilities.push(key);
      }
      context = effective;
    } catch { /* authenticated safe generally available subset only */ }
    // Detect deletion/revocation or an identity/role change during the context reads.
    // This is not an atomic authorization snapshot; LibreChat remains the authority.
    let current;
    try { current = await request("/api/user", authorization); } catch { return null; }
    if (!validIdentity(current) || current.id !== identity.id || current.role !== identity.role || current.tenantId !== identity.tenantId) return null;
    return { ...context, capabilities: [...new Set(context.capabilities)], userId: identity.id };
  }
  return { user, general, agent };
}
module.exports = { createManualContext };
