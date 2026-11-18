'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeQuery } = require('../../scripts/openbesluitvorming-statistics-workflow');
const { applySearchWorkflowInputs } = require('../../scripts/openbesluitvorming-tool-inputs');
const root = path.resolve(__dirname, '../..');
const orchestrator = JSON.parse(fs.readFileSync(path.join(root, 'agents/n8n/workflows/algemeen/orchestrator-litellm.json')))[0];
const search = JSON.parse(fs.readFileSync(path.join(root, 'agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json')));
const base = '/usr/local/lib/node_modules/n8n/node_modules/.pnpm';
const pkg = fs.readdirSync(base).find(name => name.startsWith('@n8n+n8n-nodes-langchain@'));
const { WorkflowToolService } = require(path.join(base, pkg, 'node_modules/@n8n/n8n-nodes-langchain/dist/nodes/tools/ToolWorkflow/v2/utils/WorkflowToolService'));

async function map(name, args) {
  const node = orchestrator.nodes.find(n => n.name === name);
  const context = {
    getNode: () => node, getInputData: () => [{ json: { query: args } }], continueOnFail: () => false,
    getNodeParameter: (name, index, fallback) => {
      if (name === 'workflowInputs.value') return Object.fromEntries(Object.entries(node.parameters.workflowInputs.value).map(([key, value]) => [key,
        vm.runInNewContext(value.slice(3, -2), { $fromAI: (key, description, type, fallback) => args[key] ?? fallback })]));
      if (name === 'workflowInputs.schema') return node.parameters.workflowInputs.schema;
      return fallback;
    },
  };
  const service = new WorkflowToolService(context, { returnAllItems: true });
  const tool = service.createStructuredTool(node.name, node.parameters.description, async () => 'synthetic');
  assert.ok(tool.schema.shape.date_start);
  assert.ok(tool.schema.shape.date_end);
  assert.equal(tool.schema.shape.collection, undefined);
  assert.equal(tool.schema.shape.embedding_model, undefined);
  await tool.invoke(args);
  const items = await service.prepareWorkflowItems(context, args, 0, { query: args });
  return JSON.parse(JSON.stringify(items[0].json));
}
function validate(input, workflow = search) {
  const code = workflow.nodes.find(n => n.id === 'ob-search-validate').parameters.jsCode;
  return new Function('$input', '$env', code)({ first: () => ({ json: input }) }, { LITELLM_API_KEY: 'synthetic' })[0].json;
}

test('real n8n maps the Chemelot date_start into a hard Qdrant filter, not only query', async () => {
  const mapped = await map('openbesluitvorming_search_tool', { query: 'Chemelot', date_start: '2020-01-01', query_variants: '["Chemelot","chemische industrie"]', result_limit: 100 });
  assert.equal(mapped.date_start, '2020-01-01');
  assert.equal(mapped.date_end, '');
  const config = validate(mapped);
  assert.equal(config.filters.date_from, '2020-01-01');
  assert.equal(config.filters.date_to, undefined);
  assert.ok(config.query_variants.includes('chemische industrie'));
  assert.ok(JSON.stringify(config.qdrant_filter).includes('2020-01-01T00:00:00.000Z'));
  const code = search.nodes.find(n => n.id === 'ob-search-candidates').parameters.jsCode;
  const requests = new Function('$', '$input', code)(() => ({ first: () => ({ json: config }) }),
    { first: () => ({ json: { data: config.query_variants.map(() => ({ embedding: Array(3072).fill(0.1) })) } }) });
  assert.ok(requests.length > 1, 'one tool call handles multiple internal variants');
  for (const item of requests) assert.deepEqual(item.json.request_body.filter, config.qdrant_filter);
});

test('end day is inclusive, metadata is hard-filtered, invalid or conflicting dates fail', async () => {
  const mapped = await map('openbesluitvorming_search_tool', { query: 'Chemelot', date_start: '2020-01-01', date_end: '2024-12-31', document_type: 'Motie' });
  const config = validate(mapped);
  assert.equal(config.filters.document_type, 'Motie');
  assert.ok(JSON.stringify(config.qdrant_filter).includes('2025-01-01T00:00:00.000Z'));
  for (const extra of [{ date_start: '2020-02-30' }, { date_start: '2025-01-01', date_end: '2024-01-01' }, { date_start: '2020-01-01', date_from: '2021-01-01' }]) {
    assert.throws(() => validate({ query: 'Chemelot', ...extra }));
  }
});

test('real n8n statistics tool uses operation/filter parameters and normalized hard dates', async () => {
  const mapped = await map('openbesluitvorming_statistics_tool', { operation: 'group', field: 'date', interval: 'year', date_start: '2020-01-01', document_type: 'Motie' });
  assert.equal(typeof mapped.query, 'object', 'n8n includes a checked internal transport wrapper');
  const request = normalizeQuery(mapped);
  assert.equal(request.operation, 'group');
  assert.ok(request.filters.some(f => f.field === 'date' && f.gte === '2020-01-01T00:00:00.000Z'));
  assert.ok(request.filters.some(f => f.field === 'document_type' && f.value === 'Motie'));
  assert.throws(() => normalizeQuery({ operation: 'count', query: 'ignored', date_start: '2020-01-01' }));
  assert.throws(() => normalizeQuery({ operation: 'count', date_start: '2020-02-30' }));
});

test('migration keeps server-owned source, snapshot and embedding model and is idempotent', () => {
  const live = structuredClone(search);
  const node = live.nodes.find(n => n.id === 'ob-search-validate');
  node.parameters.jsCode = node.parameters.jsCode.replace('const sourceKey=filters.source_key||null;', "const sourceKey='test_source';")
    .replace("const collection=String(input.collection||input.collectionName||'openraadsinformatie_v1').trim();", "const collection='test_snapshot';")
    .replace("embedding_model:String(input.embedding_model||input.embeddingModel||'govchat-embedding')", "embedding_model:'test_embedding'");
  applySearchWorkflowInputs(live);
  const normalized = validate({ query: 'Chemelot', date_start: '2020-01-01', collection: 'forged', embedding_model: 'forged' }, live);
  assert.equal(normalized.collection, 'test_snapshot');
  assert.equal(normalized.embedding_model, 'test_embedding');
  assert.equal(normalized.filters.source_key, 'test_source');
  assert.ok(normalized.qdrant_filter.must.some(c => c.key === 'source_key' && c.match.value === 'test_source'));
  assert.throws(() => validate({ query: 'Chemelot', source_key: 'other' }, live));
  assert.deepEqual(applySearchWorkflowInputs(structuredClone(live)), live);
});
