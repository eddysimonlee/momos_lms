"""Integration checks against a disposable PGlite socket on 127.0.0.1:55439 only.

PGlite uses one backend session, so SET LOCAL ROLE exercises erp_app privileges.
This does not prove production TLS, pooler authentication or concurrent load.
"""
from contextlib import contextmanager
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import psycopg
import cloud
import cloud_migrate
import server
import access_test
import wbs_exchange_test

DSN='postgresql://postgres@127.0.0.1:55439/postgres'


class TestDatabase(cloud.Database):
    def __init__(self):super().__init__(DSN,sslmode='disable')
    @contextmanager
    def connect(self,**kwargs):
        with super().connect(**kwargs) as db:
            db.raw.execute('SET LOCAL ROLE erp_app')
            yield db


class MemoryStorage(cloud.Storage):
    def __init__(self):
        super().__init__('https://example.supabase.co','test-secret','test-private')
        self.objects={}
    def request(self,method,path,data=None,**kwargs):
        if path.startswith('/bucket/'):return b'{"public":false}'
        if method=='POST':
            if path in self.objects:raise OSError('duplicate')
            self.objects[path]=data;return b'{}'
        if path not in self.objects:raise FileNotFoundError()
        return self.objects[path]


BaseStore=server.Store


class CloudTestStore(BaseStore):
    def __init__(self,data,root):
        with psycopg.connect(DSN,sslmode='disable') as db:
            db.execute('TRUNCATE '+','.join('erp_workspace.'+table for table in sorted(cloud.TABLES))+' RESTART IDENTITY')
            db.execute('INSERT INTO erp_workspace.state VALUES(1,NULL,0)')
            db.execute("INSERT INTO erp_workspace.cloud_meta VALUES('schema_version','1')")
        database=TestDatabase();database.verify()
        super().__init__(data,root,database=database,objects=MemoryStorage())


