"""Offline regression suite: python -m unittest discover -s tests/agents -p test_openbesluitvorming_ingest.py"""
import importlib.util
import concurrent.futures
import io
import json
import math
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('obv_worker', ROOT / 'services/openbesluitvorming-ingest/worker.py')
obv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(obv)
FIXTURE = ROOT / 'tests/agents/fixtures/openbesluitvorming-limburg-snapshot.ndjson'
RECORDS = [json.loads(line) for line in FIXTURE.read_text(encoding='utf-8').splitlines() if line]
DETAIL = json.loads((FIXTURE.parent / 'openbesluitvorming-limburg-detail.json').read_text(encoding='utf-8'))
HEADERS = {'X-Has-More': 'true', 'X-Next-Cursor': RECORDS[-1]['entity_id'], 'X-Changes-Cursor': '111032'}


class Encoder:
    def encode(self, text, **kwargs):
        return list(text.encode('utf-8'))


class FakeHttp:
    def __init__(self):
        self.calls = []
        self.payload = None
        self.embedding_error = None
        self.existing = False
        self.snapshot = (FIXTURE.read_bytes(), HEADERS)
        self.download_error = False
        self.tika = b'Complete extracted attachment text.'

    def request(self, url, method='GET', data=None, headers=None, **kwargs):
        self.calls.append((url, method, data))
        if '/export/snapshot?' in url:
            return self.snapshot
        if url == 'http://tika:9998/tika':
            return self.tika, {'Content-Type': 'text/plain'}
        if self.download_error:
            raise obv.IngestError('http_404', 'http')
        return b'%PDF-fake', {'Content-Type': 'application/pdf'}

    def json(self, url, method='GET', data=None, headers=None):
        self.calls.append((url, method, data))
        if '/embeddings' in url:
            if self.embedding_error:
                return self.embedding_error
            return {'data': [{'index': i, 'embedding': [1.0] + [0.0] * 3071}
                             for i in reversed(range(len(data['input'])))]}
        if '/entities/' in url:
            entity = obv.urllib.parse.unquote(url.rsplit('/', 1)[-1])
            if entity == DETAIL['entityId']:
                return dict(DETAIL)
            if entity.startswith('document:'):
                return {**DETAIL, 'entityId': entity, 'markdownText': 'Full source markdown.'}
            return {'entityId': entity, 'entityType': 'Meeting', 'title': 'Meeting', 'unknown': [None, {'x': 7}]}
        if '/points?wait=true' in url:
            self.payload = data['points'][0]
            return {'status': 'ok', 'result': {'status': 'completed'}}
        if method == 'GET' and '/collections/' in url:
            if not self.existing:
                raise obv.IngestError('http_404', 'http')
            return {'result': {'config': {'params': {'vectors': {'size': 3072, 'distance': 'Cosine'}}}}}
        if method == 'PUT' and '/collections/' in url and '/index' not in url:
            self.existing = True
        return {'status': 'ok'}


