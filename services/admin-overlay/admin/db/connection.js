"use strict";

/**
 * The connection to the Beleidskompas database, and the migrations that
 * bring its schema up to date.
 *
 * The schema lives in migrations/ as numbered SQL files. applyMigrations
 * runs, at startup, the files that have not run yet, in order, and records
 * each in the table schema_migrations. A change to the schema is a new
 * file; an existing file is never edited, because it has already run on
 * installations out there.
 */

const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/** The settings for pg, from the environment. User and database name are
 *  fixed; the host and the password come from docker-compose.yml. */
function connectionSettings(env = process.env) {
  return {
    host: String(env.BELEIDSKOMPAS_DB_HOST || "").trim(),
    port: Number.parseInt(String(env.BELEIDSKOMPAS_DB_PORT || "5432"), 10) || 5432,
    user: "beleidskompas",
    database: "beleidskompas",
    password: String(env.BELEIDSKOMPAS_DB_PASSWORD || ""),
  };
}

/** Opens a pg pool, or returns null when no host is configured (then the
 *  Beleidskompas store is off and the service runs as before). `pg` is
 *  required here, not at the top, so the rest of the service loads without
 *  it. */
function openPool(env = process.env) {
  const settings = connectionSettings(env);
  if (!settings.host) return null;
  const { Pool } = require("pg");
  // 10 seconds is how long n8n waits for the store.
  const pool = new Pool({ ...settings, max: 5, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  // An idle connection that breaks, for example when the database restarts,
  // is reported here. Without a listener pg throws the error and the whole
  // service stops; with one, the pool opens a new connection on the next
  // query.
  pool.on("error", (err) => console.error(`[govchat-admin] Beleidskompas database connection lost: ${err.message}`));
  return pool;
}

/** The migration files in order: name and SQL. */
function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d{4}-.+\.sql$/.test(name))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), "utf-8") }));
}

/** Runs the migrations that are not in schema_migrations yet, each in its
 *  own transaction so a failing one leaves nothing half done. Returns the
 *  names that ran. `query(sql, params)` resolves to `{ rows }` and must run
 *  every statement on the same connection, because BEGIN and COMMIT only
 *  belong together on one connection; migrate below takes care of that for
 *  a pool. */
async function applyMigrations(query, migrations = listMigrations()) {
  await query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())", []);
  const { rows } = await query("SELECT name FROM schema_migrations", []);
  const done = new Set(rows.map((r) => r.name));
  const applied = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    await query("BEGIN", []);
    try {
      await query(migration.sql, []);
      await query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
      await query("COMMIT", []);
    } catch (err) {
      await query("ROLLBACK", []);
      throw new Error(`Migration ${migration.name} failed: ${err.message}`);
    }
    applied.push(migration.name);
  }
  return applied;
}

/** Applies the migrations through one connection taken from `pool`. */
async function migrate(pool) {
  const client = await pool.connect();
  try {
    return await applyMigrations((sql, params) => client.query(sql, params));
  } finally {
    client.release();
  }
}

/** Runs `fn` in one transaction on one connection from `pool`. `fn` gets a
 *  `query(sql, params)` that runs on that connection. The transaction is
 *  committed when `fn` returns and rolled back when it throws. */
async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn((sql, params) => client.query(sql, params));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { MIGRATIONS_DIR, connectionSettings, openPool, listMigrations, applyMigrations, migrate, transaction };
