'use strict';
// Installed LibreChat client; synthetic fixtures and disposable services only.
// No database, user session, production secret, prompt or document text output.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const installed = createRequire('/app/package.json');
const api = installed('@librechat/api');
const axios = installed('axios');
const progress = { case: null, phase: 'initializing' };

async function healthStatus() {
  // Use the installed client's HTTP stack, which consumes JSON response bodies.
  const response = await axios.get(process.env.RAG_API_URL + '/health', { timeout: 10000 });
  return response.status;
}

async function main() {
  assert.ok(process.env.RAG_API_URL, 'disposable extractor URL required');
  assert.ok(process.env.JWT_SECRET, 'independent synthetic key required');
  const fixtureRoot = process.env.SYNTHETIC_FIXTURE_DIR || '/fixtures';
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json')));
  assert.equal(manifest.synthetic_only, true, 'only generated synthetic fixtures allowed');
  const repeats = Number(process.env.SYNTHETIC_SCAN_REPEATS || 10);
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 30);
  const cases = [
    ['digital.pdf', 'application/pdf'],
    ['beleid.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['beleid.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['beleid.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['beleid.odt', 'application/vnd.oasis.opendocument.text'],
    ['beleid.eml', 'message/rfc822'],
    ['beleid.txt', 'text/plain'],
    ...Array.from({ length: repeats }, () => [
      ['scan.pdf', 'application/pdf'], ['broken-layer.pdf', 'application/pdf'],
      ['mixed.pdf', 'application/pdf'],
      ['beleid.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ]).flat(),
  ];
  if (process.env.SYNTHETIC_BENCHMARK === 'true') {
    cases.push(['scan-30.pdf', 'application/pdf'], ['digital.pdf', 'application/pdf']);
  }
  if (process.env.SYNTHETIC_HIGH_RES === 'true') {
    if (process.env.SYNTHETIC_HIGH_RES_ONLY === 'true') cases.splice(0, cases.length);
    cases.push(...Array.from({ length: 4 }, () => ['scan-high-resolution.pdf', 'application/pdf']));
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-extraction-'));
  try {
    for (const [i, [name, mimetype]] of cases.entries()) {
      progress.case = i;
      progress.phase = 'health-before';
      // Installed storage preserves the sanitized original extension, optionally
      // prefixed by a UUID. The client streams this path with form-data defaults.
      const filePath = path.join(scratch, '00000000-0000-4000-8000-000000000000-' + name);
      const data = fs.readFileSync(path.join(fixtureRoot, name));
      fs.writeFileSync(filePath, data);
      assert.equal(await healthStatus(), 200, 'extractor must be healthy before each case');
      const start = Date.now();
      progress.phase = 'extracting';
      const result = await api.parseText({
        req: { user: { id: 'synthetic-client-owner' }, config: {} },
        file: { path: filePath, originalname: name, mimetype, size: data.length },
        file_id: 'synthetic-client-file-' + i,
        allowNativeFallback: false,
      });
      progress.phase = 'checking-text';
      assert.equal(result.source, 'text');
      const text = result.text;
      assert.equal(typeof text, 'string');
      const meaningful = Array.from(text).filter(c => /[\p{L}\p{N}]/u.test(c)).length;
      const replacement = Array.from(text).filter(c => c === '\ufffd').length;
      assert.ok(meaningful > 20, 'readable extraction required');
      assert.equal(replacement, 0, 'replacement garbage must not pass');
      for (const marker of ['2026', 'financiële', 'verantwoording']) {
        assert.ok(text.includes(marker), 'synthetic source marker absent');
      }
      progress.phase = 'health-after';
      assert.equal(await healthStatus(), 200);
      console.log(JSON.stringify({ case: i, chars: text.length, meaningful,
        replacement, seconds: (Date.now() - start) / 1000, healthy: true }));
      fs.unlinkSync(filePath);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const summary = { passed: true, cases: cases.length };
  console.log(JSON.stringify(summary));
  if (process.env.SYNTHETIC_REPORT) {
    fs.writeFileSync(process.env.SYNTHETIC_REPORT, JSON.stringify(summary));
  }
}

main().then(() => process.exit(0)).catch(error => {
  // Installed-client exceptions can include file labels: report class only.
  console.error(JSON.stringify({ passed: false, errorClass: error.name }));
  console.error(JSON.stringify({ ...progress,
    assertion: error.name === 'AssertionError' ? error.message : undefined,
    networkCode: /^[A-Z0-9_]{1,64}$/.test(error.code || error.cause?.code || '')
      ? (error.code || error.cause.code) : undefined }));
  process.exit(1);
});
