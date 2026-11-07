// Unit tests for the parts of beleidskompas-api.js that do not talk to
// LibreChat. Run with `node --test` in this folder (or `make
// test-beleidskompas` from the repository root).

import test from "node:test";
import assert from "node:assert/strict";

import { composePrompt, parseComposedPrompt, parseCitationsMetaBlock } from "../beleidskompas-api.js";

const SUBSTEP = { id: "2.1", title: "Rolbepaling" };

test("composePrompt labels the substep, the case, the findings, the conversation and the message, and leaves out what is empty", () => {
  assert.equal(
    composePrompt({ substep: SUBSTEP, caseText: "De casus.", findings: "Uit stap 1.", conversation: "Gebruiker: hoezo?", message: " Waarom niet regisseren? " }),
    "Deelstap: 2.1 (Rolbepaling)\nCasus: De casus.\nEerdere bevindingen: Uit stap 1.\nGesprek: Gebruiker: hoezo?\nBericht: Waarom niet regisseren?",
  );
  assert.equal(composePrompt({ substep: SUBSTEP, caseText: "De casus.", findings: "  " }), "Deelstap: 2.1 (Rolbepaling)\nCasus: De casus.");
});

test("parseComposedPrompt takes a composed message apart again", () => {
  const composed = composePrompt({ substep: SUBSTEP, caseText: "De casus.\nTweede regel.", findings: "Uit stap 1.", message: "Waarom niet\nregisseren?" });
  assert.deepEqual(parseComposedPrompt(composed), { substepId: "2.1", substepTitle: "Rolbepaling", caseText: "De casus.\nTweede regel.", message: "Waarom niet\nregisseren?" });
  assert.deepEqual(parseComposedPrompt(composePrompt({ substep: SUBSTEP, caseText: "De casus." })), { substepId: "2.1", substepTitle: "Rolbepaling", caseText: "De casus.", message: "" });
  assert.deepEqual(parseComposedPrompt("Gewoon een casus."), { substepId: "", substepTitle: "", caseText: "", message: "" });
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

  assert.deepEqual(parseCitationsMetaBlock("  Gewoon tekst  "), { displayText: "Gewoon tekst", citations: [], retrieval_trace: null, agent: null, asked_from: null });
});

test("parseCitationsMetaBlock reads which step answered and where the user asked from", () => {
  const meta = { citations: [], retrieval_trace: null, agent: "stap3", asked_from: "1.3" };
  const encoded = Buffer.from(JSON.stringify(meta), "utf8").toString("base64");
  const parsed = parseCitationsMetaBlock(`Antwoord.\n\n[beleidskompas-meta]: data:application/json;base64,${encoded}`);
  assert.equal(parsed.agent, "stap3");
  assert.equal(parsed.asked_from, "1.3");
});
