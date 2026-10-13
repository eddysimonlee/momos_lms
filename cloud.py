"""Render/Supabase adapters. No schema creation, implicit migration or local fallback."""
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
from urllib.error import HTTPError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

SCHEMA = 'erp_workspace'
SCHEMA_VERSION = '1'
MAX_OBJECT = 256 * 1024 * 1024
BACKUP_CHUNK = 32 * 1024 * 1024
TABLES = {'state','revisions','files','imports','sources','sourceversions','reviews',
          'metadata','notifications','access_users','access_sessions','access_audit',
          'file_access','access_recovery','access_reset_requests','invitations',
          'task_mail_outbox','wbs_previews','wbs_versions','cloud_meta'}


@dataclass(repr=False)
class Config:
    database_url: str
    supabase_url: str
    storage_key: str
    bucket: str
    public_url: str
    port: int

    @classmethod
    def from_env(cls, *, require_public=True):
        names = ('ERP_DATABASE_URL','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','ERP_STORAGE_BUCKET')
        missing = [name for name in names if not os.environ.get(name)]
        if missing:
            raise ValueError('필수 서버 설정 누락: ' + ', '.join(missing))
        public = os.environ.get('ERP_PUBLIC_URL') or os.environ.get('RENDER_EXTERNAL_URL','')
        parsed = urlsplit(public)
        if (public or require_public) and (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.path not in ('','/') or parsed.query or parsed.fragment or parsed.port not in (None,443)
                or parsed.hostname in ('localhost','127.0.0.1','::1')):
            raise ValueError('ERP_PUBLIC_URL은 공용 HTTPS 원점 주소여야 합니다.')
        supa = os.environ['SUPABASE_URL'].rstrip('/')
        if not re.fullmatch(r'https://[a-z0-9]{20}\.supabase\.co', supa):
            raise ValueError('SUPABASE_URL의 프로젝트 주소를 확인하세요.')
        bucket = os.environ['ERP_STORAGE_BUCKET']
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', bucket):
            raise ValueError('ERP_STORAGE_BUCKET 형식 오류')
        port = int(os.environ.get('PORT','10000'))
        if not 1 <= port <= 65535:
            raise ValueError('PORT 범위 오류')
        dsn = os.environ['ERP_DATABASE_URL']
        db_url = urlsplit(dsn)
        if db_url.scheme not in ('postgres','postgresql') or not db_url.hostname or not db_url.password:
            raise ValueError('ERP_DATABASE_URL은 비밀번호를 포함한 PostgreSQL 연결 주소여야 합니다.')
        reference=urlsplit(supa).hostname.split('.')[0]
        direct=db_url.hostname=='db.'+reference+'.supabase.co' and unquote(db_url.username or '')=='erp_app'
        pooled=(db_url.hostname.endswith('.pooler.supabase.com') and unquote(db_url.username or '')=='erp_app.'+reference)
        if not (direct or pooled) or db_url.port not in (None,5432):
            raise ValueError('같은 Supabase 프로젝트의 erp_app 계정과 Session pooler 5432 포트를 사용하세요.')
        return cls(dsn,supa,os.environ['SUPABASE_SERVICE_ROLE_KEY'],bucket,public.rstrip('/'),port)


