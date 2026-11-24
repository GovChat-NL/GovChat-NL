"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { chunkBlocks } = require("../lib/beleidskompas/rag/chunk");

const heading = (text) => ({ heading: true, text, location: "", page: null });
const text = (text, page = null) => ({ heading: false, text, location: page ? `pagina ${page}` : "", page });

test("a heading starts a new chunk, and text below the same heading is put together", () => {
  const chunks = chunkBlocks([
    text("Voorwoord."),
    heading("1. Inleiding"),
    text("Eerste alinea.", 3),
    text("Tweede alinea.", 4),
    heading("2. Doel"),
    text("Derde alinea.", 4),
  ]);
  assert.deepEqual(chunks, [
    { number: 1, heading: "", text: "Voorwoord.", location: "", page: null },
    { number: 2, heading: "1. Inleiding", text: "Eerste alinea.\nTweede alinea.", location: "pagina 3", page: 3 },
    { number: 3, heading: "2. Doel", text: "Derde alinea.", location: "pagina 4", page: 4 },
  ]);
});

test("text that does not fit in one chunk is cut at the end of a sentence, or of a line when there is no sentence", () => {
  const sentences = "Eerste zin. Tweede zin loopt\ndoor op de volgende regel. Derde zin.";
  assert.deepEqual(chunkBlocks([text(sentences)], 45).map((chunk) => chunk.text), [
    "Eerste zin.",
    "Tweede zin loopt\ndoor op de volgende regel.",
    "Derde zin.",
  ]);

  const list = "• punt een\n• punt twee\n• punt drie";
  assert.deepEqual(chunkBlocks([text(list)], 25).map((chunk) => chunk.text), ["• punt een\n• punt twee", "• punt drie"]);
});
