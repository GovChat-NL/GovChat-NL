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

test("formatRichText leaves text without a list as it was", () => {
  assert.equal(formatRichText("Een regel\n\n**vet**"), '<span class="gc-bk-pre">Een regel\n\n<strong>vet</strong></span>');
});

test("formatRichText turns dash and numbered lines into lists, with the text around them", () => {
  const html = formatRichText("**Toets:**\n- Marktfalen — **nee**\n- Externe effecten — ja\n\n**Bevoegdheid:** onbekend");
  assert.equal(
    html,
    '<div class="gc-bk-rich"><span class="gc-bk-pre"><strong>Toets:</strong></span>' +
      '<ul class="gc-bk-list"><li>Marktfalen — <strong>nee</strong></li><li>Externe effecten — ja</li></ul>' +
      '<span class="gc-bk-pre"><strong>Bevoegdheid:</strong> onbekend</span></div>',
  );
  assert.ok(formatRichText("1. een\n\n2. twee").includes('<ol class="gc-bk-list"><li>een</li><li>twee</li></ol>'));
  assert.ok(formatRichText("3. drie\n4. vier").includes('<ol class="gc-bk-list" start="3">'));
  // An indented line under an item belongs to that item.
  assert.ok(formatRichText("- punt\n  vervolg").includes("<li>punt\nvervolg</li>"));
});

test("formatRichText does not take a year, a rule or bold at the start of a line for a list", () => {
  for (const text of ["2024. Een jaar.", "---", "**Vet** aan het begin"]) {
    assert.ok(formatRichText(text).startsWith('<span class="gc-bk-pre">'), text);
  }
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
