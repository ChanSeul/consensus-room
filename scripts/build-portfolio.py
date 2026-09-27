#!/usr/bin/env python3
"""Render the editable Korean portfolio. Requires ReportLab and Korean TTF fonts.

Example: python3 scripts/build-portfolio.py --font-regular /path/Regular.ttf
         --font-bold /path/Bold.ttf
Each top-level Markdown heading starts a page; overflow is a build error.
"""

import argparse
import html
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Image, Paragraph, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
INK = colors.HexColor('#182b43')
TEAL = colors.HexColor('#14746f')
MUTED = colors.HexColor('#60738a')
LINE = colors.HexColor('#d7e2e9')
PALE = colors.HexColor('#edf4f7')


def text_markup(text):
    text = html.escape(text)
    return re.sub(r'https://[^\s]+', lambda m: '<link href="' + m[0] + '" color="#14746f">' + m[0] + '</link>', text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--font-regular', required=True, type=Path)
    parser.add_argument('--font-bold', required=True, type=Path)
    parser.add_argument('--source', type=Path, default=ROOT / 'docs/consensus-room-portfolio.md')
    parser.add_argument('--output', type=Path, default=ROOT / 'docs/consensus-room-portfolio.pdf')
    args = parser.parse_args()
    pdfmetrics.registerFont(TTFont('Portfolio', str(args.font_regular)))
    pdfmetrics.registerFont(TTFont('PortfolioBold', str(args.font_bold)))
    pdfmetrics.registerFontFamily('Portfolio', normal='Portfolio', bold='PortfolioBold')
    styles = {
        'title': ParagraphStyle('title', fontName='PortfolioBold', fontSize=21, leading=29, textColor=INK, wordWrap='CJK'),
        'heading': ParagraphStyle('heading', fontName='PortfolioBold', fontSize=12, leading=18, textColor=TEAL, wordWrap='CJK'),
        'body': ParagraphStyle('body', fontName='Portfolio', fontSize=11.3, leading=19.5, textColor=INK, wordWrap='CJK'),
        'cell': ParagraphStyle('cell', fontName='Portfolio', fontSize=10.2, leading=16.4, textColor=INK, wordWrap='CJK'),
        'cell_head': ParagraphStyle('cell_head', fontName='PortfolioBold', fontSize=10.2, leading=16.4, textColor=INK, wordWrap='CJK'),
        'caption': ParagraphStyle('caption', fontName='Portfolio', fontSize=8.4, leading=13, textColor=MUTED, wordWrap='CJK', alignment=TA_LEFT),
    }
    pages = re.split(r'^# ', args.source.read_text(encoding='utf-8'), flags=re.M)[1:]
    width, height = A4
    margin = 44
    content_width = width - margin * 2
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix('.pending.pdf')
    # Match the edition date in the source while keeping repeated renders identical.
    os.environ['SOURCE_DATE_EPOCH'] = str(int(datetime(2026, 9, 27, tzinfo=timezone.utc).timestamp()))
    doc = canvas.Canvas(str(temporary), pagesize=A4, pageCompression=1, invariant=1)
    doc.setCreator('Consensus Room portfolio renderer')
    doc.setTitle('AI 개발 작업의 계획·구현·검토를 이어 가는 도구')
    doc.setAuthor('조찬슬')
    doc.setSubject('Consensus Room 설계, 엔진 개편, 실제 파일럿과 검증 범위 — 2026-09-27')
    doc.setKeywords('Consensus Room, 점진적 계획, 원문 조회, 역할 배정, 세션 연속성, 검증')
    bottoms = []
    for index, page in enumerate(pages, 1):
        title, body = page.split('\n', 1)
        doc.setFillColor(MUTED)
        doc.setFont('PortfolioBold', 8)
        doc.drawString(margin, height - 31, 'CONSENSUS ROOM  /  ENGINEERING CASE STUDY')
        doc.setStrokeColor(LINE)
        doc.line(margin, height - 40, width - margin, height - 40)
        y = height - 61

        def draw(flowable, gap=13):
            nonlocal y
            w, h = flowable.wrap(content_width, height)
            if y - h < 57:
                raise ValueError(f'Page {index} overflows by {57 - (y - h):.1f}pt: {title}')
            flowable.drawOn(doc, margin, y - h)
            y -= h + gap

        draw(Paragraph(text_markup(title), styles['title']), 20)
        for block in re.split(r'\n\s*\n', body.strip()):
            if block.startswith('## '):
                draw(Paragraph(text_markup(block[3:]), styles['heading']), 9)
            elif block.startswith('|'):
                rows = [[cell.strip() for cell in line.strip().strip('|').split('|')] for line in block.splitlines()]
                rows = [row for row in rows if not all(re.fullmatch(r'[-: ]+', cell) for cell in row)]
                column_count = len(rows[0])
                if not all(len(row) == column_count for row in rows):
                    raise ValueError(f'Page {index}: inconsistent table columns')
                fractions = [0.33, 0.67] if column_count == 2 else [0.24, 0.38, 0.38]
                if column_count not in (2, 3):
                    raise ValueError('Only two- and three-column tables are supported')
                data = [[Paragraph(text_markup(cell), styles['cell_head' if r == 0 else 'cell']) for cell in row] for r, row in enumerate(rows)]
                table = Table(data, colWidths=[content_width * f for f in fractions], hAlign='LEFT')
                table.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), PALE),
                    ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                    ('LEFTPADDING', (0, 0), (-1, -1), 10),
                    ('RIGHTPADDING', (0, 0), (-1, -1), 10),
                    ('TOPPADDING', (0, 0), (-1, -1), 8),
                    ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
                    ('LINEBELOW', (0, 0), (-1, -1), 0.45, LINE),
                ]))
                draw(table, 18)
            elif block.startswith('!['):
                match = re.fullmatch(r'!\[(.*?)\]\((.*?)\)', block)
                if not match:
                    raise ValueError(f'Page {index}: invalid image markup')
                picture = Image(str(args.source.parent / match[2]))
                scale = min(content_width / picture.imageWidth, 245 / picture.imageHeight)
                picture.drawWidth = picture.imageWidth * scale
                picture.drawHeight = picture.imageHeight * scale
                draw(picture, 6)
                draw(Paragraph(text_markup(match[1]), styles['caption']), 17)
            else:
                draw(Paragraph(text_markup(block.replace('\n', ' ')), styles['body']))
        bottoms.append(round(y, 1))
        doc.setStrokeColor(LINE)
        doc.line(margin, 42, width - margin, 42)
        doc.setFillColor(MUTED)
        doc.setFont('Portfolio', 8)
        doc.drawString(margin, 27, 'CONSENSUS ROOM  |  조찬슬  |  2026.09.27')
        doc.drawRightString(width - margin, 27, f'{index} / {len(pages)}')
        doc.showPage()
    doc.save()
    temporary.replace(args.output)
    print(f'{args.output}: {len(pages)} pages; content bottom positions: {bottoms}')


if __name__ == '__main__':
    main()