def postgres_sql(sql):
    """Translate the small, fixed dialect used by existing repositories; bind values separately."""
    sql = sql.strip().rstrip(';')
    if sql == 'BEGIN IMMEDIATE':
        # All existing exclusive writers acquire the same transaction-scoped lock.
        return 'SELECT pg_advisory_xact_lock(730921, 1)'
    match = re.fullmatch(r'INSERT OR REPLACE INTO (imports|sources|metadata) VALUES\((.+)\)', sql, re.I)
    if match:
        table = match[1].lower()
        columns = {'imports':('run_id','status','started','ended','detail'),
                   'sources':('id','sha256','body','updated'), 'metadata':('id','body')}[table]
        sql = 'INSERT INTO '+table+' VALUES('+match[2]+') ON CONFLICT ('+columns[0]+') DO UPDATE SET '+','.join(c+'=excluded.'+c for c in columns[1:])
    elif re.match(r'INSERT OR IGNORE\b', sql, re.I):
        sql = re.sub(r'^INSERT OR IGNORE\b','INSERT',sql,flags=re.I)+' ON CONFLICT DO NOTHING'
    if re.search(r'\b(?:PRAGMA|AUTOINCREMENT|INSERT OR|ATTACH|DETACH)\b', sql, re.I):
        raise ValueError('클라우드 DB에서 지원하지 않는 내부 SQL입니다.')
    result, i, quoted = [], 0, False
    while i < len(sql):
        char = sql[i]
        if char == "'":
            result.append(char)
            if quoted and i+1 < len(sql) and sql[i+1] == "'":
                result.append("'"); i += 2; continue
            quoted = not quoted
        elif char == '?' and not quoted:
            result.append('%s')
        elif char == '%':
            result.append('%%')
        else:
            result.append(char)
        i += 1
    return ''.join(result)


class Record(dict):
    # Preserve sqlite.Row's existing string AND positional lookups.
    def __getitem__(self, key):
        return tuple(self.values())[key] if isinstance(key,(int,slice)) else super().__getitem__(key)


def row_factory(cursor):
    columns = [column.name for column in cursor.description] if cursor.description else []
    return lambda values: Record(zip(columns,values))


class Connection:
    def __init__(self, raw):
        self.raw = raw

    def execute(self, sql, params=()):
        return self.raw.execute(postgres_sql(sql), params)

    def executescript(self, script):
        # Runtime initializers must never create/alter production tables.
        for statement in script.split(';'):
            statement = statement.strip()
            if not statement:
                continue
            match = re.match(r'CREATE TABLE IF NOT EXISTS (\w+)\s*\(',statement,re.I)
            if match and match[1] in TABLES:
                continue
            if statement == 'INSERT OR IGNORE INTO state VALUES(1,NULL,0)':
                continue
            raise ValueError('서버 시작 중 DB 구조 변경을 거부했습니다. 승인된 SQL을 먼저 적용하세요.')


class Database:
    def __init__(self, dsn, *, sslmode='require', expected_role='erp_app'):
        self.dsn, self.sslmode, self.expected_role = dsn,sslmode,expected_role
        from psycopg_pool import ConnectionPool
        # Reuse a bounded set of TLS connections; transaction-local settings stay below.
        self.pool = ConnectionPool(dsn, min_size=0, max_size=8, max_idle=60,
            max_lifetime=1800, timeout=15, max_waiting=32, open=True,
            kwargs=dict(sslmode=sslmode, connect_timeout=10, row_factory=row_factory,
                        prepare_threshold=None, application_name='momos-erp-workspace'))

    @contextmanager
    def connect(self, *, snapshot=False):
        with self.pool.connection() as raw:
            if snapshot:
                raw.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            raw.execute("""SELECT
                set_config('search_path', 'erp_workspace,pg_catalog', true),
                set_config('extra_float_digits', '3', true),
                set_config('statement_timeout', '20000', true),
                set_config('lock_timeout', '15000', true)""")
            yield Connection(raw)

    def close(self):
        self.pool.close()

    def verify(self):
        with self.connect() as db:
            if db.execute('SELECT current_user').fetchone()[0] != self.expected_role:
                raise ValueError('앱 전용 erp_app DB 계정을 사용하세요. 관리자 DB 계정으로 실행하지 않습니다.')
            role=db.execute('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user').fetchone()
            if any(role.values()):
                raise ValueError('앱 계정에 관리자 또는 RLS 우회 권한이 있습니다.')
            rows = db.execute("SELECT table_name FROM information_schema.tables WHERE table_schema=?",(SCHEMA,)).fetchall()
            if not TABLES.issubset({r[0] for r in rows}):
                raise ValueError('클라우드 DB 구조가 준비되지 않았습니다. 승인된 SQL 적용이 필요합니다.')
            unsafe=db.execute("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=? AND c.relkind='r' AND (NOT c.relrowsecurity OR has_table_privilege('anon',c.oid,'SELECT') OR has_table_privilege('authenticated',c.oid,'SELECT'))",(SCHEMA,)).fetchall()
            if unsafe:
                raise ValueError('업무 테이블의 비공개 권한과 RLS 설정을 확인하세요.')
            row = db.execute("SELECT body FROM cloud_meta WHERE id='schema_version'").fetchone()
            if not row or row[0] != SCHEMA_VERSION:
                raise ValueError('클라우드 DB 구조 버전을 확인하세요.')
            if not db.execute('SELECT 1 FROM state WHERE id=1').fetchone():
                raise ValueError('워크스페이스 상태 행이 없습니다.')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward the service key to a redirected destination.
        return None


