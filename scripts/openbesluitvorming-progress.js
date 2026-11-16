'use strict';

const { execFileSync, spawn } = require('node:child_process');
const format = new Intl.NumberFormat('nl-NL');
const CONTAINER = 'govchat-obv-full-run';
const RUN = 'limburg-full-20261111';
const QUERY = `import sqlite3,json,sys,os
uri='file:/state/ingest.sqlite?mode=ro'
guard=None
if sys.argv[2]=='stopped' and not os.path.exists('/state/ingest.sqlite-wal'):
    import fcntl
    guard=open('/state/worker.lock','rb')
    fcntl.flock(guard.fileno(),fcntl.LOCK_SH | fcntl.LOCK_NB)
    if not os.path.exists('/state/ingest.sqlite-wal'):
        uri+='&immutable=1'
db=sqlite3.connect(uri,uri=True,timeout=10)
db.row_factory=sqlite3.Row
db.execute('BEGIN')
run=db.execute('SELECT * FROM runs WHERE id=?',(sys.argv[1],)).fetchone()
if run is None: raise SystemExit('Run not found')
counts=dict(db.execute('SELECT status,count(*) FROM documents WHERE run_id=? GROUP BY status',(sys.argv[1],)))
audit={}
outcomes={}
retained=counts.get('indexed',0)
if 'generation' in run.keys() and run['generation']:
    for kind,disposition,total in db.execute('SELECT entity_type,disposition,count(*) FROM refresh_seen WHERE run_id=? AND generation=? GROUP BY entity_type,disposition',(sys.argv[1],run['generation'])):
        audit.setdefault(kind,{})[disposition]=total
    retained=db.execute('SELECT count(*) FROM documents WHERE run_id=? AND has_vector=1',(sys.argv[1],)).fetchone()[0]
    outcomes=dict(db.execute('SELECT status,count(*) FROM documents WHERE run_id=? AND refresh_generation=? GROUP BY status',(sys.argv[1],run['generation'])))
print(json.dumps({'run':dict(run),'counts':counts,'audit':audit,'retained':retained,'outcomes':outcomes}))
db.close()
if guard: guard.close()`;

function command(args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 20000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }).trim();
}

function collect(runCommand = command, container = CONTAINER, run = RUN) {
  const state = JSON.parse(runCommand(['inspect', '--format', '{{json .State}}', container]));
  // Read existing state only. Even after completion, the helper cannot access
  // the network or write volumes, and never invokes the ingestion entrypoint.
  const args = state.Running && !state.Paused
    ? ['exec', container, 'python', '-c', QUERY, run, 'running']
    : ['run', '--rm', '--network', 'none', '--volumes-from', `${container}:ro`,
      '--entrypoint', 'python', 'govchat-openbesluitvorming-ingest:local', '-c', QUERY, run, 'stopped'];
  const data = JSON.parse(runCommand(args));
  const counts = {};
  for (const name of ['indexed', 'deleted', 'pending', 'processing', 'retry', 'dead_letter']) {
    const value = data.counts[name] || 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid progress counter');
    counts[name] = value;
  }
  if (data.run.id !== run) throw new Error('Unexpected ingestion run');
  for (const group of [...Object.values(data.audit || {}), data.outcomes || {}, { retained: data.retained ?? counts.indexed }]) {
    for (const value of Object.values(group)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid progress counter');
    }
  }
  const queued = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const complete = Boolean(data.run.snapshot_complete &&
    !counts.pending && !counts.processing && !counts.retry && !counts.dead_letter && !data.audit?.Document?.missing_retained);
  return { state: state.Status, counts, queued, complete, pages: data.run.pages,
    snapshotComplete: Boolean(data.run.snapshot_complete), updatedAt: data.run.updated_at,
    generation: data.run.generation || 0, phase: data.run.refresh_phase || 'none',
    audit: data.audit || {}, outcomes: data.outcomes || {}, retainedVectors: data.retained ?? counts.indexed };
}

function auditLines(data) {
  if (!data.generation) return [];
  const d = data.audit.Document || {};
  const rescanned = Object.entries(d).reduce((sum, [key, n]) => sum + (key === 'missing_retained' ? 0 : n), 0);
  const changed = (d.changed || 0) + (d.parent_changed || 0);
  const motions = Object.entries(data.audit.Motion || {}).reduce((sum, [key, n]) => sum + (key === 'missing_retained' ? 0 : n), 0);
  return [
    `Refresh generatie ${data.generation} | fase ${data.phase} | alle Document-categorieen en bijlagen`,
    `Herscand ${format.format(rescanned)} | ongewijzigd ${format.format(d.unchanged || 0)} | nieuw ${d.new || 0} | gewijzigd ${changed}`,
    `Oude/huidige vectors behouden ${format.format(data.retainedVectors)} | formaatfouten eenmalig herpland ${d.retry_size_once || 0}`,
    `Deze refresh geindexeerd ${format.format(data.outcomes?.indexed || 0)} | mislukt ${format.format(data.outcomes?.dead_letter || 0)} | retry ${data.outcomes?.retry || 0}`,
    `Bronverwijderingen ${d.deleted_source || 0} | ontbrekend/behouden ${d.missing_retained || 0} | eerdere fouten behouden ${d.failed_retained || 0}`,
    `Motion-entiteiten aangetroffen ${format.format(motions)} (niet websiteaantal moties)`
  ];
}

