#!/usr/bin/env python3
"""Offline-verifiable OBV bundles; host CLI plus non-root Linux Docker helper.

No worker imports, environment forwarding, source scheduling, alias changes or
automatic rollback/deletion. See docs/openbesluitvorming-transfer.md.
"""
import argparse
import contextlib
import datetime
import hashlib
import http.client
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
VERSION = '1.16.2'
IMAGE = 'python:3.12-slim'
ARTIFACTS = {'code.tar.gz', 'dataset.snapshot', 'ingest-state.tar.gz',
             'README.md', 'server-guide.md'}
TABLES = {
    'runs': {'id', 'collection', 'source', 'cursor', 'changes_cursor', 'pages',
             'snapshot_complete', 'created_at', 'updated_at', 'last_error', 'model',
             'generation', 'refresh_phase'},
    'documents': {'run_id', 'entity_id', 'record', 'status', 'attempts', 'next_attempt',
                  'error', 'evidence', 'updated_at', 'has_vector', 'refresh_generation'},
    'pages': {'run_id', 'page', 'cursor', 'next_cursor', 'raw', 'headers'},
    'rejected_pages': {'id', 'run_id', 'cursor', 'raw', 'headers', 'error', 'created_at'},
    'contexts': {'entity_id', 'detail', 'fetched_at'},
    'refresh_generations': {'run_id', 'generation', 'baseline', 'started_at', 'retry_size'},
    'source_entities': {'run_id', 'entity_id', 'entity_type', 'record'},
    'refresh_seen': {'run_id', 'generation', 'entity_id', 'entity_type', 'disposition'},
    'document_history': {'run_id', 'generation', 'entity_id', 'checkpoint'},
}
RUN_FIELDS = ('id', 'collection', 'source', 'model', 'pages', 'snapshot_complete',
              'generation', 'refresh_phase', 'created_at', 'updated_at')
CODE_REQUIRED = {'scripts/openbesluitvorming-transfer.py',
                 'scripts/openbesluitvorming-transfer-smoke.py',
                 'scripts/openbesluitvorming-progress.js',
                 'tests/agents/test_openbesluitvorming_transfer.py',
                 'tests/agents/openbesluitvorming-transfer-monitor.test.js',
                 'docs/openbesluitvorming-transfer.md',
                 'services/openbesluitvorming-ingest/worker.py', 'docker-compose.yml'}
INTEGER_COLUMNS = {
    'runs': {'pages', 'snapshot_complete', 'generation'},
    'documents': {'attempts', 'has_vector', 'refresh_generation'},
    'pages': {'page'}, 'rejected_pages': {'id'},
    'refresh_generations': {'generation', 'retry_size'},
    'refresh_seen': {'generation'}, 'document_history': {'generation'},
}


class Refusal(Exception):
    """Only fixed, credential-free diagnostics are emitted to the terminal."""


