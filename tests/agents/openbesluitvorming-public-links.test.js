'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { limburgPublicLinks, renderWorkflows, backfill } = require('../../scripts/openbesluitvorming-public-links');
const documentId = '75ff0c2a-fdcd-4678-ad4a-7e2b454af975';
const meetingId = '3f5d285e-d6c5-49d3-8178-9b3e8c077b9f';
const source = {
  source_key: 'provincie_limburg',
  source_id: 'document:ibabs:provincie:provincie_limburg:' + documentId,
  meeting_id: 'meeting:ibabs:provincie:provincie_limburg:' + meetingId,
  original_url: 'https://api1.ibabs.eu/publicdownload.aspx?site=Limburg&id=' + documentId,
};

test('meeting document links to the official HTML viewer and retains download provenance', () => {
  const links = limburgPublicLinks(source);
  assert.equal(links.original_url, 'https://limburg.bestuurlijkeinformatie.nl/Agenda/Document/' + meetingId + '?documentId=' + documentId);
  assert.equal(links.public_url, links.original_url);
  assert.equal(links.original_download_url, source.original_url);
  assert.deepEqual(limburgPublicLinks({ ...source, ...links }), links);
});

test('motion references use Reports, never masquerade as meetings', () => {
  const links = limburgPublicLinks({ ...source, meeting_id: source.meeting_id.replace('meeting:', 'motion:') });
  assert.equal(links.public_url, 'https://limburg.bestuurlijkeinformatie.nl/Reports/Document/' + meetingId + '?documentId=' + documentId);
});

test('falls back to a referenced meeting or official PDF without inventing a report ID', () => {
  assert.match(limburgPublicLinks({ ...source, meeting_id: null, referenced_by: source.meeting_id }).public_url, /\/Agenda\/Document\//);
  assert.equal(limburgPublicLinks({ ...source, meeting_id: 'organization:nl:provincie:provincie_limburg' }).public_url, 'https://limburg.bestuurlijkeinformatie.nl/Document/View/' + documentId);
});

test('preserves an explicit valid report viewer URL', () => {
  const public_url = 'https://limburg.bestuurlijkeinformatie.nl/Reports/Document/' + meetingId + '?documentId=' + documentId;
  assert.equal(limburgPublicLinks({ ...source, public_url }).public_url, public_url);
});

test('missing download provenance stays null on repeated rewrites', () => {
  const input = { ...source, original_url: null };
  const links = limburgPublicLinks(input);
  assert.equal(links.original_download_url, null);
  assert.deepEqual(limburgPublicLinks({ ...input, ...links }), links);
});

test('does not rewrite other sources, malformed IDs or unrelated URLs', () => {
  assert.equal(limburgPublicLinks({ ...source, source_key: 'other' }), null);
  assert.equal(limburgPublicLinks({ ...source, source_id: source.source_id + '/evil' }), null);
  assert.equal(limburgPublicLinks({ ...source, public_url: 'https://evil.example/Reports/Document/' + meetingId + '?documentId=' + documentId }).public_url, limburgPublicLinks(source).public_url);
  assert.equal(limburgPublicLinks({ ...source, meeting_id: 'meeting:ibabs:provincie:other:' + meetingId }).public_url, 'https://limburg.bestuurlijkeinformatie.nl/Document/View/' + documentId);
});

function workflowCode(filename, nodeName) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../agents/n8n/workflows', filename), 'utf8'));
  const workflow = Array.isArray(data) ? data[0] : data;
  return workflow.nodes.find(node => node.name === nodeName).parameters.jsCode;
}

test('search output selects the portal URL even for an unmigrated snapshot payload', () => {
  const code = workflowCode('openbesluitvorming-search.json', '6. Dynamic Cut-off, Coverage And Provenance');
  const prepared = { candidates: [{ payload: source, document_id: source.source_id, rrf_score: 0.1, semantic_score: 0.6 }], result_limit: 10 };
  const output = new Function('$', '$input', code)(() => ({ first: () => ({ json: prepared }) }), { first: () => ({ json: {} }) });
  const result = output[0].json.results[0];
  assert.equal(result.source.original_url, limburgPublicLinks(source).public_url);
  assert.equal(result.source.original_download_url, source.original_url);
});

test('document worker persists portal and provenance URLs for future ingestion', () => {
  const code = workflowCode('openbesluitvorming-document-worker.json', '9. Mean Pool And Build Point');
  const original = { entityId: source.source_id, sourceKey: source.source_key, detail: { title: 'Example', meetingId: source.meeting_id }, record: { payload: { original_url: source.original_url } }, chunk_weights: [1] };
  const output = new Function('$', '$input', code)(() => ({ all: () => [{ json: original }] }), { all: () => [{ json: { data: [{ embedding: new Array(3072).fill(1) }] } }] });
  const payload = output[0].json.point.payload;
  assert.equal(payload.original_url, limburgPublicLinks(source).public_url);
  assert.equal(payload.original_download_url, source.original_url);
  assert.equal(payload.source_payload.original_url, source.original_url);
  assert.equal(output[0].json.point.vector.length, 3072);
});

test('workflow rendering is reproducible and idempotent', () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'govchat-public-links-'));
  const files = ['openbesluitvorming-search.json', 'openbesluitvorming-document-worker.json'];
  try {
    for (const file of files) fs.copyFileSync(path.join(__dirname, '../../agents/n8n/workflows', file), path.join(directory, file));
    const before = files.map(file => fs.readFileSync(path.join(directory, file), 'utf8'));
    renderWorkflows(directory);
    renderWorkflows(directory);
    assert.deepEqual(files.map(file => fs.readFileSync(path.join(directory, file), 'utf8')), before);
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test('backfill dry-run does not write; apply requires explicit collection and durable private backup', async () => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'govchat-public-links-backup-'));
  const backupPath = path.join(directory, 'rollback.jsonl');
  const originalFetch = global.fetch;
  const originalCollection = process.env.QDRANT_COLLECTION;
  let writes = 0;
  global.fetch = async (url, options) => {
    if (url.includes('/points/batch')) {
      writes++;
      const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8').trim());
      assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
      assert.deepEqual(backup, { id: 'test-point', previous: { original_url: source.original_url }, missing: ['public_url', 'original_download_url'] });
      assert.equal(JSON.parse(options.body).operations[0].set_payload.payload.public_url, limburgPublicLinks(source).public_url);
      return { ok: true, json: async () => ({ status: 'ok', result: {} }) };
    }
    assert.ok(url.includes('/points/scroll'));
    return { ok: true, json: async () => ({ status: 'ok', result: { points: [{ id: 'test-point', payload: source }], next_page_offset: null } }) };
  };
  try {
    delete process.env.QDRANT_COLLECTION;
    const counts = await backfill({ apply: false, backupPath });
    assert.equal(counts.changed, 1);
    assert.equal(writes, 0);
    assert.equal(fs.existsSync(backupPath), false);
    await assert.rejects(backfill({ apply: true, backupPath }), /explicit QDRANT_COLLECTION/);
    process.env.QDRANT_COLLECTION = 'test-collection';
    await assert.rejects(backfill({ apply: true }), /requires --backup/);
    await backfill({ apply: true, backupPath });
    assert.equal(writes, 1);
    await assert.rejects(backfill({ apply: true, backupPath }), /EEXIST/);
  } finally {
    global.fetch = originalFetch;
    if (originalCollection === undefined) delete process.env.QDRANT_COLLECTION;
    else process.env.QDRANT_COLLECTION = originalCollection;
    fs.rmSync(directory, { recursive: true });
  }
});
