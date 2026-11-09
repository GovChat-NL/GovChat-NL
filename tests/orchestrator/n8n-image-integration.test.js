'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run in the pinned n8n image, with no network, credentials or real image API.
const base = '/usr/local/lib/node_modules/n8n/node_modules/.pnpm';
const pkg = fs.readdirSync(base).find(name => name.startsWith('@n8n+n8n-nodes-langchain@'));
const dist = path.join(base, pkg, 'node_modules/@n8n/n8n-nodes-langchain/dist');
const { WorkflowToolService } = require(path.join(dist, 'nodes/tools/ToolWorkflow/v2/utils/WorkflowToolService'));
const root = path.resolve(__dirname, '../..');
const workflow = JSON.parse(fs.readFileSync(path.join(root, 'agents/n8n/workflows/orchestrator-litellm.json')))[0];
const node = workflow.nodes.find(item => item.name === 'image_generation_tool');
const original = { headers: { authorization: 'Bearer synthetic-token' }, body: { userId: 'trusted-owner-123' } };
let argumentsFromAI = {};
const context = {
  getNode: () => node,
  getInputData: () => [{ json: { query: argumentsFromAI } }],
  getNodeParameter: (name, index, fallback) => {
    if (name === 'workflowInputs.value') return Object.fromEntries(Object.entries(node.parameters.workflowInputs.value).map(([key, expression]) => [key,
      vm.runInNewContext(expression.slice(3, -2), {
        $: name => { assert.equal(name, 'Webhook Orchestrator'); return { first: () => ({ json: original }) }; },
        $env: { N8N_WEBHOOK_TOKEN: 'synthetic-token' },
        $fromAI: (key, description, type, defaultValue) => argumentsFromAI[key] ?? defaultValue,
      })]));
    if (name === 'workflowInputs.schema') return node.parameters.workflowInputs.schema;
    return fallback;
  },
  continueOnFail: () => false,
};

test('pinned n8n exposes only prompt, size and quality, never owner identity', async () => {
  const service = new WorkflowToolService(context, { returnAllItems: true });
  assert.equal(service.useSchema, true);
  let captured;
  const tool = service.createStructuredTool('image_generation_tool', 'Synthetic image tool', async input => {
    captured = input;
    return 'synthetic result';
  });
  assert.deepEqual(Object.keys(tool.schema.shape).sort(), ['prompt', 'quality', 'size']);
  await tool.invoke({ prompt: 'A synthetic image', userId: 'attacker-owner-123' });
  assert.equal(captured.userId, undefined);
  assert.equal(captured.size, '1024x1024');
  assert.equal(captured.quality, 'low');
});

test('pinned n8n maps the original owner into subworkflow items despite forged query fields', async () => {
  const service = new WorkflowToolService(context, { returnAllItems: true });
  argumentsFromAI = { prompt: 'A synthetic image', userId: 'attacker-owner-123' };
  const items = await service.prepareWorkflowItems(context, argumentsFromAI, 0, { query: argumentsFromAI });
  assert.equal(items[0].json.userId, 'trusted-owner-123');
  assert.equal(items[0].json.prompt, 'A synthetic image');
  assert.equal(items[0].json.size, '1024x1024');
  original.headers.authorization = 'Bearer incorrect-token';
  try {
    await assert.rejects(service.prepareWorkflowItems(context, argumentsFromAI, 0, {}), /Unauthorized image tool caller/);
  } finally {
    original.headers.authorization = 'Bearer synthetic-token';
  }
});
