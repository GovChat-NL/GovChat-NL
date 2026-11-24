"use strict";

// An error that a route answers with the given HTTP status and message.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { HttpError };
