"""Separate model evidence and preserve the former combined completion without inferring competence."""
import copy
import json
from pathlib import Path
import unittest

import onboarding as ob
from v1_build import find_section


ROOT = Path(__file__).parent
IDS = ('grinder-blade', 'grinder-blade-robur-s', 'grinder-blade-major-vp')
DOCS = ('그라인더-날-분해-및-청소', '본점-RoburS-그라인더-날-분해-및-청소',
        '본점-MajorVP-그라인더-날-분해-및-청소')


class GrinderSplitTests(unittest.TestCase):
    def test_first_topic_removal_keeps_remaining_check_evidence_and_completion(self):
        for ident in IDS:
            for status in ('ready', 'practice', 'review', 'done'):
                with self.subTest(ident=ident, status=status):
                    learner = ob.blank('2026-11-01')
                    ob.fit(learner)
                    r = learner['records'][ident]
                    r['kpMoves'] = [ob.KP_MOVES[IDS[0]][0]] if ident == IDS[0] else []
                    r.update(status=status, teacher=[True] * 4 if status == 'done' else [True, False, True, False],
                             self=[False, True, False, True], done='2026-11-20' if status == 'done' else None,
                             completedBy='retired', completedByName='이전 확인자',
                             request='2026-11-19' if status == 'review' else None, memo='keep', history=[{'event': 'old'}])
                    for key in ('selfAt', 'teacherAt', 'selfBy', 'teacherBy', 'teacherName', 'teacherWhen'):
                        r[key] = [f'{key}-{i}' for i in range(4)]
                    before = copy.deepcopy(r)
                    other = copy.deepcopy({k: v for k, v in learner['records'].items() if k != ident})
                    ob.fit(learner)
                    for key in ('teacher', 'self', 'selfAt', 'teacherAt', 'selfBy', 'teacherBy', 'teacherName', 'teacherWhen'):
                        self.assertEqual(r[key], before[key][1:])
                    for key in ('status', 'done', 'completedBy', 'completedByName', 'request', 'memo'):
                        self.assertEqual(r[key], before[key])
                    archived = r['history'][-1]
                    for key, value in before.items():
                        if key != 'history': self.assertEqual(archived[key], value)
                    self.assertEqual({k: v for k, v in learner['records'].items() if k != ident}, other)
                    once = copy.deepcopy(learner)
                    self.assertEqual(ob.fit(learner), once)

    def test_existing_combined_records_are_archived_once_even_with_older_array_lengths(self):
        marker = ob.KP_MOVES[IDS[0]][0]
        for status in ('ready', 'practice', 'review', 'done'):
            for count in (3, 4, 5):
                with self.subTest(status=status, count=count):
                    old = dict(status=status, checkBasis='older-basis', teacher=[True] * count,
                               self=[False] * count, done='2026-11-20' if status == 'done' else None,
                               request='2026-11-19' if status == 'review' else None,
                               completedBy='retired-checker', completedByName='이전 확인자',
                               trainedBy={'name': '교육자'}, start='2026-11-17', memo='메모 보존',
                               feedback='피드백 보존', attempt=2, history=[{'event': '이전 이력'}])
                    for key in ('selfAt', 'teacherAt', 'selfBy', 'teacherBy', 'teacherName', 'teacherWhen'):
                        old[key] = [f'{key}-{i}' for i in range(count)]
                    before = copy.deepcopy(old)
                    learner = ob.blank('2026-11-01')
                    learner['records'][IDS[0]] = old
                    untouched = copy.deepcopy(learner['records']['stock-ecount'])
                    ob.fit(learner)
                    archived = old['history'][-1]
                    for key, value in before.items():
                        if key != 'history': self.assertEqual(archived[key], value)
                    self.assertEqual(old['history'][:-1], before['history'])
                    self.assertEqual(archived['lessonTitle'], '그라인더 날 분해·청소')
                    self.assertEqual(archived['splitMigration'], marker)
                    for key in ('teacher', 'self'): self.assertEqual(old[key], [False] * 3)
                    for key in ('selfAt', 'teacherAt', 'selfBy', 'teacherBy', 'teacherName', 'teacherWhen'):
                        self.assertEqual(old[key], [None] * 3)
                    self.assertEqual(old['status'], 'practice' if status in ('done', 'review') else status)
                    if status in ('done', 'review'):
                        self.assertIsNone(old['done'])
                        self.assertNotIn('completedBy', old)
                    for ident in IDS[1:]:
                        self.assertEqual(learner['records'][ident]['teacher'], [False] * 3)
                    self.assertEqual(learner['records']['stock-ecount'], untouched)
                    once = copy.deepcopy(learner)
                    self.assertEqual(ob.fit(learner), once)

    def test_fresh_and_post_migration_completions_and_existing_new_model_records_survive(self):
        learner = ob.blank('2026-11-24')
        ob.fit(learner)  # 이 작업과 무관한 기존 문항 이관을 먼저 마친다.
        for ident in IDS:
            learner['records'][ident].update(status='done', teacher=[True] * 3, done='2026-11-24')
        before = copy.deepcopy(learner)
        self.assertEqual(ob.fit(learner), before)
        learner['records'].pop(IDS[0])
        ob.fit(learner)
        self.assertEqual(learner['records'][IDS[0]]['history'], [])
        for ident in IDS[1:]: self.assertEqual(learner['records'][ident], before['records'][ident])

    def test_each_model_has_only_its_own_source_photos_and_complete_procedure(self):
        content = json.loads((ROOT / 'v1_content.json').read_text(encoding='utf-8'))
        steps = [s for u in content['units'] for s in u['steps']]
        self.assertEqual(len(steps), 97)  # REQ-33 블랙이글 데일리 청소 추가
        self.assertEqual([s['id'] for s in steps[93:]], [*IDS, 'stock-ecount'])
        for step, doc, last, count in zip(steps[93:96], DOCS, ('6.7', '6.4', '6.3'), (18, 11, 6)):
            self.assertEqual(len(step['keyPoints']), 3)
            self.assertEqual(step['shift'], ['CL'])
            self.assertEqual(step['position'], ['에스프레소'])
            self.assertEqual({c.split('|')[0] for c in step['sources']}, {doc})
            self.assertEqual({content['photos'][p]['cite'].split('|')[0] for p in step['photos']}, {doc})
            self.assertEqual(len(step['photos']), count)
            body = content['sections'][step['keyPoints'][1]['cites'][0]]
            text = '\n'.join(body['paragraphs'])
            self.assertIn(last, text)
            self.assertNotIn('완료 확인 및 이상 대응', text)
            if doc == DOCS[0]: self.assertIn('⑱ 고정 나사 단계적 체결', text)
            if doc == DOCS[1]: self.assertIn('⑪ 하부 날 중앙 너트 체결', text)

    def test_model_photos_cover_every_procedure_image_with_original_captions_in_order(self):
        content = json.loads((ROOT / 'v1_content.json').read_text(encoding='utf-8'))
        for ident, doc, count in zip(IDS, DOCS, (18, 11, 6)):
            with self.subTest(model=ident):
                step = next(s for u in content['units'] for s in u['steps'] if s['id'] == ident)
                procedure = content['sections'][doc + '|6.*']
                self.assertEqual(len(step['photos']), procedure['images'])
                self.assertEqual(len(set(step['photos'])), count)
                for n, pid in enumerate(step['photos'], 1):
                    photo = content['photos'][pid]
                    self.assertEqual(photo['n'], n)
                    self.assertEqual(photo['cite'], doc + '|6.*')
                    self.assertFalse(photo['wide'])
                    title, description = photo['caption'].split('\n', 1)
                    self.assertTrue(title.startswith(chr(0x245f + n)))
                    self.assertIn(title, procedure['paragraphs'])
                    self.assertIn(description, procedure['paragraphs'])
                    self.assertTrue((ROOT / photo['src']).is_file())

    def test_subtree_keeps_repeated_continuations_and_tables_but_stops_before_next_peer(self):
        def sec(no, level, text):
            return dict(no=no, level=level, title=text, paragraphs=[text], tables=[],
                        photos=[], images=0, chars=len(text), hash=text)
        parent = sec('6', 1, '작업')
        first = sec('6.1', 2, '분해')
        first['tables'] = [{'header': ['업무', '방법'], 'rows': [['청소', '브러시']]}]
        cont = sec('6.1', 2, '분해 계속')
        doc = dict(id='fixture', sections=[parent, first, cont, sec('7', 1, '다른 절')])
        before = copy.deepcopy(doc)
        found = find_section(doc, '6.*')
        self.assertIn('분해 계속', found['paragraphs'])
        self.assertNotIn('다른 절', found['paragraphs'])
        self.assertEqual(found['tables'], first['tables'])
        self.assertEqual(doc, before)
        with self.assertRaises(KeyError): find_section(doc, '6.1')


if __name__ == '__main__':
    unittest.main()
