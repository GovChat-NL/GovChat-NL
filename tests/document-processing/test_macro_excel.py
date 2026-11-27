"""Synthetic XLSM safety checks; no real workbooks or macro execution."""
import importlib.util
import io
import re
import zipfile

import pytest
from test_adapter import ROOT, client, e, upload

MIME = 'application/vnd.ms-excel.sheet.macroEnabled.12'
NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def workbook(changes=None, macros=True):
    files = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        'xl/workbook.xml': f'<workbook xmlns="{NS}" xmlns:r="{REL}"><sheets>'
            '<sheet name="Begroting" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{REL}/worksheet" Target="worksheets/sheet1.xml"/>'
            f'<Relationship Id="external" Type="{REL}/externalLink" Target="http://127.0.0.1/private" TargetMode="External"/>'
            '</Relationships>',
        'xl/sharedStrings.xml': f'<sst xmlns="{NS}"><si><t>Gemeente financiële</t></si></sst>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{NS}"><sheetData><row r="1">'
            '<c r="A1" t="s"><v>0</v></c><c r="B1"><v>12345.67</v></c>'
            '<c r="C1"><f>MACRO_SENTINEL()</f><v>42</v></c>'
            '<c r="D1"><f>UNCACHED_FORMULA_SENTINEL()</f></c>'
            '<c r="E1" t="inlineStr"><is><r><t>één</t></r><r><t> twee</t></r></is></c>'
            '<c r="F1" t="b"><v>1</v></c></row></sheetData></worksheet>',
        'xl/embeddings/oleObject1.bin': 'OBJECT_SENTINEL',
        'xl/externalLinks/externalLink1.xml': 'EXTERNAL_SENTINEL',
    }
    if macros:
        files['xl/vbaProject.bin'] = 'VBA_SENTINEL'
    files.update(changes or {})
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, value in files.items():
            archive.writestr(name, value)
    return data.getvalue()


def dense_workbook():
    rows = ''.join(
        f'<row r="{i}"><c r="A{i}" t="inlineStr"><is><r><t>alpha</t></r>'
        f'<r><t>beta</t></r><r><t>gamma</t></r></is></c>'
        f'<c r="B{i}"><v>{i}</v></c><c r="C{i}"><v>{i + 1}</v></c></row>'
        for i in range(1, 120001))
    return workbook({'xl/worksheets/sheet1.xml':
                     f'<worksheet xmlns="{NS}"><sheetData>{rows}</sheetData></worksheet>'})


@pytest.mark.parametrize('mime', [MIME, MIME.lower(), 'application/octet-stream'])
@pytest.mark.parametrize('macros', [True, False])
def test_macro_excel_cached_cells_only(client, mime, macros):
    response = upload(client, workbook(macros=macros), 'begroting.XLSM', mime)
    assert response.status_code == 200
    text = response.json()['text']
    for value in ['Begroting', 'A1: Gemeente financiële', 'B1: 12345.67', 'C1: 42',
                  'D1: [formule zonder opgeslagen resultaat]', 'E1: één twee', 'F1: TRUE',
                  'niet opnieuw berekend']:
        assert value in text
    assert 'SENTINEL' not in text
    assert not client.calls  # Original document is never sent to Tika.
    assert not list(client.scratch.iterdir())


def test_macro_workbook_cannot_bypass_xlsx_policy(client):
    response = upload(client, workbook(), 'x.xlsx',
                      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    assert response.status_code == 422
    assert not client.calls


@pytest.mark.parametrize('changes', [
    {'xl/_rels/workbook.xml.rels': f'<Relationships><Relationship Id="rId1" Type="{REL}/worksheet" '
        'Target="http://127.0.0.1/private" TargetMode="External"/></Relationships>'},
    {'xl/_rels/workbook.xml.rels': f'<Relationships><Relationship Id="rId1" Type="{REL}/worksheet" '
        'Target="../embeddings/oleObject1.bin"/></Relationships>'},
    {'xl/worksheets/sheet1.xml': '<!DOCTYPE x [<!ENTITY x "private">]><x>&x;</x>'},
    {'xl/worksheets/sheet1.xml': '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x><x/>'.encode('utf-16')},
    {'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{NS}"><sheetData><row><c r="A1" t="s"><v>-1</v></c></row></sheetData></worksheet>'},
    {'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{NS}"><sheetData/></worksheet>'},
    {'../unsafe.xml': 'private'},
])
def test_macro_excel_fails_closed(client, changes):
    response = upload(client, workbook(changes), 'x.xlsm', MIME)
    assert response.status_code == 422 and 'text' not in response.json()
    assert not client.calls
    assert not list(client.scratch.iterdir())


def test_macro_excel_mime_mismatch(client):
    assert upload(client, workbook(), 'x.xlsm', 'application/pdf').status_code == 415
    assert not client.calls


def test_macro_excel_sheet_limit(client):
    changes = {f'xl/worksheets/sheet{i}.xml': f'<worksheet xmlns="{NS}"/>' for i in range(2, 32)}
    assert upload(client, workbook(changes), 'x.xlsm', MIME).status_code == 422
    assert not client.calls
    assert not list(client.scratch.iterdir())


def test_macro_excel_binary_signature_required(client):
    assert upload(client, b'not an Office archive', 'x.xlsm', MIME).status_code == 422
    assert not client.calls


def test_macro_excel_specific_error_logged_without_payload(client, caplog):
    changes = {'xl/worksheets/sheet1.xml': '<!DOCTYPE x [<!ENTITY x "private-sentinel">]><x>&x;</x>'}
    with caplog.at_level('WARNING', logger='govchat.document_extractor'):
        response = upload(client, workbook(changes), 'private-sentinel.xlsm', MIME)
    assert response.json() == {'detail': 'unsafe_xml'}
    assert 'unsafe_xml' in caplog.text and 'private-sentinel' not in caplog.text


def test_worker_diagnostic_codes_never_include_parser_details():
    spec = importlib.util.spec_from_file_location('validation', ROOT / 'services/document-extractor/preflight.py')
    validation = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validation)
    assert validation.diagnostic_code(ValueError('private-document-sentinel')) == 'invalid_or_unsupported_document'
    assert validation.diagnostic_code(KeyError('private-member-sentinel')) == 'missing_archive_member'
    assert validation.diagnostic_code(MemoryError('private-parser-sentinel')) == 'worker_memory_limit'
    assert validation.diagnostic_code(ValueError('sheet_limit')) == 'sheet_limit'


