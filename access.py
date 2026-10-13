"""Local account identity and conservative project authorization, without cloud services."""
import copy
import datetime
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
import unicodedata
from http.cookies import SimpleCookie

COOKIE = 'erp_session'
SESSION_SECONDS = 12 * 3600
ROLES = {'admin', 'lead', 'member', 'viewer'}
ADMINS = {'고성운', '최상민', '채수민'}
COMPANIES_METADATA = 2026100202
MEMBER_PROFILES_METADATA = 2026100203
PROFILE_LIMITS = {'nickname':60, 'workPhone':40, 'mobile':40, 'joinedOn':10,
                  'employeeNo':40, 'workplace':100, 'responsibilities':1000}
DEFAULT_COMPANIES = {'momos': '모모스커피', 'viewcs': '뷰시에스'}


def company_name(company):
    # New external companies use their registered name as the existing TEXT key.
    return DEFAULT_COMPANIES.get(company, company)


class LoginRequired(Exception):
    pass


class RateLimited(Exception):
    pass


def public_user(row):
    return {k: row[k] for k in ('id', 'name', 'email', 'role', 'company', 'department', 'title', 'status')}


def password_hash(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), 600000).hex()


def validate_password(password):
    if (not isinstance(password, str) or not 10 <= len(password) <= 256
            or not re.search(r'[A-Z]', password) or not re.search(r'[0-9]', password)
            or not re.search(r'[^\w\s]', password)):
        raise ValueError('비밀번호는 10~256자이며 영문 대문자·숫자·특수문자를 각각 1개 이상 포함해야 합니다.')


