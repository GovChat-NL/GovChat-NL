// Gives the admin store `query` and `transaction` on top of the shared Beleidskompas pool
// (db/connection.js). The schema is not created here: db/migrations is applied at startup
// by lib/beleidskompas.

function createDb(pool) {
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

  return { query: (text, params) => pool.query(text, params), transaction };
}

const isUniqueViolation = (err) => err.code === "23505";

module.exports = { createDb, isUniqueViolation };
