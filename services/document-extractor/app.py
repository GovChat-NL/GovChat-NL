"""Independently owned LibreChat extraction-protocol adapter, not a RAG server.

Tika-only upload extraction; LibreChat owns persisted text and retention.
No document cache, URL-source route, tenant store, embedding or native-byte path.
"""
import asyncio
import json
import os
import pathlib
import re
import sys
import tempfile
import time
import unicodedata
from contextlib import asynccontextmanager
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
import jwt
from fastapi import FastAPI, HTTPException, Request
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

HERE = pathlib.Path(__file__).resolve().parent
MiB = 1024 * 1024


@dataclass(frozen=True)
class Settings:
    secret: str
    tika_url: str = 'http://govchat-upload-tika:9998'
    scratch: str = '/tmp'
    max_input: int = 12 * MiB
    max_output: int = 15 * MiB
    max_pages: int = 60
    deadline: float = 270
    min_meaningful_ratio: float = 0.10
    max_replacement_ratio: float = 0.20
    max_control_ratio: float = 0.10

    def __post_init__(self):
        if len(self.secret) < 32:
            raise ValueError('JWT secret must be at least 32 characters')
        if not (0 < self.max_input <= 12 * MiB and 0 < self.max_output <= 15 * MiB):
            raise ValueError('byte limits outside safety envelope')
        if not (1 <= self.max_pages <= 60 and 1 <= self.deadline <= 270):
            raise ValueError('page/time limits outside safety envelope')
        if not (0 < self.min_meaningful_ratio <= 1 and
                0 <= self.max_replacement_ratio <= 0.20 and
                0 <= self.max_control_ratio <= 0.10):
            raise ValueError('text quality limits outside safety envelope')
        for url in (self.tika_url,):
            p = urlsplit(url)
            if p.scheme != 'http' or p.hostname != 'govchat-upload-tika' or p.port != 9998 or p.path not in {'', '/'}:
                raise ValueError('only fixed private parser origins are supported')
            if p.username or p.password or p.query or p.fragment:
                raise ValueError('invalid parser origin')

    @classmethod
    def from_env(cls):
        return cls(secret=os.environ['JWT_SECRET'], scratch=os.getenv('TMPDIR', '/tmp'),
            min_meaningful_ratio=float(os.getenv('TEXT_MIN_MEANINGFUL_RATIO', '0.10')),
            max_replacement_ratio=float(os.getenv('TEXT_MAX_REPLACEMENT_RATIO', '0.20')),
            max_control_ratio=float(os.getenv('TEXT_MAX_CONTROL_RATIO', '0.10')))


