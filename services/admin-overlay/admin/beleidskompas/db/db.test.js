const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createDb, isUniqueViolation } = require("./db");

const { skip, openTestPool } = require("./db-fixture");

const opts = { skip };
let db, close;

before(async () => {
  if (skip) return;
  const fixture = await openTestPool("beleidskompas_db_test");
  close = fixture.close;
  db = createDb(fixture.pool);
});
after(async () => { if (close) await close(); });

test("the migrations create the template tables", opts, async () => {
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
