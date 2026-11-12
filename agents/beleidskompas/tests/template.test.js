'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_TEMPLATE, DEFAULT_MESSAGES, stepFromTemplate, rulesFromTemplate } = require('../template');
const { readSubstepPrompt, COMMON_RULES } = require('../shared');
const orchestrator = require('../orchestrator');
const steps = [require('../steps/step1').STEP, require('../steps/step2').STEP, require('../steps/step3').STEP, require('../steps/step4').STEP];

test('DEFAULT_TEMPLATE holds the four steps with the prompt file texts as prompt and answer_format', () => {
  assert.deepEqual(DEFAULT_TEMPLATE.steps.map((s) => s.id), ['stap1', 'stap2', 'stap3', 'stap4']);
  const sub = DEFAULT_TEMPLATE.steps[0].substeps[0];
  assert.deepEqual({ instruction: sub.prompt, format: sub.answer_format }, readSubstepPrompt('step1/1.1-probleemdefinitie.md'));
  assert.equal(DEFAULT_TEMPLATE.steps[0].prompt, steps[0].role);
  assert.equal(DEFAULT_TEMPLATE.rules, COMMON_RULES.join('\n'));
  assert.ok(sub.description, 'substeps carry the admin description');
});

test('stepFromTemplate maps a template step back to the STEP shape', () => {
  for (const step of steps) assert.deepEqual(stepFromTemplate(DEFAULT_TEMPLATE, step.id), step);
  assert.equal(stepFromTemplate(DEFAULT_TEMPLATE, 'stap9'), null);
});

test('rulesFromTemplate gives the non-empty trimmed lines', () => {
  assert.deepEqual(rulesFromTemplate(DEFAULT_TEMPLATE), COMMON_RULES);
  assert.deepEqual(rulesFromTemplate({ rules: ' a \n\n b\n' }), ['a', 'b']);
});

test('the default messages equal the orchestrator constants', () => {
  assert.deepEqual(DEFAULT_MESSAGES, {
    unknown_step: orchestrator.UNKNOWN_STEP_TEXT,
    store_missing: orchestrator.STORE_MISSING_TEXT,
    store_failed: orchestrator.STORE_FAILED_TEXT,
    store_warning: orchestrator.STORE_WARNING_TEXT,
  });
  assert.equal(DEFAULT_TEMPLATE.messages, DEFAULT_MESSAGES);
});
