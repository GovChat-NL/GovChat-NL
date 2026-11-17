'use strict';

/**
 * Beleidskompas step 1 ("Publiek en provinciaal belang") core logic.
 *
 * This module is the single source of truth for the reasoning embedded in the
 * n8n workflow `beleidskompas-step-stap1.json`. `generate-workflow.js` inlines
 * every function below (via Function.prototype.toString) into that workflow's
 * Code node, so the exact code exercised by logic.test.js is what runs in n8n.
 *
 * The output schema (case_summary / public_interest / provincial_interest /
 * reasoning / assumptions_missing_info / disclaimer) condenses the 6-agent
 * chain (001-006) from the prior Python/OpenWebUI/Qdrant Beleidskompas PoC
 * into a single LLM call, keeping the
 * five public-interest test criteria from 002_OVERHEIDSINTERVENTIE and the
 * public/provincial verdict shape from 005_INTEGRALE_AFWEGING.
 */

const DISCLAIMER =
  'Dit resultaat is een ondersteunend concept ten behoeve van de voorbereiding van beleidsadvies. ' +
  'Het is geen besluit en vervangt geen menselijke afweging of besluitvorming.';

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

function detectMissingInfo(stepFields, caseText) {
  const fields = stepFields && typeof stepFields === 'object' ? stepFields : {};
  const missing = [];
  if (!String(caseText || '').trim() && !String(fields.problem || '').trim()) {
    missing.push(
      'Geen casusbeschrijving of probleemdefinitie aangeleverd; de analyse hieronder gaat uit van de letterlijke vraagtekst alleen.',
    );
  }
  if (!String(fields.causes || '').trim()) {
    missing.push('Oorzaken van het probleem zijn niet aangeleverd en worden daarom als "onbekend" behandeld.');
  }
  if (!String(fields.perspectives || '').trim()) {
    missing.push(
      'Er is niet aangegeven welke perspectieven of belanghebbenden nog ontbreken; dit dient in een vervolgstap expliciet te worden nagegaan.',
    );
  }
  if (!String(fields.references || '').trim()) {
    missing.push('Geen expliciete bronverwijzingen aangeleverd door de gebruiker; de analyse steunt op de geraadpleegde beleidsbronnen hieronder.');
  }
  return missing;
}

function buildSystemPrompt(sources) {
  const sourceList = Array.isArray(sources) && sources.length ? sources.join('; ') : 'geen aanvullende bronlijst aangeleverd';
  return (
    'Je bent een realistisch analysemodel voor stap 1 (Publiek en provinciaal belang) van het Beleidskompas van Provincie Limburg. ' +
    'Je combineert drie deelanalyses tot een samenhangend oordeel: (1) probleemdefinitie - het feitelijke probleem, oorzaken, symptomen en ontbrekende perspectieven; ' +
    '(2) overheidsinterventie - toets langs vijf criteria of publiek belang aanwezig is: marktfalen, publieke goederen/diensten, sociale rechtvaardigheid, externe effecten, consumentenbescherming; ' +
    '(3) provinciaal belang - past de taak binnen de wettelijke taken, bevoegdheden en vastgestelde beleidskaders van de provincie, of is dit een gemeentelijke aangelegenheid? ' +
    'Gebruik uitsluitend expliciete informatie uit de casus en de aangeleverde brondocumenten (' + sourceList + '). ' +
    'Maak geen eigen interpretaties of feitelijke aannames; benoem ontbrekende informatie expliciet in plaats van te verzinnen. Redeneer stap voor stap en wees feitelijk en beknopt. ' +
    // De explanation-velden worden als markdown weergegeven (ook in het
    // opgeslagen LibreChat-bericht), dus per criterium een regel leest daar
    // veel beter dan "(1) ... (2) ..." in één lange alinea.
    'Zet in "explanation" elk criterium op een eigen regel als markdown-opsomming ("- criterium: bevinding"), gescheiden door regeleindes. ' +
    'Zet in "reasoning" elke redeneerstap ook op een eigen regel, genummerd ("1. ...", "2. ...") en gescheiden door regeleindes. ' +
    'Dit is een ondersteunend hulpmiddel: benoem dit resultaat nooit als een besluit. ' +
    'Antwoord UITSLUITEND met een geldig JSON-object, zonder markdown-codeblok, exact met deze velden: ' +
    '{"case_summary": string, "public_interest": {"verdict": "ja"|"nee"|"onduidelijk", "explanation": string}, ' +
    '"provincial_interest": {"verdict": "ja"|"nee"|"beperkt"|"onduidelijk", "explanation": string}, ' +
    '"reasoning": string, "assumptions_missing_info": string[]}'
  );
}

