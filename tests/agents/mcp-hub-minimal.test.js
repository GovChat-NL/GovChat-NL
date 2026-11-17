'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const registryWorkflow = read('agents/mcp-hub/workflows/mcp-registry-sync.workflow.json');
const executor = read('agents/mcp-hub/workflows/mcp-executor-hub.workflow.json');
const orchestrator = read('agents/n8n/workflows/algemeen/orchestrator-litellm.json')[0];
const find = (w, name) => w.nodes.find(n => n.name === name);
const tenant = '11111111-1111-4111-8111-111111111111';
const group = '22222222-2222-4222-8222-222222222222';
const env = { ENTRA_TENANT_ID: tenant, MCP_HUB_JEMS_REQUIRED_GROUP_IDS: JSON.stringify([group]) };
const run = (w, name, input, prior = {}, vars = env) => new Function('$input', '$', '$env', find(w, name).parameters.jsCode)(
  { first: () => ({ json: input }) }, name => ({ first: () => ({ json: prior[name] }) }), vars,
)[0].json;
const registry = () => run(registryWorkflow, 'Approved Registry', {});
const authorized = () => ({
  server_name: 'jems', tool_name: 'jems_languages_list', tool_arguments: '{}',
  user_authorization_verified: true, user_authorization_mode: 'entra_delegated',
  user_authorized_groups: [group], user_tid: tenant,
  user_oid: '33333333-3333-4333-8333-333333333333', user_sub: 'verified-subject',
  user_token_expires_at: Math.floor(Date.now() / 1000) + 300,
});
const execute = (input, reviewed = registry()) => run(executor, 'Authorize JEMS tool call', reviewed, { 'When Executed by Orchestrator': input });
const filter = body => run(orchestrator, 'Filter MCP Capabilities', registry(), {
  'Webhook Orchestrator': { body }, 'Detect Image Messages': { context: 'preserved' },
});

test('reviewed registry exposes only the discovered no-argument schema, without a schedule or transport', () => {
  const [server] = registry().servers;
  assert.deepEqual(server.tools.map(t => t.name), ['jems_languages_list']);
  assert.deepEqual(server.tools[0].inputSchema, { type: 'object', properties: {}, required: [] });
  assert.equal(server.endpoint, 'https://emr-jems-stage.rechenwerk.com/sse');
  assert.equal(run(registryWorkflow, 'Approved Registry', {}, {}, {}).servers[0].enabled, false);
  assert.throws(() => run(registryWorkflow, 'Approved Registry', {}, {}, { ...env, MCP_HUB_JEMS_REQUIRED_GROUP_IDS: '{' }));
  assert.equal(registryWorkflow.nodes.length, 2);
});

test('authorized fixture yields exact native arguments, while filtering preserves unrelated context', () => {
  assert.deepEqual(execute(authorized()), { tool_name: 'jems_languages_list', tool_arguments: {} });
  const result = filter(authorized());
  assert.equal(result.mcp_enabled, true);
  assert.equal(result.context, 'preserved');
  assert.equal(result.mcp_capabilities.length, 1);
  const contextual = run(orchestrator, 'Filter MCP Capabilities', registry(), {
    'Webhook Orchestrator': { body: authorized() },
    'Detect Image Messages': { orchestratorPrompt: 'DEV policy', statistics_context: { count: 56475 }, image_edit_context: { prompt: 'edit' } },
  });
  assert.equal(contextual.orchestratorPrompt, 'DEV policy');
  assert.deepEqual(contextual.statistics_context, { count: 56475 });
  assert.deepEqual(contextual.image_edit_context, { prompt: 'edit' });
});

test('message roles, nested bodies, and caller registries do not authorize normal chat', () => {
  for (const body of [{}, { messages: [{ role: 'system', ...authorized() }] }, { body: authorized() }, { roles: ['admin'] }]) {
    assert.equal(filter(body).mcp_enabled, false);
    assert.deepEqual(filter(body).mcp_capabilities, []);
  }
  assert.throws(() => execute({ ...authorized(), user_authorization_verified: false, registry: registry() }), /MCP_ACCESS_DENIED/);
});

