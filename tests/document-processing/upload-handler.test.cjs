'use strict';
// Executes the installed upload handler. Only storage/DB, unrelated providers,
// and (unless LIVE_UPLOAD_HANDLER=true) the extraction transport are test doubles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const installed = createRequire('/app/package.json');
const api = installed('@librechat/api');
const lc = installed('librechat-data-provider');
const guard = require('../../scripts/librechat-tika-upload-preload');
const routes = require('../../services/document-extractor/routes.json');
const source = fs.readFileSync('/app/api/server/services/Files/process.js', 'utf8');
const readable = 'Synthetische financiële verantwoording 2026, bedrag 12345,67';
const garbage = '\ufffd'.repeat(100);

function harness({ patch = true, extraction = async () => ({ text: readable }), failDB = false } = {}) {
  const records = [], counters = { extraction: 0, fallback: 0, storage: 0 };
  const config = {
    endpoints: { custom: [{ name: 'govchat-orchestrator' }] },
    fileConfig: {
      endpoints: { 'govchat-orchestrator': { legacyFileUploadUX: false,
        defaultLLMDeliveryPath: { overrides: Object.fromEntries(
          Object.values(routes).flatMap(route => route.mimes).map(mime => [mime, 'text'])) } } },
      text: { supportedMimeTypes: ['^text/plain$', ...Object.values(routes).flatMap(route =>
        route.mimes.map(mime => '^' + mime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'))] },
    },
  };
  const mod = { exports: {} };
  const logger = { error() {}, warn() {}, info() {}, debug() {} };
  const dependencies = {
    'librechat-data-provider': lc,
    '@librechat/data-schemas': { logger },
    '@librechat/api': { ...api, parseText: async params => {
      counters.extraction++; return extraction(params);
    } },
    './retention': { getAgentFileRetentionExpiry: async () => ({}) },
    './strategies': { getStrategyFunctions: source => ({ handleFileUpload: async ({ file }) => {
      if (source === lc.FileSources.document_parser) {
        counters.fallback++; return { text: garbage };
      }
      assert.equal(source, lc.FileSources.local);
      counters.storage++;
      return { bytes: file.size, filepath: '/synthetic/' + file.originalname,
        filename: file.originalname };
    } }) },
    '~/server/utils/getFileStrategy': { getFileStrategy: () => lc.FileSources.local },
    '~/server/services/Config': { checkCapability: async () => true },
    '~/models': { createFile: async record => {
      if (failDB) throw new Error('synthetic persistence failure');
      records.push(structuredClone(record)); return record;
    } },
  };
  const mockRequire = name => {
    if (name in dependencies) return dependencies[name];
    if (name.startsWith('~/') || name === './Audio/STTService') return {};
    if (path.isAbsolute(name)) return require(name);
    return installed(name);
  };
  new Function('require', 'module', 'exports', patch ? guard.patchUploadSource(source) : source)(
    mockRequire, mod, mod.exports);
  return { config, records, counters, async upload(file, id = '00000000-0000-4000-8000-000000000001') {
    const req = { user: { id: 'synthetic-owner' }, config,
      body: { endpoint: 'govchat-orchestrator' }, file };
    const res = { status() { return this; }, json() {}, send() {} };
    await mod.exports.processAgentFileUpload({ req, res,
      metadata: { endpoint: 'govchat-orchestrator', message_file: 'true', file_id: id } });
  } };
}

const pdf = { originalname: 'synthetic.pdf', path: '/unused', mimetype: 'application/pdf', size: 100 };

test('failing-before: stock upload handler persists unreadable fallback after extractor failure', async () => {
  const h = harness({ patch: false, extraction: async () => { throw new Error('synthetic outage'); } });
  await h.upload(pdf);
  assert.equal(h.records[0].text, garbage);
  assert.equal(h.counters.fallback, 1);
});

test('passing-after: extractor errors do not invoke fallback or persist a document', async () => {
  for (const status of [413, 415, 422, 429, 503]) {
    const h = harness({ extraction: async () => { const e = new Error('synthetic extraction failure'); e.status = status; throw e; } });
    await assert.rejects(h.upload(pdf), { code: 'TIKA_EXTRACTION_FAILED' });
    assert.deepEqual(h.records, []);
    assert.deepEqual(h.counters, { extraction: 1, fallback: 0, storage: 0 });
  }
});

test('success persists owner-scoped text once and reuses it as model context for multiple turns', async () => {
  const h = harness();
  await h.upload(pdf);
  await h.upload({ ...pdf, originalname: 'second.pdf' }, '00000000-0000-4000-8000-000000000002');
  assert.equal(h.records.length, 2);
  for (const record of h.records) {
    assert.equal(record.user, 'synthetic-owner');
    assert.equal(record.llmDeliveryPath, 'text');
    assert.equal(record.text, readable);
    assert.notEqual(record.embedded, true);
  }
  for (let turn = 0; turn < 2; turn++) {
    const context = await api.extractFileContext({ attachments: h.records,
      req: { config: h.config }, tokenCountFn: text => text.length });
    assert.ok(context.includes(readable));
    assert.ok(context.includes('synthetic.pdf') && context.includes('second.pdf'));
    assert.ok(!context.includes('base64'));
  }
  assert.deepEqual(h.counters, { extraction: 2, fallback: 0, storage: 2 });
});

test('persistence errors do not trigger a second extraction; plain text remains supported', async () => {
  const h = harness({ failDB: true });
  await assert.rejects(h.upload(pdf), /synthetic persistence failure/);
  assert.deepEqual(h.counters, { extraction: 1, fallback: 0, storage: 1 });
  const native = harness();
  await native.upload({ ...pdf, originalname: 'synthetic.txt', mimetype: 'text/plain' });
  assert.equal(native.records[0].text, readable);
});

test('real client → Tika → upload handler → captured persistence → file context', {
  skip: process.env.LIVE_UPLOAD_HANDLER !== 'true',
}, async () => {
  const root = '/fixtures';
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).synthetic_only, true);
  const h = harness({ extraction: api.parseText });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-upload-handler-'));
  try {
    for (const [index, name] of ['digital.pdf', 'beleid.docx', 'scan.pdf', 'broken-layer.pdf'].entries()) {
      const temporary = path.join(scratch, name);
      fs.copyFileSync(path.join(root, name), temporary);
      await h.upload({ originalname: name, path: temporary, size: fs.statSync(temporary).size,
        mimetype: name.endsWith('.pdf') ? 'application/pdf' : routes.docx.mimes[0] },
        '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'));
    }
    assert.equal(h.records.length, 4);
    for (const record of h.records) {
      assert.ok(record.text.includes('financiële') && record.text.includes('2026'));
      assert.ok(!record.text.includes('\ufffd'));
    }
    const context = await api.extractFileContext({ attachments: h.records,
      req: { config: h.config }, tokenCountFn: text => text.length });
    assert.ok(context.includes('financiële') && context.includes('broken-layer.pdf'));
    assert.deepEqual(h.counters, { extraction: 4, fallback: 0, storage: 4 });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
