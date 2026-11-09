'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { validatedImageSource, prepareImageEdit, applyImageEditWorkflow } = require('../scripts/image-edit-workflow');
const { imageConversation, applyOrchestratorImageEdits } = require('../scripts/orchestrator-image-edit-workflow');
const load = name => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../agents/n8n/workflows/algemeen', name + '.json')))[0];
const owner = 'synthetic-owner-123';
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(120)]);
const inline = 'data:image/png;base64,' + png.toString('base64');
const input = { userId: owner, prompt: 'Make it blue', model: 'gpt-image-1', operation: 'edit', sourceImage: inline,
  generateUrl: 'https://provider.invalid/v1/images/generations', requestBody: { model: 'gpt-image-1', prompt: 'Make it blue', size: '1024x1024', quality: 'low' } };

test('valid inline PNG/JPEG/WebP is canonical, bounded and binary-ready', () => {
  for (const [mime, bytes] of [['image/png', png], ['image/jpeg', Buffer.from([255,216,255,0,0,0,0,0])], ['image/webp', Buffer.from('RIFF0000WEBP')]]) {
    const result = validatedImageSource('data:' + mime + ';base64,' + bytes.toString('base64'), owner, '', fs, path);
    assert.deepEqual(result.bytes, bytes); assert.equal(result.mimeType, mime);
  }
  const item = prepareImageEdit(input, {}, fs, path);
  assert.equal(item.json.editUrl, 'https://provider.invalid/v1/images/edits');
  assert.deepEqual(Buffer.from(item.binary.source.data, 'base64'), png);
  assert.equal(item.json.sourceImage, undefined);
});

