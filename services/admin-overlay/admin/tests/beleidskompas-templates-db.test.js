"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const { connectionSettings, applyMigrations } = require("../db/connection");
const { createTemplateStore } = require("../lib/beleidskompas/template-store");
const { mount } = require("../lib/beleidskompas/admin-routes");

const enabled = process.env.BELEIDSKOMPAS_DB_TEST === "true" && connectionSettings().host;

test("admin template API persists UI actions in PostgreSQL", { skip: !enabled && "requires test PostgreSQL" }, async (t) => {
  const { Pool } = require("pg");
  const express = require("express");
  const schema = `templates_test_${process.pid}_${Date.now()}`;
  const admin = new Pool(connectionSettings());
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...connectionSettings(), options: `-c search_path=${schema},public`, max: 5 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const client = await pool.connect();
  try { await applyMigrations((sql, params) => client.query(sql, params)); } finally { client.release(); }

  let store = createTemplateStore(pool, { retention_days: 365 });
  let failPublication = false;
  let published = null;
  const app = express();
  app.use(express.json());
  const defaultFlow = () => ({ title: "Default", steps: [] });
  mount(app, {
    requireAuth: (req, res, next) => req.headers["x-test-admin"] === "yes" ? next() : res.sendStatus(401),
    getStore: () => store,
    normalizeFlow: (flow) => structuredClone(flow), defaultFlow,
    publishLive: async (flow) => {
      if (failPublication) throw new Error("publication unavailable");
      published = flow;
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  // Exercise the same ES module used by the browser, against the real HTTP API.
  global.fetch = (url, options = {}) => originalFetch(`${base}${url}`, {
    ...options, headers: { ...options.headers, "x-test-admin": "yes" },
  });
  const source = fs.readFileSync(path.join(__dirname, "../views/beleidskompas-admin/api.js"), "utf8");
  const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

  await t.test("admin authentication and database availability are enforced", async () => {
    assert.equal((await originalFetch(`${base}/api/beleidskompas/state`)).status, 401);
    const ready = store;
    store = null;
    await assert.rejects(api.getState(), /database is not available/);
    store = ready;
  });

  let first, second, document, saved;
  await t.test("empty database supports first template creation without deploying it", async () => {
    assert.deepEqual((await api.getState()).state.templates, []);
    first = await api.saveAsNewTemplate("First template", defaultFlow());
    assert.equal(first.versions[0].version, 1);
    assert.equal(first.live_version_id, null);
    assert.equal((await api.getState()).state.live, null);
    assert.equal((await pool.query("SELECT name FROM templates")).rows[0].name, "First template");
    await assert.rejects(api.saveAsNewTemplate(" ", defaultFlow()), /name is required/);
    await assert.rejects(api.saveAsNewTemplate("Twice", { steps: [{ substeps: [{ id: "1.1" }, { id: "1.1" }] }] }), /used more than once/);
  });

  await t.test("documents, saved versions and copies persist independently", async () => {
    const content = Buffer.from("# Gebiedsvisie — één provincie", "utf8");
    // uploadDocument reads FileReader in the browser; test that same route with its wire payload.
    const uploaded = await global.fetch("/api/beleidskompas/documents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "visie.md", mime_type: "text/markdown", content_base64: content.toString("base64") }),
    });
    assert.equal(uploaded.status, 201);
    document = (await uploaded.json()).document;
    assert.equal((await api.listDocuments())[0].preview_text, content.toString());
    const flow = { title: "Edited", steps: [{ id: "one", document_ids: [document.id] }] };
    saved = (await api.saveVersion(first.id, flow, "An edit")).version;
    assert.equal(saved.version, 2);
    second = await api.saveAsNewTemplate("Second template", flow);
    store = createTemplateStore(pool, { retention_days: 365 }); // Fresh instance, no browser/in-memory state.
    const state = (await api.getState()).state;
    assert.equal(state.templates.length, 2);
    assert.equal(state.templates.find((tpl) => tpl.id === first.id).versions[0].snapshot.title, "Edited");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM version_documents")).rows[0].n, 2);
    assert.equal(published, null, "saving never publishes");
    await assert.rejects(api.deleteDocument(document.id), /saved version/);
    await api.updateDocument(document.id, { filename: "renamed.md" });
    const download = await global.fetch(api.downloadUrl(document.id));
    assert.equal(await download.text(), content.toString());
  });

  await t.test("concurrent saves receive distinct sequential version numbers", async () => {
    const results = await Promise.all([api.saveVersion(first.id, defaultFlow(), "A"), api.saveVersion(first.id, defaultFlow(), "B")]);
    assert.deepEqual(results.map((r) => r.version.version).sort(), [3, 4]);
    const before = (await pool.query("SELECT count(*)::int AS n FROM templates")).rows[0].n;
    await assert.rejects(api.saveAsNewTemplate("Invalid document", { steps: [{ document_ids: ["999999"] }] }), /no longer exists/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM templates")).rows[0].n, before, "failed creation rolls back the template too");
  });

  await t.test("deploy validates ownership and leaves exactly one global live version", async () => {
    await assert.rejects(api.deployVersion(second, saved.id), /not found for this template/);
    await api.deployVersion(first, saved.id);
    assert.equal(published.title, "Edited");
    assert.equal((await api.getState()).state.templates.find((tpl) => tpl.id === first.id).live_version_id, saved.id);
    await api.deployVersion(second, second.versions[0].id);
    const state = (await api.getState()).state;
    assert.equal(state.templates.filter((tpl) => tpl.live_version_id).length, 1);
    assert.equal(state.templates.find((tpl) => tpl.id === first.id).live_version_id, null);
    failPublication = true;
    const errorLog = console.error;
    console.error = () => {};
    try { await assert.rejects(api.deployVersion(first, saved.id), /Template request failed/); }
    finally { console.error = errorLog; failPublication = false; }
    assert.equal((await api.getState()).state.templates.find((tpl) => tpl.id === second.id).live_version_id, second.versions[0].id);
  });

  await t.test("export/import creates a persistent copy with documents; settings survive reload", async () => {
    const exported = await (await global.fetch(api.exportUrl(second.id))).json();
    assert.equal(exported.documents.length, 1);
    const imported = (await api.importState({ ...exported, name: "Imported" })).template;
    assert.equal(imported.live_version_id, null);
    assert.equal(imported.versions[0].snapshot.steps[0].document_ids[0], document.id);
    await api.saveSettings({ retention_days: 30 });
    store = createTemplateStore(pool, { retention_days: 365 });
    assert.equal((await api.getState()).state.settings.retention_days, 30);
    const current = store;
    store = { getState: async () => { throw new Error("private database password"); } };
    const errorLog = console.error;
    console.error = () => {};
    try {
      const response = await global.fetch("/api/beleidskompas/state");
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "Template request failed" });
    } finally { store = current; console.error = errorLog; }
  });
});
