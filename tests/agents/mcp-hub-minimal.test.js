'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
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
// Safe fabricated identifiers and dates: unit fixtures ONLY, never a staging query.
const fetchArgs = { projectId: 12345, version: '', language: 'EN' };
const searchArgs = { id: '', acronym: '', calls: [23456], objectives: ['CLIMATE_CHANGE'], statuses: ['SUBMITTED'],
  firstSubmissionFrom: '2025-01-01T00:00:00Z', firstSubmissionTo: '2025-02-01T00:00:00Z',
  lastSubmissionFrom: '', lastSubmissionTo: '' };
const call = (tool_name, args, reviewed) => execute({ ...authorized(), tool_name, tool_arguments: JSON.stringify(args) }, reviewed);

test('registry preserves the exact published five-tool metadata snapshot, without a schedule or transport', () => {
  const [server] = registry().servers;
  assert.deepEqual(server.tools.map(t => t.name), ['jems_languages_list', 'jems_auth_status', 'jems_calls_list', 'jems_project_fetch', 'jems_project_search']);
  assert.ok(server.tools.every(t => t.enabled === true && !Object.hasOwn(t, 'operator_review')));
  // Independent hash of the operator-confirmed staging tools/list snapshot, including
  // exact descriptions, every schema/enum/required field, and the contradictory annotations.
  const metadata = server.tools.map(({ enabled, ...tool }) => tool);
  assert.equal(createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
    '852090eabdc9c76c33ce562d707bbf1dba7a8368ee3df8a74bab3c8ff20f2ed0');
  assert.deepEqual(server.tools[0].inputSchema, { type: 'object', properties: {}, required: [] });
  assert.equal(server.endpoint, 'https://emr-jems-stage.rechenwerk.com/sse');
  assert.equal(run(registryWorkflow, 'Approved Registry', {}, {}, {}).servers[0].enabled, false);
  assert.throws(() => run(registryWorkflow, 'Approved Registry', {}, {}, { ...env, MCP_HUB_JEMS_REQUIRED_GROUP_IDS: '{' }));
  assert.equal(registryWorkflow.nodes.length, 2);
  assert.equal(registryWorkflow.active, true);
  assert.equal(executor.active, true);
  assert.ok(![...registryWorkflow.nodes, ...executor.nodes].some(n => /schedule|webhook/i.test(n.type)));
});

