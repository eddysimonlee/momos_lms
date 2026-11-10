"""11/10 교육 문구 직접 수정 — 자동 사전 검사(content_edit.py)와 서버 처리(onboarding.content_request)."""
import json
import unittest
from pathlib import Path

import content_edit as ce

APP = Path(__file__).parent
CASES = json.loads((APP / 'content_edit_cases.json').read_text(encoding='utf-8'))


class Rules(unittest.TestCase):
    def test_cases_match_saved_results(self):
        for c in CASES['cases']:
            got = ce.check(c['part'], c['asis'], c['tobe'], CASES['cited'], [tuple(x) for x in CASES['others']], c['openReq'])
            self.assertEqual(got, c['expect'], c['name'])

    def test_only_seven_block_rules(self):
        codes = {c['name']: [i['code'] for i in c['expect']['items']] for c in CASES['cases']}
        self.assertEqual(codes['number'], ['number'])
        self.assertEqual(codes['range'], [])     # 4-6통 = 4~6통
        self.assertEqual(codes['comma'], [])     # 1,550 g = 1550g
        self.assertEqual(codes['kept'], [])      # 원래 문구에 있던 수치는 근거 밖이어도 통과
        self.assertIn('같은 문서 6.5', next(c for c in CASES['cases'] if c['name'] == 'other')['expect']['items'][0]['text'])
        for name in ('empty', 'same', 'length', 'markup', 'open'): self.assertEqual(codes[name], [name], name)
        self.assertEqual(codes['breaks_kp'], ['breaks']); self.assertEqual(codes['breaks_purpose'], ['breaks'])
        self.assertTrue(all(i['level'] == 'block' for c in CASES['cases'] for i in c['expect']['items']))
        # 지운 규칙(이름·빠진 내용·뜻·절반·문체)은 걸리지 않는다
        self.assertEqual(ce.check('kp', '생크림을 먼저 넣는다.', '휘핑볼은 세 배치까지만 쓰지 않기', CASES['cited'])['items'], [])

    def test_suggest_by_numbers(self):
        self.assertEqual(ce.check('kp', '생크림 1000g 넣는다.', '생크림 1000g 부어 넣는다.', CASES['cited'])['suggest'], '단순 수정')
        self.assertEqual(ce.check('kp', '6~7배치 만든다.', '6배치 만든다.', ['6배치'])['suggest'], '재확인 필요')

    def test_real_lesson(self):
        l = json.loads((APP / 'v1_lessons.json').read_text(encoding='utf-8'))['lessons']['materials-product-1']
        a = l['keyPoints'][1]['text']
        r = ce.review(APP, 'materials-product-1', 'kp', 1, a, a.replace('1000g', '1200g'))
        self.assertEqual([i['code'] for i in r['items']], ['number'])
        self.assertEqual(ce.review(APP, 'materials-product-1', 'kp', 1, a, a.replace('넣는다', '부어 넣는다'))['suggest'], '단순 수정')
        with self.assertRaises(ValueError): ce.review(APP, 'materials-product-1', 'kp', 1, a + 'x', a)
        with self.assertRaises(ValueError): ce.review(APP, 'materials-product-1', 'kp', 99, a, a)
        p = l['purpose']
        self.assertEqual(ce.review(APP, 'materials-product-1', 'purpose', None, p, p.replace('직접 ', ''))['items'], [])


