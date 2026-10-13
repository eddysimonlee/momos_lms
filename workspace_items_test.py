"""Isolated collaboration fixtures; no production accounts, data or outbound jobs."""
import copy
import http.client
import json
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
import access
import onboarding
import projects
import server
import workspace_items as items


class ItemTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.store=server.Store(Path(self.tmp.name)/'data',self.tmp.name)
        self.http=server.make_server(self.store,0)
        self.auth=self.http.access
        self.admin=self.auth.create(dict(name='고성운',email='admin@example.test',password='TestOnly-934!A'),setup=True)
        self.editor=self.add('교육자')
        self.learner=self.add('교육생')
        self.viewer=self.add('열람자')
        self.other=self.add('비참여 관리자')
        self.rooms=self.http.rooms
        self.room=self.rooms.create(self.admin,dict(title='격리 일반 프로젝트'))
        self.pi=self.rooms.create(self.admin,dict(title='격리 PI',kind='pi'))
        for room in (self.room,self.pi):
            for user,role in ((self.editor,'editor'),(self.viewer,'viewer')):
                c=self.rooms.get(self.admin,room['id'])
                self.rooms.configure(self.admin,room['id'],dict(action='member',revision=c['directoryRevision'],userId=user['id'],role=role))
        self.rooms.update(self.admin,self.room['id'],dict(action='task.create',revision=0,task=dict(title='일반 업무')))
        self.rooms.update(self.admin,self.pi['id'],dict(action='pi.save',revision=0,case=dict(title='개선 과제')))
        self.edu=onboarding.Service(self.store)
        ctx=self.edu.get(self.admin)
        self.edu.update(self.admin,dict(action='config.enrol',target=self.admin['id'],revision=ctx['learner']['revision'],rootRevision=ctx['rootRevision'],requestId=str(uuid.uuid4()),
                          data=dict(learner=self.learner['id'],trainer=self.editor['id'],assessor=self.editor['id'],join=onboarding.today())))
        self.store.put_state(dict(schemaVersion=2,settings={},tasks=[dict(id='shared',title='공유 업무',visibility='공유',owner=self.editor['name'],status='진행 중'),
                                                                dict(id='private',title='관리 전용',visibility='내부',status='진행 중')],wbs=[],people=[]),0)
        self.service=items.Service(self.store)
        self.targets=[
            dict(room='erp',kind='task',id='shared',person=''),
            dict(room=self.room['id'],kind='task',id=self.rooms.get(self.admin,self.room['id'])['tasks'][0]['id'],person=''),
            dict(room=self.pi['id'],kind='case',id=self.rooms.get(self.admin,self.pi['id'])['piCases'][0]['id'],person=''),
            dict(room='onboarding',kind='step',id=next(iter(onboarding.STEPS)),person=self.learner['id']),
            dict(room='onboarding',kind='test',id=onboarding.COURSE['tests'][0]['id'],person=self.learner['id'])
        ]
    def add(self,name):
        u=self.auth.create(dict(name=name,email=uuid.uuid4().hex+'@example.test',password='TestOnly-934!B'))
        with self.store.connect() as db:db.execute("UPDATE access_users SET status='active' WHERE id=?",(u['id'],))
        return dict(u,status='active')
    def tearDown(self):
        self.http.server_close()
        self.tmp.cleanup()
    def payload(self,u,target,action='comment',text='질문·피드백',**extra):
        c=self.service.context(u,target)
        return dict(target=target,action=action,revision=c['revision'],requestId=str(uuid.uuid4()),text=text,**extra)
    def apply(self,u,value):
        return self.service.context(u,value['target'],value)
    def snapshot(self):
        with self.store.connect() as db:
            return [(r['id'],r['body']) for r in db.execute('SELECT * FROM metadata WHERE id!=? ORDER BY id',(items.ROOT,))],self.store.get_state()
    def test_all_scopes_comment_block_resolve_preserve_operational_state(self):
        before=self.snapshot()
        for target in self.targets:
            p=self.payload(self.editor,target)
            c=self.apply(self.editor,p)
            self.assertEqual(c['comments'][0]['text'],'질문·피드백')
            blocked=self.apply(self.editor,self.payload(self.editor,target,'block','자료 확인 필요',resolver=self.editor['id']))
            self.assertEqual(blocked['blocker']['resolver'],self.editor['id'])
            summary=self.service.summary(self.editor,target['room'],target['person'])
            self.assertIn(target,[r['target'] for r in summary['items']])
            done=self.apply(self.editor,self.payload(self.editor,target,'resolve','원본 확인 완료'))
            self.assertIsNone(done['blocker'])
            self.assertEqual([h['action'] for h in done['history']],['comment','block','resolve'])
            self.assertEqual(self.service.summary(self.editor,target['room'],target['person'])['items'],[])
        self.assertEqual(before,self.snapshot())
    def test_validation_correction_idempotency_and_conflict(self):
        for target in self.targets:
            p=self.payload(self.editor,target,text='')
            with self.assertRaises(ValueError):self.apply(self.editor,p)
            p['text']='바로잡은 내용'
            self.apply(self.editor,p)
            self.apply(self.editor,p)
            self.assertEqual(len(self.service.context(self.editor,target)['comments']),1)
            bad=dict(p,text='다른 내용')
            with self.assertRaises(projects.Conflict):self.apply(self.editor,bad)
            stale=self.payload(self.editor,target,text='초안 보존')
            self.apply(self.editor,self.payload(self.editor,target,text='다른 참여자 기록'))
            with self.assertRaises(projects.Conflict):self.apply(self.editor,stale)
            stale.update(revision=self.service.context(self.editor,target)['revision'],requestId=str(uuid.uuid4()))
            self.apply(self.editor,stale)
            self.assertEqual(len(self.service.context(self.editor,target)['comments']),3)
    def test_scope_revocation_and_resolver_permissions(self):
        for target in self.targets[1:3]:
            self.assertFalse(self.service.context(self.viewer,target)['canWrite'])
            with self.assertRaises(PermissionError):self.apply(self.viewer,self.payload(self.viewer,target))
            with self.assertRaises(FileNotFoundError):self.service.context(self.other,target)
            with self.assertRaises(ValueError):self.apply(self.editor,self.payload(self.editor,target,'block','확인',resolver=self.other['id']))
        private=dict(room='erp',kind='task',id='private',person='')
        with self.assertRaises(FileNotFoundError):self.service.context(self.editor,private)
        with self.assertRaises(PermissionError):self.service.context(self.viewer,self.targets[3])
        self.apply(self.learner,self.payload(self.learner,self.targets[3]))
        with self.store.connect() as db:
            db.execute("UPDATE access_users SET status='revoked' WHERE id=?",(self.editor['id'],))
        for target in self.targets:
            with self.assertRaises(access.LoginRequired):self.service.context(self.editor,target)
    def test_get_is_readonly_and_preview_cannot_write(self):
        before=self.snapshot()
        with self.store.connect() as db:self.assertIsNone(projects.Rooms.read(db,items.ROOT))
        for t in self.targets:self.service.context(self.editor,t)
        preview=dict(self.targets[3],person=self.admin['id'])
        self.assertFalse(self.service.context(self.admin,preview)['canWrite'])
        with self.assertRaises(PermissionError):self.apply(self.admin,self.payload(self.admin,preview))
        with self.store.connect() as db:self.assertIsNone(projects.Rooms.read(db,items.ROOT))
        self.assertEqual(before,self.snapshot())
    def test_membership_revocation_hides_old_summary_and_comment(self):
        target=self.targets[1]
        self.apply(self.editor,self.payload(self.editor,target,'block','자료 대기',resolver=self.editor['id']))
        c=self.rooms.get(self.admin,self.room['id'])
        self.rooms.configure(self.admin,self.room['id'],dict(action='member',revision=c['directoryRevision'],userId=self.editor['id'],role='remove'))
        with self.assertRaises(FileNotFoundError):self.service.context(self.editor,target)
        with self.assertRaises(FileNotFoundError):self.service.summary(self.editor,target['room'])
    def test_http_csrf_401_validation_replay_and_409(self):
        thread=threading.Thread(target=self.http.serve_forever,daemon=True);thread.start()
        session,cookie=self.auth.new_session(self.editor)
        target=self.targets[1];payload=self.payload(self.editor,target,text='')
        def send(value,auth=True,csrf=True):
            conn=http.client.HTTPConnection('127.0.0.1',self.http.server_port)
            headers={'Content-Type':'application/json','Origin':'http://127.0.0.1:'+str(self.http.server_port)}
            if auth:headers['Cookie']='erp_session='+cookie
            if csrf:headers['X-CSRF-Token']=session['csrfToken']
            conn.request('POST','/api/item-collaboration',json.dumps(value),headers)
            response=conn.getresponse();body=json.loads(response.read());conn.close();return response.status,body
        try:
            self.assertEqual(send(payload,auth=False)[0],401)
            self.assertEqual(send(payload,csrf=False)[0],403)
            self.assertEqual(send(payload)[0],400)
            payload['text']='수정 후 저장'
            self.assertEqual(send(payload)[0],200)
            self.assertEqual(send(payload)[0],200)
            payload.update(text='다음 기록',requestId=str(uuid.uuid4()))
            self.assertEqual(send(payload)[0],409)
            payload['revision']=1
            self.assertEqual(send(payload)[0],200)
            self.assertEqual(len(self.service.context(self.editor,target)['comments']),2)
        finally:self.http.shutdown();thread.join()

if __name__=='__main__':unittest.main()
