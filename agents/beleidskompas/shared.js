'use strict';

/**
 * What every Beleidskompas workflow shares: reading the caller's token,
 * sending HTTP requests and calling the language model through LiteLLM,
 * scoring the source passages, the citations block that travels with a
 * chat message, and LibreChat's conversation-title request. The step
 * definitions in steps/ and main-agent.js build on these; generate-workflow.js
 * copies the functions a workflow needs into its Code node.
 */

const fs = require('node:fs');
const path = require('node:path');

// --- The prompt texts ---
//
// The texts the model gets live as files in prompts/: the template of the
// system prompt, the rules that apply to every step, and per step the role
// of the model and one instruction per substep. They are read here, in
// Node; generate-workflow.js pastes them as text into the workflows, so n8n
// never reads a file.

const PROMPTS_DIR = path.join(__dirname, 'prompts');

/** The text of a file in prompts/, without surrounding whitespace. */
function readPrompt(relativePath) {
  return fs.readFileSync(path.join(PROMPTS_DIR, relativePath), 'utf-8').trim();
}

/** A substep's prompt file: the instruction, and at the end, after
 *  "Antwoord in deze vorm:", a ```json block with the example answer. The
 *  example is what the model is asked to return and what the code uses to
 *  check and show the answer, so it has to be valid JSON. */
function readSubstepPrompt(relativePath) {
  const text = readPrompt(relativePath);
  const match = /\n```json\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  if (!match) throw new Error(`${relativePath} has no \`\`\`json example at the end`);
  let example;
  try {
    example = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`${relativePath}: the example is not valid JSON (${err.message})`);
  }
  const instruction = text.slice(0, match.index).replace(/\n*Antwoord in deze vorm:\s*$/, '').trim();
  return { instruction, example };
}

const SYSTEM_PROMPT_TEMPLATE = readPrompt('system-prompt.md');
const CONVERSATION_PROMPT_TEMPLATE = readPrompt('conversation-prompt.md');

// One rule per line in rules.md.
const COMMON_RULES = readPrompt('rules.md')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const DISCLAIMER =
  'Dit resultaat is een ondersteunend concept ten behoeve van de voorbereiding van beleidsadvies. ' +
  'Het is geen besluit en vervangt geen menselijke afweging of besluitvorming.';

// --- The caller's token ---

function extractSuppliedToken(headers) {
  const h = headers && typeof headers === 'object' ? headers : {};
  const direct = String(h['x-govchat-token'] || h['X-Govchat-Token'] || '').trim();
  if (direct) return direct;
  // The n8n-openai-bridge (LibreChat's real custom-endpoint pipeline) sends the
  // shared webhook secret as a standard Authorization bearer token instead of
  // the x-govchat-token header used by direct/manual webhook calls.
  const authHeader = String(h['authorization'] || h['Authorization'] || '').trim();
  if (/^Bearer\s/i.test(authHeader)) {
    return authHeader.slice(authHeader.indexOf(' ') + 1).trim();
  }
  return '';
}

// --- The message as the Beleidskompas page composes it ---

// The page can only send text, so it puts everything a step needs in one
// message with a label at the start of each part (composePrompt in
// overlay/src/apps/beleidskompas/beleidskompas-api.js writes these): the
// step or substep, the case as the user described it, the reports so far,
// the conversation about this substep, and the message the user typed just
// now. A message that was typed means a conversation turn. Without a
// message, the step writes the report of the substep.
const PAGE_MESSAGE_LABELS = {
  step: 'Stap:',
  substep: 'Deelstap:',
  caseText: 'Casus:',
  findings: 'Eerdere bevindingen:',
  conversation: 'Gesprek:',
  message: 'Bericht:',
};

/** Splits a message from the page into its parts (see PAGE_MESSAGE_LABELS;
 *  every part but the first two can span many lines). A substep id also
 *  names its step: 1.3 is a substep of stap1, so a message with only a
 *  substep still gets its step id. A part whose label is missing is ''. A
 *  message without any label is returned whole as the case text, so a direct
 *  webhook call with a plain case description keeps working. */
