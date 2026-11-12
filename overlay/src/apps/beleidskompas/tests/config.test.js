// Unit tests for config.js. Run with `node --test` in this folder (or
// `make test-beleidskompas` from the repository root).

import test from "node:test";
import assert from "node:assert/strict";

import { buildConfig } from "../config.js";

const STEPS_DATA = {
  steps: [
    { id: "stap1", nr: 1, title: "Publiek en provinciaal belang", substeps: [{ id: "1.1", title: "Probleemdefinitie" }, { id: "1.2", title: "Overheidsinterventie" }] },
    { id: "stap2", nr: 2, title: "Rolbepaling provincie", substeps: [{ id: "2.1", title: "Rolbepaling" }] },
  ],
};

test("the step configuration wins over the app's config, which wins over the defaults", () => {
  const defaults = buildConfig(null, null, STEPS_DATA);
  assert.equal(defaults.title, "");
  assert.ok(defaults.specialistTeam.length > 0);
  assert.deepEqual(defaults.steps.map((s) => s.id), ["stap1", "stap2"]);

  const config = buildConfig(
    { config: { title: " Uit apps.json ", specialist_team: "Team A" } },
    { title: "Uit de stappenconfig", disclaimer: " Let op " },
    STEPS_DATA,
  );
  assert.equal(config.title, "Uit de stappenconfig");
  assert.equal(config.disclaimer, "Let op");
  assert.equal(config.specialistTeam, "Team A");
});

test("the steps and substeps come from steps.json; the texts around a step from the configuration, else from the defaults", () => {
  const defaults = buildConfig(null, null, STEPS_DATA).steps;
  assert.equal(defaults[0].nr, 1);
  assert.equal(defaults[0].title, "Publiek en provinciaal belang");
  assert.deepEqual(defaults[0].substeps, [{ id: "1.1", title: "Probleemdefinitie" }, { id: "1.2", title: "Overheidsinterventie" }]);
  assert.ok(defaults[0].short.length > 0);
  assert.ok(defaults[0].help.length > 0);

  const [first, second] = buildConfig(
    null,
    {
      steps: [
        { id: "stap2", description: "Korte omschrijving van twee", prompt: "De volledige instructie" },
        { id: "stap1", title: "Een eigen titel telt niet", description: "Korte omschrijving van een" },
      ],
    },
    STEPS_DATA,
  ).steps;

  // Matched on id, not on position; the title stays the one from steps.json.
  assert.equal(first.title, "Publiek en provinciaal belang");
  assert.equal(first.short, "Korte omschrijving van een");
  assert.equal(first.info, "Korte omschrijving van een");
  assert.equal(second.short, "Korte omschrijving van twee");
  // The prompt of a step is not public, so it never shows on the page.
  assert.equal(second.info, "Korte omschrijving van twee");
  assert.deepEqual(second.help, defaults[1].help);
});

test("without steps.json the page cannot be built", () => {
  assert.throws(() => buildConfig(null, null, null), /steps\.json/);
  assert.throws(() => buildConfig(null, null, { steps: [] }), /steps\.json/);
});

test("the published configuration with steps and substeps wins over steps.json", () => {
  const config = buildConfig(
    null,
    {
      version_id: " v7 ",
      steps: [
        { id: "stap1", nr: 1, title: "Eigen titel", description: "Eigen omschrijving", substeps: [{ id: "1.1", title: "Eigen deelstap" }] },
        { id: "stap2", nr: 2, title: "Twee", substeps: [{ id: "2.9", title: "Nieuw" }] },
      ],
    },
    STEPS_DATA,
  );
  assert.equal(config.versionId, "v7");
  assert.deepEqual(config.steps.map((s) => [s.id, s.nr, s.title, s.substeps]), [
    ["stap1", 1, "Eigen titel", [{ id: "1.1", title: "Eigen deelstap" }]],
    ["stap2", 2, "Twee", [{ id: "2.9", title: "Nieuw" }]],
  ]);
  assert.equal(config.steps[0].short, "Eigen omschrijving");
  assert.ok(config.steps[0].help.length > 0);
  // steps.json is not needed then.
  assert.equal(buildConfig(null, { steps: [{ id: "stap1", substeps: [{ id: "1.1", title: "A" }] }] }, null).steps.length, 1);
  // Steps without substeps still come from steps.json.
  assert.equal(buildConfig(null, { version_id: "v8", steps: [{ id: "stap1", title: "Niet deze" }] }, STEPS_DATA).steps[0].title, "Publiek en provinciaal belang");
});
