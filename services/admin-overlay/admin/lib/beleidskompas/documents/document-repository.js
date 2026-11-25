"use strict";

/**
 * The documents of the document library in the database. The first
 * functions are for the library itself: listing, uploading, renaming,
 * downloading and deleting a document. The functions after those are for
 * indexing: which document waits, its file, its chunks and its
 * index_status.
 *
 * createDocumentRepository takes the pg pool of the Beleidskompas database.
 */

const crypto = require("crypto");
const { HttpError, FOREIGN_KEY_VIOLATION } = require("../shared/errors");
const { requireId } = require("../shared/ids");
const { inTransaction } = require("../shared/transaction");

const documentColumns = "id::text, filename, content_type AS mime_type, size AS size_bytes, preview_text, index_status, index_error, created_at AS uploaded_at";

/** An embedding as pgvector reads it: "[0.1,0.2]". */
function toVector(embedding) {
  return `[${embedding.join(",")}]`;
}

/** Postgres refuses text with a NUL character, which a PDF can hold. */
function withoutNul(text) {
  return text.replaceAll("\u0000", "");
}

function createDocumentRepository(pool) {
  async function listDocuments() {
    return (await pool.query(`SELECT ${documentColumns} FROM documents ORDER BY created_at DESC, id DESC`)).rows;
  }

  /** Stores a file, or returns the document that already holds the same
   *  file. Pass `db`, a client inside a transaction, only when the document
   *  has to be part of that transaction. */
  async function uploadDocument(doc, db = pool) {
    const filename = String(doc.filename || "").trim();
    if (!filename) throw new HttpError(400, "Filename is required");
    const content = Buffer.from(String(doc.content_base64 || ""), "base64");
    const mime = String(doc.mime_type || "application/octet-stream");
    // A file name that ends in .md or .txt, in capitals or not.
    const isText = mime.startsWith("text/") || /\.(md|txt)$/i.test(filename);
    const preview = isText ? content.toString("utf8").slice(0, 4000) : "";
    return (await db.query(
      `INSERT INTO documents (sha256, filename, content_type, size, preview_text, content) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256 RETURNING ${documentColumns}`,
      [crypto.createHash("sha256").update(content).digest("hex"), filename, mime, content.length, preview, content],
    )).rows[0];
  }

  async function updateDocument(documentId, filename) {
    if (!String(filename || "").trim()) throw new HttpError(400, "Filename is required");
    const { rows } = await pool.query(`UPDATE documents SET filename = $2 WHERE id = $1 RETURNING ${documentColumns}`, [requireId(documentId), filename.trim()]);
    if (!rows[0]) throw new HttpError(404, "Document not found");
    return rows[0];
  }

  /** A document with its file in `content`. */
  async function getDocument(documentId) {
    const { rows } = await pool.query(`SELECT ${documentColumns}, content FROM documents WHERE id = $1`, [requireId(documentId)]);
    if (!rows[0]) throw new HttpError(404, "Document not found");
    return rows[0];
  }

  async function deleteDocument(documentId) {
    try {
      const result = await pool.query("DELETE FROM documents WHERE id = $1 RETURNING id", [requireId(documentId)]);
      if (!result.rows[0]) throw new HttpError(404, "Document not found");
    } catch (err) {
      if (err.code === FOREIGN_KEY_VIOLATION) throw new HttpError(409, "Document belongs to a saved version and cannot be deleted");
      throw err;
    }
  }

  /** A document that was being indexed when the service stopped waits again. */
  async function requeueInterrupted() {
    await pool.query("UPDATE documents SET index_status = 'pending' WHERE index_status = 'indexing'");
  }

  /** Marks the next waiting document as indexing and returns its id, or
   *  null when none is waiting. */
  async function takePending() {
    const { rows } = await pool.query(
      `UPDATE documents SET index_status = 'indexing', index_error = ''
       WHERE id = (SELECT id FROM documents WHERE index_status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING id`,
    );
    return rows.length ? rows[0].id : null;
  }

  /** `{ filename, content }` of a document, or null when it no longer exists. */
  async function getFile(documentId) {
    const { rows } = await pool.query("SELECT filename, content FROM documents WHERE id = $1", [documentId]);
    return rows[0] || null;
  }

  /** Puts `chunks` in the place of the chunks the document had and marks
   *  the document as ready, in one transaction. `indexVersion` is the
   *  version of the indexing that made the chunks. */
  async function saveChunks(documentId, chunks, indexVersion) {
    await inTransaction(pool, async (db) => {
      await db.query("DELETE FROM document_chunks WHERE document_id = $1", [documentId]);
      for (const chunk of chunks) {
        await db.query(
          `INSERT INTO document_chunks (document_id, chunk_number, heading, text, location, page, embedding, embedding_model, index_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7::halfvec, $8, $9)`,
          [
            documentId,
            chunk.number,
            withoutNul(chunk.heading),
            withoutNul(chunk.text),
            chunk.location,
            chunk.page,
            toVector(chunk.embedding),
            chunk.embeddingModel,
            indexVersion,
          ],
        );
      }
      await db.query("UPDATE documents SET index_status = 'ready', index_error = '' WHERE id = $1", [documentId]);
    });
  }

  async function markFailed(documentId, reason) {
    await pool.query("UPDATE documents SET index_status = 'failed', index_error = $2 WHERE id = $1", [documentId, reason]);
  }

  /** Lets a document wait again, so it is indexed once more. */
  async function requeue(documentId) {
    const { rows } = await pool.query(
      "UPDATE documents SET index_status = 'pending', index_error = '' WHERE id = $1 RETURNING id",
      [requireId(documentId)],
    );
    if (!rows[0]) throw new HttpError(404, "Document not found");
  }

  return {
    listDocuments, uploadDocument, updateDocument, getDocument, deleteDocument,
    requeueInterrupted, takePending, getFile, saveChunks, markFailed, requeue,
  };
}

module.exports = { createDocumentRepository };
