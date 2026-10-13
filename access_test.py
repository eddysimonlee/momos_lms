"""Authorization regression tests use only temporary SQLite files and loopback HTTP."""
import copy
import http.client
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import access
import server


def fixture_state():
    def task(ident, visibility='공유', owner='박희준'):
        return dict(id=ident, kind='task', title=ident, owner=owner, owners=[], due='2026-09-20', start='2026-09-01',
                    status='진행 중', active=True, managed=True, completionCriteria='결과 파일 확인', parent='',
                    wbsLinkApproved=False, sourceRefs=['SECRET'], evidenceIds=['E1'], visibility=visibility,
                    note='private note', replies=[{'actor':'고성운','text':'private reply'}], reviews=[], completionHistory=[])
    return dict(schemaVersion=2, revision=0, tasks=[task('OWN'), task('OTHER',owner='한창룡'),task('PRIVATE','외부 비공개')],
                wbs=[],people=[{'name':'박희준','role':'admin','confirmed':True,'active':True},
                               {'name':'고성운','role':'admin','confirmed':True,'active':True}],
                sources=[{'id':'SECRET','path':'passwords.txt','text':'secret'}], evidence=[{'id':'E1','quote':'private'}],
                requirements=[{'id':'REQ','text':'internal'}], weeks=[], issues=[],requests=[],integrations=[],
                events=[],imports=[],files=[],dailyPlans=[],settings={},sourceIdMap={},meetings=[],publications=[])


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = server.Store(Path(self.temp.name)/'data', self.temp.name)
        self.httpd = server.make_server(self.store, 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.admin = self.httpd.access.create({'name':'고성운','email':'admin@example.test','password':'testing-password-123A1!'},setup=True)
        self.admin_session, self.admin_token = self.httpd.access.new_session(self.admin)
        self.member = self.httpd.access.create({'name':'박희준','email':'member@example.test','password':'testing-password-123A1!','company':'viewcs'})
        self.member = self.httpd.access.update_user(self.admin,self.member['id'],{'status':'active','role':'member'})
        self.member_session, self.member_token = self.httpd.access.new_session(self.member)
        self.store.put_state(fixture_state(), 0)

    def test_workspace_admin_rejects_non_admin_and_anonymous(self):
        for identity, expected in [(None, 401), (self.m, 403)]:
            status, body, _ = self.request('GET', '/api/auth/workspace-admin', identity=identity)
            self.assertEqual(status, expected, body)
            self.assertNotIn('users', body)
            self.assertNotIn('audit', body)
        private = self.httpd.rooms.create(self.member, dict(title='개인 프로젝트'))
        status, body, _ = self.request('GET', '/api/auth/workspace-admin', identity=self.m)
        self.assertEqual(status, 403, body)  # Project owner is not a workspace admin.

    def test_workspace_admin_hides_private_rooms_and_secrets_without_mutations(self):
        import vendor_inbox, meeting_intake
        hidden = self.httpd.rooms.create(self.member, dict(title='숨겨진 개인 프로젝트'))
        with self.store.connect() as db:
            for key, fmt in [(vendor_inbox.SYNC_KEY, vendor_inbox.SYNC_FORMAT), (meeting_intake.SYNC_KEY, meeting_intake.SYNC_FORMAT)]:
                self.httpd.rooms.write(db,key,dict(format=fmt,tokenHash='do-not-expose-token',userId=self.admin['id'],expiresAt='2099-01-01T00:00:00+00:00',revokedAt='',lastSuccessAt='2026-09-17T00:00:00+00:00'))
            db.execute("UPDATE access_audit SET detail=? WHERE kind='account.update'", (json.dumps(dict(status='active',role='member',company='viewcs',secret='do-not-expose-audit')),))
            before = [tuple(r) for r in db.execute('SELECT id,body FROM metadata ORDER BY id')]
        status, body, _ = self.request('GET', '/api/auth/workspace-admin', identity=self.a)
        self.assertEqual(status,200,body)
        self.assertNotIn(hidden['id'],[p['id'] for p in body['projects']])
        self.assertTrue(body['audit'])
        self.assertEqual(body['connections']['erpSync']['mail']['lastSuccessAt'],'2026-09-17T00:00:00+00:00')
        raw=json.dumps(body)
        for secret in ['tokenHash','do-not-expose-token','password_hash','salt','csrfToken','do-not-expose-audit','숨겨진 개인 프로젝트']:
            self.assertNotIn(secret,raw)
        with self.store.connect() as db:
            self.assertEqual(before,[tuple(r) for r in db.execute('SELECT id,body FROM metadata ORDER BY id')])

    def test_workspace_admin_without_erp_membership_retains_account_management_only(self):
        second=self.httpd.access.create(dict(name='최상민',email='second@example.test',password='testing-password-123A1!'))
        second=self.httpd.access.update_user(self.admin,second['id'],dict(role='admin',status='active'))
        self.httpd.rooms.create(self.admin,dict(title='관리자 자신의 프로젝트'))
        with self.store.connect() as db:
            directory=self.httpd.rooms.directory(db)
            erp=next(r for r in directory['rooms'] if r['id']=='erp')
            erp['members']={second['id']:'owner'}
            self.httpd.rooms.write(db,2,directory)
        status,body,_=self.request('GET','/api/auth/workspace-admin',identity=self.a)
        self.assertEqual(status,200,body)
        self.assertTrue(body['users'])
        self.assertNotIn('erpSync',body['connections'])
        self.assertNotIn('erp',[p['id'] for p in body['projects']])
        status,_,_=self.request('GET','/api/state',identity=self.a)
        self.assertEqual(status,404)

    def test_inline_schedule_is_internal_pm_only_and_atomic(self):
        state = self.store.get_state()
        action = dict(type='schedule.set', taskId='OWN', patch={'start':'2026-09-18','due':'2026-09-21'}, expectedStart='2026-09-01', expectedDue='2026-09-20')
        for user in [dict(role='admin',company='viewcs',name='박희준'), dict(role='member',company='momos',name='고성운'), dict(role='viewer',company='momos',name='최상민')]:
            with self.assertRaises(PermissionError):
                access.authorize_action(state['state'],user,action,self.httpd.access)
        invalid = copy.deepcopy(action)
        invalid['patch']['due'] = '2026-09-01'
        status, body, _ = self.request('POST','/api/actions',dict(action=invalid,revision=1),self.a)
        self.assertEqual(status,400,body)
        self.assertEqual(self.store.get_state(),state)
        status, body, _ = self.request('POST','/api/actions',dict(action=action,revision=1),self.a)
        self.assertEqual(status,200,body)
        saved=self.store.get_state()['state']
        self.assertEqual(saved['tasks'][0]['due'],'2026-09-21')
        self.assertEqual(saved['requests'][-1]['directEdit'],True)

    def test_completion_can_assign_two_people_in_one_save_and_reject_partial_changes(self):
        state = fixture_state()
        state['tasks'][0].update(owner='', owners=[])
        self.store.put_state(state, 1)
        before = self.store.get_state()
        action = dict(type='task.complete', taskId='OWN', actualCompletedOn='2026-09-07', summary='격리 검증 결과',
                      assignment=dict(owner='', owners=['고성운', '박희준'], reason=''))
        invalid = copy.deepcopy(action)
        invalid['assignment']['owners'] = ['없는 사용자']
        status, body, _ = self.request('POST', '/api/actions', dict(action=invalid, revision=2), self.a)
        self.assertEqual(status, 400, body)
        self.assertEqual(self.store.get_state(), before)
        status, body, _ = self.request('POST', '/api/actions', dict(action=action, revision=2), self.a)
        self.assertEqual(status, 200, body)
        saved = self.store.get_state()
        task = saved['state']['tasks'][0]
        self.assertEqual(saved['revision'], 3)
        self.assertEqual(task['owners'], ['고성운', '박희준'])
        self.assertEqual(task['status'], '완료')
        self.assertEqual(len(task['assignmentHistory']), 1)
        self.assertEqual(len(task['completionHistory']), 1)
        self.assertEqual(task['completedBy'], '고성운')

    def test_completion_assignment_preserves_member_wbs_and_internal_company_rules(self):
        state = fixture_state()
        state['tasks'][0].update(owner='', owners=[])
        self.store.put_state(state, 1)
        action = dict(type='task.complete', taskId='OWN', actualCompletedOn='2026-09-07', summary='검증',
                      assignment=dict(owner='박희준', reason='완료 시 지정'))
        before = self.store.get_state()
        self.assertEqual(self.request('POST', '/api/actions', dict(action=action, revision=2), self.m)[0], 403)
        self.assertEqual(self.store.get_state(), before)
        state['people'][0]['org'] = '뷰시에스'
        state['people'][1]['org'] = '모모스커피'
        state['tasks'][0]['internalOnly'] = True
        with self.assertRaises(PermissionError):
            access.authorize_action(state, self.admin, action, self.httpd.access)
        state['tasks'][0]['internalOnly'] = False
        state['wbs'] = [state['tasks'].pop(0)]
        lead = dict(self.member, role='lead')
        with self.assertRaises(PermissionError):
            access.authorize_action(state, lead, action, self.httpd.access)
        access.authorize_action(state, self.admin, action, self.httpd.access)

    def test_completion_assignment_cannot_override_owner_or_extra_fields(self):
        state = fixture_state()
        action = dict(type='task.complete', taskId='OWN', assignment=dict(owner='고성운', reason='변경'))
        with self.assertRaises(ValueError):
            access.authorize_action(state, self.admin, action, self.httpd.access)
        state['tasks'][0].update(owner='', owners=[])
        for assignment in [None, [], dict(owner='고성운', due='2026-09-30'), dict(owners='고성운')]:
            with self.assertRaises(ValueError):
                access.authorize_action(state, self.admin, dict(action, assignment=assignment), self.httpd.access)

    def test_material_application_is_admin_only_and_keeps_version_evidence(self):
        state=fixture_state()
        state['materials']=[dict(id='M-TEST',title='검토자료',name='test.txt',sha256='v1',text='추가 시험을 검토한다.',versions=[],relatedTaskIds=[])]
        self.store.put_state(state,1)
        action=dict(type='material.apply',materialId='M-TEST',sha256='v1',quote='추가 시험을 검토한다.',note='결과 확인',mode='reply',taskId='OWN')
        before=self.store.get_state()
        self.assertEqual(self.request('POST','/api/actions',dict(action=action,revision=2),self.m)[0],403)
        self.assertEqual(self.store.get_state(),before)
        status,body,_=self.request('POST','/api/actions',dict(action=action,revision=2),self.a)
        self.assertEqual(status,200,body)
        after=self.store.get_state()['state']
        self.assertEqual(after['materials'][0]['applications'][0]['actor'],'고성운')
        self.assertEqual(after['tasks'][0]['provenance'][-1]['sha256'],'v1')
        self.assertEqual(after['tasks'][0]['due'],state['tasks'][0]['due'])
        visible=access.filter_state(after,self.member)
        self.assertEqual(visible.get('materials',[]),[])
        self.assertNotIn('추가 시험을 검토한다.',json.dumps(visible,ensure_ascii=False))

    def test_member_receives_confirmed_holiday_range_without_private_settings(self):
        state=fixture_state()
        state['settings']=dict(projectStart='2026-08-24',holidayCalendarVerifiedFrom='2026-08-24',holidayCalendarVerifiedThrough='2027-02-28',holidayDates=['2026-09-24'],holidaySources=[dict(title='확인한 공휴일 자료',url='https://example.test/calendar')],privateSecret='hidden')
        visible=access.filter_state(state,self.member)
        self.assertEqual(visible['settings']['holidayCalendarVerifiedFrom'],'2026-08-24')
        self.assertEqual(visible['settings']['holidaySources'],state['settings']['holidaySources'])
        self.assertNotIn('privateSecret',visible['settings'])

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, value=None, identity=None, csrf=True, origin=True, raw=False):
        port = self.httpd.server_port
        headers = {'Host':f'127.0.0.1:{port}'}
        if origin:
            headers['Origin'] = f'http://127.0.0.1:{port}'
        if identity:
            session, token = identity
            headers['Cookie'] = access.COOKIE+'='+token
            if csrf:
                headers['X-CSRF-Token'] = session['csrfToken']
        payload = None
        if value is not None:
            headers['Content-Type'] = 'application/octet-stream' if raw else 'application/json'
            payload = value if raw else json.dumps(value).encode()
        connection = http.client.HTTPConnection('127.0.0.1',port,timeout=20)
        connection.request(method,path,payload,headers)
        response = connection.getresponse()
        body = response.read()
        response_headers = dict(response.getheaders())
        connection.close()
        try:
            body = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            pass
        return response.status, body, response_headers

    @property
    def a(self): return self.admin_session, self.admin_token
    @property
    def m(self): return self.member_session, self.member_token

    def test_unauthenticated_assets_and_private_routes(self):
        for path in ('/api/state','/api/sources','/api/review/status','/api/files/'+'a'*32,'/seed.js','/seed.json'):
            self.assertEqual(self.request('GET',path)[0],401,path)
        self.assertEqual(self.request('GET','/api/health')[0],200)
        self.assertEqual(self.request('GET','/')[0],200)

    def test_signup_pending_password_and_cookie(self):
        status, _, _ = self.request('POST','/api/auth/signup',{'name':'한창룡','email':'new@example.test','password':'strong-new-passwordA1!','company':'viewcs','role':'admin'})
        self.assertEqual(status,403)
        status, body, headers = self.request('POST','/api/auth/signup',{'name':'한창룡','email':'new@example.test','password':'strong-new-passwordA1!','company':'viewcs'})
        self.assertEqual(status,201,body)
        self.assertEqual(body['status'],'pending')
        self.assertNotIn('Set-Cookie',headers)
        self.assertEqual(self.request('GET','/api/state')[0],401)
        self.assertEqual(self.request('POST','/api/auth/login',{'email':'new@example.test','password':'strong-new-passwordA1!'})[0],401)
        new = next(u for u in self.httpd.access.users() if u['name']=='한창룡')
        self.assertEqual(new['role'],'member')
        self.assertEqual(new['status'],'pending')
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM access_users WHERE id=?',(new['id'],)).fetchone()
            self.assertNotEqual(row['password_hash'],'strong-new-passwordA1!')
            self.assertEqual(len(row['salt']),32)
        self.assertEqual(self.request('POST','/api/auth/users/'+new['id'],{'status':'active'},self.m)[0],403)
        self.assertEqual(self.request('POST','/api/auth/users/'+new['id'],{'status':'active'},self.a)[0],200)
        self.assertEqual(self.request('POST','/api/auth/login',{'email':'new@example.test','password':'strong-new-passwordA1!'})[0],200)
        status, body, headers = self.request('POST','/api/auth/login',{'email':'admin@example.test','password':'testing-password-123A1!'})
        self.assertEqual(status,200)
        self.assertIn('HttpOnly',headers['Set-Cookie'])
        self.assertIn('SameSite=Strict',headers['Set-Cookie'])
        self.assertNotIn('password',json.dumps(body))


    def test_signup_email_is_atomic_admin_only_and_keeps_pending_account(self):
        auth=self.httpd.access;mail=self.httpd.task_mail
        second=auth.create(dict(name='최상민',email='second@example.test',password='Testing-signup-123A!'))
        auth.update_user(self.admin,second['id'],dict(role='admin',company='momos',status='active'))
        value=dict(name='가입검증',email='signup@example.test',password='Testing-signup-123A!',company='viewcs',department='<img src=x>')
        self.assertEqual(self.request('POST','/api/auth/signup',value)[0],201)
        with self.store.connect() as db:
            jobs=db.execute("SELECT * FROM task_mail_outbox WHERE request_id LIKE 'signup:%'").fetchall()
        self.assertEqual(len(jobs),2)
        self.assertEqual({r['recipient_id'] for r in jobs},{self.admin['id'],second['id']})
        self.assertNotIn(value['password'],str([dict(r) for r in jobs]))
        self.assertEqual(self.request('GET','/api/auth/users',identity=self.m)[0],403)
        with patch.dict(os.environ,{'ERP_CLOUD_MODE':'1','ERP_ENABLE_EMAIL':'0','ERP_ENABLE_SIGNUP_EMAIL':'1','ERP_SMTP_HOST':'smtp.example.test','ERP_SMTP_FROM':'noreply@example.test','ERP_WORKSPACE_URL':'https://workspace.example.test'}),patch.object(mail,'send_message') as send:
            self.assertTrue(mail.signup_config()['canSend']);self.assertFalse(mail.config()['canSend'])
            self.assertFalse(mail.dispatch_one())
            self.assertTrue(mail.dispatch_signup_one());self.assertTrue(mail.dispatch_signup_one());self.assertFalse(mail.dispatch_signup_one())
            self.assertEqual(send.call_count,2)
            payload=send.call_args.args[0];self.assertIn('?admin=signups#overview',payload['html']);self.assertIn('&lt;img src=x&gt;',payload['html'])
        self.assertEqual(next(u for u in auth.users() if u['name']=='가입검증')['status'],'pending')
        self.assertEqual(self.request('POST','/api/auth/signup',value)[0],400)
        self.assertEqual(len(mail.signup_status()['items']),2)

    def test_signup_mail_unconfigured_processed_or_uncertain_never_retries(self):
        auth=self.httpd.access;mail=self.httpd.task_mail
        applicant=auth.create(dict(name='알림검증',email='notice@example.test',password='Testing-signup-123A!'),on_signup=mail.enqueue_signup)
        with patch.dict(os.environ,{'ERP_ENABLE_SIGNUP_EMAIL':'0'}),patch.object(mail,'send_message') as send:
            self.assertFalse(mail.dispatch_signup_one());send.assert_not_called()
            self.assertEqual(mail.signup_status()['items'][0]['status'],'queued')
        env={'ERP_ENABLE_SIGNUP_EMAIL':'1','ERP_SMTP_HOST':'smtp.example.test','ERP_SMTP_FROM':'noreply@example.test','ERP_WORKSPACE_URL':'https://workspace.example.test'}
        with patch.dict(os.environ,env),patch.object(mail,'send_message',side_effect=TimeoutError) as send:
            self.assertTrue(mail.dispatch_signup_one());self.assertFalse(mail.dispatch_signup_one());self.assertEqual(send.call_count,1)
        self.assertEqual(mail.signup_status()['items'][0]['status'],'unknown')
        processed=auth.create(dict(name='승인검증',email='approved@example.test',password='Testing-signup-123A!'),on_signup=mail.enqueue_signup)
        auth.update_user(self.admin,processed['id'],dict(role='member',status='active'))
        with patch.dict(os.environ,env),patch.object(mail,'send_message') as send:
            self.assertTrue(mail.dispatch_signup_one());send.assert_not_called()
        self.assertEqual(mail.signup_status()['items'][0]['status'],'suppressed')

    def test_signup_and_outbox_roll_back_together(self):
        value=dict(name='원자성검증',email='rollback@example.test',password='Testing-signup-123A!')
        with patch.object(self.httpd.task_mail,'enqueue_signup',side_effect=ValueError('queue failed')):
            self.assertEqual(self.request('POST','/api/auth/signup',value)[0],400)
        self.assertFalse(any(u['name']==value['name'] for u in self.httpd.access.users()))
    def test_admin_named_signup_requires_explicit_approval(self):
        status, body, _ = self.request('POST','/api/auth/signup',{'name':'최상민','email':'second@example.test','password':'another-passwordA1!','company':'momos'})
        self.assertEqual(status,201,body)
        pending=next(u for u in self.httpd.access.users() if u['name']=='최상민')
        self.assertEqual((pending['role'],pending['status']),('member','pending'))
        self.assertEqual(self.request('POST','/api/auth/login',{'email':pending['email'],'password':'another-passwordA1!'})[0],401)
        self.assertEqual(self.request('POST','/api/auth/users/'+pending['id'],{'status':'active','role':'admin'},self.a)[0],200)
        self.assertEqual(self.httpd.access.login({'email':pending['email'],'password':'another-passwordA1!'})[0]['user']['role'],'admin')
        self.assertEqual(self.request('POST','/api/auth/users/'+self.member['id'],{'role':'admin','company':'momos'},self.a)[0],400)

    def test_rejected_application_stays_locked(self):
        account=self.httpd.access.create({'name':'거절시험','email':'reject@example.test','password':'another-passwordA1!'})
        self.assertEqual(self.request('POST','/api/auth/users/'+account['id'],{'status':'revoked'},self.a)[0],200)
        self.assertEqual(self.request('POST','/api/auth/login',{'email':account['email'],'password':'another-passwordA1!'})[0],401)

    def test_local_admin_recovery_single_use_and_preserves_data(self):
        before=self.store.get_state()
        token=self.httpd.access.issue_local_recovery(self.admin['email'])
        status, body, _=self.request('POST','/api/auth/recovery-info',{'token':token})
        self.assertEqual(status,200,body)
        self.assertEqual(body['account']['email'],self.admin['email'])
        self.assertNotIn('password',json.dumps(body))
        reset={'token':token,'email':self.admin['email'],'password':'new-admin-password-123A1!'}
        status, result, headers=self.request('POST','/api/auth/reset-password',reset)
        self.assertEqual(status,200,result)
        for field in ('id','name','email','company','role','status'):
            self.assertEqual(result['user'][field],self.admin[field])
        self.assertIn('HttpOnly',headers['Set-Cookie'])
        self.assertEqual(self.request('GET','/api/state',identity=self.a)[0],401)
        with self.assertRaises(access.LoginRequired):
            self.httpd.access.login({'email':self.admin['email'],'password':'testing-password-123A1!'})
        self.assertEqual(self.httpd.access.login(reset)[0]['user']['id'],self.admin['id'])
        self.assertEqual(self.request('POST','/api/auth/reset-password',reset)[0],400)
        self.assertEqual(before,self.store.get_state())
        with self.store.connect() as db:
            audit=' '.join(row['detail'] for row in db.execute('SELECT detail FROM access_audit'))
            self.assertNotIn(token,audit)
            self.assertNotIn(reset['password'],audit)

    def test_recovery_bound_identity_and_invalid_requests_do_not_consume(self):
        token=self.httpd.access.issue_local_recovery(self.admin['email'])
        base={'token':token,'email':self.admin['email'],'password':'new-admin-password-123A1!'}
        for patch_value in ({'email':self.member['email']},{'password':'short'},{'role':'admin'},{'token':'0'*64}):
            self.assertEqual(self.request('POST','/api/auth/reset-password',dict(base,**patch_value))[0],400)
        self.assertEqual(self.request('POST','/api/auth/reset-password',base,origin=False)[0],403)
        self.assertEqual(self.httpd.access.recovery_info(token)['email'],self.admin['email'])
        self.assertEqual(self.request('GET','/api/state',identity=self.a)[0],200)
        for email in (self.member['email'],'unknown@example.test'):
            with self.assertRaises(ValueError):self.httpd.access.issue_local_recovery(email)
        self.assertEqual(self.request('POST','/api/auth/issue-recovery',{'email':self.admin['email']})[0],401)

    def test_recovery_expiration_reissue_and_account_version(self):
        first=self.httpd.access.issue_local_recovery(self.admin['email'])
        token=self.httpd.access.issue_local_recovery(self.admin['email'])
        with self.assertRaises(ValueError):self.httpd.access.recovery_info(first)
        with self.store.connect() as db:db.execute('UPDATE access_recovery SET expires_at=0')
        with self.assertRaises(ValueError):self.httpd.access.recovery_info(token)
        token=self.httpd.access.issue_local_recovery(self.admin['email'])
        self.httpd.access.update_user(self.admin,self.admin['id'],{'role':'admin'})
        with self.assertRaises(ValueError):self.httpd.access.recovery_info(token)

    def test_setup_single_use_csrf_and_last_admin(self):
        self.assertEqual(self.request('POST','/api/auth/setup',{'name':'최상민','email':'second@example.test','password':'another-passwordA1!'})[0],403)
        self.assertEqual(self.request('POST','/api/auth/logout',{},self.a,csrf=False)[0],403)
        self.assertEqual(self.request('POST','/api/auth/logout',{},self.a,origin=False)[0],403)
        self.assertEqual(self.request('POST','/api/auth/users/'+self.admin['id'],{'status':'revoked'},self.a)[0],400)

    def test_password_complexity_enforced_without_consuming_recovery(self):
        token=self.httpd.access.issue_local_recovery(self.admin['email'])
        for password in ('lowercase123!','UppercaseOnly!','Uppercase12345','A1!short','가나다라마바사아123!'):
            with self.assertRaises(ValueError):access.validate_password(password)
            with self.assertRaises(ValueError):self.httpd.access.reset_password({'token':token,'email':self.admin['email'],'password':password})
        self.assertEqual(self.httpd.access.recovery_info(token)['email'],self.admin['email'])
        access.validate_password('WorkingPassword1!')
        self.assertEqual(self.request('POST','/api/auth/signup',{'name':'약한암호','email':'weak@example.test','password':'weak-password'})[0],400)
        invitation=self.httpd.invitations.create(self.admin,{'name':'초대시험','email':'invite@example.test'},'http://127.0.0.1')
        with self.assertRaises(ValueError):self.httpd.invitations.accept({'token':invitation['link'].split('#invite=')[1],'email':'invite@example.test','password':'weak-password'})

    def test_existing_password_can_still_login(self):
        with self.store.connect() as db:
            row=db.execute('SELECT salt FROM access_users WHERE id=?',(self.admin['id'],)).fetchone()
            db.execute('UPDATE access_users SET password_hash=? WHERE id=?',(access.password_hash('legacy-password',row['salt']),self.admin['id']))
        self.assertEqual(self.httpd.access.login({'email':self.admin['email'],'password':'legacy-password'})[0]['user']['id'],self.admin['id'])

    def test_forgot_password_does_not_reveal_or_change_account(self):
        with patch('invitations.Invitations.config',return_value={'canSend':False}):
            first=self.request('POST','/api/auth/forgot-password',{'email':self.member['email']})
            unknown=self.request('POST','/api/auth/forgot-password',{'email':'missing@example.test'})
        self.assertEqual(first[0],202)
        self.assertEqual(first[:2],unknown[:2])
        self.assertNotIn('token',json.dumps(first[1]))
        self.assertEqual(self.request('GET','/api/auth/reset-requests',identity=self.m)[0],403)
        self.assertEqual(self.request('GET','/api/auth/reset-requests',identity=self.a)[1]['items'][0]['user_id'],self.member['id'])
        self.assertEqual(self.request('POST','/api/auth/reset-link',{'email':self.member['email'],'identityConfirmed':True},self.m)[0],403)
        self.assertEqual(self.request('POST','/api/auth/reset-link',{'email':self.member['email']},self.a)[0],400)
        status,body,_=self.request('POST','/api/auth/reset-link',{'email':self.member['email'],'identityConfirmed':True},self.a)
        self.assertEqual(status,201,body)
        token=body['link'].split('#account-reset=')[1]
        self.httpd.access.reset_password({'token':token,'email':self.member['email'],'password':'NewMemberPassword1!'})
        self.assertEqual(self.httpd.access.login({'email':self.member['email'],'password':'NewMemberPassword1!'})[0]['user']['role'],'member')

    def test_forgot_password_email_uses_bound_account_only(self):
        with patch('invitations.Invitations.config',return_value={'canSend':True}),patch.dict('os.environ',{'ERP_INVITE_BASE_URL':'https://erp.example.test'}),patch('invitations.Invitations.send_password_reset') as send:
            response=self.request('POST','/api/auth/forgot-password',{'email':self.member['email']})
        self.assertEqual(response[0],202)
        self.assertEqual(send.call_args.args[0],self.member['email'])
        token=send.call_args.args[1].split('#account-reset=')[1]
        self.assertEqual(self.httpd.access.recovery_info(token)['email'],self.member['email'])
        self.assertNotIn(token,json.dumps(response[1]))

    def test_member_projection_has_no_private_provenance(self):
        status, value, _ = self.request('GET','/api/state',identity=self.m)
        self.assertEqual(status,200)
        self.assertEqual([t['id'] for t in value['state']['tasks']],['OWN'])
        text = json.dumps(value)
        for hidden in ('SECRET','private note','private reply','passwords.txt','PRIVATE','OTHER'):
            self.assertNotIn(hidden,text)
        self.assertEqual(next(p for p in value['state']['people'] if p['name']=='박희준')['role'],'member')
        for path in ('/api/sources','/api/review/status','/api/source-file?id=SECRET','/api/import/status','/seed.js'):
            self.assertEqual(self.request('GET',path,identity=self.m)[0],403,path)

    def test_wbs_progress_admin_save_member_readback_and_authorization(self):
        state = fixture_state()
        w = state['tasks'].pop(0)
        w.update(kind='wbs', id='WBS-PROGRESS')
        w['progressHistory']=[dict(before={'status':'미착수','percent':0},after={'status':'진행 중','percent':None},reason='PRIVATE_HISTORY',actor='고성운',at='2026-09-01T00:00:00Z')]
        state['wbs'] = [w]
        self.store.put_state(state, 1)
        action = dict(type='task.update', taskId=w['id'], patch=dict(progressPercent=45, reply='격리 검증: 대상 20개 중 9개 확인'))
        status, result, _ = self.request('POST','/api/actions',{'action':action,'revision':2},self.a)
        self.assertEqual(status,200,result)
        row=result['state']['wbs'][0]
        self.assertEqual(row['progressPercent'],45)
        self.assertEqual(row['progressHistory'][-1]['actor'],'고성운')
        self.assertEqual(row['progressHistory'][-1]['after']['percent'],45)
        revision=result['revision']
        status,result,_=self.request('GET','/api/state',identity=self.m)
        self.assertEqual(result['state']['wbs'][0]['progressPercent'],45)
        self.assertEqual(len(result['state']['wbs'][0]['progressHistory']),1)
        self.assertNotIn('PRIVATE_HISTORY',str(result))
        invalid=dict(type='task.update',taskId=w['id'],patch=dict(progressPercent=100,reply='완료 우회'))
        self.assertEqual(self.request('POST','/api/actions',{'action':invalid,'revision':revision},self.a)[0],400)
        invalid['patch']['progressPercent']=35
        invalid['patch']['due']='2026-09-21'  # Schedule authority remains admin-only.
        self.assertEqual(self.request('POST','/api/actions',{'action':invalid,'revision':revision},self.m)[0],403)
        invalid['taskId']='OTHER'
        self.assertEqual(self.request('POST','/api/actions',{'action':invalid,'revision':revision},self.m)[0],403)
        self.assertEqual(self.store.get_state()['revision'],revision)

    def test_assigned_wbs_lifecycle_blank_confirmation_actor_and_schedule_boundary(self):
        state=fixture_state()
        w=state['tasks'].pop(0)
        w.update(id='WBS-OWN',kind='wbs',progressPercent=20)
        state['wbs']=[w]
        self.store.put_state(state,1)
        change={'type':'task.complete','taskId':w['id'],'actualCompletedOn':'2026-09-08','summary':'','completedBy':'고성운'}
        self.assertEqual(self.request('POST','/api/actions',{'action':change,'revision':2},self.m)[0],400)
        change['confirmWithoutSummary']=True
        status,result,_=self.request('POST','/api/actions',{'action':change,'revision':2},self.m)
        self.assertEqual(status,200,result)
        self.assertEqual(result['state']['wbs'][0]['completedBy'],'박희준')
        self.assertTrue(result['state']['wbs'][0]['completionHistory'][0]['summaryOmitted'])
        self.assertEqual(self.request('GET','/api/state',identity=self.a)[1]['state']['wbs'][0]['progressPercent'],100)
        reopen={'type':'task.reopen','taskId':w['id'],'status':'진행 중','reason':'빠진 시험 확인'}
        status,result,_=self.request('POST','/api/actions',{'action':reopen,'revision':3},self.m)
        self.assertEqual(status,200,result)
        self.assertEqual(result['state']['wbs'][0]['status'],'진행 중')
        self.assertEqual(result['state']['wbs'][0]['completionHistory'][0]['reopenedBy'],'박희준')
        update={'type':'task.update','taskId':w['id'],'patch':{'progressPercent':30,'reply':'확인한 10개 중 3개'}}
        status,result,_=self.request('POST','/api/actions',{'action':update,'revision':4},self.m)
        self.assertEqual(status,200,result)
        for patch_value in ({'due':'2026-09-22'},{'owner':'고성운'},{'visibility':'내부'},{'title':'임의 변경'},{'importantReview':False}):
            update['patch']=patch_value
            self.assertEqual(self.request('POST','/api/actions',{'action':update,'revision':5},self.m)[0],403)
        reopen['taskId']='OTHER'
        self.assertEqual(self.request('POST','/api/actions',{'action':reopen,'revision':5},self.m)[0],403)

    def test_server_actor_member_action_cas_and_scope(self):
        action={'type':'task.update','taskId':'OWN','patch':{'reply':'진행 결과를 확인했습니다.'},'actor':'고성운'}
        status, body, _ = self.request('POST','/api/actions',{'action':action,'revision':1},self.m)
        self.assertEqual(status,200,body)
        stored=self.store.get_state()
        self.assertEqual(stored['state']['events'][0]['actor'],'박희준')
        self.assertEqual(stored['state']['tasks'][0]['replies'][-1]['visibility'],'공유')
        self.assertEqual(self.request('POST','/api/actions',{'action':action,'revision':1},self.m)[0],409)
        for action in ({'type':'task.update','taskId':'OTHER','patch':{'reply':'x'}},
                       {'type':'task.update','taskId':'PRIVATE','patch':{'reply':'x'}},
                       {'type':'person.add','name':'hacker','role':'admin'},
                       {'type':'task.update','taskId':'OWN','patch':{'visibility':'공유'}},
                       {'type':'source.link','taskId':'OWN','sourceId':'SECRET'}):
            self.assertEqual(self.request('POST','/api/actions',{'action':action,'revision':2},self.m)[0],403,action)
        self.assertEqual(self.request('PUT','/api/state',{'state':fixture_state(),'revision':2},self.m)[0],403)

    def test_file_upload_binding_and_guessed_download(self):
        status, uploaded, _ = self.request('POST','/api/files?name=result.txt&taskId=OWN',b'real result',self.m,raw=True)
        self.assertEqual(status,201)
        action={'type':'attachment.add','taskId':'OWN','file':uploaded}
        self.assertEqual(self.request('POST','/api/actions',{'action':action,'revision':1},self.m)[0],200)
        self.assertEqual(self.request('GET','/api/files/'+uploaded['id'],identity=self.m)[0],200)
        denied=self.store.upload('private.txt',b'internal')
        self.assertEqual(self.request('GET','/api/files/'+denied['id'],identity=self.m)[0],403)
        self.assertEqual(self.request('POST','/api/files?name=a.txt&taskId=OTHER',b'x',self.m,raw=True)[0],403)
        action={'type':'attachment.add','taskId':'OWN','file':denied}
        self.assertEqual(self.request('POST','/api/actions',{'action':action,'revision':2},self.m)[0],403)

    def test_member_detail_creation_and_reused_private_source_follow_authorized_link(self):
        create = dict(type='task.create', title='격리 세부 준비', parentTaskId='OWN', owner='박희준', owners=['박희준'],
                      start='2026-09-10', due='2026-09-15', completionCriteria='기존 자료 확인', active=True, managed=True, visibility='공유')
        status, body, _ = self.request('POST', '/api/actions', dict(action=create, revision=1), self.m)
        self.assertEqual(status, 200, body)
        child = next(t for t in body['state']['tasks'] if t['title'] == '격리 세부 준비')
        self.assertEqual(child['createdBy'], '박희준')
        self.assertEqual(child['hierarchyContext']['parentTitle'], 'OWN')
        self.assertEqual(child['sourceRefs'], [])
        status, uploaded, _ = self.request('POST', '/api/files?name=private-source.txt&taskId=PRIVATE', b'isolated original', self.a, raw=True)
        self.assertEqual(status, 201)
        status, body, _ = self.request('POST', '/api/actions', dict(action=dict(type='attachment.add', taskId='PRIVATE', file=uploaded), revision=2), self.a)
        self.assertEqual(status, 200, body)
        self.assertEqual(self.request('GET', '/api/files/' + uploaded['id'], identity=self.m)[0], 403)
        status, body, _ = self.request('POST', '/api/actions', dict(action=dict(type='attachment.link', taskId=child['id'], fileId=uploaded['id'], reason='기존 자료를 이 업무에 공유'), revision=3), self.a)
        self.assertEqual(status, 200, body)
        status, downloaded, _ = self.request('GET', '/api/files/' + uploaded['id'], identity=self.m, raw=True)
        self.assertEqual(status, 200)
        self.assertEqual(downloaded, b'isolated original')
        status, body, _ = self.request('GET', '/api/state', identity=self.m)
        self.assertEqual(status, 200)
        reused = next(f for f in body['state']['files'] if f['id'] == uploaded['id'])
        self.assertEqual(reused['taskId'], '')
        self.assertEqual(reused['linkedTaskIds'], [child['id']])
        self.assertNotIn('PRIVATE', json.dumps(reused))
        stored = self.store.get_state()['state']
        self.assertEqual(len(stored['files']), 1)
        self.assertEqual(stored['files'][0]['taskId'], 'PRIVATE')
        self.assertEqual(stored['tasks'][0]['due'], '2026-09-20')

    def test_partial_request_reply_reuses_readable_file_and_clarify_retains_history(self):
        status, uploaded, _ = self.request('POST', '/api/files?name=shared-source.txt&taskId=OWN', b'isolated shared result', self.a, raw=True)
        self.assertEqual(status, 201)
        status, body, _ = self.request('POST', '/api/actions', dict(action=dict(type='attachment.add', taskId='OWN', file=uploaded), revision=1), self.a)
        self.assertEqual(status, 200, body)
        request = dict(type='followup.create', title='격리 자료 준비 요청', recipientId=self.member['id'], kind='material',
                       message='필요한 파일 준비', responseDue='2026-09-30', commandId='detail-partial-test')
        status, body, _ = self.request('POST', '/api/actions', dict(action=request, revision=2), self.a)
        self.assertEqual(status, 200, body)
        request_id = body['state']['followups'][0]['id']
        respond = dict(type='followup.respond', requestId=request_id, text='확인한 부분 먼저 제출', fileIds=[uploaded['id']],
                       responseState='partial', nextExpectedOn='2026-10-01')
        status, body, _ = self.request('POST', '/api/actions', dict(action=respond, revision=3), self.m)
        self.assertEqual(status, 200, body)
        response = body['state']['followups'][0]
        self.assertEqual(response['status'], 'pending')
        self.assertEqual(response['readiness'], 'partial')
        self.assertEqual(response['nextExpectedOn'], '2026-10-01')
        source = self.store.get_state()['state']['files'][0]
        self.assertEqual(source['taskId'], 'OWN')
        self.assertIn(response['taskId'], source['linkedTaskIds'])
        clarify = dict(type='followup.clarify', requestId=request_id, text='나머지 열도 포함해 주세요', responseDue='2026-10-05')
        self.assertEqual(self.request('POST', '/api/actions', dict(action=clarify, revision=4), self.m)[0], 403)
        status, body, _ = self.request('POST', '/api/actions', dict(action=clarify, revision=4), self.a)
        self.assertEqual(status, 200, body)
        response = body['state']['followups'][0]
        self.assertEqual(response['status'], 'pending')
        self.assertEqual(len(response['responses']), 1)
        self.assertEqual(len(response['clarifications']), 1)
        self.assertEqual(response['responseDue'], '2026-10-05')
        self.assertEqual(response['nextExpectedOn'], '')
        self.assertTrue(any(n['title'] == '요청 내용이 보완되었습니다' for n in self.store.notifications()['items']))

    def test_reused_response_file_isolated_between_two_requests_for_same_private_task(self):
        other = self.httpd.access.create(dict(name='한창룡', email='other-request@example.test', password='testing-password-123A1!', company='viewcs'))
        other = self.httpd.access.update_user(self.admin, other['id'], dict(status='active', role='member'))
        other_identity = self.httpd.access.new_session(other)
        status, uploaded, _ = self.request('POST', '/api/files?name=reply-a.txt&taskId=OWN', b'only request A should receive this', self.a, raw=True)
        self.assertEqual(status, 201)
        status, body, _ = self.request('POST', '/api/actions', dict(action=dict(type='attachment.add', taskId='OWN', file=uploaded), revision=1), self.a)
        self.assertEqual(status, 200, body)
        for revision, recipient in ((2, self.member), (3, other)):
            request = dict(type='followup.create', taskId='PRIVATE', recipientId=recipient['id'], kind='material', message='각자 확인한 자료 제출',
                           responseDue='2026-09-30', commandId='isolated-request-'+recipient['id'])
            status, body, _ = self.request('POST', '/api/actions', dict(action=request, revision=revision), self.a)
            self.assertEqual(status, 200, body)
        requests = body['state']['followups']
        request_a = next(r for r in requests if r['recipientId'] == self.member['id'])
        request_b = next(r for r in requests if r['recipientId'] == other['id'])
        action = dict(type='followup.respond', requestId=request_a['id'], text='A 요청에만 제출', fileIds=[uploaded['id']], responseState='ready')
        status, body, _ = self.request('POST', '/api/actions', dict(action=action, revision=4), self.m)
        self.assertEqual(status, 200, body)
        self.assertEqual(self.request('GET', '/api/files/'+uploaded['id'], identity=self.m)[0], 200)
        self.assertEqual(self.request('GET', '/api/files/'+uploaded['id'], identity=other_identity)[0], 403)
        status, body, _ = self.request('GET', '/api/state', identity=other_identity)
        self.assertEqual(status, 200)
        self.assertIn('PRIVATE', {t['id'] for t in body['state']['tasks']})
        self.assertNotIn(uploaded['id'], {f['id'] for f in body['state']['files']})
        self.assertEqual({r['id'] for r in body['state']['followups']}, {request_b['id']})
        denied_reply = dict(type='followup.respond', requestId=request_b['id'], text='다른 요청 파일 추측', fileIds=[uploaded['id']])
        self.assertEqual(self.request('POST', '/api/actions', dict(action=denied_reply, revision=5), other_identity)[0], 403)
        self.assertEqual(self.store.get_state()['revision'], 5)

    def test_revocation_logout_and_viewer_cannot_write(self):
        self.assertEqual(self.request('POST','/api/auth/users/'+self.member['id'],{'status':'revoked'},self.a)[0],200)
        self.assertEqual(self.request('GET','/api/state',identity=self.m)[0],401)
        member=self.httpd.access.update_user(self.admin,self.member['id'],{'status':'active','role':'viewer'})
        sess,token=self.httpd.access.new_session(member)
        self.assertEqual(self.request('POST','/api/actions',{'revision':1,'action':{'type':'task.update','taskId':'OWN','patch':{'reply':'x'}}},(sess,token))[0],403)
        self.assertEqual(self.request('POST','/api/auth/logout',{},(sess,token))[0],200)
        self.assertEqual(self.request('GET','/api/state',identity=(sess,token))[0],401)

    def test_identity_rate_limit(self):
        for _ in range(8):
            self.httpd.access.rate('fixture')
        with self.assertRaises(access.RateLimited):
            self.httpd.access.rate('fixture')

    def test_lead_scope_and_no_cross_company_assignment(self):
        lead = dict(self.member, name='김현태', role='lead')
        state = fixture_state()
        state['people'] += [{'name':'김현태','role':'lead','org':'뷰시에스','confirmed':True,'active':True}]
        state['people'][0]['org'] = '뷰시에스'
        state['people'][1]['org'] = '모모스커피'
        state['tasks'][1]['owner'] = '고성운'
        access.authorize_action(state,lead,{'type':'task.update','taskId':'OWN','patch':{'reply':'x'}},self.httpd.access)
        for change in ({'type':'task.update','taskId':'OTHER','patch':{'reply':'x'}},
                       {'type':'task.update','taskId':'PRIVATE','patch':{'reply':'x'}},
                       {'type':'task.update','taskId':'OWN','patch':{'owner':'고성운'}}):
            with self.assertRaises(PermissionError):
                access.authorize_action(state,lead,change,self.httpd.access)

    def test_lead_can_request_other_company_without_reassigning_the_task(self):
        lead=dict(self.member,role='lead')
        state=fixture_state();state['people'][0].update(org='뷰시에스',role='lead')
        roster=self.httpd.task_mail.options(state,lead,'OWN')['recipients']
        self.assertIn(self.admin['id'],{p['id'] for p in roster})
        request={'type':'followup.create','taskId':'OWN','recipientId':self.admin['id'],'kind':'material','message':'자료 확인 요청','responseDue':'2026-09-10'}
        original=copy.deepcopy(state['tasks'][0])
        access.authorize_action(state,lead,request,self.httpd.access)
        self.assertEqual(request['recipientName'],'고성운');self.assertEqual(state['tasks'][0],original)
        with self.assertRaisesRegex(ValueError,'다른 회사'):
            access.authorize_action(state,lead,dict(request,assignTask=True),self.httpd.access)
        with self.assertRaises(PermissionError):
            access.authorize_action(state,lead,dict(request,shareTask=True),self.httpd.access)

    def test_member_standalone_request_roundtrip_and_boundaries(self):
        before=copy.deepcopy(self.store.get_state()['state'])
        self.assertEqual(self.request('GET','/api/followup-mail/options',identity=self.m)[0],200)
        action=dict(type='followup.create',title='격리 요청: 샘플 제공',recipientId=self.admin['id'],kind='material',message='SKU와 금액 열이 있는 샘플 파일',responseDue='2026-09-30',commandId='standalone-1',sendEmail=False)
        for key in ('title','message','responseDue'):
            invalid=dict(action);invalid[key]=''
            self.assertEqual(self.request('POST','/api/actions',dict(action=invalid,revision=1),self.m)[0],400,key)
        status,result,_=self.request('POST','/api/actions',dict(action=action,revision=1),self.m)
        self.assertEqual(status,200,result)
        saved=self.store.get_state()['state'];request=saved['followups'][0]
        self.assertTrue(request['standalone']);self.assertEqual(request['requestedBy'],'박희준')
        self.assertEqual(saved['wbs'],before['wbs']);self.assertEqual(saved['tasks'][:3],before['tasks'])
        self.assertFalse(saved['tasks'][-1]['active']);self.assertFalse(saved['tasks'][-1]['managed'])
        self.assertNotIn('private note',json.dumps(result,ensure_ascii=False))
        self.assertEqual(self.request('POST','/api/actions',dict(action=action,revision=2),self.m)[0],400)
        answer=dict(type='followup.respond',requestId=request['id'],text='요청 자료 확인 및 전달 준비',fileIds=[])
        self.assertEqual(self.request('POST','/api/actions',dict(action=answer,revision=2),self.m)[0],403)
        self.assertEqual(self.request('POST','/api/actions',dict(action=answer,revision=2),self.a)[0],200)
        close=dict(type='followup.resolve',requestId=request['id'],reason='요청한 내용을 받았습니다')
        self.assertEqual(self.request('POST','/api/actions',dict(action=close,revision=3),self.m)[0],200)
        self.assertEqual(self.store.get_state()['state']['followups'][0]['status'],'resolved')
        notices=self.store.notifications()['items']
        self.assertTrue(any(n['recipients']==['고성운'] and request['taskId'] in n['taskIds'] for n in notices))
        self.assertTrue(any(n['recipients']==['박희준'] and request['taskId'] in n['taskIds'] for n in notices))
        with self.store.connect() as db:self.assertEqual(db.execute("SELECT COUNT(*) FROM task_mail_outbox WHERE status!='preview'").fetchone()[0],0)

    def test_member_requests_do_not_grant_assignment_or_private_scope(self):
        action=dict(type='followup.create',taskId='OWN',recipientId=self.admin['id'],kind='work',message='매핑 확인 요청',responseDue='2026-09-30',commandId='linked-1')
        for patch in ({'assignTask':True},{'shareTask':True},{'taskId':'PRIVATE'},{'taskId':'OTHER'},{'taskId':'MISSING'}):
            status,body,_=self.request('POST','/api/actions',dict(action=dict(action,**patch),revision=1),self.m)
            self.assertEqual(status,403,(patch,body))
        status,result,_=self.request('POST','/api/actions',dict(action=action,revision=1),self.m)
        self.assertEqual(status,200,result)
        request=result['state']['followups'][0]
        self.assertFalse(request['standalone'])
        self.assertEqual(self.store.get_state()['state']['tasks'][0]['owner'],'박희준')

    def test_completion_notifies_pms_once_without_approval(self):
        action=dict(type='task.complete',taskId='OWN',actualCompletedOn='2026-09-08',summary='',confirmWithoutSummary=True)
        status,result,_=self.request('POST','/api/actions',dict(action=action,revision=1),self.m)
        self.assertEqual(status,200,result)
        item=next(t for t in result['state']['tasks'] if t['id']=='OWN')
        self.assertEqual(item['status'],'완료');self.assertEqual(item['completedBy'],'박희준');self.assertEqual(item['reviews'],[])
        notices=[n for n in self.store.notifications()['items'] if n['title'].startswith('완료 보고')]
        self.assertEqual(len(notices),1);self.assertEqual(notices[0]['recipients'],['고성운','최상민'])
        self.assertFalse(any(n['title'].startswith('완료 보고') for n in self.request('GET','/api/notifications',identity=self.m)[1]['items']))
        self.store.put_state(self.store.get_state()['state'],2)
        self.assertEqual(len([n for n in self.store.notifications()['items'] if n['title'].startswith('완료 보고')]),1)

    def test_request_polling_reveals_only_own_version_not_other_request_content(self):
        state=fixture_state()
        state['followups']=[{'id':'own-request','taskId':'OWN','recipientId':self.member['id'],'requestedById':self.admin['id'],'status':'pending','updatedAt':'2026-09-08T05:00:00Z','message':'own message','responses':[]},
                            {'id':'other-request','taskId':'OWN','recipientId':self.admin['id'],'requestedById':self.admin['id'],'status':'responded','updatedAt':'2026-09-08T05:01:00Z','message':'private other message','responses':[{'text':'private reply'}]}]
        self.store.put_state(state,1)
        status,body,_=self.request('GET','/api/followup-mail/status',identity=self.m)
        self.assertEqual(status,200);self.assertEqual(body['requests'],[{'id':'own-request','status':'pending','updatedAt':'2026-09-08T05:00:00Z','responseCount':0}])
        self.assertNotIn('private',json.dumps(body));self.assertNotIn('own message',json.dumps(body))
        state['followups'][0].update(status='responded',updatedAt='2026-09-08T05:02:00Z',responses=[{'text':'reply'}])
        self.store.put_state(state,2)
        status,body,_=self.request('GET','/api/followup-mail/status',identity=self.m)
        self.assertEqual(status,200);self.assertEqual(body['requests'][0]['responseCount'],1)
        self.assertEqual(body['requests'][0]['status'],'responded')

    def test_completion_is_shared_without_legacy_evidence(self):
        action={'type':'task.complete','taskId':'OWN','actualCompletedOn':'2026-09-08','summary':'파일 발급 여부와 보관 위치를 확인했습니다.'}
        status, body, _ = self.request('POST','/api/actions',{'revision':1,'action':action},self.m)
        self.assertEqual(status,200,body)
        item = body['state']['tasks'][0]
        self.assertEqual(item['completedBy'],'박희준')
        self.assertEqual(item['completionHistory'][0]['summary'],action['summary'])
        self.assertEqual(item['sourceRefs'],[])
        self.assertNotIn('SECRET',json.dumps(body))

    def test_revocation_during_action_does_not_commit(self):
        run = server.subprocess.run
        def revoke_then_run(*args, **kwargs):
            self.httpd.access.update_user(self.admin,self.member['id'],{'status':'revoked'})
            return run(*args, **kwargs)
        with patch.object(server.subprocess,'run',side_effect=revoke_then_run):
            status, _, _ = self.request('POST','/api/actions',{'revision':1,'action':{'type':'task.update','taskId':'OWN','patch':{'reply':'x'}}},self.m)
        self.assertEqual(status,401)
        self.assertEqual(self.store.get_state()['revision'],1)

    def test_registered_private_file_cannot_be_downloaded_by_owner(self):
        _, file, _ = self.request('POST','/api/files?name=private.txt&taskId=OWN',b'private payload',self.m,raw=True)
        state = self.store.get_state()['state']
        state['files'].append(dict(file, taskId='OWN', visibility='내부'))
        self.store.put_state(state,1)
        self.assertEqual(self.request('GET','/api/files/'+file['id'],identity=self.m)[0],403)
        self.assertEqual(self.request('GET','/api/files/'+file['id'],identity=self.a)[0],200)

    def test_week_projection_keeps_current_plan_and_strips_private_history(self):
        state=fixture_state()
        state['wbs']=[dict(id='WBS',kind='wbs',visibility='공유',sourceStart='2026-08-24',sourceDue='2026-09-02',start='',due='')]
        def snapshot(ident):
            return dict(taskId=ident,id=ident,title=ident,sourceRefs=['SECRET'],note='SECRET NOTE')
        state['weeks']=[dict(weekOf='2026-09-07',status='확정',note='PRIVATE WEEK',draft=[snapshot('OWN'),snapshot('PRIVATE')],
                            baseline=[snapshot('OWN')],amendments=[dict(revision=1,at='now',reason='SECRET CHANGE',snapshot=[snapshot('OWN'),snapshot('OTHER')],changes={'added':['OWN','OTHER']})])]
        clean=access.filter_state(state,self.member)
        week=clean['weeks'][0]
        self.assertEqual(week['status'],'확정')
        self.assertEqual([t['taskId'] for t in week['draft']],['OWN'])
        self.assertEqual([t['taskId'] for t in week['amendments'][0]['snapshot']],['OWN'])
        self.assertEqual(clean['wbs'][0]['sourceDue'],'2026-09-02')
        self.assertEqual(clean['wbs'][0]['due'],'')
        for secret in ('SECRET','PRIVATE WEEK','OTHER','PRIVATE'):
            self.assertNotIn(secret,json.dumps(clean))

    def test_issue_owner_lifecycle_shared_visibility_and_foreign_denials(self):
        status, result, _=self.request('POST','/api/actions',{'revision':1,'action':{'type':'issue.create','taskId':'OWN','title':'답변 대기','description':'필요한 답변','note':'확인 부탁드립니다.'}},self.m)
        self.assertEqual(status,200,result)
        issue=result['state']['issues'][0]
        self.assertEqual(issue['owner'],'박희준')
        self.assertEqual(issue['replies'][0]['text'],'확인 부탁드립니다.')
        for action in ({'type':'issue.update','issueId':issue['id'],'patch':{'owner':'고성운'}},
                       {'type':'issue.update','issueId':issue['id'],'patch':{'taskId':'OTHER'}},
                       {'type':'issue.create','taskId':'PRIVATE','title':'x'},
                       {'type':'issue.create','taskId':'OTHER','title':'x'},
                       {'type':'issue.create','taskId':'OWN','title':'x','owner':'고성운'}):
            self.assertEqual(self.request('POST','/api/actions',{'revision':2,'action':action},self.m)[0],403)
        revision=2
        for action in ({'type':'issue.update','issueId':issue['id'],'patch':{'reply':'확인 중'}},
                       {'type':'issue.resolve','issueId':issue['id'],'resolution':'필요한 답변 확인'},
                       {'type':'issue.reopen','issueId':issue['id'],'reason':'추가 확인 필요'}):
            status,result,_=self.request('POST','/api/actions',{'revision':revision,'action':action},self.m)
            self.assertEqual(status,200,result)
            revision+=1
        self.assertEqual(result['state']['issues'][0]['status'],'미결')
        state=self.store.get_state()['state']
        state['issues'][0]['visibility']='내부'
        self.store.put_state(state,revision)
        self.assertEqual(self.request('GET','/api/state',identity=self.m)[1]['state']['issues'],[])
        self.assertEqual(self.request('POST','/api/actions',{'revision':revision+1,'action':{'type':'issue.resolve','issueId':issue['id'],'resolution':'x'}},self.m)[0],403)

    def test_shared_integration_updates_redact_historical_provenance(self):
        state=self.store.get_state()['state']
        state['integrations']=[dict(id='API-1',title='실제 연동',channel='채널',dataType='주문',owner='박희준',taskId='OWN',parent='',visibility='공유',
                                   stage='미착수',readiness='미확인',requirements=[],sourceRefs=['SECRET'],testEvidence=['SECRET'],note='PRIVATE API NOTE',testResult='PRIVATE RESULT')]
        self.store.put_state(state,1)
        clean=self.request('GET','/api/state',identity=self.m)[1]['state']
        self.assertEqual(clean['integrations'][0]['note'],'')
        self.assertNotIn('PRIVATE API',json.dumps(clean))
        action={'type':'integration.update','integrationId':'API-1','patch':{'note':'담당자가 확인한 업데이트','testResult':'접속 확인'}}
        status,result,_=self.request('POST','/api/actions',{'revision':2,'action':action},self.m)
        self.assertEqual(status,200,result)
        self.assertEqual(result['state']['integrations'][0]['note'],'담당자가 확인한 업데이트')
        self.assertEqual(result['state']['integrations'][0]['sourceRefs'],[])
        for field,value in (('taskId','OTHER'),('owner','고성운'),('sourceRefs',['SECRET']),('requirements',[{'title':'x','sourceRefs':['SECRET']}])):
            self.assertEqual(self.request('POST','/api/actions',{'revision':3,'action':{'type':'integration.update','integrationId':'API-1','patch':{field:value}}},self.m)[0],403)

    def test_notification_recipient_scope_read_actor_and_private_ids(self):
        own='a'*32
        foreign='b'*32
        with self.store.connect() as db:
            for ident,recipients,tasks in ((own,['박희준','고성운'],['OWN','PRIVATE','OTHER']),
                                          (foreign,['고성운'],['OWN'])):
                db.execute('INSERT INTO notifications VALUES(?,?,?,?,?,?,?,?,?)',(ident,'2026-09-08','09:00',json.dumps(recipients),
                           '오늘 할 일·미결 확인',json.dumps(tasks),'[]','now',json.dumps(['고성운'])))
        status,body,_=self.request('GET','/api/notifications',identity=self.m)
        self.assertEqual(status,200)
        self.assertEqual(len(body['items']),1)
        self.assertEqual(body['items'][0]['taskIds'],['OWN'])
        self.assertEqual(body['items'][0]['recipients'],['박희준'])
        self.assertEqual(body['items'][0]['readBy'],[])
        self.assertNotIn('PRIVATE',json.dumps(body))
        status,body,_=self.request('POST','/api/notifications/'+own+'/read',{'actor':'고성운'},self.m)
        self.assertEqual(status,200)
        self.assertEqual(body['readBy'],['박희준'])
        self.assertEqual(self.request('POST','/api/notifications/'+foreign+'/read',{},self.m)[0],403)

    def test_approved_account_enters_assignment_roster_before_first_action(self):
        new=self.httpd.access.create({'name':'새담당자','email':'new-member@example.test','password':'testing-password-123A1!','company':'momos'})
        self.httpd.access.update_user(self.admin,new['id'],{'status':'active','role':'member'})
        before=self.store.get_state()
        status,response,_=self.request('GET','/api/state',identity=self.a)
        self.assertEqual(status,200)
        person=next(p for p in response['state']['people'] if p['name']=='새담당자')
        self.assertEqual(person['role'],'member')
        self.assertTrue(person['active'])
        self.assertEqual(self.store.get_state(),before)


