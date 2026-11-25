// Unit tests for the parts of beleidskompas-api.js that do not talk to
// LibreChat. Run with `node --test` in this folder (or `make
// test-beleidskompas` from the repository root).

import test from "node:test";
import assert from "node:assert/strict";

import { composePrompt, listBeleidskompasCases, readCaseState, sendBeleidskompasFeedback } from "../beleidskompas-api.js";

const SUBSTEP = { id: "sub_k3x9q2m7", label: "2.1", title: "Rolbepaling" };

/** Takes a composed message apart the way the orchestrator does
 *  (parsePageMessage in agents/beleidskompas/shared.js). */
function readComposed(text) {
  const marker = "[beleidskompas-request]: data:application/json;base64,";
  const idx = text.lastIndexOf(marker);
  return { visible: text.slice(0, idx).trim(), request: JSON.parse(Buffer.from(text.slice(idx + marker.length).trim(), "base64").toString("utf8")) };
}

test("composePrompt puts the substep and the message in a block behind the visible text", () => {
  const { visible, request } = readComposed(composePrompt({ substep: SUBSTEP, message: " Waarom niet regisseren, met é? " }));
  assert.equal(visible, "Waarom niet regisseren, met é?");
  assert.deepEqual(request, { substep_id: "sub_k3x9q2m7", message: "Waarom niet regisseren, met é?" });

  // Without a message the visible text names the substep by its number in the list, and the
  // block carries its id. What is empty stays empty.
  const report = readComposed(composePrompt({ substep: SUBSTEP, message: "  " }));
  assert.equal(report.visible, "Deelstap 2.1: Rolbepaling");
  assert.deepEqual(report.request, { substep_id: "sub_k3x9q2m7", message: "" });
});

test("composePrompt keeps what the user typed as it is, also when it looks like a field", () => {
  const { request } = readComposed(composePrompt({ substep: SUBSTEP, message: "Wat vind je hiervan?\nCasus: eigenlijk fietspaden." }));
  assert.equal(request.message, "Wat vind je hiervan?\nCasus: eigenlijk fietspaden.");
});

test("readCaseState turns the state from the store into the cards and the chat", () => {
  const read = readCaseState({
    reports: {
      "1.1": { text: "## Samenvatting\nEen.", citations: [{ id: "a" }], retrieval_trace: { algorithm: "hybrid" }, created_at: "2026-11-08T10:00:00.000Z" },
      "1.2": { text: "## Samenvatting\nTwee.", citations: [], retrieval_trace: null, created_at: "2026-11-08T10:05:00.000Z" },
    },
    turns: [
      { seq: 1, role: "user", step_id: null, asked_from: "1.1", text: "Hoezo?", created_at: "2026-11-08T10:01:00.000Z" },
      { seq: 2, role: "assistant", step_id: "stap3", asked_from: "1.1", text: "Daarom.", created_at: "2026-11-08T10:02:00.000Z" },
    ],
  });

  assert.deepEqual(read.results["1.1"], { report_text: "## Samenvatting\nEen.", citations: [{ id: "a" }], retrieval_trace: { algorithm: "hybrid" }, updated_at: "2026-11-08T10:00:00.000Z" });
  assert.equal(read.lastReportSubstepId, "1.2");
  // The chat has the conversation; the reports stay on the cards.
  assert.deepEqual(read.messages, [
    { role: "user", text: "Hoezo?", agent: null, substepId: "1.1", ts: "2026-11-08T10:01:00.000Z" },
    { role: "assistant", text: "Daarom.", agent: "stap3", substepId: "1.1", ts: "2026-11-08T10:02:00.000Z" },
  ]);
});

test("readCaseState copes with a case that has nothing yet", () => {
  assert.deepEqual(readCaseState({ reports: {}, turns: [] }), { results: {}, messages: [], lastReportSubstepId: "" });
});

test("sendBeleidskompasFeedback posts the rating with step, substep and template version", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (calls.push([url, JSON.parse(init.body)]), { ok: true });
  try {
    await sendBeleidskompasFeedback({ rating: "up", comment: "", stepId: "stap2", substepId: "2.1", versionId: "v3" });
    await sendBeleidskompasFeedback({ rating: "down", stepId: "stap1" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls[0][0], "/govchat-api/beleidskompas-feedback");
  assert.deepEqual(calls[0][1], { rating: "up", comment: "", step_id: "stap2", substep_id: "2.1", version_id: "v3" });
  assert.deepEqual(calls[1][1], { rating: "down", comment: "", step_id: "stap1", substep_id: null, version_id: null });
});

test("listBeleidskompasCases drops the Beleidskompas prefix from the titles", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: "a", title: "Beleidskompas - Zwembad" }, { id: "b", title: "Beleidskompas - " }] });
  try {
    assert.deepEqual((await listBeleidskompasCases(8)).map((c) => c.title), ["Zwembad", "Naamloze casus"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
