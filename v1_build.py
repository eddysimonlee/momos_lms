"""Build v1_content.json: the first-release slice of the course.

Inputs
  onboarding_course.json  항목(제목·체크·사진·일정)과 단원 — 교육과정 구조
  source_images/          원본 docx 에서 꺼낸 절별 사진(source_parse.py --images). 교육안이 [문서, 절, n번째] 로
                          고른 사진만 v1_content.json 에 싣는다 — 원본에 없는 사진은 싣지 않는다.
  v1_lessons.json         항목별 교육 목적·교육 내용·원본 인용 (초안, 사람이 검토)
  source_index.json       원본 매뉴얼(docx) 색인 — source_parse.py 의 출력. 저장소에 없으면
                          LMS_SOURCE_INDEX 환경변수로 경로를 준다.

Output: v1_content.json — 화면이 그대로 읽는 파일. 인용된 절만 담는다(문서 전문 없음).

    python3 v1_build.py
"""
import base64
import json
import os
import re
import sys
from pathlib import Path

APP = Path(__file__).parent
STAGES = [1, 2]  # 교육과정 journey 순서: 1 입사·현장 적응, 2 기본 운영·고객 응대·POS (55개 항목). 넓히려면 번호 추가.


SEP = ' › '


def section_key(doc, ref):
    return f'{doc}|{ref}'


def find_section(doc, ref):
    """ref = 절 번호, 번호 없는 절의 제목, 또는 'A › B'(A 뒤에 나오는 첫 B). 한 곳으로만 풀려야 한다."""
    secs = doc['sections']
    match = lambda s, r: (r and s['no'] == r) or (not s['no'] and s['title'] == r)
    if SEP in ref:
        a, b = ref.split(SEP, 1)
        hits = [i for i, s in enumerate(secs) if match(s, a)]
        if len(hits) != 1:
            raise KeyError(f'{doc["id"]}: "{a}" 가 {len(hits)}곳')
        for s in secs[hits[0] + 1:]:
            if match(s, b):
                return s
        raise KeyError(f'{doc["id"]}: "{a}" 뒤에 "{b}" 없음')
    hits = [s for s in secs if match(s, ref)]
    if len(hits) != 1:
        raise KeyError(f'{doc["id"]}: "{ref}" 가 {len(hits)}곳 — "상위 절 › {ref}" 로 적으세요')
    return hits[0]