def require(condition, code):
    if not condition:
        raise Refusal(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(path):
    h = hashlib.sha256()
    size = 0
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
            size += len(chunk)
    return {'sha256': h.hexdigest(), 'bytes': size}


def private_name(name):
    parts = PurePosixPath(name).parts
    for part in parts:
        low = part.lower()
        if (low.startswith('.env') or low in {'private', 'secrets', 'credentials',
                'root.env', 'id_rsa', 'id_ed25519', 'custom-branding'}
                or low.endswith(('.pem', '.key', '.pfx', '.p12', '.local.yml',
                                 '-local.yml', '.local.yaml', '-local.yaml'))
                or re.search(r'(^|[-_.])(secret|credential|token|password|api[-_.]?key)(s)?([-_.]|$)', low)):
            return True
    return name.startswith(('overlay/data/', 'exports/', 'testdata/openbesluitvorming/'))


def safe_name(name):
    require(isinstance(name, str) and name and not any(c in name for c in '\\:*?<>|"')
            and not any(ord(c) < 32 for c in name), 'unsafe_archive_path')
    p = PurePosixPath(name)
    require(not p.is_absolute() and '..' not in p.parts, 'unsafe_archive_path')
    # Avoid Windows device names, ADS, case folding and trailing-dot aliases.
    for part in p.parts:
        require(part.rstrip(' .') == part and not re.fullmatch(
            r'(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?', part), 'unsafe_archive_path')
    return p.as_posix()


def archive_members(archive, kind):
    """Validate ALL members before extracting anything; never trust tar filters."""
    seen = set()
    members = []
    for member in archive:
        name = safe_name(member.name)
        if name == '.' and member.isdir():
            continue
        require(name != '.' and (member.isfile() or member.isdir()), 'archive_link_or_device')
        folded = name.casefold()
        require(folded not in seen, 'duplicate_archive_path')
        seen.add(folded)
        require(not private_name(name), 'private_archive_path')
        if kind == 'state':
            require(not any('n8n' in x.lower() for x in PurePosixPath(name).parts),
                    'unrelated_state_path')
            require(name not in {'ingest.sqlite-wal', 'ingest.sqlite-shm'}, 'sqlite_sidecar_in_archive')
        require(member.size >= 0, 'invalid_archive_size')
        members.append((member, name))
    require(any(m.isfile() for m, _ in members), 'empty_archive')
    # A regular file cannot be an ancestor of another entry, regardless of order.
    files = {n.casefold() for m, n in members if m.isfile()}
    for _, name in members:
        require(not any(p.as_posix().casefold() in files
                        for p in PurePosixPath(name).parents if str(p) != '.'),
                'archive_file_parent')
    return members


def check_archive(path, kind, destination=None):
    with tarfile.open(path, 'r:*') as archive:
        members = archive_members(archive, kind)
        if destination is not None:
            destination = Path(destination)
            require(not any(destination.iterdir()), 'staging_directory_not_empty')
            # Manual regular-file copy: ignore ownership, modes and all tar metadata.
            for member, name in members:
                target = destination.joinpath(*PurePosixPath(name).parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.extractfile(member) as src, open(target, 'xb') as dst:
                        shutil.copyfileobj(src, dst, 1024 * 1024)
                    require(target.stat().st_size == member.size, 'short_archive_member')
        return {n for m, n in members if m.isfile()}


def readonly_db(path):
    require(path.is_file() and not path.is_symlink(), 'missing_regular_sqlite')
    # A stopped WAL-mode database without committed WAL frames is immutable
    # while the exporter holds worker.lock. Avoid SQLite creating empty WAL/SHM
    # sidecars merely to read that checkpoint. Populated WAL must still be read
    # normally so connection.backup includes every committed frame.
    wal = path.with_name(path.name + '-wal')
    immutable = not wal.exists() or wal.stat().st_size == 0
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro' + ('&immutable=1' if immutable else ''), uri=True)
    db.row_factory = sqlite3.Row
    return db


def sqlite_metadata(path, run_id):
    with contextlib.closing(readonly_db(path)) as db:
        require([r[0] for r in db.execute('PRAGMA integrity_check')] == ['ok'], 'sqlite_integrity')
        require(not db.execute('PRAGMA foreign_key_check').fetchall(), 'sqlite_foreign_keys')
        rows = [dict(r) for r in db.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")]
        actual = {r['name'] for r in rows if r['type'] == 'table'}
        require(actual == set(TABLES), 'sqlite_tables_mismatch')
        columns = {}
        for table, expected in TABLES.items():
            columns[table] = [dict(r) for r in db.execute(f'PRAGMA table_info("{table}")')]
            require({r['name'] for r in columns[table]} == expected, 'sqlite_columns_mismatch')
            for column in columns[table]:
                name = column['name']
                expected_type = ('INTEGER' if name in INTEGER_COLUMNS.get(table, set()) else
                                 'BLOB' if table in ('pages', 'rejected_pages') and name == 'raw' else
                                 'REAL' if table == 'documents' and name == 'next_attempt' else 'TEXT')
                require(column['type'].upper() == expected_type, 'sqlite_column_type_mismatch')
        # Preserve the entire shared checkpoint database; only the selected
        # collection's vectors are bundled. Other runs remain historical state.
        archived_runs = [{k: r[k] for k in RUN_FIELDS} for r in db.execute('SELECT * FROM runs ORDER BY id')]
        require(all(r['source'] == 'provincie_limburg' for r in archived_runs), 'unrelated_checkpoint_source')
        run = db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
        require(run is not None and run['source'] == 'provincie_limburg', 'unknown_obv_run')
        require(re.fullmatch(r'limburg_[a-zA-Z0-9_-]{1,100}', run['collection']), 'invalid_collection')
        counts = {table: db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
                  for table in TABLES}
        for table in TABLES.keys() - {'runs', 'contexts'}:
            require(not db.execute(f'SELECT 1 FROM "{table}" WHERE run_id NOT IN (SELECT id FROM runs) LIMIT 1').fetchone(),
                    'orphan_checkpoint_run')
        selected_counts = {table: db.execute(f'SELECT count(*) FROM "{table}" WHERE run_id=?', (run_id,)).fetchone()[0]
                           for table in TABLES.keys() - {'runs', 'contexts'}}
        statuses = dict(db.execute('SELECT status,count(*) FROM documents WHERE run_id=? GROUP BY status', (run_id,)))
        require(set(statuses) <= {'pending', 'processing', 'retry', 'dead_letter', 'indexed', 'deleted'},
                'unknown_document_status')
        vectors = db.execute('SELECT count(*) FROM documents WHERE run_id=? AND has_vector=1', (run_id,)).fetchone()[0]
        require(vectors == statuses.get('indexed', 0), 'unsettled_vector_checkpoint')
        require(not any(statuses.get(s, 0) for s in ('pending', 'processing', 'retry')),
                'unsettled_checkpoint_queue')
        entities = [r[0] for r in db.execute(
            "SELECT entity_id FROM documents WHERE run_id=? AND has_vector=1 ORDER BY entity_id LIMIT 10", (run_id,))]
        records = {r['entity_id']: hashlib.sha256(canonical(json.loads(r['record'])).encode()).hexdigest()
                   for r in db.execute("SELECT entity_id,record FROM documents WHERE run_id=? AND has_vector=1 ORDER BY entity_id LIMIT 10", (run_id,))}
        audit = [dict(r) for r in db.execute(
            'SELECT generation,entity_type,disposition,count(*) AS count FROM refresh_seen WHERE run_id=? GROUP BY generation,entity_type,disposition ORDER BY generation,entity_type,disposition', (run_id,))]
        generations = [dict(r) for r in db.execute(
            'SELECT generation,started_at,retry_size FROM refresh_generations WHERE run_id=? ORDER BY generation', (run_id,))]
        return {'schema': {'user_version': db.execute('PRAGMA user_version').fetchone()[0],
                           'sql_sha256': hashlib.sha256(canonical(rows).encode()).hexdigest(),
                           'objects': rows, 'tables': columns},
                'run': {k: run[k] for k in RUN_FIELDS}, 'table_counts': counts,
                'archived_runs': archived_runs, 'selected_run_table_counts': selected_counts,
                'snapshot_scope': 'selected collection only; other archived runs require separate collection migration before use',
                'document_statuses': statuses, 'has_vector': vectors,
                'checkpoint_sample_entities': entities,
                'checkpoint_sample_records': records, 'refresh_audit': audit,
                'refresh_generations': generations,
                'complete': bool(run['snapshot_complete'] and run['refresh_phase'] in ('none', 'complete')
                                 and not statuses.get('dead_letter', 0)
                                 and not any(r['disposition'] == 'missing_retained'
                                             and r['entity_type'] == 'Document'
                                             and r['generation'] == run['generation'] for r in audit))}


def point_id(entity):
    h = hashlib.sha256(entity.encode()).hexdigest()[:32]
    return f'{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}'


class Qdrant:
    """Only loopback in the explicitly selected Qdrant container's namespace."""
    base = 'http://127.0.0.1:6333'

    def request(self, path, method='GET', data=None, missing_ok=False):
        body = None if data is None else canonical(data).encode()
        request = urllib.request.Request(self.base + path, body,
                    {'Content-Type': 'application/json'}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=3600) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            if missing_ok and code == 404:
                return None
            raise Refusal('qdrant_http_failure') from None

    def version(self):
        version = self.request('/').get('version')
        require(version == VERSION, 'qdrant_requires_exact_1_16_2')
        return version

    @staticmethod
    def collection(name):
        return '/collections/' + urllib.parse.quote(name, safe='')

    def absent(self, name):
        require(self.request(self.collection(name), missing_ok=True) is None, 'target_collection_exists')

    def reserve(self, name, vectors):
        # Atomic Qdrant create refuses an existing name; only then may our
        # snapshot replace this utility's own empty reservation. Never use an
        # overwrite/recreate endpoint or delete an operator collection.
        require(self.request(self.collection(name), 'PUT', {'vectors': vectors}).get('status') == 'ok',
                'target_collection_reservation_failed')

    def inspect(self, collection, metadata):
        path = self.collection(collection)
        info = self.request(path)['result']
        vectors = info['config']['params']['vectors']
        require(vectors.get('size') == 3072 and vectors.get('distance') == 'Cosine', 'qdrant_vector_schema')
        count = self.request(path + '/points/count', 'POST', {'exact': True})['result']['count']
        require(count == metadata['has_vector'] == metadata['document_statuses'].get('indexed', 0),
                'qdrant_checkpoint_count')
        ids = [point_id(e) for e in metadata['checkpoint_sample_entities']]
        points = self.request(path + '/points', 'POST',
            {'ids': ids, 'with_payload': True, 'with_vector': True})['result'] if ids else []
        by_id = {str(p['id']): p for p in points}
        require(len(by_id) == len(ids), 'qdrant_checkpoint_samples_missing')
        samples = []
        for entity, pid in zip(metadata['checkpoint_sample_entities'], ids):
            point = by_id.get(pid, {})
            payload = point.get('payload', {})
            require(payload.get('source_id') == entity
                    and payload.get('ingest_run_id') == metadata['run']['id']
                    and payload.get('source_key') == metadata['run']['source']
                    and len(point.get('vector', [])) == 3072, 'qdrant_checkpoint_sample_mismatch')
            require(hashlib.sha256(canonical(payload.get('source_record')).encode()).hexdigest()
                    == metadata['checkpoint_sample_records'][entity], 'qdrant_checkpoint_record_mismatch')
            vector = point['vector']
            require(all(type(x) in (int, float) and math.isfinite(x) for x in vector)
                    and abs(sum(x * x for x in vector) - 1) <= 0.001,
                    'qdrant_checkpoint_vector_invalid')
            samples.append({'id': pid, 'sha256': hashlib.sha256(canonical(point).encode()).hexdigest()})
        return {'version': VERSION, 'count': count, 'vectors': vectors,
                'payload_schema': info.get('payload_schema', {}), 'samples': samples}

    def snapshot(self, collection, output):
        path = self.collection(collection) + '/snapshots'
        name = self.request(path + '?wait=true', 'POST')['result']['name']
        require(safe_name(name) == name and '/' not in name, 'unsafe_snapshot_name')
        with urllib.request.urlopen(self.base + path + '/' + urllib.parse.quote(name, safe=''),
                                    timeout=3600) as src, open(output, 'xb') as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        # Source native snapshots are deliberately NOT deleted.
        return {'name': name, 'source_native_path': f'/qdrant/snapshots/{collection}/{name}',
                'source_native_path_basis': 'stock Qdrant image default; confirm storage.snapshots_path if customized',
                'transport': 'internal loopback HTTP streamed download; no docker cp'}

    def upload(self, collection, snapshot):
        """Known Content-Length multipart upload, bounded 1 MiB memory."""
        boundary = 'obv-' + uuid.uuid4().hex
        prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="snapshot"; '
                  'filename="dataset.snapshot"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
        suffix = f'\r\n--{boundary}--\r\n'.encode()
        conn = http.client.HTTPConnection('127.0.0.1', 6333, timeout=3600)
        try:
            conn.putrequest('POST', self.collection(collection) + '/snapshots/upload?priority=snapshot&wait=true')
            conn.putheader('Content-Type', 'multipart/form-data; boundary=' + boundary)
            conn.putheader('Content-Length', str(len(prefix) + snapshot.stat().st_size + len(suffix)))
            conn.endheaders()
            conn.send(prefix)
            with open(snapshot, 'rb') as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b''):
                    conn.send(chunk)
            conn.send(suffix)
            response = conn.getresponse()
            require(response.status == 200, 'qdrant_snapshot_upload_failed')
            require(json.load(response).get('status') == 'ok', 'qdrant_snapshot_upload_not_ok')
        finally:
            conn.close()


@contextlib.contextmanager
def state_lock(state):
    require(os.name == 'posix', 'lock_requires_linux_helper')
    import fcntl
    path = state / 'worker.lock'
    require(not path.is_symlink(), 'unsafe_lock_symlink')
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), 'unsafe_lock_type')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise Refusal('another_ingestion_command_holds_lock') from None
        yield
    finally:
        os.close(fd)


