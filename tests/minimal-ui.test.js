'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { minimalConfig, render } = require('../scripts/apply-minimal-ui');
const root = path.resolve(__dirname, '..');

test('disabled and unset modes preserve the original config path without reading or writing it', () => {
  assert.equal(render({}), '/app/librechat.yaml');
  for (const mode of ['', 'false']) {
    assert.equal(render({ GOVCHAT_MINIMAL_UI: mode, CONFIG_PATH: '/nonexistent/custom.yaml' }), '/nonexistent/custom.yaml');
  }
  for (const mode of ['yes', 'TRUE', 'true;evil']) {
    assert.throws(() => render({ GOVCHAT_MINIMAL_UI: mode }), /must be true or false/);
  }
});

test('minimal mode preserves auth, headers, upload limits and source config while selecting one backend', () => {
  const source = yaml.load(fs.readFileSync(path.join(root, 'librechat.yaml'), 'utf8'));
  source.fileConfig = { serverFileSizeLimit: 42, endpoints: { default: { fileSizeLimit: 7, disabled: true } } };
  source.endpoints.custom.push({ name: 'other' });
  source.registration = { socialLogins: ['openid'] };
  const before = structuredClone(source);
  const config = minimalConfig(source);
  assert.deepEqual(source, before);
  assert.equal(Object.hasOwn(config.interface, 'customWelcome'), false);
  assert.equal(config.interface.prompts, true);
  for (const feature of ['agents', 'modelSelect', 'parameters', 'presets', 'multiConvo', 'skills', 'webSearch', 'sharedLinks']) {
    assert.equal(config.interface[feature], false);
  }
  assert.deepEqual(config.registration, source.registration);
  assert.equal(config.fileConfig.serverFileSizeLimit, 42);
  assert.deepEqual(config.fileConfig.endpoints.default, { fileSizeLimit: 7, disabled: false });
  assert.equal(config.endpoints.custom.length, 1);
  assert.deepEqual(config.endpoints.custom[0].headers, source.endpoints.custom[0].headers);
  assert.deepEqual(config.endpoints.custom[0].models, { default: ['govchat-orchestrator'], fetch: false });
  assert.equal(config.endpoints.custom[0].apiKey, '${N8N_OPENAI_BRIDGE_BEARER_TOKEN}');
  assert.throws(() => minimalConfig({ endpoints: {} }), /requires the govchat-orchestrator/);
});

test('minimal mode and rendered config preserve an explicitly configured welcome message', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-welcome-test-'));
  const sourcePath = path.join(directory, 'librechat.yaml');
  const source = yaml.load(fs.readFileSync(path.join(root, 'librechat.yaml'), 'utf8'));
  source.interface.customWelcome = 'Welkom bij onze chatassistent';
  const before = structuredClone(source);
  let output;
  try {
    assert.equal(minimalConfig(source).interface.customWelcome, source.interface.customWelcome);
    assert.deepEqual(source, before);
    fs.writeFileSync(sourcePath, yaml.dump(source));
    const original = fs.readFileSync(sourcePath, 'utf8');
    output = render({ GOVCHAT_MINIMAL_UI: 'true', CONFIG_PATH: sourcePath });
    assert.equal(yaml.load(fs.readFileSync(output, 'utf8')).interface.customWelcome, source.interface.customWelcome);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
  } finally {
    if (output) fs.rmSync(path.dirname(output), { recursive: true });
    fs.rmSync(directory, { recursive: true });
  }
});

test('enabled rendering writes a private temporary config and disabling restores original behavior', () => {
  const sourcePath = path.join(root, 'librechat.yaml');
  const before = fs.readFileSync(sourcePath, 'utf8');
  const output = render({ GOVCHAT_MINIMAL_UI: 'true', CONFIG_PATH: sourcePath });
  try {
    assert.notEqual(output, sourcePath);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.equal(yaml.load(fs.readFileSync(output, 'utf8')).interface.agents, false);
    assert.equal(Object.hasOwn(yaml.load(fs.readFileSync(output, 'utf8')).interface, 'customWelcome'), false);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), before);
    assert.equal(render({ GOVCHAT_MINIMAL_UI: 'false', CONFIG_PATH: sourcePath }), sourcePath);
    assert.equal(yaml.load(before).interface.agents, true);
  } finally {
    fs.rmSync(path.dirname(output), { recursive: true });
  }
});

