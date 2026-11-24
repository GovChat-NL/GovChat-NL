"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { extractText } = require("../lib/beleidskompas/rag/extract");

const file = (filename, text = "") => ({ filename, content: Buffer.from(text, "utf8") });

/** Stands in for officeparser: answers with the given tree. */
const parsed = (content) => ({ parseOffice: async () => ({ content }) });

test("a markdown file gives its headings and paragraphs in order", async () => {
  const blocks = await extractText(file("kader.md", "# Kader\r\n\r\nEerste alinea,\r\ntweede regel.\n\n## Doel\nTweede alinea."));
  assert.deepEqual(blocks, [
    { heading: true, text: "Kader", location: "", page: null },
    { heading: false, text: "Eerste alinea,\ntweede regel.", location: "", page: null },
    { heading: true, text: "Doel", location: "", page: null },
    { heading: false, text: "Tweede alinea.", location: "", page: null },
  ]);
});

test("a PDF gives a block per heading and per page, with the words put back together", async () => {
  const line = (text) => ({ type: "paragraph", text });
  const blocks = await extractText(file("nota.pdf"), parsed([
    { type: "page", metadata: { pageNumber: 1 }, children: [
      { type: "heading", text: "1. Context," },
      { type: "heading", text: "aanleiding" },
      line("Een gedetail-"),
      line("leerde rol-"),
      line("en instrumentkeuze met e ff ect."),
    ] },
    { type: "page", metadata: { pageNumber: 2 }, children: [line("Vervolg."), { type: "image" }] },
  ]));
  assert.deepEqual(blocks, [
    { heading: true, text: "1. Context, aanleiding", location: "pagina 1", page: 1 },
    { heading: false, text: "Een gedetailleerde rol-\nen instrumentkeuze met effect.", location: "pagina 1", page: 1 },
    { heading: false, text: "Vervolg.", location: "pagina 2", page: 2 },
  ]);
});

test("a spreadsheet gives one block per row, with the sheet", async () => {
  const blocks = await extractText(file("koffer.xlsx"), parsed([
    { type: "sheet", metadata: { sheetName: "Instrumenten" }, children: [
      { type: "row", children: [{ type: "cell", text: "Subsidie" }, { type: "cell", text: "Financieel" }] },
      { type: "row", children: [{ type: "cell", text: "" }] },
    ] },
  ]));
  assert.deepEqual(blocks, [{ heading: false, text: "Subsidie | Financieel", location: "werkblad Instrumenten", page: null }]);
});

test("a document without text fails with no_text", async () => {
  const scanned = parsed([{ type: "page", metadata: { pageNumber: 1 }, children: [{ type: "image" }] }]);
  await assert.rejects(extractText(file("scan.pdf"), scanned), { code: "no_text" });
});
