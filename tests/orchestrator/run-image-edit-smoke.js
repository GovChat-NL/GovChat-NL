'use strict';
// Real pinned n8n Code/IF/HTTP nodes with a loopback-only provider stub.
// Run only in a disposable container with an EMPTY /shared-images tmpfs.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'govchat-image-edit-smoke-'));
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(120)]);
const inline = 'data:image/png;base64,' + png.toString('base64');
let expected;
let calls = 0;
let serverError;
const server = http.createServer(async (req,res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    calls++;
    assert.equal(req.method,'POST');
    const route = expected.operation === 'edit' ? 'edits' : 'generations';
    assert.equal(req.url, expected.azure ? '/openai/deployments/synthetic/images/' + route + '?api-version=2025-04-01-preview' : '/v1/images/' + route);
    if (expected.azure) { assert.equal(req.headers['api-key'],'synthetic-key'); assert.ok(!req.headers.authorization); }
    else { assert.equal(req.headers.authorization,'Bearer synthetic-key'); assert.ok(!req.headers['api-key']); }
    if (expected.operation === 'edit') {
      assert.match(req.headers['content-type'],/^multipart\/form-data; boundary=/);
      const text = bytes.toString('latin1');
      assert.match(text,/name="image"; filename="source.png"/);
      assert.match(text,/Content-Type: image\/png/i);
      assert.ok(bytes.includes(png),'actual source bytes in multipart');
      assert.match(text,/name="prompt"\r\n\r\nSynthetic edit prompt/);
      assert.equal(text.includes('name="model"'),!expected.azure);
      assert.equal(text.includes('name="quality"'),expected.model.startsWith('gpt-image'));
      assert.equal(text.includes('name="response_format"'),expected.model==='dall-e-2');
    } else {
      assert.match(req.headers['content-type'],/application\/json/);
      const body = JSON.parse(bytes); assert.equal(body.model,expected.model); assert.equal(body.prompt,'Synthetic edit prompt');
      assert.equal(body.response_format,undefined);
    }
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));
  } catch (error) { serverError = error; res.statusCode=500; res.end('synthetic fixture failed'); }
});