function summary(data, rate) {
  const c = data.counts;
  const label = data.generation ? 'BESCHIKBAAR' : 'GEINDEXEERD';
  const available = data.generation ? data.retainedVectors : c.indexed;
  return `${new Date().toLocaleTimeString('nl-NL')} | ${label} ${format.format(available)} | ` +
    `wacht ${format.format(c.pending)} | bezig ${c.processing} | retry ${c.retry} | ` +
    `fouten ${c.dead_letter} | bronpagina's ${format.format(data.pages)} | ${data.state}` +
    (data.generation ? ` | ${auditLines(data).join(' | ')}` : '') +
    (data.snapshotComplete ? ` | bron volledig uitgelezen | volledig geslaagd: ${data.complete ? 'JA' : 'NEE'}` : '') +
    (rate === undefined ? '' : ` | ${format.format(Math.round(rate))} docs/min`);
}

function dashboard(data, rate) {
  const c = data.counts;
  return [
    'OPENBESLUITVORMING LIMBURG - LIVE TELLER',
    '======================================',
    '',
    ...auditLines(data),
    ...(data.generation ? [''] : []),
    data.generation
      ? `  BESCHIKBAAR           ${format.format(data.retainedVectors)} documenten (bestaande vectors blijven staan)`
      : `  GEINDEXEERD            ${format.format(c.indexed)} documenten`,
    '',
    `  Nog in wachtrij        ${format.format(c.pending)}`,
    `  Nu in verwerking       ${format.format(c.processing)}`,
    `  Geplande retries       ${format.format(c.retry)}`,
    `  Fouten / dead letters  ${format.format(c.dead_letter)}`,
    `  Verwijderd volgens bron ${format.format(c.deleted)}`,
    '',
    data.snapshotComplete && !data.generation
      ? `  Totaal bronrecords     ${format.format(data.queued)} documenten`
      : data.generation
        ? `  Bestaand + aangetroffen ${format.format(data.queued)} documenten (geen inventarispercentage)`
        : `  Al aangetroffen        ${format.format(data.queued)} documenten (geen volledig brontotaal)`,
    `  Bronpagina's opgehaald ${format.format(data.pages)}`,
    `  Alle bronpagina's binnen: ${data.snapshotComplete ? 'ja' : 'nee'}`,
    `  Volledige ingest gereed: ${data.complete ? 'JA' : 'NEE'}`,
    `  Container              ${data.state}`,
    `  Laatste checkpoint     ${data.updatedAt}`,
    ...(rate === undefined ? [] : [`  Recent tempo           ${format.format(Math.round(rate))} documenten/minuut`]),
    '',
    'Vernieuwt elke 10 seconden. Ctrl+C sluit alleen deze monitor.',
    data.snapshotComplete
      ? 'Bron volledig uitgelezen. Openstaande fouten moeten nog worden opgelost.'
      : 'Het volledige brontotaal is onbekend; daarom geen misleidend percentage.'
  ].join('\n');
}

async function main(args = process.argv.slice(2)) {
  function target(flag, fallback) {
    const index = args.indexOf(flag);
    if (index === -1) return fallback;
    const value = args[index + 1];
    if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(value)) throw new Error('Invalid monitor target');
    return value;
  }
  const container = target('--container', CONTAINER);
  const run = target('--run-id', RUN);
  if (args.includes('logs')) {
    const child = spawn('docker', ['logs', '--tail', '50', '--follow', container], { stdio: 'inherit' });
    child.on('exit', code => { process.exitCode = code || 0; });
    child.on('error', () => { console.error('Docker logs kon niet worden geopend.'); process.exitCode = 1; });
    return;
  }
  const once = args.includes('--once');
  const lines = args.includes('--lines');
  const history = [];
  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  do {
    try {
      const data = collect(command, container, run);
      const current = { time: Date.now(), indexed: data.counts.indexed };
      history.push(current);
      while (history.length > 1 && current.time - history[0].time > 60000) history.shift();
      const first = history[0];
      const rate = current.time > first.time
        ? Math.max(0, (current.indexed - first.indexed) * 60000 / (current.time - first.time)) : undefined;
      if (!lines && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
      console.log(lines ? summary(data, rate) : dashboard(data, rate));
    } catch {
      console.error('Teller tijdelijk niet beschikbaar. Controleer Docker Desktop en de ingest-container.');
      if (once) process.exitCode = 1;
    }
    if (!once && !stopped) await new Promise(resolve => setTimeout(resolve, 10000));
  } while (!once && !stopped);
}

module.exports = { collect, dashboard, summary, QUERY };
if (require.main === module) main();
