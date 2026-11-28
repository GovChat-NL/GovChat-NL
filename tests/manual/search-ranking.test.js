"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { compile, resolve, CAPABILITIES, RIGHTS } = require("../../services/admin-overlay/admin/lib/manual-model");
const { readManual } = require("../../services/admin-overlay/admin/lib/manual-routes");
const { fixture } = require("./fixture");
const ids = (document, query, agent = false) => readManual(document, { action: "search", query, limit: agent ? 8 : 50 }, agent).results.map(p => p.id);

test("normalized exact full codes/messages outrank meaningful topics, with stable ties", () => {
  const model = fixture();
  model.sections[0].content = "<p>Welkom</p>";
  model.sections[0].items = [
    { id: "topic-first", title: "HTTP 413 documenten", content: "<p>Request failed documenten</p>" },
    { id: "topic-second", title: "HTTP 413 documenten", content: "<p>Request failed documenten</p>" }
  ];
  model.errorCategories[0].articles = [
    { id: "exact-first", title: "Herstel", content: "<p>documenten</p>", codes: ["HTTP 413"], messages: ["Request   failed"] },
    { id: "exact-second", title: "Herstel", content: "<p>documenten</p>", codes: ["HTTP 413"] },
    { id: "partial", title: "HTTP 413 documenten documenten", content: "<p>Request failed</p>", codes: ["HTTP 413 extra"] }
  ];
  const document = compile(model, { capabilities: CAPABILITIES, rights: RIGHTS });
  for (const agent of [false, true]) {
    assert.deepEqual(ids(document, "  ＨＴＴＰ\t４１３  ", agent), ["exact-first", "exact-second", "topic-first", "topic-second", "partial"]);
    assert.equal(ids(document, "request\nFAILED", agent)[0], "exact-first");
    assert.deepEqual(ids(document, "documenten", agent), ["topic-first", "topic-second", "partial", "exact-first", "exact-second"]);
    assert.equal(ids(document, "HTTP", agent)[0], "topic-first");
  }
});
test("dynamic templates are not exact identities and are never expanded to runtime messages", () => {
  const model = fixture();
  model.sections[0].content = "<p>Welkom</p>";
  model.sections[0].items = [{ id: "template-topic", title: "Fout ${name}", content: "<p>Algemene uitleg</p>" }];
  model.errorCategories[0].articles = [{ id: "template-error", title: "Fout ${name}", content: "<p>Algemene uitleg</p>", messages: ["Fout ${name}"] }];
  const document = compile(model, { capabilities: CAPABILITIES, rights: RIGHTS });
  assert.deepEqual(ids(document, "Fout ${name}"), ["template-topic", "template-error"]);
  assert.deepEqual(ids(document, "Fout willekeurig"), []);
});
test("visibility and trusted user/agent rights filtering happens before exact ranking", () => {
  const model = fixture();
  model.sections[0].items[0].codes = ["bad_document"];
  model.errorCategories[0].articles.push({ id: "hidden-exact", title: "Hidden", content: "<p>secret</p>", codes: ["bad_document"] });
  model.visibility.articles["hidden-exact"] = false;
  for (const agent of [false, true]) {
    assert.deepEqual(ids(compile(model, { capabilities: ["chat"], rights: [] }), "bad_document", agent), []);
    assert.deepEqual(ids(compile(model, { capabilities: ["chat", "upload"], rights: [] }), "bad_document", agent), ["err1"]);
    assert.deepEqual(ids(compile({ ...model, enabled: false }, { capabilities: CAPABILITIES, rights: RIGHTS }), "bad_document", agent), []);
  }
});
test("ordinary chat/document/prompt queries lead with meaningful topics, appendix stays excluded", () => {
  const document = compile({ ...resolve(), enabled: true }, { capabilities: CAPABILITIES, rights: RIGHTS });
  for (const query of ["chat", "documenten", "prompt"]) {
    const first = ids(document, query)[0];
    assert.ok(first, query);
    assert.notEqual(document.passages.find(p => p.id === first).kind, "articles", query);
  }
  assert.ok(!document.errorCategories.some(c => c.id === "appendix-errors"));
});
