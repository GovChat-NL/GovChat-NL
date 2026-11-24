"""Generate an image-only PDF, upload it locally and verify real OCR/model delivery."""
import io
import json
import os
from pathlib import Path
import secrets
import sys
import uuid
import importlib.util

import httpx
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]


def main():
    spec = importlib.util.spec_from_file_location('owned_api_probe', ROOT / 'scripts/smoke-tika-local-app.py')
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    code = str(100000 + secrets.randbelow(900000))
    raster = Image.new('RGB', (1800, 600), 'white')
    fonts = [Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts/arial.ttf',
             Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
    font_path = next((path for path in fonts if path.is_file()), None)
    assert font_path, 'readable local synthetic font required'
    font = ImageFont.truetype(str(font_path), 76)
    draw = ImageDraw.Draw(raster)
    draw.text((70, 70), 'Synthetische scan, geen echte gegevens.', font=font, fill='black')
    draw.text((70, 230), 'Unieke controlecode: ' + code, font=font, fill='black')
    draw.text((70, 390), 'Financiele verantwoording 2026.', font=font, fill='black')
    buffer = io.BytesIO()
    raster.save(buffer, format='PDF', resolution=150)
    pdf = buffer.getvalue()
    assert not ''.join(page.extract_text() or '' for page in PdfReader(io.BytesIO(pdf)).pages).strip()
    base = 'http://127.0.0.1:3099'
    with httpx.Client(timeout=290, trust_env=False, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'}) as client:
        probe.account(client, base, 'owner', False)
        response = probe.require(client.post(base + '/api/files', data={
            'file_id': str(uuid.uuid4()), 'endpoint': 'govchat-orchestrator', 'endpointType': 'custom',
            'model': 'govchat-orchestrator', 'message_file': 'true', 'llmDeliveryPath': 'text'},
            files={'file': ('synthetic-image-only.pdf', pdf, 'application/pdf')}), 'scan-upload')
        values = probe.event_values(response)
        result = next((value for value in values if 'file' in value or 'file_id' in value), {})
        file = result.get('file', result)
        assert file.get('file_id') and file.get('llmDeliveryPath') == 'text'
        preview = probe.require(client.get(base + '/api/files/' + file['file_id'] + '/preview'), 'scan-stored-preview')
        text = preview.json().get('text', '')
        assert code in text and '\ufffd' not in text
        for field in ['text', 'extractedText']:
            file.pop(field, None)
        answer, _, _ = probe.turn(client, base,
            'Gebruik geen tools. Welke unieke controlecode staat in de bijgevoegde scan? Geef alleen die code terug.', [file])
        assert code in answer
    summary = {'passed': True, 'image_only_pdf': True, 'original_text_layer_empty': True,
               'local_upload_and_stored_ocr': True, 'actual_model_scan_code': True}
    (ROOT / '.tika-upload-local/app-ocr-summary.json').write_text(json.dumps(summary), encoding='utf-8')
    print(json.dumps(summary))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'passed': False, 'error_class': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
