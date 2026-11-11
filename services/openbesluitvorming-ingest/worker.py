"""Opt-in, bounded, crash-resumable Limburg document ingestion. No scheduler."""
import argparse
from collections import OrderedDict
import contextlib
import concurrent.futures
import datetime
import email.utils
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

SOURCE = 'provincie_limburg'
DIMENSIONS = 3072
API = 'https://openbesluitvorming.nl/api'
ATTACHMENT_HOSTS = {'openbesluitvorming.nl', 'api1.ibabs.eu', 'api.ibabs.eu',
                    'limburg.bestuurlijkeinformatie.nl', 'fsn1.your-objectstorage.com'}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class IngestError(Exception):
    def __init__(self, code, stage='validation', evidence=None):
        super().__init__(code)
        self.code, self.stage, self.evidence = code, stage, evidence or []


def parse_page(body, headers, cursor=None):
    """A malformed line/header aborts the entire page, never a silent filter."""
    h = {k.lower(): str(v).strip() for k, v in headers.items()}
    if h.get('x-has-more') not in ('true', 'false'):
        raise IngestError('missing_or_invalid_has_more', 'pagination')
    more = h['x-has-more'] == 'true'
    nxt = h.get('x-next-cursor') or None
    if more and (not nxt or nxt == cursor):
        raise IngestError('missing_or_repeated_cursor', 'pagination')
    if not h.get('x-changes-cursor'):
        raise IngestError('missing_changes_cursor', 'pagination')
    records = []
    try:
        text = body.decode('utf-8') if isinstance(body, bytes) else body
        for number, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            r = json.loads(line)
            if (not isinstance(r, dict) or not isinstance(r.get('entity_id'), str)
                    or not r['entity_id'] or r.get('source_key') != SOURCE
                    or r.get('op') not in ('upsert', 'delete') or not r.get('entity_type')
                    or (r['op'] == 'upsert' and not isinstance(r.get('payload'), dict))):
                raise ValueError('invalid record')
            records.append(r)
    except (ValueError, UnicodeError, TypeError):
        raise IngestError(f'malformed_snapshot_line_{number if "number" in locals() else 0}', 'pagination') from None
    if more and not records:
        raise IngestError('empty_nonterminal_page', 'pagination')
    ids = [r['entity_id'] for r in records]
    if len(ids) != len(set(ids)):
        raise IngestError('duplicate_entity_in_page', 'pagination')
    if ids != sorted(ids) or (cursor and ids and ids[0] <= cursor):
        raise IngestError('snapshot_records_not_strictly_advancing', 'pagination')
    if more and nxt != ids[-1]:
        raise IngestError('cursor_does_not_match_last_snapshot_record', 'pagination')
    return records, nxt, more, h['x-changes-cursor']


def point_id(entity_id):
    # Stable UUID-shaped IDs for fresh isolated collections. The retired n8n
    # worker used a different custom hash; source_id and vector schema provide
    # search compatibility, and no legacy collection is mutated by this worker.
    h = hashlib.sha256(entity_id.encode()).hexdigest()[:32]
    return f'{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}'


def public_links(entity_id, reference, original, existing=None):
    doc = entity_id.rsplit(':', 1)[-1]
    try:
        doc = str(uuid.UUID(doc))
    except ValueError:
        raise IngestError('invalid_limburg_document_id') from None
    base = 'https://limburg.bestuurlijkeinformatie.nl'
    for prior in (existing, original):
        if isinstance(prior, str) and re.fullmatch(
                re.escape(base) + r'/(?:Agenda|Reports)/Document/[0-9a-f-]{36}\?documentId=' + re.escape(doc) + r'(?:&[^#]*)?', prior, re.I):
            return {'public_url': prior, 'original_url': prior, 'original_download_url': original}
    match = re.fullmatch(r'(meeting|motion):ibabs:provincie:provincie_limburg:([0-9a-f-]{36})', reference or '', re.I)
    url = f'{base}/Document/View/{doc}'
    if match:
        parent = str(uuid.UUID(match[2]))
        url = f'{base}/{"Agenda" if match[1].lower() == "meeting" else "Reports"}/Document/{parent}?documentId={doc}'
    return {'public_url': url, 'original_url': url, 'original_download_url': original}


