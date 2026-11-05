'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseCitationsMetaBlock,
  parseAgentJson,
  buildSystemPrompt,
  emptyStructured,
  missingParts,
  composeAnswerText,
  runStep,
} = require('../shared');
const { STEP } = require('../steps/step1');

/** A complete model reply for step 1, as the tests expect the model to give. */
function modelReply() {
  return {
    case_summary: 'Drie gemeenten vragen provinciale bijdrage aan laadinfrastructuur in het buitengebied.',
    substeps: {
      '1.1': {
        Probleem: 'Geen laadinfrastructuur in het buitengebied.',
        'Primaire oorzaken': ['Lage dichtheid'],
        Symptomen: ['Beperkte toegang'],
        'Ontbrekende perspectieven of actoren': ['Netbeheerder'],
      },
      '1.2': {
        'Toets per criterium': ['Marktfalen: aanwezig ja; marktpartijen investeren niet; verbeteringskans hoog'],
        'Bevoegdheid van de provincie': 'ja',
        'Samenvattend oordeel': 'Interventie gerechtvaardigd.',
      },
      '1.3': {
        Belanghebbenden: ['Gemeenten, overheid, belang: bereikbaarheid, invloed hoog, risico laag, bijdrage positief, niet-risicovol'],
        'Wettelijke taak van de provincie': 'ja',
        Beleidsurgentie: 'hoog',
      },
      '1.4': {
        'Publiek doel': 'Toegang tot deelmobiliteit',
        'Beleidsdoelen van Provinciale Staten': [],
        'Koppeling met de programmabegroting': [],
        'ESG-relaties': [],
        'Mate van bijdrage': 'matig',
        Toelichting: 'Beperkte bronnen.',
      },
      '1.5': {
        'Publiek belang': { oordeel: 'ja', toelichting: 'Marktfalen: marktpartijen investeren niet in het buitengebied.' },
        'Provinciaal belang': { oordeel: 'beperkt', toelichting: 'Past binnen de energietransitietaak.' },
        'Urgentie en maatschappelijke impact': 'urgentie 0.7, impact 0.6',
        Eindadvies: 'positief',
        Motivering: 'Beide toetsen positief.',
      },
    },
    reasoning: '1. Probleem benoemd.\n2. Criteria getoetst.',
    assumptions_missing_info: ['Standpunt netbeheerder ontbreekt.'],
  };
}

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
    STEP,
  );
  assert.equal(parse_warning, false);
  assert.equal(structured.case_summary, 'x');
});

test('parseAgentJson unwraps a markdown-fenced JSON response', () => {
  const { structured, parse_warning } = parseAgentJson('```json\n{"case_summary":"x","reasoning":"r"}\n```', STEP);
  assert.equal(parse_warning, false);
  assert.equal(structured.case_summary, 'x');
});

test('parseAgentJson falls back gracefully on unparsable text', () => {
  const { structured, parse_warning } = parseAgentJson('dit is geen json', STEP);
  assert.equal(parse_warning, true);
  assert.equal(structured.reasoning, 'dit is geen json');
  // The empty shape has every substep and field, so composing never fails.
  assert.equal(structured.substeps['1.5']['Publiek belang'].oordeel, 'onduidelijk');
  assert.deepEqual(structured.substeps['1.1']['Primaire oorzaken'], []);
});

test('a substep prompt file ends with the example the model is asked for', () => {
  assert.deepEqual(Object.keys(STEP.substeps[0].example), ['Probleem', 'Primaire oorzaken', 'Symptomen', 'Ontbrekende perspectieven of actoren']);
  assert.ok(!STEP.substeps[0].instruction.includes('```'), 'the example is not part of the instruction');
  assert.ok(STEP.substeps[0].instruction.endsWith('?'), 'the instruction ends with its last question');
});

test('missingParts names the parts of the answer the model left out', () => {
  const reply = modelReply();
  delete reply.substeps['1.1'].Symptomen;
  delete reply.substeps['1.5'];
  const notes = missingParts(STEP, reply);
  assert.equal(notes.length, 1 + 5);
  assert.match(notes[0], /"Symptomen" \(deelstap 1\.1\)/);
});

test('buildSystemPrompt names every substep, every field and the answer format', () => {
  const prompt = buildSystemPrompt(STEP);
  for (const needle of ['Deelstap 1.1: Probleemdefinitie', 'Deelstap 1.5: Integrale afweging', '"oordeel": "ja | nee | onduidelijk"', '"case_summary"', 'geldig JSON-object']) {
    assert.ok(prompt.includes(needle), `expected the prompt to include "${needle}"`);
  }
});

test('composeAnswerText includes a heading per substep, the verdicts, and the fixed sections', () => {
  const text = composeAnswerText(STEP, modelReply(), [{ rank: 1, filename: 'SiS 4.0 Strategisch kader', score: 0.2 }]);
  for (const needle of [
    '### Samenvatting casus',
    '### Probleemdefinitie',
    '### Overheidsinterventie',
    '### Stakeholderanalyse',
    '### Provinciaal doel',
    '### Publiek belang',
    '### Provinciaal belang',
    '### Integrale afweging',
    '### Redenering',
    '### Aannames en ontbrekende informatie',
    '### Bronnen',
    'ondersteunend concept',
  ]) {
    assert.ok(text.includes(needle), `expected answer text to include "${needle}"`);
  }
  assert.match(text, /^\*\*Primaire oorzaken:\*\*\n- Lage dichtheid$/m, 'a list field is a labelled bullet list');
  assert.match(text, /^\*\*Eindadvies:\*\* positief$/m, 'a choice field is a labelled value');
});