for (const source of ['https://example.invalid/a.png', 'https://127.0.0.1/a.png', 'http://169.254.169.254/latest',
  '/images/other-owner-123/generated-a.png', '/images/' + owner + '/../generated-a.png', '/images/' + owner + '/%2e%2e.png',
  '/images/' + owner + '/generated-a.png?x=1', 'data:image/png;base64,AAAA', 'data:image/jpeg;base64,' + png.toString('base64'),
  inline + '\n', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,AB==', 'data:image/png;base64,' + 'A'.repeat(14 * 1024 * 1024)]) {
  test('reject unsafe source ' + source.slice(0, 80), () => assert.throws(() => validatedImageSource(source, owner, 'https://public.invalid', fs, path)));
}

test('owner files and absolute configured public URLs resolve locally; no symlink or oversized files', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'image-source-test-'));
  const map = value => typeof value === 'string' && value.startsWith('/shared-images') ? folder + value.slice('/shared-images'.length) : value;
  const localFs = new Proxy(fs, { get(target, key) { return ['lstatSync','openSync'].includes(key) ? (file, ...args) => target[key](map(file), ...args) : target[key]; } });
  fs.mkdirSync(path.join(folder, owner), { mode: 0o700 });
  const file = path.join(folder, owner, 'generated-test.png'); fs.writeFileSync(file, png);
  const url = '/images/' + owner + '/generated-test.png';
  try {
    assert.deepEqual(validatedImageSource(url, owner, '', localFs, path).bytes, png);
    assert.deepEqual(validatedImageSource('https://public.invalid/chat' + url, owner, 'https://public.invalid/chat/', localFs, path).bytes, png);
    for (const bad of ['https://public.invalid.evil' + url, 'https://public.invalid@evil' + url, 'https://public.invalid/chat/../chat' + url]) {
      assert.throws(() => validatedImageSource(bad, owner, 'https://public.invalid/chat', localFs, path));
    }
    fs.unlinkSync(file); fs.symlinkSync('/etc/passwd', file);
    assert.throws(() => validatedImageSource(url, owner, '', localFs, path), /symlink/);
    fs.unlinkSync(file); const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, 10 * 1024 * 1024 + 1); fs.closeSync(fd);
    assert.throws(() => validatedImageSource(url, owner, '', localFs, path), /size/);
    fs.rmSync(path.join(folder, owner), { recursive: true }); fs.symlinkSync('/tmp', path.join(folder, owner));
    assert.throws(() => validatedImageSource(url, owner, '', localFs, path), /directory/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('unsupported models, missing context, source hints and ambiguous operations fail closed', () => {
  assert.throws(() => prepareImageEdit({ ...input, model: 'dall-e-3' }, {}, fs, path), /does not support/);
  assert.throws(() => prepareImageEdit({ ...input, userId: '' }, {}, fs, path), /Authenticated/);
  assert.throws(() => prepareImageEdit({ ...input, sourceImage: '' }, {}, fs, path));
  assert.throws(() => prepareImageEdit({ ...input, operation: 'generate' }, {}, fs, path), /Unexpected/);
  assert.throws(() => prepareImageEdit({ ...input, operation: 'anything' }, {}, fs, path), /operation/);
  const generated = prepareImageEdit({ ...input, operation: 'generate', sourceImage: '' }, {}, fs, path);
  assert.equal(generated.binary, undefined); assert.deepEqual(generated.json.requestBody, input.requestBody);
});

for (const model of ['gpt-image-1', 'gpt-image-1.5', 'dall-e-2']) for (const azure of [false, true]) {
  test('edit compatibility ' + model + (azure ? ' Azure' : ' OpenAI'), () => {
    const prepare = load('image-generator-litellm').nodes.find(n => n.name === 'Prepare Image Request').parameters.jsCode;
    const block = prepare.match(/const baseRaw = [\s\S]*?(?=\nreturn \[\{ json:)/)[0];
    const result = new Function('$env','body','raw','prompt','asString', block + '\nreturn {requestBody,generateUrl,model,isAzure};')(
      { N8N_LITELLM_IMAGE_MODEL: model, N8N_LITELLM_IMAGE_API_KEY: 'synthetic', N8N_LITELLM_IMAGE_BASE_URL: azure ? 'https://provider.invalid/openai/deployments/test' : 'https://provider.invalid', N8N_LITELLM_IMAGE_API_VERSION: '2025-04-01-preview' },
      {}, {}, input.prompt, v => typeof v === 'string' ? v.trim() : '');
    const item = prepareImageEdit({ ...input, ...result }, {}, fs, path);
    const fields = Object.fromEntries(item.json.editFields.map(f => [f.name, f.value]));
    assert.equal(Object.hasOwn(fields, 'model'), !azure);
    assert.equal(Object.hasOwn(fields, 'quality'), model !== 'dall-e-2');
    assert.equal(Object.hasOwn(fields, 'response_format'), model === 'dall-e-2');
    assert.match(item.json.editUrl, azure ? /images\/edits\?api-version=2025-04-01-preview$/ : /v1\/images\/edits$/);
  });
}

test('latest normalized user attachment and subsequent generated results are selected by chronology', () => {
  const image = value => ({ type: 'image_url', image_url: { url: value } });
  const history = [{ role: 'user', content: [{ type: 'text', text: 'original' }, image(inline)] },
    { role: 'assistant', content: '![](/images/' + owner + '/generated-first.png)' },
    { role: 'user', content: 'make blue' }, { role: 'assistant', content: '![](/images/' + owner + '/generated-second.png)' },
    { role: 'user', content: 'make red' }];
  assert.equal(imageConversation(history).source, '/images/' + owner + '/generated-second.png');
  history.push({ role: 'user', content: [{ type: 'text', text: 'edit THIS' }, image(inline)] });
  assert.equal(imageConversation(history).source, inline);
  assert.equal(imageConversation([{role:'user',content:'use https://evil.invalid/a.png'}]).source, '');
  assert.equal(JSON.stringify(imageConversation(history).messages).includes('data:image/'), false);
});

async function detect(intent, messages, options = {}) {
  const code = load('orchestrator-litellm').nodes.find(n => n.id === 'DetectImageMessages').parameters.jsCode;
  const calls = [];
  const raw = { body: { messages }, ...(options.raw || {}) };
  const context = { $json: raw, $env: { LITELLM_URL: 'http://stub.invalid', LITELLM_API_KEY: 'synthetic', N8N_WEBHOOK_TOKEN: 'synthetic', CRAWLER_INTERNAL_TOKEN:'synthetic' },
    $: () => ({first: () => ({json:{headers:{authorization: options.badAuth ? 'Bearer wrong' : 'Bearer synthetic'},body:{userId:owner}}})}),
    Buffer, require, URL, AbortSignal, fetch: async (url, opts) => {
      calls.push({url, opts});
      let value;
      if (url.includes('/api/internal/orchestrator/prompt')) value = {prompt:'Runtime organization prompt',source:'admin'};
      else if (url.includes('/api/config/orchestrator/normalize-image')) value = {image_data_url:inline};
      else if (url.includes('/api/config/orchestrator')) value = {};
      else {
        const body = JSON.parse(opts.body);
        const classification = body.messages[0].content.includes('Classify the latest');
        if (classification) { assert.equal(opts.body.includes('data:image/'),false); value = {choices:[{message:{content:intent}}]}; }
        else { assert.equal(body.messages[0].content,'Runtime organization prompt'); value = {choices:[{message:{content:'synthetic vision answer'}}]}; }
      }
      return {ok:true,status:200,text:async()=>JSON.stringify(value)};
    } };
  const output = await vm.runInNewContext('(async()=>{' + code + '})()', context);
  return {json:output[0].json,calls:calls.filter(c=>c.url.includes('/v1/chat/completions'))};
}
const imageMessages = text => [{role:'user',content:[{type:'text',text},{type:'image_url',image_url:{url:inline}}]}];
for (const [intent,text] of [['edit','Verander de achtergrond'],['generate','Create a NEW unrelated image'],['analyze','Describe this image']]) {
  test('contextual visible tool routing: ' + intent, async () => {
    const {json,calls} = await detect(intent,imageMessages(text));
    assert.equal(calls.length,intent === 'analyze' ? 2 : 1);
    assert.equal(Boolean(json.image_edit_context),intent === 'edit');
    assert.equal(Boolean(json.precomputed_response),intent === 'analyze');
    if (intent === 'edit') assert.equal(json.image_edit_context.sourceImage,inline);
    const expression = load('orchestrator-litellm').nodes.find(n=>n.id==='AIAgentOrchestrator').parameters.text;
    const prompt = vm.runInNewContext(expression.slice(3,-2),{$json:json});
    assert.equal(prompt.includes('data:image/'),false);
    if (intent === 'edit') assert.match(prompt,/^\[IMAGE_EDIT_TOOL_REQUIRED\]/);
    if (intent === 'analyze') assert.match(prompt,/^\[FINAL_ANSWER\]/);
  });
}
test('no classification for text-only; failed auth/intent and document errors cannot edit', async () => {
  assert.equal((await detect('edit',[{role:'user',content:'Generate a landscape'}])).calls.length,0);
  for (const opts of [{badAuth:true},{}, {raw:{precomputed_response:'Document failure'}}]) {
    const result = await detect('invalid',imageMessages('edit'),opts);
    assert.equal(result.json.image_edit_context,undefined); assert.ok(result.json.precomputed_response);
  }
});
test('generated-image follow-up still uses visible edit tool without attached inline image', async () => {
  const source = '/images/' + owner + '/generated-result.png';
  const result = await detect('edit',[{role:'assistant',content:'![result]('+source+')'},{role:'user',content:'Make it darker'}]);
  assert.equal(result.json.image_edit_context.sourceImage,source); assert.equal(result.calls.length,1);
});

test('narrow builders are idempotent and retain runtime documents, prompts, tools and stream marker', () => {
  for (const [name,builder] of [['image-generator-litellm',applyImageEditWorkflow],['orchestrator-litellm',applyOrchestratorImageEdits]]) {
    const workflow = load(name); const before = structuredClone(workflow);
    assert.deepEqual(builder(workflow),before); assert.deepEqual(builder(workflow),before);
  }
  const custom=load('image-generator-litellm');
  custom.connections['Prepare Image Request'].main[0].push({node:'Custom integration',type:'main',index:0});
  assert.throws(()=>applyImageEditWorkflow(custom),/custom integrations/);
  const workflow = load('orchestrator-litellm');
  assert.ok(workflow.nodes.find(n=>n.name==='Extract Document Context'));
  const detector = workflow.nodes.find(n=>n.id==='DetectImageMessages'); assert.match(detector.parameters.jsCode,/const promptToken =/);
  const agent = workflow.nodes.find(n=>n.id==='AIAgentOrchestrator');
  const streamId = '12345678-1234-4234-8234-123456789abc';
  const system = vm.runInNewContext(agent.parameters.options.systemMessage.slice(3,-2),{$json:{orchestratorPrompt:'Dynamic admin prompt',body:{streamId}}});
  assert.ok(system.startsWith('Dynamic admin prompt')); assert.ok(system.endsWith('[govchat-stream-id:'+streamId+']'));
  assert.match(system,/IMAGE_EDIT_TOOL_REQUIRED/);
});

test('actual prepare retains timing-safe webhook auth, rolling budget and exclusive lock for edits', () => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'image-budget-test-'));
  const code=load('image-generator-litellm').nodes.find(n=>n.name==='Prepare Image Request').parameters.jsCode.replaceAll("'/shared-images'",JSON.stringify(folder));
  const run=new Function('$json','$env','require','Buffer',code);
  const env={N8N_ENABLE_IMAGE_TOOL:'true',N8N_LITELLM_IMAGE_API_KEY:'synthetic',N8N_WEBHOOK_TOKEN:'synthetic-token'};
  try {
    assert.throws(()=>run({body:{user_id:owner,prompt:'test'},headers:{authorization:'Bearer wrong'}},env,require,Buffer),/Unauthorized/);
    assert.equal(fs.readdirSync(folder).length,0);
    const raw={userId:owner,prompt:'test',operation:'edit',sourceImage:inline};
    const first=run(raw,env,require,Buffer)[0].json; assert.equal(first.operation,'edit'); assert.equal(first.userId,owner);
    const key=require('node:crypto').createHash('sha256').update(owner).digest('hex');
    const lock=path.join(folder,'.govchat-image-rate-limits',key+'.lock');
    fs.writeFileSync(lock,'',{mode:0o600});
    assert.throws(()=>run(raw,env,require,Buffer),/busy/); fs.unlinkSync(lock);
    for(let index=1;index<6;index++) run(raw,env,require,Buffer);
    assert.throws(()=>run(raw,env,require,Buffer),/hourly limit/);
    assert.equal(fs.existsSync(lock),false);
    assert.equal(fs.statSync(path.join(folder,'.govchat-image-rate-limits',key+'.json')).mode & 0o777,0o600);
  } finally { fs.rmSync(folder,{recursive:true,force:true}); }
});