def validate_attachment_url(url):
    if not isinstance(url, str) or any(ord(c) < 32 or ord(c) == 127 for c in url):
        raise IngestError('invalid_attachment_url', 'download')
    try:
        u = urllib.parse.urlsplit(url)
        port = u.port
    except ValueError:
        raise IngestError('invalid_attachment_url', 'download') from None
    extra = set(filter(None, os.getenv('OBV_ATTACHMENT_HOSTS', '').split(',')))
    if (u.scheme != 'https' or u.hostname not in ATTACHMENT_HOSTS | extra
            or u.username or u.password or port not in (None, 443)):
        raise IngestError('attachment_url_not_allowlisted', 'download')
    # Source object-storage paths include literal spaces and Unicode filenames.
    # Encode only the wire URL; retain the exact source URL in metadata. Preserve
    # existing escapes and signed-query delimiters without decoding/reordering.
    return urllib.parse.urlunsplit((u.scheme, u.netloc,
        urllib.parse.quote(u.path, safe="/%:@!$&'()*+,;=-._~"),
        urllib.parse.quote(u.query, safe="%/:?@!$&'()*+,;=-._~"), u.fragment))


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, pace=None):
        super().__init__()
        self.pace = pace

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        newurl = validate_attachment_url(newurl)
        if self.pace:
            self.pace()
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Http:
    def __init__(self):
        self.last_api = 0
        self.api_lock = threading.Lock()
        self.api_not_before = 0
        self.download_slots = threading.BoundedSemaphore(2)
        self.download_lock = threading.Lock()
        self.last_download = 0
        self.download_not_before = 0
        self.timeout = int(os.getenv('OBV_HTTP_TIMEOUT_SECONDS', '120'))
        self.attempts = int(os.getenv('OBV_HTTP_ATTEMPTS', '4'))

    @staticmethod
    def retry_delay(value, attempt):
        try:
            delay = float(value)
        except (ValueError, TypeError):
            try:
                delay = email.utils.parsedate_to_datetime(value).timestamp() - time.time()
            except (ValueError, TypeError, OverflowError):
                delay = 0
        return max(delay if math.isfinite(delay) else 0, 2 ** attempt)

    def pace_download(self):
        with self.download_lock:
            time.sleep(max(0, max(self.last_download + 0.5, self.download_not_before) - time.monotonic()))
            self.last_download = time.monotonic()

    def request(self, url, method='GET', data=None, headers=None, max_bytes=64 * 1024 * 1024, attachment=False):
        if attachment:
            url = validate_attachment_url(url)
        hdr = {'User-Agent': 'GovChat-NL-OpenBesluitvorming-Ingest/1.0', **(headers or {})}
        if isinstance(data, dict):
            data = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
            hdr['Content-Type'] = 'application/json'
        opener = urllib.request.build_opener(SafeRedirect(self.pace_download)) if attachment else urllib.request.build_opener()
        for attempt in range(self.attempts):
            source = url.startswith(API + '/')
            # Serialize actual source starts (and response reads), not just slot
            # reservations. All snapshot/detail/reference/retry calls share this
            # limiter. Downstream HTTP remains concurrent. A final 429 also
            # establishes a shared cooldown before another document can start.
            with self.download_slots if attachment else contextlib.nullcontext(), \
                    self.api_lock if source else contextlib.nullcontext():
                if source:
                    time.sleep(max(0, max(self.last_api + 1.1, self.api_not_before) - time.monotonic()))
                    self.last_api = time.monotonic()
                try:
                    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
                    if attachment:
                        self.pace_download()
                    with opener.open(req, timeout=self.timeout) as response:
                        content = response.read(max_bytes + 1)
                        if len(content) > max_bytes:
                            raise IngestError('response_size_budget_exceeded', 'http')
                        return content, dict(response.headers)
                except urllib.error.HTTPError as error:
                    # Never log bodies, headers, credentials or signed URLs.
                    code = error.code
                    delay = self.retry_delay(error.headers.get('Retry-After', '0'), attempt)
                    error.close()
                    if source and code in (429, 503):
                        self.api_not_before = max(self.api_not_before, time.monotonic() + delay)
                    if attachment and code in (429, 503):
                        with self.download_lock:
                            self.download_not_before = max(self.download_not_before, time.monotonic() + delay)
                    if code not in (408, 429, 500, 502, 503, 504) or attempt == self.attempts - 1:
                        raise IngestError(f'http_{code}', 'http') from None
                except (urllib.error.URLError, TimeoutError, OSError):
                    if attempt == self.attempts - 1:
                        raise IngestError('http_transport_failure', 'http') from None
                    delay = 2 ** attempt
            time.sleep(delay)
        raise IngestError('http_attempts_exhausted', 'http')

    def json(self, url, method='GET', data=None, headers=None):
        body, _ = self.request(url, method, data, headers)
        try:
            result = json.loads(body)
        except (ValueError, UnicodeError):
            raise IngestError('malformed_json_response', 'http') from None
        if not isinstance(result, dict):
            raise IngestError('unexpected_json_schema', 'http')
        return result


@contextlib.contextmanager
def lock(state):
    """Kernel lock shared by all one-shot containers; released automatically on crash."""
    state.mkdir(parents=True, exist_ok=True)
    handle = open(state / 'worker.lock', 'a+b')
    try:
        try:
            if os.name == 'nt':
                import msvcrt
                handle.seek(0)
                if not handle.read(1):
                    handle.write(b'0')
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise IngestError('another_ingestion_command_holds_lock', 'locking') from None
        yield
    finally:
        handle.close()


