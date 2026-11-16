#!/usr/bin/env python3
"""Opt-in SYNTHETIC native snapshot + state import smoke; no source state mounts.

Run only with --approve-isolated-docker-smoke and an empty UID10001-writable
--output directory. Removes only its own randomly named disposable container.
Never mounts source state, prunes volumes, or imports a real bundle.
"""
import argparse
import contextlib
import gzip
import importlib.util
import io
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tarfile
import time
import uuid

spec = importlib.util.spec_from_file_location('obv_transfer', Path(__file__).with_name('openbesluitvorming-transfer.py'))
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)


def inside():
    transfer.require(os.name == 'posix' and os.getuid() == 10001, 'smoke_requires_uid10001')
    class TracedQdrant(transfer.Qdrant):
        def __init__(self):
            self.uploads = []

        def upload(self, collection, snapshot):
            super().upload(collection, snapshot)
            self.uploads.append(collection)

    q = TracedQdrant()
    for _ in range(60):
        try:
            q.version()
            break
        except Exception:
            time.sleep(1)
    else:
        raise transfer.Refusal('isolated_qdrant_startup_timeout')
    output = Path('/output')
    state, bundle, target_state = [output / name for name in
                                  ('fixture-source-state', 'fixture-bundle', 'fixture-target-state')]
    for path in (state, bundle, target_state):
        path.mkdir()
    worker_spec = importlib.util.spec_from_file_location('synthetic_fixture_worker',
        transfer.ROOT / 'services/openbesluitvorming-ingest/worker.py')
    worker = importlib.util.module_from_spec(worker_spec)
    worker_spec.loader.exec_module(worker)
    record = {'entity_id': 'synthetic-smoke', 'entity_type': 'Document',
              'source_key': 'provincie_limburg', 'op': 'upsert',
              'payload': {'title': 'Synthetic fixture; not source data'}}
    source = 'limburg_synthetic_smoke'
    target = 'limburg_synthetic_restored'
    run_id = 'synthetic-smoke'
    # Only connect() is called: no Worker, source API, encoder or scheduling.
    with contextlib.closing(worker.connect(state)) as db:
        db.execute('INSERT INTO runs(id,collection,source,created_at,updated_at,model,snapshot_complete) VALUES(?,?,?,?,?,?,1)',
                   (run_id, target, 'provincie_limburg', 'fixture', 'fixture', 'govchat-embedding'))
        db.execute("INSERT INTO documents(run_id,entity_id,record,status,updated_at,has_vector) VALUES(?,?,?,'indexed','fixture',1)",
                   (run_id, record['entity_id'], transfer.canonical(record)))
        db.execute('INSERT INTO document_history VALUES(?,?,?,?)',
                   (run_id, 0, record['entity_id'], transfer.canonical({'record': record, 'has_vector': 1})))
        db.commit()
        backup = output / 'fixture-standalone.sqlite'
        with contextlib.closing(sqlite3.connect(backup)) as dst:
            db.backup(dst)
    metadata = transfer.sqlite_metadata(backup, run_id)
    history = state / 'vector-history/synthetic-smoke/0/point.json.gz'
    history.parent.mkdir(parents=True)
    history.write_bytes(gzip.compress(transfer.canonical({'source_record': record,
        'vector': [1.0] + [0.0] * 3071}).encode(), mtime=0))
    (state / 'history.lock').write_bytes(b'fixture-history-lock')
    (state / 'worker.lock').write_bytes(b'fixture-archived-worker-lock')
    vectors = {'size': 3072, 'distance': 'Cosine', 'on_disk': True}
    q.absent(source)
    q.reserve(source, vectors)
    payload = {'source_id': record['entity_id'], 'source_key': 'provincie_limburg',
               'ingest_run_id': 'synthetic-smoke', 'source_record': record}
    q.request(q.collection(source) + '/points?wait=true', 'PUT',
              {'points': [{'id': transfer.point_id(record['entity_id']),
                           'vector': [1.0] + [0.0] * 3071, 'payload': payload}]})
    expected = q.inspect(source, metadata)
    snapshot = output / 'dataset.snapshot'
    q.snapshot(source, snapshot)
    transfer.check_archive(snapshot, 'snapshot')
    shutil.copyfile(snapshot, bundle / 'dataset.snapshot')
    with tarfile.open(bundle / 'ingest-state.tar.gz', 'w:gz') as archive:
        archive.add(backup, arcname='ingest.sqlite', recursive=False)
        for path, name in transfer.state_files(state):
            archive.add(path, arcname=name, recursive=False)
    # Required names are placeholders, never executable deployment code or HEAD.
    with tarfile.open(bundle / 'code.tar.gz', 'w:gz') as archive:
        for name in sorted(transfer.CODE_REQUIRED):
            body = b'SYNTHETIC FIXTURE PLACEHOLDER; NOT EXECUTABLE DEPLOYMENT CODE\n'
            member = tarfile.TarInfo(name)
            member.size = len(body)
            archive.addfile(member, io.BytesIO(body))
    for name in ('README.md', 'server-guide.md'):
        (bundle / name).write_text('SYNTHETIC FIXTURE ONLY; code placeholders; do not deploy.\n', encoding='utf-8')
    metadata.update({'format': 'govchat-obv-transfer-1', 'fixture': 'synthetic; no committed code; do not deploy',
        'embedding': {'alias': metadata['run']['model'],
                      'underlying_model': 'azure/text-embedding-3-large', 'dimensions': 3072},
        'qdrant': expected})
    metadata['artifacts'] = {name: transfer.digest(bundle / name) for name in transfer.ARTIFACTS}
    (bundle / 'manifest.json').write_text(transfer.canonical(metadata) + '\n', encoding='utf-8')
    with transfer.tempfile.TemporaryDirectory(dir=output) as tmp:
        transfer.validate_bundle(bundle, Path(tmp))
    # Ignore the API's per-request timing; compare only collection identities.
    before = q.request('/collections')['result']
    result = transfer.import_state(bundle, target_state, True, q)
    transfer.require(result == 'dry_run_validated_no_target_writes_no_snapshot_restore'
                     and not any(target_state.iterdir()) and not q.uploads
                     and q.request('/collections')['result'] == before, 'smoke_dry_run_changed_target')
    result = transfer.import_state(bundle, target_state, False, q)
    transfer.require(result == 'import_verified_staging_collection_retained_no_alias_changed'
                     and len(q.uploads) == 2 and q.uploads[0].startswith('obv_transfer_stage_')
                     and q.uploads[1] == target, 'smoke_staged_final_pipeline_missing')
    for collection in q.uploads:
        transfer.require(q.inspect(collection, metadata) == expected, 'smoke_restored_snapshot_mismatch')
    restored = transfer.sqlite_metadata(target_state / 'ingest.sqlite', run_id)
    transfer.require(all(restored[key] == metadata[key] for key in restored)
                     and transfer.digest(target_state / 'ingest.sqlite') == transfer.digest(backup),
                     'smoke_published_sqlite_mismatch')
    files = {name: transfer.digest(path) for path, name in transfer.state_files(state) if name != 'worker.lock'}
    published = {name: transfer.digest(path) for path, name in transfer.state_files(target_state) if name != 'worker.lock'}
    transfer.require(published == files and (target_state / 'worker.lock').read_bytes() == b''
                     and not any(p.name.startswith('.obv-transfer-stage-') for p in target_state.iterdir()),
                     'smoke_published_history_or_live_lock_mismatch')
    before_state = {p.relative_to(target_state).as_posix(): transfer.digest(p)
                    for p in target_state.rglob('*') if p.is_file()}
    for dry_run in (True, False):
        try:
            transfer.import_state(bundle, target_state, dry_run, q)
        except transfer.Refusal as error:
            transfer.require(str(error) == 'target_state_volume_not_empty', 'smoke_wrong_repeat_refusal')
        else:
            raise transfer.Refusal('smoke_repeat_import_not_refused')
    transfer.require(before_state == {p.relative_to(target_state).as_posix(): transfer.digest(p)
                    for p in target_state.rglob('*') if p.is_file()} and len(q.uploads) == 2
                    and q.inspect(target, metadata) == expected, 'smoke_refusal_changed_target')
    print(f'isolated_native_state_staged_import_passed points={expected["count"]} '
          f'dimensions=3072 sqlite_documents={restored["table_counts"]["documents"]} '
          f'sqlite_history={restored["table_counts"]["document_history"]} '
          f'history_files={len(files)} history_bytes={sum(x["bytes"] for x in files.values())} '
          'dry_run_untouched=true repeat_refused=true staged_final_verified=true')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approve-isolated-docker-smoke', action='store_true')
    parser.add_argument('--output')
    parser.add_argument('--inside', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.inside:
        inside()
        return
    transfer.require(args.approve_isolated_docker_smoke and args.output, 'explicit_smoke_approval_and_output_required')
    output = Path(args.output).resolve()
    transfer.require(output.is_dir() and not output.is_symlink() and not any(output.iterdir()), 'smoke_output_must_be_empty')
    name = 'obv-transfer-smoke-' + uuid.uuid4().hex
    created = False
    try:
        transfer.command(['docker', 'run', '--detach', '--rm', '--name', name,
                          '--network', 'none', 'qdrant/qdrant:v1.16.2'])
        created = True
        result = transfer.command(['docker', 'run', '--rm', '--user', '10001:10001',
            '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--network', 'container:' + name,
            '--mount', f'type=bind,src={transfer.ROOT},dst=/repo,readonly',
            '--mount', f'type=bind,src={output},dst=/output', transfer.IMAGE,
            'python', '-B', '/repo/scripts/openbesluitvorming-transfer-smoke.py', '--inside'], helper=True)
        print(result)
    finally:
        if created:
            # Only this disposable container; --rm cleans its anonymous mounts.
            transfer.command(['docker', 'stop', name])


if __name__ == '__main__':
    try:
        main()
    except transfer.Refusal as error:
        # Fixed credential-free codes, also recognized by the helper relay.
        print('transfer_refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('isolated_smoke_failed; inspect synthetic output and Docker availability/UID10001 permissions', file=sys.stderr)
        sys.exit(1)
