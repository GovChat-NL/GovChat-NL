'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '../../agents/n8n/workflows/openbesluitvorming/openbesluitvorming-search.json'), 'utf8'));
const names = { validate: '1. Validate And Normalise Parameters', retrieve: '3. Retrieve Broad Candidate Pool (Qdrant)', format: '4. Format Candidate Pool For Reranker', output: '6. Dynamic Cut-off, Coverage And Provenance' };
function run(name, items, context = {}) {
  // Pure fusion/provenance tests supply already-hydrated fixture payloads.
  // The asynchronous hydration stage is exercised separately against Qdrant.
  const code = workflow.nodes.find(n => n.name === names[name]).parameters.jsCode
    .replace(/\/\/ BEGIN OBV BOUNDED HYDRATION[\s\S]*?\/\/ END OBV BOUNDED HYDRATION/, '');
  const wrap = values => ({ first: () => values[0], all: () => values });
  return new Function('$input', '$', '$env', code)(wrap(items.map(json => ({ json }))), node => wrap(context[node] || []), {}).map(item => item.json);
}
const validate = input => run('validate', [{ query: 'water beleid', ...input }])[0];
function retrieve(config) {
  return run('retrieve', [{ data: config.query_variants.map((_, index) => ({ index, embedding: Array(3072).fill(0.1) })) }], { [names.validate]: [{ json: config }] });
}
function format(pools, input = {}) {
  const config = validate(input), requests = retrieve(config);
  return run('format', pools.map(points => ({ result: { points } })), { [names.validate]: [{ json: config }], [names.retrieve]: requests.map(json => ({ json })) })[0];
}
const output = (prepared, response = {}) => run('output', [response], { [names.format]: [{ json: prepared }] })[0];
const point = (id, payload = {}, score = 0.7) => ({ id, score, payload: { source_id: id, source_key: 'provincie_limburg', ...payload } });

test('workflow stays inactive and keeps the original document-vector endpoints', () => {
  assert.equal(workflow.active, false);
  const requests = retrieve(validate({}));
  assert.equal(requests[0].collection, 'openraadsinformatie_v1');
  assert.equal(requests[0].request_body.query.length, 3072);
  assert.equal(requests[0].request_body.using, undefined);
  assert.equal(requests[0].request_body.with_vector, false);
  assert.deepEqual(requests[0].request_body.with_payload, {include:['source_id','source_key','kind']});
  assert.equal(requests[0].candidate_limit, 500);
  assert.equal(requests[0].rerank_limit, 500);
  assert.equal(requests[0].request_body.filter.must, undefined);
  assert.deepEqual(requests[0].request_body.filter.must_not[0].match.any, ['ori_checkpoint', 'ori_dead_letter']);
});

test('explicit source aliases and actual organisation names have separate predicates', () => {
  const config = validate({ query: 'Wat is water beleid', sourceKey: 'provincie_limburg', organisation: 'Provincie Limburg' });
  assert.deepEqual(config.filters, { source_key: 'provincie_limburg', organization: 'Provincie Limburg' });
  const requests = retrieve(config);
  assert.ok(requests.length > 1);
  for (const request of requests) assert.deepEqual(request.request_body.filter, config.qdrant_filter);
  assert.deepEqual(config.qdrant_filter.must[0], { key: 'source_key', match: { value: 'provincie_limburg' } });
  assert.equal(config.qdrant_filter.must[1].should[1].key, 'entity_detail.organization');
});

test('all allowlisted metadata filters are compiled to exact predicates', () => {
  const filters = { supplier: 'ibabs', document_type: 'Raadsvoorstel', meeting_id: 'meeting:example', referenced_by: 'motion:example', classification: 'water' };
  const config = validate({ filters });
  assert.deepEqual(config.filters, filters);
  assert.equal(config.qdrant_filter.must.length, 5);
  const serialized = JSON.stringify(config.qdrant_filter);
  assert.match(serialized, /source_payload\.document_type/);
  assert.match(serialized, /entity_detail\.meetingId/);
});