function parsePageMessage(text) {
  const parts = { stepId: '', substepId: '', caseText: '', findings: '', conversation: '', message: '' };
  const unlabeled = [];
  let current = null;

  for (const line of String(text || '').split('\n')) {
    const key = Object.keys(PAGE_MESSAGE_LABELS).find((k) => line.startsWith(PAGE_MESSAGE_LABELS[k]));
    if (key) {
      current = key;
      parts[key] = line.slice(PAGE_MESSAGE_LABELS[key].length).trim();
    } else if (current) {
      parts[current] += '\n' + line;
    } else {
      unlabeled.push(line);
    }
  }

  if (!current) parts.caseText = unlabeled.join('\n');
  const substepMatch = /^(\d+)\.\d+/.exec(parts.substep || '');
  parts.substepId = substepMatch ? substepMatch[0] : '';
  const stepMatch = /^([A-Za-z0-9_-]+)/.exec(parts.step || '');
  parts.stepId = stepMatch ? stepMatch[1].toLowerCase() : substepMatch ? `stap${substepMatch[1]}` : '';
  delete parts.step;
  delete parts.substep;
  for (const key of Object.keys(parts)) parts[key] = String(parts[key] || '').trim();
  return parts;
}

// --- Scoring the source passages ---

function tokenizePolicyText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2);
}

function selectSources(passages, queryBlob, ragSettings) {
  const rag = Object.assign({ algorithm: 'hybrid', top_k: 3, min_score: 0.08 }, ragSettings || {});
  const queryWords = [...new Set(tokenizePolicyText(queryBlob))];

  const scored = (Array.isArray(passages) ? passages : [])
    .map((doc) => {
      const text = String(doc.text || '').trim();
      if (!text) return null;
      const words = tokenizePolicyText(text);
      if (!words.length) return null;

      const wordSet = new Set(words);
      const overlap = queryWords.filter((w) => wordSet.has(w)).length;
      const overlapRatio = queryWords.length ? overlap / queryWords.length : 0;
      const density = overlap / Math.max(24, words.length);
      const lowerText = text.toLowerCase();
      const needleHits = queryWords.reduce((acc, w) => (lowerText.includes(w) ? acc + 1 : acc), 0);
      const needleScore = queryWords.length ? needleHits / queryWords.length : 0;
      const haystackScore = overlapRatio * 0.7 + density * 0.3;

      let score = needleScore * 0.55 + haystackScore * 0.45;
      if (rag.algorithm === 'needle') score = needleScore;
      if (rag.algorithm === 'haystack') score = haystackScore;

      return {
        id: doc.id,
        filename: doc.filename,
        tags: Array.isArray(doc.tags) ? doc.tags : [],
        score,
        preview: text.slice(0, 420),
      };
    })
    .filter(Boolean)
    .filter((d) => d.score >= Number(rag.min_score || 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(rag.top_k || 3)))
    .map((d, i) => ({ rank: i + 1, ...d, score: Number(d.score.toFixed(4)) }));

  return {
    citations: scored,
    retrieval_trace: {
      algorithm: rag.algorithm,
      top_k: rag.top_k,
      min_score: rag.min_score,
      matched_docs: scored.length,
    },
  };
}

// --- Citations side-channel for the LibreChat chat pipeline ---
//
// n8n-openai-bridge only forwards the plain response TEXT to LibreChat
// (content/text/output/message), not our richer citations/retrieval_trace
// JSON - so when Beleidskompas runs as a real LibreChat custom endpoint,
// that data would otherwise be lost. Instead of standing up a side-channel
// store, it's appended to the message text as a trailing HTML comment:
// invisible in any markdown renderer, and parsed back out client-side
// (beleidskompas-api.js in the overlay has a matching parser) for the
// citation-preview UI. The `answer`/`structured`/`citations` fields
// returned by runStep1 stay clean (used as-is by direct webhook callers
// and the hoofdagent JSON response).

