"""Momos onboarding LMS HTTP server.

Serves the onboarding pages and APIs, shared account routes and the manual wiki.
Derived from the momos-workspace ERP server; ERP, PI, imports, mail, WBS and
backup routes were removed. Every private API still checks the session, the
CSRF token and the onboarding service's own permissions.
"""
import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import socket
import time
import sqlite3
import sys
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

import access
import invitations
import lms_store

APP = Path(__file__).resolve().parent
STATIC = {"styles.css", "auth.js", "workspace_items.js", "wds/web/variables.css", "assets/momos-white.png", "assets/momos-black.png",
          "assets/PretendardVariable.woff2", "assets/Pretendard-LICENSE.txt", "icons/momos-erp.svg",
          "icons/momos-erp-192.png", "icons/momos-erp-512.png", "icons/apple-touch-icon.png"}
mimetypes.add_type('font/woff2', '.woff2')
MAX_BODY = 20 * 1024 * 1024


def now():
    return datetime.now(timezone.utc).isoformat()


def safe_path(root, value):
    root = Path(root).resolve()
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = candidate.resolve(strict=True)
    if not candidate.is_relative_to(root) or not candidate.is_file():
        raise ValueError("Path outside permitted root")
    # Refuse even internal symbolic links / junctions along an input path.
    raw = Path(value) if Path(value).is_absolute() else root / value
    for part in (raw, *raw.parents):
        if part == root:
            break
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise ValueError("Linked paths are not served")
    return candidate