test('OpenID startup is opt-in, runs once before app start and fails closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-openid-startup-'));
  const noop = path.join(directory, 'noop.js');
  const openid = path.join(directory, 'openid.js');
  fs.writeFileSync(noop, '');
  fs.writeFileSync(openid, 'console.log("openid-adapter-called");process.exit(Number(process.env.FIXTURE_EXIT || 0))');
  try {
    for (const [enabled, exit] of [[undefined, 0], ['false', 0], ['true', 0], ['invalid', 0], ['true', 7]]) {
      const env = { ...process.env, BRANDING_MODE: 'librechat',
        LIBRECHAT_NL_TRANSLATIONS_SCRIPT: noop, BRANDING_METADATA_SCRIPT: noop,
        GOVCHAT_OPENID_ADAPTER_SCRIPT: openid, FIXTURE_EXIT: String(exit),
        GOVCHAT_MINIMAL_UI_SCRIPT: path.join(root, 'scripts/apply-minimal-ui.js'),
        CONFIG_PATH: path.join(root, 'librechat.yaml'), GOVCHAT_MINIMAL_UI: 'false' };
      delete env.GOVCHAT_OPENID_RECOVERY_ENABLED;
      if (enabled !== undefined) env.GOVCHAT_OPENID_RECOVERY_ENABLED = enabled;
      const result = spawnSync('sh', [path.join(root, 'scripts/apply-branding.sh'), 'node', '-e',
        'console.log("app-started")'], { encoding: 'utf8', env });
      const failed = enabled === 'invalid' || exit !== 0;
      assert.equal(result.status === 0, !failed, result.stderr);
      assert.equal(result.stdout.includes('app-started'), !failed);
      assert.equal(result.stdout.split('openid-adapter-called').length - 1, enabled === 'true' ? 1 : 0);
      if (enabled === 'true' && !failed) assert.ok(result.stdout.indexOf('openid-adapter-called') < result.stdout.indexOf('app-started'));
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('startup selects minimal endpoints only when enabled and fails closed on invalid mode', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-startup-test-'));
  const translation = path.join(directory, 'translations.js');
  fs.writeFileSync(translation, '');
  try {
    for (const mode of ['false', 'true', 'invalid']) {
      const result = spawnSync('sh', [path.join(root, 'scripts/apply-branding.sh'), 'node', '-e',
        'console.log(JSON.stringify({config:process.env.CONFIG_PATH,endpoints:process.env.ENDPOINTS}))'], {
        encoding: 'utf8', env: { ...process.env, BRANDING_MODE: 'librechat',
          LIBRECHAT_NL_TRANSLATIONS_SCRIPT: translation,
          BRANDING_METADATA_SCRIPT: translation,
          GOVCHAT_OPENID_RECOVERY_ENABLED: 'false',
          GOVCHAT_MINIMAL_UI_SCRIPT: path.join(root, 'scripts/apply-minimal-ui.js'),
          CONFIG_PATH: path.join(root, 'librechat.yaml'), ENDPOINTS: 'custom,agents', GOVCHAT_MINIMAL_UI: mode },
      });
      if (mode === 'invalid') {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /must be true or false/);
        continue;
      }
      assert.equal(result.status, 0, result.stderr);
      const selected = JSON.parse(result.stdout.trim().split('\n').at(-1));
      assert.equal(selected.endpoints, mode === 'true' ? 'custom' : 'custom,agents');
      if (mode === 'true') {
        assert.equal(yaml.load(fs.readFileSync(selected.config, 'utf8')).interface.prompts, true);
        fs.rmSync(path.dirname(selected.config), { recursive: true });
      } else assert.equal(selected.config, path.join(root, 'librechat.yaml'));
    }
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
