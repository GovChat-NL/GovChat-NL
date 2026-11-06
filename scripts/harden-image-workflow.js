const fs = require('fs');
const path = require('path');

const workflowPath = path.resolve(__dirname, '../agents/n8n/workflows/image-generator-litellm.json');
const fileContents = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const workflow = Array.isArray(fileContents) ? fileContents[0] : fileContents;
const findNode = (name) => workflow.nodes.find((node) => node.name === name);
const prepareNode = findNode('Prepare Image Request');
const callNode = findNode('Call Images API');
const responseNode = findNode('Build Image Response');
const triggerNode = findNode('When Executed by Another Workflow');

if (!prepareNode || !callNode || !responseNode || !triggerNode) {
  throw new Error('Required image workflow nodes were not found');
}

triggerNode.parameters = {
  ...(triggerNode.parameters || {}),
  workflowInputs: {
    values: [{ name: 'prompt' }, { name: 'size' }, { name: 'quality' }],
  },
};

prepareNode.parameters.jsCode = String.raw`const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const raw = $json || {};
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const asString = (value) => typeof value === 'string' ? value.trim() : '';
const body = isObject(raw.body) ? raw.body : raw;
const headers = isObject(raw.headers) ? raw.headers : {};
const isWebhook = Object.keys(headers).length > 0 || Object.prototype.hasOwnProperty.call(raw, 'body');

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

if (isWebhook) {
  const expected = String($env.IMAGE_JOBS_WEBHOOK_TOKEN || $env.N8N_WEBHOOK_TOKEN || '').trim();
  const headerToken = String(headers['x-govchat-token'] || headers['X-Govchat-Token'] || '').trim();
  const auth = String(headers.authorization || headers.Authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!expected || !safeEqual(headerToken || bearer, expected)) throw new Error('Unauthorized webhook request');
}

// Webhook identity is accepted only from the service-authenticated internal caller;
// tool executions may only inherit the trusted userId property, never a model argument.
const userId = isWebhook ? asString(body.user_id) : asString(raw.userId);
if (!/^[A-Za-z0-9_-]{8,64}$/.test(userId)) throw new Error('Authenticated user context is missing');

// Apply one rolling per-user budget across the internal webhook and agent-tool
// entry points. A short exclusive lock prevents concurrent calls racing the cap.
function reserveUserGeneration(ownerId) {
  const root = path.resolve('/shared-images');
  const stateDirectory = path.join(root, '.govchat-image-rate-limits');
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDirectory, 0o700);
  const ownerKey = crypto.createHash('sha256').update(ownerId).digest('hex');
  const statePath = path.join(stateDirectory, ownerKey + '.json');
  const lockPath = path.join(stateDirectory, ownerKey + '.lock');
  let lockFd;
  let ownsLock = false;
  try {
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
      ownsLock = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ageMs;
      try {
        ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (statError.code === 'ENOENT') throw new Error('Image generation is busy; retry shortly');
        throw statError;
      }
      if (ageMs <= 30000) throw new Error('Image generation is busy; retry shortly');
      fs.unlinkSync(lockPath);
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
      ownsLock = true;
    }

    const now = Date.now();
    let events = [];
    if (fs.existsSync(statePath)) {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('Image rate-limit state is invalid');
      events = parsed.filter((time) => Number.isFinite(time) && time > now - 60 * 60 * 1000);
    }
    if (events.length >= 6) throw new Error('Image generation hourly limit reached');
    events.push(now);
    const tempPath = statePath + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(events), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tempPath, statePath);
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    if (ownsLock) {
      try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
reserveUserGeneration(userId);

function latestMessage(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const content = Array.isArray(message.content)
      ? message.content.map((part) => typeof part === 'string' ? part : asString(part?.text || part?.content)).filter(Boolean).join(' ')
      : asString(message.content || message.text || message.prompt || message.input);
    if (content.trim()) return content.trim();
  }
  return '';
}

let prompt = asString(body.prompt || body.text || body.input || body.query || body.message || body.user_input || latestMessage(body.messages));
prompt = prompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
if (!prompt) throw new Error('Prompt is required');
if (prompt.length > 2000) prompt = prompt.slice(0, 2000);

if (String($env.N8N_ENABLE_IMAGE_TOOL || 'false').toLowerCase() !== 'true') {
  throw new Error('Image generation is disabled');
}

const baseRaw = String($env.N8N_LITELLM_IMAGE_BASE_URL || $env.LITELLM_URL || 'http://litellm:4000').trim();
const apiBase = baseRaw.replace(/\/$/, '');
const apiKey = String($env.N8N_LITELLM_IMAGE_API_KEY || $env.LITELLM_API_KEY || '').trim();
const model = String($env.N8N_LITELLM_IMAGE_MODEL || 'gpt-image-1').trim();
const apiVersion = String($env.N8N_LITELLM_IMAGE_API_VERSION || '2024-02-01').trim();
if (!apiKey) throw new Error('Image provider is not configured');

const isAzure = apiBase.toLowerCase().includes('/openai/deployments/');
const modelLower = model.toLowerCase();
const requestedSize = asString(body.size || raw.size).toLowerCase();
const requestedQuality = asString(body.quality || raw.quality).toLowerCase();
const sizeOptions = modelLower.includes('dall-e-3')
  ? ['1024x1024', '1792x1024', '1024x1792']
  : modelLower.includes('dall-e-2')
    ? ['256x256', '512x512', '1024x1024']
    : ['1024x1024', '1536x1024', '1024x1536'];
const size = sizeOptions.includes(requestedSize) ? requestedSize : sizeOptions[0];
const isDalle2 = modelLower.includes('dall-e-2');
const qualityOptions = modelLower.includes('dall-e-3') ? ['standard', 'hd'] : ['auto', 'low', 'medium', 'high'];
const quality = isDalle2
  ? 'standard'
  : requestedQuality === 'hd' && qualityOptions.includes('high')
    ? 'high'
    : qualityOptions.includes(requestedQuality) ? requestedQuality : qualityOptions[0];
const generateUrl = isAzure
  ? apiBase + '/images/generations?api-version=' + encodeURIComponent(apiVersion)
  : apiBase + '/v1/images/generations';
// GPT Image always returns base64 and rejects DALL-E's response_format option.
const responseFormat = modelLower.startsWith('gpt-image-') ? {} : { response_format: 'b64_json' };
const requestBody = isAzure
  ? { prompt, size, ...(isDalle2 ? {} : { quality }), ...responseFormat }
  : { model, prompt, size, ...(isDalle2 ? {} : { quality }), ...responseFormat };

return [{ json: { userId, prompt, size, quality, model, apiKey, isAzure, isAzureDeploymentPath: isAzure, generateUrl, requestBody } }];`;

