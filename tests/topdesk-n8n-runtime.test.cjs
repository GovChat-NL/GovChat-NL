'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { configureTopdeskIntegration } = require('../n8n/bootstrap');

const base = '/usr/local/lib/node_modules/n8n/node_modules/.pnpm';
const pkg = fs.readdirSync(base).find(name => name.startsWith('@n8n+n8n-nodes-langchain@'));
assert.ok(pkg, 'requires the pinned native n8n image, never silently skip');
const dist = path.join(base, pkg, 'node_modules/@n8n/n8n-nodes-langchain/dist');
const raw = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../agents/n8n/workflows/algemeen/orchestrator-litellm.json')));
const workflow = configureTopdeskIntegration(raw, { N8N_ENABLE_TOPDESK_SEARCH: 'true' })[0];
const node = workflow.nodes.find(n => n.name === 'topdesk_knowledge_search_tool');

test('native ToolWorkflow creates an AI schema with question only, never private handle or credentials', () => {
  const { WorkflowToolService } = require(path.join(dist, 'nodes/tools/ToolWorkflow/v2/utils/WorkflowToolService.js'));
  const service = new WorkflowToolService({ getNode: () => node });
  const tool = service.createStructuredTool(node.name, '[GOVCHAT_TOPDESK_AVAILABLE] test', async () => 'source result');
  assert.deepEqual(Object.keys(tool.schema.shape), ['question']);
  assert.doesNotMatch(JSON.stringify(tool.schema), /topdesk_handle|access_token|refresh_token|companyName/);
  assert.doesNotMatch(node.parameters.workflowInputs.value.topdesk_handle, /fromAI/);
});

test('actual n8n V3 binding overlay filters TOPdesk in regular and model metadata tool sets, for both agent branches', () => {
  const filename = path.join(dist, 'nodes/agents/Agent/agents/ToolsAgent/V3/helpers/createAgentSequence.js');
  const source = fs.readFileSync(filename, 'utf8');
  assert.match(source, /govchatPolicy\.selectTools/);
  const compiled = new Module(filename, module); compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(source + '\nexports.testGetAllTools = getAllTools;', filename);
  const getAllTools = compiled.exports.testGetAllTools;
  for (const agent of ['AI Agent Orchestrator', 'AI Agent Authorized MCP']) {
    assert.equal(workflow.connections[node.name].ai_tool[0].some(n => n.node === agent), true);
    for (const allowed of [true, false]) {
      const description = `[GOVCHAT_TOPDESK_${allowed ? 'AVAILABLE' : 'UNAVAILABLE'}] test`;
      const model = { metadata: { tools: [{ name: node.name, description }] } };
      const result = getAllTools(model, [{ name: node.name, description }, { name: 'ordinary_tool' }]);
      assert.equal(result.filter(t => t.name === node.name).length, allowed ? 2 : 0);
      assert.equal(result.some(t => t.name === 'ordinary_tool'), true);
    }
  }
});
