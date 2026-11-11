'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  extractSuppliedToken,
  selectSources,
  detectMissingInfo,
  parseAgentJson,
  buildDemoFallbackStructured,
  composeAnswerText,
  appendCitationsMetaBlock,
  parseCitationsMetaBlock,
  TITLE_REQUEST_MARKER,
  isTitleRequest,
  buildFallbackTitle,
  extractConvoCaseText,
  runStep1,
} = require('./logic');

const passages = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'source-passages.json'), 'utf-8'),
).passages;
const sampleCase = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-case.json'), 'utf-8'));
const missingInfoCase = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-case-missing-info.json'), 'utf-8'),
);

function webhookInput(body, token) {
  return {
    body,
    headers: token ? { 'x-govchat-token': token } : {},
  };
}

// --- selectSources ---

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

// --- detectMissingInfo ---

test('detectMissingInfo flags gaps for an empty case', () => {
  const missing = detectMissingInfo({}, '');
  assert.ok(missing.length >= 3);
});

test('detectMissingInfo is empty for a fully-specified case', () => {
  const missing = detectMissingInfo(sampleCase.step_fields, sampleCase.case_text);
  assert.equal(missing.length, 0);
});

// --- parseAgentJson ---

test('parseAgentJson parses a plain JSON response', () => {
  const { structured, parse_warning } = parseAgentJson(
    JSON.stringify({
      case_summary: 'x',
      public_interest: { verdict: 'ja', explanation: 'y' },
      provincial_interest: { verdict: 'ja', explanation: 'z' },
      reasoning: 'r',
      assumptions_missing_info: [],
    }),
  );
  assert.equal(parse_warning, false);
  assert.equal(structured.case_summary, 'x');
});

test('parseAgentJson unwraps a markdown-fenced JSON response', () => {
  const { structured, parse_warning } = parseAgentJson('```json\n{"case_summary":"x","reasoning":"r"}\n```');
  assert.equal(parse_warning, false);
  assert.equal(structured.case_summary, 'x');
});

test('parseAgentJson falls back gracefully on unparsable text', () => {
  const { structured, parse_warning } = parseAgentJson('dit is geen json');
  assert.equal(parse_warning, true);
  assert.equal(structured.reasoning, 'dit is geen json');
});

// --- buildDemoFallbackStructured / composeAnswerText ---

test('buildDemoFallbackStructured clearly labels demo output', () => {
  const structured = buildDemoFallbackStructured({
    question: sampleCase.question,
    caseText: sampleCase.case_text,
    stepFields: sampleCase.step_fields,
    citations: [],
    missingInfo: [],
  });
  assert.match(structured.reasoning, /DEMO-MODUS/);
  assert.ok(structured.assumptions_missing_info.some((m) => /geen taalmodel/i.test(m)));
});

test('composeAnswerText includes all required sections and the disclaimer', () => {
  const text = composeAnswerText(
    {
      case_summary: 'Samenvatting X',
      public_interest: { verdict: 'ja', explanation: 'want Y' },
      provincial_interest: { verdict: 'beperkt', explanation: 'want Z' },
      reasoning: 'Redenering ABC',
      assumptions_missing_info: ['iets ontbreekt'],
    },
    'llm',
    [{ rank: 1, filename: 'SiS 4.0 Strategisch kader', score: 0.2 }],
  );
  for (const needle of ['Samenvatting casus', 'Publiek belang', 'Provinciaal belang', 'Redenering', 'Aannames en ontbrekende informatie', 'Bronnen', 'ondersteunend concept']) {
    assert.ok(text.includes(needle), `expected answer text to include "${needle}"`);
  }
});

