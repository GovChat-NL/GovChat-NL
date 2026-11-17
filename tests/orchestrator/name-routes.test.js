"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { createNameStore } = require("../../services/admin-overlay/admin/lib/orchestrator-name");
const { registerNameRoutes } = require("../../services/admin-overlay/admin/lib/orchestrator-name-routes");

test("HTTP admin auth, CSRF, strict schema, public whitelist and reset in isolated store", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'name-http-'));
  const store = createNameStore({ dataDir: root, publishDir: path.join(root, 'publish'), env: { N8N_ORCHESTRATOR_DISPLAY_NAME: 'Env test', N8N_ORCHESTRATOR_MASTER_PROMPT: 'PRIVATE_SENTINEL' } });
  const app = express(); app.use(express.json());
  registerNameRoutes(app, { store, isAuthenticated: req => req.headers.cookie === 'session=test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = '/api/orchestrator/name';
  const headers = { cookie: 'session=test', 'content-type': 'application/json' };
  async function request(url, options = {}, status = 200) {
    const response = await fetch(base + url, options);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  }
  await request(admin, {}, 401);
  await request(admin, { headers: { authorization: 'Bearer internal-token' } }, 401);
  await request(admin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"display_name":"attack"}' }, 401);
  for (const body of [{ display_name: '' }, { display_name: 'x'.repeat(101) }, { display_name: '<script>' }, { display_name: 'ok', prompt: 'PRIVATE_SENTINEL' }, [], { name: 'wrong' }]) await request(admin, { method: 'POST', headers, body: JSON.stringify(body) }, 400);
  await request(admin, { method: 'POST', headers: { ...headers, origin: 'https://attacker.invalid' }, body: '{"display_name":"attack"}' }, 403);
  await request(admin, { method: 'DELETE', headers: { ...headers, 'sec-fetch-site': 'cross-site' } }, 403);
  await request(admin, { method: 'DELETE', headers: { ...headers, origin: base + '/fake' } }, 403);
  await request(admin, { method: 'POST', headers: { cookie: 'session=test', 'content-type': 'text/plain' }, body: 'text' }, 415);
  const saved = await request(admin, { method: 'POST', headers: { ...headers, origin: base, 'sec-fetch-site': 'same-origin' }, body: '{"display_name":"Admin test"}' });
  assert.equal(saved.source, 'admin');
  const publicData = await request('/api/config/orchestrator/name');
  assert.deepEqual(publicData, saved);
  assert.ok(!JSON.stringify(publicData).includes('PRIVATE_SENTINEL'));
  assert.equal((await request(admin, { method: 'DELETE', headers })).display_name, 'Env test');
  assert.equal(fs.existsSync(store.filename), false);
  fs.mkdirSync(path.dirname(store.filename), { recursive: true }); fs.writeFileSync(store.filename, 'bad');
  await request(admin, { headers }, 503);
  await request('/api/config/orchestrator/name', {}, 503);
  assert.equal((await request(admin, { method: 'DELETE', headers })).source, 'environment');
});
