'use strict';

// Self-contained so the same implementation can be embedded in n8n Code nodes.
function limburgPublicLinks(payload) {
  if (payload.source_key !== 'provincie_limburg') return null;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const entity = new RegExp('^document:ibabs:provincie:provincie_limburg:(' + uuid + ')$', 'i').exec(payload.source_id || '');
  if (!entity) return null;
  const documentId = entity[1].toLowerCase();
  const base = 'https://limburg.bestuurlijkeinformatie.nl';
  const prior = Object.hasOwn(payload, 'original_download_url')
    ? payload.original_download_url
    : payload.source_payload?.original_url || payload.original_url || null;
  // Do not overwrite an explicit portal link supplied by the source/migration.
  const existing = [payload.public_url, payload.original_url, payload.source_payload?.original_url].find(value =>
    typeof value === 'string' && new RegExp('^https://limburg\\.bestuurlijkeinformatie\\.nl/(?:Agenda|Reports)/Document/' + uuid + '\\?documentId=' + documentId + '(?:&[^#]*)?$', 'i').test(value));
  let publicUrl = existing;
  if (!publicUrl) {
    const references = [payload.meeting_id, payload.referenced_by, payload.source_payload?.is_referenced_by];
    for (const reference of references) {
      const match = new RegExp('^(meeting|motion):ibabs:provincie:provincie_limburg:(' + uuid + ')$', 'i').exec(reference || '');
      if (!match) continue;
      const route = match[1].toLowerCase() === 'motion' ? 'Reports' : 'Agenda';
      publicUrl = base + '/' + route + '/Document/' + match[2].toLowerCase() + '?documentId=' + documentId;
      break;
    }
  }
  // Organisation-only documents have no agenda/report context in this dataset.
  publicUrl ||= base + '/Document/View/' + documentId;
  return { public_url: publicUrl, original_url: publicUrl, original_download_url: prior };
}

function renderWorkflows(directory) {
  const fs = require('node:fs');
  const path = require('node:path');
  const helper = limburgPublicLinks.toString();
  const markerStart = '// BEGIN LIMBURG PUBLIC LINKS';
  const markerEnd = '// END LIMBURG PUBLIC LINKS';
  for (const [file, nodeName] of [
    ['openbesluitvorming-search.json', '6. Dynamic Cut-off, Coverage And Provenance'],
    ['openbesluitvorming-document-worker.json', '9. Mean Pool And Build Point'],
  ]) {
    const filename = path.join(directory, file);
    const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const workflow = Array.isArray(document) ? document[0] : document;
    const node = workflow.nodes.find(item => item.name === nodeName);
    if (!node) throw new Error('Missing node: ' + nodeName);
    let code = node.parameters.jsCode;
    const start = code.indexOf(markerStart);
    if (start !== -1) {
      const end = code.indexOf(markerEnd, start);
      if (end === -1) throw new Error('Incomplete helper marker');
      code = code.slice(0, start) + code.slice(end + markerEnd.length + 1);
    }
    code = markerStart + '\n' + helper + '\n' + markerEnd + '\n' + code;
    if (file.includes('search')) {
      const old = 'original_url:p.original_url||p.download_url||p.pdf_url||null,';
      const replacement = 'public_url:limburgPublicLinks(p)?.public_url||p.public_url||null,original_url:limburgPublicLinks(p)?.original_url||p.original_url||p.download_url||p.pdf_url||null,original_download_url:limburgPublicLinks(p)?.original_download_url||p.original_download_url||null,';
      if (code.includes(old)) code = code.replace(old, replacement);
      else if (!code.includes(replacement)) throw new Error('Search output shape changed');
    } else {
      const insertion = 'for (const entry of output) { if (entry.json?.point?.payload) { const links = limburgPublicLinks(entry.json.point.payload); if (links) Object.assign(entry.json.point.payload, links); } }\n';
      if (!code.includes(insertion)) {
        if (!code.endsWith('return output;')) throw new Error('Worker output shape changed');
        code = code.slice(0, -'return output;'.length) + insertion + 'return output;';
      }
    }
    node.parameters.jsCode = code;
    fs.writeFileSync(filename, JSON.stringify(document, null, 2) + '\n');
    console.log('Rendered ' + file);
  }
}

async function backfill({ apply, backupPath }) {
  const fs = require('node:fs');
  if (apply && !process.env.QDRANT_COLLECTION) throw new Error('Applying changes requires an explicit QDRANT_COLLECTION');
  if (apply && (!backupPath || backupPath.startsWith('--'))) throw new Error('Applying changes requires --backup with a new backup path');
  const base = (process.env.QDRANT_URL || 'http://qdrant:6333').replace(/\/$/, '');
  const collection = process.env.QDRANT_COLLECTION || 'openraadsinformatie_v1';
  const url = base + '/collections/' + encodeURIComponent(collection);
  const request = async (endpoint, body) => {
    const response = await fetch(url + endpoint, {
      method: 'POST', headers: {
        'Content-Type': 'application/json',
        ...(process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {}),
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok || result.status !== 'ok') throw new Error(JSON.stringify(result));
    return result.result;
  };
  const fd = apply ? fs.openSync(backupPath, 'wx', 0o600) : null;
  let offset;
  const counts = { examined: 0, changed: 0, agenda: 0, reports: 0, pdf_fallback: 0, applied: apply };
  try {
    do {
      const page = await request('/points/scroll', {
        limit: 500, offset, with_payload: true, with_vector: false,
        filter: { must: [{ key: 'source_key', match: { value: 'provincie_limburg' } }, { key: 'entity_type', match: { value: 'Document' } }] },
      });
      const operations = [];
      for (const point of page.points) {
        counts.examined++;
        const links = limburgPublicLinks(point.payload);
        if (!links) continue;
        const route = links.public_url.includes('/Agenda/') ? 'agenda' : links.public_url.includes('/Reports/') ? 'reports' : 'pdf_fallback';
        counts[route]++;
        if (Object.keys(links).every(key => point.payload[key] === links[key])) continue;
        counts.changed++;
        if (apply) {
          const previous = {}, missing = [];
          for (const key of Object.keys(links)) {
            if (Object.hasOwn(point.payload, key)) previous[key] = point.payload[key];
            else missing.push(key);
          }
          fs.writeSync(fd, JSON.stringify({ id: point.id, previous, missing }) + '\n');
          operations.push({ set_payload: { points: [point.id], payload: links } });
        }
      }
      if (operations.length) {
        fs.fsyncSync(fd); // Make rollback metadata durable before changing Qdrant.
        await request('/points/batch?wait=true', { operations });
      }
      offset = page.next_page_offset;
    } while (offset);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  console.log(JSON.stringify(counts, null, 2));
  return counts;
}

module.exports = { limburgPublicLinks, renderWorkflows, backfill };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--render-workflows' && args[1]) renderWorkflows(args[1]);
  else if (args[0] === '--backfill') {
    backfill({ apply: args.includes('--apply'), backupPath: args.includes('--backup') ? args[args.indexOf('--backup') + 1] : null })
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  } else {
    console.error('Use --render-workflows DIRECTORY or --backfill [--apply --backup FILE]');
    process.exitCode = 2;
  }
}
