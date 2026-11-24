"""Real adapter/parser regression. Only generated fixtures; no payload logging."""
import json
import os
import pathlib
import time

import httpx
import jwt


def main():
    root = pathlib.Path(os.getenv('SYNTHETIC_FIXTURE_DIR', '/fixtures'))
    assert json.loads((root / 'manifest.json').read_text())['synthetic_only'] is True
    url = os.environ['EXTRACTOR_URL']
    secret = os.environ['JWT_SECRET']
    repeats = int(os.getenv('SYNTHETIC_SCAN_REPEATS', '10'))
    assert 1 <= repeats <= 30
    documents = [
        ('digital.pdf', 'application/pdf'),
        ('beleid.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
        ('beleid.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
        ('beleid.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        ('beleid.odt', 'application/vnd.oasis.opendocument.text'),
        ('beleid.eml', 'message/rfc822'),
        ('beleid.txt', 'text/plain'),
    ]
    cases = documents + [case for _ in range(repeats) for case in [
        ('scan.pdf', 'application/pdf'), ('broken-layer.pdf', 'application/pdf'),
        ('mixed.pdf', 'application/pdf'), documents[1]]]
    if os.getenv('SYNTHETIC_BENCHMARK') == 'true':
        cases += [('scan-30.pdf', 'application/pdf'), documents[0]]
    with httpx.Client(timeout=280, trust_env=False) as client:
        for index, (name, mime) in enumerate(cases):
            assert client.get(url + '/health').status_code == 200, 'unhealthy before case'
            now = int(time.time())
            token = jwt.encode({'id': 'synthetic-owner', 'iat': now, 'exp': now + 300},
                               secret, algorithm='HS256')
            start = time.monotonic()
            with (root / name).open('rb') as file:
                response = client.post(url + '/text', headers={'Authorization': 'Bearer ' + token},
                    data={'file_id': 'synthetic-' + str(index)}, files={'file': (name, file, mime)})
            print(json.dumps({'case': index, 'status': response.status_code,
                              'seconds': round(time.monotonic() - start, 2)}), flush=True)
            assert response.status_code == 200, 'extraction failed'
            assert set(response.json()) == {'text'}
            text = response.json()['text']
            assert '\ufffd' not in text and '\x00' not in text, 'unreadable output'
            for marker in ['2026', 'financiële', 'verantwoording']:
                assert marker in text, 'source marker absent'
            assert client.get(url + '/health').status_code == 200, 'unhealthy after case'
    print(json.dumps({'passed': True, 'cases': len(cases)}))


if __name__ == '__main__':
    main()
