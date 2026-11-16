"""Offline full-inventory refresh regressions; no live credentials or network."""
import copy
import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_openbesluitvorming_ingest import obv, FakeHttp, Encoder, RECORDS


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.http = FakeHttp()
        self.w = obv.Worker(self.tmp.name, self.http, Encoder())
        self.w.fresh('test', 'limburg_test')
        self.w.page(self.w.run_info('test'), 5)
        with self.w.db:
            self.w.db.execute("UPDATE documents SET status='indexed',has_vector=1")
            self.w.db.execute('UPDATE runs SET snapshot_complete=1')
        self.parent = RECORDS[0]['payload']['is_referenced_by']
        self.parent_record = {'entity_id': self.parent, 'entity_type': 'Meeting',
            'source_key': obv.SOURCE, 'op': 'upsert', 'payload': {'name': 'Original'}}
        body = json.dumps(self.parent_record).encode()
        with self.w.db:
            self.w.db.execute('INSERT INTO pages VALUES(?,?,?,?,?,?)',
                ('test', 2, RECORDS[-1]['entity_id'], None, body, '{}'))
            self.w.db.execute('UPDATE runs SET pages=2')

    def tearDown(self):
        self.w.db.close()
        self.tmp.cleanup()

    def start(self, retry=False):
        return self.w.refresh('test', approve=True, retry_size=retry)

    def inventory(self, records, more=False):
        records = sorted(records, key=lambda r: r['entity_id'])
        headers = {'X-Has-More': str(more).lower(), 'X-Changes-Cursor': '111358'}
        if more:
            headers['X-Next-Cursor'] = records[-1]['entity_id']
        self.http.snapshot = ('\n'.join(json.dumps(r) for r in records).encode(), headers)
        self.w.page(self.w.run_info('test'), 100)

    def test_unchanged_skips_downstream_and_keeps_status_and_history(self):
        self.start()
        self.http.calls.clear()
        self.inventory(RECORDS + [self.parent_record])
        self.w.execute('test', 5, 1)
        self.assertFalse(any('/entities/' in u or '/embeddings' in u or '/points?' in u for u, _, _ in self.http.calls))
        run = self.w.status('test')['runs'][0]
        self.assertEqual(run['audit']['Document'], {'unchanged': 5})
        self.assertEqual(run['retained_vectors'], 5)
        self.assertEqual(self.w.db.execute('SELECT count(*) FROM pages').fetchone()[0], 3)
        self.assertTrue(run['complete'])

    def test_metadata_only_change_queues_despite_same_content_hash(self):
        self.start()
        records = copy.deepcopy(RECORDS)
        records[0]['payload']['new_metadata'] = {'x': 42}
        self.inventory(records + [self.parent_record])
        job = dict(self.w.db.execute('SELECT * FROM documents WHERE entity_id=?', (records[0]['entity_id'],)).fetchone())
        self.assertEqual(job['status'], 'pending')
        self.assertEqual(job['has_vector'], 1)
        history = json.loads(self.w.db.execute('SELECT checkpoint FROM document_history').fetchone()[0])
        self.assertEqual(json.loads(history['record']), RECORDS[0])
        self.assertEqual(self.w.status('test')['runs'][0]['audit']['Document']['changed'], 1)

    def test_inventory_does_not_process_before_later_parent_page(self):
        self.start()
        self.inventory(RECORDS, more=True)
        self.http.calls.clear()
        self.assertEqual(self.w.run_info('test')['refresh_phase'], 'inventory')
        parent = copy.deepcopy(self.parent_record)
        parent['payload']['name'] = 'Changed parent'
        self.inventory([parent])
        self.assertEqual(self.w.status('test')['runs'][0]['audit']['Document']['parent_changed'],
            sum(r['payload'].get('is_referenced_by') == self.parent for r in RECORDS))

    def test_cache_invalidated_at_start(self):
        self.w.context(self.parent)
        self.w.flush_contexts()
        self.start()
        self.assertFalse(self.w.context_cache)
        self.assertFalse(self.w.context_dirty)
        self.assertEqual(self.w.db.execute('SELECT count(*) FROM contexts').fetchone()[0], 0)

    def test_requires_approval_and_active_generation_cannot_reset(self):
        with self.assertRaisesRegex(obv.IngestError, 'approve_full_run'):
            self.w.refresh('test')
        self.start()
        with self.assertRaisesRegex(obv.IngestError, 'already_active'):
            self.start()

    def test_fatal_page_preserves_generation_cursor_queue_and_raw_evidence(self):
        self.start()
        self.http.snapshot = (b'{broken}', {'X-Has-More': 'false', 'X-Changes-Cursor': '111358'})
        with self.assertRaises(obv.IngestError):
            self.w.execute('test', 5, 1)
        run = self.w.run_info('test')
        self.assertIsNone(run['cursor'])
        self.assertEqual(run['refresh_phase'], 'inventory')
        self.assertEqual(self.w.db.execute('SELECT count(*) FROM refresh_seen').fetchone()[0], 0)
        self.assertEqual(self.w.db.execute('SELECT raw FROM rejected_pages').fetchone()[0], b'{broken}')

    def test_duplicate_ids_reject_entire_page(self):
        self.start()
        with self.assertRaisesRegex(obv.IngestError, 'duplicate_entity'):
            self.inventory([RECORDS[0], RECORDS[0]])
        self.assertEqual(self.w.db.execute('SELECT count(*) FROM refresh_seen').fetchone()[0], 0)

    def test_missing_document_retained_not_deleted_and_not_false_success(self):
        self.start()
        self.inventory(RECORDS[1:] + [self.parent_record])
        run = self.w.status('test')['runs'][0]
        self.assertEqual(run['audit']['Document']['missing_retained'], 1)
        self.assertEqual(run['retained_vectors'], 5)
        self.assertFalse(run['complete'])

    def test_permanent_failures_not_blindly_requeued(self):
        with self.w.db:
            self.w.db.execute("UPDATE documents SET status='dead_letter',has_vector=0,evidence=? WHERE entity_id=?",
                ('[{"code":"http_422"}]', RECORDS[0]['entity_id']))
        self.start()
        self.inventory(RECORDS + [self.parent_record])
        self.assertEqual(self.w.status('test')['runs'][0]['audit']['Document']['failed_retained'], 1)
        self.assertFalse(self.w.status('test')['runs'][0]['complete'])

    def test_size_failure_retried_once_only_with_increased_budget(self):
        with self.w.db:
            self.w.db.execute("UPDATE documents SET status='dead_letter',has_vector=0,attempts=3,evidence=? WHERE entity_id=?",
                ('[{"code":"response_size_budget_exceeded"}]', RECORDS[0]['entity_id']))
        with self.assertRaisesRegex(obv.IngestError, 'increased_attachment_budget'):
            self.start(retry=True)
        self.w.max_bytes = 256 * 1024 * 1024
        self.start(retry=True)
        self.inventory(RECORDS + [self.parent_record])
        self.w.process = lambda *a: (_ for _ in ()).throw(obv.IngestError('http_422', 'tika'))
        result = self.w.execute('test', 1, 1)
        self.assertEqual(result['runs'][0]['counts']['dead_letter'], 1)
        self.assertEqual(self.w.db.execute('SELECT count(*) FROM document_history').fetchone()[0], 1)

    def test_new_document_any_category_is_queued(self):
        self.start()
        new = copy.deepcopy(RECORDS[0])
        new['entity_id'] = 'document:ibabs:provincie:provincie_limburg:ffffffff-ffff-ffff-ffff-ffffffffffff'
        new['payload']['classification'] = ['Not a motion']
        self.inventory(RECORDS + [new, self.parent_record])
        self.assertEqual(self.w.status('test')['runs'][0]['audit']['Document']['new'], 1)

    def test_vector_archive_precedes_mutation_and_survives_replay(self):
        self.start()
        records = copy.deepcopy(RECORDS)
        records[0]['schema_version'] = 'changed'
        self.inventory(records + [self.parent_record])
        job = dict(self.w.db.execute('SELECT * FROM documents WHERE entity_id=?', (records[0]['entity_id'],)).fetchone())
        original = self.http.json
        old = {'id': obv.point_id(job['entity_id']), 'payload': {'old': True}, 'vector': [1.0] + [0.0] * 3071}
        def http(url, method='GET', data=None, headers=None):
            if url.endswith('/points') and method == 'POST':
                return {'result': [old]}
            return original(url, method, data, headers)
        self.http.json = http
        self.w.process(self.w.run_info('test'), job)
        backup = next((Path(self.tmp.name) / 'vector-history').rglob('*.gz'))
        self.assertEqual(json.loads(gzip.decompress(backup.read_bytes())), old)
        old['payload'] = {'new': True}
        with self.w.db:
            self.w.db.execute("UPDATE documents SET status='processing' WHERE entity_id=?", (job['entity_id'],))
        self.w.execute('test', 1, 1)
        self.assertEqual(json.loads(gzip.decompress(backup.read_bytes()))['payload'], {'old': True})

    def test_delete_requires_completed_ack_no_false_success(self):
        record = {**RECORDS[0], 'op': 'delete'}
        original = self.http.json
        self.http.json = lambda url, *a: {'status': 'ok', 'result': {'status': 'acknowledged'}} if '/delete?' in url else original(url, *a)
        with self.assertRaisesRegex(obv.IngestError, 'delete_not_completed'):
            self.w.process(self.w.run_info('test'), {'record': json.dumps(record)})

    def test_bounded_inventory_resumes_after_worker_reopen(self):
        self.start()
        self.inventory(RECORDS, more=True)
        self.w.db.close()
        self.w = obv.Worker(self.tmp.name, self.http, Encoder())
        self.assertEqual(self.w.run_info('test')['cursor'], RECORDS[-1]['entity_id'])
        self.inventory([self.parent_record])
        self.assertEqual(self.w.status('test')['runs'][0]['audit']['Document'], {'unchanged': 5})

    def test_bounded_execute_inventory_queues_no_downstream_until_terminal_page(self):
        self.start()
        changed = copy.deepcopy(RECORDS)
        changed[0]['payload']['name'] = 'Metadata changed'
        self.http.snapshot = ('\n'.join(json.dumps(r) for r in changed).encode(),
            {'X-Has-More': 'true', 'X-Next-Cursor': changed[-1]['entity_id'], 'X-Changes-Cursor': '111358'})
        self.http.calls.clear()
        result = self.w.execute('test', 1, 1, page_size=100)
        self.assertEqual(result['session_pages'], 1)
        self.assertEqual(result['session_processed'], 0)
        self.assertEqual(result['runs'][0]['counts']['pending'], 1)
        self.assertFalse(any('/entities/' in u or '/embeddings' in u for u, _, _ in self.http.calls))

    def test_http_failure_durable_without_advancing_cursor(self):
        self.start()
        self.http.request = lambda *a, **k: (_ for _ in ()).throw(obv.IngestError('http_503', 'http'))
        with self.assertRaisesRegex(obv.IngestError, 'http_503'):
            self.w.execute('test', 1, 1)
        self.assertEqual(self.w.run_info('test')['last_error'], 'http_503')
        self.assertIsNone(self.w.run_info('test')['cursor'])

    def test_missing_old_vector_blocks_upsert(self):
        job = {'entity_id': RECORDS[0]['entity_id'], 'record': json.dumps(RECORDS[0]),
            'refresh_generation': 1, 'has_vector': 1}
        with self.assertRaisesRegex(obv.IngestError, 'cannot_archive_previous_vector'):
            self.w.process(self.w.run_info('test'), job)
        self.assertIsNone(self.http.payload)

    def test_acknowledged_delete_archives_old_vector(self):
        self.start()
        records = copy.deepcopy(RECORDS)
        records[0]['op'] = 'delete'
        self.inventory(records + [self.parent_record])
        original = self.http.json
        def http(url, method='GET', data=None, headers=None):
            if url.endswith('/points') and method == 'POST':
                return {'result': [{'id': obv.point_id(records[0]['entity_id']), 'vector': [1.0] + [0.0] * 3071, 'payload': {'old': True}}]}
            if '/delete?' in url:
                return {'status': 'ok', 'result': {'status': 'completed'}}
            return original(url, method, data, headers)
        self.http.json = http
        result = self.w.execute('test', 1, 1)
        self.assertEqual(result['runs'][0]['refresh_outcomes'], {'deleted': 1})
        self.assertEqual(result['runs'][0]['retained_vectors'], 4)
        self.assertEqual(len(list((Path(self.tmp.name) / 'vector-history').rglob('*.gz'))), 1)


if __name__ == '__main__':
    unittest.main()
