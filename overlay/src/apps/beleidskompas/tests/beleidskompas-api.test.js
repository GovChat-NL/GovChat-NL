// Unit tests for the parts of beleidskompas-api.js that do not talk to
// LibreChat. Run with `node --test` in this folder (or `make
// test-beleidskompas` from the repository root).

import test from "node:test";
import assert from "node:assert/strict";

import { composePrompt, parseCitationsMetaBlock } from "../beleidskompas-api.js";

const STEP = { id: "stap2", title: "Rolbepaling provincie" };

test("composePrompt labels the step, the findings so far, the sources and the question, and leaves out what is empty", () => {
  assert.equal(
    composePrompt({ step: STEP, priorReports: "Uit stap 1.", currentReport: "", sources: ["Kader A", "Kader B"], question: " Welke rol past? " }),
    "Stap: stap2 (Rolbepaling provincie)\nCasus/eerdere bevindingen: Uit stap 1.\nBekende bronnen: Kader A; Kader B\nVraag: Welke rol past?",
  );
  assert.equal(
    composePrompt({ step: STEP, priorReports: "", currentReport: "Eerder in deze stap", sources: [], question: "q" }),
    "Stap: stap2 (Rolbepaling provincie)\nCasus/eerdere bevindingen: Eerder in deze stap\nVraag: q",
  );
  assert.equal(composePrompt({ step: STEP, priorReports: "", currentReport: "  ", sources: [], question: "q" }), "Stap: stap2 (Rolbepaling provincie)\nVraag: q");
});

test("parseCitationsMetaBlock splits the trailing link definition off the answer", () => {
  const meta = { citations: [{ id: "doc-1", filename: "kader.pdf" }], retrieval_trace: { algorithm: "hybrid", top_k: 5 } };
  const encoded = Buffer.from(JSON.stringify(meta), "utf8").toString("base64");
  const parsed = parseCitationsMetaBlock(`## Samenvatting\nTekst met é.\n\n[beleidskompas-meta]: data:application/json;base64,${encoded}\n`);

  assert.equal(parsed.displayText, "## Samenvatting\nTekst met é.");
  assert.deepEqual(parsed.citations, meta.citations);
  assert.deepEqual(parsed.retrieval_trace, meta.retrieval_trace);
});

test("parseCitationsMetaBlock understands the HTML comment of older messages and leaves plain text alone", () => {
  const parsed = parseCitationsMetaBlock('Antwoord.\n<!--BELEIDSKOMPAS-META:{"citations":[{"id":"x"}]}-->');
  assert.equal(parsed.displayText, "Antwoord.");
  assert.deepEqual(parsed.citations, [{ id: "x" }]);

  assert.deepEqual(parseCitationsMetaBlock("  Gewoon tekst  "), { displayText: "Gewoon tekst", citations: [], retrieval_trace: null });
});
