"use strict";

// Runs the store against a real Postgres. Needs BELEIDSKOMPAS_DB_TEST=true
// and the same BELEIDSKOMPAS_DB_* settings as the service, so it is meant
// to run inside the admin container: `make test-beleidskompas-db`. Without
// those settings every test here is skipped. It works in a schema of its
// own that is dropped afterwards, so the data of the service stays as it is.

const test = require("node:test");
const assert = require("node:assert/strict");

const { connectionSettings, applyMigrations } = require("../db/connection");
const { createStore } = require("../lib/beleidskompas/store");

const enabled = String(process.env.BELEIDSKOMPAS_DB_TEST || "").toLowerCase() === "true" && connectionSettings().host;

test("the store against a real Postgres", { skip: !enabled && "set BELEIDSKOMPAS_DB_TEST=true and the BELEIDSKOMPAS_DB_* settings" }, async () => {
  const { Client } = require("pg");
  const client = new Client(connectionSettings());
  await client.connect();
  const schema = `test_${Date.now()}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const query = (sql, params) => client.query(sql, params);

    const applied = await applyMigrations(query);
    assert.ok(applied.includes("0001-init.sql"));
    assert.deepEqual(await applyMigrations(query), [], "a second run has nothing left to apply");

    const store = createStore(query);

    assert.deepEqual(await store.setCaseText({ caseId: "conv-1", userId: "user-a", text: "De casus." }), { version: 1, unchanged: false });
    assert.deepEqual(await store.setCaseText({ caseId: "conv-1", userId: "user-a", text: "De casus." }), { version: 1, unchanged: true });
    assert.deepEqual(await store.setCaseText({ caseId: "conv-1", userId: "user-a", text: "De casus, aangevuld." }), { version: 2, unchanged: false });

    assert.deepEqual(await store.addReport({ caseId: "conv-1", userId: "user-a", substepId: "1.1", content: { a: 1 }, text: "Rapport 1.1 v1", citations: [{ id: "doc-1" }] }), { version: 1 });
    assert.deepEqual(await store.addReport({ caseId: "conv-1", userId: "user-a", substepId: "1.1", content: { a: 2 }, text: "Rapport 1.1 v2" }), { version: 2 });
    assert.deepEqual(await store.addReport({ caseId: "conv-1", userId: "user-a", substepId: "1.2", content: { b: 1 }, text: "Rapport 1.2" }), { version: 1 });

    assert.deepEqual(await store.addTurn({ caseId: "conv-1", userId: "user-a", role: "user", askedFrom: "1.1", text: "Welke instrumenten?" }), { seq: 1 });
    assert.deepEqual(await store.addTurn({ caseId: "conv-1", userId: "user-a", role: "assistant", stepId: "stap3", askedFrom: "1.1", text: "Subsidie of verordening." }), { seq: 2 });
    await store.setTitle({ caseId: "conv-1", userId: "user-a", title: "Beleidskompas - Laadpalen" });

    const state = await store.getState({ caseId: "conv-1", userId: "user-a" });
    assert.equal(state.title, "Beleidskompas - Laadpalen");
    assert.equal(state.case_text.version, 2);
    assert.equal(state.case_text.text, "De casus, aangevuld.");
    assert.deepEqual(Object.keys(state.reports).sort(), ["1.1", "1.2"]);
    assert.equal(state.reports["1.1"].version, 2, "the newest version of a report counts");
    assert.deepEqual(state.reports["1.1"].content, { a: 2 });
    assert.deepEqual(state.reports["1.1"].citations, []);
    assert.deepEqual(state.turns.map((t) => [t.seq, t.role, t.step_id]), [[1, "user", null], [2, "assistant", "stap3"]]);

    const lastTurnOnly = await store.getState({ caseId: "conv-1", userId: "user-a", maxTurns: 1 });
    assert.deepEqual(lastTurnOnly.turns.map((t) => t.seq), [2]);

    assert.equal(await store.getState({ caseId: "conv-1", userId: "user-b" }), null, "another user cannot see the case");
    await assert.rejects(store.ensureCase({ id: "conv-1", userId: "user-b" }), (err) => err.status === 403);
    await assert.rejects(store.addTurn({ caseId: "conv-1", userId: "user-a", role: "system", text: "x" }), (err) => err.status === 400);

    await store.setCaseText({ caseId: "conv-2", userId: "user-a", text: "Tweede casus." });
    assert.deepEqual((await store.listCases({ userId: "user-a" })).map((c) => c.id), ["conv-2", "conv-1"], "newest first");
    assert.deepEqual(await store.listCases({ userId: "user-b" }), []);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
