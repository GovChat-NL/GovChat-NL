'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { trustedImageUserId, trustedUserExpression, applyImageToolInputs, applyImageTriggerInputs } =
  require('../scripts/orchestrator-image-workflow');

const root = path.resolve(__dirname, '..');
const load = name => JSON.parse(fs.readFileSync(path.join(root, 'agents/n8n/workflows', name), 'utf8'))[0];
const owner = 'trusted-owner-123';
const request = { headers: { authorization: 'Bearer synthetic-service-token' }, body: { userId: owner } };

test('identity comes only from the authenticated original webhook, not model arguments', () => {
  const result = vm.runInNewContext(trustedUserExpression.slice(3, -2), {
    $: name => { assert.equal(name, 'Webhook Orchestrator'); return { first: () => ({ json: request }) }; },
    $env: { N8N_WEBHOOK_TOKEN: 'synthetic-service-token' },
    $json: { userId: 'attacker-owner', query: { userId: 'attacker-owner' } },
    $fromAI: () => { throw new Error('Identity must not be model-controlled'); },
  });
  assert.equal(result, owner);
});

for (const [label, input, token] of [
  ['missing service token', request, ''],
  ['incorrect service token', request, 'wrong'],
  ['missing authorization', { body: { userId: owner } }, 'synthetic-service-token'],
  ['missing owner', { ...request, body: {} }, 'synthetic-service-token'],
  ['model-only owner', { ...request, body: { query: { userId: owner } } }, 'synthetic-service-token'],
  ['legacy snake-case owner', { ...request, body: { user_id: owner } }, 'synthetic-service-token'],
  ['path traversal', { ...request, body: { userId: '../another-owner' } }, 'synthetic-service-token'],
  ['non-string owner', { ...request, body: { userId: {} } }, 'synthetic-service-token'],
]) test(`rejects ${label}`, () => assert.throws(() => trustedImageUserId(input, token), /Unauthorized|Authenticated/));

test('committed tool and trigger match their builders and expose only image options to AI', () => {
  const orchestrator = load('orchestrator-litellm.json');
  const image = load('image-generator-litellm.json');
  const tool = orchestrator.nodes.find(node => node.name === 'image_generation_tool');
  const trigger = image.nodes.find(node => node.name === 'When Executed by Another Workflow');
  assert.deepEqual(applyImageToolInputs(structuredClone(orchestrator)), orchestrator);
  assert.deepEqual(applyImageTriggerInputs(structuredClone(image)), image);
  assert.equal(trigger.typeVersion, 1.1);
  assert.deepEqual(trigger.parameters.workflowInputs.values.map(field => field.name), ['prompt', 'size', 'quality', 'userId', 'operation', 'sourceImage']);
  assert.equal(tool.parameters.workflowInputs.value.userId, trustedUserExpression);
  assert.equal(tool.parameters.workflowInputs.value.userId.includes('$fromAI'), false);
  for (const field of ['operation', 'sourceImage']) assert.equal(tool.parameters.workflowInputs.value[field].includes('$fromAI'), false);
  for (const field of ['prompt', 'size', 'quality']) assert.match(tool.parameters.workflowInputs.value[field], /\$fromAI/);
});

test('real prepare code retains owner validation and accepts propagated identity', () => {
  const code = load('image-generator-litellm.json').nodes.find(node => node.name === 'Prepare Image Request').parameters.jsCode;
  // Exercise the actual pre-storage guard without writing budgets or calling an API.
  const guard = code.slice(0, code.indexOf('// Apply one rolling per-user budget'));
  const run = input => new Function('require', '$json', '$env', guard + '\nreturn userId;')(require, input, {});
  assert.equal(run({ prompt: 'Synthetic image', userId: trustedImageUserId(request, 'synthetic-service-token') }), owner);
  assert.throws(() => run({ query: 'Synthetic image' }), /Authenticated user context is missing/);
  assert.throws(() => run({ query: { userId: owner } }), /Authenticated user context is missing/);
  assert.match(code, /reserveUserGeneration\(userId\)/);
});