class Storage:
    def __init__(self, url, key, bucket):
        self.base, self.key, self.bucket = url.rstrip('/')+'/storage/v1',key,bucket
        self.opener = build_opener(NoRedirect())

    def request(self, method, suffix, data=None, *, maximum=MAX_OBJECT):
        headers = {'apikey':self.key,'Authorization':'Bearer '+self.key,'Content-Type':'application/octet-stream','x-upsert':'false'}
        try:
            with self.opener.open(Request(self.base+suffix,data=data,headers=headers,method=method),timeout=45) as response:
                payload = response.read(maximum+1)
                if len(payload) > maximum:
                    raise ValueError('파일 크기 제한 초과')
                return payload
        except HTTPError as error:
            # Do not echo provider response bodies, keys, filenames or connection strings.
            status = error.code
            try:
                provider = json.loads(error.read(8192))
            except (ValueError, OSError):
                provider = {}
            error.close()
            # Storage can report a missing object as HTTP 400 with statusCode 404.
            if status == 404 or (status == 400 and isinstance(provider, dict)
                                 and str(provider.get('statusCode')) == '404'):
                raise FileNotFoundError('클라우드 보관 파일이 없습니다.') from None
            raise OSError('비공개 파일 저장소 요청 실패 ('+str(status)+')') from None

    def verify(self):
        body = json.loads(self.request('GET','/bucket/'+quote(self.bucket,safe=''),maximum=64*1024))
        if body.get('public') is not False:
            raise ValueError('첨부 저장 버킷은 반드시 비공개여야 합니다.')

    def path(self, kind, ident):
        if kind not in ('uploads','source_versions','backups') or not re.fullmatch(r'[a-f0-9]{32}|[a-f0-9]{64}', ident):
            raise ValueError('잘못된 파일 식별자')
        return '/object/'+quote(self.bucket,safe='')+'/'+kind+'/'+ident

    def put(self, kind, ident, content):
        if len(content)>MAX_OBJECT:
            raise ValueError('파일 크기 제한 초과')
        path = self.path(kind,ident)
        try:
            self.request('POST',path,content,maximum=1024*1024)
        except OSError:
            # An uncertain response or duplicate upload never overwrites existing bytes.
            if self.request('GET',path) != content:
                raise ValueError('같은 식별자의 다른 파일은 덮어쓰지 않습니다.') from None

    def cache(self, root, kind, ident, digest):
        if not re.fullmatch('[a-f0-9]{64}',digest):
            raise ValueError('파일 판본 해시가 필요합니다.')
        path = Path(root)/kind/ident
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError('연결 경로는 사용할 수 없습니다.')
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest()==digest:
            return path
        raw = self.request('GET',self.path(kind,ident))
        if hashlib.sha256(raw).hexdigest()!=digest:
            raise ValueError('다운로드한 파일의 판본 해시가 일치하지 않습니다.')
        path.parent.mkdir(parents=True,exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent,delete=False) as output:
            temporary = Path(output.name)
            output.write(raw)
        try:
            os.replace(temporary,path)
        finally:
            temporary.unlink(missing_ok=True)
        return path