def authenticate(value, secret):
    if not isinstance(value, str) or not value.startswith('Bearer ') or len(value) > 4096:
        raise HTTPException(401, 'invalid_extraction_token')
    try:
        claims = jwt.decode(value[7:], secret, algorithms=['HS256'],
                            options={'require': ['id', 'iat', 'exp']})
        if not isinstance(claims['id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', claims['id']):
            raise ValueError()
        if type(claims['iat']) is not int or type(claims['exp']) is not int:
            raise ValueError()
        if not 0 < claims['exp'] - claims['iat'] <= 300 or claims.get('scope'):
            raise ValueError()
        return claims['id']
    except (jwt.PyJWTError, ValueError, TypeError):
        raise HTTPException(401, 'invalid_extraction_token') from None


def load_routes(path=HERE / 'routes.json'):
    routes = json.loads(path.read_text())
    expected = {'pdf', 'docx', 'pptx', 'xlsx', 'msg', 'eml', 'odt', 'doc', 'rtf'}
    if set(routes) != expected:
        raise ValueError('unsupported routing keys')
    seen = set()
    for ext, route in routes.items():
        if route['parser'] != 'tika' or not route['mimes']:
            raise ValueError('format route cannot change fidelity')
        for mime in route['mimes']:
            if not re.fullmatch(r'[a-z0-9.+-]+/[a-z0-9.+-]+', mime) or mime in seen:
                raise ValueError('ambiguous MIME route')
            seen.add(mime)
    return routes


def select_route(filename, mime, routes):
    if not filename or '/' in filename or '\\' in filename or '\x00' in filename:
        raise HTTPException(415, 'invalid_filename')
    ext = pathlib.Path(filename).suffix.lower().lstrip('.')
    native = json.loads((HERE / 'native-text.json').read_text())
    if ext in native:
        routes = {**routes, ext: {'mimes': native[ext], 'parser': 'native'}}
    if ext not in routes:
        raise HTTPException(415, 'unsupported_format')
    mime = (mime or '').split(';', 1)[0].strip().lower()
    # LibreChat form-data derives MIME from a stream's extension, not original upload MIME.
    # Generic transport MIME is accepted ONLY with a known extension + binary preflight.
    if mime not in routes[ext]['mimes'] and mime != 'application/octet-stream':
        raise HTTPException(415, 'mime_extension_mismatch')
    return ext, routes[ext]['parser']


class UnreadableText(HTTPException):
    """Only this completed-result quality failure permits one PDF OCR recovery."""
    def __init__(self):
        super().__init__(422, 'unreadable_extraction')


def text_quality(text):
    """Counts only: never store/log payloads. Unicode L/N preserves Dutch and numbers."""
    return {
        'meaningful': sum(unicodedata.category(c)[0] in {'L', 'N'} for c in text),
        'nonspace': sum(not c.isspace() for c in text),
        'replacement': text.count('\ufffd'),
        'control': sum(unicodedata.category(c) == 'Cc' and c not in '\t\n\r' for c in text),
    }


def checked_text(text, cap, settings=None):
    if not isinstance(text, str):
        raise HTTPException(422, 'empty_or_invalid_extraction')
    if len(text.encode('utf-8')) > cap:
        raise HTTPException(413, 'extracted_text_limit')
    q = text_quality(text)
    denominator = max(1, q['nonspace'])
    if (not q['meaningful'] or '\x00' in text or
        q['meaningful'] / denominator < (settings.min_meaningful_ratio if settings else 0.10) or
        q['replacement'] / denominator > (settings.max_replacement_ratio if settings else 0.20) or
        q['control'] / denominator > (settings.max_control_ratio if settings else 0.10)):
        raise UnreadableText()
    return text


def tika_text(result, cap, pages=None, settings=None):
    if not isinstance(result, list) or not result or len(result) > 256:
        raise HTTPException(422, 'invalid_tika_result')
    if pages is not None:
        try:
            if int(result[0].get('xmpTPg:NPages', -1)) != pages:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, 'pdf_page_count_mismatch') from None
        if str(result[0].get('pdf:encrypted', 'false')).lower() == 'true':
            raise HTTPException(422, 'encrypted_document')
    parts = []
    for record in result:
        if not isinstance(record, dict):
            raise HTTPException(422, 'invalid_tika_record')
        for key in record:
            if key.startswith(('X-TIKA:EXCEPTION', 'X-TIKA:WARN')) or key in {
                'X-TIKA:write_limit_reached', 'X-TIKA:embedded_resource_limit_reached',
                'X-TIKA:parse_time_millis:timeout'}:
                raise HTTPException(422, 'tika_partial_or_failed')
        text = record.get('X-TIKA:content', '')
        if not isinstance(text, str):
            raise HTTPException(422, 'invalid_tika_content')
        parts.append(text)
    return checked_text('\n\n'.join(parts), cap, settings)


