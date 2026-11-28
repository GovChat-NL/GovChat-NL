"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const express = require("express");
const { createManualContext } = require("../../services/admin-overlay/admin/lib/manual-context");
const { createManualStore } = require("../../services/admin-overlay/admin/lib/manual-store");
const { registerManualRoutes } = require("../../services/admin-overlay/admin/lib/manual-routes");
const { resolve } = require("../../services/admin-overlay/admin/lib/manual-model");
const builder = require("../../scripts/orchestrator-manual-workflow");
const policy = require("../../scripts/n8n-orchestrator-tool-policy");

const req = { get: key => key === "authorization" ? "Bearer current-access" : undefined, body: { userId: "admin", roles: ["ADMIN"], capabilities: ["topdesk"] } };
function adapter(overrides = {}) {
  const payload = { identity: { id: "verified", role: "USER" }, config: { interface: { prompts: true } }, role: { name: "USER", permissions: { PROMPTS: { USE: true, CREATE: true, SHARE: true, SHARE_PUBLIC: true } } }, files: { endpoints: { custom: { disabled: false } } }, ...overrides };
  return createManualContext({ baseUrl: "http://fixed-authority", minimal: true,
    readApps: () => ({ enabled: true, apps: [{ id: "transcriptie" }, { id: "afbeelding-generator" }, { id: "openbesluitvorming" }, { id: "topdesk" }] }),
    readFeatures: () => ({ transcript: true, topdesk: true, openbesluitvorming: true, image: false }),
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.equal(new URL(url).origin, "http://fixed-authority");
      const value = url.endsWith("/api/user") ? payload.identity : url.endsWith("/api/config") ? payload.config : url.includes("/api/roles/") ? payload.role : payload.files;
      return { ok: true, text: async () => JSON.stringify(value) };
    }, ...overrides.options });
}

test("review: optional launcher/feature booleans never attest transcript, TOPdesk or OpenBesluitvorming", async () => {
  const context = adapter();
  for (const value of [context.general(), await context.user(req), await context.agent()]) {
    for (const key of ["transcript", "topdesk", "openbesluitvorming", "image"]) assert.ok(!value.capabilities.includes(key));
  }
  const common = await context.agent();
  assert.equal(common.scope, "common"); assert.equal(common.availability.promptLibrary.state, "user-dependent");
  assert.deepEqual(common.availability.promptLibrary, { state: "user-dependent" });
  assert.deepEqual(common.rights, []); assert.ok(common.capabilities.includes("prompts"));
  assert.ok(!common.capabilities.includes("upload"));
  assert.equal((await adapter({ config: { interface: { prompts: false } } }).agent()).availability.promptLibrary.state, "disabled");
  assert.equal((await adapter({ config: null }).agent()).availability.promptLibrary.state, "unknown");
  assert.deepEqual((await adapter({ config: { interface: { prompts: false } } }).user(req)).rights, []);
});

test("review: partial configuration failures discard all expanded privileges, rather than retain earlier grants", async () => {
  for (const overrides of [
    { files: [] }, { files: { disabled: "true" } }, { files: { endpoints: [] } },
    { files: { endpoints: { custom: { disabled: "true" } } } },
    { role: { name: "ADMIN", permissions: { PROMPTS: { USE: true, CREATE: true } } } },
    { options: { readApps: () => { throw new Error("private configuration failure"); } } },
    { options: { readApps: () => ({ enabled: true, apps: {} }) } },
  ]) {
    const value = await adapter(overrides).user(req);
    assert.deepEqual(value.capabilities, ["chat", "history"]); assert.deepEqual(value.rights, []);
  }
  for (const files of [{ disabled: true }, { endpoints: { custom: { disabled: true }, default: { disabled: false } } }, { endpoints: { "govchat-orchestrator": { disabled: true }, custom: { disabled: false } } }]) {
    const value = await adapter({ files }).user(req);
    assert.ok(!value.capabilities.includes("upload")); assert.ok(!value.capabilities.includes("files"));
  }
  // The unrelated agents endpoint must not determine the custom endpoint's upload policy.
  assert.ok((await adapter({ files: { endpoints: { agents: { disabled: true }, default: { disabled: false } } } }).user(req)).capabilities.includes("upload"));
});

test("review: invalid and explicitly disabled identities rejected; no cookies or asserted identity fallback", async () => {
  for (const identity of [null, [], { id: {}, role: "USER" }, { id: "u", role: "../ADMIN" }, { id: "u", role: "USER", disabled: true }, { id: "u", role: "USER", banned: true }, { id: "u", role: "USER", active: false }]) assert.equal(await adapter({ identity }).user(req), null);
  for (const authorization of [undefined, "current-access", "Bearer x y", "Bearer ", "Basic x"]) assert.equal(await adapter().user({ get: () => authorization, cookies: { refreshToken: "valid" }, user: { id: "admin", role: "ADMIN" } }), null);
});

