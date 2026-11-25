"use strict";

/**
 * Reads a document a user uploads in a Beleidskompas chat: checks the type
 * and the size against the upload settings and extracts the text. Errors
 * are StoreErrors with a Dutch message the page can show.
 */

const path = require("path");
const { StoreError } = require("./store");
const { ExtractError, extractText } = require("./documents/extract");

// The formats extract.js reads.
const SUPPORTED_TYPES = ["pdf", "docx", "pptx", "xlsx", "odt", "odp", "ods", "rtf", "txt", "md"];
const DEFAULT_UPLOAD = { upload_max_mb: 10, upload_allowed_types: SUPPORTED_TYPES };

/** `settings` holds upload_max_mb and upload_allowed_types. Returns
 *  `{ filename, size, text }`. */
async function readChatDocument({ filename, content_base64 }, settings = {}, deps = {}) {
  const name = path.basename(String(filename || "").trim());
  if (!name || typeof content_base64 !== "string") throw new StoreError(400, "Een bestandsnaam en de inhoud zijn verplicht.");

  const allowed = settings.upload_allowed_types || DEFAULT_UPLOAD.upload_allowed_types;
  const type = path.extname(name).slice(1).toLowerCase();
  if (!allowed.includes(type)) throw new StoreError(415, `Bestanden van het type .${type || "?"} worden niet ondersteund. Toegestaan: ${allowed.join(", ")}.`);

  const content = Buffer.from(content_base64, "base64");
  const maxMb = settings.upload_max_mb || DEFAULT_UPLOAD.upload_max_mb;
  if (content.length > maxMb * 1024 * 1024) throw new StoreError(413, `Het bestand is groter dan ${maxMb} MB.`);

  let blocks;
  try {
    blocks = await extractText({ filename: name, content }, deps);
  } catch (err) {
    if (!(err instanceof ExtractError)) throw err;
    if (err.code === "unsupported") throw new StoreError(415, `Bestanden van het type .${type} worden niet ondersteund.`);
    if (err.code === "no_text") throw new StoreError(422, "In dit document staat geen leesbare tekst (is het misschien gescand?).");
    throw new StoreError(422, "Dit document kan niet worden gelezen.");
  }
  // Postgres cannot store NUL, which a UTF-16 text file or some PDFs contain.
  const text = blocks.map((b) => (b.heading ? `## ${b.text}` : b.text)).join("\n\n").replace(/\u0000/g, "");
  if (!text.trim()) throw new StoreError(422, "In dit document staat geen leesbare tekst (is het misschien gescand?).");
  return { filename: name, size: content.length, text };
}

module.exports = { SUPPORTED_TYPES, DEFAULT_UPLOAD, readChatDocument };