class ParserClient:
    def __init__(self, settings, client, fault, metrics=None):
        self.s, self.client, self.fault = settings, client, fault
        self.metrics = metrics if metrics is not None else {
            'quality_rejections': 0, 'ocr_recovery_attempts': 0,
            'ocr_recovery_successes': 0, 'ocr_recovery_failures': 0}

    async def json(self, method, url, **kwargs):
        async with self.client.stream(method, url, **kwargs) as response:
            response.raise_for_status()
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > self.s.max_output + 8 * MiB:
                    self.fault('parser_work_termination_unproven')
                    raise HTTPException(413, 'parser_response_limit')
            try:
                return json.loads(body)
            except (ValueError, UnicodeError):
                raise HTTPException(502, 'invalid_parser_json') from None

    async def ready(self):
        t = await self.client.get(self.s.tika_url + '/version')
        return t.status_code == 200 and t.text.strip().startswith('Apache Tika 3.2.3')

    async def convert(self, path, ext, parser, pages, deadline):
        async def attempt(ocr_only=False):
            remaining = deadline - time.monotonic()
            # Tika's minimum is 1000 ms. Reserve time for response/cleanup;
            # neither parser jobs nor the outer admission deadline are renewed.
            if remaining <= 1.5:
                raise HTTPException(503, 'extraction_deadline_exhausted')
            headers = {'Content-Type': load_routes()[ext]['mimes'][0],
                       'Accept': 'application/json', 'writeLimit': str(self.s.max_output),
                       'maxEmbeddedResources': '255',
                       'X-Tika-Timeout-Millis': str(min(240000, int((remaining - 0.5) * 1000)))}
            if ocr_only:
                # Standard Tika 3.2.3 PDFParserConfig: OCR_ONLY -> OCR2XHTML,
                # not OCR_AND_TEXT_EXTRACTION (which would retain the bad layer).
                headers['X-Tika-PDFOcrStrategy'] = 'ocr_only'
            with path.open('rb') as file:
                result = await self.json('PUT', self.s.tika_url + '/rmeta/text',
                    content=file.read(), headers=headers, timeout=min(250, remaining))
            return tika_text(result, self.s.max_output, pages, self.s)

        try:
            try:
                return await attempt()
            except UnreadableText:
                self.metrics['quality_rejections'] += 1
                if ext != 'pdf' or pages is None:
                    raise
            self.metrics['ocr_recovery_attempts'] += 1
            try:
                recovered = await attempt(ocr_only=True)
            except BaseException:
                self.metrics['ocr_recovery_failures'] += 1
                raise
            self.metrics['ocr_recovery_successes'] += 1
            return recovered
        except httpx.HTTPStatusError as error:
            if error.response.status_code in {400, 415, 422}:
                raise HTTPException(422, 'unreadable_or_unsupported_document') from None
            self.fault('parser_work_termination_unproven')
            raise HTTPException(503, 'parser_work_termination_unproven') from None


