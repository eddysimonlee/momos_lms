"""원본 절과 절 안의 번호 예시를 구분한다. 실제 업무문서 없이 만든 DOCX로 확인한다."""
import tempfile
import unittest
from pathlib import Path

from docx import Document
import source_parse


class SectionNumberTests(unittest.TestCase):
    def test_numbered_examples_stay_under_their_toc_section(self):
        doc = Document()
        doc.add_paragraph('MOMOS COFFEE')
        doc.add_paragraph('고객 응대 기준')
        doc.add_paragraph('목차')
        headings = ['1. 목적', '4. 공통 행동 기준', '4.9 표현 비교 예시', '5. 컴플레인 응대 기준']
        for heading in headings:
            doc.add_paragraph(heading)
        doc.add_paragraph(headings[0], 'Heading 2')
        doc.add_paragraph('고객을 응대하는 업무의 기준을 안내한다.')
        doc.add_paragraph(headings[1], 'Heading 2')
        doc.add_paragraph(headings[2], 'Heading 2')
        doc.add_paragraph('상황에 맞는 표현을 비교한다.')
        for i in range(1, 11):
            doc.add_paragraph(f'{i}. 상황 {i}')
            table = doc.add_table(rows=3, cols=2)
            for row, values in zip(table.rows, [('기본 응대', f'기본 {i}'), ('디테일 응대', f'세심한 표현 {i}'), ('개선 포인트', f'배려 {i}')]):
                for cell, value in zip(row.cells, values):
                    cell.text = value
        doc.add_paragraph(headings[3])  # 목차에 있는 일반 서식 제목도 정상적인 장이다.
        doc.add_paragraph('불편을 경청하고 안내한다.')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / '고객_응대_기준_GUI_261111.docx'
            doc.save(path)
            parsed = source_parse.parse(path)
        sections = {s['no']: s for s in parsed['sections']}
        self.assertEqual(len(sections), len(parsed['sections']))
        self.assertEqual(sections['1']['title'], '목적')
        self.assertEqual(sections['4']['title'], '공통 행동 기준')
        self.assertEqual(sections['5']['title'], '컴플레인 응대 기준')
        self.assertEqual(sections['4.9']['paragraphs'], ['상황에 맞는 표현을 비교한다.'])
        for i in range(1, 11):
            example = sections[f'4.9.{i}']
            self.assertEqual(example['title'], f'상황 {i}')
            self.assertEqual(example['tables'], [{'header': ['기본 응대', f'기본 {i}'], 'rows': [['디테일 응대', f'세심한 표현 {i}'], ['개선 포인트', f'배려 {i}']]}])

    def test_normal_headings_without_toc_keep_their_original_numbers(self):
        doc = Document()
        for heading, body in [('1. 목적', '목적을 안내한다.'), ('4.9 예시', '예시를 안내한다.'), ('5. 후속 절', '후속 내용을 안내한다.')]:
            doc.add_paragraph(heading)
            doc.add_paragraph(body)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / '서식_GUI_261111.docx'
            doc.save(path)
            self.assertEqual([s['no'] for s in source_parse.parse(path)['sections']], ['1', '4.9', '5'])


if __name__ == '__main__':
    unittest.main()
