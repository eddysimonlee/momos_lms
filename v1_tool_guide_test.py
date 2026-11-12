"""메뉴 도구 안내가 원본의 다른 행이나 잘못된 번호와 연결되지 않게 한다."""
import copy
import unittest

from v1_build import validate_tool_guide


class ToolGuideTests(unittest.TestCase):
    def setUp(self):
        self.docs = {'fixture': {'id': 'fixture', 'sections': [dict(no='5.1.1', title='도구', tables=[dict(
            header=['메뉴', '번호', '도구'], rows=[['다른 메뉴', '1', '냄비'], ['확인 메뉴', '2, 3', '거름망, 스푼']])])]}}
        self.guide = dict(menu='확인 메뉴', numbers=[2, 3], names=['거름망', '스푼'], cite=['fixture', '5.1.1', 't1:r2'])

    def test_correct_menu_row_is_accepted(self):
        validate_tool_guide(self.guide, self.docs)

    def test_wrong_menu_row_or_tool_number_is_rejected(self):
        for change in [dict(cite=['fixture', '5.1.1', 't1:r1']), dict(numbers=[2, 4]), dict(menu='다른 메뉴')]:
            guide = copy.deepcopy(self.guide); guide.update(change)
            with self.assertRaisesRegex(ValueError, '원본 표'):
                validate_tool_guide(guide, self.docs)

    def test_number_and_name_count_must_match(self):
        guide = dict(self.guide, names=['거름망'])
        with self.assertRaisesRegex(ValueError, '이름 수'):
            validate_tool_guide(guide, self.docs)

    def test_user_confirmed_no_tools_has_no_source_row_claim(self):
        validate_tool_guide(dict(menu='도구 없는 메뉴', numbers=[], names=[]), {})


if __name__ == '__main__':
    unittest.main()