async def preflight(path, extension, pages, deadline=None):
    budget = 30 if deadline is None else min(30, deadline - time.monotonic())
    if budget <= 0:
        raise HTTPException(503, 'document_validation_timeout')
    proc = await asyncio.create_subprocess_exec(sys.executable, str(HERE / 'preflight.py'),
        str(path), extension, str(pages), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        async with asyncio.timeout(budget):
            stdout, _ = await proc.communicate()
        if proc.returncode or len(stdout) > 1024:
            raise HTTPException(422, 'invalid_or_unsupported_document')
        return json.loads(stdout)['pages']
    except TimeoutError:
        raise HTTPException(503, 'document_validation_timeout') from None
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()


class Admission:
    """Pure ASGI admission: bounds real bytes before spooling and owns task lifetime."""
    def __init__(self, app, settings, state):
        self.app, self.s, self.state = app, settings, state

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['path'] != '/text':
            return await self.app(scope, receive, send)
        headers = dict(scope['headers'])
        admitted = False
        waiting = False
        total = 0

        async def bounded_receive():
            nonlocal total
            message = await receive()
            total += len(message.get('body', b''))
            if total > self.s.max_input + 64 * 1024:
                raise HTTPException(413, 'upload_limit')
            return message

        try:
            authenticate(headers.get(b'authorization', b'').decode('latin1'), self.s.secret)
            if self.state['fault']:
                raise HTTPException(503, self.state['fault'])
            if self.state['waiting'] >= 3:
                raise HTTPException(429, 'extractor_busy')
            length = headers.get(b'content-length', b'')
            if not length.isdigit():
                raise HTTPException(411, 'content_length_required')
            if int(length) > self.s.max_input + 64 * 1024:
                raise HTTPException(413, 'upload_limit')
            scope.setdefault('state', {}).update(
                extraction_deadline=time.monotonic() + self.s.deadline, parser_started=False)
            try:
                async with asyncio.timeout(self.s.deadline):
                    # Queue at most three callers without reading/spooling their bodies.
                    # Waiting uses the original deadline, not a renewed parser budget.
                    self.state['waiting'] += 1
                    waiting = True
                    await self.state['lock'].acquire()
                    self.state['waiting'] -= 1
                    waiting = False
                    self.state['active'] = admitted = True
                    if self.state['fault']:
                        raise HTTPException(503, self.state['fault'])
                    # Bound the transport before the multipart library can open
                    # spool files. Memory is bounded by input + framing cap.
                    body = bytearray()
                    while True:
                        message = await bounded_receive()
                        if message['type'] == 'http.disconnect':
                            raise HTTPException(400, 'upload_disconnected')
                        body.extend(message.get('body', b''))
                        if not message.get('more_body', False):
                            break
                    delivered = False
                    async def buffered_receive():
                        nonlocal delivered
                        if delivered:
                            return {'type': 'http.request', 'body': b'', 'more_body': False}
                        delivered = True
                        return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
                    await self.app(scope, buffered_receive, send)
            except TimeoutError:
                if scope['state']['parser_started']:
                    self.state['fault'] = 'timeout_work_termination_unproven'
                raise HTTPException(503, self.state['fault'] or 'extraction_deadline_exhausted') from None
        except HTTPException as error:
            response = JSONResponse({'detail': error.detail}, status_code=error.status_code)
            await response(scope, receive, send)
        finally:
            if waiting:
                self.state['waiting'] -= 1
            if admitted:
                self.state['active'] = False
                self.state['lock'].release()


def create_app(settings=None, transport=None):
    s = settings or Settings.from_env()
    routes = load_routes()
    state = {'active': False, 'fault': None, 'waiting': 0, 'lock': asyncio.Lock()}
    metrics = {'quality_rejections': 0, 'ocr_recovery_attempts': 0,
               'ocr_recovery_successes': 0, 'ocr_recovery_failures': 0}

    def fault(code):
        state['fault'] = code

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False,
                                     transport=transport, limits=httpx.Limits(max_connections=2)) as client:
            app.state.parser = ParserClient(s, client, fault, metrics)
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.safety = state

    app.add_middleware(Admission, settings=s, state=state)

    @app.get('/health')
    async def health():
        if state['fault']:
            raise HTTPException(503, state['fault'])
        try:
            if not await app.state.parser.ready():
                raise ValueError()
        except Exception:
            raise HTTPException(503, 'parsers_not_ready') from None
        return {'status': 'ok', 'parser': 'tika', 'cancellation_validated': False,
                'quality_recovery': metrics.copy()}

    @app.post('/text')
    async def text(request: Request):
        # No caller-supplied parser options, upstream URLs, tenant IDs or document fetches.
        try:
            if request.query_params:
                raise HTTPException(400, 'query_options_unsupported')
            async with request.form(max_files=1, max_fields=1, max_part_size=1024) as form:
                if set(form) != {'file', 'file_id'} or len(form.multi_items()) != 2:
                    raise HTTPException(400, 'invalid_multipart_contract')
                upload = form['file']
                file_id = form['file_id']
                if not isinstance(file_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', file_id):
                    raise HTTPException(400, 'invalid_file_id')
                ext, parser = select_route(getattr(upload, 'filename', None),
                                           getattr(upload, 'content_type', None), routes)
                if not 0 < (upload.size or 0) <= s.max_input:
                    raise HTTPException(413, 'upload_limit')
                with tempfile.TemporaryDirectory(prefix='extract-', dir=s.scratch) as scratch:
                    path = pathlib.Path(scratch) / ('document.' + ext)
                    with path.open('xb') as output:
                        while chunk := await upload.read(64 * 1024):
                            output.write(chunk)
                    if parser == 'native':
                        try:
                            content = path.read_bytes().decode('utf-8-sig', errors='strict')
                        except UnicodeError:
                            raise HTTPException(422, 'invalid_text_encoding') from None
                        if content.startswith(('%PDF-', 'PK\x03\x04')):
                            raise HTTPException(415, 'binary_text_mismatch')
                        return {'text': checked_text(content, s.max_output, s)}
                    pages = await preflight(path, ext, s.max_pages, request.state.extraction_deadline)
                    try:
                        request.state.parser_started = True
                        result = await app.state.parser.convert(path, ext, parser, pages,
                                                                request.state.extraction_deadline)
                    except (httpx.HTTPError, TimeoutError, asyncio.CancelledError):
                        fault('parser_work_termination_unproven')
                        raise HTTPException(503, state['fault']) from None
                    return {'text': result}  # Exact LibreChat contract; errors never masquerade as text.
        except HTTPException:
            raise
        except StarletteHTTPException:
            raise HTTPException(400, 'invalid_multipart_contract') from None
        except Exception:
            raise HTTPException(422, 'invalid_document_request') from None


    return app