callNode.continueOnFail = true;
callNode.parameters.options = { ...(callNode.parameters.options || {}), timeout: 180000 };

responseNode.parameters.jsCode = String.raw`const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const prepare = $('Prepare Image Request').first().json || {};
if ($json.error || (Number($json.statusCode || 0) >= 400)) {
  throw new Error('Image generation service is temporarily unavailable');
}

const first = Array.isArray($json.data) ? $json.data.find(Boolean) || {} : {};
const base64 = String(first.b64_json || '').trim();
if (!base64 || base64.length < 100 || base64.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
  throw new Error('Image response payload is invalid');
}

const image = Buffer.from(base64, 'base64');
if (image.toString('base64') !== base64) throw new Error('Image response encoding is invalid');
const png = image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const jpeg = image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
if (!png && !jpeg) throw new Error('Image response format is not permitted');

const userId = String(prepare.userId || '').trim();
if (!/^[A-Za-z0-9_-]{8,64}$/.test(userId)) throw new Error('Authenticated user context is missing');
const root = path.resolve('/shared-images');
const userDirectory = path.resolve(root, userId);
if (!userDirectory.startsWith(root + path.sep)) throw new Error('Invalid image storage owner');
fs.mkdirSync(userDirectory, { recursive: true, mode: 0o700 });
fs.chmodSync(userDirectory, 0o700);
const extension = png ? 'png' : 'jpg';
const fileName = 'generated-' + Date.now() + '-' + crypto.randomUUID() + '.' + extension;
const filePath = path.join(userDirectory, fileName);
fs.writeFileSync(filePath, image, { flag: 'wx', mode: 0o600 });

const imageUrl = '/images/' + encodeURIComponent(userId) + '/' + fileName;
const markdown = '![gegenereerde afbeelding](' + imageUrl + ')';
return [{ json: { response: markdown, image_url: imageUrl, markdown, user_id: userId, stored_file: fileName } }];`;

workflow.settings = {
  ...(workflow.settings || {}),
  executionOrder: 'v1',
  callerPolicy: 'workflowsFromSameOwner',
  saveDataSuccessExecution: 'none',
  saveManualExecutions: false,
};

fs.writeFileSync(workflowPath, JSON.stringify(fileContents, null, 2) + '\n');
console.log('Hardened image workflow owner, input, response and storage handling');