test('composeAnswerText renders markdown that also reads well in LibreChat itself', () => {
  const text = composeAnswerText(STEP, modelReply(), [{ rank: 1, filename: 'SiS 4.0 Strategisch kader', score: 0.207 }]);

  assert.match(text, /^\*\*Stap 1 · Publiek en provinciaal belang\*\*$/m, 'step label on the first line');
  assert.match(text, /^### Publiek belang$/m, 'sections use markdown headings');
  assert.match(text, /^\*\*Oordeel:\*\* ja$/m, 'verdict is a bold label');
  assert.match(text, /^1\. \*\*SiS 4.0 Strategisch kader\*\* - relevantie 0\.207$/m, 'sources are listed with their relevance');
  assert.ok(!/^## /m.test(text), 'no h2 headings left (they render oversized in a chat bubble)');
});

test('composeAnswerText says so when no source passed the relevance threshold, and copes with a bare reply', () => {
  const text = composeAnswerText(STEP, { case_summary: 'X' }, []);
  assert.match(text, /### Bronnen\n- geen bronnen boven de relevantiedrempel/);
  assert.match(text, /^\*\*Oordeel:\*\* onduidelijk$/m, 'a missing verdict reads as unclear');
});

// --- A local stand-in for LiteLLM ---

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

/** Runs `fn(baseUrl)` against a LiteLLM stand-in that answers every call
 *  with `reply` (an object, sent as the model's JSON text). */
function withModelReply(reply, fn) {
  return withMockLiteLLM((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
    });
  }, fn);
}

test('runStep text field carries the same citations as the structured citations field', async () => {
  await withModelReply(modelReply(), async (baseUrl) => {
    const result = await runStep(STEP, {
      input: webhookInput(sampleCase),
      env: { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
      passages,
      fetchImpl: global.fetch,
    });

    assert.ok(result.citations.length > 0, 'expects the EV-charging sample case to match at least one fixture passage');
    const parsed = parseCitationsMetaBlock(result.text);
    assert.deepEqual(parsed.citations, result.citations);
    assert.deepEqual(parsed.retrieval_trace, result.retrieval_trace);
    // The clean `answer` field (used by direct/hoofdagent JSON consumers)
    // never carries the meta block.
    assert.equal(result.answer, parsed.displayText);
  });
});

test('runStep returns a clear ok:false error for a wrong webhook token (never throws)', async () => {
  // Returned rather than thrown: n8n's `responseNode` webhook mode can turn a
  // thrown Code-node error into a bare empty 200 instead of a visible error
  // (observed against a live n8n 2.25.7 instance), which would silently
  // swallow the rejection. A normal ok:false item always reaches the caller.
  const result = await runStep(STEP, {
    input: webhookInput(sampleCase, 'wrong-token'),
    env: { BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN: 'expected-token' },
    passages,
    fetchImpl: global.fetch,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unauthorized webhook token/);
});

test('runStep accepts the request the main agent sends (case_text, findings, Authorization bearer)', async () => {
  await withModelReply(modelReply(), async (baseUrl) => {
  const result = await runStep(STEP, {
    input: {
      body: {
        step_id: 'stap1',
        case_text: sampleCase.case_text,
        findings: '**Stap 1 · Publiek en provinciaal belang · 1.1 Probleemdefinitie**\n\n### Samenvatting casus\n' + sampleCase.case_text,
        sessionId: 'conv-123',
        userId: 'user-456',
      },
      headers: { authorization: 'Bearer expected-token' },
    },
    env: { N8N_WEBHOOK_TOKEN: 'expected-token', LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
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
});

test('runStep refuses to answer without a language model, with a message for the chat', async () => {
  const result = await runStep(STEP, {
    input: webhookInput(sampleCase),
    env: {},
    passages,
    fetchImpl: global.fetch,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'No language model configured');
  assert.match(result.text, /geen taalmodel geconfigureerd/);
});

test('runStep handles a very short case without crashing', async () => {
  await withModelReply(modelReply(), async (baseUrl) => {
    const result = await runStep(STEP, {
      input: webhookInput(shortCase),
      env: { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
      passages,
      fetchImpl: global.fetch,
    });

    assert.equal(result.ok, true);
    assert.ok(result.structured.disclaimer.length > 0);
    assert.ok(result.answer.includes('Aannames en ontbrekende informatie'));
  });
});

test('runStep calls the configured LLM endpoint and parses its structured JSON reply', async () => {
  const mockReply = modelReply();

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
        passages,
        fetchImpl: global.fetch,
      });

      assert.equal(result.ok, true);
      assert.equal(result.parse_warning, false);
      assert.equal(result.structured.case_summary, mockReply.case_summary);
      assert.equal(result.structured.substeps['1.5']['Publiek belang'].oordeel, 'ja');
      assert.equal(result.structured.substeps['1.5']['Provinciaal belang'].oordeel, 'beperkt');
      assert.match(result.answer, /^### Publiek belang\n\*\*Oordeel:\*\* ja$/m);
      assert.ok(result.citations.length > 0);
    },
  );
});

test('runStep reports a failing language model with a message for the chat', async () => {
  await withMockLiteLLM(
    (req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    },
    async (baseUrl) => {
      const result = await runStep(STEP, {
        input: webhookInput(sampleCase),
        env: { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
        passages,
        fetchImpl: global.fetch,
      });

      assert.equal(result.ok, false);
      assert.equal(result.error, 'Language model call failed');
      assert.match(result.text, /kon het taalmodel niet bereiken/);
    },
  );
});
