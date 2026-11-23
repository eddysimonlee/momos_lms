"""원본 변경 확인(BACKLOG 3 · 11/16).

WORKS 드라이브 ST_매장사업부(works_auth.DOCS_PATH) 원본을 'LMS 를 만든 기준'과 비교한다.
  기준  source_manifest.json(문서 id·폴더·파일) + source_sections.json(문서 sha1·절 해시 — v1_build.py 가 만든다)
        + v1_content.json(교육이 인용한 절의 본문과 교육 내용)
  결과  문서마다: 그대로 / 바뀜 / 새 판(같은 폴더, 날짜만 다른 파일) / 이동 / 내용 같음(파일만 다름) / 없음 / 확인 실패.
        바뀐 문서는 절 단위로: 교육이 인용한 절의 AS-IS·TO-BE 와 영향받는 교육, 교육에 안 쓰인 바뀐 절·새 절·없어진 절.
  바뀐 곳 찾기는 코드(sha1·절 해시)가 하고, 교육 문구 고치기는 사람·LLM 이 한다(AGENTS.md '드라이브 sync 맞춰줘').
  바뀐 문서마다 수정 요청 티켓('원본 문서 변경 확인', REQ-n)을 만들고, 배포 뒤 '그대로'가 되면 '반영됨'으로 닫는다(onboarding.sync_drive_tickets).

실행
  LMS관리자 › 수정 요청 › [동기화]         누른 사람의 WORKS 로그인 열쇠(없으면 저장된 열쇠). 11/16 지금은 이것으로만 동기화한다
  (아침 자동 확인 --cron 은 남겨 두었지만 화면에서 켤 수 없다 — BACKLOG 3)
  LLM                                    GET /api/sync/report · /api/sync/file (사람별 LLM 연결 키, 마지막 동기화 결과 읽기만) — drive_pull.py
"""
import hashlib
import json
import os
import re
import secrets
import sys
import tempfile
import threading
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import lms_store as projects

APP = Path(__file__).parent
STATE_KEY = 30_000_000_001      # 마지막 확인 결과 · 파일 sha1 캐시 · 아침 확인 켜기/끄기
LLM_KEYS_KEY = 30_000_000_003   # 사람별 LLM 연결 키(지문만)
EXTRA_LIMIT = 200
_LOCK = threading.Lock()
_RUNNING = {}


class Busy(RuntimeError):
    pass


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def nfc(t):
    return unicodedata.normalize('NFC', str(t or '')).strip()


def stem(name):
    """파일 이름 → 같은 문서인지 볼 이름. 날짜(_YYMMDD)·유형 뒤(_SOP/_GUI/_FRM…)·확장자를 뺀다(source_parse.py 의 id 규칙)."""
    fn = nfc(name).rsplit('/', 1)[-1]
    return re.sub(r'[^0-9A-Za-z가-힣]+', '-', re.sub(r'_\d{6}|_(SOP|GUI|FRM).*$|\.docx$', '', fn)).strip('-')


def load_base(app=APP):
    j = lambda n: json.loads((Path(app) / n).read_text(encoding='utf-8'))
    m = j('source_manifest.json')
    return dict(manifest=m['documents'], manifestUpdated=m.get('updated', ''), sections=j('source_sections.json')['documents'], content=j('v1_content.json'))


# --- 비교 -------------------------------------------------------------------------------------------

def cite_refs(content):
    """절 키 → 그 절을 쓰는 교육 [{no, id, title, part: 'kp'|'other', index, text}]. kp = 교육 내용 몇 번째(0부터)."""
    keys, photos, refs = set(content['sections']), content.get('photos') or {}, {}
    steps = [s for u in content['units'] for s in u['steps']]
    for n, s in enumerate(steps, 1):
        base, seen = dict(no=n, id=s['id'], title=s['title']), set()
        for i, kp in enumerate(s.get('keyPoints') or []):
            for k in kp.get('cites') or []:
                refs.setdefault(k, []).append(dict(base, part='kp', index=i, text=kp['text']))
                seen.add(k)

        def walk(x):
            if isinstance(x, str):
                if x in keys and x not in seen:
                    refs.setdefault(x, []).append(dict(base, part='other'))
                    seen.add(x)
                elif x in photos:
                    walk(photos[x].get('cite'))
            elif isinstance(x, dict):
                for k, v in x.items():
                    if k != 'keyPoints':
                        walk(v)
            elif isinstance(x, list):
                for v in x:
                    walk(v)
        walk(s)
    return refs


