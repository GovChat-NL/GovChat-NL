// Unit tests for the parts of beleidskompas-api.js that do not talk to
// LibreChat. Run with `node --test` in this folder (or `make
// test-beleidskompas` from the repository root).

import test from "node:test";
import assert from "node:assert/strict";

import { composePrompt, parseCitationsMetaBlock, readCaseState } from "../beleidskompas-api.js";

const SUBSTEP = { id: "2.1", title: "Rolbepaling" };

test("composePrompt labels the substep, the case and the message, and leaves out what is empty", () => {
  assert.equal(
    composePrompt({ substep: SUBSTEP, caseText: "De casus.", message: " Waarom niet regisseren? " }),
    "Deelstap: 2.1 (Rolbepaling)\nCasus: De casus.\nBericht: Waarom niet regisseren?",
  );
  assert.equal(composePrompt({ substep: SUBSTEP, caseText: "De casus.", message: "  " }), "Deelstap: 2.1 (Rolbepaling)\nCasus: De casus.");
  assert.equal(composePrompt({ substep: SUBSTEP, caseText: "", message: "Hoezo?" }), "Deelstap: 2.1 (Rolbepaling)\nBericht: Hoezo?");
});

test("readCaseState turns the state from the store into the case text, the cards and the chat", () => {
  const read = readCaseState({
    case_text: { version: 2, text: "De casus." },
    reports: {
      "1.1": { text: "## Samenvatting\nEen.", citations: [{ id: "a" }], retrieval_trace: { algorithm: "hybrid" }, created_at: "2026-11-08T10:00:00.000Z" },
      "1.2": { text: "## Samenvatting\nTwee.", citations: [], retrieval_trace: null, created_at: "2026-11-08T10:05:00.000Z" },
    },
    turns: [
      { seq: 1, role: "user", step_id: null, asked_from: "1.1", text: "Hoezo?", created_at: "2026-11-08T10:01:00.000Z" },
      { seq: 2, role: "assistant", step_id: "stap3", asked_from: "1.1", text: "Daarom.", created_at: "2026-11-08T10:02:00.000Z" },
    ],
  });

  assert.equal(read.caseText, "De casus.");
  assert.deepEqual(read.results["1.1"], { report_text: "## Samenvatting\nEen.", citations: [{ id: "a" }], retrieval_trace: { algorithm: "hybrid" }, updated_at: "2026-11-08T10:00:00.000Z" });
  assert.equal(read.lastReportSubstepId, "1.2");
  assert.deepEqual(read.messages, [
    { role: "user", text: "Hoezo?", agent: null, substepId: "1.1", conversation: true, ts: "2026-11-08T10:01:00.000Z" },
    { role: "assistant", text: "Daarom.", agent: "stap3", substepId: "1.1", conversation: true, ts: "2026-11-08T10:02:00.000Z" },
  ]);
});

test("readCaseState copes with a case that has nothing yet", () => {
  assert.deepEqual(readCaseState({ case_text: null, reports: {}, turns: [] }), { caseText: "", results: {}, messages: [], lastReportSubstepId: "" });
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