class Server(unittest.TestCase):
    def setUp(self):
        import onboarding
        self.o = onboarding
        cls = next(v for v in vars(onboarding).values() if isinstance(v, type) and hasattr(v, 'content_request'))
        self.svc = cls.__new__(cls)
        self.svc.lms_level = lambda root, user: 'admin'
        self.l = json.loads((APP / 'v1_lessons.json').read_text(encoding='utf-8'))['lessons']['materials-product-1']
        self.user = dict(id='u1', name='관리자', email='a@x')

    def req(self, root, tobe, index=1, **edit):
        a = self.l['keyPoints'][index]['text']
        d = dict(target=dict(kind='item', id='materials-product-1', title='피스타치오 크림 제조 연습'), type='문구 수정', asis=a, tobe=tobe(a), note='원본 표 기준',
                 edit=dict(dict(part='kp', index=index, kind='단순 수정'), **edit))
        self.svc.content_request(root, self.user, d)
        return root['contentRequests'][-1]

    def test_saved_with_checks(self):
        root = {}
        r = self.req(root, lambda a: a.replace('넣는다', '부어 넣는다'))
        self.assertEqual((r['no'], r['field'], r['edit']['part'], r['edit']['index'], r['edit']['kind'], r['status']), ('REQ-1', '교육 내용 2', 'kp', 1, '단순 수정', '진행중'))
        self.assertNotIn('checks', r['edit'])
        # 같은 줄에 검토 중인 요청이 있으면 막는다
        with self.assertRaisesRegex(ValueError, 'REQ-1 로 이미 반영 대기'): self.req(root, lambda a: a.replace('넣는다', '넣어 둔다'))
        # 다른 줄은 된다
        self.assertEqual(self.req(root, lambda a: a.replace('완료', '끝'), index=2)['no'], 'REQ-2')

    def test_blocked(self):
        with self.assertRaisesRegex(ValueError, '1200g'): self.req({}, lambda a: a.replace('1000g', '1200g'))
        with self.assertRaisesRegex(ValueError, '같아요'): self.req({}, lambda a: a)
        with self.assertRaisesRegex(ValueError, '변경 종류'): self.req({}, lambda a: a + ' 확인', kind='아무거나')
        # 변경 종류는 서버 자동 추천으로 저장(화면이 보낸 값보다 우선)
        # 수치가 바뀌면(근거 원문에 있는 값) 화면이 '단순 수정'을 보내도 서버 추천 '재확인 필요'로 저장
        self.assertEqual(self.req({}, lambda a: a.replace('설탕 500g', '설탕 330g'), kind='단순 수정')['edit']['kind'], '재확인 필요')
        with self.assertRaisesRegex(ValueError, '바뀌었어요'):
            self.svc.content_request({}, self.user, dict(target=dict(kind='item', id='materials-product-1', title='x'), type='문구 수정', asis='옛 문구', tobe='새 문구다.',
                                                          note='x', edit=dict(part='kp', index=1, kind='단순 수정')))
        with self.assertRaisesRegex(ValueError, '수정 사유'):
            a = self.l['keyPoints'][1]['text']
            self.svc.content_request({}, self.user, dict(target=dict(kind='item', id='materials-product-1', title='x'), type='문구 수정', asis=a, tobe=a + ' 꼭', note=' ',
                                                          edit=dict(part='kp', index=1, kind='단순 수정')))


