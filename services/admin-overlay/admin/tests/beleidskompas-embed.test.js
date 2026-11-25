"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { embedChunks } = require("../lib/beleidskompas/documents/embed");

test("the chunks go to the model in groups, with their heading, and each gets its own embedding back", async () => {
  const requests = [];
  // Stands in for LiteLLM: the embedding of a text is its length, and the answer comes back in reverse order.
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, authorization: options.headers.Authorization, ...body });
    const data = body.input.map((text, index) => ({ index, embedding: [text.length] })).reverse();
    return { ok: true, json: async () => ({ data }) };
  };
  const settings = { url: "http://litellm/embeddings", apiKey: "key", model: "test-model" };

  const chunks = [
    { number: 1, heading: "Doel", text: "aa" },
    { number: 2, heading: "", text: "bbb" },
    { number: 3, heading: "", text: "c" },
  ];
  const embedded = await embedChunks(chunks, { fetch, settings, chunksPerRequest: 2 });

  assert.deepEqual(requests, [
    { url: "http://litellm/embeddings", authorization: "Bearer key", model: "test-model", input: ["Doel\naa", "bbb"] },
    { url: "http://litellm/embeddings", authorization: "Bearer key", model: "test-model", input: ["c"] },
  ]);
  assert.deepEqual(embedded.map((chunk) => [chunk.number, chunk.embedding, chunk.embeddingModel]), [
    [1, [7], "test-model"],
    [2, [3], "test-model"],
    [3, [1], "test-model"],
  ]);
});
