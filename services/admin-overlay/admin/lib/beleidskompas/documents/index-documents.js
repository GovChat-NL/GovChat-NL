"use strict";

/**
 * Makes the uploaded documents searchable, in the background.
 *
 * A document waits with the status "pending". The indexer looks for waiting
 * documents every few seconds, so nothing has to tell it that a document
 * came in. It takes them one by one: it reads the text, cuts it into
 * chunks, asks for their embeddings and stores them. While it works the
 * status is "indexing", after that "ready", or "failed" with the reason in
 * index_error.
 *
 * The chunks of a document are replaced only when all of this went well, so
 * a document that fails keeps the chunks it had.
 */

const { extractText } = require("./extract");
const { chunkBlocks } = require("./chunk");
const { embedChunks } = require("./embed");

const LOOK_EVERY_MS = 5000;

/** `store` is the document store. `deps` replaces the embedding model and
 *  the log in the tests. */
function createDocumentIndexer(store, deps = {}) {
  const { embed = embedChunks, log = console } = deps;

  async function indexDocument(documentId) {
    try {
      const file = await store.getFile(documentId);
      // Deleted since it was taken.
      if (!file) return;

      const blocks = await extractText(file);
      const chunks = await embed(chunkBlocks(blocks));
      // A document of headings only has text, but nothing to search in.
      if (!chunks.length) throw new Error("No text found in this document");

      await store.saveChunks(documentId, chunks);
      log.log(`[govchat-admin] Beleidskompas document ${documentId} indexed (${chunks.length} chunks)`);
    } catch (err) {
      await store.markFailed(documentId, err.message);
      log.error(`[govchat-admin] Beleidskompas document ${documentId} could not be indexed: ${err.message}`);
    }
  }

  let running = false;

  /** Indexes the waiting documents, one at a time. */
  async function indexPending() {
    if (running) return;
    running = true;
    try {
      let documentId = await store.takePending();
      while (documentId !== null) {
        await indexDocument(documentId);
        documentId = await store.takePending();
      }
    } catch (err) {
      log.error(`[govchat-admin] Beleidskompas documents could not be indexed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  /** Starts looking for waiting documents, now and every few seconds. */
  async function start() {
    try {
      await store.requeueInterrupted();
    } catch (err) {
      log.error(`[govchat-admin] Beleidskompas documents could not be indexed: ${err.message}`);
    }
    await indexPending();
    // unref, so the timer does not keep the process from stopping.
    setInterval(indexPending, LOOK_EVERY_MS).unref();
  }

  return { indexPending, start };
}

module.exports = { createDocumentIndexer };