const CITATIONS_META_MARKER = 'BELEIDSKOMPAS-META';
const CITATIONS_META_LABEL = 'beleidskompas-meta';

/** Hangt de citaten als markdown-linkdefinitie achter het bericht.
 *
 *  Een HTML-commentaar leek de voor de hand liggende plek, maar LibreChat
 *  toont die gewoon als tekst (de markdown-renderer escapet ruwe HTML), dus
 *  stond er een blok JSON onder elk antwoord. Een linkdefinitie wordt door
 *  iedere CommonMark-renderer opgeslokt en levert geen uitvoer op, en de
 *  payload staat base64 zodat aanhalingstekens en accenten de regel niet
 *  kunnen breken. */
function appendCitationsMetaBlock(text, citations, retrieval_trace) {
  const payload = JSON.stringify({ citations: citations || [], retrieval_trace: retrieval_trace || null });
  const encoded = Buffer.from(payload, 'utf8').toString('base64');
  return `${text}\n\n[${CITATIONS_META_LABEL}]: data:application/json;base64,${encoded}`;
}

/** Client-side counterpart of appendCitationsMetaBlock: splits a message's
 *  displayed text from its embedded citations/retrieval_trace, if present.
 *  Safe to call on text that never had a meta block (returns it unchanged). */
function parseCitationsMetaBlock(text) {
  const raw = String(text || '');
  const empty = { displayText: raw.trim(), citations: [], retrieval_trace: null };

  const defMarker = `[${CITATIONS_META_LABEL}]: data:application/json;base64,`;
  const defIdx = raw.lastIndexOf(defMarker);
  if (defIdx !== -1) {
    const encoded = raw.slice(defIdx + defMarker.length).split('\n')[0].trim();
    const displayText = raw.slice(0, defIdx).trim();
    try {
      const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      return {
        displayText,
        citations: Array.isArray(parsed.citations) ? parsed.citations : [],
        retrieval_trace: parsed.retrieval_trace || null,
      };
    } catch (_) {
      // Onleesbare payload: liever de tekst tonen dan het bericht verliezen.
      return empty;
    }
  }

  // Berichten van voor de overstap naar een linkdefinitie dragen de citaten
  // nog als HTML-commentaar; die blijven leesbaar.
  const marker = `<!--${CITATIONS_META_MARKER}:`;
  const startIdx = raw.lastIndexOf(marker);
  if (startIdx === -1) return empty;

  const endIdx = raw.indexOf('-->', startIdx);
  if (endIdx === -1) return empty;

  const jsonText = raw.slice(startIdx + marker.length, endIdx);
  const displayText = (raw.slice(0, startIdx) + raw.slice(endIdx + 3)).trim();
  try {
    const parsed = JSON.parse(jsonText);
    return {
      displayText,
      citations: Array.isArray(parsed.citations) ? parsed.citations : [],
      retrieval_trace: parsed.retrieval_trace || null,
    };
  } catch (_) {
    // Zelfde afweging als hierboven: liever de tekst tonen dan het bericht
    // verliezen op een kapot meta-blok.
    return empty;
  }
}

// --- LiteLLM HTTP call (mirrors GovChat Orchestrator's requestRaw pattern) ---

