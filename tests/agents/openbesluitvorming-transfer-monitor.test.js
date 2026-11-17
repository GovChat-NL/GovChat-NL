'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collect } = require('../../scripts/openbesluitvorming-progress');

for (const running of [true, false]) {
  test(`explicit restored target monitor (${running ? 'running' : 'stopped'}) never selects source defaults`, () => {
    const calls = [];
    const read = args => {
      calls.push(args);
      if (args[0] === 'inspect') return JSON.stringify({ Running: running, Status: running ? 'running' : 'exited' });
      return JSON.stringify({ run: { id: 'restored-run', pages: 1, snapshot_complete: 1 }, counts: { indexed: 1 } });
    };
    const result = collect(read, 'restored-container-id', 'restored-run');
    assert.equal(result.counts.indexed, 1);
    assert.equal(calls[0].at(-1), 'restored-container-id');
    assert.ok(calls[1].includes('restored-run'));
    assert.ok(calls[1].includes(running ? 'restored-container-id' : 'restored-container-id:ro'));
    assert.ok(!calls.flat().includes('govchat-obv-full-run'));
    assert.ok(!calls.flat().includes('limburg-full-20261111'));
  });
}
