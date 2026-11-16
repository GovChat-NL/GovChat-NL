"""Synthetic offline transfer tests: never call Docker, source APIs or embeddings."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


transfer = load('obv_transfer', ROOT / 'scripts/openbesluitvorming-transfer.py')
worker = load('obv_transfer_fixture_worker', ROOT / 'services/openbesluitvorming-ingest/worker.py')


class ServerRunbookTests(unittest.TestCase):
    def test_documented_run_bounds_are_positive_and_approved(self):
        guide = (ROOT / 'docs/openbesluitvorming-transfer.md').read_text(encoding='utf-8')
        runs = [line for line in guide.splitlines() if '--max-documents' in line]
        self.assertTrue(runs)
        for line in runs:
            bounds = re.search(r'--max-documents (\d+) --max-pages (\d+)', line)
            self.assertIsNotNone(bounds)
            self.assertGreater(int(bounds.group(1)), 0)
            self.assertGreater(int(bounds.group(2)), 0)
            self.assertIn('--approve-full-run', line)


def archive(path, entries):
    with tarfile.open(path, 'w:gz') as tar:
        for name, body, kind in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.size = len(body) if kind == tarfile.REGTYPE else 0
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                member.linkname = '../escape'
            tar.addfile(member, io.BytesIO(body) if member.isfile() else None)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.state = self.root / 'source'
        self.state.mkdir()
        # Connect creates only an isolated synthetic schema, never a source worker.
        self.db = worker.connect(self.state)
        self.db.execute('INSERT INTO runs(id,collection,source,created_at,updated_at,model,snapshot_complete) VALUES(?,?,?,?,?,?,?)',
                        ('fixture', 'limburg_fixture', 'provincie_limburg', 'date', 'date', 'govchat-embedding', 1))
        self.record = {'entity_id': 'fixture-entity', 'entity_type': 'Document',
                       'source_key': 'provincie_limburg', 'op': 'upsert', 'payload': {'title': 'Synthetic'}}
        self.db.execute("INSERT INTO documents(run_id,entity_id,record,status,updated_at,has_vector) VALUES(?,?,?,'indexed','date',1)",
                        ('fixture', self.record['entity_id'], json.dumps(self.record)))
        self.db.commit()
        self.bundle = self.root / 'bundle'
        self.bundle.mkdir()
        self.make_bundle()
        self.target = self.root / 'target'
        self.target.mkdir()

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def make_bundle(self):
        self.db.commit()
        with contextlib.closing(sqlite3.connect(self.root / 'backup.sqlite')) as backup:
            self.db.backup(backup)
        self.manifest = transfer.sqlite_metadata(self.root / 'backup.sqlite', 'fixture')
        self.manifest.update({'format': 'govchat-obv-transfer-1',
            'git': {'commit': '0' * 40, 'date': 'date'},
            'embedding': {'alias': 'govchat-embedding', 'underlying_model': 'azure/text-embedding-3-large', 'dimensions': 3072},
            'qdrant': {'version': transfer.VERSION, 'count': 1,
                       'vectors': {'size': 3072, 'distance': 'Cosine'}, 'payload_schema': {},
                       'samples': [{'id': transfer.point_id(self.record['entity_id']), 'sha256': 'fixture'}]}})
        required = sorted(transfer.CODE_REQUIRED)
        archive(self.bundle / 'code.tar.gz', [(n, b'fixture', tarfile.REGTYPE) for n in required])
        archive(self.bundle / 'dataset.snapshot', [('snapshot-manifest.json', b'{}', tarfile.REGTYPE)])
        archive(self.bundle / 'ingest-state.tar.gz', [
            ('ingest.sqlite', (self.root / 'backup.sqlite').read_bytes(), tarfile.REGTYPE),
            ('worker.lock', b'archived-lock', tarfile.REGTYPE),
            ('vector-history/fixture/1/point.json.gz', b'previous-vector', tarfile.REGTYPE),
            ('history.lock', b'old', tarfile.REGTYPE)])
        (self.bundle / 'README.md').write_text('synthetic', encoding='utf-8')
        (self.bundle / 'server-guide.md').write_text('synthetic', encoding='utf-8')
        self.write_manifest()

    def write_manifest(self):
        self.manifest['artifacts'] = {n: transfer.digest(self.bundle / n) for n in transfer.ARTIFACTS}
        (self.bundle / 'manifest.json').write_text(json.dumps(self.manifest), encoding='utf-8')


class ArchiveTests(Fixture):
    def test_safe_nested_files(self):
        self.assertIn('vector-history/fixture/1/point.json.gz', transfer.check_archive(self.bundle / 'ingest-state.tar.gz', 'state'))

    def test_unsafe_paths(self):
        for name in ('../x', '/x', 'C:/x', 'dir\\x', 'dir/../x', 'CON', 'nul.txt', 'x.', 'x ', 'x\x00z', 'a*b', 'a?b', 'a|b'):
            with self.subTest(name=name), self.assertRaises(transfer.Refusal):
                transfer.safe_name(name)

    def test_all_members_checked_before_extraction(self):
        bad = self.root / 'bad.tar.gz'
        archive(bad, [('safe', b'file', tarfile.REGTYPE), ('../bad', b'file', tarfile.REGTYPE)])
        with self.assertRaises(transfer.Refusal):
            transfer.check_archive(bad, 'state', self.target)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_links_devices_fifo_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind):
                bad = self.root / 'bad.tar.gz'
                archive(bad, [('bad', b'', kind)])
                with self.assertRaises(transfer.Refusal):
                    transfer.check_archive(bad, 'state')

    def test_duplicate_casefold_and_normalized_paths(self):
        for names in (('file', 'FILE'), ('./file', 'file'), ('dir', 'dir/child')):
            with self.subTest(names=names):
                bad = self.root / 'bad.tar.gz'
                archive(bad, [(n, b'x', tarfile.REGTYPE) for n in names])
                with self.assertRaises(transfer.Refusal):
                    transfer.check_archive(bad, 'state')

    def test_secret_names(self):
        for name in ('.env', 'x/.env.production', 'root.env', 'secrets/key', 'private/x',
                     'api-token.txt', 'api_key.json', 'password.txt', 'id_rsa', 'cert.pem',
                     'docker-compose.local.yml', 'docker-compose.openbesluitvorming-local.yml', 'custom-branding/logo.png'):
            with self.subTest(name=name):
                self.assertTrue(transfer.private_name(name))

    def test_unrelated_and_sqlite_sidecars(self):
        for name in ('n8n/state', 'ingest.sqlite-wal', 'ingest.sqlite-shm'):
            with self.subTest(name=name):
                bad = self.root / 'bad.tar.gz'
                archive(bad, [(name, b'x', tarfile.REGTYPE)])
                with self.assertRaises(transfer.Refusal):
                    transfer.check_archive(bad, 'state')

    def test_nonempty_extraction_refused(self):
        (self.target / 'existing').write_text('keep')
        with self.assertRaises(transfer.Refusal):
            transfer.check_archive(self.bundle / 'ingest-state.tar.gz', 'state', self.target)

    def test_reviewed_code_extraction_into_empty_directory(self):
        names = transfer.check_archive(self.bundle / 'code.tar.gz', 'code', self.target)
        self.assertTrue(transfer.CODE_REQUIRED <= names)
        self.assertEqual((self.target / 'scripts/openbesluitvorming-transfer.py').read_bytes(), b'fixture')
        with self.assertRaisesRegex(transfer.Refusal, 'staging_directory_not_empty'):
            transfer.check_archive(self.bundle / 'code.tar.gz', 'code', self.target)


class ValidationTests(Fixture):
    def test_stopped_wal_database_read_creates_no_sidecars(self):
        path = self.root / 'stopped.sqlite'
        with contextlib.closing(sqlite3.connect(path)) as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE example(value TEXT)')
            db.execute("INSERT INTO example VALUES('preserved')")
            db.commit()
        before = {p.name for p in self.root.iterdir()}
        with contextlib.closing(transfer.readonly_db(path)) as db:
            self.assertEqual(db.execute('SELECT value FROM example').fetchone()[0], 'preserved')
        self.assertEqual({p.name for p in self.root.iterdir()}, before)

    def test_valid_bundle_actual_zero_user_version(self):
        manifest = transfer.validate_bundle(self.bundle)
        self.assertEqual(manifest['schema']['user_version'], 0)
        self.assertEqual(set(manifest['schema']['tables']), set(transfer.TABLES))
        self.assertEqual(manifest['schema']['sql_sha256'], transfer.sqlite_metadata(self.state / 'ingest.sqlite', 'fixture')['schema']['sql_sha256'])

    def test_every_payload_checksum_and_length(self):
        for name in transfer.ARTIFACTS:
            original = (self.bundle / name).read_bytes()
            with self.subTest(name=name):
                (self.bundle / name).write_bytes(original + b'tamper')
                with self.assertRaises(transfer.Refusal):
                    transfer.validate_bundle(self.bundle)
                (self.bundle / name).write_bytes(original)

    def test_missing_and_extra_artifacts(self):
        (self.bundle / 'extra').write_text('x')
        with self.assertRaises(transfer.Refusal):
            transfer.validate_bundle(self.bundle)
        (self.bundle / 'extra').unlink()
        (self.bundle / 'README.md').unlink()
        with self.assertRaises(transfer.Refusal):
            transfer.validate_bundle(self.bundle)

    def test_manifest_schema_and_run_count_tamper(self):
        for key in ('schema', 'run', 'table_counts', 'document_statuses', 'has_vector', 'complete', 'refresh_generations'):
            with self.subTest(key=key):
                original = self.manifest[key]
                self.manifest[key] = 'tampered'
                self.write_manifest()
                with self.assertRaises((transfer.Refusal, TypeError)):
                    transfer.validate_bundle(self.bundle)
                self.manifest[key] = original
        self.write_manifest()

    def test_snapshot_structure_even_with_valid_checksum(self):
        archive(self.bundle / 'dataset.snapshot', [('../escape', b'x', tarfile.REGTYPE)])
        self.write_manifest()
        with self.assertRaises(transfer.Refusal):
            transfer.validate_bundle(self.bundle)

    def test_sqlite_integrity(self):
        with self.assertRaises(sqlite3.DatabaseError):
            transfer.sqlite_metadata(self.bundle / 'README.md', 'fixture')

    def test_changed_schema(self):
        self.db.execute('ALTER TABLE documents ADD COLUMN unexpected TEXT')
        self.db.commit()
        with self.assertRaisesRegex(transfer.Refusal, 'sqlite_columns_mismatch'):
            transfer.sqlite_metadata(self.state / 'ingest.sqlite', 'fixture')

    def test_multiple_runs_preserved_with_selected_snapshot_scope(self):
        self.db.execute('INSERT INTO runs(id,collection,source,created_at,updated_at,model) VALUES(?,?,?,?,?,?)',
                        ('other', 'limburg_other', 'provincie_limburg', 'date', 'date', 'model'))
        self.db.commit()
        metadata = transfer.sqlite_metadata(self.state / 'ingest.sqlite', 'fixture')
        self.assertEqual([r['id'] for r in metadata['archived_runs']], ['fixture', 'other'])
        self.assertEqual(metadata['table_counts']['runs'], 2)
        self.assertEqual(metadata['selected_run_table_counts']['documents'], 1)
        self.assertIn('separate collection migration', metadata['snapshot_scope'])

    def test_unknown_run(self):
        with self.assertRaisesRegex(transfer.Refusal, 'unknown_obv_run'):
            transfer.sqlite_metadata(self.state / 'ingest.sqlite', 'other')

    def test_unsettled_queue_refused(self):
        self.db.execute("UPDATE documents SET status='retry'")
        self.db.commit()
        with self.assertRaises(transfer.Refusal):
            transfer.sqlite_metadata(self.state / 'ingest.sqlite', 'fixture')

    def test_deadletter_203_is_explicitly_incomplete(self):
        for i in range(203):
            self.db.execute("INSERT INTO documents(run_id,entity_id,record,status,updated_at) VALUES(?,?,?,'dead_letter','date')",
                            ('fixture', 'failed-' + str(i), '{}'))
        self.db.commit()
        metadata = transfer.sqlite_metadata(self.state / 'ingest.sqlite', 'fixture')
        self.assertFalse(metadata['complete'])
        self.assertEqual(metadata['document_statuses']['dead_letter'], 203)

    def test_refresh_missing_retained_incomplete(self):
        self.db.execute("UPDATE runs SET generation=1,refresh_phase='complete'")
        self.db.execute("INSERT INTO refresh_seen VALUES('fixture',1,'missing','Document','missing_retained')")
        self.db.commit()
        metadata = transfer.sqlite_metadata(self.state / 'ingest.sqlite', 'fixture')
        self.assertFalse(metadata['complete'])
        self.assertEqual(metadata['refresh_audit'][0]['count'], 1)

    def test_validate_cli_never_docker(self):
        with patch.object(transfer, 'command', side_effect=AssertionError('no Docker')):
            with contextlib.redirect_stdout(io.StringIO()):
                transfer.main(['validate', '--bundle', str(self.bundle)])


class FakeQdrant:
    def __init__(self, fixture, fail_stage=False, fail_final=False):
        self.fixture = fixture
        self.calls = []
        self.fail_stage = fail_stage
        self.fail_final = fail_final
        self.reserved = set()
        self.lock_inode = None

    def version(self):
        self.calls.append(('version',))
        return transfer.VERSION

    def absent(self, name):
        self.calls.append(('absent', name))
        transfer.require(name not in self.reserved, 'target_collection_exists')

    def reserve(self, name, vectors):
        self.calls.append(('reserve', name))
        transfer.require(name not in self.reserved, 'target_collection_exists')
        self.reserved.add(name)

    def upload(self, name, path):
        self.calls.append(('upload', name))
        if not self.lock_inode:
            self.lock_inode = (self.fixture.target / 'worker.lock').stat().st_ino
        self.fixture.assertFalse((self.fixture.target / 'ingest.sqlite').exists())

    def inspect(self, name, metadata):
        self.calls.append(('inspect', name))
        result = copy.deepcopy(self.fixture.manifest['qdrant'])
        if ((self.fail_stage and name.startswith('obv_transfer_stage_'))
                or (self.fail_final and name == 'limburg_fixture')):
            result['count'] = 2
        return result


class ImportTests(Fixture):
    def test_nonempty_volume_including_stale_lock(self):
        for name in ('worker.lock', 'existing.sqlite'):
            with self.subTest(name=name):
                p = self.target / name
                p.write_text('keep')
                q = FakeQdrant(self)
                with self.assertRaisesRegex(transfer.Refusal, 'not_empty'):
                    transfer.import_state(self.bundle, self.target, True, q)
                self.assertFalse(q.calls)
                p.unlink()

    def test_dry_run_no_state_or_snapshot_writes(self):
        q = FakeQdrant(self)
        transfer.import_state(self.bundle, self.target, True, q)
        self.assertEqual(list(self.target.iterdir()), [])
        self.assertFalse(any(c[0] in ('reserve', 'upload') for c in q.calls))

    @unittest.skipUnless(os.name == 'posix', 'Linux kernel lock/publication test')
    def test_stages_both_artifacts_and_preserves_live_lock_inode(self):
        q = FakeQdrant(self)
        with contextlib.redirect_stdout(io.StringIO()):
            transfer.import_state(self.bundle, self.target, False, q)
        self.assertEqual((self.target / 'worker.lock').stat().st_ino, q.lock_inode)
        self.assertNotEqual((self.target / 'worker.lock').read_bytes(), b'archived-lock')
        self.assertEqual((self.target / 'vector-history/fixture/1/point.json.gz').read_bytes(), b'previous-vector')
        self.assertEqual((self.target / 'history.lock').read_bytes(), b'old')
        uploads = [c[1] for c in q.calls if c[0] == 'upload']
        self.assertTrue(uploads[0].startswith('obv_transfer_stage_'))
        self.assertEqual(uploads[1], 'limburg_fixture')
        self.assertEqual(transfer.sqlite_metadata(self.target / 'ingest.sqlite', 'fixture')['has_vector'], 1)

    @unittest.skipUnless(os.name == 'posix', 'Linux kernel lock/publication test')
    def test_stage_failure_retains_diagnostics_without_final_publish(self):
        q = FakeQdrant(self, fail_stage=True)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(transfer.Refusal):
            transfer.import_state(self.bundle, self.target, False, q)
        self.assertNotIn(('upload', 'limburg_fixture'), q.calls)
        self.assertFalse((self.target / 'ingest.sqlite').exists())
        self.assertTrue(list(self.target.glob('.obv-transfer-stage-*/ingest.sqlite')))

    @unittest.skipUnless(os.name == 'posix', 'Linux kernel lock/publication test')
    def test_final_failure_retains_collection_and_staged_state(self):
        q = FakeQdrant(self, fail_final=True)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(transfer.Refusal):
            transfer.import_state(self.bundle, self.target, False, q)
        self.assertIn('limburg_fixture', q.reserved)
        self.assertFalse((self.target / 'ingest.sqlite').exists())
        self.assertTrue(list(self.target.glob('.obv-transfer-stage-*/ingest.sqlite')))

    def test_existing_collection_refused_before_restore(self):
        q = FakeQdrant(self)
        q.reserved.add('limburg_fixture')
        with self.assertRaises(transfer.Refusal):
            transfer.import_state(self.bundle, self.target, True, q)
        self.assertFalse(any(c[0] == 'upload' for c in q.calls))


class LockBackupTests(Fixture):
    @unittest.skipUnless(os.name == 'posix', 'Linux flock test; run in Linux Python helper too')
    def test_worker_kernel_lock_refused_and_inode_preserved(self):
        with worker.lock(self.state):
            inode = (self.state / 'worker.lock').stat().st_ino
            with self.assertRaisesRegex(transfer.Refusal, 'holds_lock'):
                with transfer.state_lock(self.state):
                    self.fail('lock must not be acquired')
            self.assertEqual((self.state / 'worker.lock').stat().st_ino, inode)
        with transfer.state_lock(self.state):
            pass

    @unittest.skipUnless(os.name == 'posix', 'Linux backup lock test')
    def test_wal_backup_history_and_lock_across_snapshot_and_archive(self):
        self.assertTrue((self.state / 'ingest.sqlite-wal').exists())
        history = self.state / 'vector-history/fixture/1'
        history.mkdir(parents=True)
        (history / 'point.json.gz').write_bytes(b'preserved')
        fixture = self

        class SnapshotQdrant:
            def inspect(self, collection, metadata):
                with fixture.assertRaises(transfer.Refusal):
                    with transfer.state_lock(fixture.state):
                        pass
                return fixture.manifest['qdrant']

            def snapshot(self, collection, path):
                with fixture.assertRaises(worker.IngestError):
                    with worker.lock(fixture.state):
                        pass
                archive(path, [('manifest.json', b'{}', tarfile.REGTYPE)])

        out = self.root / 'export'
        out.mkdir()
        original_check = transfer.check_archive

        def guarded_check(path, kind, destination=None):
            if kind == 'state':
                with fixture.assertRaises(worker.IngestError):
                    with worker.lock(fixture.state):
                        pass
            return original_check(path, kind, destination)

        with patch.object(transfer, 'check_archive', side_effect=guarded_check):
            result = transfer.backup_state(self.state, out, 'fixture', SnapshotQdrant())
        self.assertEqual(result['has_vector'], 1)
        names = transfer.check_archive(out / 'ingest-state.tar.gz', 'state', self.target)
        self.assertNotIn('ingest.sqlite-wal', names)
        self.assertNotIn('ingest.sqlite-shm', names)
        self.assertIn('worker.lock', names)
        self.assertEqual((self.target / 'vector-history/fixture/1/point.json.gz').read_bytes(), b'preserved')
        self.assertEqual(transfer.sqlite_metadata(self.target / 'ingest.sqlite', 'fixture')['has_vector'], 1)

    def test_state_secret_refused(self):
        (self.state / '.env').write_text('not-a-real-secret')
        with self.assertRaises(transfer.Refusal):
            transfer.state_files(self.state)

    @unittest.skipUnless(os.name == 'posix', 'Linux symlink test')
    def test_state_symlink_refused(self):
        (self.state / 'link').symlink_to(self.root)
        with self.assertRaises(transfer.Refusal):
            transfer.state_files(self.state)


class ExportMetadataTests(Fixture):
    def test_export_boundary_timestamp_and_dynamic_readme_without_environment(self):
        root = self.root.resolve()
        exports = root / 'exports'
        output = exports / 'fixture-export'
        docs = self.root / 'docs'
        docs.mkdir()
        (docs / 'openbesluitvorming-transfer.md').write_text('reviewed fixture guide')
        source = {'Id': 'stopped-source', 'State': {'Running': False, 'Status': 'exited',
                  'ExitCode': 0, 'FinishedAt': '2026-11-16T00:00:00Z', 'Error': 'DO_NOT_PRINT'},
                  'Config': {'Env': ['SECRET=DO_NOT_PRINT']},
                  'Mounts': [{'Destination': '/state', 'Type': 'volume', 'Name': 'source-volume'}]}
        git = {'commit': 'a' * 40, 'date': '2026-11-16T00:00:00+00:00'}

        def code(path):
            path.write_bytes((self.bundle / 'code.tar.gz').read_bytes())
            return git

        def command(args, cwd=None, helper=False):
            if args[:2] == ['git', 'check-ignore']:
                return str(output)
            self.assertTrue(helper)
            for name in ('ingest-state.tar.gz', 'dataset.snapshot'):
                (output / name).write_bytes((self.bundle / name).read_bytes())
            result = {k: v for k, v in self.manifest.items() if k not in
                      ('format', 'git', 'embedding', 'artifacts')}
            return json.dumps(result)

        args = type('Args', (), {'output': str(output), 'source_container': 'source',
            'qdrant_container': 'qdrant', 'helper_image': transfer.IMAGE, 'run_id': 'fixture'})()
        stdout = io.StringIO()
        with patch.object(transfer, 'ROOT', root), patch.object(transfer, 'committed_code', side_effect=code), \
             patch.object(transfer, 'command', side_effect=command), \
             patch.object(transfer, 'inspect_container', side_effect=[source, {'Id': 'qdrant-id', 'State': {'Running': True}}]), \
             contextlib.redirect_stdout(stdout):
            transfer.export_bundle(args)
        manifest = json.loads((output / 'manifest.json').read_text())
        self.assertEqual(manifest['source_boundary']['worker_state'],
                         {k: source['State'][k] for k in ('Running', 'Status', 'ExitCode', 'FinishedAt')})
        timestamp = transfer.datetime.datetime.fromisoformat(manifest['exported_at_utc'])
        self.assertEqual(timestamp.utcoffset(), transfer.datetime.timedelta(0))
        readme = (output / 'README.md').read_text()
        for text in (git['commit'], 'govchat-embedding', 'azure/text-embedding-3-large',
                     'Dimensions: 3072', 'Exact Qdrant points: 1', 'Checkpoint vectors: 1',
                     'Document statuses: {"indexed":1}'):
            self.assertIn(text, readme)
        self.assertNotIn('DO_NOT_PRINT', json.dumps(manifest) + readme + stdout.getvalue())


class HostTests(unittest.TestCase):
    def test_source_stopped_actual_named_volume(self):
        info = {'State': {'Running': False, 'Status': 'exited'},
                'Mounts': [{'Destination': '/state', 'Type': 'volume', 'Name': 'actual-volume'}]}
        self.assertEqual(transfer.source_volume(info), 'actual-volume')
        info['State']['Running'] = True
        with self.assertRaises(transfer.Refusal):
            transfer.source_volume(info)

    def test_source_bind_mount_refused(self):
        with self.assertRaises(transfer.Refusal):
            transfer.source_volume({'State': {'Running': False, 'Status': 'exited'},
                'Mounts': [{'Destination': '/state', 'Type': 'bind', 'Source': 'host'}]})

    def test_helper_no_secrets_uid_actual_volume_explicit_network(self):
        args = transfer.helper_args('explicit-id', 'actual-volume', ROOT / 'exports/x', False, transfer.IMAGE)
        self.assertIn('10001:10001', args)
        self.assertIn('container:explicit-id', args)
        self.assertIn('type=volume,src=actual-volume,dst=/state', args)
        self.assertFalse(any(x in ('--env', '-e', '--env-file', '--volumes-from') for x in args))
        self.assertTrue(any('dst=/scripts,readonly' in x for x in args))

    def test_compose_project_volume_and_base_service_resolution(self):
        args = type('Args', (), {'state_volume': None, 'compose_project': 'portable',
            'qdrant_container': None, 'compose_file': None})()
        calls = []

        def fake(cmd, cwd=None):
            calls.append(cmd)
            if cmd[:3] == ['docker', 'volume', 'inspect']:
                return '[{"Name":"portable_openbesluitvorming-ingest-state"}]'
            if cmd[:2] == ['docker', 'compose']:
                return 'compose-qdrant-id'
            if cmd[:2] == ['docker', 'ps']:
                return ''
            raise AssertionError(cmd)

        with patch.object(transfer, 'command', side_effect=fake), patch.object(transfer, 'inspect_container',
                return_value={'Id': 'actual-id', 'State': {'Running': True}}):
            self.assertEqual(transfer.resolve_target(args), ('actual-id', 'portable_openbesluitvorming-ingest-state'))
        self.assertIn(str(ROOT / 'docker-compose.yml'), calls[1])
        self.assertEqual(calls[1][-3:], ['ps', '-q', 'qdrant'])

    def test_dirty_tree_refused_before_archive(self):
        with patch.object(transfer, 'command', return_value=' M tracked') as cmd:
            with self.assertRaisesRegex(transfer.Refusal, 'dirty_tracked_tree'):
                transfer.committed_code(Path('unused'))
        self.assertEqual(cmd.call_count, 1)

    def test_transfer_files_must_be_committed(self):
        with patch.object(transfer, 'command', side_effect=['', 'committed', 'working']):
            with self.assertRaisesRegex(transfer.Refusal, 'commit_transfer'):
                transfer.committed_code(Path('unused'))

    def test_subprocess_failure_does_not_print_secret_stderr(self):
        result = subprocess.CompletedProcess([], 1, b'diagnostic_staging_collection=obv_transfer_stage_fixture\nSECRET=not-real',
            b'transfer_refused: safe_failure\nsecret-token=not-real')
        output = io.StringIO()
        with patch.object(transfer.subprocess, 'run', return_value=result), contextlib.redirect_stderr(output):
            with self.assertRaises(transfer.Refusal):
                transfer.command(['docker'], helper=True)
        self.assertIn('obv_transfer_stage_fixture', output.getvalue())
        self.assertNotIn('not-real', output.getvalue())

    def test_version_exact(self):
        q = transfer.Qdrant()
        for version in ('1.16.1', '1.17.0', None):
            with self.subTest(version=version), patch.object(q, 'request', return_value={'version': version}):
                with self.assertRaises(transfer.Refusal):
                    q.version()

    def test_native_snapshot_name_path_and_internal_stream(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'dataset.snapshot'
            q = transfer.Qdrant()
            with patch.object(q, 'request', return_value={'result': {'name': 'native-fixture.snapshot'}}) as request, \
                 patch.object(transfer.urllib.request, 'urlopen', return_value=io.BytesIO(b'native-fixture')) as stream:
                result = q.snapshot('limburg_fixture', output)
            self.assertEqual(output.read_bytes(), b'native-fixture')
            self.assertEqual(result['name'], 'native-fixture.snapshot')
            self.assertEqual(result['source_native_path'], '/qdrant/snapshots/limburg_fixture/native-fixture.snapshot')
            self.assertIn('default', result['source_native_path_basis'])
            self.assertEqual(request.call_args.args, ('/collections/limburg_fixture/snapshots?wait=true', 'POST'))
            self.assertEqual(stream.call_args.args[0],
                             'http://127.0.0.1:6333/collections/limburg_fixture/snapshots/native-fixture.snapshot')

    def test_streaming_multipart_bounded_reads_and_content_length(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = Path(tmp) / 'snapshot'
            snapshot.write_bytes(b'x' * (3 * 1024 * 1024 + 7))
            sent = []
            headers = {}

            class Connection:
                def __init__(self, *args, **kwargs):
                    pass
                def putrequest(self, *args):
                    self.args = args
                def putheader(self, name, value):
                    headers[name] = value
                def endheaders(self):
                    pass
                def send(self, body):
                    sent.append(len(body))
                def getresponse(self):
                    response = io.BytesIO(b'{"status":"ok"}')
                    response.status = 200
                    return response
                def close(self):
                    pass

            with patch.object(transfer.http.client, 'HTTPConnection', Connection):
                transfer.Qdrant().upload('limburg_fixture', snapshot)
            self.assertLessEqual(max(sent), 1024 * 1024)
            self.assertEqual(sum(sent), int(headers['Content-Length']))
            self.assertGreater(sum(sent), snapshot.stat().st_size)


if __name__ == '__main__':
    unittest.main()
