"""Synthetic fixtures only; output stays outside Git. No original attachments."""
import argparse
import io
import json
import pathlib
import random
import subprocess
import textwrap

from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
import reportlab

TEXT = 'Gemeente Noordstad: begroting 2026. Inclusie, duurzaamheid en financiële verantwoording.'


def broken_text_layer_pdf():
    """Visible native glyphs unchanged; only synthetic ToUnicode maps are corrupt."""
    import re
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    pdfmetrics.registerFont(TTFont('SyntheticVera',
        str(pathlib.Path(reportlab.__file__).parent / 'fonts/Vera.ttf')))
    output = io.BytesIO()
    doc = canvas.Canvas(output, pagesize=(595, 842), invariant=1)
    for n in range(1, 3):
        doc.setFont('SyntheticVera', 14)
        for line_no, line in enumerate([f'Synthetische pagina {n:02d}',
            'Gemeente Noordstad: financiële verantwoording',
            'Begroting 2026 en duurzaamheid', '2026     12345,67', '2027     23456,78']):
            doc.drawString(35, 790 - line_no * 30, line)
        doc.showPage()
    doc.save()
    writer = PdfWriter()
    writer.append(PdfReader(io.BytesIO(output.getvalue())))
    changed = set()
    for page in writer.pages:
        for ref in page['/Resources']['/Font'].values():
            font = ref.get_object()
            if '/ToUnicode' not in font:
                continue
            stream = font['/ToUnicode']
            if id(stream) in changed:
                continue
            data = stream.get_data()
            data = re.sub(rb'beginbfchar(.*?)endbfchar',
                lambda m: b'beginbfchar' + re.sub(rb'(<[0-9A-Fa-f]+>)\s+<[0-9A-Fa-f]+>',
                    rb'\1 <FFFD>', m[1]) + b'endbfchar', data, flags=re.S)
            stream.set_data(data)
            changed.add(id(stream))
    assert changed, 'synthetic Unicode map must exist'
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def pdf(mode='digital', pages=2, large=False):
    output = io.BytesIO()
    doc = canvas.Canvas(output, pagesize=(595, 842), invariant=1)
    rng = random.Random(2026)
    for n in range(1, pages + 1):
        text = f'Synthetische pagina {n:02d}: {TEXT}'
        if mode == 'digital' or (mode == 'mixed' and n % 2 == 1):
            doc.setFont('Helvetica', 11)
            doc.drawString(35, 790, f'Synthetische pagina {n:02d}')
            for line_no, line in enumerate(textwrap.wrap(TEXT, width=75)):
                doc.drawString(35, 760 - line_no * 16, line)
            # Columns + table with deterministic unique values.
            doc.drawString(35, 700, 'Linkerkolom: beleid en begroting')
            doc.drawString(310, 700, 'Rechterkolom: controle en uitvoering')
            doc.drawString(35, 640, 'Jaar     Bedrag EUR')
            doc.drawString(35, 620, '2026     12345,67')
            doc.drawString(35, 600, '2027     23456,78')
        else:
            image = Image.new('RGB', (1200, 1700), 'white')
            font = ImageFont.truetype(str(pathlib.Path(reportlab.__file__).parent / 'fonts/Vera.ttf'), 25)
            draw = ImageDraw.Draw(image)
            draw.text((70, 70), f'Synthetische pagina {n:02d}', fill='black', font=font)
            draw.multiline_text((70, 140), '\n'.join(textwrap.wrap(TEXT, width=65)), fill='black', font=font, spacing=15)
            draw.text((70, 280), 'Jaar       Bedrag EUR\n2026       12345,67\n2027       23456,78', fill='black', font=font)
            if large:
                # Unique low-amplitude scanner noise, no invisible text layer.
                pixels = image.load()
                for _ in range(78000):
                    x, y = rng.randrange(1200), rng.randrange(400, 1700)
                    v = rng.randrange(220, 255)
                    pixels[x, y] = (v, v, v)
            doc.drawImage(ImageReader(image), 0, 0, width=595, height=842)
        doc.showPage()
    doc.save()
    return output.getvalue()


def generate(directory, benchmark=False, legacy=False):
    from docx import Document
    from pptx import Presentation
    from pptx.util import Inches
    from openpyxl import Workbook
    from odf.opendocument import OpenDocumentText
    from odf.text import P
    directory.mkdir(parents=True, exist_ok=True)
    for mode in ('digital', 'scan', 'mixed'):
        (directory / f'{mode}.pdf').write_bytes(pdf(mode))
    (directory / 'scan-one.pdf').write_bytes(pdf('scan', pages=1))
    document = Document()
    document.add_heading('Synthetisch gemeentelijk beleid', 0)
    document.add_paragraph(TEXT)
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text, table.cell(0, 1).text = 'Jaar', 'Bedrag EUR'
    table.cell(1, 0).text, table.cell(1, 1).text = '2026', '12345,67'
    document.save(directory / 'beleid.docx')
    presentation = Presentation()
    for n in (1, 2):
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(8), Inches(3))
        box.text = f'Synthetische dia {n}: {TEXT}'
    presentation.save(directory / 'beleid.pptx')
    workbook = Workbook()
    workbook.active.title = 'Begroting'
    workbook.active.append(['Jaar', 'Bedrag EUR'])
    workbook.active.append([2026, 12345.67])
    workbook.create_sheet('Toelichting').append([TEXT])
    workbook.save(directory / 'beleid.xlsx')
    odt = OpenDocumentText()
    odt.text.addElement(P(text=TEXT))
    odt.save(str(directory / 'beleid.odt'))
    (directory / 'beleid.eml').write_text(
        'From: synthetic@example.invalid\nTo: test@example.invalid\nSubject: Synthetisch beleid\n'
        'MIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\n' + TEXT)
    (directory / 'beleid.txt').write_text(TEXT)
    manifest = {'synthetic_only': True, 'expected_markers': [TEXT, '12345,67'],
                'legacy_doc': 'pending: optional offline LibreOffice export',
                'msg': 'pending: valid independently generated Outlook compound message',
                'benchmark': 'not generated'}
    if legacy:
        subprocess.run(['libreoffice', '-env:UserInstallation=file://' + str((directory / 'lo-profile').resolve()),
                        '--headless', '--convert-to', 'doc:MS Word 97', '--outdir', str(directory),
                        str(directory / 'beleid.odt')], check=True, timeout=30)
        manifest['legacy_doc'] = 'generated by isolated offline LibreOffice'
    if benchmark:
        data = pdf('scan', pages=30, large=True)
        (directory / 'scan-30.pdf').write_bytes(data)
        manifest['benchmark'] = {'pages': 30, 'bytes': len(data),
                                 'synthetic_only': True}
    (directory / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--benchmark', action='store_true')
    parser.add_argument('--legacy', action='store_true')
    args = parser.parse_args()
    print(json.dumps(generate(args.output, args.benchmark, args.legacy), indent=2, ensure_ascii=False))
