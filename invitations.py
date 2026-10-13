"""Email-bound, single-use local invitations; SMTP is explicitly configured."""
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import ssl
import time
from email.message import EmailMessage
from urllib.parse import urlsplit

import access


class Invitations:
    def __init__(self, auth):
        self.auth, self.store = auth, auth.store
        with self.store.connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS invitations(
                id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,company TEXT NOT NULL,
                role TEXT NOT NULL,department TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,
                status TEXT NOT NULL,created_by TEXT NOT NULL,created_at REAL NOT NULL,
                expires_at REAL NOT NULL,accepted_at REAL,delivery TEXT NOT NULL);''')

    @staticmethod
    def admin(user):
        if not user or user['role'] != 'admin':
            raise PermissionError('관리자만 초대를 관리합니다.')

    @staticmethod
    def config(*, invitation=False):
        base = os.environ.get('ERP_INVITE_BASE_URL', '').rstrip('/')
        parsed = urlsplit(base)
        public = parsed.scheme == 'https' and bool(parsed.hostname) and parsed.hostname not in ('localhost', '127.0.0.1', '::1') and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
        configured = bool(os.environ.get('ERP_SMTP_HOST') and os.environ.get('ERP_SMTP_FROM'))
        credentials = not os.environ.get('ERP_SMTP_USER') or bool(os.environ.get('ERP_SMTP_PASSWORD'))
        flag = os.environ.get('ERP_ENABLE_INVITE_EMAIL', os.environ.get('ERP_ENABLE_EMAIL', '0')) if invitation else os.environ.get('ERP_ENABLE_EMAIL', '0')
        enabled = os.environ.get('ERP_CLOUD_MODE') != '1' or flag == '1'
        mail = bool(configured and credentials and enabled)
        if not public:
            message = '공개 HTTPS 초대 주소를 설정해 주세요. 현재는 로컬에서만 사용할 수 있는 링크를 생성합니다.'
        elif not configured:
            message = '운영 초대 링크를 만들 수 있습니다. 메일 발송을 사용하려면 발신 계정을 연결해 주세요.'
        elif not credentials:
            message = '운영 초대 링크를 만들 수 있습니다. 메일 발신 계정의 인증정보 입력이 필요합니다.'
        elif not enabled:
            message = '운영 초대 링크를 만들 수 있습니다. 초대 메일 발송은 아직 활성화하지 않았습니다.'
        else:
            message = '운영 초대 링크와 초대 메일을 사용할 수 있습니다.'
        return {'publicUrlReady': public, 'mailReady': mail, 'canSend': bool(public and mail),
                'mode': 'email' if public and mail else 'public_link' if public else 'local_link',
                'message': message}

    @staticmethod
    def safe(row):
        value = {k: row[k] for k in ('id', 'email', 'name', 'company', 'role', 'department', 'status', 'created_at', 'expires_at', 'accepted_at', 'delivery')}
        if value['status'] == 'pending' and value['expires_at'] <= time.time():
            value['status'] = 'expired'
        return value

    def list(self, user):
        self.admin(user)
        with self.store.connect() as db:
            return {'items': [self.safe(r) for r in db.execute('SELECT * FROM invitations ORDER BY created_at DESC')], 'config': self.config(invitation=True)}

    def create(self, user, value, local_base):
        self.admin(user)
        name, email = str(value.get('name', '')).strip(), str(value.get('email', '')).strip().lower()
        company, role = value.get('company', 'momos'), value.get('role', 'member')
        department = str(value.get('department', '')).strip()
        if not name or len(name) > 60 or len(email) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email) or len(department) > 100:
            raise ValueError('초대할 이름·이메일·부서를 확인해 주세요.')
        if not isinstance(company, str) or company not in self.auth.companies() or role not in access.ROLES:
            raise ValueError('소속과 역할을 확인해 주세요.')
        if role == 'admin' and (name not in access.ADMINS or company != 'momos'):
            raise ValueError('관리자는 고성운·최상민·채수민만 지정할 수 있습니다.')
        sending = value.get('sendEmail') is True
        config = self.config(invitation=True)
        if sending and not config['canSend']:
            raise ValueError(config['message'])
        ident, token, created = secrets.token_hex(16), secrets.token_urlsafe(32), time.time()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT 1 FROM access_users WHERE email=? OR name=?', (email, name)).fetchone():
                raise ValueError('이미 등록된 계정입니다. 계정 관리에서 권한을 확인해 주세요.')
            db.execute("UPDATE invitations SET status='cancelled' WHERE email=? AND status='pending'", (email,))
            db.execute('INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                       (ident, email, name, company, role, department, hashlib.sha256(token.encode()).hexdigest(), 'pending', user['id'], created, created + 72*3600, None, 'not_sent'))
            db.execute('INSERT INTO access_audit(at,actor_id,kind,target_id,detail) VALUES(?,?,?,?,?)',
                       (created,user['id'],'invitation.create',ident,json.dumps({'email':email,'role':role,'company':company})))
        base = os.environ.get('ERP_INVITE_BASE_URL', '').rstrip('/') if config['publicUrlReady'] else local_base
        link = base + '/#invite=' + token
        delivery = 'not_sent'
        if sending:
            try:
                self.send_email(email, name, link)
                delivery = 'sent'
            except (OSError, smtplib.SMTPException, ValueError):
                delivery = 'failed'
            with self.store.connect() as db:
                db.execute('UPDATE invitations SET delivery=? WHERE id=?', (delivery, ident))
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM invitations WHERE id=?', (ident,)).fetchone()
        return {'invitation': self.safe(row), 'link': link, 'config': config,
                'message': '초대 메일을 발송했습니다.' if delivery == 'sent' else '메일 발송에 실패했습니다. 발송 설정을 확인해 주세요.' if delivery == 'failed' else '초대 링크를 만들었습니다. 메일은 발송하지 않았습니다.'}

    @staticmethod
    def send_email(email, name, link):
        sender = os.environ['ERP_SMTP_FROM']
        if '\n' in sender or '\r' in sender:
            raise ValueError('Invalid mail sender')
        message = EmailMessage()
        message['From'], message['To'], message['Subject'] = sender, email, 'MOMOS ERP 프로젝트 초대'
        message.set_content(f'{name}님, MOMOS ERP 프로젝트에 초대되었습니다.\n\n아래 링크에서 비밀번호를 설정하면 초대된 권한으로 참여할 수 있습니다.\n{link}\n\n링크는 72시간 동안 한 번 사용할 수 있습니다.')
        Invitations.send_message(message, invitation=True)

    @staticmethod
    def send_password_reset(email, link):
        message = EmailMessage()
        message['From'], message['To'], message['Subject'] = os.environ['ERP_SMTP_FROM'], email, 'MOMOS ERP 비밀번호 재설정'
        message.set_content('비밀번호 재설정을 요청하셨습니다. 아래 링크에서 새 비밀번호를 설정해 주세요.\n'+link+'\n\n1시간 동안 한 번 사용할 수 있습니다. 요청하지 않았다면 이 메일을 무시해 주세요.')
        Invitations.send_message(message)

    @staticmethod
    def send_message(message, *, signup=False, invitation=False):
        host, port = os.environ['ERP_SMTP_HOST'], int(os.environ.get('ERP_SMTP_PORT', '587'))
        flag = os.environ.get('ERP_ENABLE_SIGNUP_EMAIL', '0') if signup else os.environ.get('ERP_ENABLE_INVITE_EMAIL', os.environ.get('ERP_ENABLE_EMAIL', '0')) if invitation else os.environ.get('ERP_ENABLE_EMAIL', '0')
        if os.environ.get('ERP_CLOUD_MODE') == '1' and flag != '1':
            raise ValueError('실제 이메일 발송은 활성화 전입니다.')
        context = ssl.create_default_context()
        client = smtplib.SMTP_SSL(host, port, timeout=15, context=context) if port == 465 else smtplib.SMTP(host, port, timeout=15)
        with client:
            if port != 465:
                client.starttls(context=context)
            if os.environ.get('ERP_SMTP_USER'):
                client.login(os.environ['ERP_SMTP_USER'], os.environ.get('ERP_SMTP_PASSWORD', ''))
            return client.send_message(message)

    def info(self, token):
        if not isinstance(token, str) or not 32 <= len(token) <= 128:
            raise ValueError('초대 링크가 유효하지 않습니다.')
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM invitations WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        if not row or row['status'] != 'pending' or row['expires_at'] <= time.time():
            raise ValueError('만료되었거나 이미 사용·취소된 초대입니다. 관리자에게 새 초대를 요청해 주세요.')
        return self.safe(row)

    def accept(self, value):
        invitation = self.info(value.get('token'))
        if str(value.get('email', '')).strip().lower() != invitation['email']:
            raise ValueError('초대된 이메일로만 가입할 수 있습니다.')
        if any(k in value for k in ('role','company','name')):
            raise ValueError('초대된 소속·역할·이름은 가입자가 변경할 수 없습니다.')
        password = value.get('password', '')
        access.validate_password(password)
        ident, salt = secrets.token_hex(16), secrets.token_hex(16)
        digest, at = access.password_hash(password, salt), time.time()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT * FROM invitations WHERE id=?', (invitation['id'],)).fetchone()
            if not row or row['status'] != 'pending' or row['expires_at'] <= at:
                raise ValueError('이미 처리되었거나 만료된 초대입니다.')
            if db.execute('SELECT 1 FROM access_users WHERE name=? OR email=?', (row['name'],row['email'])).fetchone():
                raise ValueError('이미 등록된 계정입니다. 로그인해 주세요.')
            db.execute('INSERT INTO access_users VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       (ident,row['name'],row['email'],digest,salt,row['role'],row['company'],row['department'],'','active',at,at))
            db.execute("UPDATE invitations SET status='accepted',accepted_at=? WHERE id=?", (at, row['id']))
            db.execute('INSERT INTO access_audit(at,actor_id,kind,target_id,detail) VALUES(?,?,?,?,?)', (at,ident,'invitation.accept',row['id'],'{}'))
            return access.public_user(db.execute('SELECT * FROM access_users WHERE id=?', (ident,)).fetchone())

    def cancel(self, user, ident):
        self.admin(user)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT status FROM invitations WHERE id=?', (ident,)).fetchone()
            if not row:
                raise FileNotFoundError()
            if row['status'] == 'accepted':
                raise ValueError('가입된 계정은 계정 관리에서 이용을 중지해 주세요.')
            db.execute("UPDATE invitations SET status='cancelled' WHERE id=?", (ident,))
            db.execute('INSERT INTO access_audit(at,actor_id,kind,target_id,detail) VALUES(?,?,?,?,?)', (time.time(),user['id'],'invitation.cancel',ident,'{}'))
        return {'status':'cancelled'}
