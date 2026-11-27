"""Read cached XLSM cells only. Called inside the resource-limited preflight worker.

No Office runtime, formula evaluation, VBA parsing, embedded object extraction or
network access. Original archive never goes to Tika. Dates/numbers retain their
stored values, rather than applying Excel display formats.
"""
import pathlib
import re
import zipfile
from array import array
from xml.etree import ElementTree as ET

MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
STRICT = 'http://purl.oclc.org/ooxml/spreadsheetml/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
STRICT_REL = 'http://purl.oclc.org/ooxml/officeDocument/relationships'
CELL_REFERENCE = re.compile(r'[A-Z]{1,3}[1-9][0-9]{0,6}')


class SafeXMLReader:
    """Bound reads and detect forbidden declarations across chunk boundaries."""
    def __init__(self, stream):
        self.stream = stream
        self.tail = b''

    def read(self, size=-1):
        data = self.stream.read(min(size, 64 * 1024) if size >= 0 else 64 * 1024)
        # Null removal also covers UTF-16/32 declaration encodings.
        probe = self.tail + data.replace(b'\x00', b'').upper()
        if b'<!DOCTYPE' in probe or b'<!ENTITY' in probe:
            raise ValueError('unsafe_xml')
        self.tail = probe[-16:]
        return data


def xml(archive, name):
    with archive.open(name) as stream:
        return ET.parse(SafeXMLReader(stream)).getroot()


def records(archive, name, expected_path):
    """Yield one cell/string at a time; discard all processed XML immediately."""
    with archive.open(name) as stream:
        stack = []
        active = None
        for event, element in ET.iterparse(SafeXMLReader(stream), events=('start', 'end')):
            if event == 'start':
                stack.append(element)
                if len(stack) == 1 and element.tag != expected_path[0]:
                    raise ValueError('invalid_xml')
                if len(stack) == len(expected_path) and tuple(e.tag for e in stack) == expected_path:
                    active = element
                continue
            if element is active:
                yield element
                active = None
            if active is None:
                element.clear()
                if len(stack) > 1:
                    stack[-2].remove(element)
            stack.pop()


class SharedStrings:
    """Packed UTF-8 + integer offsets, not a DOM or millions of Python strings."""
    def __init__(self):
        self.data = bytearray()
        self.offsets = array('I', [0])

    def append(self, text):
        self.data.extend(text.encode('utf-8'))
        self.offsets.append(len(self.data))

    def __len__(self):
        return len(self.offsets) - 1

    def __getitem__(self, index):
        return self.data[self.offsets[index]:self.offsets[index + 1]].decode('utf-8')


def extract_cells(source, output, cap):
    if not 0 < cap <= 15 * 1024 * 1024:
        raise ValueError('output_limit')
    total = 0
    values = 0
    with zipfile.ZipFile(source) as archive, pathlib.Path(output).open('x', encoding='utf-8') as file:
        def write(text):
            nonlocal total
            total += len(text.encode('utf-8'))
            if total > cap:
                raise ValueError('output_limit')
            file.write(text)

        workbook = xml(archive, 'xl/workbook.xml')
        ns = workbook.tag.removesuffix('}workbook').removeprefix('{')
        if ns not in {MAIN, STRICT}:
            raise ValueError('invalid_workbook')
        tags = {name: '{' + ns + '}' + name for name in
                ('sst', 'si', 't', 'r', 'sheets', 'sheet', 'worksheet', 'sheetData', 'row', 'c', 'v', 'is', 'f')}
        tag = tags.__getitem__
        value_tag, formula_tag, inline_tag = tag('v'), tag('f'), tag('is')
        text_tag, rich_text_path = tag('t'), tag('r') + '/' + tag('t')
        relationships = xml(archive, 'xl/_rels/workbook.xml.rels')
        targets = {}
        for rel in relationships:
            key = rel.get('Id')
            if not key or key in targets:
                raise ValueError('invalid_relationship')
            targets[key] = rel
        shared = SharedStrings()
        if 'xl/sharedStrings.xml' in archive.namelist():
            # Only visible text runs; do not include phonetic annotations.
            for item in records(archive, 'xl/sharedStrings.xml', (tag('sst'), tag('si'))):
                shared.append(''.join(t.text or '' for t in item.findall(text_tag) +
                                     item.findall(rich_text_path)))
        sheets = workbook.findall(tag('sheets') + '/' + tag('sheet'))
        if not 1 <= len(sheets) <= 30:
            raise ValueError('sheet_limit')
        write('Excel: alleen opgeslagen celwaarden. Macro’s, externe koppelingen en '
              'ingesloten objecten zijn niet verwerkt. Formules zijn niet opnieuw berekend; '
              'resultaten kunnen verouderd zijn. Getallen en datums zijn ruwe opgeslagen waarden.\n')
        for sheet in sheets:
            rel_id = sheet.get('{' + REL + '}id') or sheet.get('{' + STRICT_REL + '}id')
            rel = targets.get(rel_id)
            if rel is None or rel.get('TargetMode', 'Internal') != 'Internal':
                raise ValueError('invalid_relationship')
            if rel.get('Type') not in {REL + '/worksheet', STRICT_REL + '/worksheet'}:
                # Macro sheets/chartsheets are not worksheets and never inspected.
                continue
            target = rel.get('Target', '')
            if not re.fullmatch(r'(?:/?xl/)?worksheets/[A-Za-z0-9_.-]+\.xml', target):
                raise ValueError('unsafe_sheet_target')
            name = target.lstrip('/')
            if not name.startswith('xl/'):
                name = 'xl/' + name
            write('\nWerkblad: ' + sheet.get('name', '') + '\n')
            for cell in records(archive, name, (tag('worksheet'), tag('sheetData'), tag('row'), tag('c'))):
                ref = cell.get('r', '')
                if not CELL_REFERENCE.fullmatch(ref):
                    raise ValueError('invalid_cell_reference')
                kind = cell.get('t', 'n')
                value = cell.find(value_tag)
                text = value.text or '' if value is not None else ''
                if kind == 's':
                    index = int(text)
                    if not 0 <= index < len(shared):
                        raise ValueError('invalid_shared_string')
                    text = shared[index]
                elif kind == 'inlineStr':
                    inline = cell.find(inline_tag)
                    text = '' if inline is None else ''.join(t.text or '' for t in
                        inline.findall(text_tag) + inline.findall(rich_text_path))
                elif kind == 'b' and text:
                    if text not in {'0', '1'}:
                        raise ValueError('invalid_boolean')
                    text = 'TRUE' if text == '1' else 'FALSE'
                elif kind not in {'n', 'str', 'e', 'd', 'b'}:
                    raise ValueError('unsupported_cell_type')
                if text:
                    values += 1
                    write(ref + ': ' + text + '\n')
                elif cell.find(formula_tag) is not None:
                    write(ref + ': [formule zonder opgeslagen resultaat]\n')
        if not values:
            raise ValueError('empty_spreadsheet')


if __name__ == '__main__':
    import json
    import resource
    import sys
    # Local extraction has its own bounded CPU budget. Preflight remains 5s.
    # Soft SIGXCPU is distinguishable; hard limit prevents signal evasion.
    resource.setrlimit(resource.RLIMIT_CPU, (30, 31))
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    from preflight import diagnostic_code
    try:
        extract_cells(sys.argv[1], sys.argv[2], int(sys.argv[3]))
        print('{"status":"ok"}')
    except Exception as error:
        print(json.dumps({'error': diagnostic_code(error)}))
        sys.exit(1)
