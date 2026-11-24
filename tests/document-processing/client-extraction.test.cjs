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

async function main() {
  assert.ok(process.env.RAG_API_URL, 'disposable extractor URL required');
  assert.ok(process.env.JWT_SECRET, 'independent synthetic key required');
  const fixtureRoot = process.env.SYNTHETIC_FIXTURE_DIR || '/fixtures';
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'manifest.json')));
  assert.equal(manifest.synthetic_only, true, 'only generated synthetic fixtures allowed');
  const repeats = Number(process.env.SYNTHETIC_SCAN_REPEATS || 4);
  assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
  const cases = [
    ['digital.pdf', 'application/pdf'],
    ['beleid.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['beleid.txt', 'text/plain'],
    ...Array.from({ length: repeats }, () => ['scan.pdf', 'application/pdf']),
  ];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-extraction-'));
  try {
    for (const [i, [name, mimetype]] of cases.entries()) {
      // Installed storage preserves the sanitized original extension, optionally
      // prefixed by a UUID. The client streams this path with form-data defaults.
      const filePath = path.join(scratch, '00000000-0000-4000-8000-000000000000-' + name);
      const data = fs.readFileSync(path.join(fixtureRoot, name));
      fs.writeFileSync(filePath, data);
      const before = await fetch(process.env.RAG_API_URL + '/health');
      assert.equal(before.status, 200, 'extractor must be healthy before each case');
      const start = Date.now();
      const result = await api.parseText({
        req: { user: { id: 'synthetic-client-owner' }, config: {} },
        file: { path: filePath, originalname: name, mimetype, size: data.length },
        file_id: 'synthetic-client-file-' + i,
        allowNativeFallback: false,
      });
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
      assert.equal((await fetch(process.env.RAG_API_URL + '/health')).status, 200);
      console.log(JSON.stringify({ case: i, chars: text.length, meaningful,
        replacement, seconds: (Date.now() - start) / 1000, healthy: true }));
      fs.unlinkSync(filePath);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch(error => {
  // Installed-client exceptions can include file labels: report class only.
  console.error(JSON.stringify({ passed: false, errorClass: error.name }));
  process.exit(1);
});