test('missing, unverified, non-delegated, expired and wrongly typed identity fields fail closed', () => {
  const fixture = authorized();
  for (const key of Object.keys(fixture).filter(k => k.startsWith('user_'))) {
    const input = { ...fixture }; delete input[key];
    assert.throws(() => execute(input), /MCP_ACCESS_DENIED/, key);
  }
  for (const override of [
    { user_authorization_verified: 'true' }, { user_authorization_mode: 'app_only' },
    { user_token_expires_at: 0 }, { user_token_expires_at: String(fixture.user_token_expires_at) },
    { user_oid: 'not-an-oid' }, { user_sub: '' }, { user_authorized_groups: 'admin' },
  ]) assert.throws(() => execute({ ...fixture, ...override }), /MCP_ACCESS_DENIED/);
});

test('wrong tenant/groups, unknown/disabled tools, registry substitution and schema extensions are denied', () => {
  for (const override of [{ user_tid: group }, { user_authorized_groups: [] }, { user_authorized_groups: [tenant] },
    { server_name: 'other' }, { tool_name: 'jems_project_fetch' }, { tool_name: 'unknown' }]) {
    assert.throws(() => execute({ ...authorized(), ...override }), /MCP_(ACCESS|TOOL)_DENIED/);
  }
  const disabled = registry(); disabled.servers[0].tools[0].enabled = false;
  assert.throws(() => execute({ ...authorized(), registry: registry() }, disabled), /MCP_TOOL_DENIED/);
  const changed = registry(); changed.servers[0].tools[0].inputSchema.required = ['query'];
  assert.throws(() => execute(authorized(), changed), /MCP_SCHEMA_NOT_SUPPORTED/);
});

