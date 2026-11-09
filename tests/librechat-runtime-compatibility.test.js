'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { loadLibreChatRuntime } = require('../scripts/govchat-retention-worker');
const { readReleasePin } = require('../scripts/librechat-release-pin');

const expectedRelease = readReleasePin();

const root = process.env.GOVCHAT_TEST_LIBRECHAT_ROOT || '/app';
const apiRoot = path.join(root, 'api');
const available = fs.existsSync(path.join(apiRoot, 'package.json'));
// Upstream initializes its logger relative to cwd. Keep runtime writes in the
// disposable image, never in the read-only GovChat source mount.
if (available) process.chdir(apiRoot);

test('official image is the intended LibreChat release', { skip: !available }, () => {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(version, expectedRelease.tag);
});

test('real config exports remain compatible with the request-time name overlay', { skip: !available }, () => {
  const apiRequire = createRequire(path.join(apiRoot, 'package.json'));
  apiRequire('module-alias')({ base: apiRoot });
  assert.equal(typeof apiRequire(path.join(apiRoot, 'server/services/Config/app')).getAppConfig, 'function');
  assert.equal(typeof apiRequire(path.join(apiRoot, 'server/services/Config/getEndpointsConfig')).getEndpointsConfig, 'function');
});

test('real retention runtime retains initialized config and file deletion services', { skip: !available }, () => {
  // The connector validates its configuration on import. No connectDb call is
  // made here; a closed local port ensures this contract test cannot reach data.
  process.env.MONGO_URI ||= 'mongodb://127.0.0.1:1/govchat-interface-test';
  const runtime = loadLibreChatRuntime(apiRoot);
  for (const name of ['connectDb', 'getAppConfig', 'initializeFileStorage', 'runAsSystem']) {
    assert.equal(typeof runtime[name], 'function', name);
  }
  for (const name of ['processDeleteRequest', 'sweepExpiredFiles']) {
    assert.equal(typeof runtime.fileServices[name], 'function', name);
  }
  for (const name of ['deleteConvos', 'deleteMessages', 'getExpiredFiles', 'deleteFiles']) {
    assert.equal(typeof runtime.db[name], 'function', name);
  }
});
