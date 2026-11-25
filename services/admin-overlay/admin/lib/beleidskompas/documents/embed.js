"use strict";

/**
 * Asks the embedding model for embeddings, through LiteLLM.
 *
 * embedChunks takes the chunks of chunk.js and returns them with two
 * fields added: `embedding`, the numbers the model gives for the chunk, and
 * `embeddingModel`, the name of the model that gave them.
 *
 * embedQuestion returns the embedding of a question, to search the chunks
 * with. The same model has to embed the chunks and the question, because
 * embeddings of different models cannot be compared.
 */

// A large document goes to the model in several requests of this many chunks.
const CHUNKS_PER_REQUEST = 64;

const REQUEST_TIMEOUT_MS = 60000;

// The name LiteLLM gives the embedding model. The model behind the name
// gives 3072 numbers, which the embedding column in the database is made for.
const EMBEDDING_MODEL = "govchat-embedding";

function embeddingSettings(env = process.env) {
  return {
    url: String(env.LITELLM_URL || "http://litellm:4000").replace(/\/$/, "") + "/embeddings",
    apiKey: String(env.LITELLM_API_KEY || "").trim(),
    model: EMBEDDING_MODEL,
  };
}

/** What the model reads of a chunk: the text with its heading above it, so
 *  the embedding also says what the text is part of. */
function textToEmbed(chunk) {
  return chunk.heading ? `${chunk.heading}\n${chunk.text}` : chunk.text;
}

/** What LiteLLM says went wrong, from the body of a failed response. */
async function reasonOfFailure(response) {
  const body = await response.text();
  try {
    const message = JSON.parse(body).error?.message;
    if (message) return String(message);
  } catch {
    // The body is not JSON, so the body itself is the reason.
  }
  return body.slice(0, 300);
}

/** The embeddings of `texts`, in the same order. */
async function requestEmbeddings(texts, { fetch, settings }) {
  const response = await fetch(settings.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model, input: texts }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`The embedding model answered with status ${response.status}: ${await reasonOfFailure(response)}`);
  }

  const { data } = await response.json();
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error("The embedding model did not return an embedding for every text");
  }
  // Every embedding carries the place of its text in the request.
  return [...data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

/** The fetch and the settings to reach the embedding model with. `deps`
 *  replaces them in the tests. */
function resolveDeps(deps) {
  const { fetch = global.fetch, settings = embeddingSettings() } = deps;
  if (!settings.apiKey) throw new Error("LITELLM_API_KEY is not set");
  return { fetch, settings };
}

async function embedChunks(chunks, deps = {}) {
  const { chunksPerRequest = CHUNKS_PER_REQUEST } = deps;
  const { fetch, settings } = resolveDeps(deps);
  const embedded = [];

  for (let start = 0; start < chunks.length; start += chunksPerRequest) {
    const group = chunks.slice(start, start + chunksPerRequest);
    const embeddings = await requestEmbeddings(group.map(textToEmbed), { fetch, settings });
    group.forEach((chunk, i) => embedded.push({ ...chunk, embedding: embeddings[i], embeddingModel: settings.model }));
  }

  return embedded;
}

async function embedQuestion(question, deps = {}) {
  const [embedding] = await requestEmbeddings([question], resolveDeps(deps));
  return embedding;
}

module.exports = { embedChunks, embedQuestion };
