"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const express = require("express");
const { createManualStore } = require("../../services/admin-overlay/admin/lib/manual-store");
const { registerManualRoutes } = require("../../services/admin-overlay/admin/lib/manual-routes");
const { createManualContext } = require("../../services/admin-overlay/admin/lib/manual-context");
const { fixture } = require("./fixture");
test("real HTTP: separate auth, no public content, same revision, safe subset, conflicts and disable", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-api-"));
  const store = createManualStore({ dataDir: path.join(root, "private"), publishDir: path.join(root, "public") }); store.init();
  store.publish(store.save(fixture(), store.adminState()));
  const context = { general: () => ({ capabilities: ["chat"], rights: [] }), user: async req => req.get("authorization") === "Bearer valid-user" ? { capabilities: ["chat", "upload", "prompts"], rights: ["prompts.share"] } : null };
  const app = express(); app.use(express.json()); registerManualRoutes(app, { store, context, isAuthenticated: req => req.get("cookie") === "session=admin", token: "internal-only" });
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = { cookie: "session=admin", "content-type": "application/json" }, user = { authorization: "Bearer valid-user" }, internal = { authorization: "Bearer internal-only", "content-type": "application/json" };
  async function request(url, options = {}, status = 200) { const res = await fetch(base + url, options); assert.equal(res.status, status, url); assert.match(res.headers.get("cache-control"), /no-store/); return res.json(); }
  const meta = await request("/api/manual/config"); assert.deepEqual(Object.keys(meta).sort(), ["ok", "schemaVersion", "enabled", "revision", "autoOpen", "agentEnabled"].sort());
  for (const headers of [{}, admin, internal]) await request("/api/manual/document", { headers }, 401);
  await request("/api/admin/manual", { headers: internal }, 401);
  await request("/api/internal/manual", { method: "POST", headers: admin, body: '{"action":"toc"}' }, 401);
  await request("/api/admin/manual/publish", { method: "POST", headers: { ...admin, origin: "https://evil.invalid" }, body: "{}" }, 403);
  const doc = await request("/api/manual/document", { headers: user }); assert.ok(doc.passages.some(p => p.id === "secret"));
  const agent = await request("/api/internal/manual", { method: "POST", headers: internal, body: '{"action":"toc"}' }); assert.equal(agent.revision, doc.revision); assert.ok(!JSON.stringify(agent).includes("secret"));
  await request("/api/internal/manual", { method: "POST", headers: internal, body: '{"action":"get","id":"secret"}' }, 404);
  await request("/api/internal/manual", { method: "POST", headers: internal, body: '{"action":"get","id":"secret","roles":["ADMIN"]}' }, 400);
  const source = await request("/api/internal/manual", { method: "POST", headers: internal, body: '{"action":"get","id":"intro"}' }); assert.equal(source.passage.html, undefined); assert.match(source.passage.href, /^\/c\/new\?manual=intro&manualRevision=/);
  const state = await request("/api/admin/manual", { headers: admin }); const saved = await request("/api/admin/manual/draft", { method: "PUT", headers: admin, body: JSON.stringify({ ...state, model: fixture() }) });
  await request("/api/admin/manual/publish", { method: "POST", headers: admin, body: JSON.stringify(state) }, 409);
  const published = await request("/api/admin/manual/publish", { method: "POST", headers: admin, body: JSON.stringify(saved) });
  await request(`/api/manual/get?id=intro&revision=${doc.revision}`, { headers: user }, 409);
  await request("/api/admin/manual/disable", { method: "POST", headers: admin, body: JSON.stringify(published) });
  await request("/api/manual/document", { headers: user }, 404);
  await request("/api/internal/manual", { method: "POST", headers: internal, body: '{"action":"get","id":"intro"}' }, 404);
  assert.equal((await request("/api/manual/config")).agentEnabled, false);
});
test("trusted context delegates to LibreChat JWT/user and role APIs; forged roles are ignored", async () => {
  const requests = [];
  const context = createManualContext({ baseUrl: "http://trusted", minimal: true, readTools: () => ({ tools: { time: true, nos_news: false } }), readApps: () => ({ enabled: true, apps: [{ id: "beleidskompas" }] }),
    fetchImpl: async (url, options) => {
      requests.push([url, options.headers.authorization]);
      const payload = url.endsWith("/api/user") ? { id: "verified", role: "CUSTOM" } : url.endsWith("/api/config") ? { interface: { prompts: true, temporaryChat: true, sharedLinks: true, modelSelect: true } } : url.includes("/api/roles/") ? { permissions: { PROMPTS: { USE: true, CREATE: false, SHARE: false } } } : { endpoints: { default: { disabled: false } } };
      return { ok: true, text: async () => JSON.stringify(payload) };
    } });
  const req = { get: key => key === "authorization" ? "Bearer validated-access-token" : undefined, body: { role: "ADMIN" } };
  const user = await context.user(req); assert.equal(user.userId, "verified"); assert.deepEqual(user.rights, ["prompts.use"]); assert.ok(user.capabilities.includes("upload")); assert.ok(!user.capabilities.includes("temporaryChat")); assert.ok(user.capabilities.includes("beleidskompas"));
  assert.ok(requests.some(([url]) => url.endsWith("/api/roles/CUSTOM"))); assert.ok(!requests.some(([url]) => url.includes("ADMIN")));
  assert.equal(await context.user({ get: () => undefined, cookies: { refreshToken: "forged" } }), null);
  const unavailable = createManualContext({ baseUrl: "http://trusted", fetchImpl: async () => { throw new Error("offline"); } }); assert.equal(await unavailable.user(req), null);
});
test("authenticated identity with missing effective configuration falls back to safe subset", async () => {
  const context = createManualContext({ baseUrl: "http://trusted", fetchImpl: async url => {
    if (url.endsWith("/api/user")) return { ok: true, text: async () => JSON.stringify({ id: "user", role: "USER" }) };
    throw new Error("config offline");
  } });
  const user = await context.user({ get: () => "Bearer x" }); assert.deepEqual(user.capabilities, ["chat", "history"]); assert.deepEqual(user.rights, []);
});
test("pinned empty files/config means default upload config; minimal agent can read general document instructions", async () => {
  const context = createManualContext({ baseUrl: "http://trusted", minimal: true, fetchImpl: async url => ({ ok: true, text: async () => url.endsWith("/api/user") ? JSON.stringify({ id: "u", role: "USER" }) : url.endsWith("/api/files/config") ? "" : url.endsWith("/api/config") ? '{"interface":{"prompts":true}}' : '{"permissions":{"PROMPTS":{"USE":true}}}' }) });
  const user = await context.user({ get: () => "Bearer x" }); assert.ok(user.capabilities.includes("upload")); assert.ok(user.rights.includes("prompts.use"));
  assert.ok(context.general().capabilities.includes("files")); assert.deepEqual(context.general().rights, []);
});
