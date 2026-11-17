"""Explicit five-document benchmark; offline by default, never targets full ingest.

Live execution requires --live --baseline PATH and existing worker credentials.
Creates four NEW collections, never deletes collections or changes search aliases.
Measures execute() only, excluding identical initialization/verification overhead.
"""
import argparse
import contextlib
import datetime
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import statistics
import tempfile
import threading
import time
import uuid


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parents[2]
obv = load(ROOT / 'services/openbesluitvorming-ingest/worker.py', 'benchmark_worker')
fixtures = load(ROOT / 'tests/agents/test_openbesluitvorming_ingest.py', 'benchmark_fixtures')


class LatencyHttp(fixtures.FakeHttp):
    """Fixed synthetic latency, not a production source-rate configuration."""
    def __init__(self, error_class):
        super().__init__()
        self.error_class = error_class
        self.source_lock = threading.Lock()
        self.last_source = 0
        self.points = {}

    def delay(self, url):
        if url.startswith(obv.API + '/'):
            with self.source_lock:
                time.sleep(max(0, 0.05 - (time.perf_counter() - self.last_source)))
                self.last_source = time.perf_counter()
                time.sleep(0.02)
        elif '/collections/' not in url or '/points?wait=true' in url:
            time.sleep(0.10)

    def request(self, url, *args, **kwargs):
        self.delay(url)
        return super().request(url, *args, **kwargs)

    def json(self, url, method='GET', data=None, headers=None):
        self.delay(url)
        try:
            result = super().json(url, method, data, headers)
        except fixtures.obv.IngestError as error:
            raise self.error_class(error.code, error.stage, error.evidence) from None
        if '/entities/' in url and result['entityId'] == fixtures.RECORDS[1]['entity_id']:
            result.pop('markdownText', None)
        if '/points?wait=true' in url:
            self.points[data['points'][0]['id']] = data['points'][0]
        return result


class MeterHttp:
    """Identical HTTP-only instrumentation for old/new worker comparisons."""
    def __init__(self, inner):
        self.inner = inner
        self.metrics = {}
        self.mutex = threading.Lock()

    def call(self, function, url, *args, **kwargs):
        if '/export/snapshot?' in url:
            stage = 'source'
        elif '/entities/' in url:
            stage = 'detail'
        elif '/embeddings' in url:
            stage = 'embedding'
        elif '/points?wait=true' in url:
            stage = 'upsert'
        elif url.endswith('/tika'):
            stage = 'tika'
        elif kwargs.get('attachment'):
            stage = 'attachment'
        else:
            return function(url, *args, **kwargs)
        start = time.perf_counter()
        try:
            return function(url, *args, **kwargs)
        finally:
            with self.mutex:
                metric = self.metrics.setdefault(stage, {'calls': 0, 'seconds': 0.0})
                metric['calls'] += 1
                metric['seconds'] += time.perf_counter() - start

    def request(self, url, *args, **kwargs):
        return self.call(self.inner.request, url, *args, **kwargs)

    def json(self, url, *args, **kwargs):
        return self.call(self.inner.json, url, *args, **kwargs)


