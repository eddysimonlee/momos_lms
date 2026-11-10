"""11/10 교육 문구 직접 수정(관리자) — 제출 때 서버가 하는 자동 사전 검사.

같은 규칙이 v1.js 의 ContentEdit(입력하는 동안 화면 아래 경고)에 있다. 두 쪽은 content_edit_cases.json 으로 같은 결과인지 테스트한다.
검사 기준은 '그 줄의 근거 절'(교육 목적은 그 교육 모든 교육 내용의 근거 절). 근거에 없으면 다른 절 위치를 안내만 한다.
단계: block(보낼 수 없음) · warn(보낼 수 있고 티켓에 남음) · info(참고)
"""
import json
import re
from pathlib import Path

LIMIT = {'purpose': 120, 'kp': 200}
BREAKS = {'purpose': 0, 'kp': 1}
KINDS = ('재확인 필요', '단순 수정')
UNIT = r'(?:kg|g|mL|ml|L|ℓ|℃|°C|cm|mm|%|시간|분|초|잔|배치|통|샷|개월|개|일|장|병|회|번|명|층|동|팩|봉|스푼|펌프|주|년|원)'
NUM = re.compile(r'\d[\d.]*(?:~\d[\d.]*)?' + UNIT)
MARKUP = re.compile(r'<[^>]*>|https?://|www\.|[\U0001F300-\U0001FAFF☀-➿]')
STRONG = ('않', '금지', '하지 말', '말 것', '반드시', '필수', '절대')
STOP = {'기준', '항목', '품목', '재료', '용량', '수량', '비고', '내용', '담당', '위치', '시간', '방법', '순서', '구분', '상미기한'}


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


def has(text, token):
    return re.search(r'(?<![\d.])' + re.escape(token), text) is not None


def section_text(sec):
    return '\n'.join(list(sec.get('paragraphs') or []) + ['\t'.join(c for c in [t.get('header') or []] + (t.get('rows') or []) for c in c)
                                                           for t in sec.get('tables') or []])


def terms_of(sections):
    """원본 표 칸에 나오는 짧은 이름(잔·장비·장소·메뉴명): 3~12자, 한글 포함, 숫자·띄어쓰기 없음."""
    out = set()
    for sec in sections.values():
        for t in sec.get('tables') or []:
            for row in t.get('rows') or []:
                for c in row:
                    c = str(c).strip()
                    if 3 <= len(c) <= 12 and re.search('[가-힣]', c) and not re.search(r'[\d\s]', c) and c not in STOP: out.add(c)
    return sorted(out, key=lambda x: (-len(x), x))


def ratio(a, b):
    """두 글이 얼마나 같은지(0~1): 공통 부분 수열 글자 수 × 2 / 전체 글자 수."""
    a, b = a.replace(' ', ''), b.replace(' ', '')
    if not a and not b: return 1.0
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0]
        for j, y in enumerate(b):
            cur.append(prev[j] + 1 if x == y else max(prev[j + 1], cur[j]))
        prev = cur
    return 2 * prev[-1] / (len(a) + len(b))


def check(part, asis, tobe, cited, others=(), terms=(), open_req=None):
    """part: 'purpose'|'kp'. cited: 근거 절 글 목록. others: [(위치 이름, 글)] 근거가 아닌 절. open_req: 같은 줄에 검토 중인 티켓 번호.
    → {'items': [{level, code, text}], 'suggest': '재확인 필요'|'단순 수정'}"""
    items = []
    add = lambda level, code, text: items.append(dict(level=level, code=code, text=text))
    a, t = str(asis or '').replace('\r\n', '\n').strip(), str(tobe or '').replace('\r\n', '\n').strip()
    src = norm('\n'.join(cited))
    if open_req: add('block', 'open', f'이 줄은 {open_req} 로 이미 검토 중이에요. 검토가 끝난 뒤 다시 고쳐 주세요.')
    if not t: add('block', 'empty', '바꿀 문구를 적어 주세요.')
    elif t == a: add('block', 'same', '지금 문구와 같아요.')
    if len(t) > LIMIT[part]: add('block', 'length', f'{LIMIT[part]}자까지 쓸 수 있어요. (지금 {len(t)}자)')
    if t.count('\n') > BREAKS[part]: add('block', 'breaks', '교육 목적은 줄바꿈 없이 써 주세요.' if part == 'purpose' else '줄바꿈은 한 번까지 쓸 수 있어요.')
    if MARKUP.search(t): add('block', 'markup', '태그·링크·이모지는 쓸 수 없어요.')
    nums_a = numbers(a)
    for n in numbers(t):
        if n in nums_a and not has(src, n):
            continue  # 원래 문구에 있던 값(근거 밖)은 이번 수정의 책임이 아니다
        if not has(src, n):
            where = list(dict.fromkeys(label for label, text in others if has(norm(text), n)))[:2]
            add('block', 'number', f"근거 원문에 없는 수치: '{n}'" + (f" ({' · '.join(where)}에 있음 — 근거를 바꾸려면 '원본 매핑 변경' 요청)" if where else ''))
    nt = norm(t)
    for w in (terms if t else ()):
        if w in t and w not in a and w not in src:
            add('warn', 'term', f"근거 원문에 없는 이름: '{w}' — 다른 절 내용인지 확인해 주세요.")
    for n in (nums_a if t else ()):
        if not has(nt, n) and has(src, n): add('warn', 'dropped', f"원문에 있는데 빠진 내용: '{n}'")
    for w in (terms if t else ()):
        if w in a and w not in t and w in src: add('warn', 'dropped', f"원문에 있는데 빠진 내용: '{w}'")
    flip = [w for w in STRONG if a.count(w) != t.count(w)]
    if flip and t: add('warn', 'negation', f"뜻을 바꿀 수 있는 말이 늘거나 줄었어요: '{', '.join(flip)}' — 뜻이 뒤집히지 않았는지 확인해 주세요.")
    if a and t and t != a and ratio(a, t) < 0.5: add('warn', 'rewrite', "절반 넘게 바뀌었어요. 새 내용이면 '교육 내용 추가' 요청이 맞는지 확인해 주세요.")
    end = r'(다|\))\.$' if part == 'kp' else r'다\.$'
    if t and re.search(end, a) and not re.search(end, t):
        add('warn', 'style', "교육 내용은 '~다.'로 끝내 주세요." if part == 'kp' else "교육 목적은 '~할 수 있다.'처럼 끝내 주세요.")
    changed_nums = sorted(set(numbers(t)) ^ set(nums_a))
    suggest = '재확인 필요' if changed_nums or flip else '단순 수정'
    if t and t != a: add('info', 'summary', f'수치 {len(changed_nums)}곳 바뀜' if changed_nums else '수치 그대로')
    return dict(items=items, suggest=suggest)


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
        _CACHE.update(stamp=stamp, sections=sections, lessons=lessons, documents=content.get('documents', {}), terms=terms_of(sections))
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
    cited = [section_text(data['sections'][k]) for k in keys if k in data['sections']]
    docs = {data['sections'][k].get('doc') for k in keys if k in data['sections']}
    others = [(label(data, k, docs), section_text(s)) for k, s in data['sections'].items() if k not in keys]
    return check(part, asis, tobe, cited, others, data['terms'], open_req)