def entry_of(sec, part):
    """v1_build.py 가 인용 절을 싣는 방식 그대로(문단 일부 'p…', 표 행·열 'r…'/'c…')."""
    import v1_build as vb
    e = dict(title=sec['title'], paragraphs=sec['paragraphs'], tables=sec['tables'])
    if part and part.startswith('p'):
        nums = vb._nums(part[1:])
        if not nums or not all(1 <= n <= len(sec['paragraphs']) for n in nums):
            raise KeyError(f'{sec["no"]} {sec["title"]}: 문단 "{part}" 이 없음')
        paras = [sec['paragraphs'][n - 1] for n in nums]
        e.update(paragraphs=paras[1:] if len(paras) > 1 else paras, tables=[], partLabel=paras[0][:40])
    elif part:
        tab, label = vb.table_part(sec, part)
        e.update(paragraphs=[], tables=[tab], partLabel=label)
    return e


def text_of(e):
    out = [e.get('title') or ''] + ([f"[{e['partLabel']}]"] if e.get('partLabel') else []) + list(e.get('paragraphs') or [])
    for t in e.get('tables') or []:
        out.append(' | '.join(t.get('header') or []))
        out += [' | '.join(r) for r in t.get('rows') or []]
    return '\n'.join(out)


def compare_doc(m, base_doc, newdoc, content, refs):
    import v1_build as vb
    newdoc = dict(newdoc, id=m['id'])
    cited = []
    for key, e in content['sections'].items():
        if e.get('doc') != m['id']:
            continue
        ref, _, part = key.split('|', 1)[1].partition('#')
        new, err = None, ''
        try:
            new = entry_of(vb.find_section(newdoc, ref), part or None)
        except (KeyError, IndexError, ValueError) as x:
            err = str(x).strip("'\"")[:200]
        old_t, new_t = text_of(e), text_of(new) if new else ''
        if new is None or old_t != new_t:
            cited.append(dict(key=key, no=e.get('no'), title=e.get('title'), part=e.get('partLabel') or '', asis=old_t, tobe=new_t,
                              missing=new is None, note=err, lessons=refs.get(key, [])))
    old = {(s[0] or s[1]): s for s in base_doc.get('sections') or []}
    now = {(s['no'] or s['title']): s for s in newdoc.get('sections') or []}
    # 바뀐 절 중 위에서 AS-IS/TO-BE 로 보여 주지 않은 것: 교육에 안 쓰인 절 + 교육이 일부(행·문단)만 인용했는데 인용 밖이 바뀐 절(11/20)
    shown = {c['no'] or c['title'] for c in cited}
    other = [[s['no'], s['title']] for k, s in now.items() if k in old and old[k][2] != s['hash'] and k not in shown]
    added = [[s['no'], s['title']] for k, s in now.items() if k not in old]
    removed = [[s[0], s[1]] for k, s in old.items() if k not in now]
    return dict(cited=cited, other=other, added=added, removed=removed)


def parse_docx(raw, name):
    try:
        import source_parse
    except SystemExit:  # python-docx 가 없으면 source_parse 가 끝낸다
        raise RuntimeError('python-docx 가 없어 원본을 읽을 수 없어요.')
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / (Path(nfc(name)).name or 'doc.docx')
        p.write_bytes(raw)
        return source_parse.parse(str(p))


def is_doc(path):
    name = nfc(path).rsplit('/', 1)[-1]
    return name.lower().endswith('.docx') and not name.startswith(('~$', '.'))


MATCH_MIN = 0.3         # 이름이 바뀐 새 판·나뉜 문서로 볼 최소 유사도(0~1). 여러 파일이 넘으면 '나뉨'. 11/23 실제 문서로 본 무관한 문서 점수는 0.04 이하
EMPTY_HASH = hashlib.sha1(b'').hexdigest()[:12]


