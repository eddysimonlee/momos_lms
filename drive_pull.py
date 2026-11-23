"""드라이브 원본 변경 결과와 원본 docx 를 LMS 서버에서 받는다(11/16 · AGENTS.md '드라이브 sync 맞춰줘').

    LMS_SYNC_KEY=mlk_… python3 drive_pull.py [--url https://momos-lms.onrender.com] [--out .drive_sync]

  LMS_SYNC_KEY  LMS관리자 › 설정 › 'LLM 연결 키 만들기'로 받은 사람별 키. 저장소·로그에 넣지 않는다(환경변수로만).
  결과는 LMS관리자가 수정 요청 탭에서 [동기화]를 누른 마지막 결과다(11/16: 동기화는 그 버튼으로만). 오래됐으면 먼저 눌러 달라고 한다.
결과
  <out>/report.json                 확인 결과 전체(문서별 상태, 교육이 인용한 절 AS-IS·TO-BE, 영향받는 교육, 문서별 수정 요청 티켓 REQ-n)
  <out>/ST_매장사업부/<폴더>/<파일>   지금 드라이브의 원본 docx(교육 근거 문서 전부 — 다시 색인하려면 전부 필요)
  화면에는 바뀐 문서·절·교육 요약과 다음 할 일을 적는다. <out> 은 저장소에 커밋하지 않는다(.gitignore).
"""
import argparse
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DEFAULT_URL = 'https://momos-lms.onrender.com'


def get(url, key, timeout=600):
    req = Request(url, headers={'Authorization': 'Bearer ' + key, 'User-Agent': 'MomosLMS-drive-pull/1'})
    try:
        with urlopen(req, timeout=timeout) as r:
            return r.read()
    except HTTPError as e:
        try:
            msg = json.loads(e.read() or b'{}').get('error') or ''
        except ValueError:
            msg = ''
        sys.exit(f'서버 응답 {e.code}: {msg or url.split("?")[0]}')


def summary(rep):
    lines = [f"확인: {rep.get('at', '')} · {rep.get('by', '')} · 기준 manifest {rep['baseline'].get('manifestUpdated', '')} · 문서 {len(rep['docs'])}편",
             '상태: ' + ', '.join(f'{k} {v}' for k, v in sorted(rep['counts'].items()))]
    tickets = rep.get('tickets') or {}
    for d in rep['docs']:
        if d['status'] == '그대로':
            continue
        tk = tickets.get(d['id'])
        done = f" {tk['no']}({tk['status']})" if tk else ''
        lines.append(f"\n[{d['status']}]{done} {d['title']} — {d['folder']}/{d['file']}" + (f" → {d['path']}" if d.get('path') and d['path'] != f"{d['folder']}/{d['file']}" else ''))
        if d.get('error'):
            lines.append('  오류: ' + d['error'])
        for p in d.get('parts') or []:
            lines.append(f"  · 나뉜 파일: {p['path']} (기준 절 {p.get('baseSections')}개 중 같은 절 {p.get('sameSections')}개, 점수 {p.get('score')})")
        if d.get('match'):
            lines.append(f"  · 이름 바뀐 파일과 내용으로 짝지음: 같은 절 {d['match'].get('sameSections')}개, 점수 {d['match'].get('score')}")
        for c in d.get('cited') or []:
            who = ', '.join(sorted({f"{r['no']}번 {r['title']}" for r in c['lessons']})) or '(교육 없음)'
            lines.append(f"  · 인용 절 {c['no']} {c['title']}{' [' + c['part'] + ']' if c['part'] else ''} — 교육: {who}" + (' — 절을 찾지 못함: ' + c['note'] if c['missing'] else ''))
        for k, label in (('other', '인용한 부분 밖에서 바뀐 절'), ('added', '새 절'), ('removed', '없어진 절')):
            if d.get(k):
                lines.append(f"  · {label}: " + ', '.join(f'{x[0]} {x[1]}'.strip() + (f' ({x[2]})' if len(x) > 2 else '') for x in d[k]))
    if rep.get('lessons'):
        lines.append('\n영향받는 교육: ' + ', '.join(f"{x['no']}번 {x['title']}" for x in rep['lessons']))
    if rep.get('added'):
        lines.append('\n새 문서(근거 문서 아님): ' + ', '.join(x['path'] for x in rep['added']))
    if rep.get('extraCount'):
        lines.append(f"\n교육 근거가 아닌 docx {rep['extraCount']}개(최근 수정순 일부): " + ', '.join(x['path'] for x in rep['extra'][:10]))
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--url', default=os.environ.get('LMS_SYNC_URL') or DEFAULT_URL)
    ap.add_argument('--out', default='.drive_sync')
    ap.add_argument('--no-files', action='store_true', help='결과만 받고 docx 는 받지 않는다')
    a = ap.parse_args()
    key = os.environ.get('LMS_SYNC_KEY', '').strip()
    if not key.startswith('mlk_'):
        sys.exit('LMS_SYNC_KEY 환경변수에 LLM 연결 키(mlk_…)를 넣어 주세요. LMS관리자 › 원본 변경에서 만들 수 있어요.')
    base, out = a.url.rstrip('/'), Path(a.out)
    rep = json.loads(get(base + '/api/sync/report', key))
    out.mkdir(parents=True, exist_ok=True)
    (out / 'report.json').write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding='utf-8')
    print(summary(rep))
    if a.no_files:
        return
    root, n = out / 'ST_매장사업부', 0
    for d in rep['docs']:
        for p in (d.get('parts') or [])[1:]:  # 11/23 나뉜 문서는 나머지 파일도 받는다
            dest = root / p['path']
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(get(base + '/api/sync/file?' + urlencode({'path': p['path']}), key, timeout=120))
            n += 1
        if not d.get('fileId'):
            continue
        dest = root / d['path']
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(get(base + '/api/sync/file?' + urlencode({'doc': d['id']}), key, timeout=120))
        n += 1
    # 11/23 근거 문서가 아닌 docx 중 근거 문서가 있는 맨 위 폴더(아카이브 제외)에서 LMS 기준일(manifest updated) 뒤에 생기거나 고쳐진 것도 받는다
    # — 나뉜 문서·새 문서를 교육에 반영할지 판단하려면 원문이 필요하다(동기화 화면이 아직 못 잡는 경우 포함)
    man = json.loads((Path(__file__).with_name('source_manifest.json')).read_text(encoding='utf-8'))
    roots, since = {m['folder'].split('/', 1)[0] for m in man['documents']}, man.get('updated') or ''
    recent = [x for x in rep.get('extra') or [] if x['path'].split('/', 1)[0] in roots and not any('아카이브' in s for s in x['path'].split('/')[:-1])
              and str(x.get('modified') or '')[:10] > since]
    picked = {x['path']: x for x in (rep.get('added') or []) + recent}
    for x in picked.values():
        print(f"  + 근거 아닌 문서: {x['path']} ({str(x.get('modified') or '')[:10]})")
        dest = root / x['path']
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(get(base + '/api/sync/file?' + urlencode({'path': x['path']}), key, timeout=120))
        n += 1
    print(f'\n원본 docx {n}편 → {root}')
    print('다음: AGENTS.md "드라이브 sync 맞춰줘" — 바뀐 문서는 source_manifest.json(파일·sha1·revised) 갱신 →'
          f' python3 source_parse.py --base {root} --images source_images → v1_lessons.json 교육 문구 AS-IS/TO-BE 제안 → 승인 → v1_build.py·테스트·커밋')


if __name__ == '__main__':
    main()
