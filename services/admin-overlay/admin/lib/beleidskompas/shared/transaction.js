"use strict";

/** Runs `run` with a client of `pool` inside one transaction: commits when
 *  `run` returns and rolls back when it throws. */
async function inTransaction(pool, run) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { inTransaction };