def generic_marks(sections):
    """여러 근거 문서(3편 이상)에 똑같이 나오는 절 제목·절 본문 해시(목적·적용 범위·개정 이력 같은 서식 공통 부분) — 짝짓기 점수에서 뺀다."""
    norm = lambda s: re.sub(r'\s+', '', nfc(s))
    tf, hf = {}, {}
    for d in sections.values():
        for t in {norm(s[1]) for s in d.get('sections') or [] if s[1]}:
            tf[t] = tf.get(t, 0) + 1
        for h in {s[2] for s in d.get('sections') or [] if s[2]}:
            hf[h] = hf.get(h, 0) + 1
    return {t for t, n in tf.items() if n >= 3}, {h for h, n in hf.items() if n >= 3} | {EMPTY_HASH}


def similarity(base_secs, cand_secs, generic=(set(), set()), base_name='', cand_name=''):
    """기준 문서 ↔ 후보 문서가 같은 문서(또는 그 일부)인지 점수(0~1) = 절 본문 해시 0.5 + 절 제목 0.3 + 파일 이름 0.2.
    서식 공통 절(generic)은 세지 않는다. → (점수, 같은 절 수, 같은 제목 수)"""
    norm = lambda s: re.sub(r'\s+', '', nfc(s))
    gt, gh = generic
    bh = {s[2] for s in base_secs if s[2] and s[2] not in gh}
    ch = {s[2] for s in cand_secs if s[2] and s[2] not in gh}
    bt = {norm(s[1]) for s in base_secs if s[1] and norm(s[1]) not in gt}
    ct = {norm(s[1]) for s in cand_secs if s[1] and norm(s[1]) not in gt}
    same, titles = len(bh & ch), len(bt & ct)
    bs, cs = stem(base_name), stem(cand_name)
    words = lambda s: {w for w in s.split('-') if w}
    name = 1.0 if bs and bs in cs else len(words(bs) & words(cs)) / max(1, len(words(bs) | words(cs)))
    score = 0.5 * same / max(1, len(bh)) + 0.3 * titles / max(1, len(bt)) + 0.2 * name
    return round(score, 3), same, titles


def compare_split(m, bd, parts, content, refs):
    """11/23 문서 하나가 여러 파일로 나뉜 경우: 교육이 인용한 절마다 그 절이 지금 어느 파일에 어떻게 있는지(파일별 TO-BE),
    어느 파일에도 없는 기준 절(없어진 절), 기준에 없던 새 절(파일별)."""
    import v1_build as vb
    cited = []
    for key, e in content['sections'].items():
        if e.get('doc') != m['id']:
            continue
        ref, _, part = key.split('|', 1)[1].partition('#')
        old_t, variants = text_of(e), []
        for p in parts:
            try:
                variants.append(dict(path=p['path'], tobe=text_of(entry_of(vb.find_section(dict(p['doc'], id=m['id']), ref), part or None))))
            except (KeyError, IndexError, ValueError):
                variants.append(dict(path=p['path'], tobe='', missing=True))
        present = [v for v in variants if not v.get('missing')]
        if not present or any(v['tobe'] != old_t for v in present):
            cited.append(dict(key=key, no=e.get('no'), title=e.get('title'), part=e.get('partLabel') or '', asis=old_t, tobe=present[0]['tobe'] if present else '',
                              missing=not present, note='' if present else '나뉜 파일 어디에서도 이 절을 찾지 못함', lessons=refs.get(key, []), variants=variants))
    old = {(s[0] or s[1]): s[2] for s in bd.get('sections') or []}
    nows = {p['path']: {(s['no'] or s['title']): s for s in p['doc'].get('sections') or []} for p in parts}
    shown = {c['no'] or c['title'] for c in cited}
    removed = [[s[0], s[1]] for s in bd.get('sections') or [] if not any((s[0] or s[1]) in n for n in nows.values())]
    added = [[s['no'], s['title'], path] for path, n in nows.items() for k, s in n.items() if k not in old]
    other = [[s['no'], s['title'], path] for path, n in nows.items() for k, s in n.items() if k in old and old[k] != s['hash'] and k not in shown]
    return dict(cited=cited, other=other, added=added, removed=removed)


