"""Ingest-owned, materialized metadata aggregates. No Qdrant reads at query time."""
import contextlib
import datetime as dt
import hashlib
import json
from pathlib import Path
import sqlite3
import zlib
import re
from collections import Counter
from functools import lru_cache

from metadata import discover, values, present, scalar_key, date_value, blocked, clock, DATE_PATHS, TYPE_PATHS


def scope_key(collection, run_id, source):
    return json.dumps([collection, run_id, source], separators=(",", ":"))


def safe_payload(value):
    if isinstance(value, dict):
        return {k: safe_payload(v) for k, v in value.items() if not blocked(k) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", k)}
    if isinstance(value, list):
        return [safe_payload(v) for v in value]
    return value


@lru_cache(maxsize=40000)
def parsed_calendar(value):
    try:
        return date_value(value)
    except (ValueError, TypeError):
        return None


def facts(payload):
    p = safe_payload(payload)
    kinds = {}
    for name, kind in discover(p):
        kinds.setdefault(name, set()).add(kind)
    stats, groups = [], []
    for field in sorted(set(kinds) | {"date", "year", "document_type"}):
        nodes = values(p, field)
        exists = int(present(p, field))
        for interval in ("", "year", "month"):
            keys, invalid, nulls = set(), False, False
            for value in nodes:
                if value is None:
                    nulls = True
                    continue
                try:
                    if interval:
                        parsed = parsed_calendar(value) if isinstance(value, str) else None
                        if parsed is None:
                            invalid = True
                            continue
                        value = f"{parsed.year:04d}" if interval == "year" else f"{parsed.year:04d}-{parsed.month:02d}"
                    keys.add(scalar_key(value))
                except (ValueError, TypeError):
                    invalid = True
            stats.append([field, interval, exists, int(invalid), int(nulls), int(bool(keys)), int(len(keys) > 1)])
            groups.extend([field, interval, kind, value] for kind, value in sorted(keys))
    return {"kinds": [[field, kind] for field in sorted(kinds) for kind in sorted(kinds[field])],
            "stats": stats, "groups": groups}


class Catalog:
    def __init__(self, filename):
        self.path = Path(filename)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=30)
        self.db.executescript("""
          PRAGMA journal_mode=WAL;
          PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS dataset(scope TEXT PRIMARY KEY,revision TEXT,ready INTEGER NOT NULL DEFAULT 0,documents INTEGER NOT NULL DEFAULT 0,built_at TEXT);
          CREATE TABLE IF NOT EXISTS docs(scope TEXT,id TEXT,facts BLOB,PRIMARY KEY(scope,id));
          CREATE TABLE IF NOT EXISTS kinds(scope TEXT,field TEXT,kind TEXT,n INTEGER NOT NULL,PRIMARY KEY(scope,field,kind));
          CREATE TABLE IF NOT EXISTS stats(scope TEXT,field TEXT,interval TEXT,present INTEGER,invalid INTEGER,nulls INTEGER,with_value INTEGER,overlap INTEGER,PRIMARY KEY(scope,field,interval));
          CREATE TABLE IF NOT EXISTS vals(scope TEXT,field TEXT,interval TEXT,kind TEXT,value TEXT,n INTEGER NOT NULL,PRIMARY KEY(scope,field,interval,kind,value));
        """)

    def initialize(self, scope, ready=False):
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO dataset(scope,ready) VALUES(?,?)", (scope, int(ready)))

    def invalidate(self, scope):
        self.initialize(scope)
        with self.db:
            self.db.execute('UPDATE dataset SET ready=0 WHERE scope=?', (scope,))

    def _apply(self, scope, f, sign):
        self.db.executemany("INSERT INTO kinds VALUES(?,?,?,?) ON CONFLICT(scope,field,kind) DO UPDATE SET n=n+excluded.n",
                            [(scope, field, kind, sign) for field, kind in f["kinds"]])
        self.db.executemany("INSERT INTO stats VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,field,interval) DO UPDATE SET present=present+excluded.present,invalid=invalid+excluded.invalid,nulls=nulls+excluded.nulls,with_value=with_value+excluded.with_value,overlap=overlap+excluded.overlap",
                            [(scope, field, interval, *(sign*n for n in numbers)) for field, interval, *numbers in f["stats"]])
        self.db.executemany("INSERT INTO vals VALUES(?,?,?,?,?,?) ON CONFLICT(scope,field,interval,kind,value) DO UPDATE SET n=n+excluded.n",
                            [(scope, field, interval, kind, value, sign) for field, interval, kind, value in f["groups"]])

    def update(self, scope, identity, payload, commit=True):
        with self.db if commit else contextlib.nullcontext():
            self.db.execute("INSERT OR IGNORE INTO dataset(scope) VALUES(?)", (scope,))
            old = self.db.execute("SELECT facts FROM docs WHERE scope=? AND id=?", (scope, identity)).fetchone()
            if old:
                self._apply(scope, json.loads(zlib.decompress(old[0])), -1)
                self.db.execute("DELETE FROM docs WHERE scope=? AND id=?", (scope, identity))
                self.db.execute("UPDATE dataset SET documents=documents-1 WHERE scope=?", (scope,))
            if payload is not None:
                f = facts(payload)
                self._apply(scope, f, 1)
                encoded = zlib.compress(json.dumps(f, separators=(",", ":")).encode())
                self.db.execute("INSERT INTO docs VALUES(?,?,?)", (scope, identity, encoded))
                self.db.execute("UPDATE dataset SET documents=documents+1 WHERE scope=?", (scope,))
            self.db.execute("UPDATE dataset SET ready=0 WHERE scope=?", (scope,))

    def publish(self, scope, revision, expected_documents):
        with self.db:
            total = self.db.execute("SELECT documents FROM dataset WHERE scope=?", (scope,)).fetchone()
            if total is None or total[0] != expected_documents:
                return False
            self.db.execute("UPDATE dataset SET ready=1,revision=?,built_at=? WHERE scope=?", (revision, clock(), scope))
        self.db.execute("PRAGMA wal_checkpoint(PASSIVE)")
        return True

    def add_many(self, scope, documents):
        """Bulk initial/resume build: merge repeated contributions per page."""
        kinds, groups, stats, records = Counter(), Counter(), {}, []
        ids = [identity for identity, _ in documents]
        existing = set()
        if ids:
            existing = {r[0] for r in self.db.execute('SELECT id FROM docs WHERE scope=? AND id IN (' + ','.join('?' for _ in ids) + ')', (scope, *ids))}
        for identity, payload in documents:
            if identity in existing:
                continue
            f = facts(payload)
            kinds.update(tuple(v) for v in f['kinds'])
            groups.update(tuple(v) for v in f['groups'])
            for field, interval, *numbers in f['stats']:
                total = stats.setdefault((field, interval), [0]*5)
                for i, number in enumerate(numbers):
                    total[i] += number
            records.append((scope, identity, zlib.compress(json.dumps(f, separators=(',', ':')).encode())))
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO dataset(scope) VALUES(?)', (scope,))
            self.db.executemany('INSERT INTO kinds VALUES(?,?,?,?) ON CONFLICT(scope,field,kind) DO UPDATE SET n=n+excluded.n', [(scope,*k,n) for k,n in kinds.items()])
            self.db.executemany('INSERT INTO vals VALUES(?,?,?,?,?,?) ON CONFLICT(scope,field,interval,kind,value) DO UPDATE SET n=n+excluded.n', [(scope,*k,n) for k,n in groups.items()])
            self.db.executemany('INSERT INTO stats VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,field,interval) DO UPDATE SET present=present+excluded.present,invalid=invalid+excluded.invalid,nulls=nulls+excluded.nulls,with_value=with_value+excluded.with_value,overlap=overlap+excluded.overlap', [(scope,*k,*v) for k,v in stats.items()])
            self.db.executemany('INSERT INTO docs VALUES(?,?,?)', records)
            self.db.execute('UPDATE dataset SET documents=documents+?,ready=0 WHERE scope=?', (len(records),scope))
        return len(records)

    def close(self):
        self.db.close()


