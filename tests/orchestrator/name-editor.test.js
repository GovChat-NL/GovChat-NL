"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
test("name editor loads separately, renders literal text, saves and resets without prompt mutation", async () => {
  const html = fs.readFileSync(path.join(__dirname, '../../services/admin-overlay/admin/views/orchestrator-editor.html'), 'utf8');
  const elements = new Map();
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], { value: '', disabled: true, textContent: '', hidden: true });
  elements.get('orchestrator-seed').textContent = '{}';
  const calls = [];
  const context = vm.createContext({ document: { getElementById: id => elements.get(id), createElement: () => ({ remove() {} }), body: { appendChild() {} } }, confirm: () => true, setTimeout: () => {}, fetch: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/name') ? { display_name: 'Naam & "tekst"', source: options.method === 'POST' ? 'admin' : 'environment' } : { prompt: 'PRIVATE_SENTINEL', source: 'environment' } };
  } });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
  assert.ok(!scripts.includes('innerHTML'));
  vm.runInContext(scripts, context);
  await vm.runInContext('loadName()', context);
  assert.equal(elements.get('displayName').value, 'Naam & "tekst"');
  assert.match(elements.get('nameStatus').textContent, /omgevingsvariabele/);
  await vm.runInContext("changeName('POST')", context);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { display_name: 'Naam & "tekst"' });
  assert.match(elements.get('nameStatus').textContent, /beheerdersoverride/);
  await vm.runInContext("changeName('DELETE')", context);
  assert.equal(calls.at(-1).options.body, undefined);
  assert.equal(calls.at(-1).options.method, 'DELETE');
  assert.equal(elements.get('masterPrompt').value, 'PRIVATE_SENTINEL');
  elements.get('displayName').value = '<img onerror=x>';
  const count = calls.length;
  await vm.runInContext("changeName('POST')", context);
  assert.equal(calls.length, count);
  for (const call of calls.filter(call => call.url.endsWith('/name'))) {
    assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.credentials, 'same-origin');
  }
});