function requestRaw(url, opts, hasFetch, fetchImpl, httpModule, httpsModule, urlModule) {
  if (hasFetch) {
    return fetchImpl(url, opts).then(async (res) => ({
      ok: res.ok,
      status: Number(res.status || 0),
      text: await res.text(),
    }));
  }

  return new Promise((resolve, reject) => {
    try {
      const target = new urlModule.URL(String(url));
      const lib = target.protocol === 'https:' ? httpsModule : httpModule;
      const method = String((opts && opts.method) || 'GET').toUpperCase();
      const headers = (opts && opts.headers) || {};
      const body = typeof (opts && opts.body) === 'string' ? opts.body : '';

      const req = lib.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: target.pathname + target.search,
          method,
          headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body, 'utf8') } : {}) },
        },
        (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(Buffer.from(d)));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = Number(res.statusCode || 0);
            resolve({ ok: status >= 200 && status < 300, status, text });
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function callLiteLLM({ baseUrl, apiKey, model, systemPrompt, userPrompt, timeoutMs, fetchImpl, httpModule, httpsModule, urlModule }) {
  const hasFetch = typeof fetchImpl === 'function';
  const url = String(baseUrl || '').replace(/\/$/, '') + '/v1/chat/completions';
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    // No `temperature` override: some model families (e.g. reasoning-tier
    // models) reject any value other than the default (1) and error with a
    // 400. Deterministic-ish behavior is enforced via the system prompt
    // instead ("Redeneer stap voor stap", "geen aannames").
  });

  const controller = hasFetch && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await requestRaw(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
        body,
        signal: controller ? controller.signal : undefined,
      },
      hasFetch,
      fetchImpl,
      httpModule,
      httpsModule,
      urlModule,
    );
    if (!res.ok) {
      const err = new Error('LiteLLM HTTP ' + res.status);
      err.status = res.status;
      err.body = res.text;
      throw err;
    }
    let payload = {};
    try {
      payload = JSON.parse(res.text || '{}');
    } catch (_) {
      payload = {};
    }
    const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
    return String(content || '').trim();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- LibreChat conversation-title requests ---
//
// LibreChat generates each conversation's title by sending an extra request
// to the SAME custom endpoint/model with an instruction to summarize the
// conversation in a few words (see librechat.yaml's `titlePrompt`, which
// embeds TITLE_REQUEST_MARKER so it's reliably recognizable here). Without
// this, Beleidskompas ran its normal 5-section analysis on that instruction
// too (verified live), producing an absurd, oversized "title" instead of a
// short one.

const TITLE_REQUEST_MARKER = '__BELEIDSKOMPAS_TITLE_REQUEST__';
const TITLE_PREFIX = 'Beleidskompas - ';

function isTitleRequest(text) {
  return String(text || '').includes(TITLE_REQUEST_MARKER);
}

/** Deterministic title when no LLM is configured, or the LLM call fails:
 *  strips the marker/markdown and takes the first few words. */
