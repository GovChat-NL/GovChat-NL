"""Offline regression suite: python -m unittest discover -s tests/agents -p test_openbesluitvorming_ingest.py"""
import importlib.util
import json
import math
from pathlib import Path
import tempfile
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


class SafetyTests(unittest.TestCase):
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
