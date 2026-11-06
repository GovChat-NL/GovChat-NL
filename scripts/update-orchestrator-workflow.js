const fs = require('fs');

const workflowPath = require('path').resolve(__dirname, '../agents/n8n/workflows/algemeen/orchestrator-litellm.json');
const data = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const wf = Array.isArray(data) ? data[0] : data;

const detect = (wf.nodes || []).find((n) => n.id === 'DetectImageMessages');
const agent = (wf.nodes || []).find((n) => n.id === 'AIAgentOrchestrator');

if (!detect) throw new Error('DetectImageMessages node not found');
if (!agent) throw new Error('AIAgentOrchestrator node not found');

detect.parameters = detect.parameters || {};
detect.parameters.jsCode = `const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

const raw = isObj($json) ? $json : {};

function resolvePayload(source) {
  let cur = isObj(source) ? source : {};
  for (let i = 0; i < 6; i++) {
    if (Array.isArray(cur.messages)) {
      return { payload: cur, shape: i === 0 ? 'root.messages' : 'nested.body.messages' };
    }
    if (isObj(cur.body)) {
      cur = cur.body;
      continue;
    }
    break;
  }
  return {
    payload: isObj(source.body) ? source.body : source,
    shape: 'fallback',
  };
}

const resolved = resolvePayload(raw);
const payload = isObj(resolved.payload) ? resolved.payload : {};
const messages = Array.isArray(payload.messages) ? payload.messages : [];

const parsePositiveInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const fallbackMaxChars = parsePositiveInt($env.N8N_ORCHESTRATOR_IMAGE_DATA_URL_MAX_CHARS, 450000);
const fallbackMaxResolutionPx = parsePositiveInt($env.N8N_ORCHESTRATOR_IMAGE_MAX_RESOLUTION_PX, 1568);
const overlayBaseUrl = String($env.CRAWLER_ADMIN_BASE_URL || 'http://govchat-overlay-admin:3002').replace(/\\\/$/, '');
const overlayConfigUrl = overlayBaseUrl + '/api/config/orchestrator';
const overlayNormalizeUrl = overlayBaseUrl + '/api/config/orchestrator/normalize-image';

const hasFetch = typeof fetch === 'function';
const http = require('http');
const https = require('https');
const { URL } = require('url');

function requestRaw(url, opts = {}) {
  if (hasFetch) {
    return fetch(url, opts).then(async (res) => ({
      ok: res.ok,
      status: Number(res.status || 0),
      text: await res.text(),
    }));
  }

  return new Promise((resolve, reject) => {
    try {
      const target = new URL(String(url));
      const lib = target.protocol === 'https:' ? https : http;
      const method = String(opts.method || 'GET').toUpperCase();
      const headers = isObj(opts.headers) ? opts.headers : {};
      const body = typeof opts.body === 'string' ? opts.body : '';

      const req = lib.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: target.pathname + target.search,
          method,
          headers: {
            ...headers,
            ...(body ? { 'content-length': Buffer.byteLength(body, 'utf8') } : {}),
          },
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

async function requestJson(url, opts = {}) {
  const r = await requestRaw(url, opts);
  if (!r.ok) {
    const err = new Error('HTTP ' + r.status);
    err.status = r.status;
    err.body = r.text;
    throw err;
  }
  try {
    return JSON.parse(String(r.text || '{}'));
  } catch {
    return {};
  }
}

let configuredMaxChars = fallbackMaxChars;
let configuredMaxResolutionPx = fallbackMaxResolutionPx;

try {
  const cfg = await requestJson(overlayConfigUrl, { method: 'GET' });
  configuredMaxChars = parsePositiveInt(cfg && cfg.image_data_url_max_chars, fallbackMaxChars);
  configuredMaxResolutionPx = parsePositiveInt(cfg && cfg.image_max_resolution_px, fallbackMaxResolutionPx);
} catch (_) {}

let imageParts = 0;
let normalizedParts = 0;
let unchangedParts = 0;
let normalizationErrors = 0;

const normalizedMessages = [];

for (const m of messages) {
  if (!Array.isArray(m && m.content)) {
    normalizedMessages.push(m);
    continue;
  }

  const nextContent = [];
  for (const part of m.content) {
    if (!part || typeof part !== 'object') {
      nextContent.push(part);
      continue;
    }

    const type = String(part.type || '').toLowerCase();
    if (type !== 'image_url' && type !== 'input_image' && type !== 'image') {
      nextContent.push(part);
      continue;
    }

    imageParts += 1;

    const imageUrlValue =
      typeof part.image_url === 'string'
        ? part.image_url
        : (part.image_url && typeof part.image_url.url === 'string' ? part.image_url.url : '');

    if (!imageUrlValue.startsWith('data:')) {
      unchangedParts += 1;
      nextContent.push(part);
      continue;
    }

    try {
      const normPayload = await requestJson(overlayNormalizeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image_data_url: imageUrlValue,
          max_chars: configuredMaxChars,
          max_resolution_px: configuredMaxResolutionPx,
        }),
      });

      const normalizedDataUrl = String(normPayload?.image_data_url || '').trim();
      if (!normalizedDataUrl.startsWith('data:')) {
        normalizationErrors += 1;
        nextContent.push(part);
        continue;
      }

      if (normalizedDataUrl === imageUrlValue) {
        unchangedParts += 1;
        nextContent.push(part);
        continue;
      }

      normalizedParts += 1;
      if (typeof part.image_url === 'string') {
        nextContent.push({ ...part, image_url: normalizedDataUrl });
      } else {
        nextContent.push({
          ...part,
          image_url: { ...(part.image_url || {}), url: normalizedDataUrl },
        });
      }
    } catch (_) {
      normalizationErrors += 1;
      nextContent.push(part);
    }
  }

  normalizedMessages.push({ ...m, content: nextContent });
}

let precomputedResponse = '';
let visionCallStatus = 'skipped';

if (imageParts > 0) {
  try {
    const base = String($env.LITELLM_URL || 'http://litellm:4000').replace(/\\\/$/, '') + '/v1/chat/completions';
    const apiKey = String($env.LITELLM_API_KEY || $env.N8N_LITELLM_IMAGE_API_KEY || '').trim();
    const model = String($env.N8N_ORCHESTRATOR_VISION_MODEL || 'govchat-default').trim() || 'govchat-default';

    if (!apiKey) {
      visionCallStatus = 'no_api_key';
      precomputedResponse = 'Ik heb een afbeelding ontvangen, maar de vision-configuratie ontbreekt (API key niet gezet).';
    } else {
      const r = await requestRaw(base, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({ model, messages: normalizedMessages }),
      });

      if (r.ok) {
        let payloadResp = {};
        try {
          payloadResp = JSON.parse(String(r.text || '{}'));
        } catch {
          payloadResp = {};
        }
        const msg = payloadResp?.choices?.[0]?.message;
        const content = msg?.content;

        if (typeof content === 'string') {
          precomputedResponse = content.trim();
        } else if (Array.isArray(content)) {
          precomputedResponse = content
            .map((part) => {
              if (!part) return '';
              if (typeof part === 'string') return part;
              const t = String(part.type || '').toLowerCase();
              if (t === 'text' || t === 'output_text' || t === 'input_text') return String(part.text || '');
              return '';
            })
            .filter(Boolean)
            .join(' ')
            .trim();
        }

        visionCallStatus = precomputedResponse ? 'ok' : 'empty';
      } else {
        const errLc = String(r.text || '').toLowerCase();
        if (errLc.includes('unsupported image') || errLc.includes('unsupported') || errLc.includes('badrequesterror')) {
          visionCallStatus = 'unsupported_image_or_model';
          precomputedResponse = 'Ik heb de afbeelding ontvangen, maar het geconfigureerde model ondersteunt deze image-analyse niet. Configureer een vision-capabel model alias in LiteLLM en zet N8N_ORCHESTRATOR_VISION_MODEL daarop.';
        } else if (errLc.includes('authentication') || errLc.includes('unauthorized') || errLc.includes('api key')) {
          visionCallStatus = 'auth_error';
          precomputedResponse = 'Ik heb de afbeelding ontvangen, maar de vision-configuratie faalt op authenticatie (API key/model toegang).';
        } else {
          visionCallStatus = 'http_' + String(r.status || 'error');
          precomputedResponse = 'Ik heb een afbeelding ontvangen, maar de vision-aanroep faalde (HTTP ' + String(r.status || 'onbekend') + ').';
        }
      }
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e || '').trim();
    const lc = msg.toLowerCase();
    if (lc.includes('unsupported') || lc.includes('invalid image') || lc.includes('badrequesterror')) {
      visionCallStatus = 'unsupported_image_or_model';
      precomputedResponse = 'Ik heb de afbeelding ontvangen, maar het geconfigureerde model ondersteunt deze image-analyse niet. Configureer een vision-capabel model alias in LiteLLM en zet N8N_ORCHESTRATOR_VISION_MODEL daarop.';
    } else {
      visionCallStatus = msg ? ('error_' + msg.slice(0, 120)) : 'error';
      precomputedResponse = 'Ik heb een afbeelding ontvangen, maar de vision-aanroep gaf een fout' + (msg ? ' (' + msg + ')' : '') + '.';
    }
  }
}

const mergedBody = {
  ...payload,
  messages: normalizedMessages,
};

return [{
  json: {
    ...raw,
    precomputed_response: precomputedResponse || undefined,
    body: mergedBody,
    imageCap: {
      maxChars: configuredMaxChars,
      maxResolutionPx: configuredMaxResolutionPx,
      imageParts,
      normalizedParts,
      unchangedParts,
      normalizationErrors,
      visionCallStatus,
      source: overlayConfigUrl,
      inputShape: resolved.shape,
      passthrough: true,
      reason: 'Normalize image payload and precompute multimodal answer when image is attached',
    },
  },
}];`;