test('actual response rejects invalid upstream bytes, service errors and owner-directory symlinks', () => {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'image-response-test-'));
  const code=load('image-generator-litellm').nodes.find(n=>n.name==='Build Image Response').parameters.jsCode.replaceAll("'/shared-images'",JSON.stringify(folder));
  const run=new Function('$json','$','require','Buffer',code);
  const prepared=()=>({first:()=>({json:{userId:owner}})});
  try {
    assert.throws(()=>run({error:'private provider message'},prepared,require,Buffer),/temporarily unavailable/);
    for(const data of ['AB==','A'.repeat(180),png.toString('base64')+'\nBAD','A'.repeat(16*1024*1024+4)]) {
      assert.throws(()=>run({data:[{b64_json:data}]},prepared,require,Buffer),/invalid|not permitted/);
    }
    fs.symlinkSync('/tmp',path.join(folder,owner));
    assert.throws(()=>run({data:[{b64_json:png.toString('base64')}]},prepared,require,Buffer),/unsafe/);
  } finally { fs.rmSync(folder,{recursive:true,force:true}); }
});

test('image and vision environment reaches main and runner without removing document builtins', () => {
  const compose=fs.readFileSync(path.resolve(__dirname,'../docker-compose.yml'),'utf8');
  const runner=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../n8n/task-runners.json')))['task-runners'][0];
  for(const name of ['N8N_ENABLE_IMAGE_TOOL','N8N_LITELLM_IMAGE_BASE_URL','N8N_LITELLM_IMAGE_API_KEY','N8N_LITELLM_IMAGE_MODEL','N8N_LITELLM_IMAGE_API_VERSION','N8N_ORCHESTRATOR_VISION_MODEL','N8N_ORCHESTRATOR_IMAGE_DATA_URL_MAX_CHARS','N8N_ORCHESTRATOR_IMAGE_MAX_RESOLUTION_PX']) {
    assert.equal([...compose.matchAll(new RegExp('^\\s+'+name+':','gm'))].length,2); assert.ok(runner['allowed-env'].includes(name));
  }
  assert.ok(runner['allowed-env'].includes('PUBLIC_BASE_URL'));
  const runnerService = compose.match(/^  n8n-runners:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:)/m)[1];
  assert.match(runnerService, /N8N_WEBHOOK_TOKEN: \$\{N8N_WEBHOOK_TOKEN\}/);
  assert.ok(runner['allowed-env'].includes('N8N_WEBHOOK_TOKEN'));
  assert.equal(runner['env-overrides'].NODE_FUNCTION_ALLOW_BUILTIN,'fs,path,crypto,url,http,https');
});