def connect(state):
    state.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(state / 'ingest.sqlite', timeout=30)
    db.row_factory = sqlite3.Row
    db.executescript('''
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY, collection TEXT UNIQUE NOT NULL, source TEXT NOT NULL,
            cursor TEXT, changes_cursor TEXT, pages INTEGER NOT NULL DEFAULT 0,
            snapshot_complete INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, last_error TEXT, model TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (
            run_id TEXT NOT NULL, entity_id TEXT NOT NULL, record TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt REAL NOT NULL DEFAULT 0, error TEXT, evidence TEXT,
            updated_at TEXT NOT NULL, PRIMARY KEY(run_id, entity_id));
        CREATE INDEX IF NOT EXISTS pending_jobs ON documents(run_id,status,next_attempt);
        CREATE TABLE IF NOT EXISTS pages (
            run_id TEXT NOT NULL, page INTEGER NOT NULL, cursor TEXT, next_cursor TEXT,
            raw BLOB NOT NULL, headers TEXT NOT NULL, PRIMARY KEY(run_id,page));
        CREATE TABLE IF NOT EXISTS rejected_pages (
            id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, cursor TEXT,
            raw BLOB NOT NULL, headers TEXT NOT NULL, error TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS contexts (
            entity_id TEXT PRIMARY KEY, detail TEXT NOT NULL, fetched_at TEXT NOT NULL);
    ''')
    return db


