"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const m = require("../../services/admin-overlay/admin/lib/manual-model");
const { readManual } = require("../../services/admin-overlay/admin/lib/manual-routes");
const { fixture } = require("./fixture");
test("defaults off, separate automatic policy and reviewed Limburg precedence", () => {
  assert.equal(m.resolve().enabled, false); assert.equal(m.resolve().autoOpen, "never");
  const l = m.resolve({ profile: "limburg", organization: { appName: "", helpdeskEmail: "" } });
  assert.equal(l.organization.appName, ""); assert.equal(l.organization.helpdeskEmail, ""); assert.equal(l.organization.aiEmail, "ai@prvlimburg.nl");
  assert.equal(m.compile(l).passages.length, 0);
  const all = m.compile({ ...m.resolve(), enabled: true }, { capabilities: m.CAPABILITIES, rights: m.RIGHTS });
  for (const id of ["sec1", "sec2", "sec3", "beleidskompas", "chat-geschiedenis", "document-upload", "bestanden-verwijderen", "prompt-variabelen", "prompt-versies"]) assert.ok(all.passages.some(p => p.id === id), id);
  assert.ok(all.passages.length > 300);
  assert.ok(!all.errorCategories.some(c => c.id === "appendix-errors"));
  assert.ok(m.compile({ ...m.resolve(), enabled: true }, { preview: true }).passages.length > 600);
  assert.match(all.passages.find(p => p.id === "document-kwaliteit").text, /XLSM/);
});
test("hierarchical flags, capabilities and rights cannot be overridden in any read channel", () => {
  for (let mask = 0; mask < 256; mask++) {
    const v = fixture();
    const on = bit => Boolean(mask & (1 << bit));
    v.enabled = on(0); v.visibility.chapters.intro = on(1); v.visibility.topics.secret = true;
    v.visibility.errors = on(2); v.visibility.categories.category = on(3); v.visibility.articles.err1 = on(4);
    const caps = ["chat", ...(on(5) ? ["prompts"] : []), ...(on(6) ? ["upload"] : [])], rights = on(7) ? ["prompts.share"] : [];
    const doc = m.compile(v, { revision: "rev", capabilities: caps, rights });
    const secret = on(0) && on(1) && on(5) && on(7), error = on(0) && on(2) && on(3) && on(4) && on(6);
    assert.equal(doc.passages.some(p => p.id === "secret"), secret);
    assert.equal(doc.passages.some(p => p.id === "err1"), error);
    for (const agent of [false, true]) {
      assert.equal(readManual(doc, { action: "search", query: "Vertrouwelijke" }, agent).results.length, secret ? 1 : 0);
      if (!secret) assert.throws(() => readManual(doc, { action: "get", id: "secret" }, agent), e => e.code === "PASSAGE_NOT_FOUND");
      if (!error) assert.throws(() => readManual(doc, { action: "get", id: "err1" }, agent), e => e.code === "PASSAGE_NOT_FOUND");
    }
    if (!secret) assert.ok(!doc.passages.some(p => p.html.includes("manual=secret")));
    assert.equal(doc.errorCategories.length > 0, error);
  }
});
test("sanitization, text placeholders, safe links, stable IDs and hidden link removal", () => {
  const v = fixture();
  v.organization.appName = '</script><img src=x onerror="alert(1)">';
  v.sections[0].content = '<p>{{APP_NAME}}</p><script>alert(1)</script><svg><script>x</script></svg><img onerror="bad()"><p style="color:red" onclick="bad()"><strong>Goed</strong><a href="manual:secret">verborgen</a></p>';
  const p = m.compile(v).passages[0];
  assert.ok(!p.html.includes("<script") && !p.html.includes("<img") && !p.html.includes("onclick=") && !p.html.includes("style="));
  assert.match(p.html, /&lt;img/); assert.match(p.text, /<img src=x/); assert.ok(!p.html.includes("manual=secret"));
  for (const href of ["javascript:alert(1)", "data:text/html,x", "//evil.example/x", "/\\evil.example", "https://user:pass@evil.example/"]) assert.throws(() => m.sanitize(`<a href="${href}">x</a>`));
  assert.match(m.sanitize('<a href="https://example.org/a">link</a>'), /noopener noreferrer/);
  assert.equal(m.sanitize(m.sanitize('<p><b>Bold</b><br>Nieuw</p>')), m.sanitize('<p><b>Bold</b><br>Nieuw</p>'));
});
test("strict schema, IDs, aliases, applicability, limits and unresolved references", () => {
  for (const patch of [{ organization: null }, { visibility: [] }, { enabled: "true" }, { agentEnabled: 1 }, { autoOpen: "sometimes" }, { profile: "other" }, { schemaVersion: 9 }, { featureToggle: true }, { organization: { privateToken: "x" } }]) assert.throws(() => m.resolve(patch));
  for (const mutate of [v => { v.sections[0].items[0].id = "intro"; }, v => { v.sections[0].aliases = ["secret"]; }, v => { v.sections[0].related = ["missing"]; }, v => { v.sections[0].requires = ["made-up"]; }, v => { v.sections[0].rights = ["ADMIN"]; }, v => { v.sections[0].content = "{{UNREVIEWED}}"; }, v => { v.visibility.topics.missing = false; }, v => { v.sections[0].content = "x".repeat(24001); }]) {
    const v = fixture(); mutate(v); assert.throws(() => m.validate(v));
  }
});
test("legacy migration preserves chapters, items and aliases while remaining disabled", () => {
  const old = { title: "Bestaand", subtitle: "", sections: [{ id: "sec4", emoji: "📄", title: "Docs", content: "<p>Oud</p>", aliases: ["document"] , items: [{ id: "sec4-sub1", emoji: "", title: "Sub", content: "<p>Detail</p>" }] }] };
  const v = m.migrate(old); assert.equal(v.enabled, false); assert.equal(v.sections[0].id, "sec4"); assert.equal(v.sections[0].items[0].id, "sec4-sub1");
  const d = m.compile({ ...v, enabled: true }); assert.equal(readManual(d, { action: "get", id: "document" }).passage.id, "sec4");
});
test("preview explicitly labels hidden reasons and revisions/inputs are bounded", () => {
  const v = fixture(); const preview = m.compile(v, { preview: true, hardDisabled: true });
  assert.equal(preview.preview, true); assert.ok(preview.passages.find(p => p.id === "secret").hiddenReasons.includes("right:prompts.share"));
  assert.ok(preview.passages[0].hiddenReasons.includes("deployment-disabled"));
  const d = m.compile(v, { revision: "current" });
  for (const request of [{ action: "search", query: "x".repeat(201) }, { action: "get", id: "../file" }, { action: "fetch", url: "https://example.org" }, { action: "toc", roles: ["ADMIN"] }, { limit: 99 }, { limit: 2.5 }]) assert.throws(() => readManual(d, request, true));
  assert.throws(() => readManual(d, { action: "get", id: "intro", revision: "old" }), e => e.code === "REVISION_CHANGED");
});
test("default error categories inherit disabled problems chapter; category/topic parents are validated", () => {
  const v = m.resolve({ enabled: true, visibility: { chapters: { problemen: false } } });
  const doc = m.compile(v, { capabilities: m.CAPABILITIES, rights: m.RIGHTS }); assert.equal(doc.errorCategories.length, 0); assert.ok(!doc.passages.some(p => p.kind === "articles"));
  const custom = fixture(); custom.errorCategories[0].parentId = "secret";
  assert.equal(m.compile(custom, { capabilities: ["chat", "upload"] }).errorCategories.length, 0);
  custom.errorCategories[0].parentId = "missing"; assert.throws(() => m.validate(custom));
});
test("literal manual destinations normalize to allowed current passage IDs, never stale/hidden links", () => {
  const v = fixture(); v.sections[0].content = '<p><a href="/c/new?manual=secret&amp;manualRevision=old">Bron</a></p>';
  const hidden = m.compile(v); assert.ok(!hidden.passages[0].html.includes("manual=secret"));
  const allowed = m.compile(v, { capabilities: ["prompts"], rights: ["prompts.share"], revision: "current" }); assert.match(allowed.passages[0].html, /manualRevision=current/); assert.ok(!allowed.passages[0].html.includes("manualRevision=old"));
  v.sections[0].content = '<a href="/c/new?manual=unknown">bron</a>'; assert.throws(() => m.validate(v));
});
