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
            got = ce.check(c['part'], c['asis'], c['tobe'], CASES['cited'], [tuple(x) for x in CASES['others']], CASES['terms'], c['openReq'])
            self.assertEqual(got, c['expect'], c['name'])

    def test_expected_codes(self):
        codes = {c['name']: [i['code'] for i in c['expect']['items'] if i['level'] == 'block'] for c in CASES['cases']}
        self.assertEqual(codes['number'], ['number'])
        self.assertEqual(codes['range'], [])     # 4-6통 = 4~6통
        self.assertEqual(codes['comma'], [])     # 1,550 g = 1550g
        self.assertIn('같은 문서 6.5', next(c for c in CASES['cases'] if c['name'] == 'other')['expect']['items'][0]['text'])
        for name in ('empty', 'same', 'length', 'breaks_kp', 'breaks_purpose', 'markup', 'open'):
            self.assertEqual(codes[name], [name if not name.startswith('breaks') else 'breaks'], name)
        for name in ('term', 'negation', 'rewrite', 'style', 'kept', 'simple'):
            self.assertEqual(codes[name], [], name)

    def test_real_lesson(self):
        l = json.loads((APP / 'v1_lessons.json').read_text(encoding='utf-8'))['lessons']['materials-product-1']
        a = l['keyPoints'][1]['text']
        r = ce.review(APP, 'materials-product-1', 'kp', 1, a, a.replace('1000g', '1200g'))
        self.assertEqual([i['code'] for i in r['items'] if i['level'] == 'block'], ['number'])
        self.assertEqual(ce.review(APP, 'materials-product-1', 'kp', 1, a, a.replace('넣는다', '부어 넣는다'))['suggest'], '단순 수정')
        with self.assertRaises(ValueError): ce.review(APP, 'materials-product-1', 'kp', 1, a + 'x', a)
        with self.assertRaises(ValueError): ce.review(APP, 'materials-product-1', 'kp', 99, a, a)
        p = l['purpose']
        self.assertEqual([i['level'] for i in ce.review(APP, 'materials-product-1', 'purpose', None, p, p.replace('직접 ', ''))['items'] if i['level'] == 'block'], [])


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
        self.assertTrue(all(i['level'] != 'block' for i in r['edit']['checks']))
        # 같은 줄에 검토 중인 요청이 있으면 막는다
        with self.assertRaisesRegex(ValueError, 'REQ-1'): self.req(root, lambda a: a.replace('넣는다', '넣어 둔다'))
        # 다른 줄은 된다
        self.assertEqual(self.req(root, lambda a: a.replace('완료', '끝'), index=2)['no'], 'REQ-2')

    def test_blocked(self):
        with self.assertRaisesRegex(ValueError, '1200g'): self.req({}, lambda a: a.replace('1000g', '1200g'))
        with self.assertRaisesRegex(ValueError, '같아요'): self.req({}, lambda a: a)
        with self.assertRaisesRegex(ValueError, '변경 종류'): self.req({}, lambda a: a + ' 확인', kind='아무거나')
        # 변경 종류는 서버 자동 추천으로 저장(화면이 보낸 값보다 우선)
        self.assertEqual(self.req({}, lambda a: a.replace('넣는다', '넣지 않는다'), kind='단순 수정')['edit']['kind'], '재확인 필요')
        with self.assertRaisesRegex(ValueError, '바뀌었어요'):
            self.svc.content_request({}, self.user, dict(target=dict(kind='item', id='materials-product-1', title='x'), type='문구 수정', asis='옛 문구', tobe='새 문구다.',
                                                          note='x', edit=dict(part='kp', index=1, kind='단순 수정')))
        with self.assertRaisesRegex(ValueError, '수정 이유'):
            a = self.l['keyPoints'][1]['text']
            self.svc.content_request({}, self.user, dict(target=dict(kind='item', id='materials-product-1', title='x'), type='문구 수정', asis=a, tobe=a + ' 꼭', note=' ',
                                                          edit=dict(part='kp', index=1, kind='단순 수정')))


if __name__ == '__main__':
    unittest.main()
