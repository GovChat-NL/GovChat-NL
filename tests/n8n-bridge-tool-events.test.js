'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { Readable } = require('node:stream');
const { patchSource } = require('../scripts/n8n-bridge-tool-events');

// Run in the deployed bridge image with network disabled.
function client(patched) {
  const filename = '/app/src/n8nClient.js';
  const source = fs.readFileSync(filename, 'utf8');
  const mod = new Module(filename);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths('/app/src');
  mod._compile(patched ? patchSource(source) : source, filename);
  return new mod.exports({ diagnosticLogging: false });
}
const name = 'openbesluitvorming_search_tool';
const start = id => ({ type: 'tool_call', id, name, arguments: { query: 'Chemelot', date_start: '2020-01-01' } });
const end = id => ({ type: 'tool_result', id, name, output: 'synthetic search result' });
async function events(patched, chunks) {
  const response = { data: Readable.from(chunks.map(c => Buffer.from(JSON.stringify(c) + '\n'))) };
  const all = [];
  for await (const event of client(patched).processResponseStream(response, { runId: 'synthetic-run' })) all.push(event);
  return all.filter(e => e.kind === 'librechat_step_event').map(e => e.payload);
}

test('reproduces three UI cards for two real calls and fixes the phantom metadata card', async () => {
  const chunks = [start('call1'), { type: 'begin', metadata: { nodeId: 'ToolOpenBesluitvormingSearch', nodeName: name } }, end('call1'), start('call2'), end('call2')];
  const count = events => events.filter(e => e.event === 'on_run_step').length;
  assert.equal(count(await events(false, chunks)), 3);
  const fixed = await events(true, chunks);
  assert.equal(count(fixed), 2);
  assert.equal(fixed.filter(e => e.event === 'on_run_step_completed').length, 2);
});

test('replayed same-ID events do not create another card, but new IDs remain distinct', async () => {
  const fixed = await events(true, [start('call1'), end('call1'), start('call1'), end('call1'), start('call2'), end('call2')]);
  assert.equal(fixed.filter(e => e.event === 'on_run_step').length, 2);
  assert.equal(fixed.filter(e => e.event === 'on_run_step_completed').length, 2);
});

test('model-generated tool-like text alone is not an execution event', async () => {
  const fixed = await events(true, [{ type: 'item', content: '{"tool_calls":[{"name":"openbesluitvorming_search_tool","arguments":{"query":"Chemelot"}}]}' }]);
  assert.equal(fixed.filter(e => e.event === 'on_run_step').length, 0);
  const prose = await events(true, [{ type: 'item', content: JSON.stringify(start('not-executed')) }]);
  assert.equal(prose.filter(e => e.event === 'on_run_step').length, 0);
  const source = fs.readFileSync('/app/src/n8nClient.js', 'utf8');
  assert.equal(patchSource(patchSource(source)), patchSource(source));
});

test('n8n event replay neither increments toolCalls nor reactivates a completed ID', async () => {
  const { processEventStream } = require('../scripts/n8n-processEventStream.patched');
  const model = { event: 'on_chat_model_end', data: { output: { tool_calls: [{ id: 'same-id', name, args: { query: 'Chemelot' } }] } } };
  async function* stream() {
    yield model;
    yield { event: 'on_tool_end', name, data: { output: 'synthetic' } };
    yield model;
  }
  const chunks = [];
  const result = await processEventStream({ sendChunk: (type, index, data) => chunks.push({ type, data }) }, stream(), 0);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(chunks.filter(c => c.type === 'tool_call').length, 1);
  assert.equal(chunks.filter(c => c.type === 'tool_result').length, 1);
});