test('composeAnswerText renders markdown that also reads well in LibreChat itself', () => {
  const text = composeAnswerText(
    {
      case_summary: 'Samenvatting X',
      public_interest: { verdict: 'ja', explanation: '- marktfalen: aangetoond' },
      provincial_interest: { verdict: 'beperkt', explanation: 'want Z' },
      reasoning: 'Redenering ABC',
      assumptions_missing_info: [],
    },
    'llm',
    [{ rank: 1, filename: 'SiS 4.0 Strategisch kader', score: 0.207 }],
  );

  assert.match(text, /^\*\*Stap 1 · Publiek en provinciaal belang\*\*$/m, 'step label on the first line');
  assert.match(text, /^### Publiek belang$/m, 'sections use markdown headings');
  assert.match(text, /^\*\*Oordeel:\*\* ja$/m, 'verdict is a bold label');
  assert.match(text, /^1\. \*\*SiS 4.0 Strategisch kader\*\* - relevantie 0\.207$/m, 'sources are listed with their relevance');
  assert.ok(!/^## /m.test(text), 'no h2 headings left (they render oversized in a chat bubble)');
});

test('composeAnswerText says so when no source passed the relevance threshold', () => {
  const text = composeAnswerText({ case_summary: 'X' }, 'llm', []);
  assert.match(text, /### Bronnen\n- geen bronnen boven de relevantiedrempel/);
});

// --- citations meta block (LibreChat chat pipeline side-channel) ---

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

test('runStep1 text field carries the same citations as the structured citations field', async () => {
  const result = await runStep1({
    input: webhookInput(sampleCase),
    env: {},
    sources: [],
    passages,
    fetchImpl: global.fetch,
  });

  const parsed = parseCitationsMetaBlock(result.text);
  assert.deepEqual(parsed.citations, result.citations);
  assert.deepEqual(parsed.retrieval_trace, result.retrieval_trace);
  // The clean `answer` field (used by direct/hoofdagent JSON consumers)
  // never carries the meta block.
  assert.equal(result.answer, parsed.displayText);
});

// --- runStep1: auth ---

test('runStep1 returns a clear ok:false error for a wrong webhook token (never throws)', async () => {
  // Returned rather than thrown: n8n's `responseNode` webhook mode can turn a
  // thrown Code-node error into a bare empty 200 instead of a visible error
  // (observed against a live n8n 2.25.7 instance), which would silently
  // swallow the rejection. A normal ok:false item always reaches the caller.
  const result = await runStep1({
    input: webhookInput(sampleCase, 'wrong-token'),
    env: { BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN: 'expected-token' },
    sources: [],
    passages,
    fetchImpl: global.fetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unauthorized webhook token/);
});

// --- extractSuppliedToken (n8n-openai-bridge sends Authorization: Bearer, not x-govchat-token) ---

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

test('runStep1 accepts a real bridge-shaped request (Authorization bearer + currentMessage)', async () => {
  const result = await runStep1({
    input: {
      body: {
        currentMessage: sampleCase.case_text,
        chatInput: sampleCase.case_text,
        messages: [{ role: 'user', content: sampleCase.case_text }],
        sessionId: 'conv-123',
        userId: 'user-456',
      },
      headers: { authorization: 'Bearer expected-token' },
    },
    env: { N8N_WEBHOOK_TOKEN: 'expected-token' },
    sources: [],
    passages,
    fetchImpl: global.fetch,
  });

  assert.equal(result.ok, true);
  // `text` (not `answer`) is what n8n-openai-bridge actually extracts from
  // the response to build the assistant's chat message; it carries the same
  // visible content as `answer` plus an invisible trailing citations block.
  assert.ok(result.text.length > 0);
  assert.equal(parseCitationsMetaBlock(result.text).displayText, result.answer);
});

// --- runStep1: demo fallback (no LLM configured) ---

test('runStep1 uses the demo fallback when no LLM credentials are configured', async () => {
  const result = await runStep1({
    input: webhookInput(sampleCase),
    env: {},
    sources: ['SiS 4.0 Strategisch kader'],
    passages,
    fetchImpl: global.fetch,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'demo_fallback');
  assert.match(result.answer, /DEMO/);
  assert.ok(result.citations.length > 0, 'expects the EV-charging sample case to match at least one fixture passage');
  assert.equal(result.structured.disclaimer, result.structured.disclaimer); // present
  assert.ok(result.structured.disclaimer.length > 0);
});

// --- runStep1: missing-information path ---

test('runStep1 handles a case with no problem/causes/perspectives without crashing', async () => {
  const result = await runStep1({
    input: webhookInput(missingInfoCase),
    env: {},
    sources: [],
    passages,
    fetchImpl: global.fetch,
  });

  assert.equal(result.ok, true);
  assert.ok(result.structured.assumptions_missing_info.length >= 2);
  assert.ok(result.answer.includes('Aannames en ontbrekende informatie'));
});

// --- runStep1: real LLM call against a local mock server ---

function withMockLiteLLM(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        await fn(`http://127.0.0.1:${port}`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('runStep1 calls the configured LLM endpoint and parses its structured JSON reply', async () => {
  const mockReply = {
    case_summary: 'Drie gemeenten vragen provinciale bijdrage aan laadinfrastructuur in het buitengebied.',
    public_interest: { verdict: 'ja', explanation: 'Marktfalen: marktpartijen investeren niet in het buitengebied.' },
    provincial_interest: { verdict: 'ja', explanation: 'Past binnen provinciale energietransitietaak en Coalitieakkoord.' },
    reasoning: 'Beide toetsen positief; regionale schaal overstijgt individuele gemeente.',
    assumptions_missing_info: ['Standpunt netbeheerder ontbreekt.'],
  };

  await withMockLiteLLM(
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsedReq = JSON.parse(body);
        assert.ok(Array.isArray(parsedReq.messages));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(mockReply) } }],
          }),
        );
      });
    },
    async (baseUrl) => {
      const result = await runStep1({
        input: webhookInput(sampleCase),
        env: { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
        sources: ['SiS 4.0 Strategisch kader'],
        passages,
        fetchImpl: global.fetch,
      });

      assert.equal(result.mode, 'llm');
      assert.equal(result.parse_warning, false);
      assert.equal(result.structured.case_summary, mockReply.case_summary);
      assert.equal(result.structured.public_interest.verdict, 'ja');
      assert.equal(result.structured.provincial_interest.verdict, 'ja');
      assert.ok(result.citations.length > 0);
    },
  );
});

