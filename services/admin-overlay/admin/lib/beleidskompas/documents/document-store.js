"use strict";

/**
 * The documents in the database, as far as indexing them goes: which
 * document waits, its file, its chunks and its index_status.
 *
 * createDocumentStore takes the pg pool of the Beleidskompas database.
 */

/** An embedding as pgvector reads it: "[0.1,0.2]". */
function toVector(embedding) {
  return `[${embedding.join(",")}]`;
}

/** Postgres refuses text with a NUL character, which a PDF can hold. */
function withoutNul(text) {
  return text.replaceAll("\u0000", "");
}

function createDocumentStore(pool) {
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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM document_chunks WHERE document_id = $1", [documentId]);
      for (const chunk of chunks) {
        await client.query(
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
      await client.query("UPDATE documents SET index_status = 'ready', index_error = '' WHERE id = $1", [documentId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async function markFailed(documentId, reason) {
    await pool.query("UPDATE documents SET index_status = 'failed', index_error = $2 WHERE id = $1", [documentId, reason]);
  }

  /** Lets a document wait again, so it is indexed once more. Returns
   *  whether the document exists. */
  async function requeue(documentId) {
    const { rows } = await pool.query(
      "UPDATE documents SET index_status = 'pending', index_error = '' WHERE id = $1 RETURNING id",
      [documentId],
    );
    return rows.length > 0;
  }

  return { requeueInterrupted, takePending, getFile, saveChunks, markFailed, requeue };
}

module.exports = { createDocumentStore };
