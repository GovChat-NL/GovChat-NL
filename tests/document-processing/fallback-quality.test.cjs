'use strict';
// Installed pinned image, network disabled; only benign synthetic content.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const installed = createRequire('/app/package.json');
const api = installed('@librechat/api');
const lc = installed('librechat-data-provider');
const yaml = installed('js-yaml');
const active = yaml.load(fs.readFileSync('/before.yaml', 'utf8'));
const candidate = yaml.load(fs.readFileSync('/candidate.yaml', 'utf8'));
lc.filtersConfigSchema.parse(active.filters);
lc.filtersConfigSchema.parse(candidate.filters ?? {});
const reverted = structuredClone(active);
assert.equal(reverted.filters.files.pii.customPatterns[0].id, 'document-zero-readable');
delete reverted.filters;
assert.deepEqual(candidate, reverted, 'only verified introduced policy delta removed');
const text = 'Dit is een veilige Nederlandse test: één financiële zienswijze, € 13, 2026.';
const goodFile = { file_id: 'synthetic-file', source: 'text', mimetype: 'text/plain',
  extractedText: text };
// A hydrated agent file activates locator removal over the whole agent object.
// Reproduce the runtime max_depth diagnostic without any actual agent/user data.
let nested = {};
for (let i = 0; i < 26; i++) nested = { child: nested };
const agent = { instructions: 'Beantwoord de veilige test.', attachments: [goodFile],
  runtimeMetadata: nested };
const diagnostics = [];
assert.throws(() => api.assertModelBoundContent({ filters: active.filters, agents: [agent],
  submittedMessages: [{ role: 'user', content: text }],
  onTraversalFailure: (d) => diagnostics.push(d) }), (error) => {
  assert.equal(error.name, 'ContentTraversalLimitError');
  assert.equal(error.message, 'Submitted content could not be completely inspected before processing.');
  console.log('Reproduced installed stack:', error.stack.split('\n').slice(0, 7).join('\n'));
  return true;
});
assert.equal(diagnostics[0].operation, 'omit_resolved_file_locators');
assert.equal(diagnostics[0].reason, 'max_depth');
assert.equal(diagnostics[0].depth, 25);
assert.equal(diagnostics[0].resolvedFileCount, 1);
assert.equal(api.inspectContent(api.extractChatContent({ text }), { filters: active.filters }), null,
  'plain text is not a regex finding');
const cases = {
  plain: { submittedMessages: [{ role: 'user', content: text }], agents: [agent] },
  longUnicode: { submittedMessages: [{ role: 'user', content: text.repeat(1500) }], agents: [agent] },
  readableHistory: { storedMessages: [{ role: 'user', isCreatedByUser: true,
    text, files: [goodFile] }], resolvedFiles: [goodFile], agents: [agent] },
  freshReadable: { files: [goodFile], agents: [agent] },
};
for (const [name, shape] of Object.entries(cases)) {
  api.assertModelBoundContent({ filters: candidate.filters, ...shape });
  console.log('PASS model-bound:', name);
}
// Honest restored boundary: built-in fallback garbage no longer has this rule.
assert.equal(api.inspectContent(api.extractFileContent({ extractedText: '\ufffd'.repeat(100) }),
  { filters: candidate.filters }), null);
(async () => {
  let nextCalls = 0, fileReads = 0;
  const filter = api.createContentFilter({ getFilters: () => candidate.filters,
    getOpaqueFileInput: (req) => req.body,
    getFiles: async () => { fileReads++; throw new Error('unexpected file lookup'); },
    extract: (req) => api.extractChatContent(req.body) });
  for (const pasted of [text, text.repeat(1500)]) {
    await filter({ body: { text: pasted, files: [] } }, {
      status: () => { throw new Error('plain request blocked'); },
    }, (error) => { assert.equal(error, undefined); nextCalls++; });
  }
  assert.equal(nextCalls, 2);
  assert.equal(fileReads, 0, 'no file lookup or extraction for non-document chat');
  const { minimalConfig, render } = require('/source/scripts/apply-minimal-ui.js');
  assert.deepEqual(minimalConfig(candidate).filters, candidate.filters);
  const rendered = render({ GOVCHAT_MINIMAL_UI: 'true', CONFIG_PATH: '/candidate.yaml' });
  assert.deepEqual(yaml.load(fs.readFileSync(rendered, 'utf8')).filters, candidate.filters);
  console.log('PASS installed request middleware, schema, UID1000 configuration, renderer, exact rollback; fallback limitation explicit');
  process.exit(0);
})().catch((error) => { console.error(error.name, error.message); process.exit(1); });