test('raw, unknown, malformed and conflicting filters fail before embedding', () => {
  for (const input of [
    { filter: {} }, { qdrant_filter: {} }, { metadata_filter: {} }, { filters: [] }, { filters: null },
    { filters: { unknown: 'x' } }, { source_key: {} }, { filters: { organization: ['Limburg'] } },
    { filters: { supplier: true } }, { filters: { document_type: '' } }, { meeting_id: 'bad\nvalue' },
    { source_key: 'bad:key' }, { source_key: 'a', sourceKey: 'b' },
    { source_key: 'a', filters: { source_key: 'b' } }, { supplier: 'x'.repeat(301) },
  ]) assert.throws(() => validate(input), /filter|must|Invalid|Conflicting/);
  assert.throws(() => validate({ query: 'x' }), /query/);
});

test('date ranges use UTC, inclusive days and inclusive exact upper timestamps', () => {
  let range = validate({ filters: { date_from: '2024-02-29', date_to: '2024-03-01' } }).qdrant_filter.must[0].should[0].range;
  assert.deepEqual(range, { gte: '2024-02-29T00:00:00.000Z', lt: '2024-03-02T00:00:00.000Z' });
  range = validate({ date_to: '2024-03-01T12:00:00+01:00' }).qdrant_filter.must[0].should[0].range;
  assert.deepEqual(range, { lte: '2024-03-01T11:00:00.000Z' });
  for (const date of ['2023-02-29', '2024-02-30', '2024-13-01', 'yesterday', '2024-01-01T00:00:00', '2024-01-01T24:00:00Z']) assert.throws(() => validate({ date_from: date }), /date_from/);
  assert.throws(() => validate({ date_from: '2024-03-02', date_to: '2024-03-01' }), /later/);
});

test('embedding validation rejects incomplete, wrong-size and nonfinite vectors', () => {
  const config = validate({});
  const context = { [names.validate]: [{ json: config }] };
  assert.throws(() => run('retrieve', [{ data: [] }], context), /all requested/);
  for (const embedding of [[1], Array(3072).fill(NaN), Array(3072).fill('1')]) {
    assert.throws(() => run('retrieve', [{ data: config.query_variants.map(() => ({ embedding })) }], context), /dimension/);
  }
});

test('legacy preview payloads still rerank and expose optional content', () => {
  const p = point('legacy', { title: 'Legacy', organization: 'Limburg', content_preview: 'Existing preview', date: '2024-01-01' });
  const prepared = format([[p]], { include_content: true });
  assert.match(prepared.documents[0], /Title: Legacy/);
  assert.match(prepared.documents[0], /Content: Existing preview/);
  const result = output(prepared).results[0];
  assert.equal(result.source.title, 'Legacy');
  assert.equal(result.content_preview, 'Existing preview');
  assert.equal(result.source.document_type, null);
  assert.equal(output(format([[p]])).results[0].content_preview, undefined);
});

test('richer metadata and query-relevant full-text passages enter reranking, never raw objects', () => {
  const p = point('rich', {
    entity_detail: { title: 'Waterplan', organization: 'Limburg', sortDate: '2024-01-01', meetingId: 'meeting:1', documentType: 'Plan' },
    source_payload: { classification: ['water'], is_referenced_by: 'motion:1', secret: 'DO_NOT_LEAK' },
    attachment_metadata: { file_name: 'water.pdf', mime_type: 'application/pdf', secret: 'DO_NOT_LEAK' },
    full_text: 'Intro '.repeat(5000) + 'water beleid deep relevant passage', content_preview: 'Preview without relevant text', chunk_count: 6, document_characters: 30000,
  });
  const prepared = format([[p]], { include_content: true, filters: { document_type: 'Plan' } });
  assert.match(prepared.documents[0], /deep relevant passage/);
  assert.match(prepared.documents[0], /Document type: Plan/);
  assert.match(prepared.documents[0], /Meeting: meeting:1/);
  assert.match(prepared.documents[0], /water\.pdf application\/pdf/);
  assert.doesNotMatch(prepared.documents[0], /DO_NOT_LEAK/);
  assert.ok(prepared.documents[0].length <= 10000);
  const result = output(prepared).results[0];
  assert.equal(result.source.title, 'Waterplan');
  assert.equal(result.metadata.referenced_by, 'motion:1');
  assert.equal(result.metadata.chunk_count, 6);
  assert.match(result.content_preview, /deep relevant passage/);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_LEAK/);
  assert.deepEqual(output(prepared).applied_filters, { document_type: 'Plan' });
});