// --- runStep1: dependency failure (LLM configured but unreachable/erroring) ---

test('runStep1 falls back to demo mode when the configured LLM endpoint fails', async () => {
  await withMockLiteLLM(
    (req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    },
    async (baseUrl) => {
      const result = await runStep1({
        input: webhookInput(sampleCase),
        env: { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
        sources: [],
        passages,
        fetchImpl: global.fetch,
      });

      assert.equal(result.ok, true);
      assert.equal(result.mode, 'demo_fallback');
      assert.match(result.structured.reasoning, /LLM-aanroep mislukt/);
    },
  );
});

// --- LibreChat conversation-title requests ---

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

test('runStep1 derives the title from the real case, not the instruction, when the LibreChat titlePrompt template renders as a transcript', async () => {
  const result = await runStep1({
    input: webhookInput({
      currentMessage:
        `${TITLE_REQUEST_MARKER} Geef op basis van het onderstaande gesprek een korte titel.\n\n` +
        'User: Een gemeente wil een zwembad subsidiëren met provinciaal geld.\n' +
        'AI: ## Samenvatting casus\nDe invoer bevat een verzoek om provinciale subsidie voor een zwembad.',
    }),
    env: {},
    sources: [],
    passages,
    fetchImpl: global.fetch,
  });

  assert.equal(result.mode, 'title');
  assert.ok(!/onderstaande gesprek/i.test(result.text), 'title must not describe the instruction itself');
  assert.match(result.text, /zwembad/i);
});

test('runStep1 returns a short title (not the full analysis) for a title request, in demo mode', async () => {
  const result = await runStep1({
    input: webhookInput({
      question: `${TITLE_REQUEST_MARKER} Geef een titel voor dit gesprek.`,
      case_text: 'Een gemeente wil een zwembad subsidiëren met provinciaal geld.',
    }),
    env: {},
    sources: [],
    passages,
    fetchImpl: global.fetch,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'title');
  assert.ok(!result.text.includes('## Samenvatting casus'), 'title response must not run the full analysis');
  assert.ok(result.text.startsWith('Beleidskompas - '));
  assert.ok(result.text.split(' ').length <= 11);
  assert.equal(result.text, result.answer);
});

test('runStep1 uses the real LLM for a title request when configured', async () => {
  await withMockLiteLLM(
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '"Zwembad subsidie - provinciaal belang"' } }] }));
      });
    },
    async (baseUrl) => {
      const result = await runStep1({
        input: webhookInput({
          question: `${TITLE_REQUEST_MARKER} Geef een titel voor dit gesprek.`,
          case_text: 'Een gemeente wil een zwembad subsidiëren met provinciaal geld.',
        }),
        env: { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
        sources: [],
        passages,
        fetchImpl: global.fetch,
      });

      assert.equal(result.mode, 'title');
      assert.equal(result.text, 'Beleidskompas - Zwembad subsidie - provinciaal belang');
    },
  );
});

test('runStep1 falls back to a deterministic title if the LLM call fails during a title request', async () => {
  await withMockLiteLLM(
    (req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    },
    async (baseUrl) => {
      const result = await runStep1({
        input: webhookInput({
          question: `${TITLE_REQUEST_MARKER} Geef een titel voor dit gesprek.`,
          case_text: 'Een gemeente wil een zwembad subsidiëren met provinciaal geld.',
        }),
        env: { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
        sources: [],
        passages,
        fetchImpl: global.fetch,
      });

      assert.equal(result.ok, true);
      assert.equal(result.mode, 'title');
      assert.ok(result.text.length > 0);
    },
  );
});