test('authorized fixture yields exact native arguments, while filtering preserves unrelated context', () => {
  for (const [name, args] of [['jems_languages_list', {}], ['jems_auth_status', {}],
    ['jems_calls_list', { status: 'PUBLISHED' }], ['jems_project_fetch', fetchArgs], ['jems_project_search', searchArgs]]) {
    assert.deepEqual(call(name, args), { tool_name: name, tool_arguments: args });
  }
  assert.deepEqual(call('jems_project_search', { ...searchArgs, calls: [], objectives: [], statuses: [] }).tool_arguments,
    { ...searchArgs, calls: [], objectives: [], statuses: [] });
  assert.equal(call('jems_project_fetch', { ...fetchArgs, projectId: Number.MAX_SAFE_INTEGER }).tool_arguments.projectId, Number.MAX_SAFE_INTEGER);
  const result = filter(authorized());
  assert.equal(result.mcp_enabled, true);
  assert.equal(result.context, 'preserved');
  assert.equal(result.mcp_capabilities.length, 5);
  assert.deepEqual(result.mcp_capabilities, registry().servers[0].tools.map(({ enabled, ...tool }) => ({ server_name: 'jems', ...tool })));
  assert.doesNotMatch(JSON.stringify(result.mcp_capabilities), /verified-subject|33333333|user_oid|user_sub/);
  const contextual = run(orchestrator, 'Filter MCP Capabilities', registry(), {
    'Webhook Orchestrator': { body: authorized() },
    'Detect Image Messages': { orchestratorPrompt: 'DEV policy', statistics_context: { count: 56475 }, image_edit_context: { prompt: 'edit' },
      documentContext: { ok: false, code: 'INLINE_BYTES_REQUIRED' }, image_intent: 'analyze', precomputed_response: 'Document failure' },
  });
  assert.equal(contextual.orchestratorPrompt, 'DEV policy');
  assert.deepEqual(contextual.statistics_context, { count: 56475 });
  assert.deepEqual(contextual.image_edit_context, { prompt: 'edit' });
  assert.deepEqual(contextual.documentContext, { ok: false, code: 'INLINE_BYTES_REQUIRED' });
  assert.equal(contextual.image_intent, 'analyze');
  assert.equal(contextual.precomputed_response, 'Document failure');
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

test('wrong tenant/groups, unknown/disabled tools and caller registry substitution are denied', () => {
  for (const override of [{ user_tid: group }, { user_authorized_groups: [] }, { user_authorized_groups: [tenant] },
    { server_name: 'other' }, { tool_name: 'jems_project_delete' }, { tool_name: 'unknown' }]) {
    assert.throws(() => execute({ ...authorized(), ...override }), /MCP_(ACCESS|TOOL)_DENIED/);
  }
  for (let i = 0; i < 5; i++) {
    const disabled = registry(); disabled.servers[0].tools[i].enabled = false;
    assert.throws(() => execute({ ...authorized(), tool_name: disabled.servers[0].tools[i].name, registry: registry() }, disabled), /MCP_TOOL_DENIED/);
  }
  const disabled = registry(); disabled.servers[0].enabled = false;
  assert.throws(() => execute(authorized(), disabled), /MCP_ACCESS_DENIED/);
});

test('invalid JSON/object/types/enums/required/unknown/unsafe integers deny without defaults; errors sanitize', () => {
  for (const args of [undefined, null, false, 0, [], {}, '{', '', 'null', '[]', 'false', { query: 'x' }, '{"query":"x"}']) {
    assert.throws(() => execute({ ...authorized(), tool_arguments: args }), /MCP_ARGUMENTS_INVALID/);
  }
  for (const args of [{}, { status: '' }, { status: 'published' }, { status: 1 }, { status: 'PUBLISHED', user_oid: 'spoof' }]) {
    assert.throws(() => call('jems_calls_list', args), /MCP_ARGUMENTS_INVALID/);
  }
  for (const args of [{ ...fetchArgs, projectId: '12345' }, { ...fetchArgs, projectId: 1.5 },
    { ...fetchArgs, projectId: Number.MAX_SAFE_INTEGER + 1 }, { ...fetchArgs, language: null }, { ...fetchArgs, auth: {} }]) {
    assert.throws(() => call('jems_project_fetch', args), /MCP_ARGUMENTS_INVALID/);
  }
  for (const args of [{ ...searchArgs, calls: ['23456'] }, { ...searchArgs, calls: [Number.MAX_SAFE_INTEGER + 1] },
    { ...searchArgs, objectives: ['ClimateChange'] }, { ...searchArgs, statuses: ['unknown'] }, { ...searchArgs, calls: {} }]) {
    assert.throws(() => call('jems_project_search', args), /MCP_ARGUMENTS_INVALID/);
  }
  for (const [name, args] of [['jems_project_fetch', fetchArgs], ['jems_project_search', searchArgs]]) {
    for (const key of Object.keys(args)) {
      const missing = { ...args }; delete missing[key];
      assert.throws(() => call(name, missing), /MCP_ARGUMENTS_INVALID/, key);
    }
  }
  for (const literal of ['9007199254740993', '9007199254740991.1', '-9007199254740991.1', '1.0000000000000001']) {
    assert.throws(() => execute({ ...authorized(), tool_name: 'jems_project_fetch',
      tool_arguments: `{"projectId":${literal},"version":"","language":"EN"}` }), /MCP_ARGUMENTS_INVALID/);
  }
  for (const failure of [{ error: { message: 'secret-password secret-header' } },
    { isError: true, content: [{ text: 'secret-password secret-header' }] }]) {
    const result = run(executor, 'Controlled MCP Result', failure);
    assert.equal(result.error.code, 'MCP_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
});

test('generic registered schema checks nested values and fails closed on unsupported assertions or formats', () => {
  const reviewed = registry();
  const schema = { type: 'object', properties: { nested: { type: 'object', properties: {
    values: { type: 'array', items: { type: 'integer', format: 'int64', enum: [7] } },
  }, required: ['values'], additionalProperties: false } }, required: ['nested'], additionalProperties: false };
  reviewed.servers[0].tools[0].inputSchema = schema;
  assert.deepEqual(call('jems_languages_list', { nested: { values: [7] } }, reviewed).tool_arguments, { nested: { values: [7] } });
  for (const args of [{}, { nested: {} }, { nested: { values: ['7'] } }, { nested: { values: [8] } },
    { nested: { values: [7], extra: true } }, { nested: { values: [7] }, extra: true }]) {
    assert.throws(() => call('jems_languages_list', args, reviewed), /MCP_ARGUMENTS_INVALID/);
  }
  schema.additionalProperties = { type: 'string' };
  assert.equal(call('jems_languages_list', { nested: { values: [] }, extra: 'allowed-by-schema' }, reviewed).tool_arguments.extra, 'allowed-by-schema');
  assert.throws(() => call('jems_languages_list', { nested: { values: [] }, extra: 1 }, reviewed), /MCP_ARGUMENTS_INVALID/);
  for (const assertion of [{ minimum: 0 }, { format: 'date-time' }, { $ref: 'https://example.invalid/schema' }, { pattern: '^x' }]) {
    const changed = registry(); Object.assign(changed.servers[0].tools[0].inputSchema, assertion);
    assert.throws(() => execute(authorized(), changed), /MCP_SCHEMA_NOT_SUPPORTED/);
  }
});

test('workflow graph binds original webhook identity outside AI and preserves DEV integrations', () => {
  const native = find(executor, 'JEMS MCP');
  assert.equal(native.type, '@n8n/n8n-nodes-langchain.mcpClient');
  assert.equal(native.typeVersion, 1.1);
  assert.equal(native.parameters.serverTransport, 'sse');
  assert.equal(native.parameters.authentication, 'multipleHeadersAuth');
  assert.equal(native.credentials.httpMultipleHeadersAuth.id, '00000000-0000-4000-8000-000000000777');
  assert.equal(native.parameters.jsonInput, '={{ $json.tool_arguments }}');
  assert.equal(native.parameters.endpointUrl, registry().servers[0].endpoint);
  assert.equal(native.parameters.tool.value, '={{ $json.tool_name }}');
  assert.equal(executor.connections['Authorize JEMS tool call'].main[0][0].node, 'JEMS MCP');
  assert.ok(executor.connections['JEMS MCP'].main.every(branch => branch[0].node === 'Controlled MCP Result'));
  assert.ok(!executor.nodes.some(n => /agent|mcpClientTool|httpRequest|dataTable/.test(n.type)));
  for (const w of [registryWorkflow, executor, orchestrator]) assert.equal(w.settings.callerPolicy, 'workflowsFromSameOwner');
  const tool = find(orchestrator, 'mcp_hub');
  assert.deepEqual(Object.keys(tool.parameters.workflowInputs.value).filter(k => !k.startsWith('user_')).sort(), ['server_name', 'tool_arguments', 'tool_name']);
  assert.match(tool.parameters.workflowInputs.value.tool_name, /Filter MCP Capabilities.*map\(t => t.name\)/);
  assert.doesNotMatch(tool.parameters.workflowInputs.value.tool_name, /jems_languages_list/);
  assert.equal(tool.parameters.workflowInputs.attemptToConvertTypes, false);
  assert.equal(tool.parameters.workflowInputs.convertFieldsToString, false);
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
});

test('pinned n8n image contains the configured native MCP class', {
  skip: !fs.existsSync('/usr/local/lib/node_modules/n8n/node_modules/.pnpm') && 'Requires the pinned n8n image, not the public Node-only suite',
}, () => {
  // Availability check only; native staging execution and real Entra are separate checks.
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
  const marker = { version: 8, topdeskSearchEnabled: false, mcpHubVersion: 2, statisticsIntegrationVersion: 1 };
  assert.deepEqual(bootstrap.getWorkflowImportPlan(entries, JSON.stringify(marker), false, {}), []);
  const legacy = { ...marker, mcpHubVersion: 1 };
  assert.deepEqual(bootstrap.getWorkflowImportPlan(entries, JSON.stringify(legacy), false, {}).flatMap(e => e.ids).sort(), ['govchat-mcp-executor-hub', 'govchat-mcp-registry-sync', 'govchat-orchestrator-litellm']);
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
