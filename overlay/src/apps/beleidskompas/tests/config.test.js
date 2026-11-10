// Unit tests for config.js. Run with `node --test` in this folder (or
// `make test-beleidskompas` from the repository root).

import test from "node:test";
import assert from "node:assert/strict";

import { buildConfig } from "../config.js";

test("the step configuration wins over the app's config, which wins over the defaults", () => {
  const defaults = buildConfig(null, null);
  assert.equal(defaults.title, "");
  assert.ok(defaults.specialistTeam.length > 0);
  assert.equal(defaults.sources.length, 5);
  assert.deepEqual(defaults.steps.map((s) => s.id), ["stap1", "stap2", "stap3", "stap4"]);

  const config = buildConfig(
    { config: { title: " Uit apps.json ", specialist_team: "Team A", sources: ["Bron 1"] } },
    { title: "Uit de stappenconfig", disclaimer: " Let op ", sources: [] },
  );
  assert.equal(config.title, "Uit de stappenconfig");
  assert.equal(config.disclaimer, "Let op");
  assert.equal(config.specialistTeam, "Team A");
  // An empty source list means: use the defaults.
  assert.deepEqual(config.sources, defaults.sources);
});

test("a configured step takes its texts and questions from the configuration, missing fields from the default at that position", () => {
  const defaults = buildConfig(null, null).steps;
  const [first, second] = buildConfig(null, {
    steps: [
      {
        id: " probleem ",
        title: " Probleemanalyse ",
        description: "Korte omschrijving",
        prompt: "De volledige instructie",
        substeps: [{ title: "Vraag 1", description: "Verdieping 1" }, { title: "Vraag 2" }],
      },
      { title: "Eigen titel", description: "Eigen omschrijving" },
    ],
  }).steps;

  assert.equal(first.id, "probleem");
  assert.equal(first.nr, 1);
  assert.equal(first.title, "Probleemanalyse");
  assert.equal(first.short, "Korte omschrijving");
  assert.equal(first.info, "Korte omschrijving");
  assert.deepEqual(first.help, ["Vraag 1", "Vraag 2"]);
  assert.deepEqual(first.deep, ["Verdieping 1"]);

  assert.equal(second.id, "stap2");
  assert.equal(second.title, "Eigen titel");
  assert.equal(second.info, "Eigen omschrijving");
  assert.deepEqual(second.help, defaults[1].help);
  assert.deepEqual(second.deep, defaults[1].deep);
});
