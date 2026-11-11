"use strict";

/**
 * Error that needs to be raised, and the retry for a version number that two writers took at once.
 */

class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Postgres raises this code when an insert hits an existing primary or unique key.
const UNIQUE_VIOLATION = "23505";

const isUniqueViolation = (err) => Boolean(err) && err.code === UNIQUE_VIOLATION;

/** Runs `insert` again once when it collides with a version number that
 *  another insert took in the meantime. The version is read and written in
 *  one statement, so a collision is rare and the second try gets the next
 *  number. */
async function withOneRetry(insert) {
  try {
    return await insert();
  } catch (err) {
    if (isUniqueViolation(err)) return insert();
    throw err;
  }
}

module.exports = { StoreError, UNIQUE_VIOLATION, isUniqueViolation, withOneRetry };
