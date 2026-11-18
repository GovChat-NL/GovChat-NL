'use strict';

// Materialize full payloads only after RRF has deduplicated variants and chosen
// the bounded rerank pool. Source IDs remain available during candidate fusion.
const hydrateCode = `
// BEGIN OBV BOUNDED HYDRATION
const http = require('http'), https = require('https'), {URL}=require('url');
const fetchPoints = (ids) => new Promise((resolve,reject) => {
  const target = new URL(config.qdrant_base + '/collections/' + encodeURIComponent(config.collection) + '/points');
  const fields=['source_id','source_key','kind','title','file_name','organization','date','document_type','supplier','classification','meeting_id','referenced_by','indexed_at','last_discussed_at','original_url','original_download_url','public_url','download_url','pdf_url','mime_type','chunk_count','document_characters','text_truncated','content_preview','full_text','text','content','text_chunks','chunks','entity_detail.title','entity_detail.organization','entity_detail.sortDate','entity_detail.date','entity_detail.documentType','entity_detail.document_type','entity_detail.meetingId','entity_detail.meeting_id','entity_detail.markdownText','entity_detail.markdown_text','entity_detail.text','source_payload.file_name','source_payload.document_type','source_payload.classification','source_payload.is_referenced_by','attachment_metadata.file_name','attachment_metadata.mime_type','attachment.file_name','attachment.mime_type','attachments.file_name','attachments.fileName','attachments.name','attachments.title'];
  const body = JSON.stringify({ids,with_payload:{include:fields},with_vector:false});
  const req = (target.protocol==='https:'?https:http).request(target,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),...($env.OBV_QDRANT_API_KEY?{'api-key':$env.OBV_QDRANT_API_KEY}:{})}},res=>{
    const chunks=[]; let size=0;
    res.on('data',chunk=>{size+=chunk.length;if(size>64*1024*1024){req.destroy(new Error('Documentpayload overschrijdt de gegevenslimiet'));return;}chunks.push(chunk);});
    res.on('end',()=>{try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode!==200||!Array.isArray(data.result))throw new Error('Documentinhoud ophalen mislukt');resolve(data.result);}catch(error){reject(error);}});
    res.on('error',reject);
  });
  req.setTimeout(90000,()=>req.destroy(new Error('Documentinhoud ophalen duurt te lang')));req.on('error',reject);req.end(body);
});
const hydrated=new Map();
for(let start=0;start<candidates.length;start+=50){
  const ids=candidates.slice(start,start+50).map(row=>row.point.id);
  const points=await fetchPoints(ids);
  for(const point of points)hydrated.set(String(point.id),point.payload||{});
}
for(const row of candidates){
  const payload=hydrated.get(String(row.point.id));
  if(!payload)throw new Error('Een geselecteerd document is tijdens de zoekactie verdwenen; voer de zoekactie opnieuw uit');
  if(payload.source_id!==row.payload.source_id||payload.source_key!==row.payload.source_key)throw new Error('Dataset gewijzigd tijdens documentselectie');
  row.payload=payload;row.point={...row.point,payload};
}
// END OBV BOUNDED HYDRATION
`;

function applySearchPerformance(workflow) {
  const node = id => workflow.nodes.find(n=>n.id===id);
  const retrieve = node('ob-search-candidates').parameters;
  retrieve.jsCode = retrieve.jsCode.replace('with_payload:true,with_vector:false', "with_payload:{include:['source_id','source_key','kind']},with_vector:false");
  const format = node('ob-search-format').parameters;
  if (!format.jsCode.includes('// BEGIN OBV BOUNDED HYDRATION')) {
    const marker = 'const documents=candidates.map(row=>';
    if (!format.jsCode.includes(marker)) throw new Error('Onbekende rerankopbouw');
    format.jsCode = format.jsCode.replace(marker, hydrateCode + '\n' + marker);
  } else {
    format.jsCode = format.jsCode.replace(/\/\/ BEGIN OBV BOUNDED HYDRATION[\s\S]*?\/\/ END OBV BOUNDED HYDRATION/, () => hydrateCode.trim());
  }
  for (const id of ['ob-search-embed','ob-search-qdrant','ob-search-rerank']) {
    const item = node(id);
    if (item) item.parameters.options = {...item.parameters.options,timeout:120000};
  }
  const query = node('ob-search-qdrant');
  query.parameters.url = query.parameters.url.replace('/points/query"', '/points/query?timeout=90"');
  // The server budget is shorter than the client budget, so errors arrive as
  // structured responses rather than a disconnected client with work ongoing.
  retrieve.jsCode = retrieve.jsCode.replace(',filter,timeout:90}', ',filter}');
  const validate = node('ob-search-validate').parameters;
  validate.jsCode = validate.jsCode.replace("input.reranker_model||input.rerankerModel||'cohere-rerank-v4.0-fast'", "input.reranker_model||input.rerankerModel||$env.OBV_RERANKER_MODEL||''");
  const guardName='Reranker beschikbaar?';
  const skipName='Rerank overgeslagen';
  if(!node('ob-search-rerank-guard')) {
    workflow.nodes.push({id:'ob-search-rerank-guard',name:guardName,type:'n8n-nodes-base.if',typeVersion:2.2,position:[480,0],parameters:{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:'reranker-configured',leftValue:'={{ Boolean($json.reranker_model && $json.documents.length) }}',rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}}});
    workflow.nodes.push({id:'ob-search-rerank-skip',name:skipName,type:'n8n-nodes-base.code',typeVersion:2,position:[700,180],parameters:{jsCode:"return [{json:{results:[],rerank_skipped:true,reason:'Geen beschikbare reranker geconfigureerd. Resultaten gebruiken de gecombineerde retrievalscores; herhaal de zoekactie niet om deze configuratiebeperking te herstellen.'}}];"}});
  }
  const formatName=node('ob-search-format').name, rerankName=node('ob-search-rerank').name, outputName=node('ob-search-output').name;
  workflow.connections[formatName]={main:[[{node:guardName,type:'main',index:0}]]};
  workflow.connections[guardName]={main:[[{node:rerankName,type:'main',index:0}],[{node:skipName,type:'main',index:0}]]};
  workflow.connections[skipName]={main:[[{node:outputName,type:'main',index:0}]]};
  const output=node('ob-search-output').parameters;
  if(!output.jsCode.includes('rerank_unavailable:')) output.jsCode=output.jsCode.replace('results:output,candidate_pool:',"results:output,rerank_unavailable:response.rerank_skipped===true,rerank_notice:response.rerank_skipped?response.reason:null,candidate_pool:");
  workflow.settings = {...workflow.settings,executionTimeout:600};
  return workflow;
}

module.exports = {applySearchPerformance,hydrateCode};
