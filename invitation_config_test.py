"""Invitation regressions: temporary databases and mocked SMTP only."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import access
import invitations
import projects
import server
import task_mail
from access_test import fixture_state


def mail_environment(**overrides):
    values = dict(ERP_CLOUD_MODE='1', ERP_ENABLE_EMAIL='0',
                  ERP_ENABLE_SIGNUP_EMAIL='0', ERP_ENABLE_INVITE_EMAIL='1',
                  ERP_INVITE_BASE_URL='https://workspace.example.test',
                  ERP_SMTP_HOST='smtp.example.test', ERP_SMTP_PORT='465',
                  ERP_SMTP_FROM='sender@example.test', ERP_SMTP_USER='sender@example.test',
                  ERP_SMTP_PASSWORD='test-only-password')
    values.update(overrides)
    return patch.dict(os.environ, values, clear=True)


class InvitationPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = server.Store(Path(self.temp.name) / 'data', self.temp.name)
        self.auth = access.Access(self.store)
        self.invites = invitations.Invitations(self.auth)
        self.rooms = projects.Rooms(self.store)
        self.admin = self.auth.create(dict(name='고성운', email='admin@example.test',
                                          password='testing-password-123A1!'), setup=True)

    def invite(self, **overrides):
        value = dict(name='채수민', email='soomin@example.test', company='momos',
                     role='admin', sendEmail=False)
        value.update(overrides)
        return self.invites.create(self.admin, value, 'http://127.0.0.1:8768')

    def accept(self, invitation, email='soomin@example.test'):
        return self.invites.accept(dict(token=invitation['link'].split('#invite=')[1],
                                        email=email, password='testing-password-123A1!'))

    def test_admin_invite_is_email_bound_single_use_and_can_edit_schedule(self):
        with mail_environment(ERP_SMTP_HOST='', ERP_SMTP_FROM=''):
            with patch.object(self.invites, 'send_email') as send:
                invitation = self.invite()
                send.assert_not_called()
            self.assertTrue(invitation['link'].startswith('https://workspace.example.test/'))
            with self.assertRaises(ValueError):
                self.accept(invitation, 'someone-else@example.test')
            member = self.accept(invitation)
            self.assertEqual((member['role'], member['status']), ('admin', 'active'))
            with self.assertRaises(ValueError):
                self.accept(invitation)
        action = dict(type='schedule.set', taskId='OWN',
                      patch=dict(start='2026-09-18', due='2026-09-21'),
                      expectedStart='2026-09-01', expectedDue='2026-09-20')
        access.authorize_action(fixture_state(), member, action, self.auth)

    def test_registration_does_not_grant_admin_without_explicit_approval(self):
        member = self.auth.create(dict(name='채수민', email='soomin@example.test',
                                       password='testing-password-123A1!', company='momos'))
        self.assertEqual((member['role'], member['status']), ('member', 'pending'))
        member = self.auth.update_user(self.admin, member['id'], dict(role='admin', status='active'))
        self.assertEqual((member['role'], member['status']), ('admin', 'active'))

    def test_unapproved_name_and_supplier_admin_remain_rejected(self):
        for value in [dict(name='다른 사용자'), dict(company='viewcs')]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.invite(**value)

    def test_invitation_does_not_add_private_or_erp_membership(self):
        private = self.rooms.create(self.admin, dict(title='기존 개인 프로젝트'))
        with mail_environment():
            member = self.accept(self.invite())
        self.assertEqual(self.rooms.list(member)['items'], [])
        with self.assertRaises(FileNotFoundError):
            self.rooms.require_erp(member)
        revision = self.rooms.list(self.admin)['revision']
        self.rooms.configure(self.admin, 'erp', dict(revision=revision, action='member',
                                                    userId=member['id'], role='owner'))
        self.assertEqual(self.rooms.require_erp(member), 'owner')
        self.assertNotIn(private['id'], [r['id'] for r in self.rooms.list(member)['items']])


class InvitationMailTests(unittest.TestCase):
    def test_public_link_without_smtp_is_not_called_local(self):
        with mail_environment(ERP_SMTP_HOST='', ERP_SMTP_FROM=''):
            config = invitations.Invitations.config(invitation=True)
            self.assertEqual(config['mode'], 'public_link')
            self.assertTrue(config['publicUrlReady'])
            self.assertFalse(config['canSend'])
            self.assertNotIn('로컬', config['message'])

    def test_missing_smtp_password_blocks_send_readiness(self):
        with mail_environment(ERP_SMTP_PASSWORD=''):
            config = invitations.Invitations.config(invitation=True)
            self.assertFalse(config['canSend'])
            self.assertNotIn('test-only-password', str(config))

    def test_invite_switch_does_not_release_general_or_signup_mail(self):
        with mail_environment(), patch('invitations.smtplib.SMTP_SSL') as smtp:
            self.assertTrue(invitations.Invitations.config(invitation=True)['canSend'])
            self.assertFalse(invitations.Invitations.config()['canSend'])
            worker = object.__new__(task_mail.TaskMail)
            self.assertFalse(worker.dispatch_one())
            invitations.Invitations.send_email('recipient@example.test', '테스트',
                                                'https://workspace.example.test/#invite=test')
            smtp.assert_called_once()
            smtp.return_value.send_message.assert_called_once()
            with self.assertRaises(ValueError):
                invitations.Invitations.send_password_reset('recipient@example.test', 'https://example.test/reset')
            with self.assertRaises(ValueError):
                invitations.Invitations.send_message(None, signup=True)
            self.assertEqual(smtp.call_count, 1)

    def test_explicit_invite_off_overrides_general_mail(self):
        with mail_environment(ERP_ENABLE_EMAIL='1', ERP_ENABLE_INVITE_EMAIL='0'):
            self.assertFalse(invitations.Invitations.config(invitation=True)['canSend'])
            self.assertTrue(invitations.Invitations.config()['canSend'])

    def test_loopback_cannot_be_sent_as_public_invitation(self):
        with mail_environment(ERP_INVITE_BASE_URL='http://127.0.0.1:8768'):
            self.assertFalse(invitations.Invitations.config(invitation=True)['canSend'])

    def test_existing_general_switch_is_backward_compatible(self):
        with mail_environment(ERP_ENABLE_EMAIL='1'):
            del os.environ['ERP_ENABLE_INVITE_EMAIL']
            self.assertTrue(invitations.Invitations.config(invitation=True)['canSend'])


if __name__ == '__main__':
    unittest.main()
