'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collect, dashboard, summary, QUERY } = require('../../scripts/openbesluitvorming-progress');

function fixture(counts = {}, complete = 0, running = true) {
  const calls = [];
  const read = args => {
    calls.push(args);
    if (args[0] === 'inspect') return JSON.stringify({ Running: running, Status: running ? 'running' : 'exited' });
    return JSON.stringify({ run: { id: 'limburg-full-20261111', pages: 250,
      snapshot_complete: complete, updated_at: '2026-11-11T20:00:00Z' }, counts });
  };
  return { calls, read };
}

test('running counter reads only existing SQLite state through docker exec', () => {
  const f = fixture({ indexed: 4321, pending: 8, processing: 2, retry: 3, dead_letter: 4 });
  const data = collect(f.read);
  assert.equal(data.counts.indexed, 4321);
  assert.equal(data.queued, 4338);
  assert.equal(data.complete, false);
  assert.equal(f.calls[1][0], 'exec');
  assert.equal(f.calls[1].at(-1), 'running');
  assert.match(QUERY, /mode=ro/);
  assert.match(QUERY, /db.execute\('BEGIN'\)/);
  assert.doesNotMatch(QUERY, /INSERT|UPDATE|DELETE|CREATE|Worker\(/);
});

test('stopped counter uses networkless read-only existing volumes, never the ingest entrypoint', () => {
  const f = fixture({ indexed: 10 }, 1, false);
  assert.equal(collect(f.read).complete, true);
  const args = f.calls[1];
  assert.ok(args.includes('--network'));
  assert.ok(args.includes('none'));
  assert.ok(args.includes('govchat-obv-full-run:ro'));
  assert.ok(args.includes('--entrypoint'));
  assert.ok(args.includes('python'));
  assert.equal(args.at(-1), 'stopped');
  assert.match(QUERY, /sys.argv\[2\]=='stopped'/);
  assert.match(QUERY, /not os.path.exists\('\/state\/ingest.sqlite-wal'\)/);
  assert.match(QUERY, /fcntl.LOCK_SH \| fcntl.LOCK_NB/);
  assert.match(QUERY, /immutable=1/);
});

test('terminal snapshot with dead letters is not complete', () => {
  const data = collect(fixture({ indexed: 100, dead_letter: 1 }, 1).read);
  assert.equal(data.complete, false);
  assert.match(summary(data), /bron volledig uitgelezen \| volledig geslaagd: NEE/);
});

test('human-readable dashboard shows counters without inventing corpus percentage', () => {
  const data = collect(fixture({ indexed: 4321, pending: 8, retry: 2 }).read);
  const text = dashboard(data, 30);
  assert.match(text, /GEINDEXEERD\s+4\.321 documenten/);
  assert.match(text, /Nog in wachtrij\s+8/);
  assert.match(text, /Geplande retries\s+2/);
  assert.match(text, /geen volledig brontotaal/);
  assert.match(text, /30 documenten\/minuut/);
  assert.doesNotMatch(text, /\d+%/);
  assert.match(summary(data), /GEINDEXEERD 4\.321/);
});

test('invalid counters cannot be displayed as trustworthy totals', () => {
  assert.throws(() => collect(fixture({ indexed: -1 }).read), /Invalid progress counter/);
});

test('refresh shows independent audit counters and retained vectors without false percentage', () => {
  const data = collect(args => args[0] === 'inspect'
    ? JSON.stringify({ Running: true, Status: 'running' })
    : JSON.stringify({ run: { id: 'limburg-full-20261111', pages: 3100, generation: 1,
      refresh_phase: 'inventory', snapshot_complete: 0 }, counts: { indexed: 56300, pending: 71, dead_letter: 275 },
      retained: 56371, audit: { Document: { unchanged: 800, changed: 2, new: 3 }, Motion: { unchanged: 20 } } }));
  const text = dashboard(data);
  assert.match(text, /Herscand 805/);
  assert.match(text, /ongewijzigd 800/);
  assert.match(text, /nieuw 3/);
  assert.match(text, /gewijzigd 2/);
  assert.match(text, /vectors behouden 56\.371/);
  assert.match(text, /BESCHIKBAAR\s+56\.371 documenten/);
  assert.match(summary(data), /BESCHIKBAAR 56\.371/);
  assert.match(summary(data), /fase inventory/);
  assert.equal(data.complete, false);
  assert.doesNotMatch(text, /\d+%/);
});

test('absent source document retained for review prevents false complete refresh', () => {
  const data = collect(args => args[0] === 'inspect'
    ? JSON.stringify({ Running: false, Status: 'exited' })
    : JSON.stringify({ run: { id: 'limburg-full-20261111', pages: 4000, generation: 1,
      refresh_phase: 'complete', snapshot_complete: 1 }, counts: { indexed: 10 },
      audit: { Document: { unchanged: 9, missing_retained: 1 } } }));
  assert.equal(data.complete, false);
  assert.match(dashboard(data), /Herscand 9/);
});
