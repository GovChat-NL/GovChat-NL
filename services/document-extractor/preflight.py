"""Bounded subprocess preflight; never extract or log user content."""
import email.policy
import io
import json
import pathlib
import resource
import sys
import zipfile
from email.parser import BytesParser
from xml.etree.ElementTree import ParseError

import olefile
from pypdf import PdfReader

SAFE_ERRORS = frozenset(json.loads(pathlib.Path(__file__).with_name('validation-errors.json').read_text()))


def diagnostic_code(error):
    if isinstance(error, MemoryError):
        return 'worker_memory_limit'
    if isinstance(error, ParseError):
        return 'invalid_xml'
    if isinstance(error, KeyError):
        return 'missing_archive_member'
    # Only independently owned, fixed validation strings may leave this worker.
    if isinstance(error, ValueError) and str(error) in SAFE_ERRORS:
        return str(error)
    return 'invalid_or_unsupported_document'


def inspect(path, extension, max_pages):
    data = pathlib.Path(path).read_bytes()
    if extension == 'pdf':
        if not data.startswith(b'%PDF-'):
            raise ValueError('signature_mismatch')
        pdf = PdfReader(io.BytesIO(data), strict=True)
        if pdf.is_encrypted:
            raise ValueError('encrypted_document')
        count = len(pdf.pages)
        if not 1 <= count <= max_pages:
            raise ValueError('page_limit')
        return {'pages': count}
    if extension in {'docx', 'pptx', 'xlsx', 'xlsm', 'odt'}:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            names = {e.filename for e in entries}
            if len(entries) > 4096 or len(names) != len(entries):
                raise ValueError('archive_entries')
            if sum(e.file_size for e in entries) > 64 * 1024 * 1024:
                raise ValueError('archive_expansion')
            for entry in entries:
                if entry.flag_bits & 1 or '..' in pathlib.PurePosixPath(entry.filename).parts:
                    raise ValueError('unsafe_archive')
                if entry.filename.startswith('/') or entry.file_size > 32 * 1024 * 1024:
                    raise ValueError('unsafe_archive')
                if entry.file_size > max(entry.compress_size, 1) * 250:
                    raise ValueError('archive_ratio')
            roots = {'docx': 'word/document.xml', 'pptx': 'ppt/presentation.xml',
                     'xlsx': 'xl/workbook.xml', 'xlsm': 'xl/workbook.xml', 'odt': 'content.xml'}
            signatures = [roots[e] in names for e in ('docx', 'pptx', 'xlsx')]
            if roots[extension] not in names or sum(signatures) > 1:
                raise ValueError('signature_mismatch')
            if extension == 'odt':
                if archive.read('mimetype') != b'application/vnd.oasis.opendocument.text':
                    raise ValueError('signature_mismatch')
            elif '[Content_Types].xml' not in names:
                raise ValueError('signature_mismatch')
            if extension != 'xlsm' and any('vbaproject' in n.lower() for n in names):
                raise ValueError('macros_unsupported')
            if extension == 'pptx':
                count = sum(n.startswith('ppt/slides/slide') and n.endswith('.xml')
                            and '/' not in n[len('ppt/slides/'):] for n in names)
                if not 1 <= count <= max_pages:
                    raise ValueError('page_limit')
            if extension in {'xlsx', 'xlsm'}:
                count = sum(n.startswith('xl/worksheets/sheet') and n.endswith('.xml') for n in names)
                if not 1 <= count <= 30:
                    raise ValueError('sheet_limit')
            # Read every member to verify CRC; bounded by expansion policy above.
            for name in names:
                archive.read(name)
        return {'pages': None}
    if extension in {'doc', 'msg'}:
        if not olefile.isOleFile(io.BytesIO(data)):
            raise ValueError('signature_mismatch')
        with olefile.OleFileIO(io.BytesIO(data)) as ole:
            is_doc = ole.exists('WordDocument')
            is_msg = ole.exists('__properties_version1.0')
            if is_doc == is_msg or (extension == 'doc') != is_doc:
                raise ValueError('signature_mismatch')
            if ole.exists('EncryptedPackage'):
                raise ValueError('encrypted_document')
        return {'pages': None}
    if extension == 'rtf':
        if not data.startswith(b'{\\rtf'):
            raise ValueError('signature_mismatch')
        return {'pages': None}
    if extension == 'eml':
        if b'\x00' in data:
            raise ValueError('signature_mismatch')
        msg = BytesParser(policy=email.policy.default).parsebytes(data)
        if not msg.get('From') or not msg.get('Subject') or any(p.defects for p in msg.walk()):
            raise ValueError('invalid_email')
        return {'pages': None}
    raise ValueError('unsupported_format')


if __name__ == '__main__':
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    try:
        result = inspect(sys.argv[1], sys.argv[2], int(sys.argv[3]))
        print(json.dumps(result))
    except Exception as error:
        # Parser exceptions may contain document text or filenames.
        print(json.dumps({'error': diagnostic_code(error)}))
        sys.exit(1)
