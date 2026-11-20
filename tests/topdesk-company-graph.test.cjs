'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCompanyService, createCheckServer, readSettings } = require('../security/topdesk/company-service.cjs');
const { install, installPayload } = require('../security/topdesk/bridge-preload.cjs');
const { applyTopdeskSecurity } = require('../scripts/topdesk-workflow-security');
const { selectTools } = require('../scripts/n8n-orchestrator-tool-policy');
const { configureTopdeskIntegration, discoverWorkflows, getWorkflowImportPlan } = require('../n8n/bootstrap');

const tenant = '11111111-1111-4111-8111-111111111111';
const oid = '22222222-2222-4222-8222-222222222222';
const client = '33333333-3333-4333-8333-333333333333';
const caller = '44444444-4444-4444-8444-444444444444';
const group = '55555555-5555-4555-8555-555555555555';
const transportToken = 'synthetic-private-transport-credential-0123456789';
const settings = { tenant, client, company: 'Provincie Limburg', secret: 'synthetic-obo-secret',
  transportToken, ttlMs: 300000, maxHandles: 100, timeoutMs: 30 };
const identity = () => Object.freeze({ user_authorization_verified: true, user_authorization_mode: 'entra_delegated',
  user_tid: tenant, user_oid: oid, user_sub: 'synthetic-subject',
  user_token_expires_at: Math.floor(Date.now() / 1000) + 600, user_authorized_groups: [] });
const response = value => ({ ok: true, text: async () => JSON.stringify(value) });

function fixture({ company = 'Provincie Limburg', userId = oid, failure, now } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (failure === 'timeout') return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('synthetic deadline')), 60);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('synthetic timeout')); }, { once: true });
    });
    if (failure === 'error') throw new Error('must-not-leak-secret-upstream-error');
    if (failure === 'http') return { ok: false };
    if (url.includes('/oauth2/')) return response({ access_token: 'synthetic-graph-token', token_type: 'Bearer', expires_in: 600 });
    return response({ id: userId, ...(company === undefined ? {} : { companyName: company }) });
  };
  const service = createCompanyService(settings, { fetch, ...(now ? { now } : {}) });
  const user = identity(); service.trust(user);
  return { service, user, requests, handle: service.issue(user, 'synthetic-api-token') };
}

