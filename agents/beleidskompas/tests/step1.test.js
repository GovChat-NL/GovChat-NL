'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { parseCitationsMetaBlock, parseAgentJson, runStep } = require('../shared');
const { STEP, emptyStructured, buildDemoFallbackStructured, composeAnswerText } = require('../steps/step1');

const passages = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'source-passages.json'), 'utf-8'),
).passages;
const sampleCase = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-case.json'), 'utf-8'));
const shortCase = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-case-short.json'), 'utf-8'),
);

function webhookInput(body, token) {
  return {
    body,
    headers: token ? { 'x-govchat-token': token } : {},
  };
}

test('parseAgentJson parses a plain JSON response', () => {
  const { structured, parse_warning } = parseAgentJson(
    JSON.stringify({
      case_summary: 'x',
      public_interest: { verdict: 'ja', explanation: 'y' },
      provincial_interest: { verdict: 'ja', explanation: 'z' },
      reasoning: 'r',
      assumptions_missing_info: [],
    }),
    emptyStructured,
  );
  assert.equal(parse_warning, false);
  assert.equal(structured.case_summary, 'x');
});

test('parseAgentJson unwraps a markdown-fenced JSON response', () => {
  const { structured, parse_warning } = parseAgentJson('```json\n{"case_summary":"x","reasoning":"r"}\n```', emptyStructured);
  assert.equal(parse_warning, false);
  assert.equal(structured.case_summary, 'x');
});

test('parseAgentJson falls back gracefully on unparsable text', () => {
  const { structured, parse_warning } = parseAgentJson('dit is geen json', emptyStructured);
  assert.equal(parse_warning, true);
  assert.equal(structured.reasoning, 'dit is geen json');
});

test('buildDemoFallbackStructured clearly labels demo output', () => {
  const structured = buildDemoFallbackStructured({
    question: sampleCase.question,
    caseText: sampleCase.case_text,
    citations: [],
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

test('runStep1 text field carries the same citations as the structured citations field', async () => {
  const result = await runStep(STEP, {
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

test('runStep1 returns a clear ok:false error for a wrong webhook token (never throws)', async () => {
  // Returned rather than thrown: n8n's `responseNode` webhook mode can turn a
  // thrown Code-node error into a bare empty 200 instead of a visible error
  // (observed against a live n8n 2.25.7 instance), which would silently
  // swallow the rejection. A normal ok:false item always reaches the caller.
  const result = await runStep(STEP, {
    input: webhookInput(sampleCase, 'wrong-token'),
    env: { BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN: 'expected-token' },
    sources: [],
    passages,
    fetchImpl: global.fetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unauthorized webhook token/);
});

test('runStep1 accepts the request the main agent sends (question, case_text, sources, Authorization bearer)', async () => {
  const result = await runStep(STEP, {
    input: {
      body: {
        step_id: 'stap1',
        question: sampleCase.case_text,
        case_text: sampleCase.case_text,
        sources: ['Bron A', 'Bron B'],
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

test('runStep1 uses the demo fallback when no LLM credentials are configured', async () => {
  const result = await runStep(STEP, {
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

test('runStep1 handles a very short case without crashing', async () => {
  const result = await runStep(STEP, {
    input: webhookInput(shortCase),
    env: {},
    sources: [],
    passages,
    fetchImpl: global.fetch,
  });

  assert.equal(result.ok, true);
  assert.ok(result.structured.assumptions_missing_info.length >= 1);
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
      const result = await runStep(STEP, {
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

test('runStep1 falls back to demo mode when the configured LLM endpoint fails', async () => {
  await withMockLiteLLM(
    (req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    },
    async (baseUrl) => {
      const result = await runStep(STEP, {
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