agent.parameters = agent.parameters || {};
agent.parameters.text = `={{ (() => { if (typeof $json.precomputed_response === 'string' && $json.precomputed_response.trim()) { return '[FINAL_ANSWER]\\n' + $json.precomputed_response.trim(); } const msgs = Array.isArray($json.body?.messages) ? $json.body.messages : (Array.isArray($json.messages) ? $json.messages : []); if (msgs.length) { return msgs.map((m) => { const role = String(m?.role || 'user'); const content = Array.isArray(m?.content) ? m.content.map((part) => { if (!part) return ''; if (typeof part === 'string') return part; const t = String(part.type || '').toLowerCase(); if (t === 'text' || t === 'input_text') return String(part.text || part.content || ''); return ''; }).filter(Boolean).join(' ') : (typeof m?.content === 'string' ? m.content : ''); return \`[\${role}] \${String(content || '').trim()}\`.trim(); }).filter(Boolean).join('\\n'); } return String($json.body?.text || $json.text || $json.body?.prompt || $json.prompt || $json.body?.input || $json.input || ''); })() }}`;

const originalSystem = String(agent.parameters?.options?.systemMessage || '');
const finalRule = 'Als de input begint met [FINAL_ANSWER], geef exact alles ná dit label terug als eindantwoord zonder extra tekst.';
agent.parameters.options = agent.parameters.options || {};
agent.parameters.options.systemMessage = originalSystem.includes('[FINAL_ANSWER]')
  ? originalSystem
  : (originalSystem ? originalSystem + ' ' + finalRule : finalRule);

const utilityBuilder = require('./orchestrator-utility-workflow');
utilityBuilder.applyUtilityTools(wf);
// Utility exports added on dev remain at the workflow root. Do not regenerate
// duplicates in algemeen merely because the orchestrator moved there on PR13.
const utilityWorkflowsDir = require('path').resolve(__dirname, '../agents/n8n/workflows');
for (const definition of utilityBuilder.definitions) {
  const utility = utilityBuilder.utilityWorkflow(definition);
  fs.writeFileSync(require('path').join(utilityWorkflowsDir, utility.id + '.json'), JSON.stringify([utility], null, 2) + '\n');
}
fs.writeFileSync(workflowPath, JSON.stringify(data, null, 2));
console.log('Updated orchestrator workflow detect node + passthrough prompt');
