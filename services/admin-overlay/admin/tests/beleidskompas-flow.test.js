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

test("a new substep gets a random code, not a number that says where it is", async () => {
  const { newSubstepId } = await import("../views/beleidskompas-admin/pages/flow.js");
  const first = newSubstepId();
  assert.match(first, /^sub_[a-z0-9]{8}$/);
  assert.notEqual(newSubstepId(), first);
});

test("moved substeps are saved and published in their new order, with their own ids and prompts", () => {
  const seed = normalizeBeleidskompasFlow({});
  const [a, b, c, ...rest] = seed.steps[0].substeps;
  const flow = normalizeBeleidskompasFlow({ ...seed, steps: [{ ...seed.steps[0], substeps: [c, b, a, ...rest] }, ...seed.steps.slice(1)] });
  assert.deepEqual(flow.steps[0].substeps.map((s) => [s.id, s.prompt]), [c, b, a, ...rest].map((s) => [s.id, s.prompt]));
  assert.deepEqual(publicBeleidskompasConfig(flow, "v1").steps[0].substeps.map((s) => s.id), [c, b, a, ...rest].map((s) => s.id));
});

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
  assert.ok(seed.rules.includes("\n") && seed.report_prompt.includes("{{substeps}}"));
  assert.ok(seed.steps[0].substeps[0].answer_format.startsWith("###"));
  const firstId = seed.steps[0].substeps[0].id;
  const flow = normalizeBeleidskompasFlow({
    rules: " ",
    steps: [
      { id: "stapX", title: "Vreemd" },
      { id: "stap1", prompt: "", substeps: [{ id: firstId, prompt: "eigen", answer_format: "" }, { id: "1.9", title: "Nieuw" }] },
    ],
  });
  assert.equal(flow.rules, seed.rules);
  assert.deepEqual(flow.steps.map((s) => s.id), ["stap1", "stap2", "stap3", "stap4"]);
  assert.equal(flow.steps[0].prompt, seed.steps[0].prompt);
  assert.equal(flow.steps[0].substeps[0].prompt, "eigen");
  assert.equal(flow.steps[0].substeps[0].answer_format, seed.steps[0].substeps[0].answer_format);
  assert.deepEqual(flow.steps[0].substeps[1], { id: "1.9", title: "Nieuw", description: "", prompt: "", answer_format: "" });
  assert.ok(!("webhook_token" in flow) && !("workflow_id" in flow.steps[0]));
});

test("a template in which two substeps share an id is refused, on publish and on import", async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=test-password", redirect: "manual" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const post = (url, body) => fetch(`${base}${url}`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const state = async () => (await (await fetch(`${base}/api/beleidskompas/state`, { headers: { cookie } })).json()).state;

    const before = await state();
    const [stap1, stap2, ...rest] = before.live.steps;
    // The substep of step 2 gets the id of the first substep of step 1.
    const duplicated = { ...before.live, steps: [stap1, { ...stap2, substeps: [{ ...stap2.substeps[0], id: stap1.substeps[0].id }] }, ...rest] };
    const message = `Deelstap-id ${stap1.substeps[0].id} komt meer dan één keer voor in het template.`;

    const published = await post("/api/beleidskompas/publish", { flow: duplicated, note: "dubbel", live: false });
    assert.equal(published.status, 400);
    assert.equal((await published.json()).error, message);

    const imported = await post("/api/beleidskompas/import", { state: { ...before, versions: [{ ...before.versions[0], snapshot: duplicated }] } });
    assert.equal(imported.status, 400);
    assert.equal((await imported.json()).error, message);

    assert.deepEqual(await state(), before);
  } finally {
    server.close();
  }
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
