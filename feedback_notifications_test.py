"""Opinion notifications use isolated accounts/DB only, never external delivery."""
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
        self.assertNotIn('tickets', own)
        self.assertNotIn('email', own)
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
        self.assertEqual(self.opinion()['status'], '')  # 일반 댓글은 상태를 바꾸지 않는다
        notices = self.notices()
        self.assertEqual(len(notices), 1)
        self.assertEqual((notices[0]['kind'], notices[0]['title']), ('feedback.reply', '보내주신 의견에 댓글이 달렸습니다.'))
        self.assertEqual((notices[0]['feedback'], notices[0]['step'], notices[0]['text']), (fid, self.step, '새 답변'))
        self.assertEqual(notices[0]['comment'], self.opinion()['comments'][0]['id'])
        self.assertFalse(notices[0]['read'])
        self.assertEqual(self.notices(self.admin), [])

    def test_status_change_with_optional_comment_notifies_once_per_change(self):
        fid = self.send()
        value = self.payload(self.admin, 'feedback.status', dict(id=fid, status='반영됨', text='3번 교육에 넣었어요.'))
        self.service.update(self.admin, value)
        self.service.update(self.admin, value)  # 같은 요청 재시도
        self.act(self.admin, 'feedback.status', dict(id=fid, status='반영됨'))  # 같은 상태 다시 누름(댓글 없음)
        own = self.opinion()
        self.assertEqual(own['status'], '반영됨')
        self.assertEqual([(c['status'], c['text']) for c in own['comments']], [('반영됨', '3번 교육에 넣었어요.')])
        notices = self.notices()
        self.assertEqual(len(notices), 1)
        self.assertEqual((notices[0]['kind'], notices[0]['status'], notices[0]['text']), ('feedback.status', '반영됨', '3번 교육에 넣었어요.'))
        self.assertEqual(notices[0]['title'], "보내주신 의견이 '반영됨' 상태로 바뀌었습니다.")

    def test_close_after_answering_a_question(self):
        fid = self.send()
        self.act(self.admin, 'feedback.comment', dict(id=fid, text='매일 하지는 않아요.'))
        self.act(self.admin, 'feedback.status', dict(id=fid, status='닫힘'))
        self.assertEqual(self.opinion()['status'], '닫힘')
        self.assertEqual([n['kind'] for n in self.notices()], ['feedback.reply'])  # 댓글 없이 닫으면 알림 없음
        self.act(self.admin, 'feedback.status', dict(id=fid, status='진행중', text='다시 볼게요.'))
        self.assertEqual(sorted(n['kind'] for n in self.notices()), ['feedback.reply', 'feedback.status'])
        with self.assertRaises(ValueError):
            self.act(self.admin, 'feedback.status', dict(id=fid, status='완료'))

    def test_linking_a_ticket_does_not_change_the_opinion_status(self):
        fid = self.send()
        self.act(self.admin, 'content.request', dict(target=dict(kind='item', id=self.step, title='교육'), type='문구 수정', tobe='새 문장'))
        key = self.service.get(self.admin)['contentRequests'][0]['no']
        self.act(self.admin, 'feedback.link', dict(id=fid, ticket=key, on=True))
        own = self.opinion()
        self.assertEqual((own['status'], own['comments']), ('', []))  # 상태·댓글·알림 그대로
        self.assertNotIn('tickets', own)  # 작성자에게 티켓 정보는 보이지 않는다
        self.assertEqual(self.notices(), [])
        self.assertEqual(self.service.get(self.admin)['feedback'][0]['tickets'], [key])

    def test_legacy_resolve_maps_to_reflected(self):
        fid = self.send()
        self.act(self.admin, 'feedback.resolve', dict(id=fid))
        self.act(self.admin, 'feedback.resolve', dict(id=fid))
        self.assertEqual(self.opinion()['status'], '반영됨')
        self.assertEqual(self.notices(), [])  # 댓글 없는 상태 변경은 알림 없음

    def test_author_is_sender_not_the_learner_whose_education_was_open(self):
        fid = self.send(self.trainer, self.learner['id'])
        self.act(self.admin, 'feedback.comment', dict(id=fid, text='교육자님께 답변'))
        self.act(self.admin, 'feedback.status', dict(id=fid, status='반영됨', text='반영했어요.'))
        self.assertEqual(len(self.notices(self.trainer)), 2)
        self.assertEqual(self.notices(self.learner), [])
        self.assertEqual(self.service.get(self.learner)['myFeedback'], [])

    def test_non_admin_cannot_comment_or_resolve_even_own_feedback(self):
        fid = self.send()
        for user in (self.learner, self.other):
            with self.assertRaises(PermissionError):
                self.act(user, 'feedback.resolve', dict(id=fid))
            with self.assertRaises(PermissionError):
                self.act(user, 'feedback.status', dict(id=fid, status='닫힘'))
            with self.assertRaises(PermissionError):
                self.act(user, 'feedback.comment', dict(id=fid, text='허용되지 않은 답변'))
        self.assertNotIn('resolved', self.opinion())
        self.assertEqual(self.notices(), [])

    def test_read_is_per_notification_per_author_and_survives_service_reload(self):
        fid = self.send()
        self.act(self.admin, 'feedback.comment', dict(id=fid, text='첫 답변'))
        self.act(self.admin, 'feedback.status', dict(id=fid, status='반영됨', text='반영했어요.'))
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
        self.act(self.admin, 'feedback.status', dict(id=fid, status='반영됨', text='반영했어요.'))
        self.assertEqual(self.opinion()['comments'][:101], legacy)
        self.assertEqual(len(self.opinion()['comments']), 103)
        self.assertEqual(len(self.notices()), 2)
        self.assertEqual(self.service.get(self.learner)['learner'], before)
        self.assertEqual(self.erp_snapshot(), self.erp_before)

    def test_invalid_input_does_not_complete_or_create_alerts(self):
        fid = self.send()
        with self.assertRaises(ValueError):
            self.act(self.admin, 'feedback.comment', dict(id=fid, text='  '))
        with self.assertRaises(ValueError):
            self.act(self.admin, 'feedback.resolve', dict(id=fid, text='자동 댓글 금지'))
        with self.assertRaises(ValueError):
            self.act(self.admin, 'feedback.status', dict(id=fid, status='done'))
        self.assertNotIn('resolved', self.opinion())
        self.assertEqual(self.notices(), [])


if __name__ == '__main__':
    unittest.main()