def state_files(state):
    files = []
    for root, dirs, names in os.walk(state, followlinks=False):
        for name in dirs + names:
            path = Path(root) / name
            rel = path.relative_to(state).as_posix()
            safe_name(rel)
            require(not private_name(rel), 'private_state_path')
            require('n8n' not in rel.lower(), 'unrelated_state_path')
            mode = path.lstat().st_mode
            require(stat.S_ISREG(mode) or stat.S_ISDIR(mode), 'state_link_or_device')
            if stat.S_ISREG(mode) and rel not in {'ingest.sqlite', 'ingest.sqlite-wal', 'ingest.sqlite-shm', 'metadata-catalog.sqlite', 'metadata-catalog.sqlite-wal', 'metadata-catalog.sqlite-shm'} and not rel.startswith('metadata-catalog.building.sqlite'):
                files.append((path, rel))
    return sorted(files, key=lambda p: p[1])


def backup_state(state, output, run_id, qdrant):
    with state_lock(state):
        files = state_files(state)
        # Disk-backed output staging, not the helper's small /tmp tmpfs.
        with tempfile.TemporaryDirectory(prefix='.obv-backup-', dir=output) as tmp:
            backup = Path(tmp) / 'ingest.sqlite'
            with contextlib.closing(readonly_db(state / 'ingest.sqlite')) as src:
                with contextlib.closing(sqlite3.connect(backup)) as dst:
                    src.backup(dst)
            catalog_backup = None
            if (state / 'metadata-catalog.sqlite').is_file():
                catalog_backup = Path(tmp) / 'metadata-catalog.sqlite'
                with contextlib.closing(readonly_db(state / 'metadata-catalog.sqlite')) as src:
                    with contextlib.closing(sqlite3.connect(catalog_backup)) as dst:
                        src.backup(dst)
            metadata = sqlite_metadata(backup, run_id)
            metadata['qdrant'] = qdrant.inspect(metadata['run']['collection'], metadata)
            native = qdrant.snapshot(metadata['run']['collection'], output / 'dataset.snapshot')
            if native is not None:
                metadata['native_snapshot'] = native
            check_archive(output / 'dataset.snapshot', 'snapshot')
            # Check again while still holding the worker lock. Out-of-protocol
            # external writers must also be administratively stopped.
            require(qdrant.inspect(metadata['run']['collection'], metadata) == metadata['qdrant'],
                    'qdrant_changed_during_export')
            with tarfile.open(output / 'ingest-state.tar.gz', 'w:gz') as archive:
                archive.add(backup, arcname='ingest.sqlite', recursive=False)
                if catalog_backup is not None:
                    archive.add(catalog_backup, arcname='metadata-catalog.sqlite', recursive=False)
                for path, rel in files:
                    archive.add(path, arcname=rel, recursive=False)
            check_archive(output / 'ingest-state.tar.gz', 'state')
            return metadata


