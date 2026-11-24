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
const { normalizeBeleidskompasFlow, publicBeleidskompasConfig } = require("../server.js");
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
  assert.deepEqual(Object.keys(pub), ["version_id", "title", "disclaimer", "specialist_team", "steps", "upload"]);
  assert.equal(pub.upload.max_mb, 10);
  assert.ok(pub.upload.allowed_types.includes("pdf"));
  assert.deepEqual(publicBeleidskompasConfig(flow, "v7", { upload_max_mb: 3, upload_allowed_types: ["txt"] }).upload, { max_mb: 3, allowed_types: ["txt"] });
  assert.equal(pub.version_id, "v7");
  assert.deepEqual(pub.steps[0], { id: "stap1", nr: 1, title: "T", description: "D", substeps: [{ id: "1.1", title: "S" }] });
  assert.equal(pub.steps.length, 4);
  // What nginx serves for the default flow.
  const published = JSON.stringify(publicBeleidskompasConfig(normalizeBeleidskompasFlow({}), "1"));
  for (const leak of ["secret-token", "Antwoord in markdown", "Deelstap", "prompt"]) assert.ok(!published.includes(leak), leak);
});

test("an empty prompt-like field means the seed text; the four steps are fixed", () => {
  const seed = normalizeBeleidskompasFlow({});
  assert.ok(seed.rules.includes("\n") && seed.report_prompt.includes("{{substeps}}"));
  assert.ok(seed.steps[0].substeps[0].answer_format.startsWith("###"));
  const firstId = seed.steps[0].substeps[0].id;
  const flow = normalizeBeleidskompasFlow({
    rules: " ",
    webhook_token: "oud",
    steps: [
      { id: "stapX", title: "Vreemd" },
      { id: "stap1", prompt: "", workflow_id: "oud", substeps: [{ id: firstId, prompt: "eigen", answer_format: "" }, { id: "1.9", title: "Nieuw" }] },
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