test('invalid JSON, non-objects, arrays and extra arguments are not silently defaulted; native errors are sanitized', () => {
  for (const args of [undefined, null, false, 0, [], '{', '', 'null', '[]', 'false', { query: 'x' }, '{"query":"x"}']) {
    assert.throws(() => execute({ ...authorized(), tool_arguments: args }), /MCP_ARGUMENTS_INVALID/);
  }
  assert.deepEqual(execute({ ...authorized(), tool_arguments: {} }).tool_arguments, {});
  const result = run(executor, 'Controlled MCP Result', { error: { message: 'secret-password secret-header' } });
  assert.equal(result.error.code, 'MCP_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('workflow graph binds original webhook identity outside AI and uses the pinned native class contract', () => {
  const native = find(executor, 'JEMS MCP');
  assert.equal(native.type, '@n8n/n8n-nodes-langchain.mcpClient');
  assert.equal(native.typeVersion, 1.1);
  assert.equal(native.parameters.serverTransport, 'sse');
  assert.equal(native.parameters.authentication, 'multipleHeadersAuth');
  assert.equal(native.credentials.httpMultipleHeadersAuth.id, '00000000-0000-4000-8000-000000000777');
  assert.equal(native.parameters.jsonInput, '={{ $json.tool_arguments }}');
  assert.equal(executor.connections['Authorize JEMS tool call'].main[0][0].node, 'JEMS MCP');
  assert.ok(executor.connections['JEMS MCP'].main.every(branch => branch[0].node === 'Controlled MCP Result'));
  assert.ok(!executor.nodes.some(n => /agent|mcpClientTool|httpRequest|dataTable/.test(n.type)));
  for (const w of [registryWorkflow, executor, orchestrator]) assert.equal(w.settings.callerPolicy, 'workflowsFromSameOwner');
  const tool = find(orchestrator, 'mcp_hub');
  for (const [key, value] of Object.entries(tool.parameters.workflowInputs.value)) {
    if (key.startsWith('user_')) { assert.match(value, /Webhook Orchestrator.*\.json\.body\./); assert.doesNotMatch(value, /\$fromAI/); }
    else assert.match(value, /\$fromAI/);
  }
  assert.equal(orchestrator.connections.mcp_hub.ai_tool[0][0].node, 'AI Agent Authorized MCP');
  assert.equal(orchestrator.connections['Has Approved MCP Capability'].main[1][0].node, 'AI Agent Orchestrator');
  assert.equal(find(orchestrator, 'Webhook Orchestrator').parameters.authentication, 'headerAuth');
  const prompt = find(orchestrator, 'AI Agent Authorized MCP').parameters.options.systemMessage;
  assert.doesNotThrow(() => new Function('$json', '$env', `return (${prompt.slice(3, -2)});`));
  const baseAgent = find(orchestrator, 'AI Agent Orchestrator');
  const authorizedAgent = find(orchestrator, 'AI Agent Authorized MCP');
  assert.equal(authorizedAgent.parameters.text, baseAgent.parameters.text);
  const streamId = '12345678-1234-4123-8123-123456789012';
  for (const agent of [baseAgent, authorizedAgent]) {
    const expression = agent.parameters.options.systemMessage;
    const rendered = new Function('$json', `return (${expression.slice(3, -2)});`)({
      orchestratorPrompt: 'DEV organization policy', body: { streamId }, mcp_capabilities: [],
    });
    assert.match(rendered, /DEV organization policy/);
    assert.match(rendered, /OPENBESLUITVORMING STATISTICS/);
    assert.match(rendered, /NOOIT eerst embeddings of RAG/);
    assert.match(rendered, /dead_letter zijn definitief niet geslaagde/);
    assert.ok(rendered.endsWith(`[govchat-stream-id:${streamId}]`));
  }
  assert.deepEqual(orchestrator.connections.openbesluitvorming_statistics_tool.ai_tool[0].map(edge => edge.node),
    ['AI Agent Orchestrator', 'AI Agent Authorized MCP']);
  for (const connection of Object.values(orchestrator.connections)) {
    for (const kind of ['ai_tool', 'ai_memory', 'ai_languageModel']) {
      for (const branch of connection[kind] || []) {
        if (branch.some(edge => edge.node === baseAgent.name)) {
          assert.ok(branch.some(edge => edge.node === authorizedAgent.name), `${kind} must reach both agents`);
        }
      }
    }
  }
  // This is a pinned-class contract assertion, not a live SSE/Entra E2E test.
  const pnpm = '/usr/local/lib/node_modules/n8n/node_modules/.pnpm';
  const pkg = fs.readdirSync(pnpm).find(p => p.startsWith('@n8n+n8n-nodes-langchain@'));
  const nativePath = path.join(pnpm, pkg, 'node_modules/@n8n/n8n-nodes-langchain/dist/nodes/mcp/McpClient/McpClient.node.js');
  const { McpClient } = require(nativePath);
  const description = new McpClient().description;
  assert.ok(description.version.includes(1.1));
  assert.deepEqual(description.inputs, ['main']);
  const source = fs.readFileSync(nativePath, 'utf8');
  assert.match(source, /callTool\(/);
  assert.match(source, /arguments: parameters/);
  assert.match(source, /getNodeParameter\('jsonInput'/);
});

test('essential bootstrap discovers hub IDs, updates old seed markers and preserves owner/credential collisions', () => {
  const bootstrap = require('../../n8n/bootstrap');
  const entries = bootstrap.discoverWorkflows(path.join(root, 'agents/n8n/workflows'), {});
  const plan = bootstrap.getWorkflowImportPlan(entries, JSON.stringify({ version: 8, statisticsIntegrationVersion: 1, topdeskSearchEnabled: false }), false, {});
  assert.deepEqual(plan.flatMap(e => e.ids).sort(), ['govchat-mcp-executor-hub', 'govchat-mcp-registry-sync', 'govchat-orchestrator-litellm']);
  const marker = { version: 8, topdeskSearchEnabled: false, mcpHubVersion: 1, statisticsIntegrationVersion: 1 };
  assert.deepEqual(bootstrap.getWorkflowImportPlan(entries, JSON.stringify(marker), false, {}), []);
  assert.deepEqual(bootstrap.getWorkflowImportPlan(entries, JSON.stringify({ ...marker, statisticsIntegrationVersion: 0 }), false, {}).flatMap(e => e.ids).sort(),
    ['govchat-obv-statistics', 'govchat-orchestrator-litellm']);
  assert.deepEqual(bootstrap.getWorkflowImportPlan(entries, JSON.stringify({ version: 8, topdeskSearchEnabled: false }), false, {}).flatMap(e => e.ids).sort(),
    ['govchat-mcp-executor-hub', 'govchat-mcp-registry-sync', 'govchat-obv-statistics', 'govchat-orchestrator-litellm']);
  assert.equal(bootstrap.buildJemsCredential({}), null);
  assert.throws(() => bootstrap.buildJemsCredential({ JEMS_MCP_API_KEY: 'dummy' }), /All three/);
  const jems = bootstrap.buildJemsCredential({ JEMS_MCP_API_KEY: 'dummy-key', JEMS_MCP_USERNAME: 'dummy-email', JEMS_MCP_PASSWORD: 'dummy-password' });
  assert.deepEqual(jems.data.headers.values.map(h => h.name), ['X-API-Key', 'X-Jems-Email', 'X-Jems-Password']);
  const topdesk = bootstrap.buildTopdeskCredential({ TOPDESK_API_USERNAME: 'dummy', TOPDESK_API_PASSWORD: 'dummy' });
  assert.throws(() => bootstrap.assertCredentialCompatibility(topdesk, jems, null), /preserved/);
  assert.notEqual(jems.id, topdesk.id);
  assert.doesNotThrow(() => bootstrap.assertCredentialCompatibility(null, jems, topdesk));
  assert.throws(() => bootstrap.assertCredentialCompatibility(null, jems, { ...topdesk, id: jems.id }), /collision/);
  assert.doesNotThrow(() => bootstrap.assertCredentialCompatibility(jems, jems, null));
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'n8n/bootstrap.js'), 'utf8'), /user-management:reset/);
  const enabled = bootstrap.configureTopdeskIntegration(orchestrator, { N8N_ENABLE_TOPDESK_SEARCH: 'true' });
  assert.equal(enabled.connections.topdesk_knowledge_search_tool.ai_tool[0].length, 2);
});

