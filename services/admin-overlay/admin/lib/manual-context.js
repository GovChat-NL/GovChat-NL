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
    // apply-minimal-ui explicitly keeps the GovChat upload endpoints enabled. These
    // instructions require no sharing/management role; file actions still enforce ownership.
    if (minimal) capabilities.push("upload", "files");
    // These are trusted, existing backend product configurations, not manual settings.
    try { for (const [key, enabled] of Object.entries(readTools()?.tools || {})) if (enabled === true && ["nos_news", "l1_news", "time", "holidays", "calculator"].includes(key)) capabilities.push(key); } catch { /* safe subset */ }
    return { capabilities, rights: [] };
  }
  async function user(req) {
    const authorization = req.get("authorization");
    if (!/^Bearer [^\s]{1,8192}$/i.test(authorization || "")) return null;
    let identity;
    try { identity = await request("/api/user", authorization); } catch { return null; }
    if (!identity?.id || typeof identity.role !== "string") return null;
    const context = general();
    try {
      const [config, role, files] = await Promise.all([request("/api/config", authorization), request(`/api/roles/${encodeURIComponent(identity.role)}`, authorization), request("/api/files/config", authorization)]);
      if (!config || !role) throw new Error("Effective context missing");
      const ui = config.interface || {};
      if (ui.prompts === true) context.capabilities.push("prompts");
      for (const key of ["temporaryChat", "sharedLinks", "webSearch", "fileSearch"]) if (!minimal && ui[key] === true) context.capabilities.push(key);
      if (!minimal && ui.modelSelect === true) context.capabilities.push("models");
      const endpoint = files?.endpoints?.["govchat-orchestrator"] || files?.endpoints?.custom || files?.endpoints?.agents || files?.endpoints?.default;
      if (files === null || endpoint?.disabled !== true) context.capabilities.push("upload", "files");
      const permissions = role.permissions?.PROMPTS || role.PROMPTS || {};
      for (const [key, right] of [["USE", "use"], ["CREATE", "create"], ["CREATE", "edit"], ["SHARE", "share"], ["SHARE_PUBLIC", "sharePublic"]]) if (permissions[key] === true) context.rights.push(`prompts.${right}`);
      // Apps are visible only from existing trusted app config; no webhook tokens leave here.
      const apps = readApps();
      if (apps?.enabled === true) for (const app of apps.apps || []) if (app.enabled !== false) {
        const key = { beleidskompas: "beleidskompas", versimpelaar: "simplifier", transcriptie: "transcript", "afbeelding-generator": "image" }[app.id];
        // A launcher entry is not sufficient evidence that an optional backend works.
        if (key && (!["image", "transcript"].includes(key) || readFeatures()[key] === true)) context.capabilities.push(key);
      }
    } catch { /* authenticated safe generally available subset only */ }
    return { ...context, capabilities: [...new Set(context.capabilities)], userId: identity.id };
  }
  return { user, general };
}
module.exports = { createManualContext };
