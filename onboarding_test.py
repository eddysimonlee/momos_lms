"""Independent employee fixtures only; no production accounts, polls or network."""
import copy
import http.client
import json
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
import onboarding as ob
import server
import access
import lms_store as projects


class EducationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.store=server.Store(self.root/'data',self.root)
        self.auth=access.Access(self.store);self.service=ob.Service(self.store)
        self.admin=self.auth.create(dict(name='고성운',email='admin@example.test',password='TestOnlyPassword1!'),setup=True)
        self.learner=self.add('교육생');self.other=self.add('다른 직원');self.trainer=self.add('교육자');self.tech=self.add('기술 담당','viewcs');self.content=self.add('내용 담당')
        with self.store.connect() as db:
            projects.Rooms.write(db,1,{'format':'preserved-manifest'});projects.Rooms.write(db,2,{'format':'preserved-directory','rooms':[]})
        self.erp_before=self.erp_snapshot()
        self.enrol(self.learner)

    def tearDown(self):self.tmp.cleanup()

    def add(self,name,company='momos'):
        u=self.auth.create(dict(name=name,email=uuid.uuid4().hex+'@example.test',password='TestOnlyPassword1!',company=company))
        with self.store.connect() as db:db.execute("UPDATE access_users SET status='active' WHERE id=?",(u['id'],))
        return dict(u,status='active')

    def erp_snapshot(self):
        with self.store.connect() as db:
            return {t:[tuple(r) for r in db.execute('SELECT * FROM '+t).fetchall()] for t in ('files','access_users','access_sessions','access_audit')}|{'metadata':[(i,projects.Rooms.read(db,i)) for i in (1,2)]}

    def payload(self,user,action,data=None,target=None):
        c=self.service.get(user,target)
        return dict(action=action,data=data or {},target=c['target'],revision=c['learner']['revision'],rootRevision=c['rootRevision'],requestId=str(uuid.uuid4()))

    def act(self,user,action,data=None,target=None):return self.service.update(user,self.payload(user,action,data,target))

    def enrol(self,u):self.act(self.admin,'config.enrol',dict(learner=u['id'],trainer=self.trainer['id'],assessor=self.trainer['id'],join=ob.plus(ob.today(),-4)))

    def ready_review(self):
        ident=next(iter(ob.STEPS))
        for i in range(len(ob.STEPS[ident]['checks'])):self.act(self.learner,'step.self',dict(step=ident,index=i,on=True))
        self.act(self.learner,'step.request',dict(step=ident));return ident

    def test_assignment_is_not_actual_practice_and_unset_date_gates_start(self):
        ident=next(iter(ob.STEPS))
        data=dict(learner=self.learner['id'],trainer=self.trainer['id'],assessor=self.trainer['id'],join=ob.plus(ob.today(),-4),startDate=None)
        self.act(self.admin,'config.enrol',data)
        for start_date in (None,):
            data['startDate']=start_date
            self.act(self.admin,'config.enrol',data)
            c=self.service.get(self.learner)
            self.assertEqual(c['learner']['startDate'],start_date)
            self.assertTrue(all(r['status']=='ready' and not r['start'] and not r['done'] for r in c['learner']['records'].values()))
            with self.assertRaises(ValueError):self.act(self.learner,'step.start',dict(step=ident))
        data['startDate']=ob.today()
        self.act(self.admin,'config.enrol',data)
        with self.assertRaises(PermissionError):self.act(self.admin,'step.start',dict(step=ident),self.learner['id'])
        c=self.act(self.learner,'step.start',dict(step=ident))
        self.assertEqual(c['learner']['records'][ident]['status'],'practice')
        self.assertEqual(c['learner']['records'][ident]['start'],ob.today())
        self.assertFalse(c['learner']['records'][ident]['done'])
        data['assessor']=self.content['id']
        self.act(self.admin,'config.enrol',data)
        self.assertEqual(self.service.get(self.learner)['learner']['records'][ident]['start'],ob.today())
        self.assertEqual(self.erp_snapshot(),self.erp_before)

    def test_early_start_keeps_plan_and_allows_actual_checks_confirmation_and_position_logs(self):
        scheduled=ob.plus(ob.today(),3)
        self.act(self.admin,'config.enrol',dict(learner=self.learner['id'],trainer=self.trainer['id'],assessor=self.trainer['id'],join=ob.plus(ob.today(),-4),startDate=scheduled))
        before=self.service.get(self.learner)['learner']
        ident='position-making'
        with self.assertRaises(PermissionError):self.act(self.admin,'step.start',dict(step=ident),self.learner['id'])
        c=self.act(self.learner,'step.start',dict(step=ident))
        self.assertEqual(c['learner']['records'][ident]['start'],ob.today())
        self.assertEqual(c['learner']['startDate'],scheduled)
        self.assertEqual(c['learner']['planDates'],before['planDates'])
        self.assertEqual(c['assignments']['status'],'active')
        self.assertEqual(c['assignments']['next'],ident)
        self.assertTrue(c['assignments']['nextAvailable'])
        for i in range(len(ob.STEPS[ident]['checks'])):self.act(self.learner,'step.self',dict(step=ident,index=i,on=True))
        self.act(self.learner,'step.memo',dict(step=ident,memo='조기 교육 검증'))
        self.act(self.learner,'step.request',dict(step=ident))
        for i in range(len(ob.STEPS[ident]['checks'])):self.act(self.trainer,'step.teacher',dict(step=ident,index=i,on=True),self.learner['id'])
        c=self.act(self.trainer,'step.complete',dict(step=ident),self.learner['id'])
        self.assertEqual(c['learner']['records'][ident]['done'],ob.today())
        self.assertEqual(c['learner']['records'][ident]['status'],'done')
        self.assertEqual(c['learner']['startDate'],scheduled)
        self.assertEqual(c['learner']['planDates'],before['planDates'])
        self.act(self.learner,'practice.add',dict(step=ident,date=ob.today(),condition='격리 조건',observation='격리 관찰'))
        self.act(self.trainer,'test.record',dict(test='making',date=ob.today(),result='deferred',criteria='격리 기준',feedback='격리 피드백',confirmed=True),self.learner['id'])
        for bad_date in (ob.plus(ob.today(),-5),ob.plus(ob.today(),1)):
            with self.assertRaises(ValueError):self.act(self.learner,'practice.add',dict(step=ident,date=bad_date,condition='격리',observation='거절 확인'))
            with self.assertRaises(ValueError):self.act(self.trainer,'test.record',dict(test='making',date=bad_date,result='deferred',criteria='격리 기준',feedback='거절 확인',confirmed=True),self.learner['id'])
        self.assertEqual(self.erp_snapshot(),self.erp_before)

    def test_own_checks_teacher_confirmation_and_retries_are_separate(self):
        ident=self.ready_review()
        with self.assertRaises(PermissionError):self.act(self.learner,'step.teacher',dict(step=ident,index=0,on=True))
        with self.assertRaises(ValueError):self.act(self.trainer,'step.complete',dict(step=ident),self.learner['id'])
        for i in range(len(ob.STEPS[ident]['checks'])):self.act(self.trainer,'step.teacher',dict(step=ident,index=i,on=True),self.learner['id'])
        c=self.act(self.trainer,'step.complete',dict(step=ident),self.learner['id'])
        self.assertEqual(c['learner']['records'][ident]['status'],'done');self.assertEqual(c['learner']['records'][ident]['completedBy'],self.trainer['id'])
        c=self.act(self.learner,'step.retry',dict(step=ident,reason='다시 연습'))
        r=c['learner']['records'][ident];self.assertEqual(r['attempt'],2);self.assertEqual(r['history'][0]['status'],'done');self.assertFalse(any(r['self']))
        self.assertEqual(self.erp_snapshot(),self.erp_before)

    def test_cross_employee_admin_self_and_revoked_educator_are_blocked(self):
        with self.assertRaises(PermissionError):self.service.get(self.other,self.learner['id'])
        with self.assertRaises(PermissionError):self.act(self.admin,'step.teacher',dict(step=next(iter(ob.STEPS)),index=0,on=True),self.learner['id'])
        d=dict(learner=self.learner['id'],trainer=self.learner['id'],assessor=self.trainer['id'],join=ob.today())
        with self.assertRaises(ValueError):self.act(self.admin,'config.enrol',d)
        with self.store.connect() as db:db.execute("UPDATE access_users SET status='revoked' WHERE id=?",(self.trainer['id'],))
        with self.assertRaises(PermissionError):self.service.get(self.trainer,self.learner['id'])
        with self.assertRaises(PermissionError):self.service.get(self.tech)

    def test_revision_conflicts_duplicate_retry_and_invalid_payload_rollback(self):
        ident=next(iter(ob.STEPS));v=self.payload(self.learner,'step.self',dict(step=ident,index=0,on=True));stale=copy.deepcopy(v);stale['requestId']=str(uuid.uuid4())
        c=self.service.update(self.learner,v);rev=c['learner']['revision']
        self.assertEqual(self.service.update(self.learner,v)['learner']['revision'],rev)
        with self.assertRaises(projects.Conflict):self.service.update(self.learner,stale)
        v['data']['on']=False
        with self.assertRaises(ValueError):self.service.update(self.learner,v)
        for i in (-1,999,True):
            with self.assertRaises(ValueError):self.act(self.learner,'step.self',dict(step=ident,index=i,on=True))
        self.assertEqual(self.service.get(self.learner)['learner']['revision'],rev)

    def test_quiz_assignment_answers_hidden_randomized_saved_and_not_certification(self):
        self.enrol(self.other)
        c=self.act(self.learner,'quiz.assign');t=c['learner']['exam'];ids=[q['id'] for q in t['questions']]
        self.assertEqual([q['type'] for q in t['questions']],['choice','photo','match','order'])
        for q in t['questions']:
            self.assertNotIn('answer',q);self.assertNotIn('explain',q)
            for p in q.get('pairs',[]):self.assertNotIn('right',p)
        other=self.act(self.other,'quiz.assign')['learner']['exam']
        self.assertTrue(all(q['id']!=ids[i] for i,q in enumerate(other['questions'])))
        answers={}
        for q in t['questions']:
            canonical=ob.QUESTIONS[q['id']]
            answers[q['id']]=dict(order=q['display'][:],reason='품질 변화·동시 진행을 설명') if q['type']=='order' else [p['right'] for p in canonical['pairs']] if q['type']=='match' else canonical['answer']
        self.act(self.learner,'quiz.answers',dict(answers=answers))
        self.assertEqual(ob.Service(self.store).get(self.learner)['learner']['exam']['answers'],answers)
        c=self.act(self.learner,'quiz.submit',dict(answers=answers));t=c['learner']['exam']
        self.assertEqual(sum(x['status']=='correct' for x in t['results'].values()),3)
        q=next(q for q in t['questions'] if q['type']=='order')
        self.act(self.trainer,'quiz.grade',dict(question=q['id'],result='adequate',feedback='순서 근거 확인'),self.learner['id'])
        c=self.act(self.learner,'quiz.retry');self.assertEqual(len(c['learner']['examArchive']),1)
        self.assertTrue(all(not t['attempts'] for t in c['learner']['tests'].values()))
        self.assertEqual(self.erp_snapshot(),self.erp_before)

    def test_position_tests_and_plans_have_real_actor_and_daily_history(self):
        data=dict(test='espresso',date=ob.today(),result='pass',criteria='현장 평가 근거 문서',feedback='현장 확인',confirmed=True)
        with self.assertRaises(PermissionError):self.act(self.learner,'test.record',data)
        with self.assertRaises(ValueError):self.act(self.trainer,'test.record',dict(data,date=ob.plus(ob.today(),1)),self.learner['id'])
        with self.assertRaises(ValueError):self.act(self.trainer,'test.record',dict(data,confirmed=False),self.learner['id'])
        c=self.act(self.trainer,'test.record',data,self.learner['id']);a=c['learner']['tests']['espresso']['attempts'][0]
        self.assertEqual(a['assessorId'],self.trainer['id']);self.assertNotIn('demo',a)
        date=ob.plus(ob.today(),10);c=self.act(self.trainer,'plan.test',dict(test='espresso',date=date),self.learner['id'])
        self.assertEqual(c['learner']['planDates']['test-espresso']['start'],date)
        self.assertEqual(len(c['learner']['tests']['espresso']['planHistory']),1)
        self.assertEqual(self.erp_snapshot(),self.erp_before)

    def test_private_inquiries_are_visible_only_to_author_and_type_assignee(self):
        self.act(self.admin,'config.support',dict(technical=[self.tech['id']],content=[self.content['id']]))
        data=dict(type='technical',category=ob.CATEGORIES['technical'][0],title='저장 문제',body='체크할 때 오류',expected='저장',proposal='',step='',ref='')
        c=self.act(self.learner,'ticket.create',data);t=c['tickets'][0]
        for u in (self.other,self.trainer,self.content,self.admin):self.assertEqual(self.service.get(u)['tickets'],[])
        self.assertEqual(len(self.service.get(self.tech)['tickets']),1)
        with self.assertRaises(PermissionError):self.act(self.trainer,'ticket.reply',dict(ticket=t['id'],text='다른 직원 문의'))
        self.act(self.tech,'ticket.reply',dict(ticket=t['id'],text='기술 확인 답변'))
        c=self.act(self.tech,'ticket.status',dict(ticket=t['id'],operation='answer',reason='답변 기록'))
        self.assertEqual(c['tickets'][0]['status'],'answered')
        c=self.act(self.learner,'ticket.create',dict(data,type='content',category=ob.CATEGORIES['content'][0],title='내용 충돌',proposal='수정 제안'))
        t=c['tickets'][-1]
        self.act(self.content,'ticket.status',dict(ticket=t['id'],operation='work',reason='정본 대조'))
        self.act(self.content,'ticket.status',dict(ticket=t['id'],operation='approve',reason='매장 검토'))
        self.assertEqual(self.service.get(self.learner)['tickets'][-1]['decision']['status'],'정본 반영 미실행')
        self.assertEqual(self.erp_snapshot(),self.erp_before)

    def test_http_page_api_csrf_and_private_files(self):
        httpd=server.make_server(self.store,0);thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
        session,token=self.auth.new_session(self.learner)
        def req(method,path,value=None,cookie=True,csrf=True):
            headers={'Origin':f'http://127.0.0.1:{httpd.server_port}'}
            if cookie:headers['Cookie']='erp_session='+token
            if csrf:headers['X-CSRF-Token']=session['csrfToken']
            if value is not None:headers['Content-Type']='application/json'
            conn=http.client.HTTPConnection('127.0.0.1',httpd.server_port,timeout=10)
            try:
                conn.request(method,path,json.dumps(value).encode() if value is not None else None,headers)
                r=conn.getresponse();return r.status,dict(r.getheaders()),r.read()
            finally:conn.close()
        try:
            code,headers,body=req('GET','/onboarding',cookie=False)
            self.assertEqual(code,200);self.assertIn(b'authGate',body);self.assertNotIn(b'source-data',body)
            for cookie in (False,True):
                for suffix in ('','?view=timeline&target=test'):
                    code,h,b=req('GET','/onboarding/'+suffix,cookie=cookie)
                    self.assertEqual(code,302)
                    self.assertEqual(h['Location'],'/v1'+suffix)
                    self.assertEqual(h['Cache-Control'],'no-store')
                    self.assertEqual(b,b'');self.assertNotIn('Set-Cookie',h)
            self.assertEqual(req('POST','/onboarding/',{})[0],404)
            self.assertEqual(req('GET','/api/onboarding',cookie=False)[0],401)
            self.assertEqual(req('GET','/onboarding.js',cookie=False)[0],401)
            for path in ('/onboarding.py','/onboarding_course.json','/onboarding.html','/onboarding_login.html'):
                self.assertEqual(req('GET',path)[0],404,path)
            code,headers,body=req('GET','/onboarding');self.assertEqual(code,200);self.assertEqual(headers['Cache-Control'],'no-store');self.assertIn(b'source-data',body)
            data=self.payload(self.learner,'step.self',dict(step=next(iter(ob.STEPS)),index=0,on=True))
            self.assertEqual(req('POST','/api/onboarding',data,csrf=False)[0],403)
            self.assertEqual(req('POST','/api/onboarding',data)[0],200)
            self.assertEqual(req('GET','/api/onboarding')[0],200)
            code,h,b=req('GET','/',cookie=False);self.assertEqual(code,302);self.assertEqual(h['Location'],'/v1')
            # v1: the page and its script are public shells; the course slice needs a login.
            code,h,b=req('GET','/v1',cookie=False);self.assertEqual(code,200);self.assertIn(b'authGate',b);self.assertNotIn('출근 준비'.encode(),b)
            self.assertEqual(req('GET','/v1.js',cookie=False)[0],200)
            self.assertEqual(req('GET','/v1_content.json',cookie=False)[0],401)
            code,h,b=req('GET','/v1_content.json');self.assertEqual(code,200)
            slice_=json.loads(b);self.assertEqual([u['id'] for u in slice_['units']],['welcome'])
            self.assertEqual(sum(len(u['steps']) for u in slice_['units']),6)
            steps=[s for u in slice_['units'] for s in u['steps']]
            self.assertTrue(all(s['purpose'] and s['keyPoints'] and s['sources'] for s in steps))  # 교육 목적·교육 내용·원본 보기
            cited=set(c for s in steps for k in s['keyPoints'] for c in k['cites'])|set(c for s in steps for c in s['sources'])
            self.assertTrue(cited<=set(slice_['sections']));self.assertTrue(set(sec['doc'] for sec in slice_['sections'].values())<=set(slice_['documents']))
            self.assertNotIn('guides',slice_)  # 매뉴얼 전문은 더 이상 싣지 않는다
            self.assertEqual(req('GET','/v1_lessons.json')[0],404);self.assertEqual(req('GET','/source_index.json')[0],404)
            self.assertEqual(req('GET','/v1_build.py')[0],404)
            for removed in ('/api/state','/api/projects','/index.html','/app.js'):
                self.assertEqual(req('GET',removed)[0],404,removed)
        finally:httpd.shutdown();httpd.server_close();thread.join()

    def test_calendar_end_of_month_and_course_preservation(self):
        self.assertEqual(ob.month('2026-08-31',6),'2027-02-28')
        self.assertEqual(len(ob.STEPS),82);self.assertEqual(sum(len(s['checks']) for s in ob.STEPS.values()),270)  # 첫날 OJT 11→17 (FRM v0.5)
        before=self.erp_snapshot();self.service.get(self.learner)
        self.assertEqual(self.erp_snapshot(),before)


    def test_onboarding_access_override_enforced_and_history_preserved(self):
        before=self.service.get(self.learner)['learner']
        with self.assertRaises(PermissionError):
            self.act(self.learner,'config.access',dict(user=self.other['id'],allowed=False,reason='권한 없음'))
        self.act(self.admin,'config.access',dict(user=self.learner['id'],allowed=False,reason='교육 접근 보류'))
        with self.assertRaises(PermissionError):self.service.get(self.learner)
        with self.assertRaises(PermissionError):self.service.upload_asset(self.learner,dict(requestId=str(uuid.uuid4()),name='test.txt',contentBase64='dGVzdA=='))
        self.assertEqual(self.service.get(self.admin,self.learner['id'])['learner'],before)
        self.act(self.admin,'config.access',dict(user=self.learner['id'],allowed=True,reason='접근 재개'))
        self.assertEqual(self.service.get(self.learner)['learner'],before)
        with self.assertRaises(ValueError):self.act(self.admin,'config.access',dict(user=self.admin['id'],allowed=False,reason='관리자 차단'))
        self.assertEqual(self.erp_snapshot(),self.erp_before)

    def test_role_overview_uses_only_visible_learner_records(self):
        u=self.add('별도 교육생');trainer2=self.add('별도 교육자')
        self.act(self.admin,'config.enrol',dict(learner=u['id'],trainer=trainer2['id'],assessor=trainer2['id'],join=ob.today()))
        self.assertEqual({r['id'] for r in self.service.get(self.trainer)['educationSummary']},{self.learner['id']})
        self.assertEqual({r['id'] for r in self.service.get(self.learner)['educationSummary']},{self.learner['id']})
        c=self.service.get(self.admin)
        self.assertEqual(len(c['educationSummary']),2)
        self.assertFalse(c['workspaceRoles']['learner']);self.assertTrue(c['workspaceRoles']['admin'])
        self.assertTrue(self.service.get(self.trainer)['workspaceRoles']['trainer'])

    def test_system_review_guards_resolution_and_persists_images_and_history(self):
        review=ob.SYSTEM_REVIEWS[0]['id']
        learner_view=self.service.get(self.learner)
        self.assertEqual(learner_view['systemReviews'],[])
        self.assertEqual(len(learner_view['lessonReviewNotes']),3)
        for note in learner_view['lessonReviewNotes']:
            self.assertTrue(set(note.get('relatedSteps',[note['step']])).issubset(ob.STEPS))
            self.assertFalse({'image','comment','source','attachments','history','status'} & set(note))
        self.assertTrue(self.service.get(self.trainer)['reviewAccess'])
        d=dict(id=review,status='working',comment='매장 기준 확인 중',source='',attachments=[])
        with self.assertRaises(PermissionError):self.act(self.trainer,'system.review',d)
        with self.assertRaises(ValueError):self.act(self.admin,'system.review',dict(d,status='resolved'))
        self.act(self.admin,'config.support',dict(technical=[self.tech['id']],content=[self.content['id']]))
        with self.assertRaises(PermissionError):self.act(self.tech,'system.review',d)
        asset=self.service.upload_asset(self.content,dict(requestId=str(uuid.uuid4()),name='evidence.txt',contentBase64='dGVzdA=='))['asset']
        review_before=self.erp_snapshot()
        c=self.act(self.content,'system.review',dict(d,attachments=[asset['id']]))
        r=next(r for r in c['systemReviews'] if r['id']==review)
        self.assertEqual(r['status'],'working');self.assertEqual(len(r['history']),1)
        self.service.get_asset(self.trainer,asset['id'])
        with self.assertRaises(PermissionError):self.service.get_asset(self.learner,asset['id'])
        c=self.act(self.admin,'system.review',dict(d,status='resolved',source='W:/검증용 기준 v1 · 테스트',attachments=[asset['id']]))
        r=next(r for r in ob.Service(self.store).get(self.admin)['systemReviews'] if r['id']==review)
        self.assertEqual(len(r['history']),2);self.assertEqual(r['status'],'resolved')
        self.assertEqual(r['attachments'],[asset['id']])
        learner_view=self.service.get(self.learner)
        self.assertNotIn('W:/검증용 기준',json.dumps(learner_view['lessonReviewNotes'],ensure_ascii=False))
        self.assertEqual(learner_view['systemReviews'],[])
        self.assertIn(review,[n['id'] for n in learner_view['lessonReviewNotes']], '자료 확인만으로 교재 반영 완료가 되지 않음')
        with self.assertRaises(ValueError):self.act(self.admin,'system.review',dict(d,status='applied'))
        with self.assertRaises(PermissionError):self.act(self.trainer,'system.review',dict(d,status='applied',source='검증용 반영 판본'))
        c=self.act(self.content,'system.review',dict(d,status='applied',comment='격리 교재 반영 확인',source='검증용 교재 반영 v2',attachments=[asset['id']]))
        r=next(r for r in ob.Service(self.store).get(self.admin)['systemReviews'] if r['id']==review)
        self.assertEqual(r['status'],'applied');self.assertEqual(len(r['history']),3)
        self.assertEqual(r['history'][-1]['actor'],self.content['name'])
        self.assertTrue(r['history'][-1]['at']);self.assertEqual(r['attachments'],[asset['id']])
        learner_view=self.service.get(self.learner)
        self.assertNotIn(review,[n['id'] for n in learner_view['lessonReviewNotes']])
        self.assertEqual(learner_view['systemReviews'],[])
        c=self.act(self.admin,'system.review',dict(d,comment='재검토 사유 · 격리 시험',attachments=[asset['id']]))
        r=next(r for r in c['systemReviews'] if r['id']==review)
        self.assertEqual(r['status'],'working');self.assertEqual(len(r['history']),4)
        self.assertEqual(r['history'][-2]['status'],'applied')
        self.assertIn(review,[n['id'] for n in self.service.get(self.learner)['lessonReviewNotes']])
        self.assertEqual(self.erp_snapshot(),review_before)


if __name__=='__main__':unittest.main(verbosity=2)