async function listen(t, app) {
  const server = app.listen(0, "127.0.0.1"); await new Promise(r => server.once("listening", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("review HTTP: every read revalidates tokens/rights; stale, altered, revoked and changed identities cannot read protected sources", async t => {
  let identity = { id: "verified", role: "USER" }, use = true, create = true, share = true, disabledFiles = false, identityReads = 0, changeAfterFirst = null;
  const calls = [];
  const authority = express();
  authority.get("/api/config", (request, response) => response.json({ interface: { prompts: true } }));
  authority.use((request, response, next) => {
    calls.push([request.path, request.get("authorization")]);
    if (request.get("authorization") !== "Bearer current-access" || !identity) return response.sendStatus(401);
    next();
  });
  authority.get("/api/user", (request, response) => {
    identityReads++;
    const result = identity;
    if (changeAfterFirst && identityReads === 1) identity = changeAfterFirst;
    response.json(result);
  });
  authority.get("/api/roles/:role", (request, response) => response.json({ name: request.params.role, permissions: { PROMPTS: { USE: use, CREATE: create, SHARE: share, SHARE_PUBLIC: share } } }));
  authority.get("/api/files/config", (request, response) => response.json({ endpoints: { custom: { disabled: disabledFiles } } }));
  const baseUrl = await listen(t, authority);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-review-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createManualStore({ dataDir: path.join(root, "private"), publishDir: path.join(root, "public") }); store.init();
  const model = resolve({ enabled: true, sections: [{ id: "common", title: "Algemeen", content: "<p>Algemene bron</p>", items: [
    ...["use", "create", "edit", "share", "sharePublic"].map(right => ({ id: `prompt-${right}`, title: `Beschermd ${right}`, content: `<p>Geheime passage ${right}</p>`, requires: ["prompts"], rights: [`prompts.${right}`] })),
    { id: "upload", title: "Upload", content: "<p>Uploadbron</p>", requires: ["upload"] },
  ] }], errorCategories: [] });
  store.publish(store.save(model, store.adminState()));
  const app = express(); app.use(express.json());
  registerManualRoutes(app, { store, context: createManualContext({ baseUrl, minimal: true }), token: "service-secret", isAuthenticated: () => false });
  const base = await listen(t, app);
  const userHeaders = { authorization: "Bearer current-access", "x-user-id": "admin", "x-user-role": "ADMIN", "x-manual-context": '{"rights":["prompts.share"]}' };
  async function read(url, status, options = { headers: userHeaders }) {
    const response = await fetch(base + url, options); assert.equal(response.status, status, url);
    assert.match(response.headers.get("cache-control"), /no-store/); return response.json();
  }
  const document = await read("/api/manual/document", 200); assert.ok(document.passages.some(p => p.id === "prompt-share"));
  use = create = share = false;
  for (const right of ["use", "create", "edit", "share", "sharePublic"]) await read(`/api/manual/get?id=prompt-${right}`, 404);
  assert.equal((await read("/api/manual/search?query=Geheime", 200)).total, 0);
  for (const token of ["expired-access", "altered-signature", "revoked-access"]) await read("/api/manual/document", 401, { headers: { ...userHeaders, authorization: `Bearer ${token}` } });
  identity = null; await read("/api/manual/document", 401);
  identity = { id: "verified", role: "USER", disabled: true }; await read("/api/manual/document", 401);
  for (const changed of [{ id: "other", role: "USER" }, { id: "verified", role: "ADMIN" }, { id: "verified", role: "USER", tenantId: "other" }, { id: "verified", role: "USER", disabled: true }]) {
    identity = { id: "verified", role: "USER" }; identityReads = 0; changeAfterFirst = changed;
    await read("/api/manual/document", 401);
  }
  changeAfterFirst = null; identity = { id: "verified", role: "USER" }; disabledFiles = true;
  await read("/api/manual/get?id=upload", 404);
  const internal = { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer service-secret", "x-user-role": "ADMIN", "x-user-id": "verified" }, body: '{}' };
  for (const action of [{ action: "toc" }, { action: "search", query: "Geheime" }]) {
    const source = await read("/api/internal/manual", 200, { ...internal, body: JSON.stringify(action) });
    assert.equal(source.contextScope, "common"); assert.equal(source.availability.promptLibrary.state, "user-dependent");
    assert.ok(!JSON.stringify(source).includes("prompt-share")); assert.ok(!JSON.stringify(source).includes("Geheime passage"));
  }
  for (const right of ["use", "create", "edit", "share", "sharePublic"]) await read("/api/internal/manual", 404, { ...internal, body: JSON.stringify({ action: "get", id: `prompt-${right}` }) });
  for (const field of ["user", "userId", "roles", "rights", "capabilities", "context", "handle", "url", "path"]) await read("/api/internal/manual", 400, { ...internal, body: JSON.stringify({ action: "toc", [field]: "ADMIN" }) });
  await read("/api/internal/manual", 401, { ...internal, headers: { ...internal.headers, authorization: "service-secret" } });
  await read("/api/internal/manual", 415, { ...internal, headers: { ...internal.headers, "content-type": "text/plain" } });
  await read("/api/internal/manual", 413, { ...internal, body: JSON.stringify({ query: "é".repeat(1100), action: "search" }) });
  assert.ok(calls.filter(([url]) => url === "/api/roles/USER").length > 5);
  assert.ok(calls.every(([, token]) => !token?.includes("service-secret")));
  store.disable(store.adminState());
  await read("/api/internal/manual", 404, internal);
});

test("review workflow: only bounded read input reaches the service; both agent prompts distinguish common guidance from rights/sources", () => {
  const workflow = builder.manualWorkflow();
  const prepare = new Function("$json", "$env", workflow.nodes.find(n => n.id === "prepare").parameters.jsCode);
  const env = { CRAWLER_INTERNAL_TOKEN: "synthetic-service-secret" };
  for (const field of ["user", "roles", "rights", "capabilities", "context", "url"]) assert.throws(() => prepare({ request: JSON.stringify({ action: "toc", [field]: "ADMIN" }) }, env));
  for (const request of ["[]", "null", "invalid", "x".repeat(2049)]) assert.throws(() => prepare({ request }, env));
  assert.throws(() => prepare({ request: '{}' }, {}));
  assert.deepEqual(prepare({ request: '{"action":"toc"}', userId: "admin", rights: ["prompts.share"] }, env)[0].json.request, { action: "toc" });
  const result = new Function("$json", workflow.nodes.find(n => n.id === "result").parameters.jsCode);
  assert.throws(() => result({ ok: true, contextScope: "user", rights: ["prompts.share"] }));
  assert.equal(JSON.parse(result({ ok: true, contextScope: "common", title: "Bron" })[0].json.response).contextScope, "common");
  assert.ok(!JSON.stringify(result({ ok: false, error: { code: "UNAUTHORIZED" } })).includes(env.CRAWLER_INTERNAL_TOKEN));
  const orchestrator = JSON.parse(fs.readFileSync(path.join(__dirname, "../../agents/n8n/workflows/algemeen/orchestrator-litellm.json")))[0];
  for (const id of ["AIAgentOrchestrator", "AIAgentAuthorizedMcp"]) {
    const node = orchestrator.nodes.find(n => n.id === id);
    const output = new Function("$json", "return " + node.parameters.options.systemMessage.slice(3, -2))({ orchestratorPrompt: "Organisatiebeleid", body: { streamId: "12345678-1234-4234-8234-123456789abc", roles: ["ADMIN"], rights: ["prompts.share"] } });
    assert.ok(output.startsWith("Organisatiebeleid")); assert.ok(output.includes(builder.RULE));
    assert.ok(output.endsWith("\n[govchat-stream-id:12345678-1234-4234-8234-123456789abc]"));
    assert.ok(!output.includes('"prompts.share"')); assert.equal(output.split(builder.RULE).length, 2);
  }
  const tool = orchestrator.nodes.find(n => n.id === "ToolManual");
  assert.deepEqual(Object.keys(tool.parameters.workflowInputs.value), ["request"]);
  assert.deepEqual(workflow.settings, { executionOrder: "v1", saveDataSuccessExecution: "none", saveDataErrorExecution: "none", saveManualExecutions: false, saveExecutionProgress: false });
});

test("review policy: symlinks, malformed revisions and agent disable fail closed", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-policy-review-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "policy.json"), link = path.join(root, "link.json");
  const valid = { schemaVersion: 1, enabled: true, agentEnabled: true, revision: "12345678-1234-1234-1234-123456789abc" };
  fs.writeFileSync(file, JSON.stringify(valid)); assert.equal(policy.readManualPolicy(file), true);
  fs.symlinkSync(file, link); assert.equal(policy.readManualPolicy(link), false);
  for (const override of [{ revision: "-".repeat(36) }, { agentEnabled: false }, { enabled: false }, { enabled: "true" }]) {
    fs.writeFileSync(file, JSON.stringify({ ...valid, ...override })); assert.equal(policy.readManualPolicy(file), false);
  }
});