async function main() {
  assert.equal(fs.readdirSync('/shared-images').length,0,'smoke requires empty disposable storage');
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const env = { PATH:process.env.PATH, HOME:folder, DB_TYPE:'sqlite', N8N_USER_FOLDER:path.join(folder,'user'),
    N8N_ENCRYPTION_KEY:'synthetic-smoke-key', N8N_DIAGNOSTICS_ENABLED:'false', N8N_VERSION_NOTIFICATIONS_ENABLED:'false',
    N8N_RUNNERS_ENABLED:'false', N8N_BLOCK_ENV_ACCESS_IN_NODE:'false', NODE_FUNCTION_ALLOW_BUILTIN:'fs,path,crypto,url,http,https',
    N8N_ENABLE_IMAGE_TOOL:'true', N8N_LITELLM_IMAGE_API_KEY:'synthetic-key', N8N_LITELLM_IMAGE_API_VERSION:'2025-04-01-preview',
    PUBLIC_BASE_URL:'https://public.invalid',
    N8N_SSRF_PROTECTION_ENABLED:'true', N8N_SSRF_ALLOWED_IP_RANGES:'127.0.0.0/8', N8N_SSRF_ALLOWED_HOSTNAMES:'127.0.0.1', NO_PROXY:'*' };
  const cases = [{model:'gpt-image-1',azure:false,operation:'edit'}, {model:'gpt-image-1',azure:true,operation:'edit'},
    {model:'dall-e-2',azure:false,operation:'edit'}, {model:'dall-e-2',azure:true,operation:'edit'},
    {model:'gpt-image-1',azure:false,operation:'generate'}, {model:'gpt-image-1',azure:false,operation:'edit',sourceFile:true}];
  const workflows = cases.map((item,index)=>{
    const workflow = JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../agents/n8n/workflows/image-generator-litellm.json')))[0];
    for (const key of ['versionMetadata','versionId','activeVersionId','shared','pinData','staticData','sourceWorkflowId']) delete workflow[key];
    workflow.id='synthetic-image-smoke-'+index; workflow.name=workflow.id; workflow.active=false;
    workflow.nodes=workflow.nodes.filter(n=>!['When Executed by Another Workflow','Webhook Image Generator'].includes(n.name));
    delete workflow.connections['When Executed by Another Workflow']; delete workflow.connections['Webhook Image Generator'];
    workflow.nodes.unshift({id:'start',name:'Start',type:'n8n-nodes-base.manualTrigger',typeVersion:1,position:[-1000,0],parameters:{}});
    const payload={userId:'synthetic-owner-'+(item.sourceFile?0:index),prompt:'Synthetic edit prompt',operation:item.operation,sourceImage:item.operation==='edit'?inline:''};
    const fixtureCode = item.sourceFile ? 'const payload='+JSON.stringify(payload)+"; payload.sourceImage='https://public.invalid/images/synthetic-owner-0/'+require('fs').readdirSync('/shared-images/synthetic-owner-0')[0]; return [{json:payload}];" : 'return [{json:'+JSON.stringify(payload)+'}];';
    workflow.nodes.push({id:'fixture',name:'Fixture Input',type:'n8n-nodes-base.code',typeVersion:2,position:[-800,0],parameters:{jsCode:fixtureCode}});
    workflow.connections.Start={main:[[{node:'Fixture Input',type:'main',index:0}]]};
    workflow.connections['Fixture Input']={main:[[{node:'Prepare Image Request',type:'main',index:0}]]};
    return workflow;
  });
  fs.writeFileSync(path.join(folder,'workflows.json'),JSON.stringify(workflows));
  async function cli(args,extra={}) {
    const child=spawn('n8n',args,{env:{...env,...extra}}); let output='';
    child.stdout.on('data',chunk=>output+=chunk); child.stderr.on('data',chunk=>output+=chunk);
    const timer=setTimeout(()=>child.kill('SIGKILL'),90000);
    const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);}); clearTimeout(timer);
    if(serverError) throw serverError;
    if(code!==0) throw new Error('isolated n8n smoke failed: '+output.slice(-5000));
    return output;
  }
  try {
    await cli(['import:workflow','--input='+path.join(folder,'workflows.json')]);
    for (const [index,item] of cases.entries()) {
      expected=item; const before=calls;
      const ownerIndex=item.sourceFile?0:index;
      const directory=path.join('/shared-images','synthetic-owner-'+ownerIndex);
      const beforeFiles=fs.existsSync(directory)?fs.readdirSync(directory):[];
      const output=await cli(['execute','--id=synthetic-image-smoke-'+index,'--rawOutput'],{
        N8N_LITELLM_IMAGE_MODEL:item.model,N8N_LITELLM_IMAGE_BASE_URL:base+(item.azure?'/openai/deployments/synthetic':'')});
      assert.equal(calls,before+1,'exactly one routed API request');
      const allFiles=fs.readdirSync(directory); assert.equal(allFiles.length,beforeFiles.length+1);
      const files=allFiles.filter(file=>!beforeFiles.includes(file)); assert.equal(files.length,1);
      assert.deepEqual(fs.readFileSync(path.join(directory,files[0])),png);
      assert.equal(fs.statSync(directory).mode & 0o777,0o700); assert.equal(fs.statSync(path.join(directory,files[0])).mode & 0o777,0o600);
      assert.ok(output.includes('/images/synthetic-owner-'+ownerIndex+'/generated-'));
      console.log('PASS real n8n '+item.model+' '+(item.azure?'Azure':'bearer')+' '+item.operation+(item.sourceFile?' owner-file follow-up':'')+' routing, HTTP body and owner output');
    }
    console.log('Stub provider only; no live workflow, actual upstream or UI evaluation tested');
  } finally {
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); fs.rmSync(folder,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
