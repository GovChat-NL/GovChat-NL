import importlib.util
import pathlib
import time

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient
from fixtures import pdf

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('extractor', ROOT / 'services/document-extractor/app.py')
e = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = e
spec.loader.exec_module(e)
SECRET = 'synthetic-contract-test-secret-000000000000'


def token(**changes):
    claims = {'id': 'synthetic-owner', 'iat': int(time.time()), 'exp': int(time.time()) + 300}
    claims.update(changes)
    return 'Bearer ' + jwt.encode(claims, SECRET, algorithm='HS256')


@pytest.fixture
def client(tmp_path):
    calls = []
    result = [{'X-TIKA:content': 'Gemeente financiële 12345,67', 'xmpTPg:NPages': '2'}]
    def fake(request):
        calls.append(request)
        if request.url.path == '/version':
            return httpx.Response(200, text='Apache Tika 3.2.3')
        return httpx.Response(200, json=result)
    app = e.create_app(e.Settings(secret=SECRET, scratch=str(tmp_path)), httpx.MockTransport(fake))
    with TestClient(app) as c:
        c.calls, c.result, c.scratch = calls, result, tmp_path
        yield c


def upload(c, data=None, filename='x.pdf', mime='application/pdf', auth=None):
    return c.post('/text', headers={'Authorization': auth or token()},
        data={'file_id': 'synthetic-file'}, files={'file': (filename, pdf() if data is None else data, mime)})


@pytest.mark.parametrize('changes', [{'exp': 1}, {'iat': int(time.time()) + 60}, {'id': '../owner'},
    {'id': 42}, {'scope': 'agent_trigger'}, {'exp': int(time.time()) + 600}])
def test_invalid_auth_before_body(client, changes):
    assert upload(client, auth=token(**changes)).status_code == 401
    assert not client.calls


def test_missing_auth(client):
    assert client.post('/text', content=b'x').status_code == 401


def test_once_native_parser_and_cleanup(client):
    r = upload(client)
    assert r.status_code == 200 and r.json() == {'text': client.result[0]['X-TIKA:content']}
    assert [x.url.path for x in client.calls] == ['/rmeta/text']
    assert client.calls[0].headers['X-Tika-Timeout-Millis'] == '240000'
    assert not list(client.scratch.iterdir())
    assert client.get('/health').status_code == 200


@pytest.mark.parametrize('ext', ['pdf', 'docx', 'pptx', 'xlsx', 'msg', 'eml', 'odt', 'doc', 'rtf'])
def test_routes(ext):
    routes = e.load_routes()
    assert e.select_route('x.' + ext, 'application/octet-stream', routes) == (ext, 'tika')


@pytest.mark.parametrize('key', ['X-TIKA:EXCEPTION:runtime', 'X-TIKA:WARN:parse',
    'X-TIKA:write_limit_reached', 'X-TIKA:embedded_resource_limit_reached', 'X-TIKA:parse_time_millis:timeout'])
def test_partial_rejected(client, key):
    client.result[0][key] = 'true'
    r = upload(client)
    assert r.status_code == 422 and 'text' not in r.json()
    assert len(client.calls) == 1
    assert not list(client.scratch.iterdir())


def test_empty_rejected(client):
    client.result[0]['X-TIKA:content'] = ''
    assert upload(client).status_code == 422


@pytest.mark.parametrize('data,filename,mime,status', [(b'bad', 'x.pdf', 'application/pdf', 422),
    (b'bad', '../x.pdf', 'application/pdf', 415), (b'bad', 'x.docx', 'application/pdf', 415),
    (b'bad', 'x.exe', 'application/octet-stream', 415),
    (b'%PDF-binary', 'x.txt', 'text/plain', 415)])
def test_invalid_input(client, data, filename, mime, status):
    assert upload(client, data, filename, mime).status_code == status
    assert not client.calls


def test_limits_busy_and_contract(client):
    assert client.post('/text', headers={'Authorization': token(), 'Content-Length': str(13 * e.MiB)}, content=b'x').status_code == 413
    client.app.state.safety['active'] = True
    assert upload(client).status_code == 429
    client.app.state.safety['active'] = False
    assert client.post('/text', headers={'Authorization': token()}, data={'url': 'http://invalid'}).status_code == 400
    assert upload(client, pdf(pages=61)).status_code == 422


def test_native_text_preserved(client):
    assert upload(client, b'hello 12345,67', 'x.csv', 'text/csv').json() == {'text': 'hello 12345,67'}
    assert not client.calls


def test_output_cap():
    with pytest.raises(e.HTTPException):
        e.tika_text([{'X-TIKA:content': 'abc'}], 2)


def test_pdf_page_count_required():
    with pytest.raises(e.HTTPException):
        e.tika_text([{'X-TIKA:content': 'abc', 'xmpTPg:NPages': '1'}], 100, 2)