def validate_bundle(bundle, staging=None, verify_sqlite=True):
    bundle = Path(bundle)
    require(bundle.is_dir() and not bundle.is_symlink(), 'invalid_bundle_directory')
    require({p.name for p in bundle.iterdir()} == ARTIFACTS | {'manifest.json'}, 'bundle_artifact_set')
    for p in bundle.iterdir():
        require(p.is_file() and not p.is_symlink(), 'bundle_nonregular_artifact')
    require((bundle / 'manifest.json').stat().st_size <= 4 * 1024 * 1024, 'manifest_too_large')
    manifest = json.loads((bundle / 'manifest.json').read_text(encoding='utf-8'))
    require(manifest.get('format') == 'govchat-obv-transfer-1'
            and set(manifest.get('artifacts', {})) == ARTIFACTS, 'manifest_format')
    for name in ARTIFACTS:
        require(digest(bundle / name) == manifest['artifacts'][name], 'artifact_checksum_or_length')
    require(manifest['qdrant']['version'] == VERSION, 'bundle_qdrant_version')
    require(manifest['embedding']['underlying_model'] == 'azure/text-embedding-3-large'
            and manifest['embedding']['dimensions'] == 3072, 'bundle_embedding_mapping')
    code_names = check_archive(bundle / 'code.tar.gz', 'code')
    require(CODE_REQUIRED <= code_names,
            'bundle_code_missing_transfer_files')
    check_archive(bundle / 'dataset.snapshot', 'snapshot')
    if not verify_sqlite:
        require('ingest.sqlite' in check_archive(bundle / 'ingest-state.tar.gz', 'state'),
                'missing_state_database')
        return manifest
    if staging is None:
        with tempfile.TemporaryDirectory() as tmp:
            return validate_state(bundle, manifest, Path(tmp))
    return validate_state(bundle, manifest, Path(staging))


