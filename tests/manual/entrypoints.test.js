'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Minimal isolated DOM double. No reliance on the parent editor/modal fixtures.
class Element {
  constructor(name, text = '') {
    this.nodeType = name === '#text' ? 3 : 1;
    this.name = name; this.text = text; this.childNodes = []; this.attrs = {}; this.listeners = new Map();
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(n => n !== this); this.parentNode = null; }
  get isConnected() { return this.name === 'html' || Boolean(this.parentNode?.isConnected); }
  get textContent() { return this.nodeType === 3 ? this.text : this.childNodes.map(n => n.textContent).join(''); }
  set textContent(value) { this.childNodes = []; this.appendChild(new Element('#text', String(value))); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  click() { for (const listener of this.listeners.get('click') || []) listener({ preventDefault() {} }); }
  querySelectorAll(selector) {
    const attribute = selector.slice(1, -1);
    return this.childNodes.flatMap(child => [
      ...(child.hasAttribute(attribute) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function harness(timers = { setTimeout, clearTimeout }) {
  const root = new Element('html');
  const listeners = new Map();
  const window = {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
  };
  const document = {
    documentElement: root, createElement: name => new Element(name),
    querySelectorAll: selector => root.querySelectorAll(selector), querySelector: selector => root.querySelector(selector),
  };
  const context = vm.createContext({ window, document, AbortController, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    CustomEvent: class { constructor(type) { this.type = type; } preventDefault() { this.defaultPrevented = true; } },
  });
  const source = fs.readFileSync(path.resolve(__dirname, '../../overlay/src/shared/manual-entrypoints.js'), 'utf8');
  vm.runInContext(source.replace(/export function /g, 'function ') +
    '\nthis.adapter = {syncManualEntrypoints, cleanupManualEntrypoints};', context);
  function slot(kind) { const node = root.appendChild(new Element('span')); node.setAttribute('data-govchat-manual-slot', kind); return node; }
  function error(code, text) {
    const node = root.appendChild(new Element('div'));
    node.setAttribute('data-govchat-manual-error', 'message');
    if (code) node.setAttribute('data-govchat-error-code', code);
    if (text) node.appendChild(new Element('p')).textContent = text;
    const actions = node.appendChild(new Element('span')); actions.setAttribute('data-govchat-manual-error-actions', '');
    return { node, actions };
  }
  return { root, window, document, listeners, slot, error, ...context.adapter };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const doc = passages => ({ ok: true, enabled: true, revision: 'revision-1', passages });
const article = { id: 'err-known', codes: ['NETWORK_ERROR', 'BadRequest'], messages: ['Exact network failure'], aliases: ['known-alias'] };
const general = { id: 'probleem-algemeen', codes: [], messages: [], aliases: [] };

test('repeat sync yields one desktop/mobile button, preserves native content, routes menu, cleans listeners', () => {
  const h = harness(); const desktop = h.slot('desktop'); const mobile = h.slot('mobile');
  const native = desktop.appendChild(new Element('a')); native.textContent = 'Privacy'; native.setAttribute('href', '/privacy');
  const opened = []; const config = { enabled: true, open: target => opened.push(target) };
  for (let i = 0; i < 10; i++) h.syncManualEntrypoints(config);
  assert.equal(desktop.childNodes.length, 2); assert.equal(mobile.childNodes.length, 1);
  assert.equal(mobile.childNodes[0].getAttribute('aria-label'), 'Open handleiding');
  assert.equal(mobile.childNodes[0].type, 'button');
  desktop.childNodes[1].click(); mobile.childNodes[0].click();
  h.window.dispatchEvent({ type: 'govchat:manual-open', preventDefault() {} });
  assert.equal(opened.length, 3); assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{}, {}, {}]);
  const removed = mobile.childNodes[0];
  h.cleanupManualEntrypoints(); h.cleanupManualEntrypoints(); removed.click();
  assert.equal(opened.length, 3); assert.equal(desktop.childNodes.length, 1);
  assert.equal(native.textContent, 'Privacy'); assert.equal(native.getAttribute('href'), '/privacy');
  assert.equal(h.listeners.get('govchat:manual-open').size, 0);
  assert.equal(h.root.getAttribute('data-govchat-manual-enabled'), 'false');
  h.syncManualEntrypoints(config); assert.equal(mobile.childNodes.length, 1);
  h.syncManualEntrypoints({ enabled: false }); assert.equal(mobile.childNodes.length, 0);
});

test('no document callback means no error reads; callback is lazy and bounded across route sync', async () => {
  const h = harness(); let calls = 0;
  const getDocument = async () => { calls++; return doc([article, general]); };
  const config = { enabled: true, open() {}, getDocument };
  h.syncManualEntrypoints(config); await settle(); assert.equal(calls, 0);
  const { actions } = h.error('NETWORK_ERROR');
  h.syncManualEntrypoints({ enabled: true, open() {} }); await settle(); assert.equal(actions.childNodes.length, 0);
  for (let i = 0; i < 20; i++) h.syncManualEntrypoints(config);
  await settle(); assert.equal(calls, 1); assert.equal(actions.childNodes.length, 1);
  for (let i = 0; i < 20; i++) h.syncManualEntrypoints(config);
  await settle(); assert.equal(calls, 1);
  h.cleanupManualEntrypoints();
});

test('exact codes/messages/aliases match only designated native errors; unknown/substrings/case use permitted general', async () => {
  const h = harness(); const opened = [];
  const code = h.error('NETWORK_ERROR'); const alias = h.error('known-alias'); const message = h.error(null, 'Exact network failure');
  const substring = h.error(null, 'This mentions Exact network failure but is not exact');
  const unknown = h.error('network_error'); const badRequest = h.error('BadRequest');
  const chat = h.root.appendChild(new Element('div')); chat.textContent = 'NETWORK_ERROR';
  h.syncManualEntrypoints({ enabled: true, open: target => opened.push(target), getDocument: async () => doc([article, general]) });
  await settle();
  for (const error of [code, alias, message, substring, unknown, badRequest]) error.actions.childNodes[0].click();
  assert.deepEqual(opened.map(p => p.id), ['err-known', 'err-known', 'err-known', 'probleem-algemeen', 'probleem-algemeen', 'err-known']);
  assert.ok(opened.every(p => p.revision === 'revision-1'));
  assert.equal(chat.childNodes.length, 1); assert.equal(chat.textContent, 'NETWORK_ERROR');
  h.cleanupManualEntrypoints();
});

test('hidden fallback/match never produces a button; ambiguous exact matches use general only', async () => {
  const h = harness(); const known = h.error('NETWORK_ERROR'); const unknown = h.error('unmapped');
  const open = () => {};
  h.syncManualEntrypoints({ enabled: true, open, getDocument: async () => doc([]) }); await settle();
  assert.equal(known.actions.childNodes.length, 0); assert.equal(unknown.actions.childNodes.length, 0);
  const opened = [];
  h.syncManualEntrypoints({ enabled: true, open: p => opened.push(p), getDocument: async () => doc([article, { ...article, id: 'ambiguous' }, general]) });
  await settle(); known.actions.childNodes[0].click(); assert.equal(opened[0].id, 'probleem-algemeen');
  h.syncManualEntrypoints({ enabled: true, open, getDocument: async () => doc([article]) }); await settle();
  assert.equal(known.actions.childNodes.length, 1); assert.equal(unknown.actions.childNodes.length, 0);
  h.cleanupManualEntrypoints();
});

test('changed error code/replaced DOM updates targets without duplicate buttons', async () => {
  const h = harness(); const e = h.error('NETWORK_ERROR'); const opened = [];
  const config = { enabled: true, open: p => opened.push(p), getDocument: async () => doc([article, general]) };
  h.syncManualEntrypoints(config); await settle();
  e.node.setAttribute('data-govchat-error-code', 'unmapped'); h.syncManualEntrypoints(config);
  assert.equal(e.actions.childNodes.length, 1); e.actions.childNodes[0].click(); assert.equal(opened[0].id, 'probleem-algemeen');
  const old = e.actions.childNodes[0]; e.node.remove(); const next = h.error('NETWORK_ERROR');
  h.syncManualEntrypoints(config); old.click(); next.actions.childNodes[0].click();
  assert.equal(opened.length, 2); assert.equal(opened[1].id, 'err-known');
  h.cleanupManualEntrypoints();
});

test('disable/auth context replacement aborts pending reads and ignores late responses', async () => {
  const h = harness(); const e = h.error('NETWORK_ERROR'); let resolve; let signal;
  const errors = [];
  h.syncManualEntrypoints({ enabled: true, open() {}, onError: e => errors.push(e),
    getDocument: ({ signal: s }) => { signal = s; return new Promise(r => { resolve = r; }); } });
  await settle(); h.cleanupManualEntrypoints(); assert.equal(signal.aborted, true);
  h.syncManualEntrypoints({ enabled: true, open() {}, getDocument: async () => doc([]) });
  resolve(doc([article, general])); await settle();
  assert.equal(e.actions.childNodes.length, 0); assert.equal(errors.length, 0);
  h.cleanupManualEntrypoints();
});

test('failed/preview/disabled/malformed documents are rejected once and native errors stay visible', async () => {
  for (const response of [{ ...doc([article]), preview: true }, { ...doc([article]), enabled: false }, { ...doc([article]), revision: '' }, { ...doc([article]), passages: [{ id: '<unsafe>' }] }, null]) {
    const h = harness(); const e = h.error('NETWORK_ERROR', 'Visible native failure'); let calls = 0; const errors = [];
    const config = { enabled: true, open() {}, onError: e => errors.push(e), getDocument: async () => { calls++; return response; } };
    h.syncManualEntrypoints(config); await settle(); h.syncManualEntrypoints(config); await settle();
    assert.equal(calls, 1); assert.equal(errors.length, 1); assert.equal(e.actions.childNodes.length, 0);
    assert.equal(e.node.textContent, 'Visible native failure'); h.cleanupManualEntrypoints();
  }
});

test('open failures go through the parent error handler without replacing native text', async () => {
  const h = harness(); const slot = h.slot('desktop'); const errors = [];
  h.syncManualEntrypoints({ enabled: true, open() { throw new Error('get denied'); }, onError: e => errors.push(e.message) });
  slot.childNodes[0].click();
  h.syncManualEntrypoints({ enabled: true, open: async () => { throw new Error('revision changed'); }, onError: e => errors.push(e.message) });
  slot.childNodes[0].click(); await settle();
  assert.deepEqual(errors, ['get denied', 'revision changed']); h.cleanupManualEntrypoints();
});

test('document deadline aborts a hung callback and never retries from the route loop', async () => {
  let fire; let cleared = false; let milliseconds;
  const h = harness({ setTimeout(fn, ms) { fire = fn; milliseconds = ms; return 1; }, clearTimeout() { cleared = true; } });
  const e = h.error('NETWORK_ERROR'); const errors = []; let calls = 0; let signal; let resolve;
  const config = { enabled: true, open() {}, onError: error => errors.push(error),
    getDocument: ({ signal: s }) => { signal = s; calls++; return new Promise(r => { resolve = r; }); } };
  h.syncManualEntrypoints(config); await settle(); assert.equal(milliseconds, 8000);
  fire(); await settle(); assert.equal(signal.aborted, true); assert.equal(cleared, true);
  for (let i = 0; i < 20; i++) h.syncManualEntrypoints(config);
  resolve(doc([article])); await settle();
  assert.equal(errors.length, 1); assert.equal(calls, 1); assert.equal(e.actions.childNodes.length, 0);
  h.cleanupManualEntrypoints();
});

test('adapter has no broad observer, interval, fetch, generic chat selector or content fallback', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../overlay/src/shared/manual-entrypoints.js'), 'utf8');
  assert.doesNotMatch(source, /MutationObserver|setInterval|fetch\(|innerHTML|\.markdown|manual\.json|help-content\.json/);
  assert.match(source, /values\.has\(value\)/);
});
