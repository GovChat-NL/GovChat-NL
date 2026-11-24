"""Real local upload/storage/two-turn checks using only newly created synthetic data."""
import argparse
import importlib.util
import json
from pathlib import Path
import secrets
import subprocess
import sys
import uuid
from urllib.parse import urlparse

from docx import Document
import httpx

ROOT = Path(__file__).resolve().parents[1]
PROGRESS = {'stage': 'initializing'}


def require(response, stage):
    PROGRESS['stage'] = stage
    PROGRESS['status'] = response.status_code
    if response.status_code not in {200, 201}:
        retry_after = response.headers.get('retry-after', '')
        if retry_after.isdigit():
            PROGRESS['retry_after_seconds'] = int(retry_after)
        raise AssertionError(stage)
    return response


def event_values(response):
    if 'application/json' in response.headers.get('content-type', ''):
        return [response.json()]
    values = []
    for line in response.text.splitlines():
        if line.startswith('data: '):
            try:
                values.append(json.loads(line[6:]))
            except ValueError:
                pass
    return values


def account(client, base, label, provision):
    credential_path = ROOT / '.tika-upload-local' / 'app-probes' / (label + '-account.json')
    if credential_path.exists():
        saved = json.loads(credential_path.read_text(encoding='utf-8'))
        email, password = saved['email'], saved['password']
        assert email.startswith('tika-probe-') and email.endswith('@example.invalid')
        login = require(client.post(base + '/api/auth/login', json={'email': email, 'password': password}), 'login')
        client.headers['Authorization'] = 'Bearer ' + login.json()['token']
        return email, password
    identifier = uuid.uuid4().hex
    email = 'tika-probe-' + identifier + '@example.invalid'
    password = secrets.token_urlsafe(24) + '!Aa1'
    if provision:
        # Operator provisioning of NEW test users through upstream AuthService.
        # Password is supplied over stdin, never as a CLI argument or output.
        result = subprocess.run(['docker', 'exec', '-i', 'govchat-tika-local-app-app-1',
            'node', '/app/config/create-user.js', email, 'Synthetic Tika Probe',
            'tika-' + identifier, '--email-verified=false'], input=password + '\n',
            text=True, capture_output=True, timeout=60)
        PROGRESS['stage'] = 'synthetic-account-provisioning'
        if result.returncode:
            raise RuntimeError('upstream account provisioning failed')
    else:
        require(client.post(base + '/api/auth/register', json={
            'name': 'Synthetic Tika Probe', 'username': 'tika-' + identifier,
            'email': email, 'password': password, 'confirm_password': password}), 'registration')
    spec = importlib.util.spec_from_file_location('owned_local_setup', ROOT / 'scripts/prepare-tika-local-app.py')
    setup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(setup)
    setup.private_write(credential_path, json.dumps({'email': email, 'password': password}))
    login = require(client.post(base + '/api/auth/login', json={'email': email, 'password': password}), 'login')
    client.headers['Authorization'] = 'Bearer ' + login.json()['token']
    return email, password


def turn(client, base, text, files, conversation=None, parent=None):
    payload = {'text': text, 'endpoint': 'govchat-orchestrator', 'endpointType': 'custom',
               'model': 'govchat-orchestrator', 'resendFiles': True,
               'parentMessageId': parent or '00000000-0000-0000-0000-000000000000',
               'conversationId': conversation, 'messageId': str(uuid.uuid4()),
               'isRegenerate': False, 'isContinued': False, 'files': files}
    response = require(client.post(base + '/api/agents/chat/govchat-orchestrator', json=payload), 'chat-admission')
    if 'application/json' in response.headers.get('content-type', ''):
        admission = response.json()
        stream = admission.get('streamId') or admission.get('conversationId')
        assert stream, 'stream identity missing'
        response = require(client.get(base + '/api/agents/chat/stream/' + stream), 'chat-stream')
    events = event_values(response)
    final = next((e for e in reversed(events) if e.get('final')), None)
    assert final, 'chat did not complete'
    message = final.get('responseMessage') or final.get('message') or {}
    content = message.get('content', [])
    response_text = content if isinstance(content, str) else '\n'.join(
        c.get('text', '') for c in content if isinstance(c, dict) and isinstance(c.get('text'), str))
    if not response_text and isinstance(message.get('text'), str):
        response_text = message['text']
    return response_text, final.get('conversation', {}).get('conversationId'), message.get('messageId')


