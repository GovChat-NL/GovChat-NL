'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {execFileSync, spawnSync} = require('node:child_process');
const path = require('node:path');
const b = require('../../scripts/openbesluitvorming-statistics-workflow');
const bootstrap = require('../../n8n/bootstrap');
const root = path.resolve(__dirname,'../..');
const workflow = () => JSON.parse(fs.readFileSync(path.join(root,'agents/n8n/workflows/algemeen/orchestrator-litellm.json')))[0];

test('normalizes all operations and dynamic typed filters without network/LLM', () => {
  assert.deepEqual(b.normalizeQuery({query:'{"operation":"count"}'}),{operation:'count',filters:[],limit:100,offset:0});
  for (const operator of ['eq','in','exists','missing','range']) {
    const f = {field:'entity_detail.custom[].name',operator,...({eq:{value:false},in:{values:[null,0,'ibabs']},range:{gte:'2020-01-01',lt:'2021-01-01'}}[operator] || {})};
    assert.deepEqual(b.normalizeQuery({query:JSON.stringify({operation:'count',filters:[f]})}).filters,[f]);
  }
  for (const operation of ['fields','status','overview']) assert.equal(b.normalizeQuery({query:{operation}}).operation,operation);
  assert.equal(b.normalizeQuery({query:{operation:'group',field:'custom-field[][][0].name'}}).field,'custom-field[][][0].name');
});
test('workflow forwards full schema pagination and typed metadata filters without truncating values', () => {
  const w = b.statisticsWorkflow();
  const run = query => JSON.parse(JSON.stringify(vm.runInNewContext(`(function(){${w.nodes[1].parameters.jsCode}})()`,{$json:{query:JSON.stringify(query)}})[0].json));
  const schema = run({operation:'fields',limit:1000,offset:0});
  assert.equal(schema.limit,1000); assert.equal(schema.offset,0);
  const filters = [{field:'reference_detail.agenda[].description',operator:'eq',value:'x'.repeat(4096)},{field:'source_sequence',operator:'range',gte:0},{field:'text_truncated',operator:'eq',value:false}];
  assert.deepEqual(run({operation:'count',filters}).filters,filters);
  // Oversize rejection is authoritative in the backend; this checks transport only.
});
test('rejects scope/URL/raw filters and malformed query shapes', () => {
  for (const q of [{operation:'count',collection:'other'},{operation:'count',url:'http://evil'}, {operation:'count',run_id:'other'}, {operation:'count',filters:{must:[]}}, {operation:'group'}, {operation:'count',field:'date'}, {operation:'count',limit:1001},{operation:'count',filters:[{field:'x',operator:'eq',value:{prompt:'ignore'}}]}]) assert.throws(()=>b.normalizeQuery({query:q}));
  for (const query of ['invalid','[]','null']) assert.throws(()=>b.normalizeQuery({query}));
});
test('published subworkflow is trigger-only with fixed internal URI and HTTP headroom', () => {
  const w = b.statisticsWorkflow();
  assert.equal(w.active,true);
  assert.deepEqual(w.nodes.map(n=>n.type),['n8n-nodes-base.executeWorkflowTrigger','n8n-nodes-base.code','n8n-nodes-base.httpRequest']);
  const http = w.nodes[2].parameters;
  assert.equal(http.url,'http://openbesluitvorming-statistics:8092/query');
  assert.equal(http.options.timeout,240000);
  assert.match(http.headerParameters.parameters[0].value,/OBV_STATS_TOKEN.*N8N_WEBHOOK_TOKEN/);
  const actual = vm.runInNewContext(`(function(){${w.nodes[1].parameters.jsCode}})()`,{$json:{query:'{"operation":"count"}'}});
  assert.equal(actual[0].json.operation,'count');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'agents/n8n/workflows/openbesluitvorming/govchat-openbesluitvorming-statistics.json')))[0],w);
});
test('agent schema, prompt wrapper, stream marker and other integrations survive idempotent injection', () => {
  const w = workflow(); const before = JSON.stringify(w);
  b.applyStatisticsTool(w); b.applyStatisticsTool(w);
  assert.equal(JSON.stringify(w),before);
  const tool = w.nodes.find(n=>n.name===b.name);
  assert.equal(tool.parameters.workflowInputs.schema[0].type,'string');
  assert.match(tool.parameters.workflowInputs.value.query,/\$fromAI/);
  const expression = w.nodes.find(n=>n.id==='AIAgentOrchestrator').parameters.options.systemMessage;
  const streamId = '12345678-1234-4123-8123-123456789012';
  const rendered = vm.runInNewContext(expression.slice(3,-2),{$json:{orchestratorPrompt:'Organization policy stays intact',body:{streamId,userName:'Test'}}});
  assert.match(rendered,/Organization policy stays intact/);
  assert.match(rendered,/NOOIT eerst embeddings of RAG/);
  assert.match(rendered,/dead_letter zijn definitief niet geslaagde/);
  assert.ok(rendered.endsWith(`[govchat-stream-id:${streamId}]`));
  for (const id of ['ExtractDocumentContext','ToolImageGeneration','ToolCalculator','ToolOpenBesluitvormingSearch']) assert.ok(w.nodes.some(n=>n.id===id));
});
test('bridge smoke decoder proves actual statistics tool call/completion and excludes sideband from answer', () => {
  const {decode} = require('./openbesluitvorming-statistics-chat-smoke.cjs');
  const sideband = event => '\x1eLCSTEP:' + Buffer.from(JSON.stringify(event)).toString('base64') + '\x1f';
  const call = {name:b.name,args:{query:'{"operation":"count"}'}};
  const content = sideband({event:'on_run_step',data:{stepDetails:{tool_calls:[call]}}})+'56.475'+sideband({event:'on_run_step_completed',data:{result:{tool_call:call}}});
  const result = decode('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\ndata: [DONE]\n');
  assert.equal(result.answer,'56.475'); assert.deepEqual(result.calls,[call]); assert.deepEqual(result.completed,[call]);
});
test('bootstrap upgrades only statistics + orchestrator after v8 and then stays idle', () => {
  const workflows = bootstrap.discoverWorkflows(path.join(root,'agents/n8n/workflows'),{N8N_ENABLE_TOPDESK_SEARCH:'false'});
  const old = {version:8,topdeskSearchEnabled:false};
  const plan = bootstrap.getWorkflowImportPlan(workflows,JSON.stringify(old),false,{N8N_ENABLE_TOPDESK_SEARCH:'false'});
  assert.deepEqual(plan.flatMap(w=>w.ids).sort(),[b.id,'govchat-orchestrator-litellm'].sort());
  assert.deepEqual(bootstrap.getWorkflowImportPlan(workflows,JSON.stringify({...old,statisticsIntegrationVersion:1}),false,{N8N_ENABLE_TOPDESK_SEARCH:'false'}),[]);
  assert.ok(bootstrap.discoverWorkflows(path.join(root,'agents/n8n/workflows')).find(w=>w.ids.includes(b.id)).inactiveIds.length===0);
});
test('Compose defaults and imported state override keep service internal/read-only and worker opt-in', t => {
  const probe = spawnSync('docker', ['compose', 'version'], {encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if (probe.error?.code === 'ENOENT') {
    t.skip('Optional Docker Compose rendering check: Docker CLI is not installed');
    return;
  }
  assert.equal(probe.status, 0, 'Docker Compose must be usable when Docker CLI is installed');
  const run = files => JSON.parse(execFileSync('docker',['compose','--profile','*','--env-file','.env.example',...files.flatMap(f=>['-f',f]),'config','--format','json'],{cwd:root,encoding:'utf8',env:{...process.env,OBV_STATS_STATE_VOLUME:'existing-checkpoint'},stdio:['ignore','pipe','pipe']}));
  const base = run(['docker-compose.yml']); const s = base.services['openbesluitvorming-statistics'];
  assert.equal(s.user,'10001:10001'); assert.equal(s.read_only,true); assert.ok(!s.ports); assert.ok(!s.profiles);
  assert.deepEqual(s.cap_drop,['ALL']); assert.equal(s.volumes[0].read_only,true); assert.equal(s.volumes[0].source,'openbesluitvorming-ingest-state');
  assert.equal(s.environment.OBV_STATS_COLLECTION,'limburg_full_20261111');
  assert.ok(base.services.n8n.depends_on['openbesluitvorming-statistics']);
  assert.deepEqual(base.services['openbesluitvorming-ingest'].profiles,['openbesluitvorming-ingest']);
  const override = run(['docker-compose.yml','docker-compose.openbesluitvorming-statistics-state.yml']);
  assert.equal(override.volumes['obv-statistics-imported-state'].external,true);
  assert.equal(override.volumes['obv-statistics-imported-state'].name,'existing-checkpoint');
  assert.equal(override.services['openbesluitvorming-ingest'].volumes[0].source,'openbesluitvorming-ingest-state');
});