function buildUserPrompt({ question, caseText, stepFields, citations, missingInfo }) {
  const fields = stepFields && typeof stepFields === 'object' ? stepFields : {};
  const lines = [];
  if (caseText) lines.push('Casus: ' + caseText);
  if (fields.problem) lines.push('Probleemdefinitie (aangeleverd): ' + fields.problem);
  if (fields.causes) lines.push('Oorzaken (aangeleverd): ' + fields.causes);
  if (fields.perspectives) lines.push('Ontbrekend perspectief (aangeleverd): ' + fields.perspectives);
  if (question) lines.push('Vraag: ' + question);

  if (Array.isArray(citations) && citations.length) {
    lines.push('Geraadpleegde beleidsbronnen:');
    citations.forEach((c) => {
      lines.push(`[bron ${c.rank}] ${c.filename}: "${c.preview}"`);
    });
  } else {
    lines.push('Geen beleidsbronnen boven de relevantiedrempel gevonden voor deze casus.');
  }

  if (Array.isArray(missingInfo) && missingInfo.length) {
    lines.push('Reeds gedetecteerde ontbrekende informatie: ' + missingInfo.join(' '));
  }

  return lines.join('\n');
}

function parseAgentJson(rawText) {
  const text = String(rawText || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') return { structured: parsed, parse_warning: false };
  } catch (_) {
    // fall through
  }
  return {
    structured: {
      case_summary: '',
      public_interest: { verdict: 'onduidelijk', explanation: '' },
      provincial_interest: { verdict: 'onduidelijk', explanation: '' },
      reasoning: text || 'Het taalmodel gaf geen bruikbare output terug.',
      assumptions_missing_info: ['Kon het modelantwoord niet als JSON verwerken; ruwe tekst is opgenomen in het redeneerveld.'],
    },
    parse_warning: true,
  };
}

function buildDemoFallbackStructured({ question, caseText, stepFields, citations, missingInfo }) {
  const fields = stepFields && typeof stepFields === 'object' ? stepFields : {};
  const hasCase = Boolean(String(caseText || '').trim() || String(fields.problem || '').trim());

  const summaryParts = [];
  if (caseText) summaryParts.push(caseText);
  else if (fields.problem) summaryParts.push(fields.problem);
  else if (question) summaryParts.push(question);
  const case_summary = summaryParts.join(' ').trim() || 'Onvoldoende informatie aangeleverd om een casusomschrijving samen te stellen.';

  const topDocFilenames = (Array.isArray(citations) ? citations : []).map((c) => c.filename);

  const public_interest = hasCase
    ? {
        verdict: 'onduidelijk',
        explanation:
          'Demo-modus (geen taalmodel geconfigureerd): een deterministische plaatsvervanger kan marktfalen, publieke goederen, sociale rechtvaardigheid, ' +
          'externe effecten en consumentenbescherming niet inhoudelijk beoordelen. Vereist een echte modelanalyse van de casustekst.',
      }
    : { verdict: 'onduidelijk', explanation: 'Onvoldoende casusinformatie aangeleverd om publiek belang te beoordelen.' };

  const provincial_interest = {
    verdict: 'onduidelijk',
    explanation: topDocFilenames.length
      ? 'Demo-modus: mogelijk relevante beleidsbronnen gevonden (' + topDocFilenames.join(', ') + '), maar de daadwerkelijke provinciale-bevoegdheidstoets vereist een taalmodel.'
      : 'Demo-modus: geen relevante beleidsbronnen boven de drempel gevonden en geen taalmodel beschikbaar om provinciale bevoegdheid te toetsen.',
  };

  const reasoning =
    '⚠️ DEMO-MODUS: er is geen LITELLM_API_KEY/OPENAI_API_KEY geconfigureerd, dus deze uitvoer is een deterministische placeholder ' +
    'in plaats van een echte AI-beoordeling. De structuur van het antwoord (samenvatting, publiek belang, provinciaal belang, redenering, aannames, bronnen) ' +
    'is representatief voor de productiemodus, maar de inhoud is niet inhoudelijk beoordeeld.';

  return {
    case_summary,
    public_interest,
    provincial_interest,
    reasoning,
    assumptions_missing_info: [
      ...(Array.isArray(missingInfo) ? missingInfo : []),
      'Geen taalmodel geconfigureerd (LITELLM_API_KEY/OPENAI_API_KEY ontbreekt): dit is een demo-fallback, geen AI-beoordeling.',
    ],
  };
}

