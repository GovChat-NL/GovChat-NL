"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createNameStore } = require("../../services/admin-overlay/admin/lib/orchestrator-name");
const { installNameOverlay } = require("../../scripts/librechat-orchestrator-name");

test("installed runtime loader observes admin save/reset on next request without process restart", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'name-loader-'));
  const store = createNameStore({ dataDir: root, publishDir: path.join(root, 'publish'), env: { N8N_ORCHESTRATOR_DISPLAY_NAME: 'Environment fixture' } });
  store.read();
  const previousFile = process.env.GOVCHAT_ORCHESTRATOR_NAME_FILE;
  process.env.GOVCHAT_ORCHESTRATOR_NAME_FILE = store.publicFilename;
  const originalLoad = Module._load;
  const originalResolve = Module._resolveFilename;
  const cachedConfig = { endpoints: { custom: [{ name: 'govchat-orchestrator', modelDisplayLabel: 'Cached generic', models: { default: ['govchat-orchestrator'] } }] } };
  const cachedEndpoints = { 'govchat-orchestrator': { modelDisplayLabel: 'Cached generic', type: 'custom' } };
  const app = { getAppConfig: async () => cachedConfig };
  const endpoints = { getEndpointsConfig: async () => cachedEndpoints };
  Module._load = function (request) {
    if (request === 'fixture-app') return app;
    if (request === 'fixture-endpoints') return endpoints;
    return originalLoad.apply(this, arguments);
  };
  Module._resolveFilename = function (request) {
    if (request === 'fixture-app') return '/app/api/server/services/Config/app.js';
    if (request === 'fixture-endpoints') return '/app/api/server/services/Config/getEndpointsConfig.js';
    return originalResolve.apply(this, arguments);
  };
  t.after(() => {
    Module._load = originalLoad; Module._resolveFilename = originalResolve;
    if (previousFile === undefined) delete process.env.GOVCHAT_ORCHESTRATOR_NAME_FILE;
    else process.env.GOVCHAT_ORCHESTRATOR_NAME_FILE = previousFile;
    fs.rmSync(root, { recursive: true, force: true });
  });
  installNameOverlay();
  const runtimeApp = Module._load('fixture-app', module, false);
  const runtimeEndpoints = Module._load('fixture-endpoints', module, false);
  const first = runtimeApp.getAppConfig;
  Module._load('fixture-app', module, false);
  assert.equal(runtimeApp.getAppConfig, first, 'do not wrap twice');
  for (const [change, expected] of [[() => {}, 'Environment fixture'], [() => store.save('Admin fixture'), 'Admin fixture'], [() => store.reset(), 'Environment fixture']]) {
    change();
    assert.equal((await runtimeApp.getAppConfig()).endpoints.custom[0].modelDisplayLabel, expected);
    assert.equal((await runtimeEndpoints.getEndpointsConfig())['govchat-orchestrator'].modelDisplayLabel, expected);
    assert.deepEqual((await runtimeApp.getAppConfig()).endpoints.custom[0].models.default, ['govchat-orchestrator']);
  }
  assert.equal(cachedConfig.endpoints.custom[0].modelDisplayLabel, 'Cached generic');
  assert.equal(cachedEndpoints['govchat-orchestrator'].modelDisplayLabel, 'Cached generic');
});