class ApplyAndClose(unittest.TestCase):
    """apply_edits.py(작업 PC) → 배포 → close_applied_edits(서버 시작) 흐름을 임시 폴더에서."""
    def setUp(self):
        import shutil, tempfile
        self.dir = Path(tempfile.mkdtemp())
        for f in ('v1_lessons.json', 'v1_content.json', 'source_log.json', 'source_manifest.json', 'content_edit.py', 'apply_edits.py'):
            shutil.copy(APP / f, self.dir / f)
        self.l = json.loads((APP / 'v1_lessons.json').read_text(encoding='utf-8'))['lessons']['materials-product-1']

    def run_apply(self, edits, *flags):
        import importlib.util, io, contextlib
        f = self.dir / 'edits.json'
        f.write_text(json.dumps(dict(format='momos-lms-content-edits', version=1, edits=edits), ensure_ascii=False), encoding='utf-8')
        spec = importlib.util.spec_from_file_location('apply_edits_tmp', self.dir / 'apply_edits.py')
        m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        m.APP = self.dir; m.ce.load.__globals__['_CACHE'].clear()
        orig = m.ce.load
        m.ce.load = lambda app: orig(self.dir)
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out): m.main([str(f), *flags])
        finally:
            m.ce.load = orig; orig.__globals__['_CACHE'].clear()
        return out.getvalue()

    def edit(self, no, index, tobe, asis=None):
        return dict(no=no, step='materials-product-1', title='피스타치오 크림 제조 연습', part='kp', index=index, field=f'교육 내용 {index + 1}',
                    asis=asis if asis is not None else self.l['keyPoints'][index]['text'], tobe=tobe, kind='단순 수정', note='맞춤법', by='채수민')

    def test_apply_then_close(self):
        a1 = self.l['keyPoints'][1]['text']
        ok = self.edit('REQ-5', 1, a1.replace('넣는다', '차례로 넣는다'))
        bad = self.edit('REQ-6', 2, '휘핑 1200g', None)
        stale = self.edit('REQ-7', 3, '아무거나다.', asis='옛 문구')
        out = self.run_apply([ok, bad, stale], '--check')
        self.assertIn('확인만', out)
        self.assertEqual(json.loads((self.dir / 'v1_lessons.json').read_text(encoding='utf-8'))['lessons']['materials-product-1']['keyPoints'][1]['text'], a1)
        out = self.run_apply([ok, bad, stale])
        self.assertIn('반영  REQ-5', out); self.assertIn('건너뜀 REQ-6', out); self.assertIn('1200g', out); self.assertIn('건너뜀 REQ-7', out)
        les = json.loads((self.dir / 'v1_lessons.json').read_text(encoding='utf-8'))['lessons']['materials-product-1']
        self.assertEqual(les['keyPoints'][1]['text'], ok['tobe'])
        self.assertEqual(les['keyPoints'][1]['cites'], self.l['keyPoints'][1]['cites'])  # 근거는 그대로
        log = json.loads((self.dir / 'source_log.json').read_text(encoding='utf-8'))['entries'][0]
        self.assertEqual((log['tickets'], log['basis']['kind']), (['REQ-5'], '문구 수정'))
        self.assertIn('이미 반영', self.run_apply([ok]))
        # 배포 뒤 서버 시작: TO-BE 와 같아진 티켓만 반영됨
        import onboarding
        class Store:
            def __init__(s): s.body = None
            def connect(s):
                import contextlib
                outer = s
                class Db:
                    def execute(self, sql, args=()):
                        class R:
                            def fetchone(_): return (outer.body,) if outer.body else None
                        if sql.startswith('INSERT'): outer.body = args[1]
                        return R()
                return contextlib.nullcontext(Db())
        st = Store()
        root = dict(contentRequests=[dict(no='REQ-5', status='진행중', target=dict(kind='item', id='materials-product-1'), tobe=ok['tobe'], edit=dict(part='kp', index=1)),
                                     dict(no='REQ-6', status='진행중', target=dict(kind='item', id='materials-product-1'), tobe=bad['tobe'], edit=dict(part='kp', index=2)),
                                     dict(no='REQ-8', status='진행중', target=dict(kind='item', id='materials-product-1'), tobe='x', type='사진 교체')])
        st.body = json.dumps(root, ensure_ascii=False)
        orig = onboarding.content_edit.load
        onboarding.content_edit.load = lambda app: orig(self.dir)
        try: closed = onboarding.close_applied_edits(st)
        finally: onboarding.content_edit.load = orig; orig.__globals__['_CACHE'].clear()
        self.assertEqual(closed, ['REQ-5'])
        after = {r['no']: r['status'] for r in json.loads(st.body)['contentRequests']}
        self.assertEqual(after, {'REQ-5': '반영됨', 'REQ-6': '진행중', 'REQ-8': '진행중'})
        self.assertEqual(onboarding.close_applied_edits(st), [])  # 두 번째 시작에는 할 일 없음


    def test_commit_one_command(self):
        """--commit: 반영 → 빌드 → 테스트 → 커밋. 빌드·테스트가 실패하면 되돌리고 커밋하지 않는다(임시 git 레포)."""
        import subprocess
        g = lambda *a: subprocess.run(['git', *a], cwd=self.dir, capture_output=True, text=True)
        g('init', '-q', '-b', 'alpha'); g('config', 'user.email', 't@x'); g('config', 'user.name', 't')
        g('add', '.'); g('commit', '-q', '-m', 'init')
        a1 = self.l['keyPoints'][1]['text']
        ok = self.edit('REQ-5', 1, a1.replace('넣는다', '차례로 넣는다'))
        import importlib.util, io, contextlib
        f = self.dir / 'edits.json'
        f.write_text(json.dumps(dict(format='momos-lms-content-edits', version=1, edits=[ok]), ensure_ascii=False), encoding='utf-8')
        g('add', 'edits.json'); g('commit', '-q', '-m', 'edits')
        def go(fail):
            spec = importlib.util.spec_from_file_location('apply_edits_tmp2', self.dir / 'apply_edits.py')
            m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
            m.APP = self.dir
            orig_load, real_run = m.ce.load, m.run
            m.ce.load = lambda app: orig_load(self.dir)
            m.run = lambda cmd: ((not fail, 'boom') if cmd[0] != 'git' else real_run(cmd))  # 빌드·테스트는 흉내
            out = io.StringIO()
            try:
                with contextlib.redirect_stdout(out): code = m.main([str(f), '--commit'])
            finally:
                m.ce.load = orig_load; orig_load.__globals__['_CACHE'].clear()
            return code, out.getvalue()
        code, out = go(fail=True)
        self.assertEqual(code, 1); self.assertIn('되돌렸고 커밋하지 않았어요', out)
        self.assertEqual(g('status', '--porcelain', '--', 'v1_lessons.json', 'v1_content.json', 'source_log.json').stdout.strip(), '')
        self.assertEqual(g('log', '--oneline').stdout.count('\n'), 2)
        code, out = go(fail=False)
        self.assertEqual(code, 0); self.assertIn('git push origin alpha', out)
        self.assertIn('문구 수정 반영 REQ-5', g('log', '-1', '--format=%s').stdout)
        les = json.loads((self.dir / 'v1_lessons.json').read_text(encoding='utf-8'))['lessons']['materials-product-1']
        self.assertEqual(les['keyPoints'][1]['text'], ok['tobe'])
        self.assertEqual(g('status', '--porcelain', '--', 'v1_lessons.json', 'v1_content.json', 'source_log.json').stdout.strip(), '')


if __name__ == '__main__':
    unittest.main()
