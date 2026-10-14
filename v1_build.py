"""Build v1_content.json: the first-release slice of the course.

Takes the unit(s) listed in UNITS from onboarding_course.json and the
guide texts and photos they reference from onboarding.html's source data.
Run after either file changes:

    python3 v1_build.py
"""
import json
import re
from pathlib import Path

APP = Path(__file__).parent
UNITS = ['welcome']  # 입사·근무 준비. Add unit ids here to widen the slice.


def main():
    course = json.loads((APP / 'onboarding_course.json').read_text(encoding='utf-8'))
    html = (APP / 'onboarding.html').read_text(encoding='utf-8')
    source = json.loads(re.search(r'<script id="source-data" type="application/json">(.*?)</script>', html, re.S).group(1))
    units, refs, photos = [], set(), set()
    for unit in course['units']:
        if unit['id'] not in UNITS:
            continue
        steps = []
        for s in unit['steps']:
            steps.append(dict(id=s['id'], title=s['title'], copy=s['copy'], checks=s['checks'],
                              note=s.get('note') or '', photos=[str(p) for p in s.get('photos') or []],
                              refs=s.get('refs') or [s['ref']]))
            refs.update(steps[-1]['refs'])
            photos.update(steps[-1]['photos'])
        units.append(dict(id=unit['id'], title=unit['title'], summary=unit['summary'], plan=unit['plan'], steps=steps))
    out = dict(
        format='momos-lms-v1-content',
        courseVersion=course['version'], sourceVersion=course['sourceVersion'],
        units=units,
        guides={r: dict(title=source['refs'][r]['title'], file=source['refs'][r]['file'], html=source['guides'][r]) for r in sorted(refs)},
        photos={p: dict(src=source['photos'][p]['src'], caption=source['photos'][p]['caption']) for p in sorted(photos) if p in source['photos']},
    )
    (APP / 'v1_content.json').write_text(json.dumps(out, ensure_ascii=False), encoding='utf-8')
    print('v1_content.json:', sum(len(u['steps']) for u in units), 'steps,', len(out['guides']), 'guides,', len(out['photos']), 'photos')


if __name__ == '__main__':
    main()
