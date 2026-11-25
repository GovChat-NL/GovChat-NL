"use strict";

// An error that a route answers with the given HTTP status and message.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Postgres raises this code when a row points to a row that does not exist,
// or when a row is deleted while another row still points to it.
const FOREIGN_KEY_VIOLATION = "23503";

module.exports = { HttpError, FOREIGN_KEY_VIOLATION };
