"""Read checkpoint evidence without importing the writer or creating state files."""
import contextlib
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import hashlib

from metadata import UTC, clock, date_value


class ImportInProgress(Exception):
    pass


@contextlib.contextmanager
def shared_lock(path):
    # Never create/replace the lock inode. Writers hold this lock for their full
    # lifetime. Windows CRT has no shared lock: take its nonblocking exclusive
    # equivalent on the existing byte, still without modifying the file.
    if path.is_symlink():
        raise OSError("unsafe_lock")
    with path.open("rb") as handle:
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBRLCK, 1)
            except OSError as error:
                raise ImportInProgress() from error
        else:
            import fcntl
            try:
                fcntl.flock(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ImportInProgress() from error
        try:
            yield
        finally:
            if os.name == "nt":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def timestamp(value, observed):
    try:
        parsed = date_value(value)
        if len(value) == 10 or parsed > observed:
            return None
        return parsed.isoformat().replace("+00:00", "Z")
    except (ValueError, TypeError):
        return None


def read_status(state, config):
    observed = dt.datetime.now(UTC)
    result = {"available": False, "observed_at": clock(), "last_successful_full_sync_at": None}
    root = Path(state)
    database = root / "ingest.sqlite"
    if not database.is_file() or database.is_symlink():
        return {**result, "reason": "state_absent_or_unsafe"}
    try:
        with shared_lock(root / "worker.lock"):
            wal = root / "ingest.sqlite-wal"
            immutable = not wal.exists() or wal.stat().st_size == 0
            if not immutable and not (root / "ingest.sqlite-shm").is_file():
                return {**result, "reason": "wal_without_readable_shared_memory"}
            # mode=ro forbids database changes but may update a writable SHM
            # read-mark. Require the actual read-only mount for WAL reads.
            if not immutable and (not hasattr(os, "statvfs") or not os.statvfs(root).f_flag & getattr(os, "ST_RDONLY", 1)):
                return {**result, "reason": "wal_requires_readonly_filesystem"}
            # The production state mount MUST be read-only. Populated WAL must
            # not be ignored via immutable=1; refuse errors rather than fallback.
            uri = database.resolve().as_uri() + "?mode=ro" + ("&immutable=1" if immutable else "")
            with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=1)) as db:
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA query_only=ON")
                db.execute("BEGIN")
                run = db.execute("SELECT * FROM runs WHERE id=? AND collection=? AND source=?",
                                 (config.run_id, config.collection, config.source)).fetchone()
                if not run:
                    return {**result, "reason": "configured_run_not_in_state"}
                run = dict(run)
                counts = {r["status"]: r["n"] for r in db.execute(
                    "SELECT status,COUNT(*) AS n FROM documents WHERE run_id=? GROUP BY status", (config.run_id,))}
                vector_count = db.execute("SELECT COUNT(*) FROM documents WHERE run_id=? AND has_vector=1", (config.run_id,)).fetchone()[0]
                baselines = db.execute("SELECT baseline FROM refresh_generations WHERE run_id=? ORDER BY generation DESC", (config.run_id,)).fetchall()
                histories = []
                for row in baselines:
                    try:
                        baseline = json.loads(row[0])
                        if isinstance(baseline, dict) and baseline.get("id") == config.run_id:
                            histories.append(baseline)
                    except (ValueError, TypeError):
                        continue
                checkpoint = timestamp(run.get("updated_at"), observed)
                def exhausted(item):
                    return bool(item.get("snapshot_complete")) and item.get("refresh_phase", "none") in ("complete", "none")
                candidates = [item for item in [run] + histories if exhausted(item)]
                scans = sorted(filter(None, (timestamp(item.get("updated_at"), observed) for item in candidates)), key=date_value)
                failures = counts.get("dead_letter", 0) + counts.get("dead", 0)
                unfinished = sum(n for status, n in counts.items()
                                 if status not in ("indexed", "deleted", "dead_letter", "dead"))
                complete = exhausted(run) and failures == 0 and unfinished == 0 and not run.get("last_error") and checkpoint is not None
                result.update(available=True, read_mode="immutable_locked" if immutable else "readonly_wal_locked",
                              run_id=config.run_id, collection=config.collection,
                              generation=run.get("generation", 0), refresh_phase=run.get("refresh_phase", "none"),
                              snapshot_exhausted=bool(run.get("snapshot_complete")), source_complete=complete,
                              checkpoint_document_counts=counts, checkpoint_has_vector=vector_count,
                              failed_documents=failures, unfinished_documents=unfinished,
                              last_updated_checkpoint_at=checkpoint,
                              last_attempt={"checkpoint_at": checkpoint, "completed_scan": exhausted(run),
                                            "failed_documents": failures, "has_error": bool(run.get("last_error"))},
                              last_completed_scan_at=scans[-1] if scans else None,
                              last_successful_full_sync_at=checkpoint if complete else None,
                              timestamp_valid=checkpoint is not None,
                              timestamp_basis="runs.updated_at; historical refresh_generations.baseline.updated_at proves scan exhaustion only, not successful indexing",
                              historical_success_unknown=True)
                # The worker updates the checkpoint after each mutation, even
                # if the number of documents did not change. No TTL is needed.
                revision = {"run_id": config.run_id, "collection": config.collection,
                            "source": config.source, "generation": run.get("generation", 0),
                            "checkpoint": run.get("updated_at"), "counts": counts,
                            "vectors": vector_count, "phase": run.get("refresh_phase", "none")}
                result["dataset_revision"] = hashlib.sha256(json.dumps(revision, sort_keys=True).encode()).hexdigest()
                result["ingest_in_progress"] = False
                return result
    except ImportInProgress:
        return {**result, "reason": "ingest_in_progress", "ingest_in_progress": True}
    except (OSError, sqlite3.Error):
        return {**result, "reason": "state_busy_unreadable_or_schema_unavailable", "ingest_in_progress": None}


def read_revision(state, config):
    """Cheap import revision: one run row, no document-table scans."""
    root = Path(state)
    database = root / "ingest.sqlite"
    result = {"available": False, "dataset_revision": None, "ingest_in_progress": None}
    if not database.is_file() or database.is_symlink():
        return result
    try:
        with shared_lock(root / "worker.lock"):
            wal = root / "ingest.sqlite-wal"
            immutable = not wal.exists() or wal.stat().st_size == 0
            if not immutable and (not (root / "ingest.sqlite-shm").is_file() or not hasattr(os, "statvfs") or not os.statvfs(root).f_flag & getattr(os, "ST_RDONLY", 1)):
                return result
            uri = database.resolve().as_uri() + "?mode=ro" + ("&immutable=1" if immutable else "")
            with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=1)) as db:
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA query_only=ON")
                row = db.execute("SELECT * FROM runs WHERE id=? AND collection=? AND source=?", (config.run_id, config.collection, config.source)).fetchone()
                if row is None:
                    return result
                revision = hashlib.sha256(json.dumps(dict(row), sort_keys=True).encode()).hexdigest()
                active = row['refresh_phase'] in ('inventory', 'apply') if 'refresh_phase' in row.keys() else False
                return {"available": True, "dataset_revision": revision, "ingest_in_progress": active}
    except ImportInProgress:
        return {**result, "ingest_in_progress": True}
    except (OSError, sqlite3.Error):
        return result
