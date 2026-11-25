"use strict";

/**
 * Searches the documents of a step for the chunks that fit a question.
 *
 * `templates` and `documents` are the two repositories: the live template
 * says which documents a step has, and the chunks are with the documents.
 * `deps` replaces the embedding model in the tests.
 */

const { HttpError } = require("../shared/errors");
const { embedQuestion } = require("./embed");

// How many chunks a search returns, the best ones first. This number is
// known as top k.
const TOP_K = 8;

function createDocumentSearch({ templates, documents }, deps = {}) {
  const { embed = embedQuestion } = deps;

  /** The chunks of the documents of a step that fit `question` best, the
   *  best one first, with `document_count`, the number of documents the
   *  step has. A step without documents has no chunks. */
  async function searchStep(stepId, question) {
    const text = String(question || "").trim();
    if (!text) throw new HttpError(400, "Question is required");

    const documentIds = await templates.getLiveDocumentIds(stepId);
    if (!documentIds) throw new HttpError(404, "Step not found in the live template");
    if (!documentIds.length) return { document_count: 0, chunks: [] };

    const embedding = await embed(text);
    const chunks = await documents.searchChunks({ question: text, embedding, documentIds, limit: TOP_K });
    return { document_count: documentIds.length, chunks };
  }

  return { searchStep };
}

module.exports = { createDocumentSearch };