class Access:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.attempts = {}
        with store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS access_users(
                    id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,email TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL,
                    company TEXT NOT NULL,department TEXT NOT NULL,title TEXT NOT NULL,
                    status TEXT NOT NULL,created_at REAL NOT NULL,updated_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS access_sessions(
                    token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,csrf TEXT NOT NULL,
                    expires_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS access_audit(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,at REAL NOT NULL,actor_id TEXT,
                    kind TEXT NOT NULL,target_id TEXT,detail TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS file_access(
                    file_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,task_id TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS access_recovery(
                    token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,
                    account_version REAL NOT NULL,created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,used_at REAL);
                CREATE TABLE IF NOT EXISTS access_reset_requests(
                    user_id TEXT PRIMARY KEY,requested_at REAL NOT NULL,status TEXT NOT NULL);
            ''')

    def rate(self, key, limit=8):
        with self.lock:
            current = time.time()
            rows = [at for at in self.attempts.get(key, []) if at > current - 60]
            if len(rows) >= limit:
                raise RateLimited()
            rows.append(current)
            self.attempts[key] = rows
            if len(self.attempts) > 3000:
                self.attempts = {k: v for k, v in self.attempts.items() if v and v[-1] > current - 60}

    def setup_required(self):
        with self.store.connect() as db:
            return db.execute('SELECT COUNT(*) FROM access_users').fetchone()[0] == 0

    def companies(self, db=None):
        if db is None:
            with self.store.connect() as connection:
                return self.companies(connection)
        row = db.execute('SELECT body FROM metadata WHERE id=?', (COMPANIES_METADATA,)).fetchone()
        extra = json.loads(row['body']) if row else {}
        if not isinstance(extra, dict) or any(not isinstance(k, str) or not isinstance(v, str) or k != v for k, v in extra.items()):
            raise ValueError('소속 목록을 확인할 수 없습니다. 관리자에게 확인해 주세요.')
        return {**DEFAULT_COMPANIES, **{k: v for k, v in extra.items() if k not in DEFAULT_COMPANIES}}

    def add_company(self, actor, value):
        if not actor or actor['role'] != 'admin' or actor['company'] != 'momos' or actor['name'] not in ADMINS:
            raise PermissionError('관리자만 소속을 추가합니다.')
        if not isinstance(value, dict) or set(value) != {'name'} or not isinstance(value['name'], str):
            raise ValueError('추가할 소속 이름을 입력해 주세요.')
        name = ' '.join(unicodedata.normalize('NFKC', value['name']).split())
        if not name or len(name) > 60 or re.search(r'[\x00-\x1f\x7f]', value['name']) or name.casefold() in {'__proto__','constructor','prototype'}:
            raise ValueError('소속 이름은 1~60자로 입력해 주세요.')
        normalized = lambda text: ''.join(unicodedata.normalize('NFKC', text).split()).casefold()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            catalog = self.companies(db)
            if normalized(name) in {normalized(s) for s in [*catalog, *catalog.values()]}:
                raise ValueError('이미 등록된 소속입니다. 목록에서 선택해 주세요.')
            extra = {k: v for k, v in catalog.items() if k not in DEFAULT_COMPANIES}
            extra[name] = name
            db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)', (COMPANIES_METADATA, json.dumps(extra, ensure_ascii=False)))
            db.execute('INSERT INTO access_audit(at,actor_id,kind,target_id,detail) VALUES(?,?,?,?,?)',
                       (time.time(), actor['id'], 'company.add', name, json.dumps({'company': name}, ensure_ascii=False)))
            return {'company': name, 'companies': self.companies(db)}

    def session(self, cookie):
        try:
            parsed = SimpleCookie()
            parsed.load(cookie or '')
            token = parsed[COOKIE].value if COOKIE in parsed else ''
        except Exception:
            return None
        if not re.fullmatch(r'[a-f0-9]{64}', token):
            return None
        with self.store.connect() as db:
            row = db.execute('''SELECT u.*,s.csrf FROM access_sessions s
                JOIN access_users u ON s.user_id=u.id WHERE s.token_hash=?
                AND s.expires_at>? AND u.status='active' ''',
                (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        return {'user': public_user(row), 'csrfToken': row['csrf']} if row else None

    def new_session(self, user):
        token, csrf = secrets.token_hex(32), secrets.token_hex(32)
        with self.store.connect() as db:
            db.execute('DELETE FROM access_sessions WHERE expires_at<=?', (time.time(),))
            db.execute('INSERT INTO access_sessions VALUES(?,?,?,?)',
                       (hashlib.sha256(token.encode()).hexdigest(), user['id'], csrf, time.time() + SESSION_SECONDS))
        return {'user': user, 'csrfToken': csrf, 'setupRequired': False}, token

    def create(self, value, setup=False, on_signup=None):
        name = str(value.get('name', '')).strip()
        email = str(value.get('email', '')).strip().lower()
        password = value.get('password', '')
        company = 'momos' if setup else value.get('company', 'momos')
        department, title = str(value.get('department', '')).strip(), str(value.get('title', '')).strip()
        if not name or len(name) > 60 or len(email) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email):
            raise ValueError('이름과 유효한 이메일을 입력해 주세요.')
        validate_password(password)
        if not isinstance(company, str) or company not in self.companies() or len(department) > 100 or len(title) > 100:
            raise ValueError('소속 정보를 확인해 주세요.')
        if setup and name not in ADMINS:
            raise ValueError('최초 관리자는 고성운·최상민·채수민으로 설정해 주세요.')
        ident, salt = secrets.token_hex(16), secrets.token_hex(16)
        digest = password_hash(password, salt)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            count = db.execute('SELECT COUNT(*) FROM access_users').fetchone()[0]
            if setup != (count == 0):
                raise PermissionError('Initial setup state changed')
            if db.execute('SELECT 1 FROM access_users WHERE email=? OR name=?', (email, name)).fetchone():
                raise ValueError('이미 신청한 이름 또는 이메일입니다. 관리자에게 확인해 주세요.')
            db.execute('INSERT INTO access_users VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       (ident, name, email, digest, salt, 'admin' if setup else 'member', company,
                        department, title, 'active' if setup else 'pending', time.time(), time.time()))
            db.execute('INSERT INTO access_audit(at,actor_id,kind,target_id,detail) VALUES(?,?,?,?,?)',
                       (time.time(), ident, 'setup' if setup else 'signup', ident, '{}'))
            user = public_user(db.execute('SELECT * FROM access_users WHERE id=?', (ident,)).fetchone())
            if not setup and on_signup:
                on_signup(db, user)
        return user

    def login(self, value):
        email = str(value.get('email', '')).strip().lower()
        password = value.get('password', '')
        if not isinstance(password, str) or len(password) > 256:
            raise LoginRequired()
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM access_users WHERE email=?', (email,)).fetchone()
        digest = password_hash(password, row['salt'] if row else '00' * 16)
        if not row or not hmac.compare_digest(digest, row['password_hash']) or row['status'] != 'active':
            raise LoginRequired()
        return self.new_session(public_user(row))

    def issue_local_recovery(self, email, actor=None, email_verified=False):
        """Issue only through the local operator, authenticated admin or bound-email path."""
        if actor is not None and not (actor['role']=='admin' and actor['company']=='momos' and actor['name'] in ADMINS):
            raise PermissionError()
        email = str(email).strip().lower()
        token, at = secrets.token_hex(32), time.time()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM access_users WHERE email=?', (email,)).fetchone()
            permitted = email_verified or actor and actor['role']=='admin' and actor['company']=='momos' and actor['name'] in ADMINS
            if not row or row['status'] != 'active' or (not permitted and (row['role'] != 'admin' or row['company'] != 'momos' or row['name'] not in ADMINS)):
                raise ValueError('등록된 이용 중인 계정을 확인해 주세요.')
            db.execute('DELETE FROM access_recovery WHERE user_id=? OR expires_at<=?', (row['id'], at))
            db.execute('INSERT INTO access_recovery VALUES(?,?,?,?,?,NULL)',
                       (hashlib.sha256(token.encode()).hexdigest(), row['id'], row['updated_at'], at, at+3600))
            db.execute('INSERT INTO access_audit(at,actor_id,kind,target_id,detail) VALUES(?,?,?,?,?)',
                       (at, actor['id'] if actor else 'email-recovery' if email_verified else 'local-operator', 'recovery.issue', row['id'], '{"valid_seconds":3600}'))
            db.execute("UPDATE access_reset_requests SET status='issued' WHERE user_id=?", (row['id'],))
        return token

    @staticmethod
    def recovery_row(db, token):
        if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{64}', token):
            raise ValueError('비밀번호 설정 링크가 유효하지 않습니다.')
        row = db.execute('''SELECT r.token_hash,r.expires_at,r.used_at,r.account_version,u.*
            FROM access_recovery r JOIN access_users u ON u.id=r.user_id
            WHERE r.token_hash=?''', (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        if (not row or row['used_at'] is not None or row['expires_at'] <= time.time()
                or row['account_version'] != row['updated_at'] or row['status'] != 'active'):
            raise ValueError('만료되었거나 이미 사용한 링크입니다. 관리자에게 설정 링크를 다시 요청해 주세요.')
        return row

    def recovery_info(self, token):
        with self.store.connect() as db:
            row = self.recovery_row(db, token)
            return {'name':row['name'], 'email':row['email'], 'expiresAt':row['expires_at']}

    def reset_password(self, value):
        if set(value) - {'token','email','password'}:
            raise ValueError('이름·역할·계정 권한은 이 화면에서 변경할 수 없습니다.')
        password = value.get('password', '')
        validate_password(password)
        salt = secrets.token_hex(16)
        digest = password_hash(password, salt)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = self.recovery_row(db, value.get('token'))
            if str(value.get('email', '')).strip().lower() != row['email']:
                raise ValueError('설정 링크에 지정된 계정 아이디로만 사용할 수 있습니다.')
            at = time.time()
            db.execute('UPDATE access_users SET password_hash=?,salt=?,updated_at=? WHERE id=?',
                       (digest, salt, at, row['id']))
            db.execute('UPDATE access_recovery SET used_at=? WHERE user_id=? AND used_at IS NULL', (at,row['id']))
            db.execute('DELETE FROM access_sessions WHERE user_id=?', (row['id'],))
            db.execute("UPDATE access_reset_requests SET status='completed' WHERE user_id=?", (row['id'],))
            db.execute('INSERT INTO access_audit(at,actor_id,kind,target_id,detail) VALUES(?,?,?,?,?)',
                       (at,row['id'],'password.reset',row['id'],'{"method":"local_recovery"}'))
            return public_user(db.execute('SELECT * FROM access_users WHERE id=?',(row['id'],)).fetchone())

    def request_reset(self, email):
        email = str(email).strip().lower()
        if len(email)>254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email):
            raise ValueError('가입한 업무 이메일을 입력해 주세요.')
        with self.store.connect() as db:
            row=db.execute("SELECT * FROM access_users WHERE email=? AND status='active'",(email,)).fetchone()
            if row:
                db.execute("INSERT INTO access_reset_requests VALUES(?,?,'pending') ON CONFLICT(user_id) DO UPDATE SET requested_at=excluded.requested_at,status='pending'",(row['id'],time.time()))
        return public_user(row) if row else None

    def reset_requests(self):
        with self.store.connect() as db:
            return [dict(r) for r in db.execute('SELECT r.user_id,r.requested_at,r.status,u.name,u.email FROM access_reset_requests r JOIN access_users u ON r.user_id=u.id ORDER BY r.requested_at DESC')]

    def logout(self, cookie):
        parsed = SimpleCookie()
        parsed.load(cookie or '')
        token = parsed[COOKIE].value if COOKIE in parsed else ''
        with self.store.connect() as db:
            db.execute('DELETE FROM access_sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))

    def users(self):
        with self.store.connect() as db:
            return [public_user(row) for row in db.execute('SELECT * FROM access_users ORDER BY created_at')]

    def admin_audit(self, actor):
        if not actor or actor.get('role') != 'admin' or actor.get('status') != 'active':
            raise PermissionError('워크스페이스 관리자만 확인할 수 있습니다.')
        with self.store.connect() as db:
            names = {r['id']: r['name'] for r in db.execute('SELECT id,name FROM access_users')}
            rows = db.execute('SELECT at,actor_id,kind,target_id,detail FROM access_audit ORDER BY at DESC LIMIT 100').fetchall()
        result = []
        for row in rows:
            detail = json.loads(row['detail']) if row['kind'] == 'account.update' else {}
            result.append(dict(at=row['at'], actor=names.get(row['actor_id'], '시스템'),
                               action=row['kind'], target=names.get(row['target_id'], '이전 계정'),
                               detail={k: detail[k] for k in ('role','status','company','fields') if k in detail}))
        return result

    def member_details(self, actor, ident):
        if not actor or actor['role'] != 'admin':
            raise PermissionError()
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM access_users WHERE id=?', (ident,)).fetchone()
            if not row:
                raise FileNotFoundError()
            saved = db.execute('SELECT body FROM metadata WHERE id=?', (MEMBER_PROFILES_METADATA,)).fetchone()
            profiles = json.loads(saved['body']) if saved else {}
            changed = db.execute("SELECT MAX(at) FROM access_audit WHERE target_id=? AND kind IN ('setup','signup','password.reset')", (ident,)).fetchone()[0]
            requested = db.execute("SELECT requested_at FROM access_reset_requests WHERE user_id=? AND status='pending'", (ident,)).fetchone()
            return dict(user=public_user(row), profile=profiles.get(ident, {}), companies=self.companies(db),
                        passwordChangedAt=changed or row['created_at'],
                        resetRequestedAt=requested['requested_at'] if requested else None)

    def update_user(self, actor, ident, value):
        if not actor or actor['role'] != 'admin':
            raise PermissionError()
        if not isinstance(value, dict) or set(value) - {'status', 'role', 'company', 'email', 'department', 'title', 'profile'}:
            raise ValueError('변경할 수 없는 계정 항목입니다.')
        profile = value.get('profile')
        if profile is not None:
            if not isinstance(profile, dict) or set(profile) - PROFILE_LIMITS.keys():
                raise ValueError('구성원 정보 항목을 확인해 주세요.')
            profile = dict(profile)
            for key, text in profile.items():
                if not isinstance(text, str) or len(text) > PROFILE_LIMITS[key] or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', text):
                    raise ValueError('구성원 정보의 입력 길이·형식을 확인해 주세요.')
                profile[key] = text.strip()
            if profile.get('joinedOn'):
                try:
                    parsed = datetime.date.fromisoformat(profile['joinedOn'])
                    if parsed.isoformat() != profile['joinedOn']:
                        raise ValueError()
                except ValueError:
                    raise ValueError('입사일을 유효한 날짜로 입력해 주세요.')
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM access_users WHERE id=?', (ident,)).fetchone()
            if not row:
                raise FileNotFoundError()
            status, role, company = value.get('status', row['status']), value.get('role', row['role']), value.get('company', row['company'])
            email = value.get('email', row['email'])
            department, title = value.get('department', row['department']), value.get('title', row['title'])
            if status not in ('active', 'revoked', 'pending') or role not in ROLES or not isinstance(company, str) or company not in self.companies(db):
                raise ValueError('계정 상태·역할·소속을 확인해 주세요.')
            if not isinstance(email, str) or len(email)>254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email.strip()):
                raise ValueError('유효한 업무 이메일을 입력해 주세요.')
            email = email.strip().lower()
            if any(not isinstance(v, str) or len(v)>100 or re.search(r'[\x00-\x1f\x7f]', v) for v in (department,title)):
                raise ValueError('부서·직책은 100자 이내로 입력해 주세요.')
            if email != row['email'] and db.execute('SELECT 1 FROM access_users WHERE email=? AND id<>?', (email,ident)).fetchone():
                raise ValueError('이미 사용 중인 업무 이메일입니다.')
            if role == 'admin' and (row['name'] not in ADMINS or company != 'momos'):
                raise ValueError('관리자 권한은 고성운·최상민·채수민에게만 부여할 수 있습니다.')
            if row['role'] == 'admin' and row['status'] == 'active' and (role != 'admin' or status != 'active'):
                if db.execute("SELECT COUNT(*) FROM access_users WHERE role='admin' AND status='active'").fetchone()[0] <= 1:
                    raise ValueError('마지막 관리자의 권한은 회수할 수 없습니다.')
            changes = [k for k,v in dict(status=status,role=role,company=company,email=email,department=department.strip(),title=title.strip()).items() if row[k]!=v]
            if profile is not None:
                saved = db.execute('SELECT body FROM metadata WHERE id=?', (MEMBER_PROFILES_METADATA,)).fetchone()
                profiles = json.loads(saved['body']) if saved else {}
                previous = profiles.get(ident,{})
                changes += ['profile.'+k for k,v in profile.items() if previous.get(k,'')!=v]
                profiles[ident] = {**previous, **profile}
                db.execute('INSERT OR REPLACE INTO metadata VALUES(?,?)', (MEMBER_PROFILES_METADATA,json.dumps(profiles,ensure_ascii=False)))
            db.execute('UPDATE access_users SET status=?,role=?,company=?,email=?,department=?,title=?,updated_at=? WHERE id=?',
                       (status,role,company,email,department.strip(),title.strip(),time.time(),ident))
            session_revoked = any(k in changes for k in ('email','role','company','status'))
            if session_revoked:
                db.execute('DELETE FROM access_sessions WHERE user_id=?', (ident,))
            db.execute('INSERT INTO access_audit(at,actor_id,kind,target_id,detail) VALUES(?,?,?,?,?)',
                       (time.time(),actor['id'],'account.update',ident,json.dumps({'status':status,'role':role,'company':company,'fields':changes})))
            return public_user(db.execute('SELECT * FROM access_users WHERE id=?', (ident,)).fetchone())

    def project_identity(self, state, user):
        state = copy.deepcopy(state)
        if state is None:
            return None
        people = state.setdefault('people', [])
        for account in self.users():
            person = next((p for p in people if p.get('name') == account['name']), None)
            if account['status'] == 'revoked':
                if person:
                    person['active'] = False
                continue
            if account['status'] != 'active':
                continue
            if person is None:
                person = {'name': account['name']}
                people.append(person)
            person.update(role=account['role'], org=company_name(account['company']),
                          confirmed=True, active=True)
            if account.get('title'):
                person['title'] = account['title']
        # Approved accounts can be assigned immediately, before their first action.
        # Authentication is authoritative even if an old operational people row says admin.
        return state

    def file_allowed(self, user, ident, state):
        if user['role'] == 'admin':
            return True
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM file_access WHERE file_id=?', (ident,)).fetchone()
        if not row:
            return False
        registered = next((f for f in state.get('files', []) if f.get('id') == ident), None)
        if registered is not None:
            return registered.get('taskId') == row['task_id'] and bool(file_context_ids(state, user, registered))
        # The uploader may verify their staged upload before attaching it; a
        # registered private attachment is never made public by ownership.
        return row['task_id'] in visible_ids(state, user) and row['user_id'] == user['id']


def assigned(item, user):
    return user['name'] in [item.get('owner')] + item.get('owners', [])


def may_perform(item, user, state):
    if item and item.get('internalOnly') and user.get('company') != 'momos':
        return False
    if user['role'] == 'admin':
        return True
    if user['role'] == 'viewer' or not item or item.get('visibility') != '공유':
        return False
    if assigned(item, user):
        return True
    if user['role'] != 'lead':
        return False
    organization = company_name(user['company'])
    team = {p.get('name') for p in state.get('people', []) if p.get('org') == organization and p.get('confirmed') and p.get('active')}
    owners = {item.get('owner')} | set(item.get('owners', []))
    return bool(team & owners)


def regular_visible_items(state, user):
    if not state:
        return []
    items = [t for t in state.get('tasks', []) + state.get('wbs', []) if not t.get('internalOnly') or user.get('company') == 'momos']
    if user['role'] == 'admin':
        return items
    issue_tasks = {issue.get('taskId') for issue in state.get('issues', [])
                   if issue.get('visibility') == '공유' and issue.get('owner') == user['name']}
    return [item for item in items if item.get('visibility') == '공유' and
            (item.get('kind') == 'wbs' or item in state.get('wbs', []) or user['role'] in ('lead', 'viewer') or assigned(item, user) or item.get('id') in issue_tasks)]

def regular_visible_ids(state, user):
    return {r['id'] for r in regular_visible_items(state, user)}

def visible_followups(state, user):
    return [r for r in state.get('followups', []) if (user.get('company')=='momos' or not any(t.get('internalOnly') and t['id']==r.get('taskId') for t in state.get('tasks',[]))) and (user['role']=='admin' or user['id'] in (r.get('recipientId'),r.get('requestedById')))]

def request_recipient(state, user, task_id):
    return user['role'] != 'viewer' and any(r.get('taskId')==task_id and r.get('recipientId')==user['id'] and r.get('status') not in ('resolved','cancelled') for r in state.get('followups', []))

def visible_items(state, user):
    normal=regular_visible_items(state,user)
    ids={r['id'] for r in normal}
    extra={r['taskId'] for r in visible_followups(state,user)}-ids if state else set()
    return normal+[r for r in state.get('tasks',[])+state.get('wbs',[]) if r['id'] in extra] if state else []


def visible_ids(state, user):
    return {row['id'] for row in visible_items(state, user)}


TASK_FIELDS = set('id kind title phase owner owners start due sourceStart sourceDue originalDue status progressPercent active managed completionCriteria forecastDue parent parentTaskId wbsLinkApproved visibility priority nextAction blocker responseDue actualCompletedOn completionRecordedAt completedBy review fixedDue predecessors predecessorsApproved createdAt createdBy updatedAt importantReview reviewChecklist'.split())


def hierarchy_context(state, item):
    """Provide title-only ancestry without granting access to an ancestor record."""
    tasks = {t['id']: t for t in state.get('tasks', [])}
    parent = tasks.get(item.get('parentTaskId'))
    wbs_id = (parent or item).get('parent', '')
    wbs = next((t for t in state.get('wbs', []) if t['id'] == wbs_id), None)
    def title(target, hidden):
        return target.get('title', '') if target and target.get('visibility') == '공유' else hidden if target else ''
    return {'parentTaskId': item.get('parentTaskId', ''), 'parentTitle': title(parent, '비공개 상위 업무'),
            'wbsId': wbs_id, 'wbsTitle': title(wbs, '비공개 WBS')}


def file_context_ids(state, user, file):
    """A deliberate reuse exposes file content, never its other task contexts."""
    ids = visible_ids(state, user)
    regular_ids = regular_visible_ids(state, user)
    response_contexts = {r['taskId'] for r in visible_followups(state, user)
                         if any(file.get('id') in response.get('fileIds', []) for response in r.get('responses', []))}
    # Several independent requests can reference the same private task. A file
    # submitted to one request must not reach the other request's participants.
    contexts = set(file.get('linkedTaskIds', [])) & (regular_ids | response_contexts)
    original = file.get('taskId')
    if original in regular_ids and file.get('visibility') == '공유':
        contexts.add(original)
    elif original in ids and original not in regular_ids:
        if file.get('addedBy') == user['name'] or original in response_contexts:
            contexts.add(original)
    return contexts


TASK_FIELDS.update({'internalOnly','inboxKind'})

def safe_task(item, ids):
    result = {k: copy.deepcopy(v) for k, v in item.items() if k in TASK_FIELDS}
    result.update(sourceRefs=[], evidenceIds=[], reviews=[], completionHistory=[])
    result['progressHistory'] = [{k: copy.deepcopy(r[k]) for k in ('before','after','reason','actor','at') if k in r} for r in item.get('progressHistory', []) if r.get('visibility') == '공유']
    result['replies'] = [{k: r[k] for k in ('actor', 'at', 'text', 'remaining', 'blocker') if k in r}
                         for r in item.get('replies', []) if r.get('visibility') == '공유']
    result['reviews'] = [{k: r[k] for k in ('reviewer', 'at', 'note', 'checkResults', 'importantReview') if k in r}
                         for r in item.get('reviews', []) if r.get('visibility') == '공유']
    result['completionHistory'] = [{k: r[k] for k in ('actualCompletedOn', 'recordedAt', 'completedBy', 'summary', 'summaryOmitted', 'omissionConfirmed', 'reopenedAt', 'reopenedBy', 'reopenReason') if k in r}
                                   for r in item.get('completionHistory', []) if r.get('visibility') == '공유']
    result['predecessors'] = [v for v in result.get('predecessors', []) if v in ids]
    if result.get('parent') not in ids:
        result['parent'] = ''
    if result.get('parentTaskId') not in ids:
        result['parentTaskId'] = ''
    return result


def filter_state(state, user):
    if state is None or user['role'] == 'admin' and user.get('company') == 'momos':
        return state
    items = visible_items(state, user)
    ids = {item['id'] for item in items}
    result = {k: state.get(k) for k in ('schemaVersion', 'revision', 'createdAt', 'updatedAt')}
    regular_ids=regular_visible_ids(state,user)
    followups=visible_followups(state,user)
    for key in ('tasks', 'wbs'):
        result[key] = [dict(safe_task(item, ids), hierarchyContext=hierarchy_context(state, item)) for item in state.get(key, []) if item['id'] in ids]
        for index,item in enumerate(result[key]):
            if item['id'] not in regular_ids:
                r=next(r for r in followups if r['taskId']==item['id'])
                result[key][index]={'id':item['id'],'kind':'followup_context','title':r.get('taskTitle','요청 업무'),'completionCriteria':r.get('taskCriteria',''),'status':item.get('status',''),'active':False,'managed':False,'owner':'','owners':[],'visibility':'request_only','sourceRefs':[],'evidenceIds':[],'replies':[],'reviews':[],'completionHistory':[],'requestContextOnly':True}
    for key in ('evidence', 'sources', 'requirements', 'weeks', 'issues', 'requests', 'integrations', 'events', 'imports', 'dailyPlans', 'meetings', 'publications'):
        result[key] = []
    result['sourceIdMap'] = {}
    result['followups']=copy.deepcopy(followups)
    result['people'] = [{k: p.get(k) for k in ('name', 'role', 'org', 'title', 'confirmed', 'active')}
                        for p in state.get('people', []) if p.get('confirmed') and p.get('active')]
    result['files'] = []
    for file in state.get('files', []):
        contexts = file_context_ids(state, user, file)
        if not contexts:
            continue
        safe_file = {k: file.get(k) for k in ('id', 'name', 'size', 'sha256', 'addedAt', 'addedBy')}
        safe_file['taskId'] = file.get('taskId') if file.get('taskId') in contexts else ''
        safe_file['linkedTaskIds'] = sorted(contexts - {safe_file['taskId']})
        result['files'].append(safe_file)
    ids=regular_ids  # A request recipient receives no other task discussions or plans.
    def snapshots(values):
        answer = []
        for value in values:
            if value.get('taskId', value.get('id')) not in ids:
                continue
            row = safe_task(value, ids)
            row['taskId'] = value.get('taskId', value.get('id'))
            answer.append(row)
        return answer
    def decisions(values):
        return [{k: d[k] for k in ('wbsId', 'status', 'decision') if k in d}
                for d in values if d.get('wbsId') in ids]
    for week in state.get('weeks', []):
        row = {k: week[k] for k in ('weekOf', 'status', 'createdAt', 'updatedAt', 'confirmedAt', 'confirmedBy') if k in week}
        row.update(draft=snapshots(week.get('draft', [])), baseline=snapshots(week.get('baseline', [])),
                   amendments=[], coverageDecisions=decisions(week.get('coverageDecisions', [])),
                   baselineCoverageDecisions=decisions(week.get('baselineCoverageDecisions', [])),
                   coverageHistory=[], note='')
        for change in week.get('amendments', []):
            amendment = {k: change[k] for k in ('revision', 'at', 'actor') if k in change}
            amendment.update(snapshot=snapshots(change.get('snapshot', [])), reason='',
                             coverageDecisions=decisions(change.get('coverageDecisions', [])),
                             changes={k: [v for v in change.get('changes', {}).get(k, []) if v in ids] for k in ('added', 'removed', 'changed')})
            row['amendments'].append(amendment)
        result['weeks'].append(row)
    issue_fields = ('id', 'title', 'taskId', 'owner', 'due', 'originalDue', 'status', 'description',
                    'resolutionCriteria', 'nextAction', 'nextDue', 'openedAt', 'openedBy',
                    'updatedAt', 'resolvedAt', 'resolvedBy', 'resolution', 'visibility')
    for issue in state.get('issues', []):
        if issue.get('taskId') not in ids or issue.get('visibility') != '공유':
            continue
        row = {k: copy.deepcopy(issue[k]) for k in issue_fields if k in issue}
        row.update(evidenceRefs=[], history=[], note='', replies=[
            {k: reply[k] for k in ('actor', 'at', 'text') if k in reply}
            for reply in issue.get('replies', []) if reply.get('visibility') == '공유'])
        result['issues'].append(row)
    for integration in state.get('integrations', []):
        if integration.get('taskId') not in ids or integration.get('visibility') != '공유':
            continue
        row = {k: copy.deepcopy(integration[k]) for k in ('id', 'title', 'channel', 'dataType', 'owner', 'taskId', 'stage', 'readiness', 'forecastDue', 'createdAt', 'updatedAt', 'visibility') if k in integration}
        row.update(parent=integration.get('parent') if integration.get('parent') in ids else '', sourceRefs=[], testEvidence=[],
                   note='', testResult='', evidence='', requirements=[])
        share_new_content = integration.get('sharedContent') is True
        for key in ('note', 'testResult', 'evidence'):
            if (share_new_content or key in integration.get('sharedFields', [])) and isinstance(integration.get(key), str):
                row[key] = integration[key]
        for requirement in integration.get('requirements', []):
            child = {k: requirement[k] for k in ('id', 'title', 'owner', 'due', 'status') if k in requirement}
            child.update(sourceRefs=[], note=requirement.get('note', '') if share_new_content or 'requirements' in integration.get('sharedFields', []) else '')
            row['requirements'].append(child)
        result['integrations'].append(row)
    result['requests'] = [{k: r[k] for k in ('id', 'taskId', 'oldDue', 'oldStart', 'newDue', 'newStart', 'reason', 'impact', 'actor', 'requestedAt', 'status', 'reviewedBy', 'reviewedAt', 'reviewNote', 'impactNote') if k in r}
                          for r in state.get('requests', []) if r.get('taskId') in ids and r.get('visibility') == '공유']
    result['dailyPlans'] = []
    for p in state.get('dailyPlans', []):
        if p.get('taskId') not in ids or p.get('visibility') != '공유' or p.get('kind') == 'followup':
            continue
        row = {k: p[k] for k in ('id', 'kind', 'day', 'taskId', 'owner', 'owners', 'outcome', 'committedAt', 'committedBy') if k in p}
        row['results'] = [{k: r[k] for k in ('at', 'actor', 'result', 'remaining', 'blocker') if k in r} for r in p.get('results', [])]
        result['dailyPlans'].append(row)
    result['settings'] = {k: copy.deepcopy(v) for k, v in state.get('settings', {}).items()
                          if k in ('timezone', 'projectStart', 'pilotStart', 'productionMonth', 'weeklyMeeting', 'notificationTimes', 'escalationTime', 'holidaysExcluded', 'holidayDates', 'holidayCalendarVerifiedFrom', 'holidayCalendarVerifiedThrough', 'holidaySources', 'reviewPolicy', 'adminNames', 'supplierLead')}
    result['accessScope'] = 'explicitly_shared'
    return result


def filter_notifications(value, state, user):
    if user['role'] == 'admin':
        return value
    clean = filter_state(state, user)
    task_ids = {x['id'] for x in clean.get('tasks', []) + clean.get('wbs', [])}
    issue_ids = {x['id'] for x in clean.get('issues', [])}
    allowed_titles = {'오늘 할 일·미결 확인', '마감 확인: 기한·미응답·미결·완료 보고·확정 조건', '오늘 완료·변경된 내용이 있으면 업무에 반영해 주세요', '요청 답변·제출자료 확인', '업무·자료 요청에 답변해 주세요', '회신 기한 경과·미응답 요청 확인', '업무가 배정되었습니다', '요청 내용이 보완되었습니다'}
    result = {'items': [], 'calendarStatus': value.get('calendarStatus', {})}
    for item in value.get('items', []):
        if user['name'] not in item.get('recipients', []):
            continue
        tasks = [i for i in item.get('taskIds', []) if i in task_ids]
        issues = [i for i in item.get('issueIds', []) if i in issue_ids]
        if not tasks and not issues:
            continue
        row = {k: item[k] for k in ('id', 'day', 'slot', 'createdAt') if k in item}
        row.update(title=item.get('title') if item.get('title') in allowed_titles else '업무 확인 알림',
                   recipients=[user['name']], taskIds=tasks, issueIds=issues,
                   readBy=[user['name']] if user['name'] in item.get('readBy', []) else [])
        result['items'].append(row)
    return result


def authorize_action(state, user, action, access):
    if not isinstance(action, dict) or not isinstance(action.get('type'), str) or 'payload' in action:
        raise ValueError('유효한 업무 변경 요청이 필요합니다.')
    kind = action['type']
    if user['role'] == 'viewer':
        raise PermissionError()
    items = state.get('tasks', []) + state.get('wbs', [])
    target = next((row for row in items if row['id'] == action.get('taskId')), None)
    if kind == 'schedule.set' and not (user['role'] == 'admin' and user['company'] == 'momos' and user['name'] in ADMINS):
        raise PermissionError('모모스커피 내부 관리자만 일정을 직접 수정할 수 있습니다.')
    if target and target.get('internalOnly') and user.get('company') != 'momos':
        raise PermissionError('모모스커피 내부 업무입니다.')
    destination=next((t for t in items if t['id']==(action.get('parentTaskId') or action.get('patch',{}).get('parentTaskId'))),None)
    if destination and destination.get('internalOnly') and user.get('company')!='momos':
        raise PermissionError('모모스커피 내부 업무입니다.')
    if kind in ('task.create','task.update') and ((target and target.get('internalOnly')) or (destination and destination.get('internalOnly'))):
        owner_values=action.get('patch',{}) if kind=='task.update' else action
        if 'owner' in owner_values or 'owners' in owner_values or destination:
            proposed=set(owner_values.get('owners',target.get('owners',[]) if target else []))|{owner_values.get('owner',target.get('owner','') if target else '')}
            internal_people={p.get('name') for p in state.get('people',[]) if p.get('org')=='모모스커피'}
            if (proposed-{None,''})-internal_people:
                raise PermissionError('내부 요청·팔로업은 모모스커피 담당자에게 배정해 주세요.')
    if kind == 'task.complete' and 'assignment' in action:
        assignment = action['assignment']
        if not isinstance(assignment, dict) or set(assignment) - {'owner','owners','reason','confirmPeople'}:
            raise ValueError('완료 시 담당 지정 내용을 확인해 주세요.')
        if target and (target.get('owner') or target.get('owners')):
            raise ValueError('담당자가 이미 지정되었습니다. 업무를 다시 열어 확인해 주세요.')
        if not isinstance(assignment.get('owner', ''), str) or not isinstance(assignment.get('owners', []), list) or not all(isinstance(n, str) for n in assignment.get('owners', [])) or not isinstance(assignment.get('confirmPeople', []), list):
            raise ValueError('담당자는 이름 목록으로 지정해 주세요.')
        # Apply exactly the same company, role and WBS rules as a separate assignment.
        authorize_action(state, user, dict(type='task.update', taskId=action.get('taskId'),
            patch=dict(owner=assignment.get('owner', ''), owners=assignment.get('owners', [])),
            reason=assignment.get('reason', ''), confirmPeople=assignment.get('confirmPeople', [])), access)
    wbs_target=target and any(t['id']==target['id'] for t in state.get('wbs',[]))
    if kind.startswith('schedule.') and not target:
        request=next((r for r in state.get('requests',[]) if r['id']==action.get('requestId')),None)
        wbs_target=request and any(t['id']==request.get('taskId') for t in state.get('wbs',[]))
    wbs_work_update = kind == 'task.update' and set(action.get('patch', {})) <= {'status','progressPercent','forecastDue','reply','note','nextAction','blocker'}
    wbs_performance = wbs_target and target and may_perform(target,user,state) and (kind in ('task.complete','task.reopen') or wbs_work_update)
    if wbs_target and not wbs_performance and not kind.startswith('followup.') and kind not in ('attachment.add','attachment.link','schedule.request','day.commit','day.result') and not (user['role']=='admin' and user['company']=='momos' and user['name'] in ADMINS):
        raise PermissionError('WBS 변경은 모모스커피 관리자만 할 수 있습니다.')
    if kind == 'attachment.link':
        if not target or target['id'] not in visible_ids(state, user) or not (may_perform(target, user, state) or request_recipient(state, user, target['id'])):
            raise PermissionError('수행 중인 업무 또는 받은 요청에만 자료를 연결할 수 있습니다.')
        file = next((f for f in state.get('files', []) if f.get('id') == action.get('fileId')), None)
        if not file or not access.file_allowed(user, file['id'], state):
            raise PermissionError('현재 열람할 수 있는 등록 자료만 다시 사용할 수 있습니다.')
        return
    if kind.startswith('followup.'):
        if kind=='followup.create':
            if user['role'] not in ('admin','lead','member') or (action.get('taskId') and (not target or target['id'] not in regular_visible_ids(state,user))):
                raise PermissionError()
            recipient=next((u for u in access.users() if u['id']==action.get('recipientId') and u['status']=='active' and u['role']!='viewer'),None)
            if not recipient:
                raise ValueError('초대 가입을 마친 담당자를 선택해 주세요.')
            if target and target.get('internalOnly') and recipient.get('company')!='momos':
                raise PermissionError('내부 업무 요청은 모모스커피 담당자에게 연결해 주세요.')
            if action.get('assignTask') is True and (not target or user['role']=='member' or not may_perform(target,user,state)):
                raise PermissionError('업무 요청은 가능하지만 수행 담당 변경은 관리자·책임자가 합니다.')
            if user['role']=='lead' and recipient['company']!=user['company'] and action.get('assignTask') is True:
                raise ValueError('다른 회사 참여자에게는 요청만 보낼 수 있습니다. 업무 수행 담당 변경은 관리자에게 요청해 주세요.')
            action['recipientName']=recipient['name'];action['requestedById']=user['id']
            if user['role']!='admin' and action.get('shareTask'):
                raise PermissionError()
        else:
            request=next((r for r in state.get('followups',[]) if r['id']==action.get('requestId')),None)
            if not request:
                raise PermissionError()
            request_task=next((t for t in items if t['id']==request.get('taskId')),None)
            if request_task and request_task.get('internalOnly') and user.get('company')!='momos':
                raise PermissionError('모모스커피 내부 업무입니다.')
            if kind=='followup.respond':
                if request['recipientId']!=user['id']:
                    raise PermissionError()
                if not isinstance(action.get('fileIds', []), list):
                    raise ValueError('회신 자료는 목록으로 지정해 주세요.')
                for ident in action.get('fileIds', []):
                    if not any(f.get('id') == ident for f in state.get('files', [])) or not access.file_allowed(user, ident, state):
                        raise PermissionError('현재 열람할 수 있는 등록 자료만 회신할 수 있습니다.')
            elif kind in ('followup.remind','followup.resolve','followup.cancel','followup.clarify'):
                if user['role']!='admin' and request['requestedById']!=user['id']:
                    raise PermissionError()
            else:
                raise PermissionError()
        return
    if kind == 'task.create' and user['role'] == 'member':
        parent_id, execution_id = action.get('parent'), action.get('parentTaskId')
        if bool(parent_id) == bool(execution_id):
            raise PermissionError('본인에게 배정된 상위 업무 하나를 지정해 주세요.')
        parent = next((t for t in (state.get('wbs', []) if parent_id else state.get('tasks', [])) if t['id'] == (parent_id or execution_id)), None)
        if not parent or parent.get('visibility') != '공유' or not assigned(parent, user) or parent.get('parentTaskId'):
            raise PermissionError('본인에게 배정된 공유 업무 아래에만 세부 업무를 만들 수 있습니다.')
        names = {action.get('owner')} | set(action.get('owners', []))
        if names - {None, ''} != {user['name']}:
            raise PermissionError('직접 만드는 세부 업무는 본인에게만 배정할 수 있습니다.')
        if action.get('visibility', '공유') != '공유' or action.get('sourceRefs') or action.get('wbsLinkApproved') or action.get('importantReview') or action.get('reviewChecklist'):
            raise PermissionError('공개 범위·원문 근거·관리자 확인 기준은 변경할 수 없습니다.')
        return
    if user['role'] != 'admin':
        if kind.startswith('issue.'):
            if kind not in ('issue.create', 'issue.update', 'issue.resolve', 'issue.reopen'):
                raise PermissionError()
            issue = None if kind == 'issue.create' else next((i for i in state.get('issues', []) if i.get('id') == action.get('issueId')), None)
            if kind != 'issue.create':
                if not issue or issue.get('visibility') != '공유':
                    raise PermissionError()
                target = next((r for r in items if r['id'] == issue.get('taskId')), None)
            if not target or target['id'] not in visible_ids(state, user):
                raise PermissionError()
            if kind == 'issue.create':
                if not may_perform(target, user, state) or action.get('owner', user['name']) not in ('', user['name']):
                    raise PermissionError('본인의 미결 업무로 등록해 주세요.')
                action['owner'] = user['name']
            elif not (issue.get('owner') == user['name'] or user['role'] == 'lead' and may_perform(target, user, state)):
                raise PermissionError()
            if kind == 'issue.update':
                if set(action.get('patch', {})) - {'title', 'due', 'description', 'resolutionCriteria', 'nextAction', 'nextDue', 'reply', 'note'}:
                    raise PermissionError('미결의 담당자·연결 업무는 관리자가 변경합니다.')
            if action.get('evidenceRefs') or action.get('sourceRefs'):
                raise PermissionError()
            return
        if kind.startswith('integration.'):
            if kind not in ('integration.create', 'integration.update') or kind == 'integration.create' and user['role'] != 'lead':
                raise PermissionError()
            integration = None if kind == 'integration.create' else next((i for i in state.get('integrations', []) if i.get('id') == action.get('integrationId')), None)
            if kind == 'integration.update':
                if not integration or integration.get('visibility') != '공유':
                    raise PermissionError()
                target = next((r for r in items if r['id'] == integration.get('taskId')), None)
                if user['role'] == 'member' and integration.get('owner') != user['name']:
                    raise PermissionError()
            if not target or not may_perform(target, user, state) or target['id'] not in visible_ids(state, user):
                raise PermissionError()
            values = action.get('patch', {}) if kind == 'integration.update' else action
            if kind == 'integration.update' and set(values) - {'title', 'channel', 'dataType', 'requirements', 'stage', 'forecastDue', 'note', 'testResult', 'readiness', 'evidence'}:
                raise PermissionError('연동 담당자·연결 업무는 관리자가 변경합니다.')
            if kind == 'integration.create':
                if values.get('owner', user['name']) not in ('', user['name']) or values.get('parent') and values['parent'] not in visible_ids(state, user):
                    raise PermissionError()
                action['owner'] = user['name']
            if values.get('sourceRefs') or values.get('testEvidence') or isinstance(values.get('evidence'), list):
                raise PermissionError()
            def has_refs(value):
                if isinstance(value, dict):
                    return any(k in ('sourceRefs', 'testEvidence') and v or has_refs(v) for k, v in value.items())
                if isinstance(value, list):
                    return any(has_refs(v) for v in value)
                return False
            if has_refs(values.get('requirements')):
                raise PermissionError()
            return
        allowed = {'task.update', 'task.complete', 'task.reopen', 'schedule.request', 'attachment.add', 'day.commit', 'day.result'}
        if user['role'] == 'lead':
            allowed |= {'task.create'}
        if kind not in allowed:
            raise PermissionError('관리자가 처리하는 작업입니다.')
        if kind == 'task.create':
            if action.get('visibility', '공유') != '공유' or action.get('sourceRefs') or action.get('wbsLinkApproved'):
                raise PermissionError()
        elif target is None or target['id'] not in visible_ids(state, user):
            raise PermissionError()
        if target and not may_perform(target, user, state) and not (kind=='attachment.add' and request_recipient(state,user,target['id'])):
            raise PermissionError()
        if kind == 'task.update':
            fields = {'status', 'forecastDue', 'note', 'nextAction', 'blocker', 'reply'}
            if wbs_target: fields |= {'progressPercent'}
            if user['role'] == 'lead':
                fields |= {'owner', 'owners', 'title', 'completionCriteria', 'priority', 'active', 'managed'}
            if set(action.get('patch', {})) - fields:
                raise PermissionError()
        owner_input = action.get('patch', {}) if kind == 'task.update' else action
        if user['role'] == 'lead' and ('owner' in owner_input or 'owners' in owner_input):
            organization = company_name(user['company'])
            team = {p.get('name') for p in state.get('people', []) if p.get('org') == organization and p.get('confirmed') and p.get('active')}
            proposed = {owner_input.get('owner')} | set(owner_input.get('owners', []))
            if (proposed - {None, ''}) - team:
                raise PermissionError('소속 업무 담당자만 배정할 수 있습니다.')
        parent_task_id=action.get('parentTaskId') or action.get('patch',{}).get('parentTaskId')
        if parent_task_id:
            execution_parent=next((t for t in items if t['id']==parent_task_id),None)
            if not execution_parent or parent_task_id not in visible_ids(state,user) or not may_perform(execution_parent,user,state): raise PermissionError()
        if action.get('parent') and action['parent'] not in visible_ids(state, user):
            raise PermissionError()
        if action.get('evidenceRefs') or action.get('sourceRefs'):
            raise PermissionError('공유 승인된 첨부 파일 또는 확인 답변을 사용해 주세요.')
    if kind == 'attachment.add':
        value = action.get('file', {})
        ident = value.get('id')
        with access.store.connect() as db:
            row = db.execute('SELECT f.*,a.user_id,a.task_id FROM files f JOIN file_access a ON a.file_id=f.id WHERE f.id=?', (ident,)).fetchone()
        if not row or row['task_id'] != action.get('taskId') or (user['role'] != 'admin' and row['user_id'] != user['id']):
            raise PermissionError('이 업무에 업로드한 파일만 연결할 수 있습니다.')
        for field in ('name', 'size', 'sha256'):
            if value.get(field) != row[field]:
                raise ValueError('첨부 파일 정보가 저장된 원본과 다릅니다.')


def mark_shared_changes(before, after):
    """Only new entries from authenticated actions are shared; old unreviewed notes stay private."""
    for key in ('tasks', 'wbs'):
        previous = {item['id']: item for item in before.get(key, [])}
        for item in after.get(key, []):
            if item.get('visibility') != '공유':
                continue
            for collection in ('replies', 'reviews', 'completionHistory', 'progressHistory'):
                old_count = len(previous.get(item['id'], {}).get(collection, []))
                for entry in item.get(collection, [])[old_count:]:
                    entry['visibility'] = '공유'
    old_files = {f['id'] for f in before.get('files', [])}
    for item in after.get('files', []):
        if item['id'] not in old_files:
            item['visibility'] = '공유'
    shared_ids = {r['id'] for r in after.get('tasks', []) + after.get('wbs', []) if r.get('visibility') == '공유'}
    for collection in ('requests', 'dailyPlans'):
        previous = {r['id'] for r in before.get(collection, [])}
        for item in after.get(collection, []):
            if item['id'] not in previous and item.get('taskId') in shared_ids:
                item['visibility'] = '공유'
    for collection in ('issues', 'integrations'):
        previous = {r['id']: r for r in before.get(collection, [])}
        for item in after.get(collection, []):
            old = previous.get(item['id'])
            if item.get('taskId') not in shared_ids:
                continue
            if old is None:
                item['visibility'] = '공유'
                if collection == 'integrations':
                    item['sharedContent'] = True
            elif collection == 'integrations' and item.get('visibility') == '공유':
                fields = set(old.get('sharedFields', []))
                fields.update(key for key in ('note', 'testResult', 'evidence', 'requirements') if item.get(key) != old.get(key))
                item['sharedFields'] = sorted(fields)
            if collection == 'issues' and item.get('visibility') == '공유':
                for reply in item.get('replies', [])[len(old.get('replies', [])) if old else 0:]:
                    reply['visibility'] = '공유'
