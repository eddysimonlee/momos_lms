"""반영 대기 문구(LMS관리자 › 수정 요청 › '반영 대기 문구 N건 내려받기' 파일)를 v1_lessons.json 에 넣는다. (11/10)

    python3 apply_edits.py content_edits_202611101530.json --commit  # 반영 → 빌드 → 테스트 → 커밋까지 한 번에(그다음 git push 만)
    python3 apply_edits.py content_edits_202611101530.json --check   # 바꾸지 않고 확인만(바뀐 문구 + 그 줄의 근거 원문을 보여 줌)
    python3 apply_edits.py content_edits_202611101530.json --commit --skip REQ-103  # 원문과 안 맞는 건은 빼고
    python3 apply_edits.py content_edits_202611101530.json           # 반영만(빌드·테스트·커밋은 손으로)

한 건씩: 지금 문구가 AS-IS 와 같은지 → 서버와 같은 형식 검사(수정 필요 5개) → 교육 목적·교육 내용 문구만 바꾼다(근거·순서·칸 수는 그대로).
원문과 뜻이 맞는지는 스크립트가 판단하지 않는다 — --check 로 근거 원문과 나란히 보고 사람(또는 AI)이 확인한 뒤, 안 맞는 건은 --skip 으로 뺀다.
이미 TO-BE 이면 건너뛰고, AS-IS 와 다르거나 검사에 걸리면 건너뛰고 알린다. 바꾼 것은 source_log.json 에 기록 1건(tickets = REQ 번호).
--commit: 그다음 python3 v1_build.py → 모든 *_test.py → git commit 까지 한다. 하나라도 실패하면 바꾼 파일을 되돌리고 커밋하지 않는다.
사람은 git push 만 하면 되고, 배포된 서버가 문구가 같아진 티켓을 '반영됨'으로 닫는다.
배포 파일이 아니다(서버가 import 하지 않음).
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import content_edit as ce

APP = Path(__file__).parent


def dump(path, data, raw):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + ('\n' if raw.endswith('\n') else ''), encoding='utf-8')


FILES = ('v1_lessons.json', 'v1_content.json', 'source_log.json')
PUSH = {'alpha': ['git push origin alpha'], 'release/v1': ['git push github release/v1', 'git push origin release/v1']}


def run(cmd):
    """명령 하나(레포 폴더에서). → (성공 여부, 출력 끝부분)"""
    r = subprocess.run(cmd, cwd=APP, capture_output=True, text=True)
    return r.returncode == 0, (r.stdout + r.stderr).strip()[-1500:]


def git(*args):
    ok, out = run(['git', *args])
    return out if ok else None


def lesson_numbers():
    c = json.loads((APP / 'v1_content.json').read_text(encoding='utf-8'))
    order = [s['id'] for u in c.get('units', []) for s in u.get('steps', [])]
    return {sid: i + 1 for i, sid in enumerate(order)}


def main(argv=None):
    ap = argparse.ArgumentParser(description='반영 대기 문구를 v1_lessons.json 에 넣는다')
    ap.add_argument('file', help="LMS관리자 › 수정 요청 › '반영 대기 문구 내려받기' 파일")
    ap.add_argument('--check', action='store_true', help='바꾸지 않고 확인만')
    ap.add_argument('--commit', action='store_true', help='반영 뒤 빌드·테스트·커밋까지(실패하면 되돌림)')
    ap.add_argument('--skip', nargs='*', default=[], metavar='REQ-n', help='이번에 반영하지 않을 티켓 번호(원문과 안 맞는 건 등)')
    a = ap.parse_args(argv)
    if a.check and a.commit: sys.exit('--check 와 --commit 은 같이 쓸 수 없어요.')
    if a.commit:
        branch = git('rev-parse', '--abbrev-ref', 'HEAD')
        if branch is None: sys.exit('git 레포 폴더에서 실행해 주세요.')
        dirty = git('status', '--porcelain', '--', *FILES)
        if dirty: sys.exit('커밋하지 않은 변경이 있어요(' + ', '.join(l[3:] for l in dirty.splitlines()) + '). 먼저 정리한 뒤 다시 실행해 주세요.')
        print(f'브랜치: {branch} — 먼저 git pull 로 최신을 받았는지 확인하세요.\n')
    data = json.loads(Path(a.file).read_text(encoding='utf-8'))
    if data.get('format') != 'momos-lms-content-edits': sys.exit('반영 대기 문구 파일이 아니에요.')
    lpath, gpath = APP / 'v1_lessons.json', APP / 'source_log.json'
    lraw, graw = lpath.read_text(encoding='utf-8'), gpath.read_text(encoding='utf-8')
    lessons, log = json.loads(lraw), json.loads(graw)
    nos = lesson_numbers()
    done, skipped = [], []
    for e in data.get('edits') or []:
        key = f"{e.get('no')} {e.get('field')} ({e.get('title')})"
        if e.get('no') in a.skip:
            skipped.append((key, '이번에는 빼기로 함(--skip)')); continue
        l = lessons['lessons'].get(e.get('step'))
        try:
            text, _ = ce.current(ce.load(APP), e.get('step'), e.get('part'), e.get('index'))
        except ValueError as err:
            skipped.append((key, str(err))); continue
        if text == e['tobe']:
            skipped.append((key, '이미 반영돼 있어요')); continue
        if text != e['asis']:
            skipped.append((key, '지금 문구가 AS-IS 와 달라요(그 사이 바뀜) — 화면에서 다시 고쳐 주세요')); continue
        r = ce.review(APP, e['step'], e['part'], e.get('index'), e['asis'], e['tobe'])
        block = [i['text'] for i in r['items'] if i['level'] == 'block']
        if block:
            skipped.append((key, ' / '.join(block))); continue
        if e['part'] == 'purpose': l['purpose'] = e['tobe']
        else: l['keyPoints'][e['index']]['text'] = e['tobe']
        ce._CACHE.clear()  # 같은 교육의 다음 건이 바뀐 문구를 보게
        if not a.check: lpath.write_text(json.dumps(lessons, ensure_ascii=False, indent=2) + ('\n' if lraw.endswith('\n') else ''), encoding='utf-8')
        done.append(e)
    if a.check:
        lpath.write_text(lraw, encoding='utf-8'); ce._CACHE.clear()
    for e in done:
        print(f"반영  {e['no']} {nos.get(e['step'], '?')}번 {e['title']} · {e['field']}{' (변경 종류: ' + e['kind'] + ')' if e.get('kind') else ''}")
        print(f"      지금: {e['asis']}\n      수정: {e['tobe']}" + (f"\n      사유: {e['note']}" if e.get('note') else ''))
        if a.check:  # 사람·AI 가 뜻이 맞는지 보도록 그 줄의 근거 원문을 함께
            for label, text in ce.cited(APP, e['step'], e['part'], e.get('index')):
                print(f"      근거 [{label}]\n        " + text.replace('\n', '\n        '))
    for k, why in skipped: print(f"건너뜀 {k}: {why}")
    for r in data.get('requests') or []:  # 문구 수정이 아닌 진행중 요청 — 이 스크립트는 건드리지 않는다
        print(f"따로  {r.get('no')} {r.get('type')} · {(r.get('target') or {}).get('title', '')}: AGENTS.md '콘텐츠 수정 요청 처리' 대로 제안·승인 뒤 반영")
    if a.check or not done:
        print('확인만 했어요(파일은 그대로).' if a.check else '바꾼 문구가 없어요.'); return 0
    now = datetime.now(timezone(timedelta(hours=9)))
    by = {}
    for e in done: by.setdefault(e['step'], []).append(e)
    log['entries'].insert(0, dict(
        id=f"{now:%Y-%m-%d}-content-edits-{now:%H%M}", at=f"{now:%Y-%m-%d %H:%M}", approvedBy=', '.join(dict.fromkeys(e.get('by') or '' for e in done)),
        tickets=[e['no'] for e in done], title=f"문구 수정 {len(done)}건 반영 — LMS 화면 '문구 수정 모드'",
        basis=dict(kind='문구 수정', at=f"{now:%Y-%m-%d}", origin="LMS관리자 › 문구 수정 모드 → 반영 대기 문구 내려받기", copy=Path(a.file).name,
                   range=', '.join(e['no'] for e in done)),
        basisCount=len(json.loads((APP / 'source_manifest.json').read_text(encoding='utf-8')).get('documents', [])),
        work='화면에서 고친 교육 목적·교육 내용 문구를 apply_edits.py 로 v1_lessons.json 에 반영(근거·순서·칸 수 그대로, 수정 필요 7개 검사 통과).',
        docs=[], removed=[],
        lessons=[dict(no=nos.get(sid), id=sid, title=es[0].get('title', ''), changes=[dict(item=x['field'], cite='', asis=x['asis'], tobe=x['tobe'],
                     note=f"{x['no']} · 변경 종류(자동 추천) {x.get('kind', '')}" + (f" · 수정 사유: {x['note']}" if x.get('note') else '')) for x in es]) for sid, es in by.items()],
        rules=[], checks=[f"{x['no']} 변경 종류(자동 추천) {x.get('kind', '')}" for x in done if x.get('kind') == '재확인 필요'], skipped=[f"{k}: {w}" for k, w in skipped]))
    dump(gpath, log, graw)
    if not a.commit:
        print(f"\nv1_lessons.json·source_log.json 을 고쳤어요. 다음: python3 v1_build.py → 테스트 → 커밋 → push(배포)")
        return 0
    return finish([e['no'] for e in done], branch)


def finish(nos, branch):
    """--commit: 빌드 → 테스트 → 커밋. 실패하면 FILES 를 커밋 전 상태로 되돌린다."""
    steps = [('교육 콘텐츠 다시 만들기', [sys.executable, 'v1_build.py'])]
    steps += [(f'테스트 {t.name}', [sys.executable, t.name]) for t in sorted(APP.glob('*_test.py'))]
    for name, cmd in steps:
        ok, out = run(cmd)
        print(('  통과 ' if ok else '  실패 ') + name)
        if not ok:
            git('checkout', '--', *FILES)
            print(f"\n{name} 에서 멈췄어요. 바꾼 파일은 되돌렸고 커밋하지 않았어요.\n{out}")
            return 1
    git('add', '--', *FILES)
    msg = f"문구 수정 반영 {', '.join(nos)} — LMS 화면 '문구 수정 모드'"
    if git('commit', '-m', msg) is None:
        git('reset', '-q', '--', *FILES); git('checkout', '--', *FILES)
        print('\n커밋하지 못했어요(git 설정을 확인해 주세요). 바꾼 파일은 되돌렸어요.'); return 1
    print(f"\n커밋했어요: {git('log', '--oneline', '-1')}\n이제 배포(push)만 하면 돼요:")
    for c in PUSH.get(branch, [f'git push origin {branch}']): print('  ' + c)
    print("배포가 끝나면 서버가 이 티켓들을 '반영됨'으로 닫아요.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