def main(base, provision=False):
    parsed = urlparse(base)
    if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost'} or parsed.port != 3099:
        raise ValueError('only the owned local UI at port 3099 is permitted')
    fixture_dir = ROOT / '.tika-upload-local' / 'app-probes'
    fixture_dir.mkdir(exist_ok=True)
    code = secrets.token_hex(8).upper()
    document = Document()
    document.add_paragraph('Synthetisch verificatiedocument. Dit bevat geen echte gebruikersgegevens.')
    document.add_paragraph('De unieke controlecode van dit document is ' + code + '.')
    document.add_paragraph('Financiële verantwoording 2026. Gebruik alleen de tekst van dit document.')
    fixture = fixture_dir / ('probe-' + uuid.uuid4().hex + '.docx')
    document.save(fixture)
    settings = {'timeout': 290, 'trust_env': False, 'headers': {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'}}
    with httpx.Client(**settings) as owner, httpx.Client(**settings) as other:
        require(owner.get(base + '/health'), 'health')
        credentials = account(owner, base, 'owner', provision)
        account(other, base, 'other', provision)
        with fixture.open('rb') as stream:
            uploaded = require(owner.post(base + '/api/files', data={
                'file_id': str(uuid.uuid4()), 'endpoint': 'govchat-orchestrator',
                'endpointType': 'custom', 'model': 'govchat-orchestrator',
                'message_file': 'true', 'llmDeliveryPath': 'text'}, files={
                    'file': ('synthetic-probe.docx', stream,
                             'application/vnd.openxmlformats-officedocument.wordprocessingml.document')}), 'upload')
        values = event_values(uploaded)
        value = next((v for v in values if 'file' in v or 'file_id' in v), {})
        file = value.get('file', value)
        if not file.get('file_id') or file.get('llmDeliveryPath') != 'text':
            print(json.dumps({'stage': 'upload-response-shape',
                'content_type': uploaded.headers.get('content-type', '').split(';')[0],
                'event_keys': [list(v) for v in values],
                'data_keys': [list(v['data']) for v in values if isinstance(v.get('data'), dict)],
                'file_keys': list(file),
                'fixed_error_terms': [term for term in ['auth', 'token', 'login', 'ban', 'limit',
                    'permission', 'invalid', 'agent', 'browser', 'extract', 'file']
                    if any(term in str(v.get('message', '')).lower() for v in values)],
                'delivery_path': file.get('llmDeliveryPath') if file.get('llmDeliveryPath') in {'text', 'image', 'file'} else None}))
        assert file.get('file_id') and file.get('llmDeliveryPath') == 'text'
        preview = require(owner.get(base + '/api/files/' + file['file_id'] + '/preview'), 'stored-preview')
        text = preview.json().get('text', '')
        assert code in text and '\ufffd' not in text
        forbidden = other.get(base + '/api/files/' + file['file_id'] + '/preview')
        assert forbidden.status_code in {403, 404}, 'cross-owner preview was not denied'
        for field in ['text', 'extractedText']:
            file.pop(field, None)
        PROGRESS['stage'] = 'document-model-turn'
        first, conversation, parent = turn(owner, base,
            'Gebruik geen tools. Welke unieke controlecode staat in het bijgevoegde document? '
            'Geef alleen die code letterlijk terug.', [file])
        assert code.lower() in first.lower(), 'stored document did not reach actual model'
        assert conversation and parent
        PROGRESS['stage'] = 'follow-up-model-turn'
        second, _, _ = turn(owner, base,
            'Gebruik geen tools. Herhaal de unieke controlecode uit het eerdere document. '
            'Geef alleen de code terug.', [], conversation, parent)
        assert code.lower() in second.lower(), 'follow-up document/history reuse failed'
        PROGRESS['stage'] = 'ordinary-chat'
        plain, _, _ = turn(owner, base, 'Gebruik geen tools. Bereken 19 plus 23 en geef alleen het getal terug.', [])
        assert '42' in plain, 'ordinary chat failed'
        # Fresh login/connection retrieves actual persisted text, not a captured DB call.
        with httpx.Client(**settings) as fresh:
            login = require(fresh.post(base + '/api/auth/login', json={
                'email': credentials[0], 'password': credentials[1]}), 'fresh-login')
            fresh.headers['Authorization'] = 'Bearer ' + login.json()['token']
            restored = require(fresh.get(base + '/api/files/' + file['file_id'] + '/preview'), 'fresh-stored-preview')
            assert code in restored.json().get('text', '')
    summary = {'passed': True, 'real_upload': True, 'real_stored_text': True,
               'cross_owner_preview_denied': True, 'actual_model_document_turns': 2,
               'follow_up_without_client_text_or_reupload': True, 'ordinary_chat': True,
               'fresh_login_stored_text': True}
    (ROOT / '.tika-upload-local' / 'app-api-summary.json').write_text(json.dumps(summary), encoding='utf-8')
    print(json.dumps(summary))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:3099')
    parser.add_argument('--provision-test-accounts', action='store_true',
                        help='Explicitly provision new synthetic accounts using the owned app upstream helper')
    args = parser.parse_args()
    try:
        main(args.base_url.rstrip('/'), args.provision_test_accounts)
    except Exception as error:
        print(json.dumps({'passed': False, **PROGRESS, 'error_class': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
