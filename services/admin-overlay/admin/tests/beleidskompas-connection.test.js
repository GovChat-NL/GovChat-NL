"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { connectionSettings, listMigrations, applyMigrations } = require("../db/connection");

test("connectionSettings reads host and password from the environment, with user and database fixed", () => {
  const settings = connectionSettings({ BELEIDSKOMPAS_DB_HOST: " beleidskompas-postgres ", BELEIDSKOMPAS_DB_PASSWORD: "p@ss:word" });
  assert.deepEqual(settings, { host: "beleidskompas-postgres", port: 5432, user: "beleidskompas", database: "beleidskompas", password: "p@ss:word" });
  assert.equal(connectionSettings({}).host, "");
});

test("the migrations are numbered SQL files in order, starting with the tables", () => {
  const migrations = listMigrations();
  assert.ok(migrations.length >= 1);
  assert.equal(migrations[0].name, "0001-init.sql");
  assert.match(migrations[0].sql, /CREATE TABLE cases/);
  assert.deepEqual(migrations.map((m) => m.name), [...migrations.map((m) => m.name)].sort());
});

test("applyMigrations runs only the migrations that have not run yet, each in a transaction", async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    if (sql.startsWith("SELECT name FROM schema_migrations")) return { rows: [{ name: "0001-init.sql" }] };
    return { rows: [] };
  };
  const applied = await applyMigrations(query, [
    { name: "0001-init.sql", sql: "CREATE TABLE cases ()" },
    { name: "0002-status.sql", sql: "ALTER TABLE reports ADD status TEXT" },
  ]);
  assert.deepEqual(applied, ["0002-status.sql"]);
  const sqls = calls.map((c) => c.sql);
  assert.ok(sqls[0].startsWith("CREATE TABLE IF NOT EXISTS schema_migrations"));
  assert.ok(!sqls.includes("CREATE TABLE cases ()"));
  assert.deepEqual(sqls.slice(2), ["BEGIN", "ALTER TABLE reports ADD status TEXT", "INSERT INTO schema_migrations (name) VALUES ($1)", "COMMIT"]);
  assert.deepEqual(calls[4].params, ["0002-status.sql"]);
});

test("a failing migration is rolled back and reported by name", async () => {
  const calls = [];
  const query = async (sql) => {
    calls.push(sql);
    if (sql === "BROKEN") throw new Error("syntax error");
    return { rows: [] };
  };
  await assert.rejects(applyMigrations(query, [{ name: "0001-init.sql", sql: "BROKEN" }]), /Migration 0001-init.sql failed: syntax error/);
  assert.equal(calls[calls.length - 1], "ROLLBACK");
});
