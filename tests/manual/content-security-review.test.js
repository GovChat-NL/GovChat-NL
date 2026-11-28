"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const express = require("express");
const model = require("../../services/admin-overlay/admin/lib/manual-model");
const { createManualStore, atomic, readFile } = require("../../services/admin-overlay/admin/lib/manual-store");
const { registerManualRoutes, readManual } = require("../../services/admin-overlay/admin/lib/manual-routes");
const { fixture } = require("./fixture");

function setup(t, io) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-independent-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { dataDir: path.join(root, "private"), publishDir: path.join(root, "public"), ...(io ? { io } : {}) };
  const store = createManualStore(options); store.init();
  return { root, options, store };
}
test("IDs, aliases and references are strings, never coerced scalars", () => {
  for (const value of [undefined, null, true, 123, {}, []]) {
    for (const field of ["id", "aliases", "related"]) {
      const v = fixture(); v.sections[0][field] = field === "id" ? value : [value];
      assert.throws(() => model.validate(v), e => e.code === "INVALID_MANUAL", `${field}: ${value}`);
    }
    const v = fixture(); v.errorCategories[0].id = value;
    assert.throws(() => model.validate(v), e => e.code === "INVALID_MANUAL");
  }
});
test("present optional lists reject null and false instead of silently becoming empty", () => {
  for (const field of ["items", "aliases", "related", "codes", "messages", "requires", "rights"]) {
    for (const value of [null, false, "", 0]) {
      const v = fixture(); v.sections[0][field] = value;
      assert.throws(() => model.validate(v), e => e.code === "INVALID_MANUAL", field);
    }
  }
});
test("unknown placeholders fail at validation in every title and subtitle too", () => {
  const setters = [v => v.title = "{{SECRET}}", v => v.subtitle = "{{SECRET}}", v => v.sections[0].title = "{{SECRET}}", v => v.sections[0].items[0].title = "{{SECRET}}", v => v.errorCategories[0].title = "{{SECRET}}", v => v.errorCategories[0].articles[0].title = "{{SECRET}}"];
  for (const set of setters) { const v = fixture(); set(v); assert.throws(() => model.validate(v), e => e.code === "INVALID_MANUAL"); }
});
test("organization URLs are real web destinations, not recursive placeholders or manual/mailto schemes", () => {
  for (const value of ["{{COURSE_URL}}", "{{POLICY_URL}}", "manual:intro", "mailto:x@example.org", "javascript:alert(1)", "//evil.invalid", "https://user:password@evil.invalid"]) {
    const v = fixture(); v.organization.courseUrl = value;
    assert.throws(() => model.validate(v), e => e.code === "INVALID_MANUAL", value);
  }
  for (const value of ["", "https://example.org/course?a=1&b=2", "/policy"]) { const v = fixture(); v.organization.courseUrl = value; model.validate(v); }
});
test("HTML and organization interpolation cannot create active elements, attributes or executable URLs", () => {
  const v = fixture(); v.organization.appName = '<img src=x onerror="evil()">';
  v.organization.courseUrl = "https://example.org/course?a=1&b=2";
  v.sections[0].content = '<p>{{APP_NAME}}</p><svg><script>evil()</script></svg><math><mtext>x</mtext></math><iframe src="https://evil.invalid">x</iframe><p onclick="evil()" style="x"><a href="{{COURSE_URL}}" target="_blank">Cursus</a></p>';
  const p = model.compile(v).passages[0];
  assert.doesNotMatch(p.html, /<(?:img|svg|script|math|iframe)|\sonclick=|\sstyle=|\starget=/);
  assert.match(p.html, /&lt;img/); assert.match(p.html, /a=1&amp;b=2/);
  assert.match(p.html, /rel="noopener noreferrer"/);
  for (const href of ["java&#x73;cript:evil()", "&#10;javascript:evil()", "data:text/html,x", "https://example.org\\@evil.invalid"]) assert.throws(() => model.sanitize(`<a href="${href}">x</a>`));
});
test("category headings interpolate safely and related destinations must be gettable passages", () => {
  const v = fixture(); v.errorCategories[0].title = "{{APP_NAME}} fouten"; v.errorCategories[0].articles[0].title = "{{APP_NAME}} upload";
  const doc = model.compile(v, { capabilities: ["chat", "upload"] });
  assert.equal(doc.errorCategories[0].title, "GovChat-NL fouten");
  assert.equal(doc.errorCategories[0].articles[0].title, "GovChat-NL upload");
  v.sections[0].related = ["category"];
  assert.throws(() => model.validate(v), e => e.code === "INVALID_MANUAL");
});
test("unknown keys and prototype reset paths fail without changing revisions", t => {
  const { store } = setup(t); const state = store.adminState();
  for (const input of [JSON.parse('{"__proto__":{}}'), { organization: { privateToken: "x" } }, { visibility: { categories: { unknown: false } } }]) assert.throws(() => store.save(input, state), e => e.code === "INVALID_MANUAL");
  for (const field of ["organization.unknown", "organization.constructor", "organization.__proto__", "visibility.categories.unknown", "visibility.articles.unknown"]) assert.throws(() => store.reset(field, state), e => e.code === "INVALID_INPUT", field);
  assert.equal(store.adminState().draftRevision, state.draftRevision);
  assert.equal(store.adminState().sources["visibility.categories.appendix-errors"], "default");
  assert.equal(store.adminState().sources["visibility.errors"], "default");
});
test("a sparse visibility flag for a real passage can be reset without dropping siblings", t => {
  const { store } = setup(t); let state = store.save({ visibility: { topics: { snelstart: false, "goede-vraag": false } } }, store.adminState());
  state = store.reset("visibility.topics.snelstart", state);
  assert.equal(state.overrides.visibility.topics.snelstart, undefined);
  assert.equal(state.overrides.visibility.topics["goede-vraag"], false);
  state = store.reset("visibility.topics.snelstart", state); assert.ok(state.draftRevision);
});
test("stale write lock blocks old browser/agent reads and metadata; never auto-breaks a lock", t => {
  const { store, options } = setup(t); store.publish(store.save(fixture(), store.adminState()));
  const lock = path.join(store.directory, "write.lock"); fs.mkdirSync(lock);
  for (const context of [{}, { agent: true }]) assert.throws(() => store.document(context), e => e.code === "MANUAL_UNAVAILABLE");
  assert.equal(store.metadata().enabled, false);
  const restarted = createManualStore(options); assert.throws(() => restarted.init(), e => e.code === "REVISION_CONFLICT");
  assert.ok(fs.existsSync(lock)); fs.rmdirSync(lock);
  assert.equal(store.document().enabled, true);
});
test("dangling blocked and lock symlinks cannot bypass fail-closed reads", t => {
  const { store, root } = setup(t); store.publish(store.save(fixture(), store.adminState()));
  for (const name of ["blocked.json", "write.lock"]) {
    const file = path.join(store.directory, name); fs.symlinkSync(path.join(root, "absent"), file);
    assert.throws(() => store.document(), e => e.code === "MANUAL_UNAVAILABLE");
    assert.equal(store.metadata().enabled, false); fs.unlinkSync(file);
  }
});
test("import leaf swapped after path inspection is not followed and open descriptors close on invalid JSON", t => {
  const { root } = setup(t); const input = path.join(root, "input.json"), privateFile = path.join(root, "private-value.json");
  fs.writeFileSync(input, "{}"); fs.writeFileSync(privateFile, '{"private":"must-not-read"}');
  const originalOpen = fs.openSync; let swapped = false;
  t.mock.method(fs, "openSync", function (file, ...args) {
    if (file === input && !swapped) { swapped = true; fs.unlinkSync(input); fs.symlinkSync(privateFile, input); }
    return originalOpen.call(fs, file, ...args);
  });
  assert.throws(() => readFile(input)); assert.equal(swapped, true);
  t.mock.restoreAll(); fs.unlinkSync(input); fs.writeFileSync(input, "not-json");
  const originalClose = fs.closeSync; let closed = false;
  t.mock.method(fs, "closeSync", function (fd) { closed = true; return originalClose.call(fs, fd); });
  assert.throws(() => readFile(input), SyntaxError); assert.equal(closed, true);
});
test("other store instances cannot read an in-progress publication before marker persistence", t => {
  let inspect = false, reader;
  const { store, options } = setup(t, (dir, file, value, mode) => {
    if (inspect && file === "state.json") {
      assert.throws(() => reader.document(), e => e.code === "MANUAL_UNAVAILABLE");
      assert.equal(reader.metadata().enabled, false);
    }
    atomic(dir, file, value, mode);
  });
  reader = createManualStore(options); store.publish(store.save(fixture(), store.adminState()));
  inspect = true; store.save({ title: "Nieuw concept" }, store.adminState());
  assert.equal(reader.document().enabled, true);
});
test("state write failure invalidates public activation, survives restart and needs explicit successful publish", t => {
  let fail = false;
  const { store, options } = setup(t, (dir, file, value, mode) => {
    if (fail && file === "state.json") throw new Error("Onafhankelijke I/O-fout");
    atomic(dir, file, value, mode);
  });
  const live = store.publish(store.save(fixture(), store.adminState())); fail = true;
  assert.throws(() => store.disable(live), e => e.code === "PUBLISH_FAILED");
  assert.ok(!fs.existsSync(path.join(options.publishDir, "manual-config.json")));
  const restarted = createManualStore(options); restarted.init();
  assert.equal(restarted.metadata().enabled, false);
  assert.throws(() => restarted.document(), e => e.code === "MANUAL_UNAVAILABLE");
  fail = false;
  restarted.disable(restarted.adminState()); assert.equal(store.metadata().enabled, false);
  assert.throws(() => restarted.document(), e => e.code === "MANUAL_DISABLED");
});
test("marker persistence failure retains the lock and removes stale metadata across processes and restart", t => {
  const { store, options } = setup(t); const state = store.publish(store.save(fixture(), store.adminState()));
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", function (file, ...args) {
    if (typeof file === "string" && path.basename(file).startsWith(".blocked.json.")) throw new Error("Blokkermarker kan niet worden geschreven");
    return originalOpen.call(fs, file, ...args);
  });
  assert.throws(() => store.disable(state), e => e.code === "PUBLISH_FAILED");
  assert.ok(fs.existsSync(path.join(store.directory, "write.lock")));
  assert.ok(!fs.existsSync(path.join(options.publishDir, "manual-config.json")));
  const reader = createManualStore(options);
  assert.throws(() => reader.document(), e => e.code === "MANUAL_UNAVAILABLE");
  assert.throws(() => reader.init(), e => e.code === "REVISION_CONFLICT");
  assert.equal(reader.metadata().enabled, false);
});
test("labels remain configurable in private preview, not in default get/search/agent channels", () => {
  const v = model.resolve({ enabled: true });
  const doc = model.compile(v, { capabilities: model.CAPABILITIES, rights: model.RIGHTS });
  const id = "err-com_error_token_balance_prompt";
  for (const agent of [false, true]) {
    assert.throws(() => readManual(doc, { action: "get", id }, agent), e => e.code === "PASSAGE_NOT_FOUND");
    assert.equal(readManual(doc, { action: "search", query: "com_error_token_balance_prompt" }, agent).results.length, 0);
  }
  assert.ok(model.compile(v, { preview: true }).passages.some(p => p.id === id && p.hiddenReasons.includes("category-hidden")));
  v.visibility.categories["appendix-errors"] = true;
  assert.ok(model.compile(v, { capabilities: model.CAPABILITIES, rights: model.RIGHTS }).passages.some(p => p.id === id));
});
test("useful default chat/document/prompt topics and concrete error searches survive catalog filtering", () => {
  const doc = model.compile(model.resolve({ enabled: true }), { capabilities: model.CAPABILITIES, rights: model.RIGHTS });
  for (const [query, id] of [["invalid_shared_string", "err-invalid_shared_string"], ["HTTP 413", "err-http-413"], ["prompt-versies", "prompt-versies"], ["document-upload", "document-upload"], ["goede-vraag", "goede-vraag"]]) {
    const result = readManual(doc, { action: "search", query });
    if (["prompt-versies", "document-upload", "goede-vraag"].includes(id)) assert.ok(doc.passages.some(p => p.id === id));
    else assert.equal(result.results[0]?.id, id, query);
  }
});
test("real HTTP admin rejects injected unknown fields and unsafe source; preview is private, revision-bound reads disable", async t => {
  const { store } = setup(t); store.publish(store.save(fixture(), store.adminState()));
  const app = express(); app.use(express.json());
  registerManualRoutes(app, { store, context: { general: () => ({ capabilities: ["chat"], rights: [] }), user: async req => req.get("authorization") === "Bearer review-user" ? { capabilities: ["chat"], rights: [] } : null }, isAuthenticated: req => req.get("cookie") === "session=review-admin", token: "review-internal" });
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: "session=review-admin", "content-type": "application/json" };
  let state = store.adminState();
  for (const draft of [{ organization: { privateToken: "secret" } }, { title: "{{SECRET}}" }, { organization: { policyUrl: "javascript:evil()" } }]) {
    const res = await fetch(base + "/api/admin/manual/draft", { method: "PUT", headers, body: JSON.stringify({ ...state, model: draft }) });
    assert.equal(res.status, 400); assert.match(res.headers.get("cache-control"), /no-store/);
    assert.equal(store.adminState().draftRevision, state.draftRevision);
  }
  const unauthorized = await fetch(base + "/api/admin/manual/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: fixture() }) }); assert.equal(unauthorized.status, 401);
  const preview = await fetch(base + "/api/admin/manual/preview", { method: "POST", headers, body: JSON.stringify({ model: fixture() }) });
  assert.equal((await preview.json()).preview, true); assert.match(preview.headers.get("cache-control"), /no-store/);
  const user = { authorization: "Bearer review-user" };
  const old = store.document().revision; state = store.disable(state);
  const disabled = await fetch(base + `/api/manual/get?id=intro&revision=${old}`, { headers: user }); assert.equal(disabled.status, 404);
  assert.match(disabled.headers.get("cache-control"), /no-store/);
});