def canonical(points):
    payloads = {}
    for point in points:
        payload = dict(point['payload'])
        for field in ('ingest_run_id', 'indexed_at'):
            payload.pop(field)
        payloads[payload['source_id']] = payload
    return payloads


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--baseline', type=Path, help='unchanged d9b48e8 worker extracted by git show')
    parser.add_argument('--state-dir', type=Path, default=Path('/state'))
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.live and not args.baseline:
        parser.error('--live requires --baseline (original sequential worker)')
    baseline = load(args.baseline, 'baseline_worker') if args.baseline else obv
    if args.live:
        import tiktoken
        encoder = tiktoken.get_encoding('cl100k_base')
        encoder.encode('Warm tokenizer identically for all timed samples.')
    else:
        encoder = fixtures.Encoder()
    report = {'mode': 'live' if args.live else 'offline_fixed_latency', 'documents_per_trial': 5,
              'recorded_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'timing_scope': 'perf_counter around execute; fresh/tokenizer/verify excluded for every trial',
              'trials': []}
    reference = None
    full_before = None
    # Same global mutation lock as the CLI. No full run is ever executed here.
    with obv.lock(args.state_dir) if args.live else contextlib.nullcontext():
        if args.live:
            full = obv.Worker(args.state_dir, encoder=encoder)
            full_before = full.status('limburg-full-20261111')
            sample_before = full.status('live-sample-20261111')
            sample_count = full.verify('live-sample-20261111')['qdrant_count']
            full_count = full.verify('limburg-full-20261111')['qdrant_count']
            if full_count != 0 or full_before['runs'][0]['pages'] != 0 or full_before['runs'][0]['counts']:
                raise RuntimeError('full run is not untouched/empty; refusing benchmark')
        # ABBA counterbalances ordering/cache/provider variability. Offline also
        # measures the opt-in maximum. Each trial has independent context state.
        schedule = [(baseline, 1), (obv, 2), (obv, 2), (baseline, 1)]
        if not args.live:
            schedule += [(obv, 4)]
        for index, (module, workers) in enumerate(schedule):
            run_id = f'perf-{uuid.uuid4().hex[:12]}-{index}-w{workers}'
            collection = 'limburg_' + run_id.replace('-', '_')
            with tempfile.TemporaryDirectory() as temporary:
                state = args.state_dir / 'performance-benchmarks' / run_id if args.live else Path(temporary)
                inner = module.Http() if args.live else LatencyHttp(module.IngestError)
                http = MeterHttp(inner)
                worker = module.Worker(state, http=http, encoder=encoder)
                try:
                    with contextlib.redirect_stdout(io.StringIO()):
                        worker.fresh(run_id, collection)
                        # Cross-trial pacing remains conservative, even though
                        # old/new Http objects have independent invocation state.
                        if args.live:
                            time.sleep(1.1)
                        start = time.perf_counter()
                        kwargs = {'workers': workers} if module is obv else {}
                        result = worker.execute(run_id, 5, 1, 5, **kwargs)
                        elapsed = time.perf_counter() - start
                    if result['session_processed'] != 5 or result['session_pages'] != 1 or result['runs'][0]['counts'] != {'indexed': 5}:
                        raise RuntimeError('benchmark did not index exactly five documents without failures')
                    if args.live:
                        verification = worker.verify(run_id, 5)
                        jobs = worker.db.execute('SELECT entity_id FROM documents ORDER BY entity_id').fetchall()
                        points = http.json(worker.collection_url(collection) + '/points', 'POST',
                                           {'ids': [module.point_id(j['entity_id']) for j in jobs],
                                            'with_payload': True, 'with_vector': False})['result']
                    else:
                        points = list(inner.points.values())
                        verification = {'qdrant_count': len(points)}
                    payloads = canonical(points)
                    methods = [e['method'] for p in payloads.values() for e in p['extraction']]
                    if methods.count('tika') != 2 or methods.count('source_markdown') != 3:
                        raise RuntimeError('sample must contain two Tika and three markdown documents')
                    if reference is None:
                        reference = payloads
                    if payloads != reference:
                        raise RuntimeError('metadata/fulltext differs between trials (excluding run ID/index timestamp)')
                    trial = {'implementation': 'current' if module is obv else 'd9b48e8', 'workers': workers,
                             'run_id': run_id, 'collection': collection, 'state_dir': str(state) if args.live else 'temporary',
                             'elapsed_seconds': elapsed, 'documents_per_second': 5 / elapsed,
                             'counts': result['runs'][0]['counts'], 'verified_points': verification['qdrant_count'],
                             'methods': {'tika': 2, 'source_markdown': 3},
                             'metadata_fulltext_exact': True, 'http_stages': http.metrics,
                             'performance': result.get('performance')}
                    if args.live:
                        import resource
                        trial['process_cumulative_high_water_rss_mib'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
                    report['trials'].append(trial)
                    print(json.dumps(trial), flush=True)
                finally:
                    worker.db.close()
        if args.live:
            try:
                if full.status('limburg-full-20261111') != full_before or full.verify('limburg-full-20261111')['qdrant_count'] != 0:
                    raise RuntimeError('full-run state changed')
                report['full_run_unchanged'] = True
                report['full_run_before_and_after'] = full_before
                report['full_collection_points'] = 0
                if full.status('live-sample-20261111') != sample_before or full.verify('live-sample-20261111')['qdrant_count'] != sample_count:
                    raise RuntimeError('old sample state/count changed')
                report['old_sample_state_and_count_unchanged'] = True
                report['old_sample_points'] = sample_count
            finally:
                full.db.close()
    sequential = statistics.mean(t['elapsed_seconds'] for t in report['trials'][:4] if t['workers'] == 1)
    parallel = statistics.mean(t['elapsed_seconds'] for t in report['trials'][:4] if t['workers'] == 2)
    report.update({'sequential_mean_seconds': sequential, 'parallel2_mean_seconds': parallel,
                   'observed_speedup': sequential / parallel,
                   'metadata_fulltext_sha256': hashlib.sha256(json.dumps(reference, sort_keys=True).encode()).hexdigest()})
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