class Store:
    """Local SQLite or cloud PostgreSQL rows plus uploaded file objects."""

    def __init__(self, data, root=None, *, database=None, objects=None):
        self.database, self.objects = database, objects
        self.data = Path(data).resolve()
        self.root = Path(root).resolve() if root else self.data
        self.data.mkdir(parents=True, exist_ok=True)
        (self.data / "uploads").mkdir(exist_ok=True)
        self.db = self.data / "lms.sqlite3"
        if database is None:
            with self.connect() as db:
                db.executescript('''
                CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,name TEXT,size INTEGER,sha256 TEXT,created TEXT);
                CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY,body TEXT);
                ''')

    @contextmanager
    def connect(self):
        if self.database is not None:
            with self.database.connect() as db:
                yield db
            return
        db = sqlite3.connect(self.db, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def upload(self, name, content):
        if not name or len(name) > 240 or any(c in name for c in '/\\\x00\r\n') or name in ('.', '..'):
            raise ValueError("Invalid filename")
        if len(content) > MAX_BODY:
            raise ValueError("File exceeds 20 MB")
        ident = uuid.uuid4().hex
        digest = hashlib.sha256(content).hexdigest()
        (self.data / "uploads" / ident).write_bytes(content)
        if self.objects:
            self.objects.put('uploads', ident, content)
        with self.connect() as db:
            db.execute("INSERT INTO files VALUES(?,?,?,?,?)", (ident, name, len(content), digest, now()))
        return {"id": ident, "name": name, "size": len(content), "sha256": digest}

    def upload_file(self, ident):
        with self.connect() as db:
            row = db.execute('SELECT sha256 FROM files WHERE id=?', (ident,)).fetchone()
        if not row:
            raise FileNotFoundError('Unknown file')
        if self.objects:
            return self.objects.cache(self.data, 'uploads', ident, row[0])
        return safe_path(self.data / 'uploads', ident)


class Handler(BaseHTTPRequestHandler):
    server_version = 'MomosLMS/1'

    def log_message(self, fmt, *args):
        # Never log query strings, filenames, or uploaded content.
        sys.stderr.write('%s %s\n' % (now(), self.command))

    def guard(self, mutation=False):
        port = self.server.server_port
        public = getattr(self.server, 'public_url', '')
        if not mutation and urlsplit(self.path).path == '/api/health':
            return  # platform probes call this with their own Host (localhost, pod IP); it reveals nothing private
        if public:
            if self.headers.get('Host') != urlsplit(public).netloc:
                raise PermissionError('Invalid Host')
            if mutation and self.headers.get('Origin') != public:
                raise PermissionError('Same-origin browser request required')
            if mutation and self.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise PermissionError('Cross-site request refused')
            return
        if getattr(self.server, 'trial', False):
            # Internal staging without a fixed public URL: accept the ingress host, but still refuse
            # cross-site writes by requiring the Origin host to match the Host header.
            if mutation and urlsplit(self.headers.get('Origin', '')).netloc != self.headers.get('Host', ''):
                raise PermissionError('Same-origin browser request required')
            return
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        if self.headers.get('Host') not in hosts:
            raise PermissionError('Invalid Host')
        if mutation and self.headers.get('Origin') != 'http://' + self.headers.get('Host', ''):
            raise PermissionError('Same-origin browser request required')
        if mutation and self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise PermissionError('Cross-site request refused')

    def send(self, code, obj, cookie=None):
        body = json.dumps(obj, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('X-Frame-Options', 'DENY')
        if cookie is not None:
            secure = '; Secure' if getattr(self.server, 'public_url', '') else ''
            self.send_header('Set-Cookie', access.COOKIE + '=' + cookie + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + str(access.SESSION_SECONDS if cookie else 0) + secure)
        self.end_headers()
        self.wfile.write(body)

    def body(self, json_body=True):
        if self.headers.get('Transfer-Encoding'):
            raise ValueError('Chunked bodies unsupported')
        raw_length = self.headers.get('Content-Length', '')
        if not raw_length.isdigit() or int(raw_length) > MAX_BODY:
            raise ValueError('Invalid body size; maximum 20 MB')
        if json_body and self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise ValueError('application/json required')
        self.connection.settimeout(20)
        value = self.rfile.read(int(raw_length))
        if len(value) != int(raw_length):
            raise ValueError('Incomplete body')
        if not json_body:
            return value
        result = json.loads(value, parse_constant=lambda s: (_ for _ in ()).throw(ValueError('Non-finite number')))
        if not isinstance(result, dict):
            raise ValueError('JSON object required')
        return result

    def file(self, path, name=None, preview=False, cacheable=False):
        data = path.read_bytes()
        preview_type={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'}.get(Path(name or '').suffix.lower()) if preview else None
        if preview and (not preview_type or not (data.startswith(b'%PDF-') if preview_type=='application/pdf' else data.startswith(b'\x89PNG\r\n\x1a\n') if preview_type=='image/png' else data.startswith(b'\xff\xd8\xff'))):
            raise ValueError('이 형식은 화면 미리보기를 지원하지 않습니다. 원본 내려받기로 확인해 주세요.')
        etag = '"' + hashlib.sha256(data).hexdigest() + '"' if cacheable else None
        tags = [tag.strip().removeprefix('W/') for tag in self.headers.get('If-None-Match', '').split(',')]
        unchanged = etag is not None and (etag in tags or '*' in tags)
        self.send_response(304 if unchanged else 200)
        types = {'.webmanifest': 'application/manifest+json', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png'}
        self.send_header('Content-Type', preview_type or ('application/octet-stream' if name else types.get(path.suffix.lower(), mimetypes.guess_type(path.name)[0] or 'application/octet-stream')))
        if not unchanged:
            self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'private, no-cache' if cacheable else 'no-store')
        if etag:
            self.send_header('ETag', etag)
        self.send_header('X-Frame-Options', 'SAMEORIGIN' if preview else 'DENY')
        self.send_header('Referrer-Policy', 'same-origin')
        if name:
            self.send_header('Content-Disposition', ("inline" if preview else "attachment") + "; filename*=UTF-8''" + quote(name))
        self.end_headers()
        if not unchanged:
            self.wfile.write(data)

    def redirect(self, location):
        self.send_response(302)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()

    def route(self, method):
        try:
            if self.path.startswith(('/manual/', '/api/manual-wiki/')):
                import manual_wiki
                if manual_wiki.handle(self, method):
                    return
            self.guard(method != 'GET')
            parsed = urlsplit(self.path)
            path, query, store = unquote(parsed.path), parse_qs(parsed.query), self.server.store
            if method == 'GET' and path in ('/', '/onboarding/'):
                # v1 is the home page; invite and reset fragments survive the redirect.
                return self.redirect('/v1' + ('?' + parsed.query if parsed.query else ''))
            if method == 'GET' and path in ('/auth/works/login', '/auth/works/callback'):
                # NAVER WORKS 로그인: 시작(→ WORKS)과 돌아오는 곳. 세션 없이 열리고, 끝나면 LMS 세션을 만든다.
                import works_auth
                return works_auth.login(self, query) if path.endswith('/login') else works_auth.callback(self, query)
            auth = self.server.access
            filename = path[1:]
            public_get = method == 'GET' and (path == '/api/health' or filename in STATIC)
            # Public assets have no account-specific content; private APIs still check every session.
            session = None if public_get else auth.session(self.headers.get('Cookie'))
            user = session['user'] if session else None
            if user:
                import works_auth
                if works_auth.enabled() and not works_auth.allowed_email(user.get('email')):
                    # WORKS 로그인을 켠 뒤에는 WORKS 계정(허용 도메인)만 쓴다. 남아 있던 체험·자체 계정 세션은 끊는다
                    auth.logout(self.headers.get('Cookie'))
                    session = user = None
            if path == '/api/auth/status' and method == 'GET':
                return self.send(200, {'setupRequired': auth.setup_required(), 'setupAllowed': len(os.environ.get('ERP_BOOTSTRAP_TOKEN', '')) >= 32, 'user': user, 'csrfToken': session['csrfToken'] if session else None,'runtime':'cloud' if store.database else 'local', 'companies': auth.companies(), 'works': __import__('works_auth').enabled()})
            if path == '/api/auth/forgot-password' and method == 'POST':
                auth.rate('forgot:' + self.client_address[0], limit=4)
                account = auth.request_reset(self.body().get('email'))
                config = self.server.invitations.config()
                if account and config['canSend']:
                    token = auth.issue_local_recovery(account['email'], email_verified=True)
                    try:
                        self.server.invitations.send_password_reset(account['email'], os.environ['ERP_INVITE_BASE_URL'].rstrip('/')+'/#account-reset='+token)
                    except (OSError, ValueError, invitations.smtplib.SMTPException):
                        with store.connect() as db:
                            db.execute("UPDATE access_reset_requests SET status='pending' WHERE user_id=?",(account['id'],))
                return self.send(202, {'status':'accepted', 'message':'등록된 이용 계정이면 재설정 안내를 요청했습니다. 메일이 오지 않으면 관리자에게 확인해 주세요.' if config['canSend'] else '등록된 이용 계정이면 재설정 요청이 관리자에게 접수됩니다. 현재 메일 발송은 연결 전입니다. 로그인 가능한 관리자에게 링크 발급을 요청해 주세요. 관리자도 로그인할 수 없다면 이 PC 운영자가 본인을 확인하고 설정 링크를 발급해야 합니다.'})
            if method == 'POST' and path in ('/api/auth/recovery-info', '/api/auth/reset-password'):
                if not self.server.public_url and self.client_address[0] not in ('127.0.0.1', '::1'):
                    raise PermissionError('관리자 비밀번호 설정은 이 PC에서 진행해 주세요.')
                auth.rate('recovery:' + self.client_address[0])
                value = self.body()
                if path.endswith('/recovery-info'):
                    return self.send(200, {'account':auth.recovery_info(value.get('token'))})
                account = auth.reset_password(value)
                result, cookie = auth.new_session(account)
                return self.send(200, result, cookie)
            if method == 'POST' and path in ('/api/auth/invite-info', '/api/auth/accept-invite'):
                auth.rate('invite:' + self.client_address[0])
                value = self.body()
                if path.endswith('/invite-info'):
                    return self.send(200, {'invitation': self.server.invitations.info(value.get('token'))})
                account = self.server.invitations.accept(value)
                result, cookie = auth.new_session(account)
                return self.send(201, result, cookie)
            if method == 'POST' and path in ('/api/auth/setup', '/api/auth/login', '/api/auth/signup'):
                auth.rate('identity:' + self.client_address[0])
                value = self.body()
                if path.endswith('/login'):
                    result, cookie = auth.login(value)
                    return self.send(200, result, cookie)
                if path.endswith('/signup'):
                    if set(value) - {'name', 'email', 'password', 'company', 'department', 'title'}:
                        raise PermissionError('가입 신청에서 권한이나 승인 상태를 지정할 수 없습니다.')
                    auth.create(value, setup=False, on_signup=None)
                    return self.send(201, {'status': 'pending', 'message': '가입 신청을 받았습니다. 관리자 승인 후 로그인할 수 있습니다.'})
                bootstrap = os.environ.get('ERP_BOOTSTRAP_TOKEN', '')
                if len(bootstrap) < 32 or not hmac.compare_digest(str(value.pop('bootstrapToken', '')), bootstrap):
                    raise PermissionError('최초 관리자는 PC 운영자가 설정한 초기 등록 키가 필요합니다.')
                account = auth.create(value, setup=path.endswith('/setup'))
                if path.endswith('/setup'):
                    result, cookie = auth.new_session(account)
                    return self.send(201, result, cookie)
                return self.send(201, {'status': 'pending', 'message': '가입 신청을 받았습니다. 관리자 승인 후 로그인할 수 있습니다.'})
            if path == '/api/dev/accounts' and method in ('GET', 'POST'):
                # Trial only: switch between the dev_seed.py accounts without typing passwords (the 역할 전환 bar).
                # Allowed on a local sqlite run from this machine, or on a server started with LMS_TRIAL=1
                # (n3r staging, and for now the Render PoC). Anyone who can open the address can then act as any
                # trial account, including the trial administrator, so unset LMS_TRIAL once real accounts are used.
                local_run = not store.database and not self.server.public_url and self.client_address[0] in ('127.0.0.1', '::1')
                import works_auth
                if works_auth.enabled() or not (local_run or getattr(self.server, 'trial', False)):  # WORKS 로그인을 켜면 체험 계정 전환은 없다
                    raise FileNotFoundError()
                with store.connect() as db:
                    rows = db.execute("SELECT id,name,email,role FROM access_users WHERE status='active' AND email LIKE '%@local.test' ORDER BY name").fetchall()
                accounts = [dict(r) for r in rows]
                if method == 'GET':
                    return self.send(200, {'accounts': accounts, 'current': user['id'] if user else None})
                self.body()
                wanted = next((a for a in accounts if a['id'] == query.get('id', [''])[0]), None)
                if not wanted:
                    raise FileNotFoundError()
                auth.logout(self.headers.get('Cookie'))
                with store.connect() as db:
                    row = db.execute('SELECT * FROM access_users WHERE id=?', (wanted['id'],)).fetchone()
                result, cookie = auth.new_session(access.public_user(row))
                return self.send(200, result, cookie)
            private = path.startswith('/api/') and path != '/api/health'
            if private and not user:
                raise access.LoginRequired()
            if private and method != 'GET':
                if not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), session['csrfToken']):
                    raise PermissionError('Invalid CSRF token')
            if path == '/api/item-collaboration':
                import workspace_items
                collaboration = workspace_items.Service(store)
                if method == 'GET':
                    target = {k: query.get(k, [''])[0] for k in ('room', 'kind', 'id', 'person')}
                    if not target['id']:
                        return self.send(200, collaboration.summary(user, target['room'], target['person']))
                    return self.send(200, collaboration.context(user, target))
                if method == 'POST':
                    value = self.body()
                    return self.send(200, collaboration.context(user, value.get('target'), value))
                raise FileNotFoundError()
            if path in ('/v1', '/v1.js', '/v1/graph') and method == 'GET':
                # First-release learner screen: the page carries the login gate itself, the script waits for it.
                # /v1/graph: 교육항목 ↔ 원본 문서 연결도. 빈 껍데기이고, 데이터는 로그인 후 /v1_content.json 에서 계산한다.
                return self.file(APP / {'/v1': 'v1.html', '/v1.js': 'v1.js', '/v1/graph': 'v1_graph.html'}[path])
            if path == '/api/v1/pdf-link' and method == 'GET':
                # 항목 PDF 의 5분짜리 주소. 앱 내 브라우저의 다운로드·외부 Chrome 은 로그인 쿠키를 넘기지 않아 주소에 토큰을 싣는다.
                step = query.get('step', [''])[0]
                if not re.fullmatch(r'[a-z0-9-]{1,64}', step):
                    raise ValueError('step required')
                return self.send(200, {'url': f'/v1/pdf/{step}?t=' + pdf_token(self.server, step)})
            m = re.fullmatch(r'/v1/avatar/([0-9a-f]{32})', path)
            if m and method == 'GET':  # WORKS 프로필 사진(로그인할 때 받아 둔 것). 로그인한 구성원끼리만
                if not user:
                    raise access.LoginRequired()
                import works_auth
                data = works_auth.read_avatar(store, m.group(1))
                if not data:
                    raise FileNotFoundError()
                etag = '"' + hashlib.sha256(data).hexdigest()[:32] + '"'
                unchanged = etag in self.headers.get('If-None-Match', '')
                self.send_response(304 if unchanged else 200)
                self.send_header('Content-Type', 'image/jpeg')
                self.send_header('Cache-Control', 'private, max-age=3600')  # 사진은 다음 WORKS 로그인 때 바뀐다
                self.send_header('ETag', etag)
                self.send_header('X-Content-Type-Options', 'nosniff')
                if not unchanged:
                    self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                return None if unchanged else self.wfile.write(data)
            m = re.fullmatch(r'/v1/pdf/([a-z0-9-]{1,64})', path)
            if m and method == 'GET':  # 로그인 쿠키 또는 pdf-link 토큰(5분, 그 항목만)
                step = m.group(1)
                if not user and not pdf_token_ok(self.server, step, query.get('t', [''])[0]):
                    raise access.LoginRequired()
                import v1_pdf
                try:
                    data, name = v1_pdf.build(v1_content(), step)
                except KeyError:
                    raise FileNotFoundError()
                self.send_response(200)
                self.send_header('Content-Type', 'application/pdf')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Referrer-Policy', 'same-origin')
                # filename= 은 한글을 못 읽는 다운로더용 대체 이름, filename*= 이 실제 이름(번호_제목.pdf)
                self.send_header('Content-Disposition', ('inline' if query.get('inline') else 'attachment') + f'; filename="momos_{name.split("_", 1)[0]}.pdf"' + "; filename*=UTF-8''" + quote(name))
                self.end_headers()
                return self.wfile.write(data)
            m = re.fullmatch(r'/v1_photos/([0-9a-f]{12})\.jpg', path)
            if m and method == 'GET':  # 교육 화면의 원본 사진(v1_build.py 가 고른 것만). 교육 내용과 같은 로그인 기준
                if not user:
                    raise access.LoginRequired()
                f = APP / 'v1_photos' / f'{m.group(1)}.jpg'
                if not f.exists():
                    raise FileNotFoundError()
                return self.file(f, cacheable=True)
            if path == '/v1_content.json' and method == 'GET':
                if not user:
                    raise access.LoginRequired()
                return self.send(200, v1_content())
            if path in ('/onboarding','/onboarding.js','/onboarding/wiki') and method == 'GET':
                if not user:
                    if path == '/onboarding':
                        return self.file(APP / 'onboarding_login.html')
                    raise access.LoginRequired()
                import onboarding
                education = onboarding.Service(store)
                education.get(user)
                if path == '/onboarding/wiki':
                    import manual_wiki
                    service = self.server.manual_wiki
                    if service is None:
                        return self.send(503, {'error':'업무 가이드 연결을 확인하세요.'})
                    if not service.read_slots.acquire(blocking=False):
                        return self.send(503, {'error':'업무 가이드를 잠시 후 다시 열어 주세요.'})
                    try:
                        snapshot = service.current()
                        return manual_wiki.reply(self,200,snapshot.html,'text/html; charset=utf-8')
                    finally:
                        service.read_slots.release()
                return self.file(APP / ('onboarding.html' if path == '/onboarding' else 'onboarding.js'))
            if path == '/api/onboarding/material-updates' and method == 'GET':
                import onboarding
                onboarding.Service(store).get(user)
                service = self.server.manual_wiki
                if service is None:
                    return self.send(503, {'error': '업무 가이드 연결을 확인하세요.'})
                if not service.read_slots.acquire(blocking=False):
                    return self.send(503, {'error': '자료 업데이트를 잠시 후 다시 확인해 주세요.'})
                try:
                    return self.send(200, service.updates(query.get('cursor', [''])[0]))
                except ValueError:
                    return self.send(400, {'error': '자료 업데이트 기록을 확인할 수 없습니다.'})
                except (OSError, KeyError):
                    return self.send(503, {'error': '자료 업데이트를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.'})
                finally:
                    service.read_slots.release()
            asset_match=re.fullmatch(r'/api/onboarding/attachments(?:/([a-f0-9]{32}))?',path)
            if asset_match:
                import onboarding
                education=onboarding.Service(store);ident=asset_match.group(1)
                if method=='POST' and ident is None:return self.send(201,education.upload_asset(user,self.body()))
                if method=='GET' and ident:
                    source,name,preview=education.get_asset(user,ident)
                    return self.file(source,name,preview=preview)
                raise FileNotFoundError()
            if path == '/api/onboarding':
                import onboarding
                education = onboarding.Service(store)
                if method == 'GET':
                    return self.send(200,education.get(user,query.get('target',[None])[0]))
                if method == 'POST':
                    return self.send(200,education.update(user,self.body()))
                raise FileNotFoundError()
            if path == '/api/auth/logout' and method == 'POST':
                self.body()
                auth.logout(self.headers.get('Cookie'))
                return self.send(200, {'status': 'signed_out'}, '')
            if path == '/api/auth/users' and method == 'GET':
                if user['role'] != 'admin':
                    raise PermissionError()
                return self.send(200, {'users': auth.users(), 'companies': auth.companies()})
            if path == '/api/auth/reset-requests' and method == 'GET':
                if not user or user['role']!='admin' or user['company']!='momos' or user['name'] not in access.ADMINS:
                    raise PermissionError()
                return self.send(200, {'items':auth.reset_requests()})
            if path == '/api/auth/reset-link' and method == 'POST':
                if not user or user['role']!='admin' or user['company']!='momos' or user['name'] not in access.ADMINS:
                    raise PermissionError()
                value=self.body()
                if value.get('identityConfirmed') is not True:
                    raise ValueError('등록된 이메일의 본인인지 확인해 주세요.')
                token=auth.issue_local_recovery(value.get('email'), actor=user)
                base = self.server.public_url or 'http://127.0.0.1:'+str(self.server.server_port)
                return self.send(201, {'link':base+'/#account-reset='+token,'message':'본인에게만 전달할 일회용 링크입니다. 1시간 동안 한 번 사용할 수 있습니다. 메일은 발송하지 않았습니다.'})
            if path == '/api/auth/invitations':
                if method == 'GET':
                    return self.send(200, {**self.server.invitations.list(user), 'companies': auth.companies()})
                if method == 'POST':
                    return self.send(201, self.server.invitations.create(user, self.body(), 'http://127.0.0.1:' + str(self.server.server_port)))
            if path == '/api/auth/companies' and method == 'POST':
                return self.send(201, auth.add_company(user, self.body()))
            if re.fullmatch('/api/auth/invitations/[a-f0-9]{32}/cancel', path) and method == 'POST':
                self.body()
                self.server.invitations.cancel(user, path.split('/')[-2])
                return self.send(200, {'status': 'cancelled'})
            if re.fullmatch('/api/auth/users/[a-f0-9]{32}', path) and method == 'GET':
                details=auth.member_details(user, path.rsplit('/', 1)[1])
                details['recoveryEmailConnected']=self.server.invitations.config()['canSend']
                return self.send(200, details)
            if re.fullmatch('/api/auth/users/[a-f0-9]{32}', path) and method == 'POST':
                return self.send(200, {'user': auth.update_user(user, path.rsplit('/', 1)[1], self.body())})
            if method == 'GET':
                if path == '/api/health':
                    if store.database:
                        with store.connect() as db:
                            db.execute('SELECT 1').fetchone()
                        return self.send(200, {'status': 'ok', 'mode': 'cloud', 'storage': 'supabase', 'application': 'momos-lms'})
                    return self.send(200, {'status': 'ok', 'mode': 'local', 'storage': 'sqlite', 'application': 'momos-lms', 'pid': os.getpid()})
                if filename in STATIC:
                    return self.file(safe_path(APP, filename), cacheable=filename in {'styles.css', 'auth.js', 'workspace_items.js'})
            self.send(404, {'error': 'Not found'})
        except access.LoginRequired:
            self.send(401, {'error': '로그인이 필요하거나 계정 승인·로그인 정보를 확인해야 합니다.'})
        except access.RateLimited:
            self.send(429, {'error': '요청이 많습니다. 잠시 후 다시 시도해 주세요.'})
        except PermissionError:
            self.send(403, {'error': 'Access denied'})
        except FileNotFoundError:
            self.send(404, {'error': 'Not found'})
        except lms_store.Conflict as exc:
            self.send(409, {'error': str(exc)})
        except (ValueError, TypeError, RecursionError) as exc:
            self.send(400, {'error': str(exc)[:200]})
        except Exception:
            self.send(500, {'error': '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'})

    def do_GET(self):
        self.route('GET')

    def do_POST(self):
        self.route('POST')

    def do_PUT(self):
        self.route('PUT')


class LocalHTTPServer(ThreadingHTTPServer):
    # Linux containers restart in place: reuse the port so lingering TIME_WAIT connections from probes
    # do not block the new process for a minute. Windows keeps exclusive binding (server_bind below).
    allow_reuse_address = sys.platform != 'win32'

    def server_bind(self):
        # Windows must not silently share a port with an older preview server.
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class CloudHTTPServer(LocalHTTPServer):
    """Bound request threads and read time behind Render's HTTPS reverse proxy."""
    def __init__(self,*args,**kwargs):
        self.request_slots=threading.BoundedSemaphore(32)
        super().__init__(*args,**kwargs)

    def get_request(self):
        connection,address=super().get_request()
        connection.settimeout(30)
        return connection,address

    def process_request(self,request,address):
        if not self.request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:super().process_request(request,address)
        except BaseException:
            self.request_slots.release()
            raise

    def process_request_thread(self,request,address):
        try:super().process_request_thread(request,address)
        finally:self.request_slots.release()



def v1_content():
    """v1_content.json (빌드 산출물: 절·사진) 위에 v1_lessons.json (교육 목적·교육 내용·인용 글)을 덮어 돌려준다.
    글만 고칠 때는 v1_lessons.json 을 수정·커밋하면 되고, 새 절을 인용할 때만 v1_build.py 를 다시 돌린다."""
    content = json.loads((APP / 'v1_content.json').read_text(encoding='utf-8'))
    key = lambda c: f'{c[0]}|{c[1]}' + (f'#{c[2]}' if len(c) > 2 and c[2] else '')  # v1_build.section_key 와 같은 규칙(표 일부 인용 '#r2')
    lessons_path = APP / 'v1_lessons.json'
    if lessons_path.exists():
        lessons = json.loads(lessons_path.read_text(encoding='utf-8')).get('lessons', {})
        for unit in content.get('units', []):
            for step in unit['steps']:
                l = lessons.get(step['id'])
                if not l or step.get('lessonStatus') == 'planned':  # 준비 중(추가·교체) 세션에는 이전 교육안을 덮지 않는다
                    continue
                if l.get('title') and not step.get('curriculumTitle'): step['title'] = l['title']
                if 'purpose' in l: step['purpose'] = l['purpose']
                if 'keyPoints' in l: step['keyPoints'] = [dict(text=k['text'], cites=[key(c) for c in k.get('cites', [])]) for k in l['keyPoints']]
                if 'sources' in l: step['sources'] = [key(c) for c in l['sources']]
                if l.get('checks'):
                    step['checks'] = [c['text'] for c in l['checks']]
                    step['checkCites'] = [[key(x) for x in c.get('cites', [])] for c in l['checks']]
    return content


PDF_LINK_SECONDS = 300


def pdf_token(server, step, now=None):
    exp = int((now or time.time()) + PDF_LINK_SECONDS)
    sig = hmac.new(server.pdf_secret, f'{step}.{exp}'.encode(), hashlib.sha256).hexdigest()[:32]
    return f'{exp}.{sig}'


def pdf_token_ok(server, step, token, now=None):
    exp, _, sig = token.partition('.')
    if not exp.isdigit() or int(exp) < (now or time.time()):
        return False
    good = hmac.new(server.pdf_secret, f'{step}.{exp}'.encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(sig, good)


def make_server(store, port=8768, *, host='127.0.0.1', public_url='', trial=False):
    if host != '127.0.0.1' and not public_url.startswith('https://') and not trial:
        raise ValueError('외부 바인딩에는 HTTPS 공개 주소(--public-url)가 필요합니다. 리버스 프록시가 TLS를 맡습니다. (사내 테스트는 LMS_TRIAL=1)')
    server = (CloudHTTPServer if public_url else LocalHTTPServer)((host, port), Handler)
    server.public_url = public_url
    server.trial = trial
    server.pdf_secret = secrets.token_bytes(32)  # 프로세스마다 새로 — 재시작하면 남은 PDF 주소는 만료
    server.store = store
    server.access = access.Access(store)
    server.invitations = invitations.Invitations(server.access)
    import manual_wiki
    server.manual_wiki = manual_wiki.Service.from_env()
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, default=Path(os.environ.get('LMS_DATA_DIR') or APP / 'data'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT') or 8768))
    parser.add_argument('--host', default=os.environ.get('LMS_HOST') or '127.0.0.1',
                        help='0.0.0.0 to serve inside a container; needs --public-url')
    parser.add_argument('--public-url', default=os.environ.get('LMS_PUBLIC_URL') or '',
                        help='the HTTPS address users open, e.g. https://momos-lms.example.com (no trailing slash)')
    args = parser.parse_args()
    if os.environ.get('LMS_DATABASE_URL'):
        # Supabase mode (Render): rows in PostgreSQL, photos in a private bucket, HTTPS public URL required.
        import cloud
        return cloud.run()
    store = Store(args.data_dir)
    trial = os.environ.get('LMS_TRIAL') == '1' and not store.database
    import works_auth
    if trial and not works_auth.enabled():
        import dev_seed
        if dev_seed.seed(store):
            print('LMS_TRIAL=1: 체험 계정을 만들었습니다 (staff / learner / newbie @local.test).', flush=True)
    server = make_server(store, args.port, host=args.host, public_url=args.public_url.rstrip('/'), trial=trial)
    if works_auth.enabled():  # WORKS 로그인: 체험 계정은 만들지 않고, 남아 있으면 지운다(계정 테이블은 make_server 가 준비)
        n = works_auth.purge_trial_accounts(store)
        if n: print(f'WORKS 로그인: 체험 계정 {n}개와 그 기록을 지웠습니다.', flush=True)
    print('Momos LMS: %s/v1' % (args.public_url.rstrip('/') or 'http://127.0.0.1:%d' % args.port), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
