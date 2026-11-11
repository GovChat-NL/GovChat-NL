'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  selectSources,
  appendCitationsMetaBlock,
  parseCitationsMetaBlock,
  extractSuppliedToken,
  TITLE_REQUEST_MARKER,
  isTitleRequest,
  buildFallbackTitle,
  extractConvoCaseText,
} = require('../shared');

const passages = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'source-passages.json'), 'utf-8'),
).passages;

test('selectSources ranks and trims by top_k/min_score', () => {
  const { citations, retrieval_trace } = selectSources(passages, 'energietransitie provincie bevoegdheid gemeenten', {
    algorithm: 'needle',
    top_k: 2,
    min_score: 0.01,
  });
  assert.ok(citations.length <= 2);
  assert.ok(citations.length >= 1);
  assert.equal(retrieval_trace.matched_docs, citations.length);
  for (let i = 1; i < citations.length; i += 1) {
    assert.ok(citations[i - 1].score >= citations[i].score, 'citations must be sorted by descending score');
  }
});

test('selectSources returns nothing when min_score excludes everything', () => {
  const { citations } = selectSources(passages, 'volledig ongerelateerde tekst xyz', { top_k: 3, min_score: 0.99 });
  assert.equal(citations.length, 0);
});

test('appendCitationsMetaBlock + parseCitationsMetaBlock round-trip citations and retrieval_trace', () => {
  const citations = [{ rank: 1, id: 'doc-1', filename: 'Doc 1', score: 0.5, preview: 'preview tekst mét accenten' }];
  const retrieval_trace = { algorithm: 'needle', top_k: 3, min_score: 0.1, matched_docs: 1 };
  const withMeta = appendCitationsMetaBlock('Zichtbare tekst.', citations, retrieval_trace);

  assert.ok(withMeta.startsWith('Zichtbare tekst.'));
  const parsed = parseCitationsMetaBlock(withMeta);
  assert.equal(parsed.displayText, 'Zichtbare tekst.');
  assert.deepEqual(parsed.citations, citations);
  assert.deepEqual(parsed.retrieval_trace, retrieval_trace);
});

test('the meta block is a markdown link definition, so no renderer shows it', () => {
  const withMeta = appendCitationsMetaBlock('Zichtbare tekst.', [{ rank: 1, filename: 'Doc "1"' }], null);
  const metaLine = withMeta.split('\n').pop();

  // Een HTML-commentaar werd door LibreChat als tekst getoond; een
  // linkdefinitie wordt door de markdown-parser opgeslokt.
  assert.ok(!withMeta.includes('<!--'), 'no HTML comment');
  assert.match(metaLine, /^\[beleidskompas-meta]: data:application\/json;base64,[A-Za-z0-9+/=]+$/);
  assert.equal(metaLine.split('\n').length, 1, 'stays on a single line');
});

test('parseCitationsMetaBlock still reads messages stored in the old HTML-comment format', () => {
  const citations = [{ rank: 1, id: 'doc-1', filename: 'Doc 1', score: 0.5 }];
  const legacy = `Zichtbare tekst.\n\n<!--BELEIDSKOMPAS-META:${JSON.stringify({ citations, retrieval_trace: null })}-->`;

  const parsed = parseCitationsMetaBlock(legacy);
  assert.equal(parsed.displayText, 'Zichtbare tekst.');
  assert.deepEqual(parsed.citations, citations);
});

test('parseCitationsMetaBlock leaves plain text (no meta block) unchanged', () => {
  const parsed = parseCitationsMetaBlock('Gewoon tekst zonder meta-blok.');
  assert.equal(parsed.displayText, 'Gewoon tekst zonder meta-blok.');
  assert.deepEqual(parsed.citations, []);
  assert.equal(parsed.retrieval_trace, null);
});

test('extractSuppliedToken reads x-govchat-token directly', () => {
  assert.equal(extractSuppliedToken({ 'x-govchat-token': 'abc' }), 'abc');
});

test('extractSuppliedToken falls back to an Authorization bearer header', () => {
  assert.equal(extractSuppliedToken({ authorization: 'Bearer my-token' }), 'my-token');
  assert.equal(extractSuppliedToken({ Authorization: 'Bearer my-token' }), 'my-token');
});

test('extractSuppliedToken returns empty when neither header is present', () => {
  assert.equal(extractSuppliedToken({}), '');
  assert.equal(extractSuppliedToken({ authorization: 'Basic abc' }), '');
});

test('isTitleRequest detects the marker regardless of surrounding text', () => {
  assert.equal(isTitleRequest(`${TITLE_REQUEST_MARKER} geef een titel`), true);
  assert.equal(isTitleRequest('gewone casustekst zonder marker'), false);
  assert.equal(isTitleRequest(''), false);
});

test('buildFallbackTitle strips the marker/markdown and shortens the text', () => {
  const title = buildFallbackTitle(`${TITLE_REQUEST_MARKER} ## Een gemeente wil een zwembad subsidiëren met provinciaal geld en vraagt om advies`);
  assert.ok(!title.includes(TITLE_REQUEST_MARKER));
  assert.ok(!title.includes('#'));
  assert.ok(title.split(' ').length <= 9);
});

test('buildFallbackTitle falls back to a generic label for empty input', () => {
  assert.equal(buildFallbackTitle(''), 'Beleidskompas casus');
  assert.equal(buildFallbackTitle(TITLE_REQUEST_MARKER), 'Beleidskompas casus');
});

test('extractConvoCaseText pulls the case text out of the rendered "User: ...\\nAI: ..." transcript', () => {
  const rendered = 'Geef een titel.\n\nUser: Een gemeente wil een zwembad subsidiëren.\nAI: ## Samenvatting casus ...';
  assert.equal(extractConvoCaseText(rendered), 'Een gemeente wil een zwembad subsidiëren.');
});

test('extractConvoCaseText returns the input unchanged when there is no "User:" transcript', () => {
  assert.equal(extractConvoCaseText('gewone casustekst zonder transcript'), 'gewone casustekst zonder transcript');
  assert.equal(extractConvoCaseText(''), '');
});
