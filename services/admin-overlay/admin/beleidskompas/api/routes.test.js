// HTTP-level tests for the Beleidskompas router. No database: store and flow helpers are fakes.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createBeleidskompasRouter } = require("./routes");
const { createService } = require("./service");

const calls = [];
const current = { versionId: 7, snapshot: { title: "T", steps: [] }, documentIds: [1] };
const store = {
  getCurrent: async (id) => (id === 1 ? current : null),
  getLive: async () => ({ template_id: 1, version_id: 7, snapshot: current.snapshot, documents: [] }),
  listTemplates: async () => [{ id: 1, name: "A", versions: [] }],
  getSettings: async () => null,
  saveVersion: async (...args) => { calls.push(["saveVersion", ...args]); return { version: { id: 8, version: 2 }, isLive: true }; },
  getDocument: async (id) => (id === 1 ? { id: 1, filename: "a.txt", mime_type: "text/plain", preview_text: "hi", content: Buffer.from("hello") } : null),
  listDocuments: async () => [{ id: 1, filename: "a.txt", active: true }],
};
const flow = {
  DEFAULT_BELEIDSKOMPAS_SETTINGS: { retention_days: 365 },
  normalizeBeleidskompasFlow: (f) => f ?? { steps: [] },
  defaultBeleidskompasFlow: () => ({ steps: [] }),
  readBeleidskompasWorkflowManifest: () => null,
  selectBeleidskompasRagDocs: () => ({ rag: {}, docs: [] }),
  normalizeLegacyState: (s) => s,
  publishLive: async () => { calls.push(["publishLive"]); return { synced: true }; },
  n8nBaseUrl: "http://n8n:5678",
  n8nWebhookToken: "",
};

let server, base, authed = true;
before(async () => {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => (authed ? next() : res.status(401).json({ error: "auth" }));
  const service = createService({ store, publishLive: flow.publishLive });
  app.use("/api/beleidskompas", createBeleidskompasRouter({ store, service, requireAuth, flow }));
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/beleidskompas`;
});
after(() => server.close());

const json = (method, path, body) => fetch(base + path, {
  method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
});

test("GET /state returns templates, merged settings and the live pointer", async () => {
  const res = await json("GET", "/state");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.live, { template_id: 1, version_id: 7 });
  assert.equal(body.settings.retention_days, 365);
  assert.equal(body.templates[0].name, "A");
});

test("requests without auth are rejected", async () => {
  authed = false;
  try { assert.equal((await json("GET", "/state")).status, 401); } finally { authed = true; }
});

test("unknown template gives 404", async () => {
  const res = await json("GET", "/templates/99/documents");
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "Template niet gevonden");
});

test("POST /templates requires a name", async () => {
  assert.equal((await json("POST", "/templates", { name: "  " })).status, 400);
});

test("POST /templates/:id/versions saves a version and publishes when live", async () => {
  calls.length = 0;
  const res = await json("POST", "/templates/1/versions", { flow: { steps: [] }, note: "n" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.version.version, 2);
  assert.deepEqual(body.workflow_manifest, { synced: true });
  assert.equal(calls[0][0], "saveVersion");
  assert.deepEqual(calls[0][3], [1]); // keeps the current documents
  assert.equal(calls.at(-1)[0], "publishLive");
});

test("document download sends the bytes with the stored content type", async () => {
  const res = await fetch(`${base}/documents/1/download`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain");
  assert.equal(await res.text(), "hello");
  assert.equal((await fetch(`${base}/documents/2/download`)).status, 404);
});

test("DELETE document that is not active in the template gives 404", async () => {
  const res = await json("DELETE", "/templates/1/documents/1");
  assert.equal(res.status, 200); // doc 1 is active, so removal works
  store.getCurrent = async () => ({ ...current, documentIds: [] });
  assert.equal((await json("DELETE", "/templates/1/documents/1")).status, 404);
});
