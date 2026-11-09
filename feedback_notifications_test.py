"""Opinion notifications use isolated accounts/DB only, never external delivery.
11/06: 의견에는 상태가 없다 — 관리자 댓글만 작성자에게 보이고 알림이 간다. 진행 상태는 수정 요청 티켓에서 본다."""
import copy
import unittest
from unittest.mock import patch

import onboarding as ob
import onboarding_test as fixtures
import lms_store as projects


class FeedbackNotificationTests(unittest.TestCase):
    tearDown = fixtures.EducationTests.tearDown
    add = fixtures.EducationTests.add
    erp_snapshot = fixtures.EducationTests.erp_snapshot
    payload = fixtures.EducationTests.payload
    act = fixtures.EducationTests.act
    enrol = fixtures.EducationTests.enrol

    def setUp(self):
        fixtures.EducationTests.setUp(self)
        seed = patch.object(ob, 'LMS_ADMIN_SEED', [self.admin['email'].lower()])
        seed.start()
        self.addCleanup(seed.stop)
        self.step = 'welcome-prep'

    def send(self, author=None, target=None):
        author = author or self.learner
        self.act(author, 'feedback.send', dict(step=self.step, text='위치를 더 설명해 주세요.'), target)
        return self.service.get(author)['myFeedback'][0]['id']

    def opinion(self, author=None):
        return self.service.get(author or self.learner)['myFeedback'][0]

    def notices(self, user=None):
        return [n for n in self.service.get(user or self.learner)['notifications']
                if n.get('kind', '').startswith('feedback.')]

    def test_author_reads_only_own_feedback_without_admin_ticket_data(self):
        fid = self.send()
        self.act(self.admin, 'feedback.comment', dict(id=fid, text='답변입니다.'))
        own = self.opinion()
        self.assertEqual(own['comments'][0]['text'], '답변입니다.')
        for key in ('tickets', 'email', 'status', 'resolved'):
            self.assertNotIn(key, own)
        self.assertEqual(self.service.get(self.other)['myFeedback'], [])
        self.assertNotIn('feedback', self.service.get(self.other))
        self.assertEqual(self.notices(self.other), [])
        self.assertEqual(self.service.get(self.admin)['feedback'][0]['id'], fid)

    def test_reply_retry_saves_one_comment_and_one_author_notification(self):
        fid = self.send()
        value = self.payload(self.admin, 'feedback.comment', dict(id=fid, text='새 답변'))
        self.service.update(self.admin, value)
        self.service.update(self.admin, value)
        self.assertEqual(len(self.opinion()['comments']), 1)
        notices = self.notices()
        self.assertEqual(len(notices), 1)
        self.assertEqual((notices[0]['kind'], notices[0]['title']), ('feedback.reply', '보내주신 의견에 댓글이 달렸습니다.'))
        self.assertEqual((notices[0]['feedback'], notices[0]['step'], notices[0]['text']), (fid, self.step, '새 답변'))
        self.assertEqual(notices[0]['comment'], self.opinion()['comments'][0]['id'])
        self.assertFalse(notices[0]['read'])
        self.assertEqual(self.notices(self.admin), [])

    def test_status_actions_are_gone(self):
        fid = self.send()
        for action, data in (('feedback.status', dict(id=fid, status='닫힘')), ('feedback.resolve', dict(id=fid))):  # 알파에서 잠깐 쓰던 의견 상태(답변 상태와 별개)
            with self.assertRaises(Exception):
                self.act(self.admin, action, data)
        self.assertNotIn('status', self.service.get(self.admin)['feedback'][0])

    def test_linking_a_ticket_changes_nothing_for_the_author(self):
        fid = self.send()
        self.act(self.admin, 'content.request', dict(target=dict(kind='item', id=self.step, title='교육'), type='문구 수정', tobe='새 문장'))
        key = self.service.get(self.admin)['contentRequests'][0]['no']
        self.act(self.admin, 'feedback.link', dict(id=fid, ticket=key, on=True))
        own = self.opinion()
        self.assertEqual(own['comments'], [])
        self.assertNotIn('tickets', own)  # 작성자에게 티켓 정보는 보이지 않는다
        self.assertEqual(self.notices(), [])
        self.assertEqual(self.service.get(self.admin)['feedback'][0]['tickets'], [key])

    def test_alpha_status_records_are_shown_only_as_comments(self):
        """알파에서 잠깐 쓰던 의견 상태: 상태 필드는 감추고, 상태를 바꾸며 쓴 댓글은 댓글로, 내용 없는 기록·자동 기록은 뺀다."""
        fid = self.send()
        with self.store.connect() as db:
            root = self.service.root(db)
            root['feedback'][-1].update(status='반영됨', statusAt='2026-11-06', comments=[
                dict(id='a1', at='2026-11-06', user=self.admin['id'], name='관리자', text='', status='진행중', auto='REQ-1 수정 요청과 연결'),
                dict(id='a2', at='2026-11-06', user=self.admin['id'], name='관리자', text='', status='닫힘'),
                dict(id='a3', at='2026-11-06', user=self.admin['id'], name='관리자', text='반영했어요.', status='반영됨')])
            projects.Rooms.write(db, ob.ROOT, root)
        own = self.opinion()
        self.assertNotIn('status', own)
        self.assertEqual([(c['id'], c['text']) for c in own['comments']], [('a3', '반영했어요.')])
        self.assertNotIn('status', own['comments'][0])
        self.assertEqual([n['comment'] for n in self.notices()], ['a3'])
        admin_row = self.service.get(self.admin)['feedback'][0]
        self.assertNotIn('status', admin_row)
        self.assertEqual([c['id'] for c in admin_row['comments']], ['a3'])

    def test_answer_state_defaults_to_in_progress_and_only_admins_toggle_it_without_alerts(self):
        fid = self.send()
        self.assertEqual(self.opinion()['answer'], '답변중')
        self.assertEqual(self.service.get(self.admin)['feedback'][0]['answer'], '답변중')
        with self.assertRaises(PermissionError):
            self.act(self.learner, 'feedback.answer', dict(id=fid, on=True))
        with self.assertRaises(ValueError):
            self.act(self.admin, 'feedback.answer', dict(id=fid, on='yes'))
        self.act(self.admin, 'feedback.answer', dict(id=fid, on=True))
        first = self.service.get(self.admin)['feedback'][0]
        self.assertEqual((first['answer'], self.opinion()['answer']), ('완료', '완료'))
        self.assertNotIn('answered', first)
        self.act(self.admin, 'feedback.answer', dict(id=fid, on=True))  # 다시 눌러도 처음 완료 시각 유지
        self.assertEqual(self.service.get(self.admin)['feedback'][0]['answeredAt'], first['answeredAt'])
        self.assertEqual(self.notices(), [])  # 상태 변경은 알림이 없다
        self.act(self.admin, 'feedback.answer', dict(id=fid, on=False))
        self.assertEqual(self.opinion()['answer'], '답변중')

    def test_author_is_sender_not_the_learner_whose_education_was_open(self):
        fid = self.send(self.trainer, self.learner['id'])
        self.act(self.admin, 'feedback.comment', dict(id=fid, text='교육자님께 답변'))
        self.assertEqual(len(self.notices(self.trainer)), 1)
        self.assertEqual(self.notices(self.learner), [])
        self.assertEqual(self.service.get(self.learner)['myFeedback'], [])

    def test_non_admin_cannot_comment_even_own_feedback(self):
        fid = self.send()
        for user in (self.learner, self.other):
            with self.assertRaises(PermissionError):
                self.act(user, 'feedback.comment', dict(id=fid, text='허용되지 않은 답변'))
        self.assertEqual(self.notices(), [])

    def test_read_is_per_notification_per_author_and_survives_service_reload(self):
        fid = self.send()
        self.act(self.admin, 'feedback.comment', dict(id=fid, text='첫 답변'))
        self.act(self.admin, 'feedback.comment', dict(id=fid, text='두 번째 답변'))
        first, second = self.notices()
        self.assertFalse(any(n['read'] for n in self.notices()))  # GET/list never marks read.
        with self.assertRaises(PermissionError):
            self.act(self.other, 'notification.read', dict(ids=[first['id']]))
        self.act(self.learner, 'notification.read', dict(ids=[first['id']]))
        self.service = ob.Service(self.store)
        notices = {n['id']: n for n in self.notices()}
        self.assertTrue(notices[first['id']]['read'])
        self.assertFalse(notices[second['id']]['read'])
        self.act(self.learner, 'notification.read', dict(ids=[first['id']]))
        self.assertEqual(len(self.notices()), 2)

    def test_existing_comments_and_learning_records_are_preserved_without_retroactive_alerts(self):
        fid = self.send()
        record = self.service.get(self.learner)['learner']['records'][self.step]
        for index in range(len(record['teacher'])):
            self.act(self.admin, 'step.mark', dict(step=self.step, index=index, on=True), self.learner['id'])
        self.act(self.admin, 'step.close', dict(step=self.step), self.learner['id'])
        self.assertEqual(self.service.get(self.learner)['learner']['records'][self.step]['status'], 'done')
        legacy = [dict(id='legacy-'+str(i), at='2026-01-01', user=self.admin['id'],
                       name='기존 담당자', text='기존 답변 '+str(i)) for i in range(101)]
        with self.store.connect() as db:
            root = self.service.root(db)
            root['feedback'][-1]['comments'] = legacy
            projects.Rooms.write(db, ob.ROOT, root)
        self.assertEqual(self.notices(), [])
        before = copy.deepcopy(self.service.get(self.learner)['learner'])
        self.act(self.admin, 'feedback.comment', dict(id=fid, text='추가 답변'))
        self.assertEqual(self.opinion()['comments'][:101], legacy)
        self.assertEqual(len(self.opinion()['comments']), 102)
        self.assertEqual(len(self.notices()), 1)
        self.assertEqual(self.service.get(self.learner)['learner'], before)
        self.assertEqual(self.erp_snapshot(), self.erp_before)

    def test_invalid_input_does_not_create_alerts(self):
        fid = self.send()
        with self.assertRaises(ValueError):
            self.act(self.admin, 'feedback.comment', dict(id=fid, text='  '))
        self.assertEqual(self.notices(), [])


if __name__ == '__main__':
    unittest.main()