function buildFallbackTitle(text) {
  const cleaned = String(text || '')
    .replaceAll(TITLE_REQUEST_MARKER, '')
    .replace(/[#*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Beleidskompas casus';
  const words = cleaned.split(' ').slice(0, 8);
  const joined = words.join(' ');
  return joined.length < cleaned.length ? joined + '…' : joined;
}

/** librechat.yaml's titlePrompt renders as our instruction followed by the
 *  real conversation via the "User: ...\nAI: ..." transcript format (the
 *  `{convo}` placeholder, filled in by @librechat/agents before this ever
 *  reaches us). Extracting just the user's case text keeps the title (and
 *  its deterministic fallback) focused on the actual case instead of the
 *  instruction sentence that precedes it. Falls back to the input unchanged
 *  when that format isn't present (e.g. direct webhook/test calls). */
function extractConvoCaseText(text) {
  const s = String(text || '');
  const userIdx = s.indexOf('User:');
  if (userIdx === -1) return s.trim();
  const afterUser = s.slice(userIdx + 'User:'.length);
  const aiIdx = afterUser.indexOf('\nAI:');
  return (aiIdx === -1 ? afterUser : afterUser.slice(0, aiIdx)).trim();
}

/** Handles a title-generation request: returns a short title instead of
 *  running the full step-1 analysis. Never throws - falls back to a
 *  deterministic title on any LLM error, since a broken title must never
 *  break the actual conversation. */
async function buildTitleResponse({ titleSource, env, fetchImpl, httpModule, httpsModule, urlModule }) {
  const source = extractConvoCaseText(String(titleSource || '').replaceAll(TITLE_REQUEST_MARKER, ''));
  const litellmUrl = String((env && env.LITELLM_URL) || '').trim();
  const litellmApiKey = String((env && (env.LITELLM_API_KEY || env.OPENAI_API_KEY)) || '').trim();

  let title = '';
  if (litellmUrl && litellmApiKey && source) {
    try {
      const raw = await callLiteLLM({
        baseUrl: litellmUrl,
        apiKey: litellmApiKey,
        model: (env && env.BELEIDSKOMPAS_MODEL) || 'govchat-default',
        systemPrompt:
          'Je genereert uitsluitend een korte titel (maximaal 6 woorden) voor een gesprek, in het Nederlands. ' +
          'Geen opmaak, geen aanhalingstekens, geen toelichting: alleen de titel zelf.',
        userPrompt: source.slice(0, 2000),
        timeoutMs: 20000,
        fetchImpl,
        httpModule,
        httpsModule,
        urlModule,
      });
      const wrapperChars = new Set(['"', "'", '#', '*', '_']);
      let start = 0;
      let end = raw.length;
      while (start < end && (wrapperChars.has(raw[start]) || /\s/.test(raw[start]))) start += 1;
      while (end > start && (wrapperChars.has(raw[end - 1]) || /\s/.test(raw[end - 1]))) end -= 1;
      title = raw.slice(start, end);
    } catch (_) {
      // A failed title must never break the conversation: fall through to
      // the deterministic title below.
      title = '';
    }
  }
  if (!title) title = buildFallbackTitle(source);
  // Prefixed so Beleidskompas conversations are visually grouped in
  // LibreChat's conversation-list sidebar, alongside other endpoints/agents.
  title = TITLE_PREFIX + title;

  return { ok: true, step_id: null, mode: 'title', answer: title, text: title };
}

// --- A step as a list of substeps ---
//
// A step definition (see steps/) is data: its id, number and title, the
// sentence that tells the model its role, and its substeps. A substep has
// an instruction for the model and an example of the answer, both from its
// file in prompts/. The example is the contract: its keys are the parts of
// the answer (and the labels on the page), and the shape of each value says
// what it is: a string is text, an array is a list, an object with
// "oordeel" is a verdict, shown on the page as a heading of its own with a
// badge. From that the functions below make the system prompt, the shape of
// an empty answer, and the answer text with a heading per substep.

function isVerdict(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'oordeel' in value;
}

/** The answer format the model is asked for: the fixed fields, and per
 *  substep the example from its prompt file. */
function answerFormat(step) {
  return JSON.stringify(
    {
      case_summary: 'korte, feitelijke samenvatting van de casus',
      substeps: Object.fromEntries(step.substeps.map((substep) => [substep.id, substep.example])),
      reasoning: 'de redenering, stap voor stap',
      assumptions_missing_info: ['aannames en ontbrekende informatie'],
    },
    null,
    2,
  );
}

/** Fills a prompt template with what a step provides: its role, its
 *  substeps with their instructions, the rules, and the answer format. */
function fillTemplate(template, step) {
  const values = {
    role: step.role,
    substeps: step.substeps.map((substep) => `Deelstap ${substep.id}: ${substep.title}\n${substep.instruction}`).join('\n\n'),
    rules: COMMON_RULES.map((rule) => '- ' + rule).join('\n'),
    answer_format: answerFormat(step),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in values ? values[key] : match));
}

/** The system prompt for writing the report of a step (prompts/system-prompt.md). */
function buildSystemPrompt(step) {
  return fillTemplate(SYSTEM_PROMPT_TEMPLATE, step);
}

/** The system prompt for answering a message about a step's report
 *  (prompts/conversation-prompt.md). */
function buildConversationPrompt(step) {
  return fillTemplate(CONVERSATION_PROMPT_TEMPLATE, step);
}

/** The value of a part of the answer when nothing can be said about it,
 *  in the shape its example has. */
function emptyValue(example) {
  if (Array.isArray(example)) return [];
  if (isVerdict(example)) return { oordeel: 'onduidelijk', toelichting: '' };
  return '';
}

/** The answer when the model's reply is not JSON: every part empty, the
 *  raw reply kept as the reasoning. */
function emptyStructured(step, rawText) {
  return {
    case_summary: '',
    substeps: Object.fromEntries(
      step.substeps.map((substep) => [
        substep.id,
        Object.fromEntries(Object.entries(substep.example).map(([label, example]) => [label, emptyValue(example)])),
      ]),
    ),
    reasoning: rawText || 'Het taalmodel gaf geen bruikbare output terug.',
    assumptions_missing_info: ['Kon het modelantwoord niet als JSON verwerken; ruwe tekst is opgenomen in het redeneerveld.'],
  };
}

/** The parts of the answer the model left out, as notes for the reader. */
function missingParts(step, structured) {
  const answers = structured && structured.substeps && typeof structured.substeps === 'object' ? structured.substeps : {};
  return step.substeps.flatMap((substep) => {
    const given = answers[substep.id] && typeof answers[substep.id] === 'object' ? answers[substep.id] : {};
    return Object.keys(substep.example)
      .filter((label) => !(label in given))
      .map((label) => `Het taalmodel gaf geen antwoord voor "${label}" (deelstap ${substep.id}).`);
  });
}

// The answer text is markdown: a heading per section. It is not only what
// the Beleidskompas page shows; LibreChat stores it as the chat message, so
// it has to read well on its own, sources included.

function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  const text = String(value || '').trim();
  return text ? [text] : [];
}