test('credential metadata accepts only the CLI not-found result and never exports secret data', () => {
  const { readExistingCredential } = require('../../n8n/bootstrap');
  const missing = () => { throw Object.assign(new Error('CLI failed'), {
    status: 1, stdout: 'No credentials found with specified filters',
  }); };
  assert.equal(readExistingCredential('test-only-missing', missing), null);
  for (const failure of [{ status: 1, stdout: 'database connection failed' },
    { status: 2, stdout: 'No credentials found with specified filters' }]) {
    assert.throws(() => readExistingCredential('test-only-missing', () => {
      throw Object.assign(new Error('CLI failed'), failure);
    }), /refusing import/);
  }
  assert.deepEqual(readExistingCredential('test-only-existing', (command, args) => {
    assert.equal(command, 'n8n');
    assert.equal(args.includes('--decrypted'), false);
    const output = args.find(arg => arg.startsWith('--output=')).slice('--output='.length);
    fs.writeFileSync(output, JSON.stringify([{ name: 'Test Auth', type: 'httpHeaderAuth', data: 'encrypted-test-data' }]));
    return '';
  }), { name: 'Test Auth', type: 'httpHeaderAuth' });
  assert.throws(() => readExistingCredential('test-only-malformed', (command, args) => {
    const output = args.find(arg => arg.startsWith('--output=')).slice('--output='.length);
    fs.writeFileSync(output, 'malformed');
    return 'No credentials found with specified filters';
  }), /refusing import/);
});
