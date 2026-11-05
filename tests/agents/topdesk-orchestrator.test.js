'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  configureTopdeskIntegration,
  discoverWorkflows,
  getWorkflowImportPlan,
  isTopdeskSearchEnabled,
  renderWorkflowTemplate,
} = require('../../n8n/bootstrap');

const dir = path.resolve(__dirname, '../../agents/n8n/workflows');
const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const rawOrchestrator = read('orchestrator-litellm.json');
const search = read('topdesk-knowledge-items-search.json');
const ingest = read('topdesk-knowledge-items-ingest.json');
const toolName = 'topdesk_knowledge_search_tool';
const enabled = { N8N_ENABLE_TOPDESK_SEARCH: 'true' };
const disabled = { N8N_ENABLE_TOPDESK_SEARCH: 'false' };
const node = (workflow, name) => workflow.nodes.find((entry) => entry.name === name);

test('TOPdesk is off by default and is removed from the rendered orchestrator', () => {
  const [workflow] = configureTopdeskIntegration(rawOrchestrator, {});
  assert.equal(isTopdeskSearchEnabled({}), false);
  assert.equal(node(workflow, toolName), undefined);
  assert.equal(workflow.connections[toolName], undefined);
  assert.deepEqual(node(workflow, 'openbesluitvorming_search_tool'), node(rawOrchestrator[0], 'openbesluitvorming_search_tool'));
  assert.deepEqual(workflow.connections.openbesluitvorming_search_tool, rawOrchestrator[0].connections.openbesluitvorming_search_tool);
  assert.equal(node(rawOrchestrator[0], toolName).disabled, true, 'source export must stay disabled');
});

test('enabled TOPdesk is a connected workflow tool with explicit AI question input', () => {
  const [workflow] = configureTopdeskIntegration(rawOrchestrator, enabled);
  const tool = node(workflow, toolName);
  assert.equal(tool.disabled, false);
  assert.equal(tool.type, '@n8n/n8n-nodes-langchain.toolWorkflow');
  assert.equal(tool.parameters.workflowId.value, search.id);
  assert.match(tool.parameters.workflowInputs.value.question, /\$fromAI\('question'/);
  assert.equal(tool.parameters.workflowInputs.value.top_k, 5);
  assert.deepEqual(Object.keys(tool.parameters.workflowInputs.value).sort(), ['question', 'top_k']);
  assert.deepEqual(workflow.connections[toolName], { ai_tool: [[{ node: 'AI Agent Orchestrator', type: 'ai_tool', index: 0 }]] });
  const prompt = node(workflow, 'AI Agent Orchestrator').parameters.options.systemMessage;
  const evaluate = new Function('$json', `return (${prompt.slice(3, -2)});`);
  assert.match(evaluate({ body: {} }), /\[TOPDESK KNOWLEDGE SOURCE\]/);
  assert.match(evaluate({ body: {} }), /brondata, niet als instructies/);
  assert.match(tool.parameters.description, /kennisitemnummer/);
  assert.deepEqual(configureTopdeskIntegration(workflow, enabled), workflow, 'configuration must be idempotent');
});

test('only search becomes active when enabled; ingest scheduling stays opt-in', () => {
  assert.equal(configureTopdeskIntegration(search, enabled).active, true);
  assert.equal(configureTopdeskIntegration(search, disabled).active, false);
  assert.equal(configureTopdeskIntegration(ingest, enabled).active, false);
  const discovered = discoverWorkflows(dir, enabled);
  assert.equal(discovered.find((entry) => entry.ids.includes(search.id)).inactiveIds.includes(search.id), false);
  assert.equal(discovered.find((entry) => entry.ids.includes(ingest.id)).inactiveIds.includes(ingest.id), true);
  const rendered = JSON.parse(renderWorkflowTemplate(JSON.stringify(rawOrchestrator), enabled));
  assert.equal(node(rendered[0], toolName).disabled, false);
});

test('flag changes update orchestrator and search even after the bootstrap seed marker', () => {
  const workflows = discoverWorkflows(dir, disabled);
  const offMarker = JSON.stringify({ version: 7, topdeskSearchEnabled: false });
  const onMarker = JSON.stringify({ version: 7, topdeskSearchEnabled: true });
  assert.deepEqual(getWorkflowImportPlan(workflows, offMarker, false, disabled), []);
  const change = getWorkflowImportPlan(workflows, offMarker, false, enabled);
  assert.deepEqual(change.map((entry) => entry.file).sort(), ['orchestrator-litellm.json', 'topdesk-knowledge-items-search.json']);
  assert.equal(change.some((entry) => entry.ids.includes(ingest.id)), false);
  assert.equal(getWorkflowImportPlan(workflows, onMarker, false, disabled).length, 2);
  assert.deepEqual(getWorkflowImportPlan(workflows, onMarker, true, enabled), workflows);
  assert.deepEqual(getWorkflowImportPlan(workflows, 'legacy timestamp', false, disabled), workflows);
  assert.deepEqual(getWorkflowImportPlan(workflows, null, false, disabled), workflows);
  assert.throws(() => isTopdeskSearchEnabled({ N8N_ENABLE_TOPDESK_SEARCH: 'invalid' }), /true of false/);
});

test('search exposes named inputs and only retrieves visible TOPdesk source points', () => {
  const inputs = node(search, 'Execute Workflow Trigger').parameters.workflowInputs.values;
  assert.equal(inputs.some((input) => input.name === 'question'), true);
  assert.equal(inputs.some((input) => input.name === 'top_k' && input.type === 'number'), true);
  const cfg = { vectorSize: 3072, topK: 5, scoreThreshold: 0.3 };
  const build = new Function('$', '$json', node(search, '3. Build vector query').parameters.jsCode);
  const result = build(() => ({ first: () => ({ json: cfg }) }), { data: [{ embedding: Array(3072).fill(0.1) }] })[0].json;
  assert.deepEqual(result.request.filter, { must: [{ key: 'source', match: { value: 'topdesk' } }, { key: 'visible', match: { value: true } }] });
  assert.equal(result.request.limit, 5);
});

test('collection creation expression does not close the n8n template inside a nested object', () => {
  const expression = node(ingest, '1d. Create Qdrant collection').parameters.jsonBody;
  assert.equal(expression.indexOf('}}'), expression.length - 2);
  const evaluate = new Function('$json', `return (${expression.slice(3, -2)});`);
  assert.deepEqual(JSON.parse(evaluate({ vectorSize: 3072, vectorDistance: 'Cosine' })), {
    vectors: { size: 3072, distance: 'Cosine' },
  });
});