function bullets(items) {
  return items.length ? items.map((item) => '- ' + item).join('\n') : '- geen';
}

function section(title, body) {
  return `### ${title}\n${body}`;
}

/** One part of a substep's answer under the substep heading. `alone`: it is
 *  the substep's only part, so it needs no label. */
function partText(label, example, value, alone) {
  if (Array.isArray(example)) return `**${label}:**\n${bullets(asList(value))}`;
  const text = String(value == null ? '' : value).trim() || 'onbekend';
  return alone ? text : `**${label}:** ${text}`;
}

/** The sections of one substep: a verdict gets a heading of its own with an
 *  "**Oordeel:**" line (the page turns that into a badge); the other parts
 *  go together under the substep's heading, in the order of the example. */
function substepSections(substep, answer) {
  const given = answer && typeof answer === 'object' ? answer : {};
  const parts = Object.entries(substep.example);
  const verdictSections = parts
    .filter(([, example]) => isVerdict(example))
    .map(([label]) => {
      const value = isVerdict(given[label]) ? given[label] : {};
      const explanation = String(value.toelichting || '').trim();
      return section(label, `**Oordeel:** ${String(value.oordeel || 'onduidelijk')}` + (explanation ? `\n\n${explanation}` : ''));
    });
  const others = parts.filter(([, example]) => !isVerdict(example));
  if (!others.length) return verdictSections;
  return [...verdictSections, section(substep.title, others.map(([label, example]) => partText(label, example, given[label], others.length === 1)).join('\n\n'))];
}

function sourcesText(citations) {
  if (!citations.length) return '- geen bronnen boven de relevantiedrempel';
  return citations
    .map((c, idx) => {
      const score = Number(c && c.score);
      const relevance = Number.isFinite(score) && score > 0 ? ` - relevantie ${score.toFixed(3)}` : '';
      return `${idx + 1}. **${String((c && c.filename) || 'Onbekende bron')}**${relevance}`;
    })
    .join('\n');
}

/** The step as it is asked: all its substeps, or only the one named by
 *  `substepId` (then `substep` is that one, for the heading of the answer).
 *  Null when the step has no such substep. */
function askedStep(step, substepId) {
  if (!substepId) return step;
  const substep = step.substeps.find((s) => s.id === substepId);
  return substep ? { ...step, substeps: [substep], substep } : null;
}

