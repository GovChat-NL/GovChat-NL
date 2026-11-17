'use strict';

// Keep the reusable fixture small; inject an unchanged search snapshot at import time.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/openbesluitvorming-search-runtime-smoke.json');
const source = require('../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json');

function build(search = source) {
  assert.equal(search.id, source.id);
  assert.equal(search.active, false, 'Core search must remain inactive');
  assert.deepEqual(search.nodes, source.nodes, 'Deployed search nodes differ from source');
  assert.deepEqual(search.connections, source.connections);
  const result = structuredClone(fixture);
  // Diagnostic retention only: global save-on-success=none otherwise leaves progress rows.
  const settings = { ...search.settings, saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all' };
  const snapshot = { id: search.id, name: search.name, active: false, nodes: search.nodes, connections: search.connections, settings };
  result.nodes.find(n => n.type === 'n8n-nodes-base.executeWorkflow').parameters.workflowJson = JSON.stringify(snapshot);
  return result;
}

module.exports = { build };
if (require.main === module) {
  const output = process.argv[2];
  assert.ok(output, 'Provide a temporary output path');
  const deployed = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : source;
  const search = Array.isArray(deployed) ? deployed.find(w => w.id === source.id) : deployed;
  fs.writeFileSync(path.resolve(output), JSON.stringify(build(search), null, 2) + '\n');
}
