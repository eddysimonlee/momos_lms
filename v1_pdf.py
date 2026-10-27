"""교육 항목 하나를 PDF 로 만든다(모바일 공유·다운로드용). 화면의 인쇄본(v1.js printView)과 같은 구성.

머리글(단계·단원·번호·제목) → 교육 목적 → 사진(3열) → 비고 → 교육 내용 + 출처명 → 수행 확인(빈 체크박스) → 기준일·출력일.
원문 본문·메모·상태 안내는 넣지 않는다. 글꼴: Pretendard(OFL-1.1, assets/fonts).
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fpdf import FPDF

APP = Path(__file__).resolve().parent
FONTS = APP / 'assets' / 'fonts'
KST = timezone(timedelta(hours=9))

INK, SUB, META, LINE = (32, 33, 36), (107, 110, 117), (58, 61, 66), (217, 218, 221)
NOTE_BAR, NOTE_BG = (168, 100, 0), (255, 246, 229)
ML, MT, MR, MB = 14, 16, 14, 16            # 여백(mm) — 인쇄 CSS @page 와 같다
GAP, PHOTO_H = 3, 42                       # 사진 칸 간격·높이(mm)


class _Doc(FPDF):
    def __init__(self):
        super().__init__(format='A4', unit='mm')
        self.set_margins(ML, MT, MR)
        self.set_auto_page_break(True, MB)
        self.add_font('P', '', str(FONTS / 'Pretendard-Regular.ttf'))
        self.add_font('P', 'B', str(FONTS / 'Pretendard-Bold.ttf'))
        self.set_title('모모스 온보딩')

    @property
    def width(self):
        return self.w - ML - MR

    def text_block(self, txt, size=10.5, style='', color=INK, x=None, w=None, lh=1.6, after=1.2):
        self.set_font('P', style, size)
        self.set_text_color(*color)
        self.set_x(ML if x is None else x)
        self.multi_cell(w or self.width - ((x or ML) - ML), size * 0.3528 * lh, txt, new_x='LMARGIN', new_y='NEXT')
        if after:
            self.ln(after)

    def heading(self, txt):
        if self.get_y() > self.h - MB - 20:  # 제목만 쪽 끝에 남지 않게
            self.add_page()
        self.ln(3)
        self.text_block(txt, 11.5, 'B', after=0.8)


def _stage_of(content, unit):
    return unit.get('stage') or {}


def build(content, step_id, photos_dir=APP / 'v1_photos', now=None):
    units = content['units']
    steps = [s for u in units for s in u['steps']]
    index = next((i for i, s in enumerate(steps) if s['id'] == step_id), None)
    if index is None:
        raise KeyError(step_id)
    s = steps[index]
    if s.get('lessonStatus') == 'planned':
        raise KeyError(step_id)
    unit = next(u for u in units if any(x['id'] == step_id for x in u['steps']))
    stage = _stage_of(content, unit)
    sections, documents = content['sections'], content['documents']

    def src_label(key):
        sec = sections.get(key)
        if not sec:
            return key
        doc = documents.get(sec['doc']) or {}
        label = ' '.join(x for x in (doc.get('title', ''), sec['no'], sec['title']) if x)
        return label + (f" · {sec['partLabel']}" if sec.get('partLabel') else '')  # 표 일부 인용: '· 2행'

    pdf = _Doc()
    pdf.set_title(f"{index + 1}_{s['title']}")
    pdf.add_page()

    # 머리글
    pdf.text_block('모모스 온보딩 · 온천 본점', 9, color=SUB, after=0.5)
    meta = f"{unit.get('no', '')} {unit['title']} · {index + 1}/{len(steps)}".strip()
    if stage:
        tag = f"{stage['order']}. {stage['title']}"
        pdf.set_font('P', '', 8.5)
        tw = pdf.get_string_width(tag) + 3.6
        y = pdf.get_y()
        pdf.set_draw_color(*META)
        pdf.set_line_width(0.26)
        pdf.set_text_color(*META)
        pdf.rect(ML, y + 0.3, tw, 4.6, round_corners=True, corner_radius=1)
        pdf.set_xy(ML, y + 0.3)
        pdf.cell(tw, 4.6, tag, align='C')
        pdf.set_xy(ML + tw + 1.5, y)
        pdf.set_font('P', '', 9.5)
        pdf.cell(0, 5.2, meta, new_x='LMARGIN', new_y='NEXT')
    else:
        pdf.text_block(meta, 9.5, color=META, after=0)
    pdf.ln(1)
    pdf.text_block(s['title'], 16, 'B', lh=1.35, after=1.5)
    pdf.set_draw_color(*INK)
    pdf.set_line_width(0.53)
    pdf.line(ML, pdf.get_y(), pdf.w - MR, pdf.get_y())
    pdf.ln(3)

    # 교육 목적
    pdf.heading('교육 목적')
    for p in ([s['purpose']] if s.get('purpose') else s.get('copy', [])):
        pdf.text_block(p)

    # 사진 3열
    shots = [content['photos'][p] for p in s.get('photos', []) if p in content['photos']]
    if shots:
        pdf.ln(1.5)
        cw = (pdf.width - GAP * 2) / 3
        for row in range(0, len(shots), 3):
            group = shots[row:row + 3]
            pdf.set_font('P', '', 8.5)
            cap_h = max(len(pdf.multi_cell(cw, 3.6, p['caption'], dry_run=True, output='LINES')) for p in group) * 3.6
            if pdf.get_y() + PHOTO_H + cap_h + 2 > pdf.h - MB:
                pdf.add_page()
            y = pdf.get_y()
            for n, p in enumerate(group):
                x = ML + n * (cw + GAP)
                pdf.set_draw_color(*LINE)
                pdf.set_line_width(0.18)
                pdf.rect(x, y, cw, PHOTO_H, round_corners=True, corner_radius=1)
                f = photos_dir / Path(p['src']).name
                if f.exists():
                    pdf.image(str(f), x=x + 0.4, y=y + 0.4, w=cw - 0.8, h=PHOTO_H - 0.8, keep_aspect_ratio=True)
                pdf.set_xy(x, y + PHOTO_H + 0.8)
                pdf.set_text_color(*SUB)
                pdf.multi_cell(cw, 3.6, p['caption'])
            pdf.set_y(y + PHOTO_H + 0.8 + cap_h + GAP)

    if s.get('note'):
        pdf.ln(1)
        pdf.set_font('P', '', 10.5)
        lines = pdf.multi_cell(pdf.width - 6, 5.6, s['note'], dry_run=True, output='LINES')
        h = len(lines) * 5.6 + 3.6
        y = pdf.get_y()
        pdf.set_fill_color(*NOTE_BG)
        pdf.rect(ML, y, pdf.width, h, style='F')
        pdf.set_fill_color(*NOTE_BAR)
        pdf.rect(ML, y, 0.7, h, style='F')
        pdf.set_xy(ML + 3.5, y + 1.8)
        pdf.set_text_color(*INK)
        pdf.multi_cell(pdf.width - 6, 5.6, s['note'], new_x='LMARGIN', new_y='NEXT')
        pdf.ln(2.5)

    # 교육 내용
    if not s.get('contentOmitted'):
        pdf.heading('교육 내용')
        kps = s.get('keyPoints') or []
        if kps:
            for n, k in enumerate(kps, 1):
                y = pdf.get_y()
                pdf.set_font('P', '', 10.5)
                pdf.set_text_color(*INK)
                pdf.set_xy(ML, y)
                pdf.cell(5.5, 5.9, f'{n}.')
                pdf.text_block(k['text'], x=ML + 5.5, after=0)
                cites = list(dict.fromkeys(k.get('cites') or []))
                if cites:
                    pdf.text_block('출처: ' + ' · '.join(src_label(c) for c in cites), 8.5, color=SUB, x=ML + 5.5, lh=1.45, after=0)
                pdf.ln(1.8)
        else:
            for p in s.get('copy', []):
                pdf.text_block(p)
        for d in s.get('refDocs') or []:
            pdf.text_block(f"원고 문서: {d['title']} ({d['ref']})", 8.5, color=SUB)

    # 수행 확인 — 빈 체크박스. 목록이 쪽 사이에서 갈라지지 않게 남은 높이를 먼저 본다
    pdf.set_font('P', '', 10.5)
    need = 12 + sum(len(pdf.multi_cell(pdf.width - 7, 5.9, c, dry_run=True, output='LINES')) * 5.9 + 1.5 for c in s['checks'])
    if pdf.get_y() + need > pdf.h - MB and need < pdf.h - MT - MB:
        pdf.add_page()
    pdf.heading('수행 확인')
    for c in s['checks']:
        y = pdf.get_y()
        pdf.set_draw_color(*INK)
        pdf.set_line_width(0.35)
        pdf.rect(ML, y + 1.1, 3.9, 3.9, round_corners=True, corner_radius=0.5)
        pdf.text_block(c, x=ML + 7, after=1.5)

    # 바닥글
    now = now or datetime.now(KST)
    pdf.ln(5)
    pdf.set_draw_color(*LINE)
    pdf.set_line_width(0.18)
    pdf.line(ML, pdf.get_y(), pdf.w - MR, pdf.get_y())
    pdf.ln(2)
    basis = (content.get('curriculumVersion') or '').replace('-', '.')
    pdf.text_block(f"콘텐츠 기준 {basis} · 출력 {now:%Y.%m.%d}", 8.5, color=SUB, after=0)
    return bytes(pdf.output()), f"{index + 1}_{s['title']}.pdf"
