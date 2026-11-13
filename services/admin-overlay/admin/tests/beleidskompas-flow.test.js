"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// server.js writes its defaults where DATA_DIR and PUBLISH_DIR point, so give it a throwaway place.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-admin-"));
for (const name of ["DATA_DIR", "PUBLISH_DIR"]) {
  process.env[name] = path.join(dir, name.toLowerCase());
  fs.mkdirSync(process.env[name]);
}
process.env.ADMIN_PASSWORD = "test-password";
process.env.BELEIDSKOMPAS_STORE_TOKEN = "secret-token";
const { app, normalizeBeleidskompasFlow, publicBeleidskompasConfig } = require("../server.js");
const publicFile = path.join(process.env.PUBLISH_DIR, "beleidskompas-config.json");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("the public config holds only what the Beleidskompas page reads", () => {
  const flow = normalizeBeleidskompasFlow({
    rules: "r",
    steps: [{ id: "stap1", title: "T", description: "D", prompt: "P", document_ids: ["d1"], substeps: [{ id: "1.1", title: "S", prompt: "p", answer_format: "a" }] }],
  });
  const pub = publicBeleidskompasConfig(flow, "v7");
  assert.deepEqual(Object.keys(pub), ["version_id", "title", "disclaimer", "specialist_team", "steps"]);
  assert.equal(pub.version_id, "v7");
  assert.deepEqual(pub.steps[0], { id: "stap1", nr: 1, title: "T", description: "D", substeps: [{ id: "1.1", title: "S" }] });
  assert.equal(pub.steps.length, 4);
  // The file nginx serves, written on startup from the default flow.
  const published = fs.readFileSync(publicFile, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(published)).sort(), ["disclaimer", "specialist_team", "steps", "title", "version_id"]);
  for (const leak of ["secret-token", "Antwoord in markdown", "Deelstap", "prompt"]) assert.ok(!published.includes(leak), leak);
});

test("an empty prompt-like field means the seed text; the four steps are fixed", () => {
  const seed = normalizeBeleidskompasFlow({});
  assert.ok(seed.rules.includes("\n") && seed.report_prompt.includes("{{substeps}}") && seed.messages.store_failed);
  assert.ok(seed.steps[0].substeps[0].answer_format.startsWith("###"));
  const flow = normalizeBeleidskompasFlow({
    rules: " ",
    messages: { store_failed: "Eigen tekst" },
    steps: [
      { id: "stapX", title: "Vreemd" },
      { id: "stap1", prompt: "", substeps: [{ id: "1.1", prompt: "eigen", answer_format: "" }, { id: "1.9", title: "Nieuw" }] },
    ],
  });
  assert.equal(flow.rules, seed.rules);
  assert.deepEqual(flow.messages, { ...seed.messages, store_failed: "Eigen tekst" });
  assert.deepEqual(flow.steps.map((s) => s.id), ["stap1", "stap2", "stap3", "stap4"]);
  assert.equal(flow.steps[0].prompt, seed.steps[0].prompt);
  assert.equal(flow.steps[0].substeps[0].prompt, "eigen");
  assert.equal(flow.steps[0].substeps[0].answer_format, seed.steps[0].substeps[0].answer_format);
  assert.deepEqual(flow.steps[0].substeps[1], { id: "1.9", title: "Nieuw", description: "", prompt: "", answer_format: "" });
});

test("a step that still has the old default substeps gets the current ones; changed substeps stay", () => {
  const { steps } = normalizeBeleidskompasFlow({
    steps: [
      { id: "stap1", substeps: [{ id: "1.1", title: "Mijn titel" }] },
      { id: "stap2", substeps: [{ id: "2.1", title: "Rolopties" }, { id: "2.2", title: "Afweging" }] },
    ],
  });
  assert.deepEqual(steps[0].substeps.map((s) => s.title), ["Mijn titel"]);
  assert.deepEqual(steps[1].substeps.map((s) => `${s.id} ${s.title}`), ["2.1 Rolbepaling"]);
});

test("publish with live: false saves a version without making it live", async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=test-password", redirect: "manual" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const state = async () => (await (await fetch(`${base}/api/beleidskompas/state`, { headers: { cookie } })).json()).state;
    const before = await state();
    const publishedBefore = fs.readFileSync(publicFile, "utf8");
    const saved = await (await fetch(`${base}/api/beleidskompas/publish`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ flow: { ...before.live, title: "Niet live" }, note: "n", live: false }) })).json();
    const after = await state();
    assert.equal(after.live_version_id, before.live_version_id);
    assert.equal(after.versions[0].id, saved.version.id);
    assert.equal(after.live.title, before.live.title);
    assert.equal(fs.readFileSync(publicFile, "utf8"), publishedBefore);
  } finally {
    server.close();
  }
});
