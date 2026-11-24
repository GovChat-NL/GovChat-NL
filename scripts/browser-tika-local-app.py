"""Headless Chromium UI proof with an owned synthetic account/document only."""
import json
import os
from pathlib import Path
import secrets
import sys
import uuid
import xml.etree.ElementTree as ET
import zipfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.tika-upload-local'
BASE = 'http://127.0.0.1:3099'
PROGRESS = {'stage': 'initializing'}


def synthetic_document():
    originals = sorted((LOCAL / 'app-probes').glob('probe-*.docx'), key=lambda p: p.stat().st_mtime)
    assert originals, 'owned synthetic DOCX fixture required'
    code = secrets.token_hex(8).upper()
    output = LOCAL / 'app-probes' / ('browser-' + uuid.uuid4().hex + '.docx')
    with zipfile.ZipFile(originals[-1]) as source, zipfile.ZipFile(output, 'w') as target:
        for info in source.infolist():
            content = source.read(info.filename)
            if info.filename == 'word/document.xml':
                tree = ET.fromstring(content)
                changed = False
                for text in tree.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'):
                    if 'unieke controlecode' in (text.text or ''):
                        text.text = 'De unieke browsercontrolecode van dit document is ' + code + '.'
                        changed = True
                assert changed
                content = ET.tostring(tree, encoding='utf-8', xml_declaration=True)
            target.writestr(info, content)
    return output, code


def main():
    credentials = json.loads((LOCAL / 'app-probes' / 'owner-account.json').read_text(encoding='utf-8'))
    assert credentials['email'].startswith('tika-probe-') and credentials['email'].endswith('@example.invalid')
    document, code = synthetic_document()
    os.environ['PLAYWRIGHT_BROWSERS_PATH'] = str(LOCAL / 'browsers')
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(30000)
        PROGRESS['stage'] = 'browser-login'
        page.goto(BASE + '/login')
        page.locator('input[name="email"]').fill(credentials['email'])
        page.locator('input[name="password"]').fill(credentials['password'])
        with page.expect_response(lambda r: r.url.endswith('/api/auth/login')) as login:
            page.locator('button[type="submit"]').click()
        PROGRESS['status'] = login.value.status
        assert login.value.status == 200
        page.wait_for_url('**/c/**')
        page.locator('textarea').first.wait_for(state='visible')
        PROGRESS['stage'] = 'browser-upload'
        if page.locator('input[type="file"]').count() == 0:
            # Report only static UI control labels, never chat/document/account text.
            labels = page.locator('button').evaluate_all(
                '(buttons) => buttons.map(b => b.getAttribute("aria-label")).filter(Boolean)')
            print(json.dumps({'stage': 'upload-control-lookup', 'control_labels': labels}))
            raise AssertionError('file upload control unavailable')
        with page.expect_response(lambda r: '/api/files' in r.url and r.request.method == 'POST', timeout=290000) as upload:
            page.locator('input[type="file"]').first.set_input_files(str(document))
        response = upload.value
        PROGRESS['status'] = response.status
        assert response.status in {200, 201}
        raw = response.text()
        values = []
        try:
            values = [json.loads(raw)]
        except ValueError:
            for line in raw.splitlines():
                if line.startswith('data: '):
                    try:
                        values.append(json.loads(line[6:]))
                    except ValueError:
                        pass
        value = next((v for v in values if isinstance(v, dict) and ('file' in v or 'file_id' in v)), {})
        file = value.get('file', value)
        assert file.get('file_id') and file.get('llmDeliveryPath') == 'text'
        page.wait_for_timeout(1000)
        PROGRESS['stage'] = 'browser-document-chat'
        page.locator('textarea').first.fill('Gebruik geen tools. Welke unieke browsercontrolecode staat in het document? Geef alleen die code letterlijk terug.')
        page.locator('textarea').first.press('Enter')
        page.get_by_text(code, exact=False).first.wait_for(state='visible', timeout=180000)
        # Reloaded UI must resolve its actual persisted conversation and attachment.
        PROGRESS['stage'] = 'browser-reload-and-follow-up'
        page.reload()
        page.locator('textarea').first.wait_for(state='visible')
        before = page.get_by_text(code, exact=False).count()
        page.locator('textarea').first.fill('Gebruik geen tools. Herhaal alleen de browsercontrolecode uit het eerdere document.')
        page.locator('textarea').first.press('Enter')
        page.wait_for_function('(args) => document.body.innerText.split(args.code).length - 1 > args.before',
                               arg={'code': code, 'before': before}, timeout=180000)
        PROGRESS['stage'] = 'browser-ordinary-chat'
        page.locator('textarea').first.fill('Gebruik geen tools. Bereken 19 plus 23. Geef alleen het getal terug.')
        page.locator('textarea').first.press('Enter')
        page.get_by_text('42', exact=True).first.wait_for(state='visible', timeout=180000)
        PROGRESS['stage'] = 'browser-image-upload'
        page.goto(BASE + '/c/new')
        page.locator('textarea').first.wait_for(state='visible')
        with page.expect_response(lambda r: '/api/files' in r.url and r.request.method == 'POST', timeout=60000) as image_upload:
            page.locator('input[type="file"]').first.set_input_files(str(ROOT / 'tests/fixtures/number-grid.png'))
        image_response = image_upload.value
        assert image_response.status in {200, 201}
        image_values = []
        image_raw = image_response.text()
        try:
            image_values = [json.loads(image_raw)]
        except ValueError:
            for line in image_raw.splitlines():
                if line.startswith('data: '):
                    try:
                        image_values.append(json.loads(line[6:]))
                    except ValueError:
                        pass
        image_value = next((v for v in image_values if 'file' in v or 'file_id' in v), {})
        image_file = image_value.get('file', image_value)
        # Installed v0.8.8 resolver uses native provider delivery for PNG.
        if not image_file.get('file_id') or image_file.get('llmDeliveryPath') != 'provider':
            print(json.dumps({'stage': 'image-response-shape', 'event_keys': [list(v) for v in image_values],
                              'file_keys': list(image_file), 'has_file_id': bool(image_file.get('file_id')),
                              'png_mime': image_file.get('mimetype') == 'image/png',
                              'delivery_path_present': 'llmDeliveryPath' in image_file,
                              'is_text_delivery': image_file.get('llmDeliveryPath') == 'text'}))
        assert image_file.get('file_id') and image_file.get('llmDeliveryPath') == 'provider'
        page.wait_for_timeout(1000)
        PROGRESS['stage'] = 'browser-image-model-answer'
        page.locator('textarea').first.fill('Hoeveel blauwe vakken in de afbeelding bevatten het cijfer 7? Geef alleen het aantal terug.')
        page.locator('textarea').first.press('Enter')
        page.get_by_text('2', exact=True).first.wait_for(state='visible', timeout=180000)
        browser.close()
    summary = {'passed': True, 'chromium_login': True, 'ui_file_upload': True,
               'actual_model_document_answer': True, 'reload_follow_up': True, 'ordinary_chat': True,
               'image_delivery_preserved': True, 'actual_image_model_answer': True}
    (LOCAL / 'app-browser-summary.json').write_text(json.dumps(summary), encoding='utf-8')
    print(json.dumps(summary))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Playwright errors may include credentials, document labels or page text.
        print(json.dumps({'passed': False, **PROGRESS, 'error_class': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
