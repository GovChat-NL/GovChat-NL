'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DISCLAIMER } = require('../shared');
const { buildAssignment, processReply, buildResult } = require('../step-agent');
const { STEPS } = require('../generate-workflow');

const [step1, step2] = STEPS;
const input = {
  substep_id: '1.2',
  assignment: 'uitwerken',
  case_id: 'c1',
  user_id: 'u1',
  findings: '**Stap 1 · 1.1**\n\n### Probleemdefinitie\n**Probleem:** x',
  conversation: 'Gebruiker: hallo',
};

test('the assignment for a report holds only the asked substep, with its answer format, and the earlier reports in full', () => {
  const a = buildAssignment({ step: step1, input });

  assert.deepEqual([a.mode, a.valid, a.step_id, a.substep_id, a.substep_title], ['report', true, 'stap1', '1.2', 'Overheidsinterventie']);
  assert.ok(a.system_prompt.startsWith(step1.role));
  assert.ok(a.system_prompt.includes('Deelstap 1.2: Overheidsinterventie'));
  assert.ok(!a.system_prompt.includes('Deelstap 1.1:'));
  assert.ok(!/\{\{\w+\}\}/.test(a.system_prompt), 'every placeholder is filled');
  const format = ['### Samenvatting casus', '### Overheidsinterventie', '### Redenering', '### Aannames en ontbrekende informatie'];
  assert.deepEqual(format.map((h) => a.system_prompt.indexOf(h)).sort((x, y) => x - y), format.map((h) => a.system_prompt.indexOf(h)));
  assert.ok(format.every((h) => a.system_prompt.includes(h)));

  assert.equal(
    a.user_prompt,
    'Bevindingen tot nu toe:\n**Stap 1 · 1.1**\n\n### Probleemdefinitie\n**Probleem:** x\n\nLaatste beurten van het gesprek:\nGebruiker: hallo\n\n' +
      'Opdracht: werk deelstap 1.2 (Overheidsinterventie) uit.\n\nBeleidsbronnen: geen beschikbaar. Vermeld dit alleen onder "Aannames en ontbrekende informatie".',
  );
});

test('every substep of every step gets a complete assignment', () => {
  for (const step of STEPS) {
    for (const substep of step.substeps) {
      const a = buildAssignment({ step, input: { ...input, substep_id: substep.id } });
      assert.equal(a.mode, 'report', substep.id);
      assert.ok(a.system_prompt.includes(`Deelstap ${substep.id}: ${substep.title}`), substep.id);
      assert.ok(!/\{\{\w+\}\}/.test(a.system_prompt), substep.id);
    }
  }
});

test('a report for a substep of another step is invalid', () => {
  const a = buildAssignment({ step: step2, input });
  assert.deepEqual([a.mode, a.valid, a.error], ['invalid', false, 'Stap 2 kent deelstap "1.2" niet. Bekende deelstappen: 2.1.']);
  assert.deepEqual(buildResult({ assignment: a, reply: null, saved: null }), { kind: 'error', error: a.error });
});

test('any other assignment is a question: about one substep, or about the whole step', () => {
  const whole = buildAssignment({ step: step1, input: { ...input, substep_id: '', assignment: 'Waarom is dit een provinciaal belang?' } });
  assert.deepEqual([whole.mode, whole.substep_id], ['conversation', '']);
  assert.ok(whole.system_prompt.includes('Deelstap 1.1: Probleemdefinitie') && whole.system_prompt.includes('Deelstap 1.5: Integrale afweging'));
  assert.ok(!whole.system_prompt.includes('### Redenering'), 'a question gets no answer format');
  assert.ok(whole.user_prompt.includes('Bericht van de gebruiker:\nWaarom is dit een provinciaal belang?'));

  const one = buildAssignment({ step: step1, input: { ...input, assignment: 'Waarom beperkt?' } });
  assert.ok(one.system_prompt.includes('Deelstap 1.2:') && !one.system_prompt.includes('Deelstap 1.1:'));
});

const assignment = buildAssignment({ step: step1, input });
const reply =
  '```markdown\n### Samenvatting casus\nKort.\n\n### Overheidsinterventie\n**Oordeel:** ja\n\n### Redenering\n1. a\n\n### Aannames en ontbrekende informatie\n- budget onbekend\n- looptijd onbekend\n```';
const agent = { output: reply };

test('the reply for a report is stored with the step heading and the disclaimer, without the code block', () => {
  const processed = processReply({ assignment, agent });

  assert.equal(processed.save, true);
  assert.ok(processed.report_text.startsWith('**Stap 1 · Publiek en provinciaal belang · 1.2 Overheidsinterventie**\n\n### Samenvatting casus\nKort.'));
  assert.ok(processed.report_text.endsWith(`- budget onbekend\n- looptijd onbekend\n\n---\n${DISCLAIMER}`));
  assert.ok(!processed.report_text.includes('```'));
  assert.equal(processed.error, null);
});

test('the orchestrator gets the report as it was stored', () => {
  const processed = processReply({ assignment, agent });
  const result = buildResult({ assignment, reply: processed, saved: { version: 3 } });
  assert.deepEqual(result, {
    kind: 'report',
    step_id: 'stap1',
    substep_id: '1.2',
    saved: true,
    version: 3,
    error: null,
    report: processed.report_text,
    tools: [],
  });
});

test('a report that could not be stored says so', () => {
  const processed = processReply({ assignment, agent });
  const result = buildResult({ assignment, reply: processed, saved: { error: { message: 'HTTP 500' } } });
  assert.deepEqual([result.saved, result.version, result.error], [false, null, 'Het rapport is gemaakt, maar opslaan is mislukt.']);
});

test('a failing or silent agent stores nothing and gives the orchestrator an error', () => {
  const failed = processReply({ assignment, agent: { error: { message: 'LiteLLM 500' } } });
  assert.deepEqual([failed.save, failed.error], [false, 'LiteLLM 500']);
  assert.deepEqual(buildResult({ assignment, reply: failed, saved: null }), { kind: 'error', error: 'LiteLLM 500' });
  assert.equal(processReply({ assignment, agent: { output: '' } }).error, 'De agent van stap 1 gaf geen antwoord.');
});

test('the answer to a question goes back as it is and is not stored', () => {
  const question = buildAssignment({ step: step1, input: { ...input, assignment: 'Waarom beperkt?' } });
  const processed = processReply({ assignment: question, agent: { output: 'Omdat de provincie maar deels bevoegd is.' } });
  assert.equal(processed.save, false);
  assert.deepEqual(buildResult({ assignment: question, reply: processed, saved: null }), { kind: 'answer', step_id: 'stap1', answer: 'Omdat de provincie maar deels bevoegd is.', tools: [] });
});
