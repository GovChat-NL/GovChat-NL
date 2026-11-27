"use strict";
const { ManualError, ID } = require("./manual-model");
const { safeTokenEqual } = require("./utility-tools");
function readManual(document, request, agent = false) {
  const allowed = ["action", "query", "id", "revision", "limit"];
  if (!request || typeof request !== "object" || Array.isArray(request) || Object.keys(request).some(k => !allowed.includes(k))) throw new ManualError("INVALID_INPUT", "Onbekende handleidinginvoer");
  const action = request.action || "toc";
  if (!["toc", "search", "get"].includes(action)) throw new ManualError("INVALID_INPUT", "Onbekende handleidingactie");
  if (request.revision !== undefined && request.revision !== document.revision) throw new ManualError("REVISION_CHANGED", "De handleiding is gewijzigd; open de actuele inhoudsopgave", 409);
  const limit = request.limit === undefined ? (agent ? 5 : 20) : Number(request.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > (agent ? 8 : 50)) throw new ManualError("INVALID_INPUT", "Ongeldige resultaatlimiet");
  const base = { ok: true, revision: document.revision };
  const passage = p => agent ? { id: p.id, title: p.title, text: p.text.slice(0, 12000), truncated: p.text.length > 12000, href: p.href, related: p.related.slice(0, 10) } : p;
  if (action === "toc") return { ...base, title: document.title, subtitle: document.subtitle, autoOpen: document.autoOpen, reviewedAt: document.reviewedAt, sections: agent ? document.sections.map(s => ({ id: s.id, title: s.title.slice(0, 120), itemCount: s.items.length })) : document.sections, errorCategories: agent ? document.errorCategories.map(c => ({ id: c.id, title: c.title.slice(0, 120), count: c.articles.length })) : document.errorCategories };
  if (action === "get") {
    if (typeof request.id !== "string" || !ID.test(request.id)) throw new ManualError("INVALID_INPUT", "Ongeldig passage-ID");
    const found = document.passages.find(p => p.id === request.id || p.aliases.includes(request.id));
    if (!found) throw new ManualError("PASSAGE_NOT_FOUND", "Deze passage is niet beschikbaar; open de inhoudsopgave", 404);
    return { ...base, passage: passage(found) };
  }
  if (typeof request.query !== "string" || !request.query.trim() || request.query.length > 200) throw new ManualError("INVALID_INPUT", "Zoektekst moet 1–200 tekens bevatten");
  const words = request.query.toLocaleLowerCase("nl").trim().split(/\s+/).slice(0, 20);
  const ranked = document.passages.map(p => {
    const title = p.title.toLocaleLowerCase("nl"), text = [p.text, ...p.codes, ...p.messages, ...p.aliases].join(" ").toLocaleLowerCase("nl");
    return { p, score: words.every(w => title.includes(w) || text.includes(w)) ? words.reduce((sum, w) => sum + (title.includes(w) ? 3 : 1), 0) : 0 };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  return { ...base, results: ranked.slice(0, limit).map(({ p }) => ({ id: p.id, title: p.title, snippet: p.text.slice(0, 240), href: p.href })), total: ranked.length };
}
function registerManualRoutes(app, { store, context, isAuthenticated, token, publicBaseUrl = "" }) {
  const paths = ["/api/manual", "/api/admin/manual", "/api/internal/manual"];
  app.use(paths, (req, res, next) => { res.set("Cache-Control", "private, no-store"); res.set("Vary", "Authorization, Cookie"); res.set("X-Content-Type-Options", "nosniff"); next(); });
  function sameOrigin(req) {
    const origin = req.get("origin"), site = req.get("sec-fetch-site");
    if (site && !["same-origin", "none"].includes(site)) return false;
    if (!origin) return !site || site === "none" || site === "same-origin";
    try { const expected = publicBaseUrl ? new URL(publicBaseUrl).origin : `${req.protocol}://${req.get("host")}`; return new URL(origin).origin === origin && origin === expected; } catch { return false; }
  }
  const wrap = fn => async (req, res) => {
    try { return res.json(await fn(req)); } catch (e) { return res.status(e instanceof ManualError ? e.status : 503).json({ ok: false, error: { code: e instanceof ManualError ? e.code : "MANUAL_UNAVAILABLE", message: e instanceof ManualError ? e.message : "De handleiding is tijdelijk niet beschikbaar" }, fallback: "/c/new?manual=toc" }); }
  };
  const admin = (req, res, next) => {
    if (!isAuthenticated(req)) return res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED", message: "Beheerdersaanmelding vereist" } });
    if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: { code: "CROSS_ORIGIN", message: "Cross-site verzoek geweigerd" } });
    if (req.method !== "GET" && !req.is("application/json")) return res.status(415).json({ ok: false, error: { code: "JSON_REQUIRED", message: "JSON vereist" } });
    next();
  };
  const user = wrap(async req => {
    if (!sameOrigin(req)) throw new ManualError("CROSS_ORIGIN", "Cross-site verzoek geweigerd", 403);
    const trusted = await context.user(req);
    if (!trusted) throw new ManualError("UNAUTHORIZED", "Meld je aan om de handleiding te lezen", 401);
    const document = store.document(trusted);
    if (req.params.action === "document") return { ok: true, ...document };
    return readManual(document, { ...req.query, action: req.params.action || "toc" });
  });
  app.get("/api/manual/config", wrap(() => ({ ok: true, ...store.metadata() })));
  app.get("/api/manual/:action(toc|search|get|document)", user);
  app.post("/api/internal/manual", wrap(req => {
    if (!token) throw new ManualError("AUTH_NOT_CONFIGURED", "Interne authenticatie ontbreekt", 503);
    if (!safeTokenEqual(req.get("authorization")?.replace(/^Bearer /i, ""), token)) throw new ManualError("UNAUTHORIZED", "Niet geautoriseerd", 401);
    // Request schema contains no roles/capabilities/user IDs. Never trust tool-supplied context.
    return readManual(store.document({ ...context.general(), agent: true }), req.body, true);
  }));
  app.get("/api/admin/manual", admin, wrap(() => ({ ok: true, ...store.adminState() })));
  app.get("/api/admin/manual/export", admin, wrap(() => ({ ok: true, model: store.adminState().model })));
  app.put("/api/admin/manual/draft", admin, wrap(req => ({ ok: true, ...store.save(req.body.model, req.body) })));
  app.post("/api/admin/manual/import", admin, wrap(req => ({ ok: true, ...store.save(req.body.model?.schemaVersion === undefined ? require("./manual-model").migrate(req.body.model) : req.body.model, req.body, "admin-import") })));
  app.post("/api/admin/manual/preview", admin, wrap(req => ({ ok: true, ...store.preview(req.body.model, context.general()) })));
  app.post("/api/admin/manual/publish", admin, wrap(req => ({ ok: true, ...store.publish(req.body) })));
  app.post("/api/admin/manual/rollback", admin, wrap(req => ({ ok: true, ...store.publish(req.body, req.body.revision) })));
  app.post("/api/admin/manual/disable", admin, wrap(req => ({ ok: true, ...store.disable(req.body) })));
  app.post("/api/admin/manual/reset", admin, wrap(req => ({ ok: true, ...store.reset(req.body.path, req.body) })));
}
module.exports = { registerManualRoutes, readManual };
