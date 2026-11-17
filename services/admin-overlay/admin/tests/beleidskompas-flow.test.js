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
process.env.BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN = "secret-token";
const { app, normalizeBeleidskompasFlow, publicBeleidskompasConfig } = require("../server.js");
const publicFile = path.join(process.env.PUBLISH_DIR, "beleidskompas-config.json");
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("the public config holds only what the Beleidskompas page reads", () => {
  const flow = normalizeBeleidskompasFlow({
    rules: "r",
    steps: [{ id: "stap1", title: "T", description: "D", prompt: "P", document_ids: ["d1"], substeps: [{ id: "1.1", title: "S", prompt: "p", answer_format: "a" }] }],
  });
  const pub = publicBeleidskompasConfig(flow);
  assert.deepEqual(pub, { title: flow.title, disclaimer: flow.disclaimer, specialist_team: flow.specialist_team, steps: [{ id: "stap1", title: "T", description: "D" }] });
  assert.ok(!JSON.stringify(pub).includes("secret-token"));
  // The file nginx serves, written on startup from the default flow (which carries the token).
  const published = fs.readFileSync(publicFile, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(published)).sort(), ["disclaimer", "specialist_team", "steps", "title"]);
  assert.ok(!published.includes("secret-token"));
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