def test_large_macro_excel_streams_under_original_memory_limit(client):
    # Large non-cell worksheet metadata must also be discarded while streaming.
    # Keep actual cell output small to isolate DOM memory from output/CPU caps.
    rows = ''.join(
        f'<row r="{i}"><c r="A{i}" t="inlineStr"><is><r><t>alpha</t></r>'
        f'<r><t>beta</t></r><r><t>gamma</t></r></is></c>'
        f'<c r="B{i}"><v>{i}</v></c><c r="C{i}"><v>{i + 1}</v></c></row>'
        for i in range(1, 1001))
    metadata = ''.join(f'<ext uri="synthetic-{i}"><unused/></ext>' for i in range(450000))
    sheet = f'<worksheet xmlns="{NS}"><sheetData>{rows}</sheetData><extLst>{metadata}</extLst></worksheet>'
    response = upload(client, workbook({'xl/worksheets/sheet1.xml': sheet}), 'large.xlsm', MIME)
    assert response.status_code == 200, response.json()
    text = response.json()['text']
    assert 'A1: alphabetagamma' in text and 'B1000: 1000' in text
    assert not client.calls and not list(client.scratch.iterdir())


def test_dense_macro_excel_has_separate_bounded_extraction_budget(client):
    response = upload(client, dense_workbook(), 'dense.xlsm', MIME)
    assert response.status_code == 200, response.json()
    assert 'B120000: 120000' in response.json()['text']
    assert not client.calls and not list(client.scratch.iterdir())


@pytest.mark.asyncio
async def test_spreadsheet_timeout_reaps_worker(tmp_path, monkeypatch):
    import asyncio
    real_timeout = asyncio.timeout
    class Process:
        returncode = None
        killed = waited = False
        async def communicate(self):
            await asyncio.sleep(1)
        def kill(self):
            self.killed = True
            self.returncode = -9
        async def wait(self):
            self.waited = True
    process = Process()
    async def spawn(*args, **kwargs):
        return process
    monkeypatch.setattr(e.asyncio, 'create_subprocess_exec', spawn)
    monkeypatch.setattr(e.asyncio, 'timeout', lambda _: real_timeout(0.01))
    with pytest.raises(e.HTTPException) as error:
        await e.extract_spreadsheet(tmp_path / 'synthetic.xlsm', tmp_path / 'cells.txt',
                                    1000, e.time.monotonic() + 270)
    assert error.value.status_code == 503
    assert error.value.detail == 'spreadsheet_extraction_timeout'
    assert process.killed and process.waited


@pytest.mark.asyncio
async def test_spreadsheet_budget_does_not_renew_request_deadline(tmp_path, monkeypatch):
    deadline = e.time.monotonic() + 7
    calls = []
    async def worker(script, args, actual_deadline, max_seconds, timeout_code):
        calls.append((script, actual_deadline, max_seconds, timeout_code))
        return {'status': 'ok'}
    monkeypatch.setattr(e, 'local_worker', worker)
    await e.extract_spreadsheet(tmp_path / 'synthetic.xlsm', tmp_path / 'cells.txt', 1000, deadline)
    assert calls == [('spreadsheet.py', deadline, 120, 'spreadsheet_extraction_timeout')]


def test_streaming_xml_rejects_declaration_split_across_chunks():
    spec = importlib.util.spec_from_file_location('cells', ROOT / 'services/document-extractor/spreadsheet.py')
    cells = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cells)
    reader = cells.SafeXMLReader(io.BytesIO(b'<!DOCTYPE x>'))
    assert reader.read(4) == b'<!DO'
    with pytest.raises(ValueError, match='unsafe_xml'):
        reader.read(5)


def test_macro_excel_output_cap(tmp_path):
    spec = importlib.util.spec_from_file_location('cells', ROOT / 'services/document-extractor/spreadsheet.py')
    cells = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cells)
    source = tmp_path / 'source.xlsm'
    source.write_bytes(workbook())
    with pytest.raises(ValueError, match='output_limit'):
        cells.extract_cells(source, tmp_path / 'cells.txt', 10)


def test_macro_excel_routing_and_upload_configuration():
    assert e.select_route('x.xlsm', MIME, e.load_routes()) == ('xlsm', 'spreadsheet')
    spec = importlib.util.spec_from_file_location('renderer', ROOT / 'scripts/render-document-processing-config.py')
    renderer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(renderer)
    config = renderer.document_config({'endpoints': {'custom': [{'name': 'govchat-orchestrator'}]}}, e.load_routes())
    for mime in (MIME, MIME.lower()):
        assert any(re.search(p, mime) for p in config['fileConfig']['text']['supportedMimeTypes'])
        assert any(re.search(p, mime) for p in config['fileConfig']['endpoints']['govchat-orchestrator']['supportedMimeTypes'])
        # Both browser spelling and normalized transport must use text delivery.
        assert config['fileConfig']['endpoints']['govchat-orchestrator']['defaultLLMDeliveryPath']['overrides'][mime] == 'text'
