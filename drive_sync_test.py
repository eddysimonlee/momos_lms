"""11/16 원본 변경 확인(drive_sync.py)·저장된 드라이브 열쇠(works_auth)·LLM 연결 키·LLM 읽기 주소."""
import hashlib
import http.client
import io
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError

import drive_sync
import lms_store
import onboarding
import server
import works_auth


def base():
    manifest = [dict(id='a-doc', folder='F', file='A_문서_261020_SOP.docx', sha1='s0'),
                dict(id='b-doc', folder='G', file='B_261001.docx', sha1='b0'),
                dict(id='c-doc', folder='H', file='C.docx', sha1='c0')]
    sections = {'a-doc': dict(sha1='s0', sections=[['1', '개요', 'h1'], ['2', '절차', 'h2'], ['3', '기타', 'h3']]),
                'b-doc': dict(sha1='b0', sections=[]), 'c-doc': dict(sha1='c0', sections=[])}
    content = dict(documents={'a-doc': dict(title='A 문서')}, photos={'ph1': dict(cite='a-doc|1')},
                   sections={'a-doc|2#r1': dict(doc='a-doc', no='2', title='절차', paragraphs=[], tables=[dict(header=['항목', '방법'], rows=[['닦기', '물로']])], partLabel='1행'),
                             'a-doc|1': dict(doc='a-doc', no='1', title='개요', paragraphs=['p1'], tables=[])},
                   units=[dict(steps=[dict(id='s1', title='교육1', keyPoints=[dict(text='물로 닦는다', cites=['a-doc|2#r1'])], photos=[]),
                                      dict(id='s2', title='교육2', keyPoints=[], photos=['ph1'])])])
    return dict(manifest=manifest, manifestUpdated='2026-11-13', sections=sections, content=content)


NEW_A = dict(sections=[dict(no='1', title='개요', paragraphs=['p1'], tables=[], hash='h1'),
                       dict(no='2', title='절차', paragraphs=[], tables=[dict(header=['항목', '방법'], rows=[['닦기', '세제로'], ['말리기', '그늘']])], hash='h2x'),
                       dict(no='4', title='새 절', paragraphs=[], tables=[], hash='h4')], version='v0.5', revised_at='2026-11-16')
A_PATH = 'F/A_문서_261020_SOP.docx'


def make_store(tmp):
    store = server.Store(Path(tmp) / 'data')
    server.make_server(store, 0).server_close()  # 테이블 준비
    return store


