"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createNameStore, validateName, validateMetadata, DEFAULT_DISPLAY_NAME } = require("../../services/admin-overlay/admin/lib/orchestrator-name");
const { readName, overlayAppConfig, overlayEndpoints } = require("../../scripts/librechat-orchestrator-name");

test("name validation rejects empty, oversized, controls, formatting and markup", () => {
  for (const value of [null, 1, {}, '', '  ', 'x'.repeat(101), 'a\nb', 'a\tb', '\u007f', '\u0085', '\u202eabc', '\u200b', '\u2028', '\ud800', '<img onerror=x>']) assert.throws(() => validateName(value));
  assert.equal(validateName('  Test & naam "veilig"  '), 'Test & naam "veilig"');
  assert.equal(validateName('x'.repeat(100)).length, 100);
});

test("override > env > generic; reset removes only name; publication cannot include prompt", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'name-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { N8N_ORCHESTRATOR_DISPLAY_NAME: 'Omgevingsnaam', N8N_ORCHESTRATOR_MASTER_PROMPT: 'PRIVATE_SENTINEL' };
  const store = createNameStore({ dataDir: root, publishDir: path.join(root, 'publish'), env });
  assert.equal(store.read().source, 'environment');
  store.save('  Adminnaam  ');
  assert.equal(store.read().display_name, 'Adminnaam');
  assert.equal(store.read().source, 'admin');
  assert.equal(fs.statSync(store.filename).mode & 0o777, 0o600);
  assert.equal(readName({ filename: store.publicFilename, env }), 'Adminnaam');
  const promptFile = path.join(root, 'private/orchestrator-prompt.json');
  fs.writeFileSync(promptFile, 'PRIVATE_SENTINEL');
  assert.equal(store.reset().source, 'environment');
  assert.equal(fs.existsSync(store.filename), false);
  assert.equal(fs.readFileSync(promptFile, 'utf8'), 'PRIVATE_SENTINEL');
  assert.equal(readName({ filename: store.publicFilename, env }), 'Omgevingsnaam');
  env.N8N_ORCHESTRATOR_DISPLAY_NAME = '';
  assert.equal(store.read().display_name, DEFAULT_DISPLAY_NAME);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(store.publicFilename))).sort(), ['display_name', 'max_length', 'source', 'version']);
  assert.ok(!fs.readFileSync(store.publicFilename, 'utf8').includes('PRIVATE_SENTINEL'));
  assert.throws(() => validateMetadata({ ...store.read(), prompt: 'PRIVATE_SENTINEL' }));
});

test("invalid storage/env fails closed; explicit reset repairs corruption; symlinks rejected", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'name-corrupt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {};
  const store = createNameStore({ dataDir: root, publishDir: path.join(root, 'publish'), env });
  store.save('Admin');
  fs.writeFileSync(store.filename, '{}');
  assert.throws(() => store.read());
  env.N8N_ORCHESTRATOR_DISPLAY_NAME = '\n';
  assert.throws(() => store.reset());
  assert.ok(fs.existsSync(store.filename));
  env.N8N_ORCHESTRATOR_DISPLAY_NAME = '';
  store.reset();
  fs.writeFileSync(store.publicFilename, 'bad');
  assert.throws(() => readName({ filename: store.publicFilename, env }));
  store.read();
  fs.symlinkSync(store.publicFilename, store.filename);
  assert.throws(() => store.save('test'));
  assert.throws(() => store.reset());
});

test("request-time endpoint and modelSpec labels remain coherent without cache/ID mutation", () => {
  const config = { endpoints: { custom: [{ name: 'govchat-orchestrator', modelDisplayLabel: 'Old', models: { default: ['govchat-orchestrator'] }, apiKey: 'unchanged' }, { name: 'other', modelDisplayLabel: 'Other' }] }, modelSpecs: { list: [{ name: 'stable-spec-id', label: 'Old', preset: { endpoint: 'govchat-orchestrator', model: 'stable-model-id' } }, { name: 'other', label: 'Other', preset: { endpoint: 'other' } }] } };
  const before = JSON.stringify(config);
  const result = overlayAppConfig(config, 'Nieuwe naam');
  assert.equal(result.endpoints.custom[0].modelDisplayLabel, 'Nieuwe naam');
  assert.equal(result.modelSpecs.list[0].label, 'Nieuwe naam');
  assert.equal(result.modelSpecs.list[0].name, 'stable-spec-id');
  assert.equal(result.modelSpecs.list[0].preset.model, 'stable-model-id');
  assert.equal(result.endpoints.custom[0].apiKey, 'unchanged');
  assert.equal(result.endpoints.custom[1].modelDisplayLabel, 'Other');
  assert.equal(JSON.stringify(config), before);
  const endpoints = { 'govchat-orchestrator': { modelDisplayLabel: 'Old', titleModel: 'stable-title-model' } };
  assert.equal(overlayEndpoints(endpoints, 'Nieuwe naam')['govchat-orchestrator'].titleModel, 'stable-title-model');
  assert.equal(endpoints['govchat-orchestrator'].modelDisplayLabel, 'Old');
});
