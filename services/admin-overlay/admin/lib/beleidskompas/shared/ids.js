"use strict";

const { HttpError } = require("./errors");

/** The id of a row as text, or a 400 when `value` is not such an id. */
function requireId(value) {
  const text = String(value ?? "");
  // An id is a whole number above zero, written without a leading zero.
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new HttpError(400, "Invalid id");
  return text;
}

module.exports = { requireId };