def test_encrypted_pdf(client):
    import io
    from pypdf import PdfReader, PdfWriter
    writer = PdfWriter()
    writer.append(PdfReader(io.BytesIO(pdf())))
    writer.encrypt('synthetic-password')
    output = io.BytesIO()
    writer.write(output)
    assert upload(client, output.getvalue()).status_code == 422
    assert not client.calls


@pytest.mark.parametrize('status', [400, 415, 422, 500, 503])
def test_native_http_error_cleanup(tmp_path, status):
    def fake(request):
        return httpx.Response(status, text='native parser error')
    app = e.create_app(e.Settings(secret=SECRET, scratch=str(tmp_path)), httpx.MockTransport(fake))
    with TestClient(app) as c:
        response = upload(c)
        assert response.status_code == (422 if status in {400, 415, 422} else 503)
        assert 'text' not in response.json()
        assert not list(tmp_path.iterdir())
        if status >= 500:
            assert c.get('/health').status_code == 503


def test_transport_failure_fails_closed(tmp_path):
    def fake(request):
        raise httpx.ReadTimeout('synthetic timeout', request=request)
    app = e.create_app(e.Settings(secret=SECRET, scratch=str(tmp_path)), httpx.MockTransport(fake))
    with TestClient(app) as c:
        assert upload(c).status_code == 503
        assert c.get('/health').status_code == 503
        assert not list(tmp_path.iterdir())


# Entirely synthetic unreadable output; no document-derived counts or text.
GARBAGE = '\ufffd' * 6000 + ' ' * 1000


@pytest.mark.parametrize('text', ['één financiële zienswijze – naïef', '13', 'a',
    'Jaar,Bedrag\n2026,12345.67\n', 'العربية ١٣', '東京 13', 'tekst\ufffd'])
def test_unicode_short_numeric_and_csv_quality(text):
    assert e.checked_text(text, 1000) == text


@pytest.mark.parametrize('text', [GARBAGE, '', ' \n\t', '\x01' * 20 + 'abc',
    'abc\x00', 'abc' + '\ufffd' * 20, '!' * 200 + 'a', '\x7f' * 20])
def test_unreadable_quality(text):
    with pytest.raises(e.UnreadableText):
        e.checked_text(text, 30000)


def test_quality_metadata_contains_only_counts():
    assert e.text_quality(GARBAGE) == {
        'meaningful': 0, 'nonspace': 6000, 'replacement': 6000, 'control': 0}


def recovery_client(tmp_path, results, deadline=270):
    calls = []
    async def fake(request):
        if request.url.path == '/version':
            return httpx.Response(200, text='Apache Tika 3.2.3')
        calls.append(request)
        value = results[min(len(calls) - 1, len(results) - 1)]
        if callable(value):
            value = await value(request)
        if isinstance(value, Exception):
            raise value
        if isinstance(value, httpx.Response):
            return value
        return httpx.Response(200, json=[{'X-TIKA:content': value, 'xmpTPg:NPages': '2'}])
    app = e.create_app(e.Settings(secret=SECRET, scratch=str(tmp_path), deadline=deadline),
                       httpx.MockTransport(fake))
    return app, calls


def test_pdf_quality_one_recovery_same_bytes(tmp_path):
    app, calls = recovery_client(tmp_path, [GARBAGE, 'Herstelde financiële tabel 12345,67'])
    with TestClient(app) as c:
        r = upload(c)
        assert r.status_code == 200 and '\ufffd' not in r.json()['text']
        assert len(calls) == 2 and calls[0].content == calls[1].content
        assert 'X-Tika-PDFOcrStrategy' not in calls[0].headers
        assert calls[1].headers['X-Tika-PDFOcrStrategy'] == 'ocr_only'
        assert c.get('/health').json()['quality_recovery'] == {
            'quality_rejections': 1, 'ocr_recovery_attempts': 1,
            'ocr_recovery_successes': 1, 'ocr_recovery_failures': 0}
        assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('second', [GARBAGE, '', httpx.Response(500),
    httpx.Response(401), httpx.Response(400), httpx.Response(200, content=b'bad json'),
    httpx.ReadTimeout('synthetic recovery timeout')])
def test_failed_recovery_no_third_attempt_or_error_text(tmp_path, second):
    app, calls = recovery_client(tmp_path, [GARBAGE, second])
    with TestClient(app) as c:
        r = upload(c)
        assert r.status_code >= 400 and 'text' not in r.json()
        assert len(calls) == 2 and not list(tmp_path.iterdir())
        assert app.state.parser.metrics['ocr_recovery_failures'] == 1
        if isinstance(second, httpx.ReadTimeout) or (
            isinstance(second, httpx.Response) and second.status_code in {500, 401}):
            assert c.get('/health').status_code == 503


