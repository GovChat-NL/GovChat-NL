const fs = require('fs');

const path = require('path');
const workflowPath = path.resolve(__dirname, '../agents/n8n/workflows/algemeen/image-generator-litellm.json');
const data = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const wf = Array.isArray(data) ? data[0] : data;

const prep = (wf.nodes || []).find(
  (n) => n.id === 'PrepareImageRequest' || n.name === 'Prepare Image Request',
);
const call = (wf.nodes || []).find(
  (n) => n.id === 'CallImageApi' || n.name === 'Call Images API',
);
const build = (wf.nodes || []).find(
  (n) => n.id === 'BuildImageResponse' || n.name === 'Build Image Response',
);

if (!prep) {
  throw new Error('Prepare Image Request node not found');
}
if (!build) {
  throw new Error('Build Image Response node not found');
}
if (!call) {
  throw new Error('Call Images API node not found');
}

prep.parameters = prep.parameters || {};
prep.parameters.jsCode = `const raw = $json || {};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const asString = (v) => (typeof v === 'string' ? v.trim() : '');

const body = isObj(raw.body) ? raw.body : raw;
const headers = isObj(raw.headers) ? raw.headers : {};

const expectedToken = String($env.N8N_WEBHOOK_TOKEN || '').trim();
const hasWebhookShape = !!raw.body || Object.keys(headers).length > 0;

if (hasWebhookShape) {
  const headerToken = String(headers['x-govchat-token'] || headers['X-Govchat-Token'] || '').trim();
  const authHeader = String(headers.authorization || headers.Authorization || '').trim();
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const suppliedToken = headerToken || bearerToken;

  if (!expectedToken) throw new Error('Server misconfiguratie: N8N_WEBHOOK_TOKEN ontbreekt');
  if (!suppliedToken || suppliedToken !== expectedToken) throw new Error('Unauthorized webhook token');
}

function fromMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] || {};
    const direct = asString(m.content) || asString(m.text) || asString(m.prompt) || asString(m.input);
    if (direct) return direct;
    if (Array.isArray(m.content)) {
      const joined = m.content
        .map((part) => {
          if (!part) return '';
          if (typeof part === 'string') return part;
          return asString(part.text) || asString(part.content) || '';
        })
        .filter(Boolean)
        .join(' ')
        .trim();
      if (joined) return joined;
    }
  }
  return '';
}

const candidates = [
  asString(body.prompt),
  asString(body.text),
  asString(body.input),
  asString(body.query),
  asString(body.message),
  asString(body.user_input),
  asString(body.request),
  asString(body.instruction),
  isObj(body.data) ? asString(body.data.prompt) || asString(body.data.text) || asString(body.data.input) : '',
  isObj(body.arguments)
    ? asString(body.arguments.prompt) || asString(body.arguments.text) || asString(body.arguments.input)
    : '',
  isObj(body.args) ? asString(body.args.prompt) || asString(body.args.text) || asString(body.args.input) : '',
  isObj(raw.toolInput)
    ? asString(raw.toolInput.prompt) || asString(raw.toolInput.text) || asString(raw.toolInput.input)
    : '',
  isObj(raw.input) ? asString(raw.input.prompt) || asString(raw.input.text) || asString(raw.input.input) : '',
  isObj(raw.parameters)
    ? asString(raw.parameters.prompt) || asString(raw.parameters.text) || asString(raw.parameters.input)
    : '',
  fromMessages(body.messages),
  fromMessages(raw.messages),
].filter(Boolean);

const prompt = (candidates[0] || '').trim();
if (!prompt) {
  const hint = Object.keys(body).slice(0, 12).join(',');
  throw new Error('Afbeelding-tool vereist een prompt (ontvangen keys: ' + hint + ')');
}

const requestedSize = (asString(body.size) || asString(raw.size) || '').toLowerCase();
const requestedQuality = (asString(body.quality) || asString(raw.quality) || '').toLowerCase();
const enabled = String($env.N8N_ENABLE_IMAGE_TOOL || 'false').toLowerCase() === 'true';
if (!enabled) throw new Error('Afbeelding-generatie staat uit (N8N_ENABLE_IMAGE_TOOL=false)');

const baseRaw = String($env.N8N_LITELLM_IMAGE_BASE_URL || $env.LITELLM_URL || 'http://litellm:4000').trim();
const apiBase = baseRaw.endsWith('/') ? baseRaw.slice(0, -1) : baseRaw;
const apiKey = String($env.N8N_LITELLM_IMAGE_API_KEY || $env.LITELLM_API_KEY || '').trim();
const model = String($env.N8N_LITELLM_IMAGE_MODEL || 'gpt-image-1').trim();
const apiVersion = String($env.N8N_LITELLM_IMAGE_API_VERSION || '2024-02-01').trim();

if (!enabled) {
  return [{
    json: {
      image_disabled: true,
      disabled_reason: 'Afbeelding-generatie staat uit (N8N_ENABLE_IMAGE_TOOL=false).',
      // Call node draait met continueOnFail=true en zal op deze URL direct falen,
      // waarna Build Image Response een nette, niet-fatale melding teruggeeft.
      generateUrl: 'http://127.0.0.1:9/disabled',
      requestBody: {},
      apiKey: '',
      isAzureDeploymentPath: false,
      prompt,
      size,
      quality,
      model,
      apiBase,
    },
  }];
}

if (!apiKey) throw new Error('LITELLM_API_KEY ontbreekt');

const modelLc = model.toLowerCase();
const isGptImage = modelLc.includes('gpt-image');
const isDalle3 = modelLc.includes('dall-e-3');
const isDalle2 = modelLc.includes('dall-e-2');

function normalizeQuality(input) {
  if (isGptImage) {
    const allowed = new Set(['auto', 'low', 'medium', 'high']);
    if (!input || input === 'standard') return 'auto';
    if (input === 'hd') return 'high';
    return allowed.has(input) ? input : 'auto';
  }

  if (isDalle3) {
    const allowed = new Set(['standard', 'hd']);
    if (!input || input === 'auto') return 'standard';
    if (input === 'low' || input === 'medium') return 'standard';
    if (input === 'high') return 'hd';
    return allowed.has(input) ? input : 'standard';
  }

  if (isDalle2) {
    return 'standard';
  }

  return input || 'auto';
}

function normalizeSize(input) {
  if (isGptImage) {
    const allowed = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);
    return allowed.has(input) ? input : 'auto';
  }

  if (isDalle3) {
    const allowed = new Set(['1024x1024', '1792x1024', '1024x1792']);
    return allowed.has(input) ? input : '1024x1024';
  }

  if (isDalle2) {
    const allowed = new Set(['256x256', '512x512', '1024x1024']);
    return allowed.has(input) ? input : '1024x1024';
  }

  return input || '1024x1024';
}

const size = normalizeSize(requestedSize);
const quality = normalizeQuality(requestedQuality);

const isAzureDeploymentPath = apiBase.toLowerCase().includes('/openai/deployments/');
const generateUrl = isAzureDeploymentPath
  ? apiBase + '/images/generations?api-version=' + encodeURIComponent(apiVersion)
  : apiBase + '/v1/images/generations';

const requestBody = isAzureDeploymentPath
  ? { prompt, size, quality }
  : { model, prompt, size, quality };

return [{
  json: {
    prompt,
    size,
    quality,
    model,
    apiBase,
    apiKey,
    isAzureDeploymentPath,
    generateUrl,
    requestBody,
  },
}];`;

fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log('Patched Prepare Image Request jsCode');

call.continueOnFail = true;

build.parameters = build.parameters || {};
build.parameters.jsCode = `const arr = Array.isArray($json.data) ? $json.data : [];
const first = arr[0] || {};

if ($json.image_disabled || $json.disabled_reason) {
  return [{
    json: {
      response: 'Afbeelding-generatie is momenteel uitgeschakeld door de beheerder.',
      image_url: null,
      has_base64: false,
      image_disabled: true,
    },
  }];
}

if ($json.error) {
  const message = String($json.error?.message || $json.error || '').trim();
  return [{
    json: {
      response: message ? 'Afbeelding-generatie mislukt: ' + message : 'Afbeelding-generatie mislukt.',
      image_url: null,
      has_base64: false,
      image_error: true,
    },
  }];
}

const httpUrl = String(first.url || '').trim();
const b64 = String(first.b64_json || '').trim();
const publicBase = String($env.PUBLIC_BASE_URL || '').replace(/\\/$/, '');

if (httpUrl) {
  const markdown = '![gegenereerde afbeelding](' + httpUrl + ')';
  return [{
    json: {
      response: markdown,
      image_url: httpUrl,
      markdown,
      has_base64: false,
    },
  }];
}

if (b64) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const fileName = 'generated-' + Date.now() + '-' + crypto.randomUUID() + '.png';
  const outDir = '/shared-images';
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, fileName);
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));

  const imageUrl = publicBase
    ? publicBase + '/images/' + fileName
    : '/images/' + fileName;
  const markdown = '![gegenereerde afbeelding](' + imageUrl + ')';

  return [{
    json: {
      response: markdown,
      image_url: imageUrl,
      markdown,
      has_base64: true,
      base64_length: b64.length,
      stored_file: fileName,
    },
  }];
}

throw new Error('Geen afbeelding URL/b64 ontvangen van image API');`;

fs.writeFileSync(path, JSON.stringify(data, null, 2));
console.log('Patched Build Image Response jsCode');

