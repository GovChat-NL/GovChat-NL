'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const installed = createRequire('/app/package.json');
const yaml = installed('js-yaml');
const lc = installed('librechat-data-provider');
const before = yaml.load(fs.readFileSync('/before.yaml', 'utf8'));
const candidatePath = process.env.CANDIDATE_CONFIG_PATH || '/candidate.yaml';
const candidate = yaml.load(fs.readFileSync(candidatePath, 'utf8'));
const { minimalConfig, render } = require('/source/scripts/apply-minimal-ui.js');
const routes = JSON.parse(fs.readFileSync('/source/services/document-extractor/routes.json'));
for (const config of [candidate, minimalConfig(candidate)]) {
  lc.fileConfigSchema.parse(config.fileConfig);
  const merged = lc.mergeFileConfig(config.fileConfig);
  const ec = lc.getEndpointFileConfig({ fileConfig: merged, endpoint: 'govchat-orchestrator', endpointType: 'custom' });
  assert.equal(ec.legacyFileUploadUX, false);
  assert.equal(lc.isPermissiveMimeConfig(merged.text.supportedMimeTypes), false);
  for (const route of Object.values(routes)) for (const mimeType of route.mimes) {
    assert.equal(lc.resolveDefaultUploadLLMDeliveryPath({ mimeType, endpointConfig: ec, fileConfig: merged, endpoint: 'govchat-orchestrator', sttConfigured: false }), 'text', mimeType);
    assert.equal(merged.checkType(mimeType, merged.text.supportedMimeTypes), true);
  }
  assert.equal(config.endpoints.custom.find(e => e.name === 'govchat-orchestrator').resendFiles, true);
}
const stripped = structuredClone(candidate);
delete stripped.fileConfig;
if (before.fileConfig !== undefined) stripped.fileConfig = before.fileConfig;
for (const e of stripped.endpoints.custom) if (e.name === 'govchat-orchestrator') {
  const original = before.endpoints.custom.find(x => x.name === e.name);
  if ('resendFiles' in original) e.resendFiles = original.resendFiles; else delete e.resendFiles;
}
assert.deepEqual(stripped, before, 'only upload configuration may change');
const mergedBefore = lc.mergeFileConfig(before.fileConfig);
const mergedAfter = lc.mergeFileConfig(candidate.fileConfig);
for (const mimeType of ['image/png', 'audio/wav', 'video/mp4', 'text/plain', 'application/json', 'application/zip']) {
  const resolve = fileConfig => lc.resolveDefaultUploadLLMDeliveryPath({ mimeType, fileConfig, endpoint: 'govchat-orchestrator', sttConfigured: false,
    endpointConfig: lc.getEndpointFileConfig({ fileConfig, endpoint: 'govchat-orchestrator', endpointType: 'custom' }) });
  assert.equal(resolve(mergedBefore), resolve(mergedAfter), mimeType);
}
const output = render({ GOVCHAT_MINIMAL_UI: 'true', CONFIG_PATH: candidatePath });
assert.deepEqual(yaml.load(fs.readFileSync(output, 'utf8')).fileConfig, minimalConfig(candidate).fileConfig);
assert.ok(fs.readFileSync(output, 'utf8').includes('${'), 'secret placeholders preserved');
console.log('Installed LibreChat schema, upload routing, UID readability, branding renderer, settings/media preservation: PASS');
