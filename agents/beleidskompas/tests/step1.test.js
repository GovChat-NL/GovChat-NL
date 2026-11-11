'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { parseCitationsMetaBlock, buildReportPrompt, composeReport, askedStep, runStep } = require('../shared');
const { STEP } = require('../steps/step1');

/** A model reply for substep 1.5, in the markdown the report prompt asks for. */
const MODEL_REPLY = [
  '### Samenvatting casus',
  'Drie gemeenten vragen provinciale bijdrage aan laadinfrastructuur in het buitengebied.',
  '',
  '### Publiek belang',
  '**Oordeel:** ja',
  '',
  'Marktfalen: marktpartijen investeren niet in het buitengebied.',
  '',
  '### Provinciaal belang',
  '**Oordeel:** beperkt',
  '',
  'Past binnen de energietransitietaak.',
  '',
  '### Integrale afweging',
  '**Eindadvies:** positief',
  '',
  '### Redenering',
  '1. Probleem benoemd.',
  '2. Criteria getoetst.',
  '',
  '### Aannames en ontbrekende informatie',
  '- Standpunt netbeheerder ontbreekt.',
].join('\n');

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

test('a substep prompt file holds the instruction and, after "Antwoord in deze vorm:", the answer format', () => {
  const substep = STEP.substeps[0];
  assert.ok(substep.format.startsWith('### Probleemdefinitie'), 'the answer format starts with the heading of the substep');
  assert.ok(substep.format.includes('**Primaire oorzaken:**'));
  assert.ok(!substep.instruction.includes('Antwoord in deze vorm'), 'the answer format is not part of the instruction');
  assert.ok(substep.instruction.endsWith('?'), 'the instruction ends with its last question');
});

test('buildReportPrompt holds every substep, its answer format and the fixed sections', () => {
  const prompt = buildReportPrompt(STEP);
  for (const needle of [
    'Deelstap 1.1: Probleemdefinitie',
    'Deelstap 1.5: Integrale afweging',
    '### Samenvatting casus',
    '### Probleemdefinitie',
    '### Publiek belang\n**Oordeel:** ja | nee | onduidelijk',
    '### Redenering',
    '### Aannames en ontbrekende informatie',
  ]) {
    assert.ok(prompt.includes(needle), `expected the prompt to include "${needle}"`);
  }
  assert.ok(!/\{\{\w+\}\}/.test(prompt), 'every placeholder is filled in');
});

test('buildReportPrompt for one substep holds only the answer format of that substep', () => {
  const prompt = buildReportPrompt(askedStep(STEP, '1.1'));
  assert.ok(prompt.includes('### Probleemdefinitie'));
  assert.ok(!prompt.includes('### Publiek belang'));
});

test('composeReport puts the step heading above the reply and the sources and disclaimer below it', () => {
  const text = composeReport(askedStep(STEP, '1.5'), MODEL_REPLY, [{ rank: 1, filename: 'SiS 4.0 Strategisch kader', score: 0.207 }]);
  assert.match(text, /^\*\*Stap 1 · Publiek en provinciaal belang · 1\.5 Integrale afweging\*\*$/m, 'step label on the first line');
  assert.ok(text.includes(MODEL_REPLY), 'the reply is kept as it is');
  assert.match(text, /^### Bronnen\n1\. \*\*SiS 4.0 Strategisch kader\*\* - relevantie 0\.207$/m, 'sources are listed with their relevance');
  assert.match(text, /\n---\n.*ondersteunend concept/, 'the disclaimer comes last, after a rule');
});

test('composeReport unwraps a reply in a code block, reads an empty reply as unknown, and says when there are no sources', () => {
  assert.ok(composeReport(STEP, '```markdown\n### Samenvatting casus\nX\n```', []).includes('\n\n### Samenvatting casus\nX\n\n'));
  const empty = composeReport(STEP, '', []);
  assert.match(empty, /\*\*\n\nonbekend\n\n/);
  assert.match(empty, /### Bronnen\n- geen bronnen boven de relevantiedrempel/);
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
 *  with `reply` as the model's text. */
function withModelReply(reply, fn) {
  return withMockLiteLLM((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  }, fn);
}

test('runStep text field carries the same citations as the structured citations field', async () => {
  await withModelReply(MODEL_REPLY, async (baseUrl) => {
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
    // The clean `answer` field (used by direct/orchestrator JSON consumers)
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

test('runStep accepts the request the orchestrator sends (case_text, findings, Authorization bearer)', async () => {
  await withModelReply(MODEL_REPLY, async (baseUrl) => {
  const result = await runStep(STEP, {
    input: {
      body: {
        step_id: 'stap1',
        case_text: sampleCase.case_text,
        findings: '**Stap 1 · Publiek en provinciaal belang · 1.1 Probleemdefinitie**\n\n### Samenvatting casus\n' + sampleCase.case_text,
        asked_from: '3.2',
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
  const meta = parseCitationsMetaBlock(result.text);
  assert.equal(meta.displayText, result.answer);
  // The page reads from the meta block which step answered and where the
  // user asked from.
  assert.equal(meta.agent, 'stap1');
  assert.equal(meta.asked_from, '3.2');
  assert.equal(result.asked_from, '3.2');
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
  await withModelReply(MODEL_REPLY, async (baseUrl) => {
    const result = await runStep(STEP, {
      input: webhookInput(shortCase),
      env: { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
      passages,
      fetchImpl: global.fetch,
    });

    assert.equal(result.ok, true);
    assert.ok(result.answer.includes('Aannames en ontbrekende informatie'));
  });
});

test('runStep sends the report prompt to the configured LLM endpoint and returns the report', async () => {
  let systemPrompt = '';
  await withMockLiteLLM(
    (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        systemPrompt = JSON.parse(body).messages[0].content;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: MODEL_REPLY } }] }));
      });
    },
    async (baseUrl) => {
      const result = await runStep(STEP, {
        input: webhookInput({ ...sampleCase, substep_id: '1.5' }),
        env: { LITELLM_URL: baseUrl, LITELLM_API_KEY: 'test-key' },
        passages,
        fetchImpl: global.fetch,
      });

      assert.equal(result.ok, true);
      assert.equal(result.mode, 'report');
      assert.ok(systemPrompt.includes('### Publiek belang\n**Oordeel:** ja | nee | onduidelijk'), 'the model gets the answer format of the substep');
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
