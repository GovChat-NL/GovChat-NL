'use strict';
// Network-free regression: Tika configuration must not add broad file policies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const installed = createRequire('/app/package.json');
const api = installed('@librechat/api');
const lc = installed('librechat-data-provider');
const yaml = installed('js-yaml');
const before = yaml.load(fs.readFileSync('/before.yaml', 'utf8'));
const candidate = yaml.load(fs.readFileSync(process.env.CANDIDATE_CONFIG_PATH || '/candidate.yaml', 'utf8'));
assert.deepEqual(candidate.filters, before.filters, 'Tika must preserve existing security policies');
lc.filtersConfigSchema.parse(candidate.filters ?? {});
const text = 'Dit is een veilige Nederlandse test: één financiële zienswijze, € 13, 2026.';
const file = { file_id: 'synthetic-file', source: 'text', mimetype: 'text/plain', extractedText: text };
let nested = {};
for (let i = 0; i < 26; i++) nested = { child: nested };
const agent = { instructions: 'Beantwoord de veilige test.', attachments: [file], runtimeMetadata: nested };
for (const content of [text, text.repeat(1500)]) {
  api.assertModelBoundContent({ filters: candidate.filters, agents: [agent],
    submittedMessages: [{ role: 'user', content }] });
}
(async () => {
  let calls = 0;
  const filter = api.createContentFilter({ getFilters: () => candidate.filters,
    getOpaqueFileInput: req => req.body,
    getFiles: async () => { throw new Error('ordinary text must not resolve files'); },
    extract: req => api.extractChatContent(req.body) });
  for (const content of [text, text.repeat(1500)]) {
    await filter({ body: { text: content, files: [] } }, {
      status: () => { throw new Error('ordinary text blocked'); },
    }, error => { assert.equal(error, undefined); calls++; });
  }
  assert.equal(calls, 2);
  console.log('PASS: policies preserved; ordinary Unicode/pasted chat needs no file traversal');
  process.exit(0);
})().catch(error => { console.error(error.name); process.exit(1); });
