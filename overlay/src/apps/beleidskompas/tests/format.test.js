// Unit tests for format.js. Run with `node --test` in this folder (or
// `make test-beleidskompas` from the repository root).

import test from "node:test";
import assert from "node:assert/strict";

import { formatRichText, parseAdvice, needsSpecialistTeam } from "../format.js";

const advice = [
  "⚠️ Demo-antwoord.",
  "## Publiek belang",
  "**Oordeel:** Ja, er is een publiek belang.",
  "Toelichting.",
  "## Provinciaal belang",
  "Oordeel: Nee",
  "## Aannames en ontbrekende informatie",
  "- Eerste aanname",
  "- Tweede aanname",
  "- geen",
  "---",
  "Dit is geen besluit.",
].join("\n");

test("formatRichText turns headings and bold into HTML and escapes everything else", () => {
  const html = formatRichText("## Kop\n**vet** en <b>html</b>");
  assert.ok(html.includes('<span class="gc-bk-rich-h">Kop</span>'));
  assert.ok(html.includes("<strong>vet</strong>"));
  assert.ok(html.includes("&lt;b&gt;html&lt;/b&gt;"));
});

test("parseAdvice splits the answer into sections, verdicts and disclaimer, and gives null for other text", () => {
  const parsed = parseAdvice(advice);
  assert.equal(parsed.isDemo, true);
  assert.equal(parsed.disclaimer, "Dit is geen besluit.");
  assert.deepEqual(parsed.sections.map((s) => s.heading), ["Publiek belang", "Provinciaal belang", "Aannames en ontbrekende informatie"]);
  assert.equal(parsed.sections[0].verdict, "Ja, er is een publiek belang.");
  assert.equal(parsed.sections[0].text, "Toelichting.");
  assert.equal(parsed.sections[1].verdict, "Nee");
  assert.equal(parsed.sections[2].verdict, "");

  assert.equal(parseAdvice(""), null);
  assert.equal(parseAdvice("Er ging iets mis."), null);
});

test("needsSpecialistTeam flags a negative verdict or three open assumptions", () => {
  assert.equal(needsSpecialistTeam(parseAdvice(advice)), true);

  const clear = parseAdvice(["## Publiek belang", "Oordeel: Ja", "## Aannames", "- Een", "- Twee", "- geen"].join("\n"));
  assert.equal(needsSpecialistTeam(clear), false);

  const open = parseAdvice(["## Publiek belang", "Oordeel: Ja", "## Aannames", "- Een", "- Twee", "- Drie"].join("\n"));
  assert.equal(needsSpecialistTeam(open), true);
});
