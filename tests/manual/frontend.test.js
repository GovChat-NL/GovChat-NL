'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;

function moduleFixture(file, names, extra = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../overlay/src/shared', file), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export (async )?function /g, '$1function ').replace(/export class /g, 'class ');
  const context = vm.createContext({ crypto, TextEncoder, URLSearchParams, AbortController, setTimeout, clearTimeout, ...extra });
  vm.runInContext(source + `\nthis.exports = {${names.join(',')}}`, context);
  return context.exports;
}
function storage() {
  const map = new Map();
  return { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key), map };
}

test('citation router accepts only exact compiler shapes and explicit TOC fallback', () => {
  const { parseManualHref: parse } = moduleFixture('manual-client.js', ['parseManualHref']);
  assert.equal(parse('/c/new?manual=exact_ID-1&manualRevision=rev_123').id, 'exact_ID-1');
  assert.equal(parse('/c/new?manual=toc').toc, true);
  for (const href of [null, 'manual:exact', 'https://example.org/c/new?manual=id&manualRevision=rev', '//example.org/c/new?manual=id&manualRevision=rev', '/c/new?manual=id', '/c/new?manual=id&manualRevision=', '/c/new?manualRevision=rev&manual=id', '/c/new?manual=id&manualRevision=rev#quote', '/c/new?manual=id&manualRevision=rev&other=1', '/c/new?manual=id&manualRevision=rev&manual=id', '/c/new?manual=%69d&manualRevision=rev', '/c/new/?manual=id&manualRevision=rev', '/c/new?manual=../id&manualRevision=rev', '/c/new?manual=id&manualRevision=rev%20', 'Read /c/new?manual=id&manualRevision=rev']) assert.equal(parse(href), null, String(href));
});

test('public metadata uses no auth and content uses normal bearer client with no-store', async () => {
  const requests = [];
  const response = { ok: true, json: async () => ({ ok: true, revision: 'rev' }) };
  const mod = moduleFixture('manual-client.js', ['manualRequest'], {
    fetch: async (url, options) => { requests.push({ public: true, url, options }); return response; },
    librechatFetch: async (url, options) => { requests.push({ public: false, url, options }); return response; },
  });
  await mod.manualRequest('config'); await mod.manualRequest('get', { id: 'passage', revision: 'rev' });
  assert.equal(requests[0].public, true); assert.equal(requests[1].public, false);
  assert.equal(requests[1].url, '/govchat-api/manual/get?id=passage&revision=rev');
  assert.equal(requests[1].options.cache, 'no-store'); assert.ok(requests[1].options.signal);
});

test('admin previews and error responses are never accepted as user content', async () => {
  let body = { ok: true, revision: 'preview', preview: true };
  const mod = moduleFixture('manual-client.js', ['manualRequest'], { librechatFetch: async () => ({ ok: true, status: 200, json: async () => body }) });
  await assert.rejects(mod.manualRequest('document'), error => error.code === 'INVALID_RESPONSE');
  body = { ok: false, error: { code: 'REVISION_CHANGED', message: 'Changed' } };
  await assert.rejects(mod.manualRequest('get'), error => error.code === 'REVISION_CHANGED');
});

test('bootstrap awaits standard auth before verifying current user and app config', async () => {
  const calls = [];
  const mod = moduleFixture('manual-client.js', ['manualAuthBootstrap'], {
    getLibreChatAuthToken: async force => { calls.push(['token', force]); },
    librechatFetch: async url => { calls.push(url); return { ok: true, json: async () => url === '/api/user' ? { id: 'trusted' } : { interface: {} } }; },
  });
  assert.equal(await mod.manualAuthBootstrap(), 'trusted'); assert.equal(calls[0][0], 'token'); assert.equal(calls[0][1], true);
  assert.ok(calls.includes('/api/user')); assert.ok(calls.includes('/api/config'));
});

test('opaque installation/user scopes differ and do not contain identity', async () => {
  const mod = moduleFixture('manual-preferences.js', ['preferenceScope']);
  const scope = await mod.preferenceScope('private-user', 'https://govchat.example');
  assert.match(scope, /^gc_manual_v1_[a-f0-9]{64}$/); assert.ok(!scope.includes('private-user'));
  assert.notEqual(scope, await mod.preferenceScope('another', 'https://govchat.example'));
  assert.notEqual(scope, await mod.preferenceScope('private-user', 'https://other.example'));
  assert.equal(await mod.preferenceScope('', 'https://govchat.example'), null);
});

test('all auto policies are revision-aware with shared full-route session suppression', () => {
  const { createManualPreferences: create } = moduleFixture('manual-preferences.js', ['createManualPreferences']);
  const local = storage(), session = storage(); const initial = create('scope', local, session);
  assert.equal(initial.shouldOpen('never', 'r1'), false);
  for (const policy of ['first-use', 'new-revision', 'every-session']) assert.equal(initial.shouldOpen(policy, 'r1'), true);
  initial.opened('r1');
  const nextPage = create('scope', local, session);
  for (const policy of ['first-use', 'new-revision', 'every-session']) assert.equal(nextPage.shouldOpen(policy, 'r2'), false);
  const newSession = create('scope', local, storage());
  assert.equal(newSession.shouldOpen('first-use', 'r2'), false);
  assert.equal(newSession.shouldOpen('new-revision', 'r1'), false);
  assert.equal(newSession.shouldOpen('new-revision', 'r2'), true);
  assert.equal(newSession.shouldOpen('every-session', 'r1'), true);
  newSession.suppress(true); assert.equal(newSession.shouldOpen('every-session', 'r1'), false);
  newSession.restore(); assert.equal(newSession.shouldOpen('every-session', 'r1'), true);
  newSession.cancelAuto(); assert.equal(newSession.shouldOpen('every-session', 'r1'), false);
  const saved = JSON.parse(local.getItem('scope')); assert.deepEqual(Object.keys(saved).sort(), ['optOut', 'revision', 'seen']);
});

test('denied, absent, corrupt or partially writable storage never loops auto', () => {
  const { createManualPreferences: create } = moduleFixture('manual-preferences.js', ['createManualPreferences']);
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const broken = storage(); broken.setItem('scope', '{not-json');
  for (const [local, session] of [[denied, storage()], [storage(), denied], [undefined, undefined], [broken, storage()]]) {
    for (let i = 0; i < 3; i++) { const prefs = create('scope', local, session); assert.equal(prefs.available, false); assert.equal(prefs.shouldOpen('every-session', 'revision'), false); prefs.opened('revision'); prefs.suppress(true); prefs.restore(); }
  }
});
