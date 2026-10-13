"""Account routes the LMS keeps, exercised over HTTP with isolated fixtures only."""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

import server

PASSWORD = 'TestOnlyPassword1!'


class AccountRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = server.Store(Path(self.tmp.name) / 'data')
        self.httpd = server.make_server(self.store, 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.auth = self.httpd.access
        self.admin = self.auth.create(dict(name='고성운', email='admin@example.test', password=PASSWORD), setup=True)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def req(self, method, path, value=None, cookie=None, csrf=None, origin=True):
        headers = {}
        if origin:
            headers['Origin'] = 'http://127.0.0.1:%d' % self.httpd.server_port
        if cookie:
            headers['Cookie'] = 'erp_session=' + cookie
        if csrf:
            headers['X-CSRF-Token'] = csrf
        body = None
        if value is not None:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(value).encode()
        conn = http.client.HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=10)
        try:
            conn.request(method, path, body, headers)
            r = conn.getresponse()
            raw = r.read()
            return r.status, dict(r.getheaders()), json.loads(raw) if raw and r.getheader('Content-Type', '').startswith('application/json') else raw
        finally:
            conn.close()

    def login(self, email, password=PASSWORD):
        code, headers, body = self.req('POST', '/api/auth/login', dict(email=email, password=password))
        self.assertEqual(code, 200)
        cookie = headers['Set-Cookie'].split(';')[0].split('=', 1)[1]
        return cookie, body['csrfToken']

    def test_health_and_static_are_public_but_apis_are_not(self):
        code, _, body = self.req('GET', '/api/health')
        self.assertEqual((code, body['application']), (200, 'momos-lms'))
        self.assertEqual(self.req('GET', '/styles.css')[0], 200)
        self.assertEqual(self.req('GET', '/api/auth/users')[0], 401)
        self.assertEqual(self.req('GET', '/server.py')[0], 404)

    def test_login_logout_and_wrong_password(self):
        self.assertEqual(self.req('POST', '/api/auth/login', dict(email='admin@example.test', password='wrong'))[0], 401)
        cookie, csrf = self.login('admin@example.test')
        code, _, body = self.req('GET', '/api/auth/status', cookie=cookie)
        self.assertEqual((code, body['user']['name']), (200, '고성운'))
        self.assertEqual(self.req('POST', '/api/auth/logout', {}, cookie=cookie)[0], 403)
        code, headers, _ = self.req('POST', '/api/auth/logout', {}, cookie=cookie, csrf=csrf)
        self.assertEqual(code, 200)
        self.assertIn('Max-Age=0', headers['Set-Cookie'])
        self.assertIsNone(self.req('GET', '/api/auth/status', cookie=cookie)[2]['user'])

    def test_signup_waits_for_admin_approval(self):
        code, _, body = self.req('POST', '/api/auth/signup', dict(name='신규 직원', email='new@example.test', password=PASSWORD, company='momos'))
        self.assertEqual((code, body['status']), (201, 'pending'))
        self.assertEqual(self.req('POST', '/api/auth/signup', dict(name='권한 지정', email='x@example.test', password=PASSWORD, role='admin'))[0], 403)
        self.assertEqual(self.req('POST', '/api/auth/login', dict(email='new@example.test', password=PASSWORD))[0], 401)
        cookie, csrf = self.login('admin@example.test')
        code, _, body = self.req('GET', '/api/auth/users', cookie=cookie)
        self.assertEqual(code, 200)
        pending = next(u for u in body['users'] if u['email'] == 'new@example.test')
        self.assertEqual(pending['status'], 'pending')
        code, _, _ = self.req('POST', '/api/auth/users/' + pending['id'], dict(status='active', role='member'), cookie=cookie, csrf=csrf)
        self.assertEqual(code, 200)
        self.login('new@example.test')

    def test_member_cannot_list_users_or_issue_reset_links(self):
        member = self.auth.create(dict(name='일반 직원', email='member@example.test', password=PASSWORD, company='momos'))
        self.auth.update_user(self.admin, member['id'], dict(status='active', role='member'))
        cookie, csrf = self.login('member@example.test')
        self.assertEqual(self.req('GET', '/api/auth/users', cookie=cookie)[0], 403)
        self.assertEqual(self.req('POST', '/api/auth/reset-link', dict(email='admin@example.test', identityConfirmed=True), cookie=cookie, csrf=csrf)[0], 403)

    def test_invitation_link_creates_active_account_once(self):
        cookie, csrf = self.login('admin@example.test')
        code, _, body = self.req('POST', '/api/auth/invitations', dict(name='초대 직원', email='invite@example.test', company='momos', role='member', sendEmail=False), cookie=cookie, csrf=csrf)
        self.assertEqual(code, 201)
        token = body['link'].split('#invite=')[1]
        accept = dict(token=token, email='invite@example.test', password=PASSWORD)
        code, _, body = self.req('POST', '/api/auth/accept-invite', accept)
        self.assertEqual(code, 201)
        self.assertEqual(self.req('POST', '/api/auth/accept-invite', accept)[0], 400)
        self.login('invite@example.test')

    def test_cross_origin_mutation_is_refused(self):
        self.assertEqual(self.req('POST', '/api/auth/login', dict(email='admin@example.test', password=PASSWORD), origin=False)[0], 403)


if __name__ == '__main__':
    unittest.main()
