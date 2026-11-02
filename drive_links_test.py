"""11/03 드라이브 링크 점검(works_auth.link_report) 테스트 — 네트워크 없이."""
import unittest

import works_auth

DOCS = [dict(folder='재고·전산 관리', file='a.docx', folderKey='K1'),
        dict(folder='재고·전산 관리', file='b.docx', folderKey='K1'),
        dict(folder='교육·평가', file='c.docx', folderKey='K2')]
FOLDERS = [['재고·전산 관리', 'K1'], ['교육·평가', 'K2']]
TREE = [dict(path='재고·전산 관리/a.docx'), dict(path='재고·전산 관리/b.docx'), dict(path='교육·평가/c.docx')]


class LinkReportTest(unittest.TestCase):
    def test_ok(self):
        r = works_auth.link_report(DOCS, FOLDERS, TREE)
        self.assertTrue(r['ok'])
        self.assertEqual(r['folders'], 2)
        self.assertIn('링크 정상 2', r['summary'])

    def test_folder_gone_moved_and_file_missing(self):
        r = works_auth.link_report(DOCS, [['교육·평가 (옛)', 'K2']], [dict(path='교육·평가/c.docx')])
        self.assertFalse(r['ok'])
        self.assertEqual([g['folder'] for g in r['goneFolders']], ['재고·전산 관리'])
        self.assertEqual(r['movedFolders'][0]['now'], '교육·평가 (옛)')
        # 키가 가리키는 폴더('교육·평가 (옛)') 안에 c.docx 가 없다 — 같은 이름의 다른 폴더에 있어도 실패
        self.assertEqual(r['missingDocs'], ['교육·평가/c.docx'])

    def test_file_not_in_linked_folder(self):
        tree = [dict(path='재고·전산 관리/a.docx'), dict(path='교육·평가/c.docx'), dict(path='교육·평가/b.docx')]
        r = works_auth.link_report(DOCS, FOLDERS, tree)
        self.assertFalse(r['ok'])
        self.assertEqual(r['missingDocs'], ['재고·전산 관리/b.docx'])
        self.assertIn('링크 폴더에 없는 파일 1', r['summary'])

    def test_no_key(self):
        r = works_auth.link_report([dict(folder='x', file='y.docx')], FOLDERS, [dict(path='x/y.docx')])
        self.assertEqual(r['noKeyDocs'], ['x/y.docx'])
        self.assertFalse(r['ok'])


if __name__ == '__main__':
    unittest.main()