test('chunk text fallback is bounded and supports strings and text/content objects', () => {
  const prepared = format([[point('chunks', { chunks: ['first', { text: 'second' }, { content: 'third' }, { unknown: 'DO_NOT_LEAK' }] })]], { include_content: true });
  assert.match(prepared.documents[0], /first\nsecond\nthird/);
  assert.doesNotMatch(prepared.documents[0], /DO_NOT_LEAK/);
  assert.equal(output(prepared).results[0].metadata.text_truncated, false);
});

test('RRF deduplicates document votes per variant, selects best payload and isolates sources', () => {
  const a = point('a', { source_id: 'same', content_preview: 'low' }, 0.1);
  const b = point('b', { source_id: 'same', content_preview: 'best' }, 0.9);
  const other = point('c', { source_id: 'same', source_key: 'other' });
  const control = point('checkpoint', { kind: 'ori_checkpoint' });
  const prepared = format([[a, b, other, control], [b]]);
  assert.equal(prepared.candidates.length, 2);
  assert.equal(prepared.candidates[0].payload.content_preview, 'best');
  assert.equal(prepared.candidates[0].rrf_score, 2 / 61);
  assert.equal(prepared.candidates[0].semantic_score, 0.9);
  assert.equal(prepared.candidates[0].matched_variants.length, 2);
});

test('rerank ceiling and excluded-score coverage remain observable', () => {
  const prepared = format([Array.from({ length: 70 }, (_, i) => point(String(i)))], { rerank_limit: 50, result_limit: 10 });
  assert.equal(prepared.documents.length, 50);
  assert.equal(prepared.candidate_pool.unique_documents, 70);
  assert.equal(prepared.candidate_pool.excluded_from_rerank.count, 20);
  assert.equal(output(prepared).results.length, 10);
});

test('complete valid reranking is applied; malformed or partial responses fall back consistently', () => {
  const prepared = format([[point('a'), point('b')]], { reranker_model: 'configured-test-reranker' });
  const valid = { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] };
  assert.equal(output(prepared, valid).results[0].source.source_id, 'b');
  assert.equal(output(prepared, valid).reranking.applied, true);
  for (const results of [[], [null, null], [{ index: 0, relevance_score: 0.5 }], [{ index: 0, relevance_score: 0.5 }, { index: 0, relevance_score: 0.9 }], [{ index: 0, relevance_score: NaN }, { index: 1, relevance_score: 0.9 }], [{ index: 0, relevance_score: 2 }, { index: 1, relevance_score: 0.9 }]]) {
    const result = output(prepared, { results });
    assert.equal(result.reranking.fallback_used, true);
    assert.equal(result.results[0].source.source_id, 'a');
  }
});

test('empty candidate pools return an explicit no-results response', () => {
  const result = output(format([[]]));
  assert.equal(result.no_results, true);
  assert.deepEqual(result.results, []);
  assert.equal(result.candidate_pool.unique_documents, 0);
});

test('actual n8n HTTP-error output preserves candidates and uses explicit rerank fallback', () => {
  const node = workflow.nodes.find(n => n.id === 'ob-search-rerank');
  assert.equal(node.onError, 'continueRegularOutput');
  const prepared = format([[point('coronavirus', { full_text: 'Provinciale maatregelen tegen het coronavirus' })]], { include_content: true, reranker_model: 'configured-test-reranker' });
  const result = output(prepared, { error: { message: '400 - Invalid model name passed in model=cohere-rerank-v4.0-fast' } });
  assert.equal(result.reranking.applied, false);
  assert.equal(result.reranking.fallback_used, true);
  assert.equal(result.no_results, false);
  assert.equal(result.results[0].source.source_id, 'coronavirus');
  assert.match(result.results[0].content_preview, /coronavirus/);
  const empty = output(format([[]]), { error: '400 - Invalid model name' });
  assert.equal(empty.no_results, true);
  assert.deepEqual(empty.results, []);
});

