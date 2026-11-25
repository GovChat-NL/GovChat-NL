"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { extractText } = require("../lib/beleidskompas/documents/extract");

const file = (filename, text = "") => ({ filename, content: Buffer.from(text, "utf8") });

/** A small real file from tests/fixtures. */
const fixture = (filename) => ({ filename, content: fs.readFileSync(path.join(__dirname, "fixtures", filename)) });

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

test("a document without text fails with no_text", async () => {
  const scanned = parsed([{ type: "page", metadata: { pageNumber: 1 }, children: [{ type: "image" }] }]);
  await assert.rejects(extractText(file("scan.pdf"), scanned), { code: "no_text" });
});

// The three tests below read a real file with the real officeparser, one
// for every office format the admin UI lets an administrator upload.

test("a real Word file gives its headings, its paragraphs and a block per table row", async () => {
  assert.deepEqual(await extractText(fixture("kader.docx")), [
    { heading: true, text: "Doel van het kader", location: "", page: null },
    { heading: false, text: "De provincie verleent een subsidie aan gemeenten.", location: "", page: null },
    { heading: true, text: "Aanpak", location: "", page: null },
    { heading: false, text: "Eerst een analyse, dan een keuze.", location: "", page: null },
    { heading: false, text: "Instrument | Soort", location: "", page: null },
    { heading: false, text: "Subsidie | Financieel", location: "", page: null },
  ]);
});

test("a real Excel file gives a block per row, with its sheet", async () => {
  assert.deepEqual(await extractText(fixture("koffer.xlsx")), [
    { heading: false, text: "Instrument | Soort", location: "werkblad Instrumenten", page: null },
    { heading: false, text: "Subsidie | Financieel", location: "werkblad Instrumenten", page: null },
    { heading: false, text: "Regisseur", location: "werkblad Rollen", page: null },
  ]);
});

test("a real PDF gives its heading and the text of every page, with the page", async () => {
  assert.deepEqual(await extractText(fixture("nota.pdf")), [
    { heading: true, text: "Context en aanleiding", location: "pagina 1", page: 1 },
    { heading: false, text: "De provincie verleent een subsidie.\nDit is de tweede regel.", location: "pagina 1", page: 1 },
    { heading: false, text: "Vervolg op pagina twee.", location: "pagina 2", page: 2 },
  ]);
});
