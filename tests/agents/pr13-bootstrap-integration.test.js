'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { discoverWorkflows, getWorkflowImportPlan, writeRenderedWorkflow } = require('../../n8n/bootstrap');

const directory = path.resolve(__dirname, '../../agents/n8n/workflows');
const env = { N8N_ENABLE_TOPDESK_SEARCH: 'false' };

test('bootstrap discovers grouped PR workflows and flat dev additions without duplicate IDs', () => {
  const workflows = discoverWorkflows(directory, env);
  const files = workflows.map(entry => entry.file);
  for (const file of ['algemeen/orchestrator-litellm.json', 'openbesluitvorming/openbesluitvorming-search.json',
    'beleidskompas/beleidskompas-step-stap1.json', 'govchat-utility-time.json', 'topdesk-knowledge-items-search.json']) {
    assert.ok(files.includes(file), `Missing workflow: ${file}`);
  }
  const ids = workflows.flatMap(entry => entry.ids);
  assert.equal(new Set(ids).size, ids.length);
});

test('the merged bootstrap imports new workflows after either parent marker, then remains idempotent', () => {
  const workflows = discoverWorkflows(directory, env);
  for (const version of [6, 7]) {
    assert.deepEqual(getWorkflowImportPlan(workflows, JSON.stringify({ version, topdeskSearchEnabled: false }), false, env), workflows);
  }
  const marker = JSON.stringify({ version: 8, topdeskSearchEnabled: false });
  assert.deepEqual(getWorkflowImportPlan(workflows, marker, false, env), []);
  const changed = getWorkflowImportPlan(workflows, marker, false, { N8N_ENABLE_TOPDESK_SEARCH: 'true' });
  assert.deepEqual(changed.map(entry => entry.file).sort(), ['algemeen/orchestrator-litellm.json', 'topdesk-knowledge-items-search.json']);
});

test('workflow rendering creates private nested directories and preserves TOPdesk configuration', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pr13-bootstrap-'));
  try {
    for (const workflow of discoverWorkflows(directory, env)) {
      const output = writeRenderedWorkflow(workflow, env, temporary);
      assert.equal(path.relative(temporary, output), workflow.file);
      assert.equal(fs.statSync(output).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(output)).mode & 0o777, 0o700);
      const rendered = JSON.parse(fs.readFileSync(output, 'utf8'));
      const items = Array.isArray(rendered) ? rendered : [rendered];
      assert.deepEqual(items.map(item => item.id).filter(Boolean), workflow.ids);
      for (const item of items) {
        if (item.id === 'govchat-orchestrator-litellm') {
          assert.equal(item.nodes.some(node => node.name === 'topdesk_knowledge_search_tool'), false);
        }
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('regenerating the moved orchestrator does not create duplicate utility exports', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pr13-generator-'));
  try {
    const scripts = path.join(temporary, 'scripts');
    fs.mkdirSync(scripts);
    for (const file of ['update-orchestrator-workflow.js', 'orchestrator-utility-workflow.js']) {
      fs.copyFileSync(path.resolve(__dirname, '../../scripts', file), path.join(scripts, file));
    }
    const workflowsDir = path.join(temporary, 'agents/n8n/workflows');
    fs.cpSync(directory, workflowsDir, { recursive: true });
    execFileSync(process.execPath, [path.join(scripts, 'update-orchestrator-workflow.js')]);
    const workflows = discoverWorkflows(workflowsDir, env);
    assert.equal(workflows.length, discoverWorkflows(directory, env).length);
    const ids = workflows.flatMap(entry => entry.ids);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(workflows.filter(entry => entry.file.startsWith('algemeen/govchat-utility-')).length, 0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
