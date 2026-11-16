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
                dict(path='X/B_261001.docx', fileId='fb', size=5, modified='2026-10-01'),
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
        self.assertEqual(rep['counts'], {'새 판': 1, '이동': 1, '없음': 1})

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
        self.assertEqual((st['lastRun']['ok'], drive_sync.pending(st)), (True, 0))
        st['report']['docs'][0].update(status='바뀜', sha1='zz')
        drive_sync.update_state(self.store, lambda s: s.update(report=st['report']))
        self.assertEqual(drive_sync.pending(drive_sync.read_state(self.store)), 1)
        drive_sync.set_ack(self.store, 'a-doc', True)
        self.assertEqual(drive_sync.pending(drive_sync.read_state(self.store)), 0)
        drive_sync.set_auto(self.store, True, dict(name='이재현'))
        v = drive_sync.view(self.store)
        self.assertEqual((v['auto'], v['autoBy'], v['ack']), (True, '이재현', {'a-doc': 'zz'}))
        self.assertNotIn('cache', v)

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
        self.assertEqual((code, json.loads(body)['pending']), (200, 1))
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