function composeAnswerText(step, structured, citations) {
  const s = structured && typeof structured === 'object' ? structured : {};
  const answers = s.substeps && typeof s.substeps === 'object' ? s.substeps : {};
  const substep = step.substep ? ` · ${step.substep.id} ${step.substep.title}` : '';
  return [
    `**Stap ${step.nr} · ${step.title}${substep}**`,
    section('Samenvatting casus', String(s.case_summary || '').trim() || 'onbekend'),
    ...step.substeps.flatMap((substep) => substepSections(substep, answers[substep.id])),
    section('Redenering', String(s.reasoning || '').trim() || 'onbekend'),
    section('Aannames en ontbrekende informatie', bullets(asList(s.assumptions_missing_info))),
    section('Bronnen', sourcesText(Array.isArray(citations) ? citations : [])),
    `---\n${DISCLAIMER}`,
  ].join('\n\n');
}

// --- Running a step ---

/** What the model gets as the user's message: the case, the findings so
 *  far, the conversation about this substep and the message typed just now
 *  (each only when there is one), and the source passages found. */
function buildUserPrompt({ caseText, findings, conversation, message, citations }) {
  const found = Array.isArray(citations) ? citations : [];
  const sources = found.length
    ? ['Geraadpleegde beleidsbronnen:', ...found.map((c) => `[bron ${c.rank}] ${c.filename}: "${c.preview}"`)].join('\n')
    : 'Geen beleidsbronnen boven de relevantiedrempel gevonden voor deze casus.';
  return [
    caseText && `Casus:\n${caseText}`,
    findings && `Bevindingen tot nu toe:\n${findings}`,
    conversation && `Gesprek over deze deelstap tot nu toe:\n${conversation}`,
    message && `Bericht van de gebruiker:\n${message}`,
    sources,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Reads the model's reply as JSON, also when it is wrapped in a markdown
 *  code block. When that fails, the answer is the step's empty shape with
 *  the raw reply as the reasoning, and parse_warning is set. */
function parseAgentJson(rawText, step) {
  const text = String(rawText || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') return { structured: parsed, parse_warning: false };
  } catch (_) {
    // fall through
  }
  return { structured: emptyStructured(step, text), parse_warning: true };
}

/** What the Code node of every step workflow runs.
 *
 *  `step` is the step's definition (see steps/): its id, number, title,
 *  role sentence and substeps. `ctx.input` is the request as the main agent
 *  sends it (`$json`: body with case_text, findings, conversation, message
 *  and, when one substep is asked for, substep_id, plus headers), `ctx.env`
 *  the settings from `$env`, `ctx.passages` the source passages to search,
 *  and the rest the means to send HTTP. In order: check the token, read the
 *  fields, find the relevant passages, ask the model, and then either
 *  return its answer to the message as it is, or compose the report
 *  from its JSON. */
async function runStep(step, ctx) {
  const { input, env, passages, fetchImpl, httpModule, httpsModule, urlModule } = ctx;
  const raw = input || {};
  const body = raw.body || {};
  const headers = raw.headers || {};

  // A wrong token gives a normal answer with ok: false, not a thrown error:
  // n8n can turn a thrown error into an empty response, and then the caller
  // sees nothing at all.
  const suppliedToken = extractSuppliedToken(headers);
  const expectedToken = String((env && (env.BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN || env.N8N_WEBHOOK_TOKEN)) || '').trim();
  if (expectedToken && suppliedToken !== expectedToken) {
    return { ok: false, step_id: step.id, error: 'Unauthorized webhook token', text: '' };
  }

  const caseText = String(body.case_text || '').trim();
  const findings = String(body.findings || '').trim();
  const conversation = String(body.conversation || '').trim();
  const message = String(body.message || '').trim();
  const substepId = String(body.substep_id || '').trim();
  const asked = askedStep(step, substepId);
  if (!asked) {
    const text = `Beleidskompas kent deelstap ${substepId} niet in stap ${step.nr}.`;
    return { ok: false, step_id: step.id, substep_id: substepId, error: 'Unknown substep', text, answer: text };
  }

  const queryBlob = [message, caseText, findings].filter(Boolean).join(' ');
  const ragSettings = { algorithm: 'needle', top_k: 3, min_score: 0.12 };
  const { citations, retrieval_trace } = selectSources(passages, queryBlob, ragSettings);

  // No model, or a failing one, is answered with a message for the chat,
  // never with a placeholder that could pass for an assessment.
  const litellmUrl = String((env && env.LITELLM_URL) || '').trim();
  const litellmApiKey = String((env && (env.LITELLM_API_KEY || env.OPENAI_API_KEY)) || '').trim();
  if (!litellmUrl || !litellmApiKey) {
    const text = 'Beleidskompas kan deze stap niet uitvoeren: er is geen taalmodel geconfigureerd (LITELLM_URL en LITELLM_API_KEY of OPENAI_API_KEY).';
    return { ok: false, step_id: step.id, error: 'No language model configured', text, answer: text };
  }

  // A typed message is a conversation turn about the report. Without a
  // message, the step writes the report.
  const conversing = Boolean(message);

  let rawAnswer;
  try {
    rawAnswer = await callLiteLLM({
      baseUrl: litellmUrl,
      apiKey: litellmApiKey,
      model: (env && env.BELEIDSKOMPAS_MODEL) || 'govchat-default',
      systemPrompt: conversing ? buildConversationPrompt(asked) : buildSystemPrompt(asked),
      userPrompt: buildUserPrompt({ caseText, findings, conversation, message, citations }),
      timeoutMs: 60000,
      fetchImpl,
      httpModule,
      httpsModule,
      urlModule,
    });
  } catch (err) {
    const text = `Beleidskompas kon het taalmodel niet bereiken (${String((err && err.message) || err)}). Probeer het later opnieuw.`;
    return { ok: false, step_id: step.id, error: 'Language model call failed', text, answer: text };
  }

  if (conversing) {
    const answer = String(rawAnswer || '').trim() || 'Beleidskompas kreeg geen antwoord van het taalmodel. Probeer het opnieuw.';
    return {
      ok: true,
      step_id: step.id,
      substep_id: substepId || null,
      mode: 'conversation',
      answer,
      text: appendCitationsMetaBlock(answer, citations, retrieval_trace),
      citations,
      retrieval_trace,
    };
  }

  const parsed = parseAgentJson(rawAnswer, asked);
  const structured = parsed.structured;
  const missing = missingParts(asked, structured);
  if (missing.length) structured.assumptions_missing_info = [...asList(structured.assumptions_missing_info), ...missing];
  structured.disclaimer = DISCLAIMER;
  const answer = composeAnswerText(asked, structured, citations);

  return {
    ok: true,
    step_id: step.id,
    substep_id: substepId || null,
    mode: 'report',
    parse_warning: parsed.parse_warning,
    answer,
    // What the chat pipeline delivers: the bridge reads `text`, not
    // `answer`, so the citations and the retrieval trace travel along in the
    // invisible block appended here (see appendCitationsMetaBlock).
    text: appendCitationsMetaBlock(answer, citations, retrieval_trace),
    structured,
    citations,
    retrieval_trace,
  };
}

module.exports = {
  DISCLAIMER,
  CITATIONS_META_MARKER,
  CITATIONS_META_LABEL,
  TITLE_REQUEST_MARKER,
  TITLE_PREFIX,
  PAGE_MESSAGE_LABELS,
  extractSuppliedToken,
  parsePageMessage,
  tokenizePolicyText,
  selectSources,
  appendCitationsMetaBlock,
  parseCitationsMetaBlock,
  requestRaw,
  callLiteLLM,
  isTitleRequest,
  buildFallbackTitle,
  extractConvoCaseText,
  buildTitleResponse,
  readPrompt,
  readSubstepPrompt,
  SYSTEM_PROMPT_TEMPLATE,
  CONVERSATION_PROMPT_TEMPLATE,
  COMMON_RULES,
  isVerdict,
  answerFormat,
  fillTemplate,
  buildSystemPrompt,
  buildConversationPrompt,
  emptyValue,
  emptyStructured,
  missingParts,
  asList,
  bullets,
  section,
  partText,
  substepSections,
  sourcesText,
  askedStep,
  composeAnswerText,
  buildUserPrompt,
  parseAgentJson,
  runStep,
};