class CloudChecks(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.store=CloudTestStore(Path(self.temp.name)/'data',self.temp.name)
    def tearDown(self):self.temp.cleanup()

    def test_connection_settings_and_snapshot_stay_transaction_local(self):
        with self.store.database.connect(snapshot=True) as db:
            self.assertEqual(db.execute('SHOW search_path').fetchone()[0],'erp_workspace,pg_catalog')
            self.assertEqual(db.execute('SHOW extra_float_digits').fetchone()[0],'3')
            self.assertEqual(db.execute('SHOW statement_timeout').fetchone()[0],'20s')
            self.assertEqual(db.execute('SHOW lock_timeout').fetchone()[0],'15s')
            self.assertEqual(db.execute('SHOW transaction_read_only').fetchone()[0],'on')
            self.assertEqual(db.execute('SHOW transaction_isolation').fetchone()[0],'repeatable read')
        with self.store.database.connect() as db:
            self.assertEqual(db.execute('SHOW transaction_read_only').fetchone()[0],'off')

    def test_database_privileges_and_rollback(self):
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT current_user').fetchone()[0],'erp_app')
            self.assertFalse(db.execute("SELECT has_table_privilege('anon','erp_workspace.state','SELECT')").fetchone()[0])
            db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)',(1,'100% ? quote\''))
            self.assertEqual(db.execute("SELECT body FROM metadata WHERE body LIKE '100%' AND id=?",(1,)).fetchone()[0],"100% ? quote'")
        with self.assertRaises(ValueError):
            with self.store.connect() as db:
                db.execute('UPDATE metadata SET body=? WHERE id=1',('rolled back',))
                raise ValueError('rollback test')
        with self.store.connect() as db:self.assertNotEqual(db.execute('SELECT body FROM metadata').fetchone()[0],'rolled back')
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            with self.store.connect() as db:db.execute('CREATE TABLE denied_table(id INTEGER)')

    def test_private_object_integrity_and_backup(self):
        content=b'private original bytes';ident='a'*32;sha=hashlib.sha256(content).hexdigest()
        self.store.objects.put('uploads',ident,content)
        self.store.objects.put('uploads',ident,content)
        with self.assertRaises(ValueError):self.store.objects.put('uploads',ident,b'changed')
        with self.store.connect() as db:db.execute('INSERT INTO files VALUES(?,?,?,?,?)',(ident,'fixture.txt',len(content),sha,server.now()))
        self.assertEqual(self.store.upload_file(ident).read_bytes(),content)
        self.store.put_state(access_test.fixture_state(),0)
        with patch.object(cloud,'BACKUP_CHUNK',64):
            result=self.store.create_backup()
        self.assertGreater(len(result['chunks']),1)
        with zipfile.ZipFile(self.store.backup_file(result['id'])) as archive:
            self.assertEqual(archive.read('uploads/'+ident),content)
            self.assertEqual(json.loads(archive.read('database.json'))['tables']['state'][0]['revision'],1)

    def test_public_origin_secure_cookie_and_no_seed(self):
        import threading
        httpd=server.make_server(self.store,0,public_url='https://workspace.example.test')
        admin=httpd.access.create({'name':'고성운','email':'admin@example.test','password':'Testing123!Safe'},setup=True)
        thread=threading.Thread(target=httpd.serve_forever,daemon=True);thread.start()
        def request(path,method='GET',body=None,host='workspace.example.test',origin='https://workspace.example.test'):
            connection=http.client.HTTPConnection('127.0.0.1',httpd.server_port,timeout=10)
            connection.request(method,path,body,{'Host':host,'Origin':origin,'Content-Type':'application/json'})
            response=connection.getresponse();data=response.read();headers=dict(response.getheaders());status=response.status;connection.close()
            return status,data,headers
        try:
            self.assertEqual(request('/api/health')[0],200)
            self.assertEqual(request('/api/health',host='attacker.test')[0],403)
            login=json.dumps({'email':'admin@example.test','password':'Testing123!Safe'})
            self.assertEqual(request('/api/auth/login','POST',login,origin='https://evil.test')[0],403)
            status,body,headers=request('/api/auth/login','POST',login)
            self.assertEqual(status,200,body);self.assertIn('Secure',headers['Set-Cookie'])
            self.assertNotEqual(request('/seed.js')[0],200)
        finally:httpd.shutdown();httpd.server_close();thread.join()

    def test_email_disabled_even_with_smtp_settings(self):
        import invitations,task_mail,access
        with patch.dict(os.environ,{'ERP_CLOUD_MODE':'1','ERP_ENABLE_EMAIL':'0','ERP_SMTP_HOST':'smtp.example.test','ERP_SMTP_FROM':'noreply@example.test','ERP_INVITE_BASE_URL':'https://workspace.example.test'}):
            self.assertFalse(invitations.Invitations.config()['canSend'])
            self.assertFalse(task_mail.TaskMail(access.Access(self.store),0).config()['canSendReminder'])

    def test_migration_bundle_preserves_data_and_refuses_overwrite(self):
        import access, invitations,task_mail,wbs_exchange
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            local=BaseStore(root/'data',root)
            auth=access.Access(local);invitations.Invitations(auth);task_mail.TaskMail(auth,0);wbs_exchange.Exchange(local)
            user=auth.create({'name':'고성운','email':'admin@example.test','password':'Testing123!Safe'},setup=True)
            auth.new_session(user)
            local.put_state(access_test.fixture_state(),0)
            uploaded=local.upload('migration-fixture.txt',b'migration original bytes')
            bundle=root/'bundle.zip'
            plan=cloud_migrate.prepare(local.data,root,bundle,'a'*20)
            self.assertEqual(plan['excludedTransientRows']['access_sessions'],1)
            self.assertEqual(auth.setup_required(),False)
            with local.connect() as db:self.assertEqual(db.execute('SELECT COUNT(*) FROM access_sessions').fetchone()[0],1)
            config=cloud.Config('test-dsn','https://'+'a'*20+'.supabase.co','test','test-private','https://workspace.example.test',10000)
            with patch.object(cloud.Config,'from_env',return_value=config),patch.object(cloud,'Database',return_value=self.store.database),patch.object(cloud,'Storage',return_value=self.store.objects):
                result=cloud_migrate.apply(bundle,plan['bundleSha256'])
                self.assertEqual(result['status'],'completed')
                self.assertEqual(self.store.get_state(),local.get_state())
                self.assertEqual(self.store.upload_file(uploaded['id']).read_bytes(),b'migration original bytes')
                with self.assertRaises(ValueError):cloud_migrate.apply(bundle,plan['bundleSha256'])
            with self.store.connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM access_sessions').fetchone()[0],0)
                self.assertEqual(db.execute('SELECT email FROM access_users').fetchone()[0],'admin@example.test')
            self.assertIsNotNone(access.Access(self.store).login({'email':'admin@example.test','password':'Testing123!Safe'}))


def suite():
    result=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(CloudChecks))
    for name in ['test_unauthenticated_assets_and_private_routes','test_signup_pending_password_and_cookie',
                 'test_admin_named_signup_requires_explicit_approval','test_password_complexity_enforced_without_consuming_recovery',
                 'test_existing_password_can_still_login','test_forgot_password_does_not_reveal_or_change_account']:
        result.addTest(access_test.AccessTests(name))
    for name in ['test_roundtrip_and_apply_preserves_tasks_and_history','test_permissions_are_server_enforced',
                 'test_material_upload_and_wbs_upload_share_approval_and_exact_original','test_stale_preview_does_not_overwrite_other_updates']:
        result.addTest(wbs_exchange_test.WbsExchangeTests(name))
    return result


if __name__=='__main__':
    with patch.object(server,'Store',CloudTestStore):
        result=unittest.TextTestRunner(verbosity=2).run(suite())
    raise SystemExit(not result.wasSuccessful())
