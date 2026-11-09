const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createDb, isUniqueViolation } = require("./db");

const url = process.env.BELEIDSKOMPAS_TEST_DATABASE_URL;
const opts = url ? {} : { skip: "BELEIDSKOMPAS_TEST_DATABASE_URL not set" };
let db;

before(async () => {
  if (!url) return;
  const admin = createDb({ connectionString: url, schema: "public" });
  await admin.query("DROP SCHEMA IF EXISTS beleidskompas_test CASCADE");
  await admin.end();
  db = createDb({ connectionString: url, schema: "beleidskompas_test" });
});
after(async () => { if (db) await db.end(); });

test("applySchema is idempotent and sets the search_path", opts, async () => {
  await db.applySchema();
  await db.applySchema();
  const { rows } = await db.query("SELECT current_schemas(false) AS s");
  assert.ok(rows[0].s.includes("beleidskompas_test"));
  const t = await db.query("SELECT count(*)::int AS n FROM templates");
  assert.equal(t.rows[0].n, 0);
});

test("transaction rolls back on throw", opts, async () => {
  await assert.rejects(db.transaction(async (q) => {
    await q("INSERT INTO templates (name) VALUES ($1)", ["x"]);
    throw new Error("boom");
  }));
  const t = await db.query("SELECT count(*)::int AS n FROM templates");
  assert.equal(t.rows[0].n, 0);
});

test("isUniqueViolation detects duplicate keys", opts, async () => {
  await db.query("INSERT INTO settings (data) VALUES ('{}')");
  await assert.rejects(db.query("INSERT INTO settings (data) VALUES ('{}')"), isUniqueViolation);
});
