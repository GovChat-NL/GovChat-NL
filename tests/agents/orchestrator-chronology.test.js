'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '../../agents/n8n/workflows/orchestrator-litellm.json'), 'utf8'))[0];
const expression = workflow.nodes.find(node => node.name === 'AI Agent Orchestrator').parameters.options.systemMessage;
const { DEFAULT_PROMPT } = require('../../services/admin-overlay/admin/lib/orchestrator-prompt');

function prompt(input) {
  assert.ok(expression.startsWith('={{ ') && expression.endsWith(' }}'));
  return new Function('$json', 'return ' + expression.slice(3, -2))({ ...input, orchestratorPrompt: DEFAULT_PROMPT });
}

test('prompt specifies chronology, yearly grouping, date provenance and unknown dates', () => {
  const text = prompt({});
  for (const instruction of ['van oud naar nieuw', 'jaarkoppen', 'binnen elk jaar op datum',
    'Gebruik niet de zoekrang', 'document- of besluitdatum', 'vergaderdatum', 'Datum onbekend', 'verzin geen datum']) {
    assert.ok(text.includes(instruction), instruction);
  }
  assert.ok(text.includes('[FINAL_ANSWER]'));
  assert.ok(!text.includes('Context huidige gebruiker'));
});

test('chronology change preserves user context and validated stream correlation marker', () => {
  const id = '12345678-1234-4123-8123-123456789012';
  const text = prompt({ body: { userName: ' Test ', userEmail: ' test@example.org ', streamId: id } });
  assert.ok(text.includes('naam: Test, e-mailadres: test@example.org'));
  assert.ok(text.includes('alleen als dat functioneel nodig is'));
  assert.ok(text.endsWith('[govchat-stream-id:' + id + ']'));
  assert.ok(!prompt({ body: { streamId: 'bad-stream-id' } }).includes('[govchat-stream-id:'));
});