def test_docx_quality_does_not_force_ocr(tmp_path, monkeypatch):
    async def valid(*args):
        return None
    monkeypatch.setattr(e, 'preflight', valid)
    app, calls = recovery_client(tmp_path, [GARBAGE, 'must not run'])
    with TestClient(app) as c:
        assert upload(c, b'synthetic', 'x.docx',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document').status_code == 422
        assert len(calls) == 1 and not list(tmp_path.iterdir())


@pytest.fixture
def fast_preflight(monkeypatch):
    async def valid(*args):
        return 2
    monkeypatch.setattr(e, 'preflight', valid)


def test_retry_uses_remaining_admission_deadline(tmp_path, fast_preflight):
    import asyncio
    async def delayed(request):
        await asyncio.sleep(0.15)
        return GARBAGE
    app, calls = recovery_client(tmp_path, [delayed, '13'], deadline=3)
    with TestClient(app) as c:
        assert upload(c).status_code == 200
        budgets = [int(x.headers['X-Tika-Timeout-Millis']) for x in calls]
        assert 1000 <= budgets[1] < budgets[0] <= 2500
        assert calls[1].extensions['timeout']['read'] < calls[0].extensions['timeout']['read']


def test_no_retry_when_remaining_budget_unsafe(tmp_path, fast_preflight):
    import asyncio
    async def delayed(request):
        await asyncio.sleep(0.6)
        return GARBAGE
    app, calls = recovery_client(tmp_path, [delayed, 'must not run'], deadline=2)
    with TestClient(app) as c:
        assert upload(c).status_code == 503
        assert len(calls) == 1 and not list(tmp_path.iterdir())


def test_first_timeout_no_retry(tmp_path):
    app, calls = recovery_client(tmp_path, [httpx.ReadTimeout('synthetic'), 'must not run'])
    with TestClient(app) as c:
        assert upload(c).status_code == 503 and len(calls) == 1
        assert c.get('/health').status_code == 503
        assert not list(tmp_path.iterdir())


def test_response_oversize_cleanup_and_fault(tmp_path):
    app, calls = recovery_client(tmp_path, [httpx.Response(200, content=b'x' * (23 * e.MiB + 1))])
    with TestClient(app) as c:
        r = upload(c)
        assert r.status_code == 413 and 'text' not in r.json() and len(calls) == 1
        assert c.get('/health').status_code == 503 and not list(tmp_path.iterdir())


def test_recovery_text_oversize_rejected(tmp_path):
    app, calls = recovery_client(tmp_path, [GARBAGE, 'a' * (15 * e.MiB + 1)])
    with TestClient(app) as c:
        assert upload(c).status_code == 413 and len(calls) == 2
        assert not list(tmp_path.iterdir())


def test_outer_deadline_timeout_cleanup(tmp_path, fast_preflight):
    import asyncio
    async def slow(request):
        await asyncio.sleep(5)
        return 'late'
    app, calls = recovery_client(tmp_path, [slow], deadline=2)
    with TestClient(app) as c:
        assert upload(c).status_code == 503 and len(calls) == 1
        assert c.get('/health').status_code == 503
        assert not list(tmp_path.iterdir())


def test_real_synthetic_corrupted_unicode_map():
    import io
    from pypdf import PdfReader
    from fixtures import broken_text_layer_pdf
    reader = PdfReader(io.BytesIO(broken_text_layer_pdf()))
    assert len(reader.pages) == 2
    text = '\n'.join(page.extract_text() for page in reader.pages)
    assert e.text_quality(text)['meaningful'] == 0
    assert e.text_quality(text)['replacement'] > 200
    with pytest.raises(e.UnreadableText):
        e.checked_text(text, 30000)


@pytest.mark.parametrize('setting,value', [('min_meaningful_ratio', 0),
    ('max_replacement_ratio', 0.21), ('max_control_ratio', 0.11)])
def test_quality_configuration_safety_envelope(setting, value):
    with pytest.raises(ValueError):
        e.Settings(secret=SECRET, **{setting: value})


def test_quality_policy_preserves_source_and_is_idempotent():
    spec = importlib.util.spec_from_file_location('quality_policy',
        ROOT / 'scripts/add-extraction-quality-policy.py')
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    source = {'unrelated': {'keep': True}, 'filters': {'messages': {'pii': {'action': 'audit'}}}}
    result = policy.with_quality_policy(source)
    assert 'files' not in source['filters']
    assert result == source
    assert 'files' not in result['filters']
    assert result['unrelated'] == source['unrelated']
    assert result['filters']['messages'] == source['filters']['messages']
    assert policy.with_quality_policy(result) == result
    for existing in [{'action': 'audit'}, {'fields': ['filename']}]:
        configured = {'filters': {'files': {'pii': existing}}}
        assert policy.with_quality_policy(configured) == configured