class Worker:
    def __init__(self, state, http=None, encoder=None):
        self.state = Path(state)
        self.db = connect(self.state)
        self.http = http or Http()
        self.encoder = encoder
        self.qdrant = os.getenv('OBV_QDRANT_URL', 'http://qdrant:6333').rstrip('/')
        self.litellm = os.getenv('LITELLM_URL', 'http://litellm:4000').rstrip('/')
        self.tika = os.getenv('OBV_TIKA_URL', 'http://tika:9998/tika')
        self.max_bytes = int(os.getenv('OBV_ATTACHMENT_MAX_BYTES', str(64 * 1024 * 1024)))
        self.max_chars = int(os.getenv('OBV_DOCUMENT_MAX_CHARS', '10000000'))
        self.context_lock = threading.Lock()
        self.encoder_lock = threading.Lock()
        self.metrics_lock = threading.Lock()
        self.context_cache = OrderedDict()
        self.context_dirty = {}
        self.metrics = {}
        self.local = threading.local()

    def timed(self, stage, function, *args, **kwargs):
        start = time.perf_counter()
        try:
            return function(*args, **kwargs)
        finally:
            elapsed = time.perf_counter() - start
            with self.metrics_lock:
                metric = self.metrics.setdefault(stage, {'calls': 0, 'seconds': 0.0})
                metric['calls'] += 1
                metric['seconds'] += elapsed
            if hasattr(self.local, 'timings'):
                self.local.timings[stage] = self.local.timings.get(stage, 0.0) + elapsed

    def flush_contexts(self):
        # Only the coordinator touches SQLite; thread-fetched reference metadata
        # is an optimization cache, never the authoritative document checkpoint.
        with self.context_lock:
            with self.db:
                for reference, detail in self.context_dirty.items():
                    self.db.execute('INSERT OR REPLACE INTO contexts VALUES(?,?,?)', (reference, json.dumps(detail), now()))
            self.context_dirty.clear()

    def run_info(self, run_id):
        row = self.db.execute('SELECT * FROM runs WHERE id=?', (run_id,)).fetchone()
        if row is None:
            raise IngestError('unknown_run')
        return dict(row)

    def collection_url(self, collection):
        return f'{self.qdrant}/collections/{urllib.parse.quote(collection, safe="")}'

    def fresh(self, run_id, collection):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', run_id) or not re.fullmatch(r'limburg_[a-zA-Z0-9_-]{1,100}', collection):
            raise IngestError('fresh_run_requires_unique_limburg_prefixed_collection')
        if self.db.execute('SELECT 1 FROM runs WHERE id=? OR collection=?', (run_id, collection)).fetchone():
            raise IngestError('run_or_collection_already_registered')
        url = self.collection_url(collection)
        try:
            self.http.json(url)
        except IngestError as e:
            if e.code != 'http_404':
                raise
        else:
            raise IngestError('refusing_existing_collection')
        self.http.json(url, 'PUT', {'vectors': {'size': DIMENSIONS, 'distance': 'Cosine', 'on_disk': True},
                                    'hnsw_config': {'on_disk': True}, 'on_disk_payload': True})
        for field, schema in [('source_id', 'keyword'), ('source_key', 'keyword'), ('entity_type', 'keyword'), ('ingest_run_id', 'keyword'),
                              ('title', 'text'), ('content_preview', 'text'), ('date', 'datetime')]:
            self.http.json(url + '/index?wait=true', 'PUT', {'field_name': field, 'field_schema': schema})
        with self.db:
            self.db.execute('INSERT INTO runs(id,collection,source,created_at,updated_at,model) VALUES(?,?,?,?,?,?)',
                            (run_id, collection, SOURCE, now(), now(), os.getenv('OBV_EMBEDDING_MODEL', 'govchat-embedding')))
        return self.status(run_id)

    def validate_collection(self, run):
        result = self.http.json(self.collection_url(run['collection']))
        v = result.get('result', {}).get('config', {}).get('params', {}).get('vectors', {})
        if v.get('size') != DIMENSIONS or v.get('distance') != 'Cosine':
            raise IngestError('qdrant_vector_schema_mismatch', 'qdrant')

    def page(self, run, limit):
        query = {'source': SOURCE, 'limit': limit}
        if run['cursor']:
            query['cursor'] = run['cursor']
        body, headers = self.timed('source', self.http.request, API + '/export/snapshot?' + urllib.parse.urlencode(query))
        try:
            records, nxt, more, changes = parse_page(body, headers, run['cursor'])
            # Snapshot cursors are entity IDs ordered lexicographically. Prevent cycles/backtracking.
            if more and run['cursor'] and nxt <= run['cursor']:
                raise IngestError('nonadvancing_snapshot_cursor', 'pagination')
            if len(records) > limit:
                raise IngestError('snapshot_exceeded_requested_limit', 'pagination')
        except IngestError as e:
            with self.db:
                self.db.execute('INSERT INTO rejected_pages(run_id,cursor,raw,headers,error,created_at) VALUES(?,?,?,?,?,?)',
                                (run['id'], run['cursor'], body, json.dumps(headers), e.code, now()))
                self.db.execute('UPDATE runs SET last_error=?,updated_at=? WHERE id=?', (e.code, now(), run['id']))
            raise
        with self.db:
            page = run['pages'] + 1
            self.db.execute('INSERT INTO pages VALUES(?,?,?,?,?,?)',
                            (run['id'], page, run['cursor'], nxt, body, json.dumps(headers)))
            for record in records:
                if record['entity_type'] == 'Document':
                    self.db.execute('''INSERT INTO documents(run_id,entity_id,record,updated_at) VALUES(?,?,?,?)
                        ON CONFLICT(run_id,entity_id) DO UPDATE SET record=excluded.record,status='pending',
                        attempts=0,next_attempt=0,error=NULL,updated_at=excluded.updated_at''',
                                    (run['id'], record['entity_id'], json.dumps(record, ensure_ascii=False), now()))
            self.db.execute('''UPDATE runs SET cursor=?,changes_cursor=COALESCE(changes_cursor,?),pages=?,
                snapshot_complete=?,updated_at=?,last_error=NULL WHERE id=?''',
                            (nxt, changes, page, int(not more), now(), run['id']))

    def detail(self, entity_id):
        d = self.http.json(API + '/entities/' + urllib.parse.quote(entity_id, safe=''))
        if d.get('entityId') != entity_id or not d.get('entityType'):
            raise IngestError('entity_detail_identity_mismatch', 'entity_detail')
        return d

    def context(self, reference):
        if not reference:
            return None
        if not isinstance(reference, str):
            raise IngestError('unsupported_reference_schema', 'metadata')
        if reference.startswith('organization:'):
            # Actual API: organization:nl:provincie:provincie_limburg returns
            # 404 from /entities. Preserve the exact ID and document detail's
            # display name without fabricating unavailable entity metadata.
            return {'entity_id': reference, 'metadata_status': 'reference_only',
                    'reason': 'organization_not_exposed_by_entity_detail_api'}
        with self.context_lock:
            if reference not in self.context_cache:
                # A short-lived thread-owned read connection avoids sharing the
                # coordinator connection. Keep only 128 references in memory;
                # the durable cache can grow without growing worker RSS forever.
                with contextlib.closing(sqlite3.connect(self.state / 'ingest.sqlite', timeout=30)) as reader:
                    cached = reader.execute('SELECT detail FROM contexts WHERE entity_id=?', (reference,)).fetchone()
                d = json.loads(cached[0]) if cached else self.timed('detail', self.detail, reference)
                self.context_cache[reference] = d
                if not cached:
                    self.context_dirty[reference] = d
                if len(self.context_cache) > 128:
                    self.context_cache.popitem(last=False)
            self.context_cache.move_to_end(reference)
            return self.context_cache[reference]

    def download_text(self, urls, name):
        errors = []
        for url in dict.fromkeys(filter(None, urls)):
            try:
                data, headers = self.timed('attachment', self.http.request, url, max_bytes=self.max_bytes, attachment=True)
                mime = next((v for k, v in headers.items() if k.lower() == 'content-type'), '').split(';')[0]
                if not data or mime == 'text/html' or data.lstrip()[:30].lower().startswith((b'<!doctype html', b'<html')):
                    raise IngestError('empty_or_html_attachment', 'download')
                extracted, _ = self.timed('tika', self.http.request, self.tika, 'PUT', data,
                                                 {'Accept': 'text/plain', 'Content-Type': mime or 'application/octet-stream'},
                                                 max_bytes=self.max_chars * 4)
                text = extracted.decode('utf-8', errors='strict').strip()
                if not text:
                    raise IngestError('empty_tika_text_ocr_may_be_required', 'tika')
                if len(text) > self.max_chars:
                    raise IngestError('document_character_budget_exceeded', 'tika')
                return text, {'name': name, 'method': 'tika', 'url': url, 'mime_type': mime,
                              'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                              'characters': len(text), 'fallback_errors': errors}
            except UnicodeError:
                errors.append({'code': 'invalid_utf8_tika_response', 'stage': 'tika'})
            except IngestError as e:
                errors.append({'code': e.code, 'stage': e.stage})
        raise IngestError('all_attachment_candidates_failed', 'attachment', errors)

    def content(self, record, detail):
        p = record['payload']
        name = p.get('file_name') or detail.get('title') or record['entity_id']
        media = p.get('media_urls', [])
        if not isinstance(media, list) or any(not isinstance(m, dict) or not isinstance(m.get('url'), str) for m in media):
            raise IngestError('unsupported_media_urls_schema', 'attachment')
        markdown = detail.get('markdownText') or detail.get('markdown_text')
        if markdown is not None and not isinstance(markdown, str):
            raise IngestError('invalid_markdown_schema', 'extraction')
        parts, evidence = [], []
        if markdown and markdown.strip():
            parts.append(markdown.strip())
            evidence.append({'name': name, 'method': 'source_markdown', 'characters': len(parts[0])})
        else:
            # Multiple media entries are distinct required attachments, not a
            # fallback list that would silently discard all but the first.
            urls = ([media[0]['url'], media[0].get('original_url')] if media else [])
            urls += [detail.get('downloadUrl'), detail.get('pdfUrl'), p.get('original_url')]
            text, extraction = self.download_text(urls, name)
            parts.append(text)
            evidence.append(extraction)
        # In the actual Limburg schema each snapshot Document IS an attachment;
        # these optional arrays support additional attachments if the API adds them.
        attachments = list(media[1:])
        for parent in (p, detail):
            if 'attachments' in parent:
                if not isinstance(parent['attachments'], list):
                    raise IngestError('unsupported_attachments_schema', 'attachment')
                attachments.extend(parent['attachments'])
        seen = {u for u in [detail.get('downloadUrl'), detail.get('pdfUrl'), p.get('original_url')]
                + ([media[0]['url'], media[0].get('original_url')] if media else []) if u}
        for a in attachments:
            if not isinstance(a, dict):
                raise IngestError('unsupported_attachment_schema', 'attachment')
            urls = [a.get('url'), a.get('downloadUrl'), a.get('download_url'), a.get('original_url')]
            key = next(filter(None, urls), None)
            if not key:
                raise IngestError('attachment_without_download_url', 'attachment')
            if key in seen:
                continue
            seen.add(key)
            text, extraction = self.download_text(urls, a.get('name') or a.get('file_name'))
            parts.append(text)
            evidence.append(extraction)
        text = '\n\n'.join(parts)
        if len(text) > self.max_chars:
            raise IngestError('document_character_budget_exceeded', 'extraction')
        return text, evidence

    def embed(self, text, title, model):
        with self.encoder_lock:
            if self.encoder is None:
                import tiktoken
                self.encoder = tiktoken.get_encoding('cl100k_base')
        # No truncation/chunk-count cap. Non-overlapping token windows ensure every
        # token contributes exactly once. Batches bound memory and provider limits.
        prefix = f'Titel: {title}\nOrganisatie: Limburg\n\nInhoud:\n'
        prefix_tokens = self.encoder.encode(prefix, disallowed_special=())[:512]
        tokens = self.encoder.encode(text, disallowed_special=())
        if not tokens:
            raise IngestError('empty_content', 'embedding')
        summed = [0.0] * DIMENSIONS
        total, count, batches = 0, 0, 0
        for start in range(0, len(tokens), 2000 * 8):
            windows = [tokens[i:i + 2000] for i in range(start, min(start + 16000, len(tokens)), 2000)]
            result = self.http.json(self.litellm + '/embeddings', 'POST',
                                    {'model': model, 'input': [prefix_tokens + w for w in windows], 'dimensions': DIMENSIONS},
                                    {'Authorization': 'Bearer ' + os.getenv('LITELLM_API_KEY', '')})
            rows = result.get('data')
            if not isinstance(rows, list) or len(rows) != len(windows):
                raise IngestError('embedding_batch_cardinality_mismatch', 'embedding')
            indexed = {}
            for row in rows:
                if not isinstance(row, dict) or type(row.get('index')) is not int or row['index'] in indexed:
                    raise IngestError('invalid_embedding_indices', 'embedding')
                indexed[row['index']] = row.get('embedding')
            if set(indexed) != set(range(len(windows))):
                raise IngestError('missing_embedding_index', 'embedding')
            for i, window in enumerate(windows):
                v = indexed[i]
                if (not isinstance(v, list) or len(v) != DIMENSIONS
                        or any(type(x) not in (int, float) or not math.isfinite(x) for x in v)):
                    raise IngestError('invalid_embedding_vector', 'embedding')
                weight = len(window)
                for dimension in range(DIMENSIONS):
                    summed[dimension] += v[dimension] * weight
                total += weight
                count += 1
            batches += 1
        norm = math.sqrt(sum((x / total) ** 2 for x in summed))
        if not math.isfinite(norm) or norm == 0:
            raise IngestError('zero_or_invalid_pooled_vector', 'embedding')
        return [x / total / norm for x in summed], {'chunk_count': count, 'embedding_batch_count': batches,
                                                   'embedding_tokens': total, 'pooling': 'token_weighted_mean_l2',
                                                   'embedding_model': model, 'embedding_dimensions': DIMENSIONS}

    def process(self, run, job):
        record = json.loads(job['record'])
        url = self.collection_url(run['collection']) + '/points'
        if record['op'] == 'delete':
            self.timed('upsert', self.http.json, url + '/delete?wait=true', 'POST', {'points': [point_id(record['entity_id'])]})
            return 'deleted'
        detail = self.timed('detail', self.detail, record['entity_id'])
        if detail['entityType'] != 'Document':
            raise IngestError('entity_is_not_document', 'entity_detail')
        p = record['payload']
        reference = p.get('is_referenced_by') or detail.get('meetingId')
        context = self.context(reference)
        text, extraction = self.content(record, detail)
        title = detail.get('title') or p.get('name') or record['entity_id']
        vector, stats = self.timed('embedding', self.embed, text, title, run['model'])
        payload = {
            'source_id': record['entity_id'], 'source_key': SOURCE, 'entity_type': 'Document',
            'title': title, 'organization': detail.get('organization') or p.get('organization'),
            'date': detail.get('sortDate') or p.get('last_discussed_at') or p.get('date_modified'),
            'meeting_id': detail.get('meetingId'), 'download_url': detail.get('downloadUrl'),
            'pdf_url': detail.get('pdfUrl'), 'file_name': p.get('file_name'),
            'classification': p.get('classification', []), 'last_discussed_at': p.get('last_discussed_at'),
            'referenced_by': reference, 'derived_content': p.get('derived_content', {}),
            'media_urls': p.get('media_urls', []), 'source_payload': p,
            'source_record': record, 'entity_detail': detail, 'reference_detail': context,
            'supplier': record.get('supplier'), 'commit_id': record.get('commit_id'),
            'content_hash': record.get('content_hash'), 'source_sequence': record.get('seq'),
            'source_operation': record.get('op'), 'source_time': record.get('time'),
            'schema_version': record.get('schema_version'), 'content_preview': text[:3000],
            'full_text': text, 'document_characters': len(text), 'text_truncated': False,
            'extraction': extraction, 'ingest_run_id': run['id'], 'indexed_at': now(), **stats,
            **public_links(record['entity_id'], reference, p.get('original_url'), p.get('public_url')),
        }
        ack = self.timed('upsert', self.http.json, url + '?wait=true', 'PUT', {'points': [{'id': point_id(record['entity_id']),
                                                                 'vector': vector, 'payload': payload}]})
        if ack.get('status') != 'ok' or ack.get('result', {}).get('status') != 'completed':
            raise IngestError('qdrant_upsert_not_completed', 'qdrant')
        return 'indexed'

    def task(self, run, job):
        self.local.timings = {}
        start = time.perf_counter()
        try:
            return self.process(run, job), None, self.local.timings, time.perf_counter() - start
        except Exception as error:
            e = error if isinstance(error, IngestError) else IngestError('unexpected_' + type(error).__name__, 'worker')
            return None, e, self.local.timings, time.perf_counter() - start
        finally:
            del self.local.timings

    def persist_task(self, run_id, job, future):
        outcome, error, timings, elapsed = future.result()
        with self.db:
            if error is None:
                self.db.execute('UPDATE documents SET status=?,error=NULL,evidence=NULL,updated_at=? WHERE run_id=? AND entity_id=?',
                                (outcome, now(), run_id, job['entity_id']))
            else:
                attempts = job['attempts'] + 1
                outcome = 'dead_letter' if attempts >= int(os.getenv('OBV_JOB_MAX_ATTEMPTS', '3')) else 'retry'
                self.db.execute('UPDATE documents SET status=?,error=?,evidence=?,next_attempt=?,updated_at=? WHERE run_id=? AND entity_id=?',
                                (outcome, json.dumps({'code': error.code, 'stage': error.stage}), json.dumps(error.evidence),
                                 time.time() + min(3600, 60 * 2 ** (attempts - 1)), now(), run_id, job['entity_id']))
            self.db.execute('UPDATE runs SET updated_at=? WHERE id=?', (now(), run_id))
        print(json.dumps({'entity_id': job['entity_id'], 'outcome': outcome,
                          'elapsed_seconds': elapsed, 'timings_seconds': timings}), flush=True)

    def execute(self, run_id, max_documents=5, max_pages=5, page_size=20, approve=False, workers=None):
        workers = int(os.getenv('OBV_WORKERS', '2')) if workers is None else workers
        if not 1 <= workers <= 4:
            raise IngestError('workers_must_be_between_1_and_4')
        if not 1 <= page_size <= 100 or max_documents < 1 or max_pages < 1:
            raise IngestError('invalid_execution_bounds')
        if (max_documents > 10 or max_pages > 10) and not approve:
            raise IngestError('large_run_requires_approve_full_run')
        start = time.perf_counter()
        self.metrics = {stage: {'calls': 0, 'seconds': 0.0}
                        for stage in ('source', 'detail', 'attachment', 'tika', 'embedding', 'upsert')}
        run = self.run_info(run_id)
        self.validate_collection(run)
        # Previous process died after claiming work: the kernel lock proves it is
        # no longer running; deterministic Qdrant IDs make replay idempotent.
        with self.db:
            self.db.execute("UPDATE documents SET status='pending' WHERE run_id=? AND status='processing'", (run_id,))
        processed, fetched, submitted, peak = 0, 0, 0, 0
        outstanding = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers, thread_name_prefix='obv') as pool:
            try:
                while submitted < max_documents or outstanding:
                    # Drain acknowledgements before fetching another page. At most
                    # workers jobs are claimed/inflight; no unbounded executor queue.
                    for future in list(outstanding):
                        if future.done():
                            self.persist_task(run_id, outstanding[future], future)
                            del outstanding[future]
                            processed += 1
                    self.flush_contexts()
                    if submitted >= max_documents or len(outstanding) >= workers:
                        if outstanding:
                            concurrent.futures.wait(outstanding, return_when=concurrent.futures.FIRST_COMPLETED)
                        elif submitted >= max_documents:
                            break
                        continue
                    job = self.db.execute("""SELECT * FROM documents WHERE run_id=? AND status IN ('pending','retry')
                        AND next_attempt<=? ORDER BY entity_id LIMIT 1""", (run_id, time.time())).fetchone()
                    if job:
                        job = dict(job)
                        with self.db:
                            self.db.execute("UPDATE documents SET status='processing',attempts=attempts+1,updated_at=? WHERE run_id=? AND entity_id=?",
                                            (now(), run_id, job['entity_id']))
                        outstanding[pool.submit(self.task, run, job)] = job
                        submitted += 1
                        peak = max(peak, len(outstanding))
                        continue
                    run = self.run_info(run_id)
                    if not run['snapshot_complete'] and fetched < max_pages:
                        self.page(run, min(page_size, max_documents - submitted))
                        fetched += 1
                    elif outstanding:
                        concurrent.futures.wait(outstanding, return_when=concurrent.futures.FIRST_COMPLETED)
                    else:
                        break
            finally:
                # A page/rate/validation error must not discard successful sibling
                # tasks. Stop scheduling, wait for the bounded set, persist every
                # outcome, then propagate the original coordinator exception.
                pool.shutdown(wait=True)
                for future, job in list(outstanding.items()):
                    self.persist_task(run_id, job, future)
                    del outstanding[future]
                    processed += 1
                self.flush_contexts()
        result = self.status(run_id)
        elapsed = time.perf_counter() - start
        result.update({'session_processed': processed, 'session_pages': fetched,
                       'performance': {'workers': workers, 'peak_inflight': peak, 'elapsed_seconds': elapsed,
                                       'documents_per_second': processed / elapsed, 'stages': self.metrics}})
        return result

    def retry(self, run_id, entity_id=None):
        self.run_info(run_id)
        with self.db:
            sql = "UPDATE documents SET status='pending',attempts=0,next_attempt=0 WHERE run_id=? AND status IN ('retry','dead_letter')"
            args = [run_id]
            if entity_id:
                sql += ' AND entity_id=?'
                args.append(entity_id)
            count = self.db.execute(sql, args).rowcount
        return {'requeued': count, 'run_id': run_id}

    def status(self, run_id=None):
        runs = [self.run_info(run_id)] if run_id else [dict(r) for r in self.db.execute('SELECT * FROM runs')]
        for run in runs:
            counts = dict(self.db.execute('SELECT status,count(*) FROM documents WHERE run_id=? GROUP BY status', (run['id'],)))
            run['counts'] = counts
            run['complete'] = bool(run['snapshot_complete'] and not any(counts.get(s, 0) for s in ('pending', 'processing', 'retry', 'dead_letter')))
            run['failures'] = [dict(r) for r in self.db.execute("SELECT entity_id,status,attempts,error,evidence FROM documents WHERE run_id=? AND status IN ('retry','dead_letter') LIMIT 20", (run['id'],))]
        return {'runs': runs}

    def failures(self, run_id, limit=100, offset=0):
        self.run_info(run_id)
        if not 1 <= limit <= 1000 or offset < 0:
            raise IngestError('invalid_failure_listing_bounds')
        rows = self.db.execute("""SELECT entity_id,status,attempts,error,evidence,next_attempt,updated_at
            FROM documents WHERE run_id=? AND status IN ('retry','dead_letter')
            ORDER BY entity_id LIMIT ? OFFSET ?""", (run_id, limit, offset))
        return {'run_id': run_id, 'limit': limit, 'offset': offset, 'failures': [dict(r) for r in rows]}

    def verify(self, run_id, sample_size=10, query=None):
        """Read-only count and bounded payload/vector verification. Never switches aliases."""
        if not 1 <= sample_size <= 100:
            raise IngestError('invalid_verification_sample_size')
        run = self.run_info(run_id)
        self.validate_collection(run)
        url = self.collection_url(run['collection']) + '/points'
        count = self.http.json(url + '/count', 'POST', {'exact': True,
                              'filter': {'must': [{'key': 'ingest_run_id', 'match': {'value': run_id}}]}})
        actual = count.get('result', {}).get('count')
        expected = self.db.execute("SELECT count(*) FROM documents WHERE run_id=? AND status='indexed'", (run_id,)).fetchone()[0]
        if actual != expected:
            raise IngestError('qdrant_and_checkpoint_count_mismatch', 'verification')
        jobs = self.db.execute("SELECT entity_id,record FROM documents WHERE run_id=? AND status='indexed' ORDER BY entity_id LIMIT ?",
                               (run_id, sample_size)).fetchall()
        ids = [point_id(j['entity_id']) for j in jobs]
        points = self.http.json(url, 'POST', {'ids': ids, 'with_payload': True, 'with_vector': True}).get('result', []) if ids else []
        if not isinstance(points, list) or len(points) != len(jobs):
            raise IngestError('verification_missing_points', 'verification')
        by_id = {p.get('id'): p for p in points}
        samples = []
        for job in jobs:
            point = by_id.get(point_id(job['entity_id']), {})
            p, v = point.get('payload', {}), point.get('vector', [])
            if (p.get('source_record') != json.loads(job['record']) or p.get('source_id') != job['entity_id']
                    or p.get('source_payload') != json.loads(job['record'])['payload']
                    or p.get('entity_detail', {}).get('entityId') != job['entity_id']
                    or not p.get('full_text') or p.get('document_characters') != len(p['full_text'])
                    or p.get('text_truncated') is not False or not p.get('extraction')
                    or len(v) != DIMENSIONS or any(not math.isfinite(x) for x in v)
                    or abs(sum(x*x for x in v) - 1) > 0.001):
                raise IngestError('verification_payload_or_vector_mismatch', 'verification')
            samples.append({'entity_id': job['entity_id'], 'characters': p['document_characters'],
                            'methods': [e['method'] for e in p['extraction']], 'chunks': p['chunk_count'],
                            'dimensions': len(v), 'metadata_exact': True})
        result = {'run_id': run_id, 'collection': run['collection'], 'qdrant_count': actual,
                  'checkpoint_indexed': expected, 'samples': samples}
        if query:
            vector, _ = self.embed(query, 'Verification query', run['model'])
            hits = self.http.json(url + '/query', 'POST', {'query': vector, 'limit': 5, 'with_payload': ['source_id', 'title']})
            result['query_hits'] = [{'entity_id': p['payload'].get('source_id'), 'score': p['score']}
                                    for p in hits.get('result', {}).get('points', [])]
            if not result['query_hits'] and expected:
                raise IngestError('verification_query_returned_no_results', 'verification')
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', default=os.getenv('OBV_STATE_DIR', '/state'))
    sub = parser.add_subparsers(dest='command', required=True)
    fresh = sub.add_parser('fresh', help='create new isolated collection; does NOT ingest')
    fresh.add_argument('--run-id', required=True)
    fresh.add_argument('--collection', required=True)
    run = sub.add_parser('run', help='bounded processing; same command resumes')
    run.add_argument('--run-id', required=True)
    run.add_argument('--max-documents', type=int, default=5)
    run.add_argument('--max-pages', type=int, default=5)
    run.add_argument('--page-size', type=int, default=20)
    run.add_argument('--workers', type=int, help='1..4 document pipelines; default OBV_WORKERS or 2')
    run.add_argument('--approve-full-run', action='store_true')
    status = sub.add_parser('status')
    status.add_argument('--run-id')
    retry = sub.add_parser('retry', help='requeue failures, without processing them')
    retry.add_argument('--run-id', required=True)
    retry.add_argument('--entity-id')
    failures = sub.add_parser('failures', help='read-only paginated retry/dead-letter listing')
    failures.add_argument('--run-id', required=True)
    failures.add_argument('--limit', type=int, default=100)
    failures.add_argument('--offset', type=int, default=0)
    verify = sub.add_parser('verify', help='read-only count and bounded complete metadata/vector check')
    verify.add_argument('--run-id', required=True)
    verify.add_argument('--sample-size', type=int, default=10)
    verify.add_argument('--query', help='optional small embedding + Qdrant retrieval smoke check')
    args = parser.parse_args()
    try:
        # status can run concurrently. Every mutation uses one global kernel lock.
        guard = contextlib.nullcontext() if args.command in ('status', 'failures', 'verify') else lock(Path(args.state_dir))
        with guard:
            w = Worker(args.state_dir)
            try:
                if args.command == 'fresh':
                    result = w.fresh(args.run_id, args.collection)
                elif args.command == 'run':
                    result = w.execute(args.run_id, args.max_documents, args.max_pages, args.page_size, args.approve_full_run, args.workers)
                elif args.command == 'retry':
                    result = w.retry(args.run_id, args.entity_id)
                elif args.command == 'failures':
                    result = w.failures(args.run_id, args.limit, args.offset)
                elif args.command == 'verify':
                    result = w.verify(args.run_id, args.sample_size, args.query)
                else:
                    result = w.status(args.run_id)
                print(json.dumps(result, ensure_ascii=False, indent=2))
            finally:
                w.db.close()
    except IngestError as error:
        print(json.dumps({'error': error.code, 'stage': error.stage}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