def validate_state(bundle, manifest, staging):
    names = check_archive(bundle / 'ingest-state.tar.gz', 'state', staging)
    require('ingest.sqlite' in names, 'missing_state_database')
    actual = sqlite_metadata(staging / 'ingest.sqlite', manifest['run']['id'])
    for key, value in actual.items():
        require(manifest.get(key) == value, 'sqlite_manifest_mismatch')
    require(manifest['qdrant']['count'] == actual['has_vector']
            and manifest['qdrant']['vectors'].get('size') == 3072
            and manifest['qdrant']['vectors'].get('distance') == 'Cosine', 'manifest_vector_counts')
    require(manifest['embedding']['alias'] == actual['run']['model'], 'manifest_embedding_alias')
    return manifest


def import_state(bundle, state, dry_run, qdrant):
    # Strict emptiness includes a stale worker.lock. Create the lock only AFTER
    # this check; never replace its inode during publication.
    require(state.is_dir() and not any(state.iterdir()), 'target_state_volume_not_empty')
    if dry_run:
        # Host has already performed full disk-backed SQLite validation. Recheck
        # hashes/archives here without writing target state or huge tmpfs files.
        manifest = validate_bundle(bundle, verify_sqlite=False)
        qdrant.version()
        qdrant.absent(manifest['run']['collection'])
        require(not any(state.iterdir()), 'target_state_changed')
        return 'dry_run_validated_no_target_writes_no_snapshot_restore'
    with state_lock(state):
        staged = state / ('.obv-transfer-stage-' + uuid.uuid4().hex)
        staged.mkdir()
        print('diagnostic_state_staging=' + staged.name, flush=True)
        try:
            manifest = validate_bundle(bundle, staged)
            qdrant.version()
            collection = manifest['run']['collection']
            qdrant.absent(collection)
            staging_collection = 'obv_transfer_stage_' + uuid.uuid4().hex
            # Print ONLY identifiers needed for manual recovery; never response bodies.
            print('diagnostic_staging_collection=' + staging_collection, flush=True)
            qdrant.absent(staging_collection)
            qdrant.reserve(staging_collection, manifest['qdrant']['vectors'])
            qdrant.upload(staging_collection, bundle / 'dataset.snapshot')
            require(qdrant.inspect(staging_collection, manifest) == manifest['qdrant'],
                    'restored_staging_snapshot_mismatch_retained')
            require({p.name for p in state.iterdir()} == {'worker.lock', staged.name}, 'target_state_changed')
            qdrant.absent(collection)
            print('diagnostic_final_collection=' + collection, flush=True)
            qdrant.reserve(collection, manifest['qdrant']['vectors'])
            qdrant.upload(collection, bundle / 'dataset.snapshot')
            require(qdrant.inspect(collection, manifest) == manifest['qdrant'],
                    'restored_final_snapshot_mismatch_retained')
            # The helper's live lock is preserved. Other archived lockfiles/history
            # are ordinary checkpoint artifacts. No automatic rollback after this.
            for entry in staged.iterdir():
                if entry.name == 'worker.lock':
                    continue
                target = state / entry.name
                require(not target.exists(), 'publication_path_exists_retained')
                entry.rename(target)
            restored = sqlite_metadata(state / 'ingest.sqlite', manifest['run']['id'])
            require(all(manifest[k] == v for k, v in restored.items()), 'published_state_mismatch_retained')
            if (staged / 'worker.lock').exists():
                (staged / 'worker.lock').unlink()  # Never the live target inode.
            staged.rmdir()
            return 'import_verified_staging_collection_retained_no_alias_changed'
        except Exception:
            # Leave disk-backed staged state and any restored collections intact.
            raise


