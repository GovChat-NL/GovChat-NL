'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const guard = require('../../scripts/librechat-tika-upload-preload');
const Module = require('node:module');

test('rejects document fallback but leaves plain text and media untouched', () => {
  const routes = require('../../services/document-extractor/routes.json');
  for (const mime of Object.values(routes).flatMap(route => route.mimes)) {
    assert.throws(() => guard.rejectFallback({ mimetype: mime }), { code: 'TIKA_EXTRACTION_FAILED' });
  }
  for (const mime of ['text/plain', 'text/csv', 'image/png', 'audio/mpeg', 'video/mp4']) {
    assert.doesNotThrow(() => guard.rejectFallback({ mimetype: mime }));
  }
});

test('patch is selective and fails closed on incompatible installed upload source', () => {
  const source = fs.readFileSync('/app/api/server/services/Files/process.js', 'utf8');
  const patched = guard.patchUploadSource(source);
  assert.ok(patched.includes('.rejectFallback(file);'));
  assert.throws(() => guard.patchUploadSource('incompatible release'));
  assert.throws(() => guard.patchUploadSource(source + source));
  assert.throws(() => guard.patchUploadSource(patched));
});

test('loader activates only with the explicit flag and correct private origin', () => {
  const previous = Module._extensions['.js'];
  const flag = process.env.GOVCHAT_TIKA_UPLOAD_ENABLED;
  const origin = process.env.RAG_API_URL;
  try {
    process.env.GOVCHAT_TIKA_UPLOAD_ENABLED = 'false';
    guard.install();
    assert.equal(Module._extensions['.js'], previous);
    process.env.GOVCHAT_TIKA_UPLOAD_ENABLED = 'true';
    process.env.RAG_API_URL = 'http://unrelated-extractor';
    assert.throws(() => guard.install(), /private Tika extraction origin/);
    process.env.RAG_API_URL = 'http://govchat-upload-extractor:8000';
    guard.install();
    let compiled;
    Module._extensions['.js']({ _compile: text => { compiled = text; } },
      '/app/api/server/services/Files/process.js');
    assert.ok(compiled.includes('.rejectFallback(file);'));
  } finally {
    Module._extensions['.js'] = previous;
    if (flag === undefined) delete process.env.GOVCHAT_TIKA_UPLOAD_ENABLED;
    else process.env.GOVCHAT_TIKA_UPLOAD_ENABLED = flag;
    if (origin === undefined) delete process.env.RAG_API_URL;
    else process.env.RAG_API_URL = origin;
  }
});
