'use strict';

/**
 * What every Beleidskompas workflow shares: reading the caller's token,
 * sending HTTP requests and calling the language model through LiteLLM,
 * scoring the source passages, the citations block that travels with a
 * chat message, and LibreChat's conversation-title request. The step
 * definitions in steps/ and main-agent.js build on these; generate-workflow.js
 * copies the functions a workflow needs into its Code node.
 */

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
// overlay/src/apps/beleidskompas/beleidskompas-api.js writes these).
const PAGE_MESSAGE_LABELS = {
  step: 'Stap:',
  findings: 'Casus/eerdere bevindingen:',
  sources: 'Bekende bronnen:',
  question: 'Vraag:',
};

/** Splits a message from the page into its parts: the step id, the findings
 *  of the earlier steps (which span many lines), the list of known sources
 *  and the question. A part whose label is missing is '' (or [] for the
 *  sources). A message without any label is returned whole as the question,
 *  so a direct webhook call with a plain case text keeps working. */
function parsePageMessage(text) {
  const parts = { stepId: '', findings: '', sources: '', question: '' };
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

  if (!current) parts.question = unlabeled.join('\n');
  const stepMatch = /^([A-Za-z0-9_-]+)/.exec(parts.step || '');
  parts.stepId = stepMatch ? stepMatch[1].toLowerCase() : '';
  delete parts.step;
  for (const key of Object.keys(parts)) parts[key] = String(parts[key] || '').trim();
  parts.sources = parts.sources
    .split(';')
    .map((name) => name.trim())
    .filter(Boolean);
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
      // LLM call failed: title falls through to the deterministic one below,
      // same as the demo-fallback pattern used elsewhere in this file.
      title = '';
    }
  }
  if (!title) title = buildFallbackTitle(source);
  // Prefixed so Beleidskompas conversations are visually grouped in
  // LibreChat's conversation-list sidebar, alongside other endpoints/agents.
  title = TITLE_PREFIX + title;

  return { ok: true, step_id: 'stap1', mode: 'title', answer: title, text: title };
}

// --- Running a step ---

function buildUserPrompt({ question, caseText, citations }) {
  const lines = [];
  if (caseText) lines.push('Casus: ' + caseText);
  // The first message of a case is the case description itself; then the
  // question is the case and is not repeated.
  if (question && question !== caseText) lines.push('Vraag: ' + question);

  if (Array.isArray(citations) && citations.length) {
    lines.push('Geraadpleegde beleidsbronnen:');
    citations.forEach((c) => {
      lines.push(`[bron ${c.rank}] ${c.filename}: "${c.preview}"`);
    });
  } else {
    lines.push('Geen beleidsbronnen boven de relevantiedrempel gevonden voor deze casus.');
  }

  return lines.join('\n');
}

/** Reads the model's reply as JSON, also when it is wrapped in a markdown
 *  code block. When that fails, the step's `emptyStructured` gives the
 *  answer shape with the raw reply as the reasoning, and parse_warning is
 *  set. */
function parseAgentJson(rawText, emptyStructured) {
  const text = String(rawText || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') return { structured: parsed, parse_warning: false };
  } catch (_) {
    // fall through
  }
  return { structured: emptyStructured(text), parse_warning: true };
}

/** What the Code node of every step workflow runs.
 *
 *  `step` is the step's definition (see steps/): its id, its system prompt,
 *  the shape of an empty answer, its demo fallback and how it composes the
 *  answer text. `ctx.input` is the request as the main agent sends it
 *  (`$json`: body with question, case_text and sources, plus headers),
 *  `ctx.env` the settings from `$env`, `ctx.passages` the source passages to
 *  search, `ctx.sources` the names of the sources when the request names
 *  none, and the rest the means to send HTTP. In order: check the token,
 *  read the fields, find the relevant passages, ask the model (or fall back
 *  to the demo answer), compose the answer. */
async function runStep(step, ctx) {
  const { input, env, sources: defaultSources, passages, fetchImpl, httpModule, httpsModule, urlModule } = ctx;
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

  const question = String(body.question || '').trim();
  const caseText = String(body.case_text || '').trim();
  // The names of the sources the page knows, when it sent them; otherwise
  // the fixed list this workflow was generated with.
  const sources = Array.isArray(body.sources) && body.sources.length ? body.sources : defaultSources;

  const queryBlob = [question, caseText].filter(Boolean).join(' ');
  const ragSettings = { algorithm: 'needle', top_k: 3, min_score: 0.12 };
  const { citations, retrieval_trace } = selectSources(passages, queryBlob, ragSettings);

  const litellmUrl = String((env && env.LITELLM_URL) || '').trim();
  const litellmApiKey = String((env && (env.LITELLM_API_KEY || env.OPENAI_API_KEY)) || '').trim();
  const demoMode = !litellmUrl || !litellmApiKey;

  let structured;
  let mode;
  let parseWarning = false;

  if (demoMode) {
    mode = 'demo_fallback';
    structured = step.buildDemoFallbackStructured({ question, caseText, citations });
  } else {
    mode = 'llm';
    const systemPrompt = step.buildSystemPrompt(sources);
    const userPrompt = buildUserPrompt({ question, caseText, citations });
    try {
      const rawAnswer = await callLiteLLM({
        baseUrl: litellmUrl,
        apiKey: litellmApiKey,
        model: (env && env.BELEIDSKOMPAS_MODEL) || 'govchat-default',
        systemPrompt,
        userPrompt,
        timeoutMs: 60000,
        fetchImpl,
        httpModule,
        httpsModule,
        urlModule,
      });
      const parsed = parseAgentJson(rawAnswer, step.emptyStructured);
      structured = parsed.structured;
      parseWarning = parsed.parse_warning;
    } catch (err) {
      mode = 'demo_fallback';
      structured = step.buildDemoFallbackStructured({ question, caseText, citations });
      structured.reasoning =
        `⚠️ DEMO-MODUS (LLM-aanroep mislukt: ${String((err && err.message) || err)}): ` + structured.reasoning;
    }
  }

  structured.disclaimer = DISCLAIMER;
  const answer = step.composeAnswerText(structured, mode, citations);

  return {
    ok: true,
    step_id: step.id,
    mode,
    parse_warning: parseWarning,
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
  buildUserPrompt,
  parseAgentJson,
  runStep,
};