class PaginationTests(unittest.TestCase):
    def test_actual_schema(self):
        records, cursor, more, changes = obv.parse_page(FIXTURE.read_bytes(), HEADERS)
        self.assertEqual(records, RECORDS)
        self.assertTrue(more)
        self.assertEqual(cursor, RECORDS[-1]['entity_id'])
        self.assertEqual(changes, '111032')

    def test_terminal_empty_page(self):
        self.assertEqual(obv.parse_page(b'', {'x-has-more': 'false', 'x-changes-cursor': '1'})[:3], ([], None, False))

    def test_malformed_lines_never_filtered(self):
        for bad in (b'{invalid}', b'null', b'[]', b'{}', b'\xff'):
            with self.subTest(bad=bad), self.assertRaises(obv.IngestError):
                obv.parse_page(FIXTURE.read_bytes() + b'\n' + bad, HEADERS)

    def test_bad_pagination_headers(self):
        for h in ({}, {'x-has-more': 'yes'}, {**HEADERS, 'X-Next-Cursor': ''}, {**HEADERS, 'X-Changes-Cursor': ''}):
            with self.subTest(h=h), self.assertRaises(obv.IngestError):
                obv.parse_page(FIXTURE.read_bytes(), h)

    def test_repeated_cursor(self):
        with self.assertRaises(obv.IngestError):
            obv.parse_page(FIXTURE.read_bytes(), HEADERS, HEADERS['X-Next-Cursor'])

    def test_empty_nonterminal_page(self):
        with self.assertRaises(obv.IngestError):
            obv.parse_page(b'', HEADERS)

    def test_wrong_source_and_operation(self):
        for record in ({**RECORDS[0], 'source_key': 'other'}, {**RECORDS[0], 'op': 'unknown'}):
            with self.assertRaises(obv.IngestError):
                obv.parse_page(json.dumps(record), HEADERS)

    def test_duplicate_entities(self):
        with self.assertRaises(obv.IngestError):
            obv.parse_page('\n'.join([json.dumps(RECORDS[0])] * 2), HEADERS)

    def test_cursor_cannot_skip_snapshot_records(self):
        with self.assertRaisesRegex(obv.IngestError, 'cursor_does_not_match'):
            obv.parse_page(FIXTURE.read_bytes(), {**HEADERS, 'X-Next-Cursor': 'zzzz'})

    def test_unordered_and_backtracking_records_fail(self):
        with self.assertRaises(obv.IngestError):
            obv.parse_page('\n'.join(json.dumps(r) for r in reversed(RECORDS)), HEADERS)
        with self.assertRaises(obv.IngestError):
            obv.parse_page(FIXTURE.read_bytes(), HEADERS, RECORDS[0]['entity_id'])


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.http = FakeHttp()
        self.worker = obv.Worker(self.tmp.name, self.http, Encoder())
        self.worker.fresh('test', 'limburg_test')
        self.run = self.worker.run_info('test')

    def tearDown(self):
        self.worker.db.close()
        self.tmp.cleanup()

    def test_fresh_refuses_existing_data(self):
        with self.assertRaisesRegex(obv.IngestError, 'refusing_existing_collection'):
            self.worker.fresh('second', 'limburg_other')
        self.assertFalse(any(method == 'DELETE' for _, method, _ in self.http.calls))

    def test_fresh_does_not_fetch_source(self):
        self.assertFalse(any('/entities/' in url or '/export/' in url for url, _, _ in self.http.calls))

    def test_fresh_requires_isolated_name(self):
        with self.assertRaises(obv.IngestError):
            self.worker.fresh('other', 'openbesluitvorming')

    def test_page_enqueue_cursor_and_raw_metadata_are_atomic(self):
        self.worker.page(self.run, 5)
        self.assertEqual(self.worker.run_info('test')['cursor'], RECORDS[-1]['entity_id'])
        rows = self.worker.db.execute('SELECT record FROM documents ORDER BY entity_id').fetchall()
        self.assertEqual([json.loads(r['record']) for r in rows], RECORDS)
        self.assertEqual(self.worker.db.execute('SELECT raw FROM pages').fetchone()['raw'], FIXTURE.read_bytes())

    def test_malformed_page_does_not_advance_checkpoint(self):
        self.http.snapshot = (FIXTURE.read_bytes() + b'\n{broken}', HEADERS)
        with self.assertRaises(obv.IngestError):
            self.worker.page(self.run, 5)
        self.assertIsNone(self.worker.run_info('test')['cursor'])
        self.assertEqual(self.worker.db.execute('SELECT count(*) FROM documents').fetchone()[0], 0)
        self.assertEqual(self.worker.db.execute('SELECT count(*) FROM rejected_pages').fetchone()[0], 1)

    def test_page_larger_than_requested_is_rejected(self):
        with self.assertRaisesRegex(obv.IngestError, 'exceeded_requested_limit'):
            self.worker.page(self.run, 2)

    def test_missing_markdown_downloads_attachment_through_tika(self):
        text, evidence = self.worker.content(RECORDS[0], DETAIL)
        self.assertEqual(text, self.http.tika.decode())
        self.assertEqual(evidence[0]['method'], 'tika')
        self.assertEqual(evidence[0]['bytes'], 9)

    def test_markdown_path_does_not_download(self):
        self.http.calls.clear()
        text, evidence = self.worker.content(RECORDS[0], {**DETAIL, 'markdownText': 'All markdown'})
        self.assertEqual(text, 'All markdown')
        self.assertEqual(evidence[0]['method'], 'source_markdown')
        self.assertEqual(self.http.calls, [])

    def test_explicit_attachments_included_with_source_markdown(self):
        d = {**DETAIL, 'markdownText': 'Main', 'attachments': [{'url': RECORDS[0]['payload']['original_url'] + '&attachment=extra', 'name': 'Extra'}]}
        text, evidence = self.worker.content(RECORDS[0], d)
        self.assertIn('Main', text)
        self.assertIn(self.http.tika.decode(), text)
        self.assertEqual(len(evidence), 2)

    def test_failed_required_attachment_is_not_silently_skipped(self):
        self.http.download_error = True
        with self.assertRaisesRegex(obv.IngestError, 'all_attachment_candidates_failed'):
            self.worker.content(RECORDS[0], DETAIL)

    def test_multiple_media_entries_are_all_indexed(self):
        p = {**RECORDS[0]['payload'], 'media_urls': [
            {'url': RECORDS[0]['payload']['original_url']},
            {'url': RECORDS[0]['payload']['original_url'] + '&second=1'}]}
        text, evidence = self.worker.content({**RECORDS[0], 'payload': p}, DETAIL)
        self.assertEqual(len(evidence), 2)
        self.assertEqual(text.count(self.http.tika.decode()), 2)

    def test_attachment_fallback_failure_evidence_retained(self):
        original = self.http.request
        def request(url, *args, **kwargs):
            if 'stored.pdf' in url:
                raise obv.IngestError('http_404', 'http')
            return original(url, *args, **kwargs)
        self.http.request = request
        text, evidence = self.worker.download_text(['https://fsn1.your-objectstorage.com/stored.pdf', RECORDS[0]['payload']['original_url']], 'name')
        self.assertTrue(text)
        self.assertEqual(evidence['fallback_errors'], [{'code': 'http_404', 'stage': 'http'}])

    def test_failure_listing_is_read_only(self):
        self.worker.page(self.run, 5)
        with self.worker.db:
            self.worker.db.execute("UPDATE documents SET status='dead_letter'")
        result = self.worker.failures('test', 2, 1)
        self.assertEqual(len(result['failures']), 2)
        self.assertEqual(self.worker.status('test')['runs'][0]['counts']['dead_letter'], 5)

    def test_empty_tika_output_is_failure(self):
        self.http.tika = b'  '
        with self.assertRaises(obv.IngestError) as result:
            self.worker.content(RECORDS[0], DETAIL)
        self.assertEqual(result.exception.evidence[0]['code'], 'empty_tika_text_ocr_may_be_required')

    def test_unknown_attachment_schema_fails_closed(self):
        with self.assertRaises(obv.IngestError):
            self.worker.content(RECORDS[0], {**DETAIL, 'markdownText': 'Text', 'attachments': {'url': 'x'}})

    def test_long_document_no_48_chunk_cap(self):
        vector, stats = self.worker.embed('a' * 100001, 'Title', 'govchat-embedding')
        self.assertEqual(stats['chunk_count'], 51)
        self.assertEqual(stats['embedding_tokens'], 100001)
        self.assertEqual(stats['embedding_batch_count'], 7)
        self.assertEqual(len(vector), 3072)
        self.assertAlmostEqual(sum(x*x for x in vector), 1)
        batches = [data['input'] for url, _, data in self.http.calls if '/embeddings' in url]
        self.assertTrue(all(len(batch) <= 8 for batch in batches))

    def test_malformed_embedding_batches_fail_closed(self):
        cases = [{'data': []}, {'data': [{'index': 0, 'embedding': [1]}]},
                 {'data': [{'index': 1, 'embedding': [1] * 3072}]},
                 {'data': [{'index': 0, 'embedding': [math.nan] * 3072}]},
                 {'data': [{'index': 0, 'embedding': [0] * 3072}]}]
        for bad in cases:
            self.http.embedding_error = bad
            with self.subTest(bad=str(bad)[:40]), self.assertRaises(obv.IngestError):
                self.worker.embed('Text', 'Title', 'govchat-embedding')

    def test_complete_metadata_payload_and_public_links(self):
        record = {**RECORDS[0], 'future_field': {'a': [False, None]},
                  'payload': {**RECORDS[0]['payload'], 'unknown_metadata': {'x': 0}}}
        self.worker.process(self.run, {'record': json.dumps(record)})
        payload = self.http.payload['payload']
        self.assertEqual(payload['source_record'], record)
        self.assertEqual(payload['source_payload'], record['payload'])
        self.assertEqual(payload['entity_detail'], DETAIL)
        self.assertEqual(payload['reference_detail']['unknown'], [None, {'x': 7}])
        self.assertEqual(payload['full_text'], self.http.tika.decode())
        self.assertFalse(payload['text_truncated'])
        self.assertIn('/Agenda/Document/', payload['public_url'])
        self.assertEqual(payload['original_download_url'], record['payload']['original_url'])
        self.assertEqual(self.http.payload['id'], obv.point_id(record['entity_id']))

    def test_actual_organization_reference_not_an_entity_api_resource(self):
        reference = RECORDS[3]['payload']['is_referenced_by']
        self.http.calls.clear()
        result = self.worker.context(reference)
        self.assertEqual(result['entity_id'], reference)
        self.assertEqual(result['metadata_status'], 'reference_only')
        self.assertFalse(self.http.calls)

    def test_legacy_workflows_have_no_scheduler_and_fail_closed(self):
        for name in ('ingest', 'sync', 'document-worker'):
            w = json.loads((ROOT / f'agents/n8n/workflows/openbesluitvorming/openbesluitvorming-{name}.json').read_text(encoding='utf-8'))
            self.assertFalse(w['active'])
            self.assertFalse(any(n['type'] == 'n8n-nodes-base.scheduleTrigger' for n in w['nodes']))
            guard = next(n for n in w['nodes'] if n['name'].startswith('2. Configure') or n['name'] == '2. Split Documents')
            self.assertTrue(guard['parameters']['jsCode'].startswith('throw new Error('))

    def test_durable_retry_dead_letter_and_operator_requeue(self):
        self.worker.page(self.run, 5)
        self.worker.process = lambda run, job: (_ for _ in ()).throw(obv.IngestError('failed', 'test'))
        result = self.worker.execute('test', 1, 1)
        self.assertEqual(result['session_processed'], 1)
        self.assertEqual(result['runs'][0]['counts']['retry'], 1)
        job = self.worker.db.execute("SELECT * FROM documents WHERE status='retry'").fetchone()
        with self.worker.db:
            self.worker.db.execute("UPDATE documents SET attempts=2,next_attempt=0 WHERE entity_id=?", (job['entity_id'],))
        self.worker.execute('test', 1, 1)
        self.assertEqual(self.worker.status('test')['runs'][0]['counts']['dead_letter'], 1)
        self.assertEqual(self.worker.retry('test', job['entity_id'])['requeued'], 1)

    def test_crash_claim_is_replayed_idempotently(self):
        self.worker.page(self.run, 5)
        with self.worker.db:
            self.worker.db.execute("UPDATE documents SET status='processing' WHERE entity_id=?", (RECORDS[0]['entity_id'],))
        self.worker.execute('test', 1, 1)
        self.assertEqual(self.worker.status('test')['runs'][0]['counts']['indexed'], 1)

    def test_full_run_requires_explicit_approval(self):
        with self.assertRaisesRegex(obv.IngestError, 'approve_full_run'):
            self.worker.execute('test', 100000, 20000)

    def test_status_complete_requires_zero_failures(self):
        self.worker.page(self.run, 5)
        with self.worker.db:
            self.worker.db.execute("UPDATE runs SET snapshot_complete=1 WHERE id='test'")
            self.worker.db.execute("UPDATE documents SET status='dead_letter'")
        self.assertFalse(self.worker.status('test')['runs'][0]['complete'])
        with self.worker.db:
            self.worker.db.execute("UPDATE documents SET status='indexed'")
        self.assertTrue(self.worker.status('test')['runs'][0]['complete'])

    def test_parallel_inflight_and_exact_attempt_bounds(self):
        self.worker.page(self.run, 5)
        gate = threading.Barrier(2)
        mutex = threading.Lock()
        active, peak, calls = 0, 0, 0
        def process(run, job):
            nonlocal active, peak, calls
            with mutex:
                active += 1
                peak = max(peak, active)
                calls += 1
                number = calls
            if number <= 2:
                gate.wait(timeout=5)
            time.sleep(0.01)
            with mutex:
                active -= 1
            return 'indexed'
        self.worker.process = process
        result = self.worker.execute('test', 3, 1, workers=2)
        self.assertEqual((calls, peak, result['session_processed']), (3, 2, 3))
        self.assertEqual(result['performance']['peak_inflight'], 2)
        self.assertEqual(result['runs'][0]['counts'], {'indexed': 3, 'pending': 2})
        self.assertEqual(self.worker.db.execute('SELECT sum(attempts) FROM documents').fetchone()[0], 3)

    def test_invalid_worker_bounds_and_environment_default(self):
        for workers in (0, -1, 5, 100):
            with self.assertRaisesRegex(obv.IngestError, 'workers_must'):
                self.worker.execute('test', workers=workers)
        self.worker.page(self.run, 5)
        with patch.dict(obv.os.environ, {'OBV_WORKERS': '1'}):
            result = self.worker.execute('test', 1, 1)
        self.assertEqual(result['performance']['workers'], 1)

    def test_parallel_replay_and_error_sibling_are_both_persisted(self):
        self.worker.page(self.run, 5)
        with self.worker.db:
            self.worker.db.execute("UPDATE documents SET status='processing' WHERE entity_id=?", (RECORDS[0]['entity_id'],))
        original = self.worker.process
        def process(run, job):
            if job['entity_id'] == RECORDS[1]['entity_id']:
                raise obv.IngestError('http_429', 'http')
            return original(run, job)
        self.worker.process = process
        result = self.worker.execute('test', 2, 1, workers=2)
        self.assertEqual(result['runs'][0]['counts'], {'indexed': 1, 'retry': 1, 'pending': 3})
        self.assertEqual(self.http.payload['id'], obv.point_id(RECORDS[0]['entity_id']))
        self.assertIn('http_429', result['runs'][0]['failures'][0]['error'])

    def test_unexpected_task_exception_is_sanitized_and_success_sibling_persists(self):
        self.worker.page(self.run, 5)
        def process(run, job):
            if job['entity_id'] == RECORDS[0]['entity_id']:
                raise RuntimeError('private response must not appear in evidence')
            return 'indexed'
        self.worker.process = process
        result = self.worker.execute('test', 2, 1, workers=2)
        self.assertEqual(result['runs'][0]['counts'], {'indexed': 1, 'retry': 1, 'pending': 3})
        failure = result['runs'][0]['failures'][0]
        self.assertEqual(json.loads(failure['error']), {'code': 'unexpected_RuntimeError', 'stage': 'worker'})
        self.assertNotIn('private response', json.dumps(result))

    def test_page_exception_drains_outstanding_success_and_failure(self):
        for exception in (obv.IngestError('http_429', 'http'), RuntimeError('page failed'), KeyboardInterrupt()):
            with self.subTest(exception=type(exception).__name__):
                with self.worker.db:
                    self.worker.db.execute('DELETE FROM documents')
                    for record in RECORDS[:2]:
                        self.worker.db.execute('INSERT INTO documents(run_id,entity_id,record,updated_at) VALUES(?,?,?,?)',
                                               ('test', record['entity_id'], json.dumps(record), obv.now()))
                release = threading.Event()
                def process(run, job):
                    self.assertTrue(release.wait(5))
                    if job['entity_id'] == RECORDS[1]['entity_id']:
                        raise obv.IngestError('embedding_failure', 'embedding')
                    return 'indexed'
                def page(*args):
                    release.set()
                    raise exception
                self.worker.process = process
                self.worker.page = page
                with self.assertRaises(type(exception)):
                    self.worker.execute('test', 3, 1, workers=3)
                self.assertEqual(self.worker.status('test')['runs'][0]['counts'], {'indexed': 1, 'retry': 1})

    def test_parallel_page_budget_and_remaining_document_request_are_exact(self):
        calls = []
        def page(run, limit):
            calls.append(limit)
            # Non-document pages must still count toward the invocation bound.
        self.worker.page = page
        result = self.worker.execute('test', 3, 2, page_size=100, workers=4)
        self.assertEqual(calls, [3, 3])
        self.assertEqual((result['session_pages'], result['session_processed']), (2, 0))

    def test_reference_cache_is_deduplicated_durable_and_bounded(self):
        reference = RECORDS[0]['payload']['is_referenced_by']
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(self.worker.context, [reference] * 4))
        self.assertTrue(all(r == results[0] for r in results))
        self.assertEqual(sum('/entities/' in url for url, _, _ in self.http.calls), 1)
        self.worker.flush_contexts()
        self.worker.context_cache.clear()
        self.worker.context(reference)
        self.assertEqual(sum('/entities/' in url for url, _, _ in self.http.calls), 1)
        for i in range(130):
            self.worker.context(f'meeting:test:{i}')
            self.worker.flush_contexts()
        self.assertLessEqual(len(self.worker.context_cache), 128)

    def test_timing_metrics_cover_pipeline_and_are_not_payload_metadata(self):
        self.worker.page(self.run, 5)
        result = self.worker.execute('test', 1, 1, workers=1)
        metrics = result['performance']
        self.assertGreater(metrics['elapsed_seconds'], 0)
        self.assertAlmostEqual(metrics['documents_per_second'], 1 / metrics['elapsed_seconds'])
        for stage in ('detail', 'attachment', 'tika', 'embedding', 'upsert'):
            self.assertGreater(metrics['stages'][stage]['calls'], 0)
            self.assertGreater(metrics['stages'][stage]['seconds'], 0)
        self.assertNotIn('timings_seconds', self.http.payload['payload'])

    def test_tokenizer_initializes_once_across_threads(self):
        import types
        get_encoding = unittest.mock.Mock(return_value=Encoder())
        self.worker.encoder = None
        with patch.dict('sys.modules', {'tiktoken': types.SimpleNamespace(get_encoding=get_encoding)}):
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda _: self.worker.embed('Text', 'Title', 'model'), range(4)))
        get_encoding.assert_called_once_with('cl100k_base')