def main():
    course = json.loads((APP / 'onboarding_course.json').read_text(encoding='utf-8'))
    lessons = json.loads((APP / 'v1_lessons.json').read_text(encoding='utf-8'))['lessons']
    index_path = Path(os.environ.get('LMS_SOURCE_INDEX', APP / 'source_index.json'))
    if not index_path.exists():
        sys.exit(f'원본 색인이 없습니다: {index_path}\n  python3 source_parse.py <원본 docx 폴더> -o source_index.json  로 먼저 만드세요.')
    index = json.loads(index_path.read_text(encoding='utf-8'))
    docs = {d['id']: d for d in index['documents']}  # 문서 키 = source_parse.py 의 id (파일명에서 날짜·유형을 뺀 이름)

    photos, used_sections, used_docs = {}, {}, set()
    images_dir = Path(os.environ.get('LMS_SOURCE_IMAGES', APP / 'source_images'))

    def lesson_photos(l):
        """교육안의 photos: [{cite: [문서, 절], n: 절 안의 몇 번째 사진(1부터), caption}] → 사진 키 목록.
        사진은 원본 절에서만 가져오고, 키는 원본 이미지의 sha1 이라 같은 사진은 한 번만 싣는다."""
        keys = []
        for ph in l.get('photos', []):
            doc, no = ph['cite']
            sec = find_section(docs[doc], no)
            items = sec.get('photos') or []
            if not 1 <= ph['n'] <= len(items):
                raise KeyError(f'{doc} {no}: 사진 {ph["n"]}번째가 없음 (이 절의 사진 {len(items)}장)')
            pid = items[ph['n'] - 1]['id']
            f = images_dir / f'{pid}.jpg'
            if not f.exists():
                sys.exit(f'사진 파일이 없습니다: {f}\n  python3 source_parse.py <원본 폴더> --images source_images  로 먼저 꺼내세요.')
            photos[pid] = dict(src='data:image/jpeg;base64,' + base64.b64encode(f.read_bytes()).decode(),
                               caption=ph.get('caption') or sec['title'], cite=section_key(doc, no), n=ph['n'],
                               wide=bool(items[ph['n'] - 1].get('w') and items[ph['n'] - 1]['w'] > 1.2 * items[ph['n'] - 1]['h']))  # 글씨 있는 가로 그림은 한 줄 전체
            keys.append(pid)
        return keys
    course_steps = {s['id']: (u, s) for u in course['units'] for s in u['steps']}

    def lesson_step(s):
        """교육과정의 항목 1개 + v1_lessons.json 의 교육안 → 화면용 항목."""
        l = lessons.get(s['id'], {})
        checks = l.get('checks')  # [{text, cites}] — 없으면 교육과정의 체크 문구
        cites = [tuple(c) for kp in l.get('keyPoints', []) + (checks or []) for c in kp['cites']] + [tuple(c) for c in l.get('sources', [])] \
            + [tuple(ph['cite']) for ph in l.get('photos', [])]
        sources = [list(c) for c in l['sources']] if l.get('sources') else list(dict.fromkeys(cites))
        for doc, no in cites:
            key = section_key(doc, no)
            if key not in used_sections:
                sec = find_section(docs[doc], no)
                used_sections[key] = dict(doc=doc, no=sec['no'], title=sec['title'], kind=sec['kind'], chars=sec['chars'],
                                          images=sec['images'], paragraphs=sec['paragraphs'], tables=sec['tables'], hash=sec['hash'])
                used_docs.add(doc)
        step = dict(id=s['id'], title=l.get('title') or s['title'], copy=s['copy'],
                    checks=[c['text'] for c in checks] if checks else s['checks'],
                    checkCites=[[section_key(*c) for c in k['cites']] for k in checks] if checks else [],
                    note=s.get('note') or '', photos=lesson_photos(l),  # 원본 docx 의 사진만(예전 원고 사진은 쓰지 않음)
                    purpose=l.get('purpose', ''),
                    keyPoints=[dict(text=kp['text'], cites=[section_key(*c) for c in kp['cites']]) for kp in l.get('keyPoints', [])],
                    sources=[section_key(*c) for c in sources],
                    # 원본 절 인용이 하나도 없는 항목만: 기존 교육과정의 U코드 원고 문서 이름을 싣는다(전문 없음).
                    refDocs=[] if sources else [dict(ref=r, title=course['refs'][r]['title'], file=course['refs'][r]['file'])
                                                   for r in (s.get('refs') or [s.get('ref')]) if r in course['refs']],
                    lessonStatus=l.get('status', 'none'))
        return step

    def planned_step(sess):
        """교육안이 아직 없는 세션(추가·교체): 제목·다룰 내용·근거 문서 예정만 싣는다. 수행 확인 없음."""
        return dict(id=sess['id'], title=sess['title'], copy=[], checks=[], checkCites=[], note='', photos=[], purpose='',
                    keyPoints=[], sources=[], refDocs=[], lessonStatus='planned',
                    topics=sess.get('topics', []), plannedSources=sess.get('sources', ''))

    units = []
    curriculum_path = APP / 'curriculum.json'
    if curriculum_path.exists():
        # 모모스 확정 교육과정: 단계 → 단원 → 세션. 기존 항목은 id 로 그대로 잇고, 추가·교체 세션은 '준비 중'으로 싣는다.
        curriculum = json.loads(curriculum_path.read_text(encoding='utf-8'))
        for st in curriculum['stages']:
            stage = dict(order=st['no'], title=st['title'], summary=st.get('summary', ''), note=st.get('note', ''))
            for u in st['units']:
                steps = []
                for sess in u['sessions']:
                    l = lessons.get(sess['id'], {})
                    fresh = l.get('curriculum') == curriculum['version']  # 이 교육과정 기준으로 다시 쓴 교육안
                    if sess['id'] in course_steps and (sess['kind'] != '교체' or fresh):
                        step = lesson_step(course_steps[sess['id']][1])
                    elif fresh and l.get('checks'):
                        # 새 세션: 교육과정(onboarding_course.json)에는 없고 교육안만 있다
                        step = lesson_step(dict(id=sess['id'], title=sess['title'], copy=[], checks=[], photos=[], refs=[], ref=''))
                    else:
                        step = planned_step(sess)
                    if sess.get('title'):
                        step['title'] = sess['title']
                        step['curriculumTitle'] = True  # 교육과정의 세션 제목이 교육안 제목보다 우선
                    step.update(kind=sess['kind'], sessionNote=sess.get('note', ''), fromItems=sess.get('from', []),
                                reworkPending=sess['kind'] in ('보완', '교체') and not fresh)
                    steps.append(step)
                plans = [course_steps[x['id']][0]['plan'] for x in steps if x['id'] in course_steps]
                units.append(dict(id=u['no'], no=u['no'], title=u['title'], summary=u.get('note', ''),
                                  plan=[min(p[0] for p in plans), max(p[1] for p in plans)] if plans else None,
                                  stage=stage, steps=steps))
        extra = [dict(title=e['title'], note=e.get('note', ''), sessions=[dict(id=x['id'], title=x['title']) for x in e['sessions']])
                 for e in curriculum.get('extra', [])]
    else:
        stage_of = {uid: dict(order=j['order'], title=j['title']) for j in course['journey'] if j['order'] in STAGES for uid in j['units']}
        order = [uid for j in sorted(course['journey'], key=lambda j: j['order']) if j['order'] in STAGES for uid in j['units']]
        for unit in sorted((u for u in course['units'] if u['id'] in stage_of), key=lambda u: order.index(u['id'])):
            units.append(dict(id=unit['id'], title=unit['title'], summary=unit['summary'], plan=unit['plan'], stage=stage_of[unit['id']],
                              steps=[lesson_step(s) for s in unit['steps']]))
        extra, curriculum = [], None
    out = dict(
        format='momos-lms-v1-content',
        courseVersion=course['version'], sourceIndexedAt=index['generated_at'],
        units=units, extra=extra, curriculumVersion=curriculum['version'] if curriculum else None,
        documents={k: dict(title=d['title'], type=d['type'], version=d['version'], revised=d['revised_at'], status=d['status'], file=d['file'], folder=d.get('folder', ''))
                   for k, d in docs.items() if k in used_docs},
        sections=used_sections,
        photos=dict(sorted(photos.items())),
    )
    (APP / 'v1_content.json').write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
    print('v1_content.json:', sum(len(u['steps']) for u in units), 'steps,', len(out['documents']), 'documents,', len(out['sections']), 'sections,', len(out['photos']), 'photos')


if __name__ == '__main__':
    main()
