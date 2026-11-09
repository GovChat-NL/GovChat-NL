const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

function createDb({ connectionString, schema = "beleidskompas" }) {
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  pool.on("error", (err) => console.error("[db] idle client error", err));

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn((text, params) => client.query(text, params));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function applySchema() {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  }

  return { query: (text, params) => pool.query(text, params), transaction, applySchema, end: () => pool.end() };
}

const isUniqueViolation = (err) => err.code === "23505";

module.exports = { createDb, isUniqueViolation };