def command(args, cwd=None, output=None, helper=False):
    # Docker inspect/config can contain secrets. Never relay stdout/stderr on error.
    if output is None:
        result = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    else:
        result = subprocess.run(args, cwd=cwd, stdout=output, stderr=subprocess.PIPE)
    if result.returncode != 0 and helper:
        # Relay ONLY our controlled diagnostics, not arbitrary Docker output.
        for line in result.stdout.decode('utf-8', errors='replace').splitlines():
            if re.fullmatch(r'diagnostic_(staging_collection|final_collection|state_staging)=[a-zA-Z0-9_.-]{1,160}', line):
                print(line, file=sys.stderr)
        for line in result.stderr.decode('utf-8', errors='replace').splitlines():
            if re.fullmatch(r'transfer_refused: [a-z0-9_]+', line):
                print(line, file=sys.stderr)
    require(result.returncode == 0, 'helper_failed_retained_state_and_collections' if helper else 'external_command_failed')
    return result.stdout.decode('utf-8').strip() if output is None else None


def inspect_container(container):
    result = json.loads(command(['docker', 'inspect', container]))
    require(len(result) == 1, 'ambiguous_container')
    return result[0]


def source_volume(info):
    require(not info['State']['Running'] and info['State'].get('Status') in ('exited', 'created'),
            'source_worker_must_be_stopped')
    mounts = [m for m in info['Mounts'] if m['Destination'] == '/state']
    require(len(mounts) == 1 and mounts[0]['Type'] == 'volume' and mounts[0].get('Name'),
            'source_requires_named_state_volume')
    return mounts[0]['Name']