for (const company of ['Provincie Limburg', 'provincie Limburg', 'Provincie limburg', ' Provincie Limburg',
  'Provincie Limburg ', 'Provincie  Limburg', 'Provincie Limburg\n', 'Provincie Limburg\u00a0',
  'Other company', '', null, false, 42, ['Provincie Limburg'], { companyName: 'Provincie Limburg' }]) {
  test(`exact Graph company comparison: ${JSON.stringify(company)}`, async () => {
    const f = fixture({ company });
    assert.equal(await f.service.check(f.handle), company === settings.company);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].url, 'https://graph.microsoft.com/v1.0/me?$select=id,companyName');
  });
}
test('missing company, wrong Graph object and all upstream failures deny', async () => {
  for (const option of [{ company: null }, { userId: caller }, { failure: 'error' }, { failure: 'http' }, { failure: 'timeout' }]) {
    const f = fixture(option); assert.equal(await f.service.check(f.handle), false);
  }
  const f = fixture();
  const service = createCompanyService(settings, { fetch: async url => url.includes('/oauth2/') ?
    response({ access_token: 'synthetic', token_type: 'Bearer', expires_in: 100 }) : response({ id: oid }) });
  service.trust(f.user); assert.equal(await service.check(service.issue(f.user, 'synthetic')), false);
});
test('no positive cache: each check repeats OBO and Graph, company removal takes effect', async () => {
  let company = settings.company; let graphCalls = 0; let exchanges = 0;
  const service = createCompanyService(settings, { fetch: async url => {
    if (url.includes('/oauth2/')) { exchanges++; return response({ access_token: 'synthetic', token_type: 'Bearer', expires_in: 600 }); }
    graphCalls++; return response({ id: oid, companyName: company });
  } });
  const user = identity(); service.trust(user); const handle = service.issue(user, 'synthetic');
  assert.equal(await service.check(handle), true); company = 'Other';
  assert.equal(await service.check(handle), false); company = settings.company;
  assert.equal(await service.check(handle), true);
  assert.equal(graphCalls, 3); assert.equal(exchanges, 3);
});
test('untrusted JSON, absent/expired/revoked/random handles never call upstream', async () => {
  const f = fixture();
  assert.equal(f.service.issue(identity(), 'spoofed'), null);
  const expired = Object.freeze({ ...identity(), user_token_expires_at: 1 });
  f.service.trust(expired); assert.equal(f.service.issue(expired, 'synthetic'), null);
  for (const handle of [null, undefined, '', 'x'.repeat(43), { verified: true }, f.user]) assert.equal(await f.service.check(handle), false);
  f.service.revoke(f.handle); assert.equal(await f.service.check(f.handle), false);
  assert.equal(f.requests.length, 0);
});
test('expiry and revocation during Graph request deny', async () => {
  let clock = Date.now(); const f = fixture({ now: () => clock });
  clock += settings.ttlMs + 1; assert.equal(await f.service.check(f.handle), false); assert.equal(f.requests.length, 0);
  let service; let handle;
  service = createCompanyService(settings, { fetch: async url => {
    if (url.includes('/oauth2/')) return response({ access_token: 'synthetic', token_type: 'Bearer', expires_in: 60 });
    service.revoke(handle); return response({ id: oid, companyName: settings.company });
  } });
  const user = identity(); service.trust(user); handle = service.issue(user, 'synthetic');
  assert.equal(await service.check(handle), false);
});
test('strict grant and Graph parsing rejects malformed responses without error leakage', async () => {
  for (const grant of [{}, { access_token: null }, { access_token: 'x', token_type: 'Basic', expires_in: 10 },
    { access_token: 'x', token_type: 'Bearer', expires_in: 0 }]) {
    const service = createCompanyService(settings, { fetch: async () => response(grant) });
    const user = identity(); service.trust(user); assert.equal(await service.check(service.issue(user, 'synthetic')), false);
  }
  for (const text of ['not-json', 'x'.repeat(65537), 'null']) {
    const service = createCompanyService(settings, { fetch: async () => ({ ok: true, text: async () => text }) });
    const user = identity(); service.trust(user); assert.equal(await service.check(service.issue(user, 'synthetic')), false);
  }
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', use: 'sig', alg: 'RS256' };
function jwt(overrides = {}, key = privateKey, header = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = encode({ alg: 'RS256', kid: jwk.kid, ...header }) + '.' + encode({ ver: '2.0', tid: tenant,
    iss: `https://login.microsoftonline.com/${tenant}/v2.0`, aud: client, azp: caller, scp: 'access_as_user',
    oid, sub: 'synthetic-subject', exp: seconds + 600, nbf: seconds - 10, iat: seconds - 10, ...overrides });
  return input + '.' + sign('RSA-SHA256', Buffer.from(input), key).toString('base64url');
}
function nativeFixture() {
  const native = { ...require('/app/src/middleware/entraIdentity.js') };
  const f = fixture(); install(native, f.service);
  class Client extends require('/app/src/n8nClient.js') {}
  installPayload(Client, native);
  const clientInstance = new Client({ fileUploadMode: 'passthrough' });
  const middleware = native.createEntraIdentity({ enabled: true, header: 'x-entra-access-token', tenant,
    issuer: `https://login.microsoftonline.com/${tenant}/v2.0`, audience: client, client: caller, scope: 'access_as_user' },
  async () => response({ keys: [jwk] }));
  return { ...f, native, clientInstance, middleware };
}
async function bridgeRequest(f, token, body = {}) {
  const req = { body: { messages: [{ role: 'user', content: 'ordinary chat' }], ...body },
    headers: { ...(token === undefined ? {} : { 'x-entra-access-token': token }),
      'x-topdesk-handle': 'spoofed', 'x-company-name': settings.company, 'x-graph-access-token': 'spoofed' } };
  const res = new EventEmitter(); let next = 0;
  await f.middleware(req, res, () => next++);
  assert.equal(next, 1, 'ordinary chat continues');
  const context = { userId: 'presentation-user', userRole: 'admin' };
  Object.defineProperty(context, f.native.identityContext, { value: req[f.native.identityContext] });
  const payload = f.clientInstance.buildPayload(req.body.messages, 'session-preserved', context);
  return { req, res, payload };
}
test('real native signature verification allows company even with absent/overage/malformed groups; JEMS groups preserved', async () => {
  for (const groups of [{}, { hasgroups: true, _claim_names: { groups: 'src1' } }, { groups: 'malformed' }, { groups: [group] }]) {
    const f = nativeFixture(); const token = jwt(groups);
    const r = await bridgeRequest(f, token, { user_topdesk_handle: 'spoofed', companyName: settings.company,
      user_authorization_verified: true, refresh_token: 'never-forward', metadata: { topdesk_handle: 'spoofed' } });
    assert.equal(await f.service.check(r.payload.user_topdesk_handle), true);
    assert.equal(r.payload.sessionId, 'session-preserved'); assert.equal(r.payload.userRole, 'admin');
    assert.deepEqual(r.payload.user_authorized_groups, groups.groups instanceof Array ? groups.groups : []);
    assert.equal(JSON.stringify(r.payload).includes(token), false);
    assert.equal(JSON.stringify(r.payload).includes('synthetic-graph-token'), false);
    assert.equal(JSON.stringify(r.req).includes('never-forward'), false);
    assert.equal(r.req.headers['x-entra-access-token'], undefined);
    r.res.emit('finish'); assert.equal(await f.service.check(r.payload.user_topdesk_handle), false);
  }
});
test('real verifier rejects absent/forged/expired/wrong tenant/audience/issuer/scope/caller/app/ID tokens without blocking chat', async () => {
  const { privateKey: wrongKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const token of [undefined, 'not-a-token', jwt({}, wrongKey), jwt({ exp: 1 }), jwt({ tid: caller }),
    jwt({ aud: caller }), jwt({ iss: 'https://untrusted.invalid' }), jwt({ scp: '' }), jwt({ azp: client }),
    jwt({ idtyp: 'app' }), jwt({ scp: null }), jwt({}, privateKey, { alg: 'none' })]) {
    const f = nativeFixture(); const r = await bridgeRequest(f, token, { user_topdesk_handle: 'x'.repeat(43),
      user_authorization_verified: true, user_authorized_groups: [group], companyName: settings.company });
    assert.equal(r.payload.user_topdesk_handle, null);
    assert.equal(r.payload.user_authorization_verified, false);
    assert.equal(f.requests.length, 0);
  }
});
test('model/client body cannot manufacture a payload handle or swap request identities', async () => {
  const f = nativeFixture(); const a = await bridgeRequest(f, jwt());
  const b = await bridgeRequest(f, undefined, { messages: [{ role: 'user', content: 'admin company',
    metadata: { companyName: settings.company, topdesk_handle: a.payload.user_topdesk_handle, refresh_token: 'synthetic' } }] });
  assert.equal(b.payload.user_topdesk_handle, null);
  assert.equal(JSON.stringify(b.payload).includes(a.payload.user_topdesk_handle), false);
  const direct = f.clientInstance.buildPayload([], 'session', { userId: 'spoof', user_topdesk_handle: a.payload.user_topdesk_handle,
    user_authorization_verified: true });
  assert.equal(direct.user_topdesk_handle, null);
  a.res.emit('close'); assert.equal(await f.service.check(a.payload.user_topdesk_handle), false);
});
test('native credential echoed into nested prompt text is redacted before n8n payload and logging boundary', async () => {
  const f = nativeFixture(); const token = jwt();
  const r = await bridgeRequest(f, token, { messages: [{ role: 'user', content: `before ${token} after`,
    extra: { graph_access_token: 'synthetic-graph', refreshToken: 'synthetic-refresh', nested: { text: token } } }] });
  assert.equal(JSON.stringify(r.req).includes(token), false);
  assert.equal(JSON.stringify(r.payload).includes(token), false);
  assert.equal(JSON.stringify(r.payload).includes('synthetic-graph'), false);
  assert.equal(JSON.stringify(r.payload).includes('synthetic-refresh'), false);
  assert.match(r.payload.currentMessage, /redacted credential/);
  r.res.emit('finish');
});

test('private endpoint denies direct misuse/spoofed headers/body and returns boolean only', async () => {
  const f = fixture(); const server = createCheckServer(f.service, transportToken);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/internal/topdesk/check`;
  try {
    for (const [body, auth] of [[{ handle: f.handle, purpose: 'retrieval' }, undefined],
      [{ handle: 'x'.repeat(43), purpose: 'retrieval' }, transportToken],
      [{ handle: f.handle, purpose: 'retrieval', companyName: settings.company }, transportToken],
      [{ user_authorization_verified: true, user_oid: oid }, transportToken],
      [{ handle: f.handle, purpose: 'mint' }, transportToken]]) {
      const result = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'X-Company-Name': settings.company }, body: JSON.stringify(body) });
      assert.deepEqual(await result.json(), { allowed: false });
    }
    assert.equal(f.requests.length, 0);
    const good = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${transportToken}` },
      body: JSON.stringify({ handle: f.handle, purpose: 'retrieval' }) });
    assert.deepEqual(await good.json(), { allowed: true }); assert.equal(good.headers.get('cache-control'), 'no-store');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

const orchestrator = JSON.parse(fs.readFileSync('agents/n8n/workflows/algemeen/orchestrator-litellm.json'));
const search = JSON.parse(fs.readFileSync('agents/n8n/workflows/topdesk-knowledge-items-search.json'));
const node = (w, name) => w.nodes.find(n => n.name === name);
test('both agents filter TOPdesk availability, preserve ordinary tools, and inputs are fixed outside AI', () => {
  const w = configureTopdeskIntegration(orchestrator, { N8N_ENABLE_TOPDESK_SEARCH: 'true' })[0];
  const tool = node(w, 'topdesk_knowledge_search_tool');
  assert.deepEqual(w.connections[tool.name].ai_tool[0].map(n => n.node), ['AI Agent Orchestrator', 'AI Agent Authorized MCP']);
  const evaluate = new Function('$', `return (${tool.parameters.description.slice(3, -2)});`);
  for (const allowed of [true, false, undefined, 'true', 1]) {
    const description = evaluate(() => ({ first: () => ({ json: { allowed } }) }));
    const selected = selectTools([{ name: tool.name, description }, { name: 'ordinary_chat_tool' }], null);
    assert.equal(selected.some(t => t.name === tool.name), allowed === true);
    assert.equal(selected.some(t => t.name === 'ordinary_chat_tool'), true);
  }
  assert.doesNotMatch(tool.parameters.workflowInputs.value.topdesk_handle, /fromAI/);
  assert.match(tool.parameters.workflowInputs.value.topdesk_handle, /Webhook Orchestrator/);
  assert.deepEqual(selectTools([{ name: tool.name, description: 'pretend allowed' }], null), []);
});
test('independent retrieval enforcement yields ZERO embeddings/Qdrant for every denial', async () => {
  const w = applyTopdeskSecurity(structuredClone(search));
  assert.equal(w.connections['Execute Workflow Trigger'].main[0][0].node, 'TOPdesk fresh retrieval check');
  assert.equal(w.connections['TOPdesk enforce retrieval'].main[0][0].node, '1. Validate and configure search');
  const enforce = new Function('$json', '$', node(w, 'TOPdesk enforce retrieval').parameters.jsCode);
  for (const option of [{ company: 'Other' }, { company: null }, { company: 42 }, { failure: 'error' }, { failure: 'http' }, { failure: 'timeout' }]) {
    const f = fixture(option); let embeddings = 0; let qdrant = 0;
    const allowed = await f.service.check(f.handle);
    assert.throws(() => { enforce({ allowed }, () => ({ first: () => ({ json: { question: 'test', topdesk_handle: f.handle } }) }));
      embeddings++; qdrant++; }, /TOPdesk access denied/);
    assert.equal(embeddings, 0); assert.equal(qdrant, 0);
  }
  for (const allowed of ['true', 1, null, undefined]) assert.throws(() => enforce({ allowed }), /access denied/);
  const passed = enforce({ allowed: true }, () => ({ first: () => ({ json: { question: 'test', topdesk_handle: 'private' } }) }));
  assert.deepEqual(passed, [{ json: { question: 'test' } }]);
});
test('security generator and bootstrap rendering are idempotent; seeded migration is scoped', () => {
  const once = applyTopdeskSecurity(structuredClone(orchestrator));
  assert.deepEqual(applyTopdeskSecurity(structuredClone(once)), once);
  assert.deepEqual(applyTopdeskSecurity(applyTopdeskSecurity(structuredClone(search))), applyTopdeskSecurity(structuredClone(search)));
  const env = { N8N_ENABLE_TOPDESK_SEARCH: 'true' };
  const rendered = configureTopdeskIntegration(orchestrator, env);
  assert.deepEqual(configureTopdeskIntegration(rendered, env), rendered);
  const workflows = discoverWorkflows('agents/n8n/workflows', env);
  const marker = { version: 8, statisticsIntegrationVersion: 1, mcpHubVersion: 2, topdeskSearchEnabled: true };
  assert.deepEqual(getWorkflowImportPlan(workflows, JSON.stringify(marker), false, env).map(w => w.file).sort(),
    ['algemeen/orchestrator-litellm.json', 'topdesk-knowledge-items-search.json']);
  marker.topdeskCompanySecurityVersion = 1;
  assert.deepEqual(getWorkflowImportPlan(workflows, JSON.stringify(marker), false, env), []);
  assert.equal(search.settings.saveDataErrorExecution, 'none');
});
test('configuration fails closed without native verifier, secret or distinct backend credentials', () => {
  assert.throws(() => readSettings({}), /strict Entra/);
  assert.throws(() => readSettings({ TOPDESK_ALLOWED_COMPANY_NAME: '' }), /ALLOWED_COMPANY/);
  assert.throws(() => readSettings({ ENTRA_JWT_ENABLED: 'true', ENTRA_TENANT_ID: tenant,
    ENTRA_EXPECTED_AUDIENCE: client, N8N_WEBHOOK_BEARER_TOKEN: transportToken, BEARER_TOKEN: transportToken }), /distinct/);
});
test('private configuration preserves exact configurable company and validates secret file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'topdesk-settings-'));
  const filename = path.join(directory, 'synthetic-secret');
  const env = { ENTRA_JWT_ENABLED: 'true', ENTRA_TENANT_ID: tenant, ENTRA_EXPECTED_AUDIENCE: client,
    N8N_WEBHOOK_BEARER_TOKEN: transportToken, BEARER_TOKEN: 'synthetic-distinct-bridge-credential',
    TOPDESK_OBO_CLIENT_SECRET_FILE: filename, TOPDESK_ALLOWED_COMPANY_NAME: ' Exact custom company ' };
  try {
    fs.writeFileSync(filename, 'synthetic-private-secret\n', { mode: 0o600 });
    const configured = readSettings(env);
    assert.equal(configured.company, ' Exact custom company '); assert.equal(configured.secret, 'synthetic-private-secret');
    assert.equal(readSettings({ ...env, TOPDESK_ALLOWED_COMPANY_NAME: undefined }).company, settings.company);
    for (const company of [' Exact custom company ', 'Exact custom company']) {
      const service = createCompanyService(configured, { fetch: async url => url.includes('/oauth2/') ?
        response({ access_token: 'synthetic', token_type: 'Bearer', expires_in: 60 }) : response({ id: oid, companyName: company }) });
      const user = identity(); service.trust(user);
      assert.equal(await service.check(service.issue(user, 'synthetic')), company === configured.company);
    }
    for (const secret of ['', 'x'.repeat(8193)]) {
      fs.writeFileSync(filename, secret); assert.throws(() => readSettings(env), /private OBO/);
    }
    for (const invalid of [{ ENTRA_TENANT_ID: '' }, { ENTRA_EXPECTED_AUDIENCE: '' }, { N8N_WEBHOOK_BEARER_TOKEN: 'short' },
      { TOPDESK_ALLOWED_COMPANY_NAME: 'x'.repeat(257) }, { TOPDESK_ALLOWED_COMPANY_NAME: 42 }]) {
      assert.throws(() => readSettings({ ...env, ...invalid }));
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('handle storage is bounded, prunes expired entries and does not grant via changed JSON', async () => {
  let clock = Date.now();
  const service = createCompanyService({ ...settings, maxHandles: 1 }, { now: () => clock, fetch: async () => { throw new Error('unexpected Graph'); } });
  const user = identity(); service.trust(user);
  const first = service.issue(user, 'synthetic'); assert.equal(typeof first, 'string');
  assert.equal(service.issue(user, 'synthetic'), null);
  clock += settings.ttlMs + 1;
  assert.equal(typeof service.issue(user, 'synthetic'), 'string');
  assert.equal(await service.check(first), false);
  for (const changed of [{ ...user, user_authorization_verified: false }, { ...user, user_authorization_mode: 'app' },
    { ...user, user_tid: caller }, { ...user, user_oid: null }, { ...user, user_token_expires_at: '9999999999' }]) {
    service.trust(changed); assert.equal(service.issue(changed, 'synthetic'), null);
  }
});
test('private endpoint rejects malformed, oversized and extra identity fields without Graph', async () => {
  const f = fixture(); const server = createCheckServer(f.service, transportToken);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [route, method, body] of [['/internal/topdesk/check', 'GET', undefined], ['/mint', 'POST', '{}'],
      ['/internal/topdesk/check', 'POST', 'not-json'], ['/internal/topdesk/check', 'POST', 'null'],
      ['/internal/topdesk/check', 'POST', 'x'.repeat(2049)],
      ['/internal/topdesk/check', 'POST', JSON.stringify({ handle: f.handle, purpose: 'availability', user_authorization_verified: true })]]) {
      const r = await fetch(origin + route, { method, headers: { Authorization: `Bearer ${transportToken}` }, body });
      assert.deepEqual(await r.json(), { allowed: false });
    }
    assert.equal(f.requests.length, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
