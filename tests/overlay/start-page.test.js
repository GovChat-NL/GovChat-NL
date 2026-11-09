'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'overlay/src/shared/html.js'), 'utf8').replace(/^export /gm, '');
const source = fs.readFileSync(path.join(root, 'overlay/src/apps/start/start.js'), 'utf8')
  .replace(/^import .*;\s*$/gm, '').replace('\nstart();', '\nglobalThis.ready = start();');

async function page({ loggedIn = true, apps = null, search = '' } = {}) {
  const redirects = [];
  const document = {
    title: 'GovChat-NL', body: { innerHTML: '' }, querySelectorAll: () => [],
    querySelector: () => null, getElementById: () => null,
  };
  const context = vm.createContext({
    document, URL, URLSearchParams,
    window: { location: { origin: 'https://govchat.example', search, replace: url => redirects.push(url) } },
    getLibreChatAuthToken: async () => { if (!loggedIn) throw new Error('Unauthenticated'); return 'synthetic-token'; },
    fetch: async url => ({ ok: true, json: async () => url === '/api/config' ? { appTitle: 'GovChat-NL' } : apps }),
    fetchHelpContent: async () => null, openHelpModal() {}, applyLibreChatTheme() {},
  });
  vm.runInContext(html + '\n' + source, context);
  await context.ready;
  return { redirects, html: document.body.innerHTML };
}

test('start page requires a LibreChat session before rendering app tiles', async () => {
  const result = await page({ loggedIn: false });
  assert.equal(result.html, '');
  assert.deepEqual(result.redirects, ['/login?redirect_to=' + encodeURIComponent('/c/new?app=start')]);
});

test('missing app configuration returns to the requested same-origin conversation', async () => {
  const result = await page({ search: '?chat=' + encodeURIComponent('/c/existing-case') });
  assert.deepEqual(result.redirects, ['/c/existing-case']);
});

test('a foreign chat URL cannot become an open redirect', async () => {
  const result = await page({ search: '?chat=' + encodeURIComponent('https://untrusted.example/c/new') });
  assert.deepEqual(result.redirects, ['/c/new']);
});

test('disabled landing and stale app IDs return to chat instead of an empty page', async () => {
  for (const landing of [{ enabled: false, apps: ['chat'] }, { enabled: true, apps: ['missing'] }]) {
    const result = await page({ apps: { landing, apps: [] } });
    assert.deepEqual(result.redirects, ['/c/new']);
    assert.equal(result.html, '');
  }
});

test('landing preserves tile order, existing chat context and escaped configuration', async () => {
  const result = await page({ search: '?chat=' + encodeURIComponent('/c/existing-case'), apps: {
    landing: { enabled: true, title: '<Welkom>', apps: ['policy', 'chat', 'modal'] },
    apps: [
      { id: 'chat', name: 'Chat', target: 'navigate', url: '/c/new' },
      { id: 'policy', name: '<Beleidskompas>', target: 'navigate', url: '/beleidskompas/' },
      { id: 'modal', name: 'Not a page', target: 'modal', url: '/modal/' },
    ],
  } });
  assert.deepEqual(result.redirects, []);
  assert.match(result.html, /&lt;Welkom&gt;/);
  assert.match(result.html, /&lt;Beleidskompas&gt;/);
  assert.match(result.html, /href="\/beleidskompas\/"/);
  assert.match(result.html, /href="\/c\/existing-case"/);
  assert.ok(result.html.indexOf('data-id="policy"') < result.html.indexOf('data-id="chat"'));
  assert.doesNotMatch(result.html, /Not a page/);
});