class SafetyTests(unittest.TestCase):
    def test_attachment_downloads_share_two_slots_and_global_start_pacing(self):
        clock, starts = [100.0], []
        barrier = threading.Barrier(2)
        mutex = threading.Lock()
        active, peak = 0, 0
        class Response:
            headers = {}
            def __enter__(self):
                return self
            def read(self, count):
                barrier.wait(timeout=5)
                return b'ok'
            def __exit__(self, *args):
                nonlocal active
                with mutex:
                    active -= 1
        def open_request(*args, **kwargs):
            nonlocal active, peak
            with mutex:
                starts.append(clock[0])
                active += 1
                peak = max(peak, active)
            return Response()
        opener = unittest.mock.Mock()
        opener.open.side_effect = open_request
        http = obv.Http()
        with patch.object(obv.urllib.request, 'build_opener', return_value=opener), \
                patch.object(obv.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(obv.time, 'sleep', side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)):
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda _: http.request('https://api1.ibabs.eu/file', attachment=True), range(8)))
        self.assertEqual(peak, 2)
        self.assertEqual(len(starts), 8)
        self.assertTrue(all(b - a >= 0.5 - 1e-8 for a, b in zip(starts, starts[1:])))

    def test_attachment_redirects_are_allowlisted_and_paced(self):
        pace = unittest.mock.Mock()
        redirect = obv.SafeRedirect(pace)
        request = obv.urllib.request.Request('https://api1.ibabs.eu/file')
        redirected = redirect.redirect_request(request, None, 302, 'found', {}, 'https://fsn1.your-objectstorage.com/file')
        self.assertEqual(redirected.full_url, 'https://fsn1.your-objectstorage.com/file')
        pace.assert_called_once_with()
        with self.assertRaises(obv.IngestError):
            redirect.redirect_request(request, None, 302, 'found', {}, 'https://evil.example/file')
        pace.assert_called_once_with()

    def test_final_attachment_429_establishes_shared_download_cooldown(self):
        clock, starts = [100.0], []
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'ok'
        response.headers = {}
        def open_request(*args, **kwargs):
            starts.append(clock[0])
            if len(starts) == 1:
                raise obv.urllib.error.HTTPError('https://api1.ibabs.eu/file', 429, 'limit', {'Retry-After': '125'}, io.BytesIO())
            return response
        opener = unittest.mock.Mock()
        opener.open.side_effect = open_request
        http = obv.Http()
        http.attempts = 1
        with patch.object(obv.urllib.request, 'build_opener', return_value=opener), \
                patch.object(obv.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(obv.time, 'sleep', side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)):
            with self.assertRaisesRegex(obv.IngestError, 'http_429'):
                http.request('https://api1.ibabs.eu/first', attachment=True)
            http.request('https://api1.ibabs.eu/second', attachment=True)
        self.assertGreaterEqual(starts[1] - starts[0], 125)

    def test_source_starts_are_globally_paced_across_threads_and_retries(self):
        clock, starts = [100.0], []
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'ok'
        response.headers = {}
        def open_request(*args, **kwargs):
            starts.append(clock[0])
            if len(starts) == 1:
                raise obv.urllib.error.HTTPError(obv.API, 429, 'rate limit', {'Retry-After': '7'}, io.BytesIO())
            return response
        opener = unittest.mock.Mock()
        opener.open.side_effect = open_request
        http = obv.Http()
        def sleep(delay):
            clock[0] += delay
        with patch.object(obv.urllib.request, 'build_opener', return_value=opener), \
                patch.object(obv.time, 'monotonic', side_effect=lambda: clock[0]), patch.object(obv.time, 'sleep', side_effect=sleep):
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(http.request, [obv.API + '/entities/test', obv.API + '/export/snapshot?limit=1'] * 2))
        self.assertEqual(len(starts), 5)
        self.assertGreaterEqual(starts[1] - starts[0], 7)
        self.assertTrue(all(b - a >= 1.1 - 1e-8 for a, b in zip(starts, starts[1:])))

    def test_final_source_429_cooldown_applies_to_next_document(self):
        clock, starts = [100.0], []
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'ok'
        response.headers = {}
        def open_request(*args, **kwargs):
            starts.append(clock[0])
            if len(starts) == 1:
                raise obv.urllib.error.HTTPError(obv.API, 429, 'limit', {'Retry-After': '125'}, io.BytesIO())
            return response
        opener = unittest.mock.Mock()
        opener.open.side_effect = open_request
        http = obv.Http()
        http.attempts = 1
        with patch.object(obv.urllib.request, 'build_opener', return_value=opener), \
                patch.object(obv.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(obv.time, 'sleep', side_effect=lambda delay: clock.__setitem__(0, clock[0] + delay)):
            with self.assertRaisesRegex(obv.IngestError, 'http_429'):
                http.request(obv.API + '/entities/first')
            http.request(obv.API + '/entities/second')
        self.assertGreaterEqual(starts[1] - starts[0], 125)

    def test_retry_after_http_date_and_invalid_values(self):
        with patch.object(obv.time, 'time', return_value=0):
            self.assertEqual(obv.Http.retry_delay('Thu, 01 Jan 1970 00:02:05 GMT', 0), 125)
        for value in ('invalid', 'NaN', '-1', 'inf'):
            self.assertEqual(obv.Http.retry_delay(value, 2), 4)

    def test_http_retry_after_and_attempt_budget(self):
        import io
        error = obv.urllib.error.HTTPError('https://example.test', 429, 'rate limit', {'Retry-After': '7'}, io.BytesIO())
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'ok'
        response.headers = {}
        opener = unittest.mock.MagicMock()
        opener.open.side_effect = [error, response]
        with patch.object(obv.urllib.request, 'build_opener', return_value=opener), patch.object(obv.time, 'sleep') as sleep:
            result = obv.Http().request('https://example.test')
        self.assertEqual(result[0], b'ok')
        sleep.assert_called_with(7)
        self.assertEqual(opener.open.call_count, 2)

    def test_download_size_budget_is_not_truncation(self):
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'12345'
        response.headers = {}
        opener = unittest.mock.MagicMock()
        opener.open.return_value = response
        with patch.object(obv.urllib.request, 'build_opener', return_value=opener), self.assertRaisesRegex(obv.IngestError, 'size_budget'):
            obv.Http().request('https://example.test', max_bytes=4)

    def test_explicit_public_portal_url_is_preserved(self):
        doc = RECORDS[0]['entity_id'].rsplit(':', 1)[-1]
        prior = f'https://limburg.bestuurlijkeinformatie.nl/Reports/Document/816dfb44-e9f8-4561-a58e-c960b59f68c7?documentId={doc}'
        self.assertEqual(obv.public_links(RECORDS[0]['entity_id'], None, 'download', prior)['public_url'], prior)

    def test_ssrf_redirect_allowlist(self):
        for url in ('http://api1.ibabs.eu/a', 'https://127.0.0.1/a', 'https://evil.example/a',
                    'https://api1.ibabs.eu:444/a', 'https://user:password@api1.ibabs.eu/a'):
            with self.subTest(url=url), self.assertRaises(obv.IngestError):
                obv.validate_attachment_url(url)
        self.assertEqual(obv.validate_attachment_url(RECORDS[0]['payload']['original_url']), RECORDS[0]['payload']['original_url'])

    def test_overlapping_commands_refused_and_lock_released(self):
        with tempfile.TemporaryDirectory() as directory:
            with obv.lock(Path(directory)):
                with self.assertRaises(obv.IngestError):
                    with obv.lock(Path(directory)):
                        pass
            with obv.lock(Path(directory)):
                pass

    def test_point_id_is_stable_sha256_for_fresh_collections(self):
        import hashlib
        self.assertEqual(obv.point_id(RECORDS[0]['entity_id']).replace('-', ''), hashlib.sha256(RECORDS[0]['entity_id'].encode()).hexdigest()[:32])


if __name__ == '__main__':
    unittest.main()