class DetailAccessTests(unittest.TestCase):
    """Permission and filtered-context checks need no HTTP server or real accounts."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = server.Store(Path(self.temp.name) / 'data', self.temp.name)
        self.auth = access.Access(self.store)
        self.member = dict(id='member-test', name='박희준', role='member', company='viewcs')
        self.admin = dict(id='admin-test', name='고성운', role='admin', company='momos')
        self.state = fixture_state()

    def tearDown(self):
        self.temp.cleanup()

    def file(self, task_id, owner_id='admin-test', visibility='공유'):
        value = self.store.upload('격리 검증 자료.txt', b'isolated reusable source')
        with self.store.connect() as db:
            db.execute('INSERT INTO file_access VALUES(?,?,?)', (value['id'], owner_id, task_id))
        value.update(taskId=task_id, addedBy='고성운', visibility=visibility, sourceRefs=['PRIVATE-SOURCE'])
        self.state['files'].append(value)
        return value

    def authorize(self, action, user=None):
        return access.authorize_action(self.state, user or self.member, action, self.auth)

    def test_title_context_survives_hidden_parent_without_granting_parent_access(self):
        parent = self.state['tasks'][1]
        parent['parent'] = 'WBS'
        child = self.state['tasks'][0]
        child.update(parentTaskId=parent['id'], createdBy='박희준')
        self.state['wbs'] = [dict(id='WBS', kind='wbs', title='공유 WBS 제목', visibility='공유')]
        clean = access.filter_state(self.state, self.member)
        visible = next(t for t in clean['tasks'] if t['id'] == child['id'])
        self.assertEqual(visible['parentTaskId'], '')
        self.assertEqual(visible['hierarchyContext'], dict(parentTaskId='OTHER', parentTitle='OTHER', wbsId='WBS', wbsTitle='공유 WBS 제목'))
        self.assertEqual(visible['createdBy'], '박희준')
        self.assertNotIn('OTHER', {t['id'] for t in clean['tasks']})
        self.assertEqual(visible['sourceRefs'], [])
        parent.update(visibility='내부', title='비공개 부모 내용')
        self.state['wbs'][0].update(visibility='내부', title='비공개 WBS 내용')
        clean = access.filter_state(self.state, self.member)
        context = clean['tasks'][0]['hierarchyContext']
        self.assertEqual(context['parentTitle'], '비공개 상위 업무')
        self.assertEqual(context['wbsTitle'], '비공개 WBS')
        self.assertNotIn('비공개 부모 내용', json.dumps(clean, ensure_ascii=False))
        self.assertNotIn('비공개 WBS 내용', json.dumps(clean, ensure_ascii=False))

    def test_member_creates_only_self_assigned_detail_beneath_assigned_shared_parent(self):
        valid = dict(type='task.create', title='준비 사항', parentTaskId='OWN', owner='박희준', owners=['박희준'], visibility='공유')
        self.authorize(valid)
        self.state['wbs'] = [dict(id='WBS', kind='wbs', owner='박희준', visibility='공유')]
        self.authorize(dict(valid, parentTaskId='', parent='WBS'))
        for change in ({'owner':'한창룡'}, {'owner':'','owners':[]}, {'parentTaskId':'OTHER'}, {'parentTaskId':'PRIVATE'},
                       {'parent':'WBS'}, {'sourceRefs':['SECRET']}, {'wbsLinkApproved':True}, {'visibility':'내부'}):
            with self.subTest(change=change), self.assertRaises(PermissionError):
                self.authorize(dict(valid, **change))
        self.state['tasks'][0]['parentTaskId'] = 'OTHER'
        with self.assertRaises(PermissionError):
            self.authorize(valid)

    def test_reuse_checks_current_download_permission_and_target_permission(self):
        shared = self.file('OWN')
        private = self.file('PRIVATE', visibility='내부')
        self.assertTrue(self.auth.file_allowed(self.member, shared['id'], self.state))
        self.authorize(dict(type='attachment.link', taskId='OWN', fileId=shared['id']))
        for task_id, file_id in [('OWN', private['id']), ('OTHER', shared['id']), ('OWN', 'missing')]:
            with self.subTest(task_id=task_id, file_id=file_id), self.assertRaises(PermissionError):
                self.authorize(dict(type='attachment.link', taskId=task_id, fileId=file_id))
        self.state['followups'] = [dict(id='R', taskId='PRIVATE', recipientId='member-test', requestedById='admin-test', status='pending')]
        self.authorize(dict(type='attachment.link', taskId='PRIVATE', fileId=shared['id']))
        self.state['followups'][0]['status'] = 'resolved'
        with self.assertRaises(PermissionError):
            self.authorize(dict(type='attachment.link', taskId='PRIVATE', fileId=shared['id']))

    def test_linked_file_download_does_not_disclose_original_private_context(self):
        value = self.file('PRIVATE', visibility='내부')
        value.update(linkedTaskIds=['OWN', 'OTHER'], linkHistory=[dict(taskId='PRIVATE', reason='private rationale')])
        self.assertTrue(self.auth.file_allowed(self.member, value['id'], self.state))
        files = access.filter_state(self.state, self.member)['files']
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]['taskId'], '')
        self.assertEqual(files[0]['linkedTaskIds'], ['OWN'])
        self.assertNotIn('PRIVATE', json.dumps(files))
        self.assertNotIn('OTHER', json.dumps(files))
        self.assertNotIn('sourceRefs', files[0])
        self.assertNotIn('linkHistory', files[0])
        value['linkedTaskIds'] = []
        self.assertFalse(self.auth.file_allowed(self.member, value['id'], self.state))
        self.assertEqual(access.filter_state(self.state, self.member)['files'], [])

    def test_request_only_original_and_linked_files_share_only_with_that_request(self):
        other = dict(id='other-test', name='한창룡', role='member', company='viewcs')
        linked = self.file('OWN')
        linked['linkedTaskIds'] = ['PRIVATE']
        original = self.file('PRIVATE')
        self.state['followups'] = [dict(id='A', taskId='PRIVATE', recipientId='member-test', requestedById='admin-test', status='responded',
                                       responses=[dict(fileIds=[linked['id'], original['id']])]),
                                  dict(id='B', taskId='PRIVATE', recipientId='other-test', requestedById='admin-test', status='pending', responses=[])]
        for file in (linked, original):
            with self.subTest(file_id=file['id']):
                self.assertTrue(self.auth.file_allowed(self.member, file['id'], self.state))
                self.assertFalse(self.auth.file_allowed(other, file['id'], self.state))
        self.assertEqual(access.filter_state(self.state, other)['files'], [])

    def test_response_reuses_readable_file_from_other_uploader_and_clarify_is_requester_only(self):
        shared = self.file('OWN')
        private = self.file('PRIVATE', visibility='내부')
        self.state['followups'] = [dict(id='R', taskId='OTHER', recipientId='member-test', requestedById='admin-test', status='pending')]
        self.authorize(dict(type='followup.respond', requestId='R', fileIds=[shared['id']], responseState='partial', nextExpectedOn='2026-09-15'))
        with self.assertRaises(PermissionError):
            self.authorize(dict(type='followup.respond', requestId='R', fileIds=[private['id']]))
        with self.assertRaises(PermissionError):
            self.authorize(dict(type='followup.clarify', requestId='R', text='범위 보완'))
        self.authorize(dict(type='followup.clarify', requestId='R', text='범위 보완'), self.admin)
        self.state['followups'][0].update(requestedById='member-test', recipientId='another-test')
        self.authorize(dict(type='followup.clarify', requestId='R', text='범위 보완'))


if __name__ == '__main__':
    unittest.main()