def metadata(store, ident, default=None):
    with store.connect() as db:
        row = db.execute('SELECT body FROM cloud_meta WHERE id=?',(ident,)).fetchone()
    return json.loads(row[0]) if row else default


def review_document(store, ident, page, limit):
    if not isinstance(ident,str) or not 1<=page or not 1<=limit<=500:
        raise ValueError('Invalid document page')
    result = metadata(store,'review_document:'+ident)
    if result is None:
        raise FileNotFoundError('이전되지 않은 자료 검토입니다.')
    ensure_source_allowed(store, result.get('document',{}))
    units = result.get('units',[])
    return dict(result,units=units[(page-1)*limit:page*limit],page=page,limit=limit,total=len(units))


def ensure_source_allowed(store, document):
    import source_review
    restrictions = metadata(store,'source_protections',{'paths':[],'hashes':[]})
    path = document.get('canonical_path') or document.get('path','')
    if (not path or source_review.protected(path,document.get('kind'))
            or re.search(r'접속정보|계정정보|api\s*키|비밀번호|credential|password|\.env(?:$|\.)',path,re.I)
            or path in restrictions['paths'] or document.get('sha256') in restrictions['hashes']):
        raise PermissionError('Restricted document')


def encode_rows(rows):
    import base64
    return [{key: {'$bytes':base64.b64encode(value).decode()} if isinstance(value,(bytes,memoryview)) else value
             for key,value in dict(row).items()} for row in rows]


def create_backup(store):
    """Consistent DB snapshot plus registered immutable objects. Never restore in place."""
    import uuid
    import zipfile
    from datetime import datetime, timezone
    if not store.backup_lock.acquire(blocking=False):
        raise ValueError('백업이 이미 진행 중입니다.')
    try:
        with store.database.connect(snapshot=True) as db:
            tables = {name:encode_rows(db.execute('SELECT * FROM '+name).fetchall()) for name in sorted(TABLES)}
        ident = uuid.uuid4().hex
        revision = tables['state'][0]['revision']
        state = json.loads(tables['state'][0]['body'] or '{}')
        required = {('uploads',row['id']):row['sha256'] for row in tables['files']}
        required.update({('source_versions',row['sha256']):row['sha256'] for row in tables['sourceversions']})
        required.update({('source_versions',row['sha256']):row['sha256'] for row in state.get('materials',[]) if row.get('sha256')})
        # Source metadata can predate preserved bytes; list those gaps explicitly.
        missing, included = [], []
        with tempfile.TemporaryDirectory(dir=store.data) as temporary:
            archive_path = Path(temporary)/'backup.zip'
            with zipfile.ZipFile(archive_path,'w',zipfile.ZIP_DEFLATED,compresslevel=1) as archive:
                archive.writestr('database.json',json.dumps({'schema':SCHEMA,'version':SCHEMA_VERSION,'tables':tables},ensure_ascii=False))
                for (kind,key),digest in required.items():
                    try:
                        source = store.objects.cache(store.data,kind,key,digest)
                    except FileNotFoundError:
                        if kind=='uploads':
                            raise ValueError('등록된 첨부가 없어 백업을 완료하지 않았습니다.') from None
                        missing.append({'kind':kind,'sha256':digest}); continue
                    archive.write(source,kind+'/'+key)
                    included.append({'kind':kind,'id':key,'sha256':digest})
                    if archive_path.stat().st_size>2*1024*1024*1024:
                        raise ValueError('백업이 2 GB를 넘습니다. 별도 서버 백업이 필요합니다.')
                archive.writestr('manifest.json',json.dumps({'files':included,'missing':missing},ensure_ascii=False))
            chunks=[];checksum=hashlib.sha256();size=0
            with archive_path.open('rb') as incoming:
                for raw in iter(lambda:incoming.read(BACKUP_CHUNK),b''):
                    chunk_hash=hashlib.sha256(raw).hexdigest()
                    store.objects.put('backups',chunk_hash,raw)
                    chunks.append({'id':chunk_hash,'size':len(raw)})
                    checksum.update(raw);size+=len(raw)
        record={'status':'completed','id':ident,'url':'/api/backups/'+ident,'name':'momos-workspace-backup.zip',
                'stateRevision':revision,'size':size,'sha256':checksum.hexdigest(),'chunks':chunks,
                'createdAt':datetime.now(timezone.utc).isoformat(),'includedFiles':len(included),'missing':missing,
                'scope':['PostgreSQL 업무·계정 테이블 스냅샷','등록 첨부·보존 원문'],
                'excluded':['앱 코드·비밀 설정','Google Drive 원천 전체','백업 생성 이후 변경']}
        with store.connect() as db:
            db.execute('INSERT INTO cloud_meta VALUES(?,?)',('backup:'+ident,json.dumps(record,ensure_ascii=False)))
        return record
    finally:
        store.backup_lock.release()


