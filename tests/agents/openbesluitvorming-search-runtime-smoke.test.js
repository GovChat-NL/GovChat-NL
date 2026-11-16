'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('./build-openbesluitvorming-search-smoke.cjs');
const source = require('../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json');

test('probe executes unchanged inactive search via parameter, not unpublished database lookup', () => {
  const probe = build();
  assert.equal(probe.active, false);
  assert.equal(probe.nodes.length, 3);
  const execute = probe.nodes.find(n => n.type === 'n8n-nodes-base.executeWorkflow');
  assert.equal(execute.parameters.source, 'parameter');
  assert.equal(execute.parameters.options.waitForSubWorkflow, true);
  const snapshot = JSON.parse(execute.parameters.workflowJson);
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.settings.saveDataSuccessExecution, 'all');
  assert.equal(source.settings.saveDataSuccessExecution, undefined);
  assert.deepEqual(snapshot.nodes, source.nodes);
  assert.deepEqual(snapshot.connections, source.connections);
  assert.throws(() => build({ ...source, active: true }), /inactive/);
  assert.throws(() => build({ ...source, nodes: [] }), /differ/);
});

test('probe authenticates before search and bounds collection, query and metadata modes', () => {
  const code = build().nodes.find(n => n.type === 'n8n-nodes-base.code').parameters.jsCode;
  const run = (body, authorization, token = 'test-only-token') => new Function('$input', '$env', code)(
    { first: () => ({ json: { body, headers: { authorization } } }) }, { N8N_WEBHOOK_TOKEN: token });
  assert.throws(() => run({}, undefined), /Unauthorized/);
  assert.throws(() => run({}, 'Bearer wrong'), /Unauthorized/);
  assert.throws(() => run({}, 'Bearer ', ''), /Unauthorized/);
  assert.throws(() => run({ mode: 'ingest' }, 'Bearer test-only-token'), /Unsupported/);
  const input = run({ collection: 'limburg_full_20261111', query: 'ignored', filters: {} }, 'Bearer test-only-token')[0].json;
  assert.equal(input.collection, 'limburg_sample_20261111');
  assert.match(input.query, /coronavirus/);
  assert.deepEqual(input.filters, { source_key: 'provincie_limburg' });
  assert.equal(input.include_content, true);
  assert.equal(input.result_limit, 5);
  assert.deepEqual(run({ mode: 'date_2020' }, 'Bearer test-only-token')[0].json.filters,
    { source_key: 'provincie_limburg', date_from: '2020-01-01', date_to: '2020-12-31' });
  assert.equal(run({ mode: 'wrong_source' }, 'Bearer test-only-token')[0].json.filters.source_key, 'provincie_nonexistent_smoke');
});
