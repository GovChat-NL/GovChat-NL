'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readReleasePin } = require('../scripts/librechat-release-pin');
const image = 'registry.librechat.ai/librechat-ai/librechat:';
const fixture = tag => `services:\n  librechat:\n    image: ${image}${tag}\n  govchat-retention:\n    image: ${image}${tag}\n`;

test('release expectations follow exact synchronized committed Compose pins', () => {
  assert.match(readReleasePin().tag, /^v\d+\.\d+\.\d+$/);
  assert.deepEqual(readReleasePin(fixture('v1.20.3')), { image: image + 'v1.20.3', tag: 'v1.20.3' });
});

test('floating, development, other registry, unequal and duplicate pins fail closed', () => {
  for (const tag of ['latest', 'v0.8.8-rc1', 'v0.8.8-dev', '0.8.8', 'v01.8.8', '${VERSION}', 'v0.8.8@sha256:abc']) {
    assert.throws(() => readReleasePin(fixture(tag)));
  }
  for (const text of [fixture('v0.8.8').replace('v0.8.8', 'v0.8.9'),
    fixture('v0.8.8').replaceAll('registry.librechat.ai', 'ghcr.io'),
    fixture('v0.8.8').replace('  librechat:', '  librechat:\n  librechat:'),
    fixture('v0.8.8').replace('  librechat:', "  'librechat': {}\n  librechat:"),
    fixture('v0.8.8').replace('services:', "'services': {}\nservices:"),
    fixture('v0.8.8').replace('services:', 'services: {}\nnetworks:'),
    fixture('v0.8.8').replace('    image:', '    image: duplicate\n    image:'),
    fixture('v0.8.8').replace('    image:', '    image : duplicate\n    image:'),
    fixture('v0.8.8').replace('    image:', "    'image': duplicate\n    image:"),
    fixture('v0.8.8').replace('    image:', '    <<: *other\n    image:')]) {
    assert.throws(() => readReleasePin(text));
  }
});
