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
run=db.execute('SELECT id,pages,snapshot_complete,updated_at FROM runs WHERE id=?',(sys.argv[1],)).fetchone()
if run is None: raise SystemExit('Run not found')
counts=dict(db.execute('SELECT status,count(*) FROM documents WHERE run_id=? GROUP BY status',(sys.argv[1],)))
print(json.dumps({'run':dict(run),'counts':counts}))
db.close()
if guard: guard.close()`;

function command(args) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 20000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }).trim();
}

function collect(runCommand = command) {
  const state = JSON.parse(runCommand(['inspect', '--format', '{{json .State}}', CONTAINER]));
  // Read existing state only. Even after completion, the helper cannot access
  // the network or write volumes, and never invokes the ingestion entrypoint.
  const args = state.Running && !state.Paused
    ? ['exec', CONTAINER, 'python', '-c', QUERY, RUN, 'running']
    : ['run', '--rm', '--network', 'none', '--volumes-from', `${CONTAINER}:ro`,
      '--entrypoint', 'python', 'govchat-openbesluitvorming-ingest:local', '-c', QUERY, RUN, 'stopped'];
  const data = JSON.parse(runCommand(args));
  const counts = {};
  for (const name of ['indexed', 'deleted', 'pending', 'processing', 'retry', 'dead_letter']) {
    const value = data.counts[name] || 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid progress counter');
    counts[name] = value;
  }
  if (data.run.id !== RUN) throw new Error('Unexpected ingestion run');
  const queued = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const complete = Boolean(data.run.snapshot_complete &&
    !counts.pending && !counts.processing && !counts.retry && !counts.dead_letter);
  return { state: state.Status, counts, queued, complete, pages: data.run.pages,
    snapshotComplete: Boolean(data.run.snapshot_complete), updatedAt: data.run.updated_at };
}

function summary(data, rate) {
  const c = data.counts;
  return `${new Date().toLocaleTimeString('nl-NL')} | GEINDEXEERD ${format.format(c.indexed)} | ` +
    `wacht ${format.format(c.pending)} | bezig ${c.processing} | retry ${c.retry} | ` +
    `fouten ${c.dead_letter} | bronpagina's ${format.format(data.pages)} | ${data.state}` +
    (data.snapshotComplete ? ` | bron volledig uitgelezen | volledig geslaagd: ${data.complete ? 'JA' : 'NEE'}` : '') +
    (rate === undefined ? '' : ` | ${format.format(Math.round(rate))} docs/min`);
}

function dashboard(data, rate) {
  const c = data.counts;
  return [
    'OPENBESLUITVORMING LIMBURG - LIVE TELLER',
    '======================================',
    '',
    `  GEINDEXEERD            ${format.format(c.indexed)} documenten`,
    '',
    `  Nog in wachtrij        ${format.format(c.pending)}`,
    `  Nu in verwerking       ${format.format(c.processing)}`,
    `  Geplande retries       ${format.format(c.retry)}`,
    `  Fouten / dead letters  ${format.format(c.dead_letter)}`,
    `  Verwijderd volgens bron ${format.format(c.deleted)}`,
    '',
    data.snapshotComplete
      ? `  Totaal bronrecords     ${format.format(data.queued)} documenten`
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
  if (args.includes('logs')) {
    const child = spawn('docker', ['logs', '--tail', '50', '--follow', CONTAINER], { stdio: 'inherit' });
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
      const data = collect();
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