def compare(base, tree, fetch, sections_of=None, seen=None):
    """기준(LMS 를 만든 원본) ↔ 지금 드라이브. tree = [{path, fileId, size, modified, created}] (ST_매장사업부 아래 경로).
    fetch(f, force) → (sha1, 받은 바이트 또는 None). sections_of(f) → 그 파일의 절 목록 [[번호, 제목, 해시]](내용으로 짝짓기).
    근거 문서마다: 그대로 · 바뀜 · 내용 같음 · 새 판 · 이동 · 이름 바뀐 새 판 · 나뉨 · 없음 · 확인 실패.
    근거 문서와 짝지어지지 않은 docx 중 기준일(manifest updated) 뒤에 생기거나 고쳐진 것 = 새 문서(added)."""
    manifest, sections, content = base['manifest'], base['sections'], base['content']
    refs = cite_refs(content)
    titles = {k: v.get('title') for k, v in (content.get('documents') or {}).items()}
    generic = generic_marks(sections)
    files = [f for f in tree if is_doc(f['path'])]
    by_path = {nfc(f['path']): f for f in files}
    # 짝 후보·새 문서는 근거 문서가 있는 맨 위 폴더(매장사업부 공통·ST-002_온천본점 등) 안에서만, 아카이브 폴더는 빼고 찾는다
    # — 다른 지점 폴더·아카이브에 있는 같은 이름 사본을 잘못 짝짓지 않게(11/20 REQ-22)
    roots = {nfc(m['folder']).split('/', 1)[0] for m in manifest}
    movable = [x for x in files if nfc(x['path']).split('/', 1)[0] in roots and not any('아카이브' in seg for seg in nfc(x['path']).split('/')[:-1])]
    newest = lambda xs: max(xs, key=lambda x: x.get('modified') or '')
    # 1) 위치·이름으로: 그대로 → 같은 폴더에서 날짜만 다른 파일(새 판) → 후보 폴더의 같은 이름(이동)
    found, used = {}, set()
    for m in manifest:
        f = by_path.get(nfc(f"{m['folder']}/{m['file']}"))
        if f:
            found[m['id']] = ([f], None, None); used.add(nfc(f['path']))
    for m in manifest:
        if m['id'] in found:
            continue
        folder, st = nfc(m['folder']), stem(m['file'])
        same = [x for x in files if nfc(x['path']).rsplit('/', 1)[0] == folder and stem(x['path']) == st and nfc(x['path']) not in used]
        hits = same or [x for x in movable if nfc(x['path']) not in used and (nfc(x['path']).rsplit('/', 1)[-1] == nfc(m['file']) or stem(x['path']) == st)]
        if hits:
            f = newest(hits); found[m['id']] = ([f], '새 판' if same else '이동', None); used.add(nfc(f['path']))
    # 2) 그래도 없으면 내용으로: 짝 없는 후보 문서의 절을 읽어 점수를 매긴다. 하나가 넘으면 이름 바뀐 새 판, 여럿이 넘으면 나뉨(11/23)
    if sections_of:
        scored = {}
        for m in manifest:
            if m['id'] in found:
                continue
            bsec = (sections.get(m['id']) or {}).get('sections') or []
            for x in movable:
                if nfc(x['path']) in used:
                    continue
                try:
                    score, same, tl = similarity(bsec, sections_of(x), generic, m['file'], x['path'])
                except Exception:
                    continue
                if score >= MATCH_MIN:
                    scored.setdefault(m['id'], []).append((score, x, dict(path=nfc(x['path']), score=score, sameSections=same, sameTitles=tl, baseSections=len(bsec))))
        folder_of = {m['id']: nfc(m['folder']) for m in manifest}
        for mid, hits in scored.items():  # 원래 폴더의 파일을 맨 앞에(대표), 나머지는 점수 순
            hits = [h for h in sorted(hits, key=lambda h: (nfc(h[1]['path']).rsplit('/', 1)[0] != folder_of[mid], -h[0])) if nfc(h[1]['path']) not in used]
            if not hits:
                continue
            for h in hits:
                used.add(nfc(h[1]['path']))
            found[mid] = ([h[1] for h in hits], '이름 바뀐 새 판' if len(hits) == 1 else '나뉨', [h[2] for h in hits])
    docs = []
    for m in manifest:
        fs, how, match = found.get(m['id'], (None, None, None))
        rec = dict(id=m['id'], title=titles.get(m['id']) or m['id'], folder=m['folder'], file=m['file'])
        if not fs:
            docs.append(dict(rec, status='없음'))
            continue
        bd = sections.get(m['id']) or {}
        try:
            if how == '나뉨':
                parts = []
                for f, mt in zip(fs, match):
                    sha, raw = fetch(f, True)
                    parts.append(dict(path=nfc(f['path']), fileId=f.get('fileId'), modified=f.get('modified'), sha1=sha, doc=parse_docx(raw, f['path'])))
                    mt.update(fileId=f.get('fileId'), modified=f.get('modified'), sha1=sha)
                diff = compare_split(m, bd, parts, content, refs)
                docs.append(dict(rec, status='나뉨', path=parts[0]['path'], modified=parts[0]['modified'], fileId=parts[0]['fileId'],
                                 sha1=hashlib.sha1('|'.join(sorted(p['sha1'] for p in parts)).encode()).hexdigest(), parts=match, **diff))
                continue
            f = fs[0]
            rec.update(path=nfc(f['path']), modified=f.get('modified'), fileId=f.get('fileId'), **({'match': match[0]} if match else {}))
            sha, raw = fetch(f, False)
            if sha == (bd.get('sha1') or m.get('sha1')):
                docs.append(dict(rec, sha1=sha, status=how or '그대로'))
                continue
            if raw is None:
                sha, raw = fetch(f, True)
            nd = parse_docx(raw, f['path'])
            diff = compare_doc(m, bd, nd, content, refs)
            changed = any(diff.values())
            docs.append(dict(rec, sha1=sha, status=how or ('바뀜' if changed else '내용 같음'), version=nd.get('version'), revised=nd.get('revised_at'), **diff))
        except Exception as e:
            docs.append(dict(rec, status='확인 실패', error=f'{type(e).__name__}: {str(e)[:200]}'))
    extra = sorted(({'path': nfc(f['path']), 'modified': f.get('modified'), 'fileId': f.get('fileId')} for f in files if nfc(f['path']) not in used), key=lambda x: x['modified'] or '', reverse=True)
    # 3) 11/23 새 문서: 후보 폴더 안의 짝 없는 docx 중 LMS 기준일(manifest updated) 뒤에 생기거나 고쳐진 것(몇 번째 동기화든 같은 결과)
    since = str(base.get('manifestUpdated') or '')
    when = lambda x: str(x.get('created') or x.get('modified') or '')[:10]
    added = [{'path': nfc(x['path']), 'modified': x.get('modified'), 'created': x.get('created'), 'fileId': x.get('fileId')}
             for x in movable if nfc(x['path']) not in used and since and when(x) > since]
    counts = {}
    for d in docs:
        counts[d['status']] = counts.get(d['status'], 0) + 1
    if added:
        counts['새 문서'] = len(added)
    lessons = {}
    for d in docs:
        for c in d.get('cited') or []:
            for r in c['lessons']:
                lessons[r['id']] = dict(no=r['no'], id=r['id'], title=r['title'])
    return dict(format='momos-lms-drive-sync', version=2, baseline=dict(manifestUpdated=since, documents=len(manifest)),
                counts=counts, lessons=sorted(lessons.values(), key=lambda x: x['no']), docs=docs, added=added,
                extra=extra[:EXTRA_LIMIT], extraCount=len(extra))


