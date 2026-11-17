'use strict';
// Opt-in real bridge + production orchestrator test. No substitute agent/prompt.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const cases = {
  count:'Hoeveel stukken staan er in de OpenBesluitvorming database?',
  year:'Hoeveel stukken staan er per jaar in de OpenBesluitvorming database? Geef alle jaren en exacte aantallen.',
  type:'Hoeveel stukken staan er per documenttype in de OpenBesluitvorming database? Geef de classificaties en exacte aantallen.',
  status:'Wanneer is de OpenBesluitvorming database voor het laatst gesynchroniseerd? Is de volledige synchronisatie succesvol en zijn er mislukte documenten?',
  nested:'Hoeveel stukken in de OpenBesluitvorming database hebben leverancier ibabs? Ontdek de metadata voor het exacte bronveld.',
  zero:'Hoeveel stukken in de OpenBesluitvorming database hebben classification exact gelijk aan __obv_stats_nonexistent_fixture__?',
  fields:'Welke metadatavelden zijn beschikbaar? Het gaat om de OpenBesluitvorming database. Geef het exacte totale aantal beschikbare metadatavelden en vermeld of de volledige schema-scan alle stukken omvatte.',
  supplier:'Hoeveel stukken hebben supplier ibabs? Het gaat om de OpenBesluitvorming database. Ontdek eerst het exacte metadataveld en tel daarna exact.',
  nested_year:'Groepeer de stukken in de OpenBesluitvorming database op het geneste metadataveld source_payload.classification, alleen voor het kalenderjaar 2020 (date vanaf 2020-01-01 tot exclusief 2021-01-01). Geef alle categorieën en hun exacte aantallen.',
  numeric:'Hoeveel stukken in de OpenBesluitvorming database hebben het numerieke metadataveld source_sequence groter dan of gelijk aan het getal 0? Gebruik een getypeerd numeriek filter en geef het exacte aantal.',
};
function decode(sse) {
  let content = ''; const events = [];
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const data = JSON.parse(line.slice(6));
    if (data.error) throw new Error('Bridge returned a stream error');
    content += data.choices?.[0]?.delta?.content || '';
  }
  const answer = content.replace(/\x1eLCSTEP:([A-Za-z0-9+/=_-]+)\x1f/g,(_,encoded)=>{events.push(JSON.parse(Buffer.from(encoded,'base64').toString('utf8')));return '';});
  const calls = events.filter(e=>e.event==='on_run_step').flatMap(e=>e.data?.stepDetails?.tool_calls || []);
  return {answer,calls,completed:events.filter(e=>e.event==='on_run_step_completed').map(e=>e.data.result.tool_call)};
}
async function main() {
  if (process.env.OBV_STATS_CHAT_SMOKE !== '1') throw new Error('Set OBV_STATS_CHAT_SMOKE=1; each selected case runs a paid model request');
  const token = process.env.BEARER_TOKEN || process.env.N8N_OPENAI_BRIDGE_BEARER_TOKEN;
  if (!token) throw new Error('Bridge token not configured');
  const selected = process.argv.slice(2); const result = {started_at:new Date().toISOString(),model:'govchat-orchestrator',cases:[]};
  for (const key of selected.length ? selected : ['count','year','type','status','nested','zero']) {
    assert.ok(cases[key],'Unknown case');
    const start = Date.now();
    const response = await fetch((process.env.OBV_STATS_BRIDGE_URL || 'http://localhost:3333')+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({model:'govchat-orchestrator',stream:true,messages:[{role:'user',content:cases[key]}]}),signal:AbortSignal.timeout(600000)});
    assert.equal(response.status,200);
    const decoded = decode(await response.text());
    const record = {case:key,http_status:response.status,duration_ms:Date.now()-start,...decoded};
    result.cases.push(record);
    fs.writeFileSync(process.env.OBV_STATS_CHAT_REPORT || '/tmp/obv-statistics-chat-report.json',JSON.stringify(result,null,2));
    console.log(JSON.stringify({...record,completed:decoded.completed.map(c=>({id:c?.id,name:c?.name}))}));
    assert.ok(decoded.calls.length>0,'Agent did not call a tool');
    assert.ok(decoded.calls.every(c=>c.name==='openbesluitvorming_statistics_tool'),'Unexpected RAG/embedding/other tool');
    assert.ok(decoded.completed.length>0,'No completed tool event');
    if(key==='count') assert.match(decoded.answer,/56[.,\s]?475/);
    if(key==='status') {assert.match(decoded.answer,/203/);assert.match(decoded.answer,/2026|16 november/);assert.match(decoded.answer,/niet|onbekend|aangetoond/i);}
    if(key==='nested') assert.equal(JSON.parse(decoded.calls[0].args.query).operation,'fields','Unknown field was guessed');
    if(key==='zero') assert.match(decoded.answer,/\b0\b|geen stukken/i);
    if(key==='fields') assert.match(decoded.answer,/\b199\b/);
    if(key==='supplier') {
      assert.equal(JSON.parse(decoded.calls[0].args.query).operation,'fields','Supplier field was guessed');
      assert.ok(decoded.calls.some(c=>JSON.parse(c.args.query).operation==='count'),'No supplier count call');
      assert.match(decoded.answer,/56[.,\s]?475/);
    }
    if(key==='nested_year') assert.ok(decoded.calls.some(c=>{const q=JSON.parse(c.args.query);return q.operation==='group' && /^source_payload\.classification(?:\[\])?$/.test(q.field) && q.filters?.some(f=>f.operator==='range' && f.gte==='2020-01-01' && f.lt==='2021-01-01');}),'Missing nested grouping with year filter');
    if(key==='numeric') {
      assert.ok(decoded.calls.some(c=>{const q=JSON.parse(c.args.query);return q.operation==='count' && q.filters?.some(f=>f.field==='source_sequence' && f.operator==='range' && f.gte===0);}), 'Missing typed numeric count');
      assert.match(decoded.answer,/56[.,\s]?475/);
    }
  }
}
module.exports = {decode,cases};
if(require.main===module) main().catch(e=>{console.error(e.message);process.exitCode=1;});
