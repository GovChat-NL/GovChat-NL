'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { generateKeyPairSync, sign } = require('node:crypto');

test('real native HTTP bridge + preload + private checks: fresh Graph, ordinary chat, streaming, no token propagation', { timeout: 20000 }, async () => {
  const tenant = '11111111-1111-4111-8111-111111111111';
  const oid = '22222222-2222-4222-8222-222222222222';
  const client = '33333333-3333-4333-8333-333333333333';
  const caller = '44444444-4444-4444-8444-444444444444';
  const bearer = 'synthetic-bridge-credential-0123456789';
  const transport = 'synthetic-n8n-transport-credential-0123456789';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'runtime-fixture', use: 'sig', alg: 'RS256' };
  const jwt = (expired = false) => {
    const now = Math.floor(Date.now() / 1000); const encode = v => Buffer.from(JSON.stringify(v)).toString('base64url');
    const input = encode({ alg: 'RS256', kid: jwk.kid }) + '.' + encode({ ver: '2.0', tid: tenant, oid,
      iss: `https://login.microsoftonline.com/${tenant}/v2.0`, aud: client, azp: caller, scp: 'access_as_user',
      sub: 'runtime-user', iat: now - 20, nbf: now - 20, exp: expired ? now - 10 : now + 600,
      hasgroups: true, _claim_names: { groups: 'overage' } });
    return input + '.' + sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  };
  const token = jwt(); const expired = jwt(true);
  let graphCalls = 0; let exchanges = 0; let company = 'Provincie Limburg';
  const payloads = []; const seenAuth = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
      if (req.url === '/obo') {
        exchanges++; let body = ''; for await (const chunk of req) body += chunk;
        assert.equal(new URLSearchParams(body).get('assertion'), token);
        assert.equal(new URLSearchParams(body).get('scope'), 'https://graph.microsoft.com/User.Read');
        return res.end(JSON.stringify({ access_token: 'synthetic-runtime-graph-token', token_type: 'Bearer', expires_in: 600 }));
      }
      if (req.url === '/graph') {
        graphCalls++; seenAuth.push(req.headers.authorization);
        return res.end(JSON.stringify({ id: oid, companyName: company }));
      }
      let body = ''; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body); payloads.push(payload);
      assert.equal(req.headers.authorization, `Bearer ${transport}`);
      const check = async purpose => (await (await fetch('http://127.0.0.1:3334/internal/topdesk/check', {
        method: 'POST', headers: { Authorization: `Bearer ${transport}` },
        body: JSON.stringify({ handle: payload.user_topdesk_handle, purpose }),
      })).json()).allowed;
      company = 'Provincie Limburg';
      const available = await check('availability');
      if (payload.currentMessage === 'change after availability') company = 'Other company';
      const retrieval = await check('retrieval');
      const text = `ordinary chat; available=${available}; retrieval=${retrieval}; embeddings=${retrieval ? 1 : 0}; qdrant=${retrieval ? 1 : 0}`;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ type: 'item', content: text }));
    } catch {
      res.statusCode = 500; res.end('synthetic runtime assertion failed');
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'topdesk-runtime-'));
  const secret = path.join(directory, 'obo-secret'); fs.writeFileSync(secret, 'synthetic-runtime-secret', { mode: 0o600 });
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const script = `const originalFetch=globalThis.fetch;globalThis.fetch=(url,options)=>{
    const value=String(url);let target=value;
    if(value.includes('/discovery/v2.0/keys')) target=${JSON.stringify(origin + '/jwks')};
    else if(value.startsWith('https://login.microsoftonline.com/')) target=${JSON.stringify(origin + '/obo')};
    else if(value==='https://graph.microsoft.com/v1.0/me?$select=id,companyName') target=${JSON.stringify(origin + '/graph')};
    else if(!value.startsWith('http://127.0.0.1:')) throw new Error('No external network allowed');
    return originalFetch(target,options);};
    require(${JSON.stringify(path.resolve('scripts/n8n-bridge-tool-events.js'))});
    require(${JSON.stringify(path.resolve('security/topdesk/bridge-preload.cjs'))});require('/app/src/server.js');`;
  const child = spawn(process.execPath, ['-e', script], { cwd: '/app', env: {
    PATH: process.env.PATH, PORT: '3333', BEARER_TOKEN: bearer, N8N_WEBHOOK_BEARER_TOKEN: transport,
    ENTRA_JWT_ENABLED: 'true', ENTRA_TENANT_ID: tenant, ENTRA_EXPECTED_AUDIENCE: client,
    ENTRA_ALLOWED_CLIENT_ID: caller, ENTRA_REQUIRED_SCOPE: 'access_as_user',
    TOPDESK_COMPANY_GRAPH_ENABLED: 'true', TOPDESK_OBO_CLIENT_SECRET_FILE: secret,
    GOVCHAT_AUTHORITATIVE_TOOL_EVENTS: 'true',
    MODEL_LOADER_TYPE: 'static', STATIC_MODELS: JSON.stringify({ 'runtime-chat': origin + '/n8n' }),
    LOG_REQUESTS: 'true', USER_ROLE_HEADERS: 'X-User-Role',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  const exit = new Promise(resolve => child.once('exit', resolve));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error('Synthetic bridge failed startup');
      try { ready = (await fetch('http://127.0.0.1:3333/health')).ok; } catch {}
      if (ready) break; await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'native bridge starts with verified preload contract');
    for (const [accessToken, content, stream, allowed] of [[token, 'normal allowed', false, true],
      [token, 'change after availability', false, false], [undefined, 'normal absent', false, false],
      [expired, 'normal expired', false, false], [token, 'normal streaming', true, true]]) {
      const before = graphCalls;
      const r = await fetch('http://127.0.0.1:3333/v1/chat/completions' + (accessToken ? '?echo=' + encodeURIComponent(accessToken) : ''), { method: 'POST', headers: {
        Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'X-User-Role': 'admin',
        'X-User-Name': accessToken || 'ordinary identity',
        ...(accessToken ? { 'X-Entra-Access-Token': accessToken } : {}), 'X-Company-Name': 'Provincie Limburg',
      }, body: JSON.stringify({ model: 'runtime-chat', stream, user_topdesk_handle: 'spoofed',
        user_authorization_verified: true, companyName: 'Provincie Limburg', messages: [{ role: 'user', content }] }) });
      assert.equal(r.status, 200, 'ordinary chat remains operational');
      const result = stream ? await r.text() : (await r.json()).choices[0].message.content;
      assert.match(result, /ordinary chat/);
      assert.match(result, new RegExp(`retrieval=${allowed}`));
      assert.match(result, new RegExp(`embeddings=${allowed ? 1 : 0}`));
      assert.match(result, new RegExp(`qdrant=${allowed ? 1 : 0}`));
      assert.equal(result.includes(token), false); assert.equal(result.includes('synthetic-runtime-graph-token'), false);
      assert.equal(graphCalls - before, accessToken === token ? 2 : 0);
      const payload = payloads.at(-1);
      assert.equal(payload.userRole, 'admin');
      assert.deepEqual(payload.user_authorized_groups, []);
      assert.equal(JSON.stringify(payload).includes(token), false);
      assert.equal(JSON.stringify(payload).includes(expired), false);
      assert.equal(JSON.stringify(payload).includes('synthetic-runtime-graph-token'), false);
      assert.equal(JSON.stringify(payload).includes('synthetic-runtime-secret'), false);
      if (payload.user_topdesk_handle) {
        const check = await fetch('http://127.0.0.1:3334/internal/topdesk/check', { method: 'POST',
          headers: { Authorization: `Bearer ${transport}` },
          body: JSON.stringify({ handle: payload.user_topdesk_handle, purpose: 'retrieval' }) });
        assert.deepEqual(await check.json(), { allowed: false }, 'response closure revokes capability');
      }
    }
    assert.equal(graphCalls, 6); assert.equal(exchanges, 6);
    assert.equal(seenAuth.every(auth => auth === 'Bearer synthetic-runtime-graph-token'), true);
    const unauthorized = await fetch('http://127.0.0.1:3333/v1/chat/completions', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'runtime-chat', messages: [] }) });
    assert.equal(unauthorized.status, 401, 'existing bridge transport boundary preserved');
    assert.equal(logs.includes(token), false); assert.equal(logs.includes(expired), false);
    assert.equal(logs.includes('synthetic-runtime-graph-token'), false);
    assert.equal(logs.includes('synthetic-runtime-secret'), false);
  } finally {
    child.kill('SIGTERM'); await exit;
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