# --- 상태(DB metadata 한 줄) ----------------------------------------------------------------------------

def read_state(store):
    with store.connect() as db:
        return projects.Rooms.read(db, STATE_KEY) or {}


def update_state(store, fn):
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        st = projects.Rooms.read(db, STATE_KEY) or {}
        fn(st)
        st['kind'] = 'drive-sync'
        projects.Rooms.write(db, STATE_KEY, st)
        return st


def _reason(e):
    from urllib.error import HTTPError
    if isinstance(e, HTTPError):
        return f'WORKS 드라이브 응답 {e.code}'
    return str(e)[:200] if re.search('[가-힣]', str(e)) else type(e).__name__


def run(store, token, by, base=None):
    """드라이브를 읽어 비교하고 결과를 저장한다. 한 번에 하나만(이미 돌고 있으면 Busy)."""
    if not _LOCK.acquire(blocking=False):
        raise Busy('이미 확인하고 있어요. 잠시 후 결과를 보세요.')
    try:
        _RUNNING.update(by=by, at=stamp())
        import works_auth as wa
        drive, folder, _ = wa.docs_folder(token)
        if not folder:
            raise RuntimeError('드라이브에서 ST_매장사업부 폴더를 찾지 못했어요.')
        tree = wa.docs_tree(token, drive, folder)
        prev = read_state(store)
        cache, fp = dict(prev.get('cache') or {}), dict(prev.get('fp') or {})

        def fetch(f, force):
            c = cache.get(f['fileId'])
            if not force and c and c.get('modified') == f.get('modified') and c.get('size') == f.get('size'):
                return c['sha1'], None
            raw = wa.docs_download(token, drive, f['fileId'])
            sha = hashlib.sha1(raw).hexdigest()
            cache[f['fileId']] = dict(modified=f.get('modified'), size=f.get('size'), sha1=sha)
            return sha, raw
        def sections_of(f):  # 짝 후보 문서의 절 목록(수정일·크기가 같으면 저장해 둔 것)
            c = fp.get(f['fileId'])
            if c and c.get('modified') == f.get('modified') and c.get('size') == f.get('size'):
                return c['secs']
            _, raw = fetch(f, True)
            secs = [[s['no'], s['title'], s['hash']] for s in parse_docx(raw, f['path'])['sections']]
            fp[f['fileId']] = dict(modified=f.get('modified'), size=f.get('size'), secs=secs)
            return secs
        report = compare(base or load_base(), tree, fetch, sections_of)
        report.update(at=stamp(), by=by, sharedriveId=drive)
        ids = {f['fileId'] for f in tree}

        def save(st):
            st.pop('seen', None)
            st.update(report=report, cache={k: v for k, v in cache.items() if k in ids},
                      fp={k: v for k, v in fp.items() if k in ids}, lastRun=dict(at=report['at'], by=by, ok=True))
        update_state(store, save)
        try:  # 바뀐 문서 → 수정 요청 티켓(REQ-n). 실패해도 확인 결과는 남는다. 새로 생긴 티켓 수는 화면 '동기화 완료' 안내에 쓴다
            import onboarding
            report['tickets'] = onboarding.sync_drive_tickets(store, report, by)
            update_state(store, lambda st: st['lastRun'].update(tickets=report['tickets']))
        except Exception as e:
            print(f'drive sync: tickets failed {type(e).__name__}', flush=True)
        print(f"drive sync: {by} ok docs={len(report['docs'])} counts={report['counts']} tickets={report.get('tickets')}", flush=True)
        return report
    except Busy:
        raise
    except Exception as e:
        msg = _reason(e)
        print(f'drive sync: {by} failed {type(e).__name__}', flush=True)
        try:
            update_state(store, lambda st: st.update(lastRun=dict(at=stamp(), by=by, ok=False, error=msg)))
        except Exception:
            pass
        raise
    finally:
        _RUNNING.clear()
        _LOCK.release()


