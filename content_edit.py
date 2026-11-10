"""11/10 교육 문구 직접 수정(관리자) — 제출 때 서버가 하는 자동 사전 검사.

같은 규칙이 v1.js 의 ContentEdit(입력하는 동안 화면 아래 경고)에 있다. 두 쪽은 content_edit_cases.json 으로 같은 결과인지 테스트한다.
검사 기준은 '그 줄의 근거 절'(교육 목적은 그 교육 모든 교육 내용의 근거 절). 근거에 없으면 다른 절 위치를 안내만 한다.
11/10 이재현: 남기는 규칙은 '수정 필요'(block) 5개뿐 — 빈 문구·같은 문구·길이·태그/링크/이모지·같은 줄 반영 대기(줄바꿈 횟수는 제한하지 않음, 11/10).
원문과 뜻이 맞는지(수치·이름 포함)는 글자 대조로 판단할 수 없어(예: 3000g = 3kg) 빼고, 배포할 때 사람이 AI 와 함께 확인한다(AGENTS.md).
변경 종류 자동 추천 = 수치가 바뀌면 '재확인 필요', 아니면 '단순 수정'(화면에는 안 보이고 티켓에만 남는다).
"""
import json
import re
from pathlib import Path

LIMIT = {'purpose': 120, 'kp': 200}
KINDS = ('재확인 필요', '단순 수정')
UNIT = r'(?:kg|g|mL|ml|L|ℓ|℃|°C|cm|mm|%|시간|분|초|잔|배치|통|샷|개월|개|일|장|병|회|번|명|층|동|팩|봉|스푼|펌프|주|년|원)'
NUM = re.compile(r'\d[\d.]*(?:~\d[\d.]*)?' + UNIT)
MARKUP = re.compile(r'<[^>]*>|https?://|www\.|[\U0001F300-\U0001FAFF☀-➿]')


def norm(s):
    s = str(s or '').replace('\r\n', '\n')
    s = re.sub(r'(\d),(?=\d{3}(?!\d))', r'\1', s)          # 1,550 → 1550
    s = re.sub(r'(\d)\s*[~\-–]\s*(?=\d)', r'\1~', s)        # 4-6 · 4 ~ 6 → 4~6
    s = re.sub(r'(\d)[ \t]+(?=[^\d\s])', r'\1', s)          # 28 잔 → 28잔
    return s


def numbers(s):
    out = []
    for m in NUM.findall(norm(s)):
        if m not in out: out.append(m)
    return out


def section_text(sec):
    return '\n'.join(list(sec.get('paragraphs') or []) + ['\t'.join(c for c in [t.get('header') or []] + (t.get('rows') or []) for c in c)
                                                           for t in sec.get('tables') or []])


def check(part, asis, tobe, open_req=None):
    """part: 'purpose'|'kp'. open_req: 같은 줄에 반영 대기 중인 티켓 번호.
    → {'items': [{level: 'block', code, text}], 'suggest': '재확인 필요'|'단순 수정'}"""
    items = []
    add = lambda code, text: items.append(dict(level='block', code=code, text=text))
    a, t = str(asis or '').replace('\r\n', '\n').strip(), str(tobe or '').replace('\r\n', '\n').strip()
    if open_req: add('open', f'이 줄은 {open_req} 로 이미 반영 대기 중이에요. 배포 뒤 다시 고쳐 주세요.')
    if not t: add('empty', '바꿀 문구를 적어 주세요.')
    elif t == a: add('same', '지금 문구와 같아요.')
    if len(t) > LIMIT[part]: add('length', f'{LIMIT[part]}자까지 쓸 수 있어요. (지금 {len(t)}자)')
    if MARKUP.search(t): add('markup', '태그·링크·이모지는 쓸 수 없어요.')
    changed = set(numbers(t)) ^ set(numbers(a))  # 변경 종류 자동 추천에만 쓴다(검사 아님)
    return dict(items=items, suggest='재확인 필요' if t and changed else '단순 수정')


# --- 서버: 지금 교육 문구·근거 절 읽기(server.v1_content 와 같은 인용 키 규칙)
_CACHE = {}


def _key(c):
    return f'{c[0]}|{c[1]}' + (f'#{c[2]}' if len(c) > 2 and c[2] else '')


def load(app):
    app = Path(app)
    paths = (app / 'v1_content.json', app / 'v1_lessons.json')
    stamp = tuple(p.stat().st_mtime_ns if p.exists() else 0 for p in paths)
    if _CACHE.get('stamp') != stamp:
        content = json.loads(paths[0].read_text(encoding='utf-8')) if paths[0].exists() else {}
        lessons = json.loads(paths[1].read_text(encoding='utf-8')).get('lessons', {}) if paths[1].exists() else {}
        sections = content.get('sections', {})
        _CACHE.update(stamp=stamp, sections=sections, lessons=lessons, documents=content.get('documents', {}))
    return _CACHE


def label(data, key, same=()):
    sec = data['sections'].get(key) or {}
    doc = data['documents'].get(sec.get('doc')) or {}
    head = '같은 문서' if sec.get('doc') in same else doc.get('title', '')
    return f"{head} {sec.get('no', '')} {sec.get('title', '')}".strip()


def current(data, step, part, index):
    """→ (지금 문구, 근거 절 키 목록). 없으면 ValueError."""
    l = data['lessons'].get(step)
    if not l: raise ValueError('고칠 교육을 찾지 못했어요.')
    kps = l.get('keyPoints') or []
    if part == 'purpose':
        if not l.get('purpose'): raise ValueError('이 교육에는 교육 목적이 없어요.')
        keys = []
        for k in kps:
            for c in k.get('cites', []):
                if _key(c) not in keys: keys.append(_key(c))
        return l['purpose'], keys
    if type(index) is not int or not 0 <= index < len(kps): raise ValueError('고칠 교육 내용을 확인해 주세요.')
    return kps[index]['text'], list(dict.fromkeys(_key(c) for c in kps[index].get('cites', [])))


def review(app, step, part, index, asis, tobe, open_req=None):
    data = load(app)
    text, keys = current(data, step, part, index)
    if asis != text: raise ValueError('그 사이 문구가 바뀌었어요. 화면을 새로 고친 뒤 다시 고쳐 주세요.')
    return check(part, asis, tobe, open_req)


def cited(app, step, part, index):
    """그 줄의 근거 원문 [(위치 이름, 글)] — apply_edits.py --check 가 사람·AI 확인용으로 보여 준다."""
    data = load(app)
    _, keys = current(data, step, part, index)
    def readable(sec):  # 표는 한 행에 한 줄
        rows = [' | '.join(r) for t in sec.get('tables') or [] for r in [t.get('header') or []] + (t.get('rows') or []) if r]
        return '\n'.join(list(sec.get('paragraphs') or []) + rows)
    return [(label(data, k), readable(data['sections'][k])) for k in keys if k in data['sections']]
