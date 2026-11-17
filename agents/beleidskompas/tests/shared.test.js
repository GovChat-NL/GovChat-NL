'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUEST_META_LABEL,
  TITLE_REQUEST_MARKER,
  extractSuppliedToken,
  parsePageMessage,
  isTitleRequest,
  buildFallbackTitle,
  extractConvoCaseText,
} = require('../shared');

/** A message as the page composes it: the visible text, then the request
 *  as base64 JSON in a markdown link definition. */
function pageMessage(request, shown = 'Zichtbare tekst') {
  return `${shown}\n\n[${REQUEST_META_LABEL}]: data:application/json;base64,${Buffer.from(JSON.stringify(request), 'utf8').toString('base64')}`;
}

test('parsePageMessage reads the substep, the case and the message from the block of the page', () => {
  const parts = parsePageMessage(pageMessage({ substep_id: '3.2', case_text: ' Een casus mét accenten. ', message: 'Waarom?' }));
  assert.deepEqual(parts, { fromPage: true, stepId: 'stap3', substepId: '3.2', caseText: 'Een casus mét accenten.', message: 'Waarom?' });
});

test('parsePageMessage: text without the block was typed in the chat of LibreChat and is all message', () => {
  assert.deepEqual(parsePageMessage('  Hoe werkt dit?  '), { fromPage: false, stepId: '', substepId: '', caseText: '', message: 'Hoe werkt dit?' });
});

test('parsePageMessage: an unreadable block leaves the text as the message', () => {
  const broken = `Tekst\n\n[${REQUEST_META_LABEL}]: data:application/json;base64,@@@`;
  assert.equal(parsePageMessage(broken).fromPage, false);
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