/** Stelt het antwoord samen als markdown. Dit is niet alleen de tekst voor de
 *  Beleidskompas-interface: LibreChat bewaart hem als gespreksbericht, dus wie
 *  de casus in de gewone chat opent ziet exact dit. Daarom kopjes, vette
 *  labels en een expliciete bronnenlijst - die bronnen zitten verder alleen in
 *  het onzichtbare meta-blok en zouden daar anders ontbreken (F-25). */
function composeAnswerText(structured, mode, citations) {
  const s = structured && typeof structured === 'object' ? structured : {};
  const pub = s.public_interest && typeof s.public_interest === 'object' ? s.public_interest : {};
  const prov = s.provincial_interest && typeof s.provincial_interest === 'object' ? s.provincial_interest : {};
  const assumptions = Array.isArray(s.assumptions_missing_info) ? s.assumptions_missing_info : [];
  const sources = Array.isArray(citations) ? citations : [];

  const lines = [];
  if (mode === 'demo_fallback') {
    lines.push('⚠️ DEMO-UITVOER (geen taalmodel geconfigureerd) - onderstaande tekst is een deterministische placeholder, geen AI-beoordeling.');
    lines.push('');
  }
  lines.push('**Stap 1 · Publiek en provinciaal belang**');
  lines.push('');
  lines.push('### Samenvatting casus');
  lines.push(s.case_summary || 'onbekend');
  lines.push('');
  lines.push('### Publiek belang');
  lines.push(`**Oordeel:** ${pub.verdict || 'onduidelijk'}`);
  if (pub.explanation) {
    lines.push('');
    lines.push(pub.explanation);
  }
  lines.push('');
  lines.push('### Provinciaal belang');
  lines.push(`**Oordeel:** ${prov.verdict || 'onduidelijk'}`);
  if (prov.explanation) {
    lines.push('');
    lines.push(prov.explanation);
  }
  lines.push('');
  lines.push('### Redenering');
  lines.push(s.reasoning || 'onbekend');
  lines.push('');
  lines.push('### Aannames en ontbrekende informatie');
  lines.push(assumptions.length ? assumptions.map((a) => '- ' + a).join('\n') : '- geen');
  lines.push('');
  lines.push('### Bronnen');
  lines.push(
    sources.length
      ? sources
          .map((c, idx) => {
            const score = Number(c && c.score);
            const relevance = Number.isFinite(score) && score > 0 ? ` - relevantie ${score.toFixed(3)}` : '';
            return `${idx + 1}. **${String((c && c.filename) || 'Onbekende bron')}**${relevance}`;
          })
          .join('\n')
      : '- geen bronnen boven de relevantiedrempel',
  );
  lines.push('');
  lines.push('---');
  lines.push(DISCLAIMER);

  return lines.join('\n');
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

// --- Top-level orchestration (embedded verbatim into the n8n Code node) ---

async function runStep1(ctx) {
  const { input, env, sources, passages, fetchImpl, httpModule, httpsModule, urlModule } = ctx;
  const raw = input || {};
  const body = raw.body || {};
  const headers = raw.headers || {};

  const suppliedToken = extractSuppliedToken(headers);
  const expectedToken = String((env && (env.BELEIDSKOMPAS_N8N_WEBHOOK_TOKEN || env.N8N_WEBHOOK_TOKEN)) || '').trim();
  if (expectedToken && suppliedToken !== expectedToken) {
    // Returned (not thrown): some n8n versions turn a thrown Code-node error into
    // a bare empty 200 response for a webhook in `responseNode` mode instead of a
    // visible error, which would silently swallow this rejection. Returning a
    // normal ok:false item guarantees the caller always sees a clear message.
    return { ok: false, step_id: 'stap1', error: 'Unauthorized webhook token', text: '' };
  }

  // `currentMessage`/`chatInput` are how the n8n-openai-bridge (LibreChat's real
  // chat pipeline) delivers the user's message; `question`/`case_text` remain
  // supported for direct webhook calls (curl, the custom step-form UI).
  const chatMessage = String(body.currentMessage || body.chatInput || '').trim();
  const question = String(body.question || chatMessage || '').trim();
  const caseText = String(body.case_text || (body.question ? '' : chatMessage) || '').trim();
  const stepFields = body.step_fields && typeof body.step_fields === 'object' ? body.step_fields : {};

  // LibreChat's own conversation-title request (see TITLE_REQUEST_MARKER):
  // short-circuit before running any analysis, on whichever field the
  // marker landed in (systemPrompt vs. the message itself).
  const systemPromptField = String(body.systemPrompt || '').trim();
  if (isTitleRequest(chatMessage) || isTitleRequest(question) || isTitleRequest(systemPromptField)) {
    return buildTitleResponse({
      titleSource: caseText || question || chatMessage,
      env,
      fetchImpl,
      httpModule,
      httpsModule,
      urlModule,
    });
  }

  const queryBlob = [question, caseText, stepFields.problem, stepFields.causes, stepFields.perspectives, stepFields.references]
    .filter(Boolean)
    .join(' ');

  const ragSettings = { algorithm: 'needle', top_k: 3, min_score: 0.12 };
  const { citations, retrieval_trace } = selectSources(passages, queryBlob, ragSettings);
  const missingInfo = detectMissingInfo(stepFields, caseText);

  const litellmUrl = String((env && env.LITELLM_URL) || '').trim();
  const litellmApiKey = String((env && (env.LITELLM_API_KEY || env.OPENAI_API_KEY)) || '').trim();
  const demoMode = !litellmUrl || !litellmApiKey;

  let structured;
  let mode;
  let parseWarning = false;

  if (demoMode) {
    mode = 'demo_fallback';
    structured = buildDemoFallbackStructured({ question, caseText, stepFields, citations, missingInfo });
  } else {
    mode = 'llm';
    const systemPrompt = buildSystemPrompt(sources);
    const userPrompt = buildUserPrompt({ question, caseText, stepFields, citations, missingInfo });
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
      const parsed = parseAgentJson(rawAnswer);
      structured = parsed.structured;
      parseWarning = parsed.parse_warning;
      if (Array.isArray(missingInfo) && missingInfo.length) {
        structured.assumptions_missing_info = [...new Set([...(structured.assumptions_missing_info || []), ...missingInfo])];
      }
    } catch (err) {
      mode = 'demo_fallback';
      structured = buildDemoFallbackStructured({ question, caseText, stepFields, citations, missingInfo });
      structured.reasoning =
        `⚠️ DEMO-MODUS (LLM-aanroep mislukt: ${String((err && err.message) || err)}): ` + structured.reasoning;
    }
  }

  structured.disclaimer = DISCLAIMER;
  const answer = composeAnswerText(structured, mode, citations);

  return {
    ok: true,
    step_id: 'stap1',
    mode,
    parse_warning: parseWarning,
    answer,
    // Variant of `answer` actually delivered through the LibreChat chat
    // pipeline: the n8n-openai-bridge extracts `content || text || output ||
    // message` from each response chunk (not `answer`), and only forwards
    // that string, so citations/retrieval_trace are appended as an invisible
    // trailing block (see appendCitationsMetaBlock) instead of being lost.
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
  isTitleRequest,
  buildFallbackTitle,
  extractConvoCaseText,
  buildTitleResponse,
  extractSuppliedToken,
  tokenizePolicyText,
  selectSources,
  detectMissingInfo,
  buildSystemPrompt,
  buildUserPrompt,
  parseAgentJson,
  buildDemoFallbackStructured,
  composeAnswerText,
  appendCitationsMetaBlock,
  parseCitationsMetaBlock,
  requestRaw,
  callLiteLLM,
  runStep1,
};
