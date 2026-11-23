'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_TEMPLATE, stepFromTemplate } = require('../template');
const { readSubstepPrompt, COMMON_RULES } = require('../shared');
const steps = [require('../steps/step1').STEP, require('../steps/step2').STEP, require('../steps/step3').STEP, require('../steps/step4').STEP];

test('DEFAULT_TEMPLATE holds the four steps with the prompt file texts as prompt and answer_format', () => {
  assert.deepEqual(DEFAULT_TEMPLATE.steps.map((s) => s.id), ['stap1', 'stap2', 'stap3', 'stap4']);
  const sub = DEFAULT_TEMPLATE.steps[0].substeps[0];
  assert.deepEqual({ instruction: sub.prompt, format: sub.answer_format }, readSubstepPrompt('step1/1.1-probleemdefinitie.md'));
  assert.equal(DEFAULT_TEMPLATE.steps[0].prompt, steps[0].role);
  assert.equal(DEFAULT_TEMPLATE.rules, COMMON_RULES.join('\n'));
});

test('stepFromTemplate maps a template step back to the STEP shape, with a label per substep', () => {
  for (const step of steps) {
    const labelled = { ...step, substeps: step.substeps.map((substep, position) => ({ ...substep, label: `${step.nr}.${position + 1}` })) };
    assert.deepEqual(stepFromTemplate(DEFAULT_TEMPLATE, step.id), labelled);
  }
  assert.equal(stepFromTemplate(DEFAULT_TEMPLATE, 'stap9'), null);
});

test('a moved substep keeps its id and gets the label of its new place', () => {
  const [first, second, ...rest] = DEFAULT_TEMPLATE.steps[0].substeps;
  const added = { ...first, id: 'sub_k3x9q2m7', title: 'Nieuw' };
  const moved = { ...DEFAULT_TEMPLATE, steps: [{ ...DEFAULT_TEMPLATE.steps[0], substeps: [second, first, ...rest, added] }, ...DEFAULT_TEMPLATE.steps.slice(1)] };
  const substeps = stepFromTemplate(moved, 'stap1').substeps.map((substep) => [substep.id, substep.label, substep.title]);
  assert.deepEqual(substeps.slice(0, 2), [[second.id, '1.1', 'Overheidsinterventie'], [first.id, '1.2', 'Probleemdefinitie']]);
  assert.deepEqual(substeps.at(-1), ['sub_k3x9q2m7', '1.6', 'Nieuw']);
});

test('the page numbers the substeps like stepFromTemplate', async () => {
  const { buildConfig } = await import('../../../overlay/src/apps/beleidskompas/config.js');
  const page = buildConfig({}, DEFAULT_TEMPLATE).steps.map((step) => step.substeps.map((substep) => substep.label));
  assert.deepEqual(page, DEFAULT_TEMPLATE.steps.map((step) => stepFromTemplate(DEFAULT_TEMPLATE, step.id).substeps.map((substep) => substep.label)));
});