def run_background(store, token, by):
    if _LOCK.locked():
        raise Busy('이미 확인하고 있어요. 잠시 후 결과를 보세요.')

    def go():
        try:
            run(store, token, by)
        except Exception:
            pass
    threading.Thread(target=go, daemon=True).start()
    time.sleep(0.05)


def set_auto(store, on, user):
    update_state(store, lambda st: st.update(auto=bool(on), autoBy=user.get('name') or '', autoAt=stamp()))


def view(store):
    st = read_state(store)
    return dict(auto=bool(st.get('auto')), autoBy=st.get('autoBy'), autoAt=st.get('autoAt'), lastRun=st.get('lastRun'),
                report=st.get('report'), running=dict(_RUNNING) or None)


def drive_tickets(store):
    """문서 id → 그 문서의 원본 변경 티켓(가장 최근) {no, status}. LLM 이 반영 기록 tickets 에 적을 번호."""
    import onboarding
    with store.connect() as db:
        root = projects.Rooms.read(db, onboarding.ROOT) or {}
    out = {}
    for r in root.get('contentRequests') or []:
        d = r.get('drive') or {}
        if d.get('docId'):
            out[d['docId']] = dict(no=r.get('no'), status=onboarding.req_status(r.get('status')), version=d.get('version'))
    return out


