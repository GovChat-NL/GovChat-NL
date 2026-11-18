"""One-off materialization for an existing ingest scope; no embeddings or ingestion."""
import argparse
import json
import os
from pathlib import Path
import time

from catalog import Catalog, scope_key
from metadata import Config, Qdrant, payload_exclusions
from state import read_revision, shared_lock


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', default=os.environ.get('OBV_STATS_STATE_DIR', '/state'))
    args = parser.parse_args()
    root = Path(args.state_dir)
    config, client = Config.environment(), Qdrant(Config.environment())
    scope = scope_key(config.collection, config.run_id, config.source)
    target = root / 'metadata-catalog.sqlite'
    temporary = root / 'metadata-catalog.building.sqlite'
    start = time.monotonic()
    with shared_lock(root / 'worker.lock'):
        revision = read_revision(root, config)
        if not revision.get('available'):
            raise RuntimeError('Ingest revision unavailable; refusing an unversioned build')
        predicate = {'must': [{'key': key, 'match': {'value': value}} for key, value in
                             [('source_key', config.source), ('ingest_run_id', config.run_id), ('entity_type', 'Document')]]}
        expected = client.request('count', {'filter': predicate, 'exact': True}, 30)['count']
        if temporary.exists():
            existing = Catalog(temporary)
            row = existing.db.execute('SELECT revision FROM dataset WHERE scope=?', (scope,)).fetchone()
            existing.close()
            if row is None or row[0] != revision['dataset_revision']:
                raise RuntimeError('Unfinished build does not match the ingest revision; refusing reuse')
        catalog = Catalog(temporary)
        catalog.initialize(scope)
        with catalog.db:
            catalog.db.execute('UPDATE dataset SET revision=? WHERE scope=?', (revision['dataset_revision'],scope))
        offset, count = None, 0
        try:
            while True:
                body = {'filter': predicate, 'limit': 100, 'with_payload': {'exclude': payload_exclusions()}, 'with_vector': False}
                if offset is not None:
                    body['offset'] = offset
                page = client.request('scroll', body, 60)
                documents = []
                for point in page['points']:
                    payload = point['payload']
                    if any(payload.get(k) != v for k, v in [('source_key', config.source), ('ingest_run_id', config.run_id), ('entity_type', 'Document')]):
                        raise RuntimeError('Unexpected document scope')
                    documents.append((payload.get('source_id') or str(point['id']),payload))
                    count += 1
                catalog.add_many(scope, documents)
                if count % 1000 == 0:
                    print(json.dumps({'processed': count, 'expected': expected, 'elapsed_seconds': round(time.monotonic()-start, 1)}), flush=True)
                offset = page.get('next_page_offset')
                if offset is None:
                    break
            after = client.request('count', {'filter': predicate, 'exact': True}, 30)['count']
            current = read_revision(root, config)
            if count != expected or after != expected or current.get('dataset_revision') != revision['dataset_revision']:
                raise RuntimeError('Dataset changed during build; not publishing')
            if not catalog.publish(scope, revision['dataset_revision'], expected):
                raise RuntimeError('Materialized document count differs')
            catalog.db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            catalog.close()
            os.replace(temporary, target)
            os.chmod(target, 0o640)
            print(json.dumps({'published': True, 'documents': count, 'elapsed_seconds': round(time.monotonic()-start, 1)}), flush=True)
        except Exception:
            catalog.close()
            raise


if __name__ == '__main__':
    main()