class CompareTests(unittest.TestCase):
    def tree(self):
        return [dict(path='F/A_문서_261116_SOP.docx', fileId='fa', size=10, modified='2026-11-16'),
                dict(path='H/B_261001.docx', fileId='fb', size=5, modified='2026-10-01'),
                dict(path='F/새_문서.docx', fileId='fn', size=1, modified='2026-11-15'),
                dict(path='F/~$임시.docx', fileId='ft', size=1, modified='2026-11-16'),
                dict(path='F/사진.jpg', fileId='fj', size=1, modified='2026-11-16')]

    def test_new_edition_moved_missing_and_section_diff(self):
        fetch = lambda f, force: {'fa': ('s1', b'docx'), 'fb': ('b0', None)}[f['fileId']]
        with mock.patch.object(drive_sync, 'parse_docx', return_value=NEW_A) as parse:
            rep = drive_sync.compare(base(), self.tree(), fetch)
        parse.assert_called_once()
        docs = {d['id']: d for d in rep['docs']}
        a = docs['a-doc']
        self.assertEqual((a['status'], a['path'], a['sha1']), ('새 판', 'F/A_문서_261116_SOP.docx', 's1'))
        self.assertEqual(len(a['cited']), 1)  # 개요(그대로)는 빠지고 인용한 표 1행만
        c = a['cited'][0]
        self.assertEqual((c['key'], c['part']), ('a-doc|2#r1', '1행'))
        self.assertIn('닦기 | 물로', c['asis'])
        self.assertIn('닦기 | 세제로', c['tobe'])
        self.assertEqual([(r['no'], r['part'], r['index'], r['text']) for r in c['lessons']], [(1, 'kp', 0, '물로 닦는다')])
        self.assertEqual((a['added'], a['removed'], a['other']), ([['4', '새 절']], [['3', '기타']], []))
        self.assertEqual(docs['b-doc']['status'], '이동')
        self.assertEqual(docs['c-doc']['status'], '없음')
        self.assertEqual([x['path'] for x in rep['extra']], ['F/새_문서.docx'])  # 임시 파일(~$)·docx 아닌 파일 제외
        self.assertEqual(rep['lessons'], [dict(no=1, id='s1', title='교육1')])
        self.assertEqual(rep['counts'], {'새 판': 1, '이동': 1, '없음': 1, '새 문서': 1})  # 11/23 기준일(11/13) 뒤에 생긴 짝 없는 문서 = 새 문서
        self.assertEqual([x['path'] for x in rep['added']], ['F/새_문서.docx'])

    def test_move_ignores_other_store_and_archive_copies(self):
        # 11/20 다른 지점 폴더·아카이브의 같은 이름 사본은 '이동'으로 짝짓지 않는다 → 없음
        tree = [dict(path='X/B_261001.docx', fileId='x', size=1, modified='m'), dict(path='G/아카이브/B_261001.docx', fileId='a', size=1, modified='m'),
                dict(path='F/A_문서_261020_SOP.docx', fileId='fa', size=1, modified='m')]
        b = base()
        b['manifest'][2]['folder'] = 'F/H'  # 근거 문서 맨 위 폴더 = F, G
        rep = drive_sync.compare(b, tree, lambda f, force: ({'fa': 's0'}.get(f['fileId'], 'b0'), None))
        self.assertEqual({d['id']: d['status'] for d in rep['docs']}, {'a-doc': '그대로', 'b-doc': '없음', 'c-doc': '없음'})
        tree.append(dict(path='F/새폴더/B_261001.docx', fileId='m', size=1, modified='m'))
        rep = drive_sync.compare(b, tree, lambda f, force: ({'fa': 's0'}.get(f['fileId'], 'b0'), None))
        self.assertEqual([(d['status'], d.get('path')) for d in rep['docs'] if d['id'] == 'b-doc'], [('이동', 'F/새폴더/B_261001.docx')])

    def test_renamed_split_and_new_docs(self):
        # 11/23 위치·이름으로 못 찾은 근거 문서는 후보 폴더 안 짝 없는 문서의 절을 읽어 내용으로 짝짓는다:
        # 하나면 '이름 바뀐 새 판', 여럿이면 '나뉨'(인용 절마다 파일별 TO-BE). 기준일 뒤에 생긴 짝 없는 문서 = 새 문서
        b = base()
        b['manifest'] = b['manifest'][:1]
        b['sections'] = {'a-doc': dict(sha1='s0', sections=[['1', '개요', 'h1'], ['2', '절차', 'h2'], ['3', '기타', 'h3']])}
        old = '2026-11-01T00:00:00Z'
        tree = [dict(path='F/본점_EK43_A_문서_261118_SOP.docx', fileId='renamed', size=1, modified='2026-11-18T00:00:00Z'),
                dict(path='F/무관한_문서.docx', fileId='other', size=1, modified=old),
                dict(path='F/아카이브/A_문서_261020_SOP.docx', fileId='arch', size=1, modified=old),
                dict(path='Z/A_문서_261020_SOP.docx', fileId='store', size=1, modified=old)]
        secs = {'renamed': [['1', '개요', 'h1'], ['2', '절차', 'h2x'], ['4', '새 절', 'h4']], 'other': [['1', '전혀 다른', 'zz']]}
        asked = []
        sections_of = lambda f: asked.append(f['fileId']) or secs[f['fileId']]
        with mock.patch.object(drive_sync, 'parse_docx', return_value=NEW_A):
            rep = drive_sync.compare(b, tree, lambda f, force: ('s9', b'x'), sections_of)
        a = rep['docs'][0]
        self.assertEqual((a['status'], a['path'], a['match']['sameSections'], a['match']['sameTitles']), ('이름 바뀐 새 판', 'F/본점_EK43_A_문서_261118_SOP.docx', 1, 2))
        self.assertEqual(len(a['cited']), 1)  # 짝지은 뒤에는 바뀐 절 AS-IS/TO-BE 를 그대로 보여 준다
        self.assertEqual(sorted(asked), ['other', 'renamed'])  # 아카이브·다른 지점 사본은 읽지도 않는다
        self.assertEqual(rep['added'], [])  # 짝지어진 파일은 새 문서가 아니고, 'other' 는 기준일 전 문서
        # 나뉨: 같은 문서가 두 파일로(공통에 하나, 본점에 하나) — 둘 다 짝, 인용 절은 파일별 TO-BE
        tree += [dict(path='F/본점/본점_Robur_A_문서_261118_SOP.docx', fileId='part2', size=1, modified='2026-11-18T00:00:00Z'),
                 dict(path='F/새로운_안내_GUI_261119.docx', fileId='brand-new', size=1, created='2026-11-19T00:00:00Z', modified='2026-11-19T00:00:00Z')]
        secs.update({'part2': [['1', '개요', 'h1'], ['2', '절차', 'h2'], ['5', '로버 전용', 'h5']], 'brand-new': [['1', '안내', 'n1']]})
        part2 = dict(sections=[dict(no='1', title='개요', paragraphs=['p1'], tables=[], hash='h1'),
                               dict(no='2', title='절차', paragraphs=[], tables=[dict(header=['항목', '방법'], rows=[['닦기', '물로']])], hash='h2'),
                               dict(no='5', title='로버 전용', paragraphs=[], tables=[], hash='h5')])
        with mock.patch.object(drive_sync, 'parse_docx', side_effect=lambda raw, path: part2 if 'Robur' in path else NEW_A):
            rep = drive_sync.compare(b, tree, lambda f, force: (f['fileId'], b'x'), sections_of)
        a = rep['docs'][0]
        self.assertEqual((a['status'], [p['path'] for p in a['parts']]), ('나뉨', ['F/본점_EK43_A_문서_261118_SOP.docx', 'F/본점/본점_Robur_A_문서_261118_SOP.docx']))
        c = next(c for c in a['cited'] if c['key'] == 'a-doc|2#r1')
        self.assertEqual([(v['path'].rsplit('/', 1)[0] if 'Robur' in v['path'] else v['path'].split('_A_')[0], '세제로' in v['tobe'], '물로' in v['tobe']) for v in c['variants']], [('F/본점_EK43', True, False), ('F/본점', False, True)])
        self.assertEqual([x['path'] for x in rep['added']], ['F/새로운_안내_GUI_261119.docx'])
        self.assertEqual(rep['counts'], {'나뉨': 1, '새 문서': 1})

    def test_similarity_ignores_template_sections(self):
        # 여러 문서에 똑같이 나오는 서식 절(목적·적용 범위)은 짝짓기 점수에 넣지 않는다 — 서식만 같은 남의 문서와 짝짓지 않게
        sections = {k: dict(sections=[['1', '목적', 'g1'], ['2', '적용 범위', 'g2'], ['3', k, k]]) for k in ('d1', 'd2', 'd3')}
        generic = drive_sync.generic_marks(sections)
        score, same, titles = drive_sync.similarity(sections['d1']['sections'], [['1', '목적', 'g1'], ['2', '적용 범위', 'g2'], ['3', '남의 절', 'x']], generic, 'A_문서.docx', 'B_딴문서.docx')
        self.assertEqual((same, titles), (0, 0))
        self.assertLess(score, drive_sync.MATCH_MIN)

    def test_newest_created_file_in_folder_is_current_edition(self):
        # 11/23 옛 파일을 남겨 둔 채 같은 문서의 새 파일을 만들면(날짜를 잘못 적어도) 드라이브에서 가장 늦게 생성된 파일을 지금 판으로 본다
        b = base()
        b['manifest'] = b['manifest'][:1]
        tree = [dict(path=A_PATH, fileId='old', size=1, created='2026-10-20T00:00:00Z', modified='2026-10-20T00:00:00Z'),
                dict(path='F/A_문서_261001_SOP.docx', fileId='new', size=1, created='2026-11-18T00:00:00Z', modified='2026-11-18T00:00:00Z')]  # 날짜를 잘못 적음
        with mock.patch.object(drive_sync, 'parse_docx', return_value=NEW_A):
            rep = drive_sync.compare(b, tree, lambda f, force: ({'old': 's0'}.get(f['fileId'], 's1'), b'x'))
        a = rep['docs'][0]
        self.assertEqual((a['status'], a['path']), ('새 판', 'F/A_문서_261001_SOP.docx'))
        self.assertEqual(rep['added'], [])  # 옛 파일도 새 파일도 '새 문서'가 아니다
        tree[1]['created'] = '2026-10-01T00:00:00Z'  # 새로 만든 게 아니면 기준 파일 그대로
        rep = drive_sync.compare(b, tree, lambda f, force: ({'old': 's0'}.get(f['fileId'], 's1'), b'x'))
        self.assertEqual((rep['docs'][0]['status'], rep['docs'][0]['path']), ('그대로', A_PATH))

    def test_unchanged_doc_is_not_parsed(self):
        tree = [dict(path=A_PATH, fileId='fa', size=10, modified='m')]
        with mock.patch.object(drive_sync, 'parse_docx') as parse:
            rep = drive_sync.compare(base(), tree, lambda f, force: ('s0', None))
        parse.assert_not_called()
        self.assertEqual(rep['docs'][0]['status'], '그대로')

    def test_cited_section_missing_and_photo_reference(self):
        new = dict(sections=[dict(no='2', title='절차', paragraphs=[], tables=[dict(header=['항목', '방법'], rows=[['닦기', '물로']])], hash='h2')])
        tree = [dict(path=A_PATH, fileId='fa', size=10, modified='m')]
        with mock.patch.object(drive_sync, 'parse_docx', return_value=new):
            rep = drive_sync.compare(base(), tree, lambda f, force: ('s9', b'x'))
        a = rep['docs'][0]
        self.assertEqual(a['status'], '바뀜')
        self.assertEqual([(c['key'], c['missing']) for c in a['cited']], [('a-doc|1', True)])
        self.assertEqual([(r['no'], r['part']) for r in a['cited'][0]['lessons']], [(2, 'other')])  # 사진의 근거 절
        self.assertEqual(a['removed'], [['1', '개요'], ['3', '기타']])

    def test_parse_failure_is_reported_per_document(self):
        tree = [dict(path=A_PATH, fileId='fa', size=10, modified='m')]
        with mock.patch.object(drive_sync, 'parse_docx', side_effect=RuntimeError('깨진 파일')):
            rep = drive_sync.compare(base(), tree, lambda f, force: ('s9', b'x'))
        self.assertEqual(rep['docs'][0]['status'], '확인 실패')
        self.assertIn('깨진 파일', rep['docs'][0]['error'])

    def test_repo_baseline_matches_build(self):
        """저장소의 기준: manifest 문서가 모두 source_sections.json 에 있고, 교육이 인용한 절이 그 절 목록에 있다."""
        b = drive_sync.load_base()
        self.assertEqual({m['id'] for m in b['manifest']}, set(b['sections']))
        for key, e in b['content']['sections'].items():
            names = {(s[0] or s[1]) for s in b['sections'][e['doc']]['sections']}
            self.assertIn(e['no'] or e['title'], names, key)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = make_store(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_run_caches_sha_and_ack_counts(self):
        tree = [dict(path=A_PATH, fileId='fa', size=10, modified='m1')]
        downloads = []
        b = base()
        b['manifest'], b['sections'] = b['manifest'][:1], {'a-doc': dict(b['sections']['a-doc'], sha1=hashlib.sha1(b'same').hexdigest())}
        with mock.patch.object(works_auth, 'docs_folder', return_value=('d1', 'f1', [])), \
                mock.patch.object(works_auth, 'docs_tree', return_value=tree), \
                mock.patch.object(works_auth, 'docs_download', side_effect=lambda t, d, fid: downloads.append(fid) or b'same'):
            rep = drive_sync.run(self.store, 'tok', '테스트', base=b)
            self.assertEqual((rep['docs'][0]['status'], rep['sharedriveId']), ('그대로', 'd1'))
            drive_sync.run(self.store, 'tok', '테스트', base=b)
        self.assertEqual(downloads, ['fa'])  # 수정일·크기가 같으면 다시 받지 않는다
        st = drive_sync.read_state(self.store)
        self.assertEqual((st['lastRun']['ok'], rep['tickets'], st['lastRun']['tickets']), (True, dict(created=[], replaced=[], closed=[]), dict(created=[], replaced=[], closed=[])))  # 화면 '동기화 완료 … n개'
        drive_sync.set_auto(self.store, True, dict(name='이재현'))
        v = drive_sync.view(self.store)
        self.assertEqual((v['auto'], v['autoBy']), (True, '이재현'))
        self.assertNotIn('cache', v)

    def tickets(self):
        with self.store.connect() as db:
            return (lms_store.Rooms.read(db, onboarding.ROOT) or {}).get('contentRequests') or []

    def test_changed_docs_become_tickets_and_close_after_deploy(self):
        changed = dict(id='a-doc', title='A 문서', folder='F/G', file='A.docx', status='바뀜', sha1='v1', path='F/G/A.docx',
                       cited=[dict(key='a-doc|1', no='1', title='개요', part='', asis='개요\np1', tobe='개요\np2', missing=False, note='',
                                   lessons=[dict(no=3, id='s1', title='교육1', part='kp', index=0, text='t')])], other=[], added=[['4', '새 절']], removed=[])
        rep = lambda *docs: dict(at='2026-11-16T00:00:00+00:00', docs=list(docs))
        out = onboarding.sync_drive_tickets(self.store, rep(changed, dict(id='b-doc', status='그대로'), dict(id='c-doc', status='확인 실패')), '아침 자동 확인')
        self.assertEqual((out['created'], out['replaced'], out['closed'], out['kinds']), (['REQ-1'], [], [], {'바뀜': 1}))
        t = self.tickets()[0]
        self.assertEqual((t['type'], t['status'], t['target']['kind'], t['target']['title'], t['drive']['version']), ('원본 문서 변경 확인', '진행중', 'doc', 'F › G › A 문서', 'v1'))
        self.assertIn('영향받는 교육: 3. 교육1', t['tobe'])
        self.assertIn('새 절: 4 새 절', t['tobe'])
        self.assertEqual(onboarding.sync_drive_tickets(self.store, rep(changed), 'x'), dict(created=[], replaced=[], closed=[]))  # 같은 판은 그대로(kinds 도 없음)
        out = onboarding.sync_drive_tickets(self.store, rep(dict(changed, sha1='v2')), '이재현')  # 또 바뀌면 새 티켓, 이전 티켓은 반려(이어짐)
        self.assertEqual((out['created'], out['replaced']), (['REQ-2'], ['REQ-1']))
        old, new = self.tickets()
        self.assertEqual((old['status'], old['drive']['version'], new['status'], new['drive']['version'], new['name']), ('반려', 'v1', '진행중', 'v2', '이재현'))
        self.assertIn('REQ-2', old['reply'])
        out = onboarding.sync_drive_tickets(self.store, rep(dict(id='a-doc', status='그대로')), '이재현')  # 배포 뒤 기준 = 드라이브
        self.assertEqual((out['closed'], self.tickets()[1]['status']), (['REQ-2'], '반영됨'))
        self.assertEqual(onboarding.sync_drive_tickets(self.store, rep(dict(changed, sha1='v2')), 'x')['created'], [])  # 처리한 판은 다시 만들지 않는다
        self.assertEqual(onboarding.sync_drive_tickets(self.store, rep(dict(changed, sha1='v3')), 'x')['created'], ['REQ-3'])
        self.assertEqual({k['no']: k['version'] for k in drive_sync.drive_tickets(self.store).values()}, {'REQ-3': 'v3'})

    def test_new_doc_ticket_and_close(self):
        rep = dict(at='x', docs=[], added=[dict(path='F/G/새 안내.docx', fileId='f1', modified='m')])
        self.assertEqual(onboarding.sync_drive_tickets(self.store, rep, '이재현')['created'], ['REQ-1'])
        self.assertEqual(onboarding.sync_drive_tickets(self.store, rep, '이재현')['created'], [])  # 같은 파일은 한 번만
        t = self.tickets()[0]
        self.assertEqual((t['field'], t['target']['title'], t['drive']['docId']), ('새 문서', 'F › G › 새 안내', 'new:f1'))
        out = onboarding.sync_drive_tickets(self.store, dict(at='y', docs=[dict(id='new-doc', status='그대로', fileId='f1', sha1='s')]), '이재현')
        self.assertEqual((out['closed'], self.tickets()[0]['status']), (['REQ-1'], '반영됨'))  # 근거 문서로 등록되면 반영됨

    def test_deploy_closes_ticket_when_baseline_matches(self):
        base = json.loads((Path(__file__).parent / 'source_sections.json').read_text(encoding='utf-8'))['documents']
        man = {m['id']: m for m in json.loads((Path(__file__).parent / 'source_manifest.json').read_text(encoding='utf-8'))['documents']}
        doc, info = next(iter(base.items()))
        onboarding.sync_drive_tickets(self.store, dict(at='x', docs=[dict(id=doc, title='T', folder='F', file='f.docx', status='이동', sha1=info['sha1'], path='딴곳/아카이브/f.docx')]), '동기화')
        onboarding.sync_drive_tickets(self.store, dict(at='x', docs=[dict(id='other-doc', title='O', folder='F', file='o.docx', status='바뀜', sha1='not-deployed', path='F/o.docx')]), '동기화')
        self.assertEqual(onboarding.close_synced_drive_tickets(self.store), [])  # 내용(sha1)은 같아도 위치가 다르면 닫지 않는다(11/20 REQ-22)
        with self.store.connect() as db:
            root = lms_store.Rooms.read(db, onboarding.ROOT)
            root['contentRequests'][0]['drive']['path'] = f"{man[doc]['folder']}/{man[doc]['file']}"
            lms_store.Rooms.write(db, onboarding.ROOT, root)
        self.assertEqual(onboarding.close_synced_drive_tickets(self.store), ['REQ-1'])  # 배포된 기준 sha1·경로 = 티켓의 원본 → 반영됨
        self.assertEqual([t['status'] for t in self.tickets()], ['반영됨', '진행중'])

    def test_failed_run_is_recorded(self):
        with mock.patch.object(works_auth, 'docs_folder', return_value=(None, None, [])):
            with self.assertRaises(RuntimeError):
                drive_sync.run(self.store, 'tok', '테스트', base=base())
        st = drive_sync.read_state(self.store)
        self.assertEqual((st['lastRun']['ok'], st['lastRun']['error']), (False, '드라이브에서 ST_매장사업부 폴더를 찾지 못했어요.'))

    def test_llm_keys(self):
        raw = drive_sync.new_llm_key(self.store, dict(email='boss@momos.co.kr', name='점장'))
        self.assertTrue(raw.startswith('mlk_'))
        with self.store.connect() as db:
            self.assertNotIn(raw, json.dumps(lms_store.Rooms.read(db, drive_sync.LLM_KEYS_KEY)))  # 원문은 저장하지 않는다
        boss = {'boss@momos.co.kr'}
        self.assertEqual(drive_sync.check_llm_key(self.store, 'Bearer ' + raw, boss)['name'], '점장')
        self.assertIsNone(drive_sync.check_llm_key(self.store, 'Bearer ' + raw, {'other@momos.co.kr'}))  # 관리자에서 빠지면 못 쓴다
        self.assertIsNone(drive_sync.check_llm_key(self.store, 'Bearer mlk_wrong', boss))
        self.assertIsNone(drive_sync.check_llm_key(self.store, raw, boss))
        keys = drive_sync.list_llm_keys(self.store, set())
        self.assertEqual((len(keys), keys[0]['active'], bool(keys[0]['last'])), (1, False, True))
        drive_sync.revoke_llm_key(self.store, keys[0]['id'])
        self.assertIsNone(drive_sync.check_llm_key(self.store, 'Bearer ' + raw, boss))


BOSS = dict(email='boss@momos.co.kr', name='점장', company='momos')


class RefreshTokenTests(unittest.TestCase):
    def setUp(self):
        from cryptography.fernet import Fernet
        self.tmp = tempfile.TemporaryDirectory()
        self.store = make_store(self.tmp.name)
        self.patches = [mock.patch.dict(os.environ, {'LMS_TOKEN_KEY': Fernet.generate_key().decode(), 'WORKS_CLIENT_ID': 'cid',
                                                     'WORKS_CLIENT_SECRET': 'sec', 'WORKS_DOMAIN': 'momos.co.kr'}),
                        mock.patch.object(works_auth, 'admin_emails', return_value={'boss@momos.co.kr'})]
        for p in self.patches:
            p.start()
        works_auth._SERVICE.clear()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        works_auth._SERVICE.clear()
        self.tmp.cleanup()

    def raw_saved(self):
        with self.store.connect() as db:
            return json.dumps(lms_store.Rooms.read(db, works_auth.REFRESH_KEY) or {})

    def test_admin_refresh_token_is_encrypted_and_used(self):
        works_auth.keep_refresh(self.store, BOSS, dict(refresh_token='RT-SECRET-1'))
        works_auth.keep_refresh(self.store, dict(BOSS, email='staff@momos.co.kr'), dict(refresh_token='RT-STAFF'))
        self.assertNotIn('RT-SECRET-1', self.raw_saved())
        self.assertNotIn('staff@', self.raw_saved())  # LMS관리자가 아니면 저장하지 않는다
        self.assertEqual([k['email'] for k in works_auth.saved_refresh(self.store, {'boss@momos.co.kr'})], ['boss@momos.co.kr'])
        sent = []
        with mock.patch.object(works_auth, '_post_form', side_effect=lambda url, data: sent.append(data) or dict(access_token='AT', expires_in=3600)):
            self.assertEqual(works_auth.service_token(self.store), 'AT')
            self.assertEqual(works_auth.service_token(self.store), 'AT')  # 만료 전에는 다시 받지 않는다
        self.assertEqual(len(sent), 1)
        self.assertEqual((sent[0]['grant_type'], sent[0]['refresh_token']), ('refresh_token', 'RT-SECRET-1'))
        self.assertEqual(works_auth.drive_token(self.store, 'no-login-user'), 'AT')

    def test_invalid_or_removed_admin_tokens_are_dropped(self):
        works_auth.keep_refresh(self.store, BOSS, dict(refresh_token='RT'))
        err = HTTPError('u', 400, 'bad', {}, io.BytesIO(b'{"error":"invalid_grant"}'))
        with mock.patch.object(works_auth, '_post_form', side_effect=err):
            with self.assertRaises(works_auth.DirectoryUnavailable):
                works_auth.service_token(self.store)
        self.assertEqual(works_auth.saved_refresh(self.store, {'boss@momos.co.kr'}), [])
        works_auth.keep_refresh(self.store, BOSS, dict(refresh_token='RT2'))
        with self.store.connect() as db:
            works_auth.forget_refresh(db, 'Boss@momos.co.kr')
        self.assertEqual(works_auth.saved_refresh(self.store, {'boss@momos.co.kr'}), [])

    def test_without_encryption_key_nothing_is_stored(self):
        with mock.patch.dict(os.environ, {'LMS_TOKEN_KEY': ''}):
            works_auth.keep_refresh(self.store, BOSS, dict(refresh_token='RT'))
            self.assertFalse(works_auth.key_ready())
            with self.assertRaises(works_auth.DirectoryUnavailable):
                works_auth.service_token(self.store)
        self.assertEqual(works_auth.saved_refresh(self.store, {'boss@momos.co.kr'}), [])


class SyncApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = server.Store(Path(self.tmp.name) / 'data')
        self.httpd = server.make_server(self.store, 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.env = mock.patch.dict(os.environ, {'LMS_ADMIN_EMAILS': 'boss@momos.co.kr'})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def get(self, path, key=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=10)
        try:
            conn.request('GET', path, headers={'Authorization': 'Bearer ' + key} if key else {})
            r = conn.getresponse()
            return r.status, dict(r.getheaders()), r.read()
        finally:
            conn.close()

    def test_llm_read_needs_admin_key(self):
        self.assertEqual(self.get('/api/sync/report')[0], 401)
        self.assertEqual(self.get('/api/sync/report', 'mlk_nope')[0], 401)
        key = drive_sync.new_llm_key(self.store, BOSS)
        self.assertEqual(self.get('/api/sync/report', key)[0], 404)  # 아직 결과 없음
        report = dict(format='momos-lms-drive-sync', sharedriveId='d1', docs=[dict(id='a-doc', status='바뀜', sha1='x', path='F/가.docx', fileId='fa')], extra=[], counts={})
        drive_sync.update_state(self.store, lambda s: s.update(report=report))
        code, _, body = self.get('/api/sync/report', key)
        self.assertEqual((code, json.loads(body)['tickets']), (200, {}))
        with mock.patch.object(works_auth, 'service_token', return_value='AT'), \
                mock.patch.object(works_auth, 'docs_download', return_value=b'PK-docx') as dl:
            code, _, body = self.get('/api/sync/file?doc=a-doc', key)
            self.assertEqual((code, body), (200, b'PK-docx'))
            dl.assert_called_once_with('AT', 'd1', 'fa')
            self.assertEqual(self.get('/api/sync/file?doc=none', key)[0], 404)
        with mock.patch.dict(os.environ, {'LMS_ADMIN_EMAILS': ''}):
            self.assertEqual(self.get('/api/sync/report', key)[0], 401)  # LMS관리자에서 빠진 사람의 키


if __name__ == '__main__':
    unittest.main()