# --- 사람별 LLM 연결 키 ---------------------------------------------------------------------------------
# LMS관리자가 화면에서 만든다. 원문은 한 번만 보여 주고 서버에는 sha256 지문만 둔다. LMS관리자에서 해제되면 쓸 수 없다.

def _digest(raw):
    return hashlib.sha256(str(raw).encode()).hexdigest()


def _edit_keys(store, fn):
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        data = projects.Rooms.read(db, LLM_KEYS_KEY) or {}
        keys = data.get('keys') or {}
        out = fn(keys)
        projects.Rooms.write(db, LLM_KEYS_KEY, dict(kind='llm-keys', keys=keys))
        return out


def new_llm_key(store, user):
    raw = 'mlk_' + secrets.token_urlsafe(32)
    email = str(user.get('email') or '').lower()
    _edit_keys(store, lambda keys: keys.__setitem__(_digest(raw), dict(id=secrets.token_hex(4), email=email, name=user.get('name') or '', at=stamp(), last=None)))
    return raw


def revoke_llm_key(store, kid):
    def fn(keys):
        hit = [h for h, k in keys.items() if k.get('id') == kid]
        if not hit:
            raise ValueError('키를 찾지 못했어요.')
        for h in hit:
            keys.pop(h)
    _edit_keys(store, fn)


def list_llm_keys(store, admins):
    with store.connect() as db:
        keys = ((projects.Rooms.read(db, LLM_KEYS_KEY) or {}).get('keys') or {}).values()
    return sorted((dict(k, active=k.get('email') in admins) for k in keys), key=lambda k: k.get('at') or '', reverse=True)


def check_llm_key(store, header, admins):
    """Authorization: Bearer mlk_… → 그 키의 주인(LMS관리자일 때만). 마지막 사용 시각은 10분에 한 번만 적는다."""
    raw = header[7:].strip() if str(header or '').startswith('Bearer ') else ''
    if not raw.startswith('mlk_'):
        return None
    h = _digest(raw)
    with store.connect() as db:
        k = ((projects.Rooms.read(db, LLM_KEYS_KEY) or {}).get('keys') or {}).get(h)
    if not k or k.get('email') not in admins:
        return None
    last = k.get('last') or ''
    if not last or last < datetime.fromtimestamp(time.time() - 600, timezone.utc).isoformat(timespec='seconds'):
        try:
            _edit_keys(store, lambda keys: keys.get(h, {}).__setitem__('last', stamp()))
        except Exception:
            pass
    return k


# --- 아침 자동 확인(Render Cron Job) --------------------------------------------------------------------

class _DbStore:
    def __init__(self, database):
        self.database = database

    def connect(self):
        return self.database.connect()


def cron():
    """Render Cron Job: 아침 자동 확인이 켜져 있으면 저장된 LMS관리자 열쇠로 확인한다. 꺼져 있으면 아무것도 하지 않는다."""
    if os.environ.get('LMS_DATABASE_URL'):
        import cloud
        database = cloud.Database(cloud.Config.from_env(require_public=False).database_url)
        database.verify()
        store = _DbStore(database)
    else:
        import server
        store = server.Store(Path(os.environ.get('LMS_DATA_DIR') or APP / 'data'))
    if not read_state(store).get('auto'):
        print('drive sync: 아침 자동 확인이 꺼져 있어요(LMS관리자 › 원본 변경).', flush=True)
        return 0
    import works_auth
    try:
        token = works_auth.service_token(store)
    except works_auth.DirectoryUnavailable as e:
        update_state(store, lambda st: st.update(lastRun=dict(at=stamp(), by='아침 자동 확인', ok=False, error=str(e))))
        print('drive sync: 열쇠 없음', flush=True)
        return 1
    run(store, token, '아침 자동 확인')
    return 0


if __name__ == '__main__':
    if sys.argv[1:] == ['--cron']:
        sys.exit(cron())
    sys.exit('사용법: python3 drive_sync.py --cron')
