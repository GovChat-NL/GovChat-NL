// For the database tests of the stores: a pool on a schema of its own, with the migrations applied, dropped
// again afterwards, so the data of the service stays as it is. Run with `make test-beleidskompas-db`
// (BELEIDSKOMPAS_DB_TEST=true and the BELEIDSKOMPAS_DB_* settings of the service); without them
// the tests are skipped.

const { connectionSettings, applyMigrations } = require("../db/connection");

const enabled = String(process.env.BELEIDSKOMPAS_DB_TEST || "").toLowerCase() === "true" && Boolean(connectionSettings().host);
const skip = enabled ? false : "set BELEIDSKOMPAS_DB_TEST=true and the BELEIDSKOMPAS_DB_* settings";

async function openTestPool(name) {
  const { Pool } = require("pg"); // here, so the tests load (and skip) without pg installed
  const schema = `${name}_${Date.now()}`;
  const admin = new Pool({ ...connectionSettings(), max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ ...connectionSettings(), options: `-c search_path=${schema}` });
  const client = await pool.connect();
  try {
    await applyMigrations((sql, params) => client.query(sql, params));
  } finally {
    client.release();
  }
  const close = async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  };
  return { pool, close };
}

module.exports = { skip, openTestPool };
