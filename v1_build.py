"""Build v1_content.json: the first-release slice of the course.

Inputs
  onboarding_course.json  항목(제목·체크·사진·일정)과 단원 — 교육과정 구조
  onboarding.html         사진 데이터(source-data)
  v1_lessons.json         항목별 교육 목적·교육 내용·원본 인용 (초안, 사람이 검토)
  source_index.json       원본 매뉴얼(docx) 색인 — source_parse.py 의 출력. 저장소에 없으면
                          LMS_SOURCE_INDEX 환경변수로 경로를 준다.

Output: v1_content.json — 화면이 그대로 읽는 파일. 인용된 절만 담는다(문서 전문 없음).

    python3 v1_build.py
"""
import json
import os
import re
import sys
from pathlib import Path

APP = Path(__file__).parent
UNITS = ['welcome']  # 입사·근무 준비. Add unit ids here to widen the slice.


def section_key(doc, no):
    return f'{doc}|{no}'


def main():
    course = json.loads((APP / 'onboarding_course.json').read_text(encoding='utf-8'))
    html = (APP / 'onboarding.html').read_text(encoding='utf-8')
    source = json.loads(re.search(r'<script id="source-data" type="application/json">(.*?)</script>', html, re.S).group(1))
    lessons = json.loads((APP / 'v1_lessons.json').read_text(encoding='utf-8'))['lessons']
    index_path = Path(os.environ.get('LMS_SOURCE_INDEX', APP / 'source_index.json'))
    if not index_path.exists():
        sys.exit(f'원본 색인이 없습니다: {index_path}\n  python3 source_parse.py <원본 docx 폴더> -o source_index.json  로 먼저 만드세요.')
    index = json.loads(index_path.read_text(encoding='utf-8'))
    docs = {d['id'][0]: d for d in index['documents']}  # 파일명 앞 숫자가 문서 키

    def find_section(doc, no):
        for s in docs[doc]['sections']:
            if (no and s['no'] == no) or (not s['no'] and s['title'] == no):
                return s
        raise KeyError(f'{doc} {no}')

    units, photos, used_sections, used_docs = [], set(), {}, set()
    for unit in course['units']:
        if unit['id'] not in UNITS:
            continue
        steps = []
        for s in unit['steps']:
            l = lessons.get(s['id'], {})
            cites = [tuple(c) for kp in l.get('keyPoints', []) for c in kp['cites']] + [tuple(c) for c in l.get('sources', [])]
            for doc, no in cites:
                key = section_key(doc, no)
                if key not in used_sections:
                    sec = find_section(doc, no)
                    used_sections[key] = dict(doc=doc, no=sec['no'], title=sec['title'], kind=sec['kind'], chars=sec['chars'],
                                              images=sec['images'], paragraphs=sec['paragraphs'], tables=sec['tables'], hash=sec['hash'])
                    used_docs.add(doc)
            steps.append(dict(id=s['id'], title=l.get('title') or s['title'], copy=s['copy'], checks=s['checks'],
                              note=s.get('note') or '', photos=[str(p) for p in s.get('photos') or []],
                              purpose=l.get('purpose', ''),
                              keyPoints=[dict(text=kp['text'], cites=[section_key(*c) for c in kp['cites']]) for kp in l.get('keyPoints', [])],
                              sources=[section_key(*c) for c in l.get('sources', [])],
                              lessonStatus=l.get('status', 'none')))
            photos.update(steps[-1]['photos'])
        units.append(dict(id=unit['id'], title=unit['title'], summary=unit['summary'], plan=unit['plan'], steps=steps))
    out = dict(
        format='momos-lms-v1-content',
        courseVersion=course['version'], sourceIndexedAt=index['generated_at'],
        units=units,
        documents={k: dict(title=d['title'], type=d['type'], version=d['version'], revised=d['revised_at'], status=d['status'], file=d['file'])
                   for k, d in docs.items() if k in used_docs},
        sections=used_sections,
        photos={p: dict(src=source['photos'][p]['src'], caption=source['photos'][p]['caption']) for p in sorted(photos) if p in source['photos']},
    )
    (APP / 'v1_content.json').write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
    print('v1_content.json:', sum(len(u['steps']) for u in units), 'steps,', len(out['documents']), 'documents,', len(out['sections']), 'sections,', len(out['photos']), 'photos')


if __name__ == '__main__':
    main()