def helper_args(qdrant, volume, bundle, writable, image):
    return ['docker', 'run', '--rm', '--user', '10001:10001', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--network', 'container:' + qdrant, '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777',
            '--mount', f'type=volume,src={volume},dst=/state',
            '--mount', f'type=bind,src={ROOT / "scripts"},dst=/scripts,readonly',
            '--mount', f'type=bind,src={bundle.resolve()},dst=/output' + ('' if writable else ',readonly'),
            image, 'python', '-B', '/scripts/openbesluitvorming-transfer.py']


def committed_code(output):
    require(not command(['git', 'status', '--porcelain', '--untracked-files=no'], ROOT), 'dirty_tracked_tree')
    for name in sorted(CODE_REQUIRED):
        committed = command(['git', 'rev-parse', 'HEAD:' + name], ROOT)
        current = command(['git', 'hash-object', name], ROOT)
        require(committed == current, 'commit_transfer_utility_and_guide_before_export')
    tracked = command(['git', 'ls-tree', '-r', '--name-only', '-z', 'HEAD'], ROOT).split('\0')
    # git archive reads exactly HEAD, not a filesystem copy or working-tree tar.
    excludes = [':(exclude,literal)' + n for n in tracked if n and private_name(n)]
    command(['git', 'archive', '--format=tar.gz', '--output=' + str(output), 'HEAD', '--', '.', *excludes], ROOT)
    check_archive(output, 'code')
    return {'commit': command(['git', 'rev-parse', 'HEAD'], ROOT),
            'date': command(['git', 'show', '-s', '--format=%cI', 'HEAD'], ROOT)}


def export_bundle(args):
    output = Path(args.output).resolve()
    exports = ROOT / 'exports'
    require(output != exports and exports in output.parents, 'output_must_be_under_ignored_exports')
    require(command(['git', 'check-ignore', str(output)], ROOT), 'exports_must_be_gitignored')
    require(not output.is_symlink() and (not output.exists()
            or (output.is_dir() and not any(output.iterdir()))), 'output_must_be_new_or_empty')
    # Dirty/committed-file checks happen before any Docker operation or snapshot.
    with tempfile.TemporaryDirectory() as tmp:
        code = Path(tmp) / 'code.tar.gz'
        git = committed_code(code)
        source = inspect_container(args.source_container)
        volume = source_volume(source)
        qi = inspect_container(args.qdrant_container)
        require(qi['State']['Running'], 'qdrant_must_be_running')
        output.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(code, output / 'code.tar.gz')
        result = command(helper_args(qi['Id'], volume, output, True, args.helper_image)
            + ['_export', '--run-id', args.run_id], helper=True)
        metadata = json.loads(result)
    metadata.update({'format': 'govchat-obv-transfer-1', 'git': git,
        'exported_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'embedding': {'alias': metadata['run']['model'],
                      'underlying_model': 'azure/text-embedding-3-large', 'dimensions': 3072,
                      'mapping': 'operator-declared; LiteLLM alias is not an immutable model identity'},
        'source_boundary': {'worker_container_id': source['Id'],
                            'worker_state': {key: source['State'].get(key) for key in
                                             ('Running', 'Status', 'ExitCode', 'FinishedAt')},
                            'state_volume': volume, 'qdrant_container_id': qi['Id'],
                            'protocol': 'stopped worker + global worker.lock; external writers must be stopped'}})
    shutil.copyfile(ROOT / 'docs/openbesluitvorming-transfer.md', output / 'server-guide.md')
    (output / 'README.md').write_text(
        '# GovChat OBV transfer bundle\n\nRead server-guide.md before deployment.\n'
        'Validate all artifacts before import. No credentials are bundled.\n'
        f'Run: {metadata["run"]["id"]}\nCollection: {metadata["run"]["collection"]}\n'
        f'Complete: {str(metadata["complete"]).lower()}\n'
        f'Exported (UTC): {metadata["exported_at_utc"]}\n'
        f'Code commit: {git["commit"]} ({git["date"]})\n'
        f'Embedding alias: {metadata["embedding"]["alias"]}\n'
        f'Underlying model (operator-declared): {metadata["embedding"]["underlying_model"]}\n'
        f'Dimensions: {metadata["embedding"]["dimensions"]}\n'
        f'Exact Qdrant points: {metadata["qdrant"]["count"]}\n'
        f'Checkpoint vectors: {metadata["has_vector"]}\n'
        f'Selected-run document records: {metadata["selected_run_table_counts"]["documents"]}\n'
        f'Archived checkpoint runs: {len(metadata["archived_runs"])}\n'
        f'Snapshot scope: {metadata["snapshot_scope"]}\n'
        f'Document statuses: {canonical(metadata["document_statuses"])}\n'
        f'Dead letter: {metadata["document_statuses"].get("dead_letter", 0)}\n'
        'An exhausted source snapshot does not mean every document was indexed.\n', encoding='utf-8')
    metadata['artifacts'] = {n: digest(output / n) for n in sorted(ARTIFACTS)}
    (output / 'manifest.json').write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    validate_bundle(output)
    print('export_bundle_validated')