def backup_file(store,ident,record):
    directory=store.data/'backups'
    directory.mkdir(exist_ok=True)
    destination=directory/(ident+'.zip')
    def checksum(path):
        with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
    if destination.is_file() and checksum(destination)==record['sha256']:return destination
    with tempfile.NamedTemporaryFile(dir=directory,delete=False) as output:
        temporary=Path(output.name)
        try:
            for chunk in record['chunks']:
                raw=store.objects.request('GET',store.objects.path('backups',chunk['id']))
                if hashlib.sha256(raw).hexdigest()!=chunk['id'] or len(raw)!=chunk['size']:
                    raise ValueError('백업 파일 조각 무결성 오류')
                output.write(raw)
        except Exception:
            output.close();temporary.unlink(missing_ok=True);raise
    try:
        if checksum(temporary)!=record['sha256'] or temporary.stat().st_size!=record['size']:
            raise ValueError('전체 백업 무결성 오류')
        os.replace(temporary,destination)
    finally:temporary.unlink(missing_ok=True)
    return destination


def run():
    import server
    import signal
    config = Config.from_env()
    database = Database(config.database_url)
    database.verify()
    with database.connect() as db:
        if not db.execute('SELECT body FROM state WHERE id=1').fetchone()[0]:
            raise ValueError('기존 업무 데이터 이전이 완료되어야 서버를 시작할 수 있습니다.')
    objects = Storage(config.supabase_url,config.storage_key,config.bucket)
    objects.verify()
    # Cloud always has its own disposable cache, never the user's Drive root.
    root = Path(os.environ.get('ERP_CACHE_DIR','/tmp/momos-workspace'))
    root.mkdir(parents=True,exist_ok=True)
    os.environ.setdefault('ERP_INVITE_BASE_URL',config.public_url)
    os.environ.setdefault('ERP_WORKSPACE_URL',config.public_url)
    os.environ['ERP_CLOUD_MODE']='1'
    store = server.Store(root/'data',root,database=database,objects=objects)
    httpd = server.make_server(store,config.port,host='0.0.0.0',public_url=config.public_url)
    httpd.daemon_threads=False
    # External mail and import polling remain disabled until separately enabled by an operator.
    stop = threading.Event()
    def terminate(signum,frame):
        stop.set()
        threading.Thread(target=httpd.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,terminate)
    signal.signal(signal.SIGINT,terminate)
    if os.environ.get('ERP_ENABLE_APP_REMINDERS') == '1':
        threading.Thread(target=store.notification_poll,args=(stop,),daemon=True).start()
    if os.environ.get('ERP_ENABLE_EMAIL') == '1' or os.environ.get('ERP_ENABLE_SIGNUP_EMAIL') == '1':
        threading.Thread(target=httpd.task_mail.poll,args=(stop,),daemon=True).start()
    try:
        httpd.serve_forever()
    finally:
        stop.set()
        httpd.server_close()
        database.close()


if __name__ == '__main__':
    try:
        run()
    except Exception as error:
        # Configuration/startup exceptions can include credentials in third-party messages.
        raise SystemExit('클라우드 서버 시작 실패: '+type(error).__name__+' · 설정과 DB/Storage 준비 상태를 확인하세요.') from None
