#!/usr/bin/env python3
"""Render the Korean case study with prose and supporting vector diagrams.

python3 scripts/build-portfolio.py --font-regular Regular.ttf --font-bold Bold.ttf
All diagrams, labels and platform icons remain vectors in the PDF.
"""
import argparse
import html
import json
import math
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from reportlab.graphics import renderPDF
from reportlab.graphics.shapes import Drawing, Group
from reportlab.graphics.svgpath import SvgPath
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Paragraph

ROOT = Path(__file__).resolve().parents[1]
INK = '#183343'
MUTED = '#576F7D'
LINE = '#D7E3E8'
COLORS = {'teal': ('#087F80', '#E8F5F3'), 'blue': ('#306DC0', '#EDF3FC'),
          'coral': ('#BF674A', '#FCF0E9'), 'purple': ('#7964A7', '#F2EEF8'),
          'gray': ('#647985', '#F0F4F6'), 'red': ('#AF4D5D', '#FCEEF0')}
W, H = A4
MARGIN = 42
CW = W - 2 * MARGIN


def color(s):
    return colors.HexColor(s)


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
    icons = json.loads((args.source.parent / 'images/portfolio-icons.json').read_text())
    pages = re.split(r'^# ', args.source.read_text(), flags=re.M)[1:]
    specs = []
    for section in pages:
        title = section.split('\n', 1)[0]
        if re.search(r'(다[.!]?|나요\?|까요\?)$', title):
            raise ValueError('Use a concise noun title: ' + title)
        match = re.search(r'```diagram\n(.*?)\n```', section, re.S)
        if not match:
            raise ValueError('Missing diagram: ' + title)
        spec = json.loads(match[1])
        spec['intro'] = section.split('\n', 1)[1].split('```diagram', 1)[0].strip()
        body = section[match.end():].split('관련 자료:', 1)[0].strip()
        spec['body'] = []
        for block in re.split(r'^## ', body, flags=re.M)[1:]:
            heading, prose = block.split('\n', 1)
            spec['body'].append((heading, [p.strip() for p in prose.split('\n\n') if p.strip()]))
        specs.append((title, spec))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix('.pending.pdf')
    os.environ['SOURCE_DATE_EPOCH'] = str(int(datetime(2026, 10, 5, tzinfo=timezone.utc).timestamp()))
    c = canvas.Canvas(str(temporary), pagesize=A4, pageCompression=1, invariant=1)
    c.setTitle('Consensus Room | AI 개발 작업 관리')
    c.setAuthor('조찬슬')
    c.setCreator('Consensus Room vector portfolio renderer')
    c.setSubject('계층별 책임·승인된 연속 실행·자료 수집과 복구 | 2026-10-05')
    c.setKeywords('Consensus Room, Claude, Codex, 워크플로, 계층 계약, 복구, 시각화')
    counts = []

    def rect(x, y, w, h, fill, stroke=LINE, radius=12, dashed=False):
        c.setFillColor(color(fill)); c.setStrokeColor(color(stroke)); c.setLineWidth(.8)
        c.setDash(3, 3) if dashed else c.setDash()
        c.roundRect(x, H-y-h, w, h, radius, fill=1, stroke=1)
        c.setDash()

    def text(value, x, y, w, size=11, bold=False, ink=INK, align=0, max_h=100):
        style = ParagraphStyle('text', fontName='PortfolioBold' if bold else 'Portfolio',
                               fontSize=size, leading=size*1.45, textColor=color(ink),
                               wordWrap='CJK', alignment=align)
        p = Paragraph(html.escape(value).replace('\n', '<br/>'), style)
        _, height = p.wrap(w, max_h)
        if height > max_h + .2:
            raise ValueError(f'Text overflow on page {index}: {value[:60]} ({height:.1f}>{max_h})')
        if y + height > H-10:
            raise ValueError(f'Footer overlap on page {index}: {value[:50]}')
        p.drawOn(c, x, H-y-height)
        return height

    def icon(name, x, y, size=25):
        record = icons[name]
        drawing = Drawing(size, size)
        # SVG coordinates point down; PDF coordinates point up.
        vx, vy, vw, vh = record.get('viewbox', [0, 0, 24, 24])
        scale = size/max(vw, vh)
        g = Group(); g.transform = (scale, 0, 0, -scale, (size-vw*scale)/2-vx*scale, (size+vh*scale)/2+vy*scale)
        for j, path in enumerate(record['paths']):
            fill = record.get('fills', [record['color']] * len(record['paths']))[j]
            g.add(SvgPath(path, fillColor=color(fill), strokeColor=None))
        drawing.add(g); renderPDF.draw(drawing, c, x, H-y-size)

    def draw_element(e):
        kind = e['kind']
        x, y = MARGIN + e.get('x', 0), diagram_top + e.get('y', 0)
        accent, pale = COLORS[e.get('color', 'teal')]
        if kind in ('node', 'metric'):
            w, h = e['w'], e['h']
            rect(x, y, w, h, pale, pale)
            tx = x+14
            if e.get('icon'):
                icon(e['icon'], tx, y+14, 23); tx += 32
            label_h = text(e['label'], tx, y+14, x+w-12-tx, e.get('size', 12), True, accent, max_h=h-24)
            if e.get('body'):
                start = max(45 if e.get('icon') else 35, 14+label_h+8)
                text(e['body'], x+14, y+start, w-28, e.get('body_size', 10), ink=INK, max_h=h-start-10)
        elif kind == 'group':
            rect(x, y, e['w'], e['h'], '#FFFFFF', LINE, dashed=True)
            text(e['label'], x+12, y+9, e['w']-24, 9, True, MUTED, max_h=30)
        elif kind == 'text':
            text(e['label'], x, y, e.get('w', 150), e.get('size', 10), e.get('bold', False), e.get('ink', MUTED), e.get('align', 0), e.get('h', 80))
        elif kind == 'arrow':
            points = [(MARGIN+px, H-diagram_top-py) for px, py in e['points']]
            c.setStrokeColor(color(accent)); c.setFillColor(color(accent)); c.setLineWidth(e.get('width', 1.5))
            c.setDash(4, 3) if e.get('dashed') else c.setDash()
            p = c.beginPath(); p.moveTo(*points[0])
            for px,py in points[1:]: p.lineTo(px,py)
            c.drawPath(p); c.setDash()
            end, prev = points[-1], points[-2]
            a = math.atan2(end[1]-prev[1], end[0]-prev[0]); length=6
            p=c.beginPath(); p.moveTo(*end)
            p.lineTo(end[0]-length*math.cos(a-.45),end[1]-length*math.sin(a-.45))
            p.lineTo(end[0]-length*math.cos(a+.45),end[1]-length*math.sin(a+.45));p.close()
            c.drawPath(p,fill=1,stroke=0)
        elif kind == 'diamond':
            w,h=e['w'],e['h'];c.setStrokeColor(color(accent));c.setFillColor(color(pale));c.setLineWidth(1)
            p=c.beginPath();p.moveTo(x+w/2,H-y);p.lineTo(x+w,H-y-h/2);p.lineTo(x+w/2,H-y-h);p.lineTo(x,H-y-h/2);p.close();c.drawPath(p,fill=1,stroke=1)
            text(e['label'],x+w*.17,y+h*.3,w*.66,11,True,accent,1,max_h=h*.5)
        elif kind == 'image':
            source = (args.source.parent / e['path']).resolve()
            im=ImageReader(str(source));iw,ih=im.getSize();s=min(e['w']/iw,e['h']/ih)
            c.drawImage(im,x+(e['w']-iw*s)/2,H-y-ih*s,width=iw*s,height=ih*s,mask='auto')
        elif kind == 'bar':
            w,h=e['w'],e['h'];cur=x
            for part in e['parts']:
                partw=w*part['fraction'];c.setFillColor(color(COLORS[part['color']][0]));c.rect(cur,H-y-h,partw,h,stroke=0,fill=1);cur+=partw
        elif kind == 'icon':
            icon(e['name'],x,y,e.get('size',25))
        else: raise ValueError('Unknown diagram element: '+kind)

    for index, (title, spec) in enumerate(specs, 1):
        c.setFillColor(color('#FFFFFF'));c.rect(0,0,W,H,fill=1,stroke=0)
        c.setFillColor(color('#087F80'));c.rect(0,H-8,W,8,fill=1,stroke=0)
        text('CONSENSUS ROOM  /  '+spec['section'],MARGIN,29,CW-60,8,True,MUTED,max_h=20)
        text(f'{index:02d}',W-MARGIN-30,26,30,14,True,'#087F80',2,max_h=22)
        text(title,MARGIN,65,CW,24,True,max_h=72)
        text(spec['lead'],MARGIN,112,CW,10.5,ink=MUTED,max_h=34)
        intro_height = text(spec['intro'],MARGIN,160,CW,10.8,max_h=95)
        diagram_top = 160 + intro_height + 20
        for element in spec['elements']:
            draw_element(element)
        y = diagram_top + spec['height'] + 23
        for heading, paragraphs in spec['body']:
            y += text(heading,MARGIN,y,CW,12,True,'#087F80',max_h=35) + 9
            for paragraph in paragraphs:
                y += text(paragraph,MARGIN,y,CW,10.8,max_h=766-y) + 9
            y += 7
        text(spec.get('source',''),MARGIN,776,CW,6.8,ink=MUTED,max_h=22)
        text('조찬슬  ·  2026.10.05',MARGIN,815,CW-60,7,ink=MUTED,max_h=12)
        text(f'{index} / {len(specs)}',W-MARGIN-60,815,60,7,ink=MUTED,align=2,max_h=12)
        counts.append(len(spec['elements']));c.showPage()
    c.save();temporary.replace(args.output)
    print(json.dumps({'pages':len(specs),'elements':sum(counts),'output':str(args.output)},ensure_ascii=False))

if __name__ == '__main__': main()