def prepared_query(filename, config, query, revision):
    """Hold the existing ingest lock while reading a published catalog."""
    from state import shared_lock, ImportInProgress
    path = Path(filename)
    guard = shared_lock(path.parent / 'worker.lock') if (path.parent / 'worker.lock').is_file() else contextlib.nullcontext()
    try:
        with guard:
            return _prepared_query(filename, config, query, revision)
    except ImportInProgress:
        return None


def _prepared_query(filename, config, query, revision):
    """Return only a published matching version; never scan source documents."""
    path = Path(filename)
    if not revision or query["filters"] or query["operation"] == "status" or not path.is_file() or path.is_symlink():
        return None
    scope = scope_key(config.collection, config.run_id, config.source)
    wal = Path(str(path) + '-wal')
    immutable = not wal.exists() or wal.stat().st_size == 0
    uri = path.resolve().as_uri() + "?mode=ro" + ('&immutable=1' if immutable else '')
    with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=1)) as db:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        row = db.execute("SELECT * FROM dataset WHERE scope=?", (scope,)).fetchone()
        if row is None or not row["ready"] or row["revision"] != revision:
            return None
        total = row["documents"]
        result = {"operation": query["operation"], "source_kind": "ingest_materialized_metadata",
                  "scope": {"collection": config.collection, "run_id": config.run_id, "source_key": config.source},
                  "query_as_of": clock(), "computed_at": row["built_at"], "dataset_revision": revision,
                  "ingest_in_progress": False, "cached": False, "precomputed": True,
                  "exact": True, "truncated": False, "total_documents": total,
                  "matched_documents": total, "scanned_documents": 0, "skipped_documents": 0,
                  "coverage": {"basis": "indexed documents represented by the completed ingest version", "source_complete": None},
                  "evidence": {"method": "ingest_materialized_aggregates"}}
        if query["operation"] == "count":
            return result
        limit, offset = query["limit"], query["offset"]
        result.update(limit=limit, offset=offset)
        if query["operation"] in ("fields", "overview"):
            total_fields = db.execute("SELECT COUNT(DISTINCT field) FROM kinds WHERE scope=? AND n>0", (scope,)).fetchone()[0]
            names = db.execute("SELECT DISTINCT field FROM kinds WHERE scope=? AND n>0 ORDER BY field LIMIT ? OFFSET ?", (scope, limit, offset)).fetchall()
            fields = []
            for item in names:
                field = item[0]
                types = [r[0] for r in db.execute("SELECT kind FROM kinds WHERE scope=? AND field=? AND n>0 ORDER BY kind", (scope, field))]
                present = db.execute("SELECT present FROM stats WHERE scope=? AND field=? AND interval=''", (scope, field)).fetchone()[0]
                fields.append({"field": field, "types": types, "present_documents": present, "missing_documents": total-present})
            result.update(fields=fields, total_fields=total_fields, fields_paginated=offset>0 or total_fields>offset+limit,
                          excluded_field_categories=["document content", "credentials", "binary/vectors", "unaddressable keys"],
                          aliases={"date": list(DATE_PATHS), "year": "date grouped by UTC calendar year", "document_type": list(TYPE_PATHS)})
        elif query["operation"] == "group":
            field = query["field"]
            interval = query["interval"] or ("year" if field == "year" else "")
            total_groups = db.execute("SELECT COUNT(*) FROM vals WHERE scope=? AND field=? AND interval=? AND n>0", (scope, field, interval)).fetchone()[0]
            rows = db.execute("SELECT kind,value,n FROM vals WHERE scope=? AND field=? AND interval=? AND n>0 ORDER BY n DESC,kind,value LIMIT ? OFFSET ?", (scope, field, interval, limit, offset)).fetchall()
            groups = [{"value": r[1] if r[0]=='string' else json.loads(r[1]), "value_type": r[0], "count": r[2]} for r in rows]
            sums = db.execute("SELECT * FROM stats WHERE scope=? AND field=? AND interval=?", (scope, field, interval)).fetchone()
            memberships = db.execute("SELECT COALESCE(SUM(n),0) FROM vals WHERE scope=? AND field=? AND interval=? AND n>0", (scope, field, interval)).fetchone()[0]
            result.update(field=field, interval=query["interval"], groups=groups, total_groups=total_groups,
                          groups_paginated=offset>0 or total_groups>offset+limit,
                          missing_documents=total-(sums['present'] if sums else 0), invalid_documents=sums['invalid'] if sums else 0,
                          null_documents=sums['nulls'] if sums else 0, documents_with_value=sums['with_value'] if sums else 0,
                          overlap_documents=sums['overlap'] if sums else 0, group_memberships=memberships,
                          semantics="Distinct values count each document once; array memberships can overlap.")
            if field == 'document_type':
                result['source_field'] = config.canonical_type_field or 'document_type (metadata alias)'
        return result
