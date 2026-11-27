"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createManualStore } = require("../../services/admin-overlay/admin/lib/manual-store");
const { fixture } = require("./fixture");
const { dom, DOMParser, settle } = require("./editor-dom-fixture");
const editorPath = path.resolve(__dirname, "../../services/admin-overlay/admin/views/help-editor-assets/editor.js");
const html = fs.readFileSync(path.resolve(__dirname, "../../services/admin-overlay/admin/views/help-editor.html"), "utf8");
const core = require(editorPath);
function temporary(t) {
  const parent = path.resolve(__dirname, "../../.manual-tools/tmp"); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "editor-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function bridge(t) {
  const root = temporary(t), store = createManualStore({ dataDir: path.join(root, "data"), publishDir: path.join(root, "public") }); store.init();
  store.save(fixture(), store.adminState());
  const calls = [];
  const fetch = async (url, options) => {
    const route = url.replace(/^.*\/api\/admin\/manual/, ""), body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, options, body });
    try {
      let state;
      if (!route) state = store.adminState();
      else if (route === "/draft") state = store.save(body.model, body);
      else if (route === "/import") state = store.save(body.model, body, "admin-import");
      else if (route === "/preview") state = store.preview(body.model);
      else if (route === "/reset") state = store.reset(body.path, body);
      else if (route === "/publish") state = store.publish(body);
      else if (route === "/disable") state = store.disable(body);
      else if (route === "/rollback") state = store.publish(body, body.revision);
      else if (route === "/export") state = { model: store.adminState().model };
      else throw new Error("unexpected route");
      return { ok: true, status: 200, json: async () => ({ ok: true, ...state }) };
    } catch (error) { return { ok: false, status: error.status || 503, json: async () => ({ ok: false, error: { code: error.code, message: error.message } }) }; }
  };
  return { store, calls, fetch };
}
async function ui(t, base = "https://beheer.invalid/management/help-editor", initialOverrides) {
  const api = bridge(t);
  if (initialOverrides !== undefined) api.store.save(initialOverrides, api.store.adminState());
  const document = dom(html), downloads = [];
  const window = { fetch: api.fetch, location: { href: base }, confirm: () => true, prompt: () => null, addEventListener() {}, setTimeout: callback => callback() };
  const URLDouble = class extends URL {};
  URLDouble.createObjectURL = blob => { downloads.push(blob); return "blob:private-test"; }; URLDouble.revokeObjectURL = () => {};
  const context = vm.createContext({ document, window, URL: URLDouble, Blob, DOMParser, console });
  vm.runInContext(fs.readFileSync(editorPath, "utf8"), context); await settle();
  const $ = id => document.getElementById(id);
  const input = (label, value, event = "input") => {
    const caption = document.querySelectorAll("label").find(n => n.textContent === label); assert.ok(caption, label);
    const node = $(caption.htmlFor); assert.ok(node, label); node.value = value; node.dispatch(event); return node;
  };
  const tab = async name => { document.querySelectorAll("[data-tab]").find(n => n.dataset.tab === name).click(); await settle(); };
  const click = async id => { $(id).click(); await settle(); };
  return { ...api, document, window, downloads, $, input, tab, click };
}
test("editor page has no bootstrap interpolation and assets stay inside copied views", () => {
  assert.match(html, /lang="nl"/); assert.match(html, /defer/); assert.doesNotMatch(html, /\{\{jsonData\}\}|<script[^>]*>\s*[^<\s]/);
  for (const id of ["status", "workspace", "conflict", "save", "preview", "publish", "disable", "export", "preview-panel"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-live="polite"/); assert.match(html, /<noscript>/);
});
test("sparse edits preserve inheritance, explicit empty/false, and arrays are wholesale", t => {
  const api = bridge(t), state = api.store.adminState();
  // Use a sparse initial draft, not the full fixture, to test accidental materialization.
  api.store.save({ profile: "limburg" }, state);
  const session = new core.Session(api.fetch, "/api/admin/manual"); session.accept(api.store.adminState());
  session.edit("organization.helpdeskEmail", ""); session.edit("enabled", false);
  assert.deepEqual(session.overrides, { profile: "limburg", organization: { helpdeskEmail: "" }, enabled: false });
  const count = session.model.sections.length; session.array("sections")[0].title = "Anders";
  assert.equal(session.overrides.sections.length, count); assert.equal(session.overrides.sections[1].id, session.state.model.sections[1].id);
  assert.equal(session.state.model.sections[0].title === "Anders", false);
  assert.throws(() => core.put({}, "__proto__.polluted", true));
});
test("all mutation contracts carry both current revisions, preview does not publish", async t => {
  const api = bridge(t), session = new core.Session(api.fetch, "/api/admin/manual"); session.accept(api.store.adminState());
  const original = session.state.baseRevision;
  session.edit("organization.name", "Testorganisatie"); await session.mutate("/draft", { model: session.overrides }, "PUT");
  assert.equal(session.state.baseRevision, original); assert.equal(session.dirty, false);
  const preview = await session.request("/preview", "POST", { model: session.overrides });
  assert.equal(preview.preview, true); assert.ok(preview.passages.find(p => p.id === "secret").hiddenReasons.includes("right:prompts.share"));
  assert.deepEqual(Object.keys(api.calls.at(-1).body), ["model"]);
  await session.mutate("/publish"); assert.notEqual(session.state.baseRevision, original);
  const history = session.state.history[0].revision;
  await session.mutate("/reset", { path: "organization.name" });
  await session.mutate("/disable"); assert.equal(session.state.effective.enabled, false);
  await session.mutate("/rollback", { revision: history });
  for (const call of api.calls.filter(c => c.body && !c.url.endsWith("/preview"))) { assert.equal(typeof call.body.baseRevision, "string"); assert.equal(typeof call.body.draftRevision, "string"); }
  for (const call of api.calls) { assert.equal(call.options.credentials, "same-origin"); assert.equal(call.options.cache, "no-store"); assert.equal(call.options.redirect, "error"); }
});
test("conflicts retain local overrides, compare does not rebase, and no request is retried", async t => {
  const api = bridge(t), session = new core.Session(api.fetch, "/api/admin/manual"); session.accept(api.store.adminState());
  session.edit("title", "Mijn lokale titel"); api.store.save({ title: "Andere beheerder" }, api.store.adminState());
  await assert.rejects(session.mutate("/draft", { model: session.overrides }, "PUT"), e => e.status === 409);
  assert.equal(session.conflict, true); const count = api.calls.length;
  await assert.rejects(session.mutate("/publish")); assert.equal(api.calls.length, count);
  const latest = await session.request(); assert.equal(latest.model.title, "Andere beheerder"); assert.equal(session.model.title, "Mijn lokale titel"); assert.equal(session.conflict, true);
  session.accept(latest); assert.equal(session.conflict, false);
});
test("network and publication failures require explicit current-state recovery; validation remains editable", async t => {
  const state = bridge(t).store.adminState(); let calls = 0;
  for (const status of [0, 503, 400]) {
    const session = new core.Session(async () => { calls++; if (!status) throw Error("network"); return { ok: false, status, json: async () => ({ ok: false, error: { message: "Mislukt" } }) }; }, "/api/admin/manual"); session.accept(state);
    session.edit("title", "Lokaal"); await assert.rejects(session.mutate("/draft", { model: session.overrides }, "PUT"));
    assert.equal(session.model.title, "Lokaal"); assert.equal(session.uncertain, status !== 400);
    if (session.uncertain) { const before = calls; await assert.rejects(session.mutate("/publish")); assert.equal(calls, before); }
  }
});
test("import recognizes full models, legacy models, sparse overrides and downloaded override arrays", () => {
  const full = fixture(); assert.deepEqual(core.importPayload(full), { path: "/import", method: "POST", model: full });
  assert.equal(core.importPayload({ title: "oud", sections: [] }).path, "/import");
  assert.equal(core.importPayload({ title: "nieuw" }).path, "/draft");
  assert.equal(core.importPayload({ type: "govchat-manual-overrides", overrides: { title: "nieuw", sections: [] } }).path, "/draft");
  assert.equal(core.importPayload({ ok: true, model: full }).model, full);
  assert.throws(() => core.importPayload([]));
});
test("search covers exact codes/messages/aliases and new IDs avoid aliases; order has boundaries", () => {
  const model = fixture(); model.sections[0].aliases = ["artikel-1"];
  assert.equal(core.uniqueId(model, "artikel"), "artikel-2");
  const article = core.entries(model).find(e => e.node.id === "err1");
  assert.equal(core.matching(article, "bad_document foutdocument"), true);
  assert.equal(core.matching(article, "geen-resultaat"), false);
  const list = ["a", "b", "c"]; assert.equal(core.move(list, 0, -1), false); assert.equal(core.move(list, 0, 1), true); assert.deepEqual(list, ["b", "a", "c"]);
});
test("link and preview sinks reject active URLs and escape metadata", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,x", "//evil.test", "/\\evil", "https://user:pass@evil.test"]) assert.equal(core.safeLink(href), false);
  for (const href of ["https://example.test", "/beleid", "manual:intro", "mailto:team@example.test", "{{COURSE_URL}}"] ) assert.equal(core.safeLink(href), true);
  const preview = core.previewPage({ title: '</h1><script>alert(1)</script>', html: "<p>Veilige compilerinhoud</p>" });
  assert.doesNotMatch(preview, /<script>/); assert.match(preview, /&lt;script&gt;/); assert.match(preview, /default-src 'none'/);
});
test("DOM editor loads prefix-aware private data, saves sparse edits, and updates sources", async t => {
  const app = await ui(t); assert.equal(app.calls[0].url, "/management/api/admin/manual");
  app.input("E-mail helpdesk", "helpdesk@example.test");
  assert.match(app.$("revision").textContent, /Niet-bewaarde/); assert.equal(app.$("publish").disabled, true);
  assert.match(app.document.textContent, /Lokale wijziging \(nog niet bewaard\)/);
  await app.click("save"); assert.equal(app.store.adminState().model.organization.helpdeskEmail, "helpdesk@example.test"); assert.equal(app.$("publish").disabled, false);
  app.input("E-mail helpdesk", ""); await app.click("save"); assert.equal(app.store.adminState().model.organization.helpdeskEmail, "");
  await app.click("preview"); assert.equal(app.$("preview-panel").hidden, false); assert.match(app.$("preview-list").textContent, /right:prompts.share/);
  app.input("Titel", "Nog een wijziging"); assert.equal(app.$("preview-panel").hidden, true);
});
test("DOM chapter/topic editing, filtering, moving and adding preserve the whole catalog", async t => {
  const app = await ui(t); await app.tab("chapters");
  app.input("Titel", "Nieuw welkom"); await app.click("save"); assert.equal(app.store.adminState().model.sections[0].title, "Nieuw welkom");
  const add = app.document.querySelectorAll("button").find(n => n.textContent === "Onderwerp toevoegen"); add.click(); await settle();
  assert.match(app.$("workspace").textContent, /Nieuw onderwerp/); await app.click("save"); assert.equal(app.store.adminState().model.sections[0].items.length, 2);
  await app.tab("errors"); app.input("Zoeken in titel, ID, code, melding en inhoud", "bad_document");
  assert.match(app.document.querySelector(".catalog").textContent, /Foutdocument/); assert.doesNotMatch(app.document.querySelector(".catalog").textContent, /Fouten\s+category/);
});
test("DOM conflict offers comparison/download but never automatically retries or discards", async t => {
  const app = await ui(t); app.input("Titel", "Lokaal bewaren");
  app.store.save({ title: "Serverwijziging" }, app.store.adminState()); await app.click("save");
  assert.equal(app.$("conflict").hidden, false); assert.equal(app.$("save").disabled, true); assert.equal(app.$("publish").disabled, true);
  await app.click("compare"); assert.match(app.$("comparison").textContent, /Lokaal bewaren/); assert.match(app.$("comparison").textContent, /Serverwijziging/);
  await app.click("local-export"); assert.equal(app.downloads.length, 1); assert.match(await app.downloads[0].text(), /Lokaal bewaren/);
  app.window.confirm = () => false; await app.click("reload-conflict"); assert.equal(app.$("conflict").hidden, false);
  app.window.confirm = () => true; await app.click("reload-conflict"); assert.equal(app.$("conflict").hidden, true); assert.match(app.$("workspace").textContent, /Instellingen/);
});
test("DOM advanced HTML source never activates scripts/events/unsafe links, server validates on save", async t => {
  const app = await ui(t); await app.tab("chapters");
  app.input("Veilige HTML-bron", '<p onclick="evil()">Tekst<img src="https://evil.test"><script>evil()</script><a href="javascript:evil()">link</a></p>');
  const rich = app.document.querySelector(".rich"); assert.doesNotMatch(rich.innerHTML, /script|onclick|img|javascript:/);
  await app.click("save"); assert.match(app.$("status").textContent, /Onveilige/); assert.equal(app.$("publish").disabled, true);
});
test("DOM field reset requires a saved draft and removes only the selected override", async t => {
  const app = await ui(t); app.input("Titel", "Eigen titel");
  const titleSource = app.document.querySelectorAll("label").find(n => n.textContent === "Titel").parentNode.querySelector(".source");
  titleSource.querySelector("button").click(); await settle(); assert.match(app.$("status").textContent, /Bewaar eerst/);
  await app.click("save");
  const before = app.store.adminState().overrides;
  app.document.querySelectorAll("label").find(n => n.textContent === "Titel").parentNode.querySelector("button").click(); await settle();
  const after = app.store.adminState().overrides; assert.equal(Object.hasOwn(after, "title"), false); assert.deepEqual(after.sections, before.sections); assert.deepEqual(after.organization, before.organization);
  assert.equal(app.calls.at(-1).body.path, "title");
});
test("DOM explicit publication, live-only disable, private export and historical rollback", async t => {
  const app = await ui(t); await app.click("publish"); const first = app.store.adminState();
  app.input("Titel", "Ander concept"); await app.click("save"); const draft = app.store.adminState(); assert.equal(draft.baseRevision, first.baseRevision);
  await app.click("export"); assert.match(await app.downloads[0].text(), /Ander concept/);
  await app.click("disable"); const disabled = app.store.adminState(); assert.equal(disabled.effective.enabled, false); assert.equal(disabled.model.title, first.model.title);
  await app.tab("transfer");
  const restore = app.document.querySelectorAll("button").find(n => n.textContent === "Deze publicatie terugzetten" && n.parentNode.textContent.includes(first.baseRevision));
  assert.ok(restore); restore.click(); await settle();
  const rolled = app.store.adminState(); assert.equal(rolled.effective.enabled, true); assert.notEqual(rolled.baseRevision, first.baseRevision); assert.equal(rolled.model.title, first.model.title);
  assert.equal(app.calls.at(-1).body.revision, first.baseRevision);
});
test("DOM complete default error catalog remains editable and searchable without dropping inherited arrays", async t => {
  const app = await ui(t, "https://beheer.invalid/help-editor", {}); await app.tab("errors");
  const model = app.store.adminState().model, expected = model.errorCategories.reduce((count, c) => count + 1 + c.articles.length, 0);
  assert.equal(app.document.querySelector(".catalog").children.filter(n => n.localName === "button").length, expected);
  const article = model.errorCategories.flatMap(c => c.articles).find(a => a.codes.length);
  app.input("Zoeken in titel, ID, code, melding en inhoud", article.codes[0]); assert.match(app.document.querySelector(".catalog").textContent, new RegExp(article.id));
  assert.deepEqual(app.store.adminState().overrides, {});
});