def resolve_target(args):
    volume = args.state_volume or args.compose_project + '_openbesluitvorming-ingest-state'
    # Inspect, never create/prune or silently initialize a missing volume.
    vi = json.loads(command(['docker', 'volume', 'inspect', volume]))
    require(len(vi) == 1 and vi[0]['Name'] == volume, 'target_volume_not_found')
    qdrant = args.qdrant_container
    if not qdrant:
        compose = ['docker', 'compose', '-p', args.compose_project]
        for file in args.compose_file or [str(ROOT / 'docker-compose.yml')]:
            compose += ['-f', file]
        ids = command(compose + ['ps', '-q', 'qdrant'], ROOT).splitlines()
        require(len(ids) == 1, 'compose_qdrant_not_unique_running_service')
        qdrant = ids[0]
    info = inspect_container(qdrant)
    require(info['State']['Running'], 'target_qdrant_not_running')
    # Active containers sharing the volume are forbidden (including status jobs).
    require(not command(['docker', 'ps', '-q', '--filter', 'volume=' + volume]),
            'target_volume_in_use_by_running_container')
    return info['Id'], volume


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    export = sub.add_parser('export', help='stopped source only; utility/guide must already be committed')
    export.add_argument('--source-container', required=True)
    export.add_argument('--qdrant-container', required=True)
    export.add_argument('--run-id', required=True)
    export.add_argument('--output', required=True)
    export.add_argument('--helper-image', default=IMAGE)
    validate = sub.add_parser('validate', help='offline checksums/archive/SQLite checks; no Docker')
    validate.add_argument('--bundle', required=True)
    restore = sub.add_parser('import', help='empty target only; stage and verify native snapshot before publication')
    restore.add_argument('--bundle', required=True)
    restore.add_argument('--compose-project', required=True)
    restore.add_argument('--compose-file', '-f', action='append')
    restore.add_argument('--qdrant-container')
    restore.add_argument('--state-volume')
    restore.add_argument('--dry-run', action='store_true')
    restore.add_argument('--helper-image', default=IMAGE)
    internal_export = sub.add_parser('_export', help=argparse.SUPPRESS)
    internal_export.add_argument('--run-id', required=True)
    internal_import = sub.add_parser('_import', help=argparse.SUPPRESS)
    internal_import.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    if args.command.startswith('_'):
        require(os.name == 'posix' and os.getuid() == 10001, 'helper_requires_uid_10001')
    if args.command == 'export':
        export_bundle(args)
    elif args.command == 'validate':
        validate_bundle(Path(args.bundle))
        print('bundle_validated_offline_snapshot_semantics_require_import_staging')
    elif args.command == 'import':
        bundle = Path(args.bundle).resolve()
        validate_bundle(bundle)  # Before any target Docker call.
        qdrant, volume = resolve_target(args)
        result = command(helper_args(qdrant, volume, bundle, False, args.helper_image)
            + ['_import'] + (['--dry-run'] if args.dry_run else []), helper=True)
        print(result)
    elif args.command == '_export':
        qdrant = Qdrant()
        qdrant.version()
        print(canonical(backup_state(Path('/state'), Path('/output'), args.run_id, qdrant)))
    elif args.command == '_import':
        print(import_state(Path('/output'), Path('/state'), args.dry_run, Qdrant()))


if __name__ == '__main__':
    try:
        main()
    except Refusal as error:
        print('transfer_refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Avoid secrets/URLs in exception strings, subprocess stderr or tracebacks.
        print('transfer_failed: inspect retained bundle/state and diagnostic collections; '
              'no automatic rollback; check UID10001 permissions and Docker availability', file=sys.stderr)
        sys.exit(1)
