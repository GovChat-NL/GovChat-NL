'use strict';

const fs = require('node:fs');
const path = require('node:path');
const prefix = 'registry.librechat.ai/librechat-ai/librechat:';
const stableTag = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function readReleasePin(text = fs.readFileSync(path.join(__dirname, '../docker-compose.yml'), 'utf8')) {
  const mappings = [...text.matchAll(/^["']?services["']?[ \t]*:/gm)];
  if (mappings.length !== 1 || !/^services:[ \t]*\n/.test(text.slice(mappings[0].index))) throw new Error('Expected one literal services mapping');
  const start = mappings[0].index;
  const contentStart = text.indexOf('\n', start) + 1;
  const nextMapping = /^\S/m.exec(text.slice(contentStart));
  const end = nextMapping ? contentStart + nextMapping.index : text.length;
  const section = text.slice(start, end);
  const images = ['librechat', 'govchat-retention'].map(service => {
    const keys = [...section.matchAll(new RegExp(`^  ["']?${service}["']?[ \\t]*:`, 'gm'))];
    const blocks = [...text.matchAll(new RegExp(`^  ${service}:\\n(.*?)(?=^\\S|^  [\\w"'-]+[ \\t]*:|$(?![\\s\\S]))`, 'gms'))];
    if (keys.length !== 1 || blocks.length !== 1 || blocks[0].index < start || blocks[0].index >= end) throw new Error(`Expected one literal ${service} service`);
    const block = blocks[0][1];
    const pins = [...block.matchAll(/^    image: ([^\s#]+)\s*$/gm)];
    if (pins.length !== 1 || [...block.matchAll(/^    ["']?image["']?[ \t]*:/gm)].length !== 1 || /^    ["']?<<["']?[ \t]*:/m.test(block)) {
      throw new Error('Expected one literal image pin');
    }
    const image = pins[0][1];
    if (!image.startsWith(prefix) || !stableTag.test(image.slice(prefix.length))) {
      throw new Error('Expected official registry and exact vX.Y.Z image tag');
    }
    return image;
  });
  if (images[0] !== images[1]) throw new Error('LibreChat and retention image pins differ');
  return { image: images[0], tag: images[0].slice(prefix.length) };
}

module.exports = { readReleasePin };