test('Limburg meeting, motion, organisation-only and explicit portal URLs are preserved', () => {
  const id = '75ff0c2a-fdcd-4678-ad4a-7e2b454af975', reference = '3f5d285e-d6c5-49d3-8178-9b3e8c077b9f';
  const download = 'https://api1.ibabs.eu/publicdownload.aspx?site=Limburg&id=' + id;
  for (const [kind, route] of [['meeting', 'Agenda'], ['motion', 'Reports'], ['organization', 'View']]) {
    const p = point('document:ibabs:provincie:provincie_limburg:' + id, { meeting_id: kind + ':ibabs:provincie:provincie_limburg:' + reference, original_url: download });
    const source = output(format([[p]])).results[0].source;
    assert.match(source.public_url, new RegExp('/' + route + '/'));
    assert.equal(source.original_url, source.public_url);
    assert.equal(source.original_download_url, download);
    const enriched = { ...p, payload: { ...p.payload, meeting_id: null, entity_detail: { meetingId: p.payload.meeting_id } } };
    assert.equal(output(format([[enriched]])).results[0].source.public_url, source.public_url);
  }
  const public_url = 'https://limburg.bestuurlijkeinformatie.nl/Reports/Document/' + reference + '?documentId=' + id;
  const p = point('document:ibabs:provincie:provincie_limburg:' + id, { public_url, original_download_url: download });
  assert.equal(output(format([[p]])).results[0].source.public_url, public_url);
  const external = point('external', { source_key: 'other', public_url: 'https://example.org/document' });
  assert.equal(output(format([[external]])).results[0].source.public_url, 'https://example.org/document');
});

test('real Qdrant executes filters against legacy and enriched document-vector fixtures', { skip: !process.env.OBV_SEARCH_TEST_QDRANT_URL }, async () => {
  const base = process.env.OBV_SEARCH_TEST_QDRANT_URL.replace(/\/$/, '');
  const collection = 'obv_search_regression_' + process.pid + '_' + Date.now();
  async function api(route, method, body) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  const vector = Array(3072).fill(0.1);
  const payloads = [
    { source_key: 'provincie_limburg', organization: 'Limburg', supplier: 'ibabs', date: '2024-02-29T12:00:00Z', document_type: 'Plan', meeting_id: 'meeting:1', classification: ['water'] },
    { source_key: 'provincie_limburg', supplier: 'ibabs', entity_detail: { organization: 'Limburg', sortDate: '2024-02-29T18:00:00Z', documentType: 'Plan', meetingId: 'meeting:1' }, source_payload: { classification: ['water'] } },
    { source_key: 'other', date: '2024-02-29T12:00:00Z', document_type: 'Plan' },
    { source_key: 'provincie_limburg', date: '2024-03-01T00:00:00Z', document_type: 'Plan' },
    { source_key: 'provincie_limburg', kind: 'ori_checkpoint' },
    { source_key: 'provincie_limburg', date: '2024-02-29', document_type: 'Plan' },
  ];
  try {
    await api('/collections/' + collection, 'PUT', { vectors: { size: 3072, distance: 'Cosine' } });
    await api('/collections/' + collection + '/points?wait=true', 'PUT', { points: payloads.map((payload, index) => ({ id: index + 1, vector, payload })) });
    const config = validate({ collection, filters: { source_key: 'provincie_limburg', organization: 'Limburg', supplier: 'ibabs', document_type: 'Plan', meeting_id: 'meeting:1', classification: 'water', date_from: '2024-02-29', date_to: '2024-02-29' } });
    const result = await api('/collections/' + collection + '/points/query', 'POST', retrieve(config)[0].request_body);
    assert.deepEqual(result.result.points.map(p => p.id).sort(), [1, 2]);
    const unfiltered = await api('/collections/' + collection + '/points/query', 'POST', retrieve(validate({ collection }))[0].request_body);
    assert.equal(unfiltered.result.points.length, 5);
    const dates = await api('/collections/' + collection + '/points/query', 'POST', retrieve(validate({ collection, source_key: 'provincie_limburg', date_start: '2024-02-29', date_end: '2024-02-29' }))[0].request_body);
    assert.deepEqual(dates.result.points.map(p => p.id).sort(), [1, 2, 6]);
  } finally {
    await api('/collections/' + collection, 'DELETE');
  }
});
