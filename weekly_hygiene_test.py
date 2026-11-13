"""Weekday split: preserve old evidence, never infer individual task completion."""
import copy
import json
from pathlib import Path
import unittest

import onboarding as ob


class WeeklyHygieneTests(unittest.TestCase):
    def test_old_checks_are_archived_once_and_new_days_are_unchecked(self):
        move = ob.KP_MOVES['floor-weekly']
        arrays = ('self', 'teacher', 'selfAt', 'teacherAt', 'selfBy', 'teacherBy', 'teacherName', 'teacherWhen')
        for status in ('ready', 'practice', 'review', 'done'):
            for basis in (ob.CHECK_BASIS, 'older-check-basis'):
                with self.subTest(status=status, basis=basis):
                    old = dict(status=status, checkBasis=basis, teacher=[status == 'done' or i % 2 == 0 for i in range(9)],
                               self=[True] * 9, done='2026-11-12' if status == 'done' else None,
                               request='2026-11-12' if status == 'review' else None, start='2026-11-10',
                               memo='keep memo', feedback='keep feedback', attempt=2,
                               history=[{'event': 'keep history'}], completedBy='old-trainer', completedByName='이전 교육자')
                    for key in arrays[2:]:
                        old[key] = [f'{key}-{i}' for i in range(9)]
                    before = copy.deepcopy(old)
                    unrelated = ob.blank('2026-11-01')['records']['floor-cleaning']
                    unrelated.update(status='done', teacher=[True] * len(unrelated['teacher']), done='2026-11-11')
                    other_before = copy.deepcopy(unrelated)
                    plan = dict(start='2026-11-20', end='2026-11-27', edited=True)
                    learner = dict(join='2026-11-01', records={'floor-weekly': old, 'floor-cleaning': unrelated},
                                   planDates={'floor-weekly': plan})
                    ob.fit(learner)
                    self.assertEqual(old['history'][:-1], before['history'])
                    archive = old['history'][-1]
                    for key, value in before.items():
                        if key != 'history': self.assertEqual(archive[key], value)
                    self.assertEqual(archive['checkTexts'], move[3]['previousChecks'])
                    self.assertEqual(archive['lessonTitle'], '요일별 주간 위생 업무')
                    self.assertEqual(archive['splitMigration'], move[0])
                    for key in arrays:
                        self.assertEqual(old[key], [False if key in ('self', 'teacher') else None] * 6)
                    self.assertEqual(old['status'], 'practice' if status in ('done', 'review') else status)
                    self.assertEqual(old['memo'], before['memo'])
                    self.assertEqual(old['feedback'], before['feedback'])
                    if status in ('done', 'review'):
                        self.assertIsNone(old['done'])
                        self.assertIsNone(old['request'])
                        self.assertNotIn('completedBy', old)
                    for ident, n in move[3]['addedSteps'].items():
                        added = learner['records'][ident]
                        self.assertEqual((added['status'], added['teacher'], added['history']), ('ready', [False] * n, []))
                        self.assertEqual(learner['planDates'][ident], plan)
                        self.assertIsNot(learner['planDates'][ident], plan)
                        self.assertEqual(ob.STEPS[ident]['plan'], ob.STEPS['floor-weekly']['plan'])
                    self.assertEqual(learner['records']['floor-cleaning'], other_before)
                    once = copy.deepcopy(learner)
                    self.assertEqual(ob.fit(learner), once)

    def test_new_completion_and_existing_day_schedule_are_never_reset(self):
        learner = ob.blank('2026-11-13')
        for ident in ('floor-weekly', 'floor-weekly-tue'):
            r = learner['records'][ident]
            r.update(status='done', teacher=[True] * len(r['teacher']), done='2026-11-13')
        learner['planDates']['floor-weekly-tue'] = dict(start='2026-12-01', end='2026-12-05', edited=True)
        before = copy.deepcopy(learner)
        ob.fit(learner)
        for ident in ('floor-weekly', 'floor-weekly-tue'):
            self.assertEqual(learner['records'][ident]['status'], 'done')
            self.assertEqual(learner['records'][ident]['history'], [])
        self.assertEqual(learner['planDates'], before['planDates'])

    def test_weekdays_are_separate_and_each_body_contains_only_its_task_row(self):
        content = json.loads(Path(__file__).with_name('v1_content.json').read_text(encoding='utf-8'))
        steps = [s for u in content['units'] for s in u['steps']]
        self.assertEqual(len(steps), 92)
        ids = ['floor-weekly'] + ['floor-weekly-' + day for day in ('tue', 'wed', 'thu', 'fri', 'sat', 'sun')]
        self.assertEqual([s['id'] for s in steps[29:36]], ids)
        for step, n, ref, day in zip(steps[29:36], (6, 8, 7, 7, 6, 4, 5), range(2, 9), '월화수목금토일'):
            self.assertEqual(step['title'], day + '요일 주간위생업무')
            self.assertNotEqual(step['lessonStatus'], 'planned')
            self.assertEqual(len(step['keyPoints']), n)
            self.assertEqual(len(ob.STEPS[step['id']]['checks']), n)
            for row, kp in enumerate(step['keyPoints'], 1):
                key = f'주간-위생-업무|5.{ref}#r{row}'
                self.assertEqual(kp['cites'], [key])
                sec = content['sections'][key]
                self.assertEqual(sec['tables'][0]['header'], ['업무 항목', '수행 방법'])
                self.assertEqual(len(sec['tables'][0]['rows']), 1)
                self.assertEqual(sec['paragraphs'], [])
            self.assertIn('격주', step['note'])
        for step in steps[31:33]:
            self.assertIn('다음 날 근무자', step['note'])


if __name__ == '__main__':
    unittest.main()
