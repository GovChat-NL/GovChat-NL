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
  const legacyMarker = JSON.stringify({ version: 8, statisticsIntegrationVersion: 1, topdeskCompanySecurityVersion: 1, topdeskSearchEnabled: false });
  assert.deepEqual(getWorkflowImportPlan(workflows, legacyMarker, false, env).flatMap(entry => entry.ids).sort(),
    ['govchat-mcp-executor-hub', 'govchat-mcp-registry-sync', 'govchat-orchestrator-litellm']);
  const marker = JSON.stringify({ version: 8, statisticsIntegrationVersion: 1, mcpHubVersion: 2, topdeskCompanySecurityVersion: 1, topdeskSearchEnabled: false });
  assert.deepEqual(getWorkflowImportPlan(workflows, marker, false, env), []);
  const changed = getWorkflowImportPlan(workflows, marker, false, { N8N_ENABLE_TOPDESK_SEARCH: 'true' });
  assert.deepEqual(changed.map(entry => entry.file).sort(), ['algemeen/orchestrator-litellm.json', 'topdesk-knowledge-items-search.json']);
});

test('workflow rendering creates private nested directories and preserves TOPdesk configuration', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pr13-bootstrap-'));
  try {
    for (const workflow of discoverWorkflows(directory, env)) {
      const output = writeRenderedWorkflow(workflow, env, temporary);
      assert.equal(path.relative(temporary, output).split(path.sep).join('/'), workflow.file);
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(output).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(output)).mode & 0o777, 0o700);
      }
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
    for (const file of ['update-orchestrator-workflow.js', 'orchestrator-utility-workflow.js',
      'orchestrator-document-workflow.js', 'n8n-document-context.js',
      'orchestrator-image-workflow.js', 'orchestrator-prompt-workflow.js',
      'orchestrator-manual-workflow.js',
      'orchestrator-image-edit-workflow.js', 'openbesluitvorming-statistics-workflow.js',
      'openbesluitvorming-tool-inputs.js', 'openbesluitvorming-search-performance.js',
      'openbesluitvorming-filter-description.js',
      'workflow-function-source.js', 'topdesk-workflow-security.js']) {
      fs.copyFileSync(path.resolve(__dirname, '../../scripts', file), path.join(scripts, file));
    }
    const workflowsDir = path.join(temporary, 'agents/n8n/workflows');
    fs.cpSync(directory, workflowsDir, { recursive: true });
    fs.cpSync(path.resolve(directory, '../../mcp-hub/workflows'),
      path.join(temporary, 'agents/mcp-hub/workflows'), { recursive: true });
    execFileSync(process.execPath, [path.join(scripts, 'update-orchestrator-workflow.js')]);
    const renderedOnce = fs.readFileSync(path.join(workflowsDir, 'algemeen/orchestrator-litellm.json'), 'utf8');
    const searchOnce = fs.readFileSync(path.join(workflowsDir, 'topdesk-knowledge-items-search.json'), 'utf8');
    const manualOnce = fs.readFileSync(path.join(workflowsDir, 'govchat-manual-read.json'), 'utf8');
    execFileSync(process.execPath, [path.join(scripts, 'update-orchestrator-workflow.js')]);
    assert.equal(fs.readFileSync(path.join(workflowsDir, 'algemeen/orchestrator-litellm.json'), 'utf8'), renderedOnce);
    assert.equal(fs.readFileSync(path.join(workflowsDir, 'topdesk-knowledge-items-search.json'), 'utf8'), searchOnce);
    assert.equal(fs.readFileSync(path.join(workflowsDir, 'govchat-manual-read.json'), 'utf8'), manualOnce);
    const workflows = discoverWorkflows(workflowsDir, env);
    assert.equal(workflows.length, discoverWorkflows(directory, env).length);
    const ids = workflows.flatMap(entry => entry.ids);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(workflows.filter(entry => entry.file.startsWith('algemeen/govchat-utility-')).length, 0);
    const template = JSON.parse(fs.readFileSync(path.join(workflowsDir, 'algemeen/orchestrator-litellm.json')))[0];
    assert.equal(template.nodes.filter(node => node.name === 'TOPdesk availability').length, 1);
    assert.match(template.nodes.find(node => node.name === 'topdesk_knowledge_search_tool').parameters.workflowInputs.value.topdesk_handle, /Webhook Orchestrator/);
    const detector = template.nodes.find(node => node.id === 'DetectImageMessages');
    assert.match(detector.parameters.jsCode, /api\/internal\/orchestrator\/prompt/);
    assert.match(detector.parameters.jsCode, /role: 'system', content: orchestratorPrompt/);
    assert.match(detector.parameters.jsCode, /imageEditContext/);
    assert.ok(template.nodes.some(node => node.id === 'ExtractDocumentContext'));
    const agent = template.nodes.find(node => node.id === 'AIAgentOrchestrator');
    assert.match(agent.parameters.options.systemMessage, /const organizationPrompt = \$json\.orchestratorPrompt/);
    assert.match(agent.parameters.options.systemMessage, /OPENBESLUITVORMING STATISTICS/);
    assert.equal(template.nodes.filter(node => node.name === 'openbesluitvorming_statistics_tool').length, 1);
    const imageTool = template.nodes.find(node => node.name === 'image_generation_tool');
    assert.match(JSON.stringify(imageTool.parameters), /Webhook Orchestrator/);
    assert.match(JSON.stringify(imageTool.parameters), /sourceImage/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
