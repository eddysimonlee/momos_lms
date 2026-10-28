"""NAVER WORKS 로그인(OAuth 2.0 Authorization Code + OIDC userinfo).

흐름: /auth/works/login → WORKS 로그인 → /auth/works/callback?code&state
      → 서버가 code 로 토큰 발급(client_secret) → userinfo 로 구성원 ID·이메일·이름 확인
      → 같은 이메일의 LMS 계정을 찾고, 없으면 만든다 → LMS 세션 쿠키 → /v1

토큰은 서버가 WORKS 와 TLS 로 직접 주고받은 것만 쓰고, 화면(브라우저)에는 넘기지 않는다.
ID Token 서명 검증 대신 userinfo 를 서버에서 호출해 구성원 정보를 받는다(OIDC Core 의 UserInfo Endpoint).

환경변수 (Render 에서 직접 입력 — 저장소에 넣지 않는다)
  WORKS_CLIENT_ID, WORKS_CLIENT_SECRET   Developer Console 의 OAuth 앱 정보
  WORKS_DOMAIN                           로그인 화면을 그 고객사로 보낼 도메인(예: momos.co.kr). 선택
  WORKS_ALLOWED_DOMAINS                  로그인을 허용할 이메일 도메인, 쉼표로 여러 개. 기본값 = WORKS_DOMAIN
  WORKS_REDIRECT_URL                     기본값 = <공개 주소>/auth/works/callback
문서: https://developers.worksmobile.com/kr/docs/auth-oauth , https://developers.worksmobile.com/kr/docs/auth-oidc
"""
import hashlib
import json
import os
import secrets
import time
from http.cookies import SimpleCookie
from html import escape
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import access

AUTH_BASE = os.environ.get('WORKS_AUTH_BASE', 'https://auth.worksmobile.com')  # 테스트에서만 바꾼다
STATE_COOKIE = 'works_state'
STATE_SECONDS = 600


def config():
    cid, secret = os.environ.get('WORKS_CLIENT_ID', '').strip(), os.environ.get('WORKS_CLIENT_SECRET', '').strip()
    domain = os.environ.get('WORKS_DOMAIN', '').strip()
    allowed = [d.strip().lower().lstrip('@') for d in (os.environ.get('WORKS_ALLOWED_DOMAINS') or domain).split(',') if d.strip()]
    return dict(client_id=cid, client_secret=secret, domain=domain, allowed=allowed,
                redirect=os.environ.get('WORKS_REDIRECT_URL', '').strip(), enabled=bool(cid and secret and allowed))


def enabled():
    return config()['enabled']


def _redirect_url(handler, cfg):
    if cfg['redirect']:
        return cfg['redirect']
    base = getattr(handler.server, 'public_url', '') or 'http://' + handler.headers.get('Host', '')
    return base.rstrip('/') + '/auth/works/callback'


def _secure(handler):
    return '; Secure' if getattr(handler.server, 'public_url', '') else ''


def _page(handler, code, title, body, cookies=()):
    """결과 화면. 로그인 성공 시에는 같은 사이트 안에서 /v1 로 넘어가게 한다(SameSite=Strict 세션 쿠키가 실리도록)."""
    html = ('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{escape(title)}</title><style>body{{font-family:-apple-system,"Apple SD Gothic Neo",sans-serif;max-width:420px;margin:15vh auto;padding:0 20px;color:#202124}}'
            'a{display:inline-block;margin-top:16px;padding:10px 16px;border-radius:8px;background:#1a6bd6;color:#fff;text-decoration:none}</style></head>'
            f'<body>{body}</body></html>').encode()
    handler.send_response(code)
    handler.send_header('Content-Type', 'text/html; charset=utf-8')
    handler.send_header('Content-Length', str(len(html)))
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('X-Content-Type-Options', 'nosniff')
    handler.send_header('X-Frame-Options', 'DENY')
    handler.send_header('Referrer-Policy', 'no-referrer')  # code·state 가 다른 곳으로 새지 않게
    for c in cookies:
        handler.send_header('Set-Cookie', c)
    handler.end_headers()
    handler.wfile.write(html)


def _fail(handler, message, code=400):
    clear = f'{STATE_COOKIE}=; Path=/auth/works; HttpOnly; SameSite=Lax; Max-Age=0' + _secure(handler)
    return _page(handler, code, 'NAVER WORKS 로그인',
                 f'<h2>로그인하지 못했어요</h2><p>{escape(message)}</p><a href="/auth/works/login">다시 로그인</a>', [clear])


def login(handler):
    cfg = config()
    if not cfg['enabled']:
        return _fail(handler, 'NAVER WORKS 로그인이 아직 설정되지 않았어요. 관리자에게 문의해 주세요.', 503)
    state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(16)
    params = dict(client_id=cfg['client_id'], redirect_uri=_redirect_url(handler, cfg), scope='openid email profile',
                  response_type='code', state=state, nonce=nonce)
    if cfg['domain']:
        params['domain'] = cfg['domain']
    handler.send_response(302)
    handler.send_header('Location', f'{AUTH_BASE}/oauth2/v2.0/authorize?' + urlencode(params))
    # 돌아올 때(다른 사이트에서 오는 최상위 이동) 실려야 하므로 Lax. 10분, 이 경로에서만.
    handler.send_header('Set-Cookie', f'{STATE_COOKIE}={state}; Path=/auth/works; HttpOnly; SameSite=Lax; Max-Age={STATE_SECONDS}' + _secure(handler))
    handler.send_header('Content-Length', '0')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Referrer-Policy', 'no-referrer')
    handler.end_headers()


def _post_form(url, data):
    req = Request(url, data=urlencode(data).encode(), headers={'Content-Type': 'application/x-www-form-urlencoded'}, method='POST')
    with urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def _get_json(url, token):
    req = Request(url, headers={'Authorization': 'Bearer ' + token})
    with urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def callback(handler, query):
    cfg = config()
    if not cfg['enabled']:
        return _fail(handler, 'NAVER WORKS 로그인이 아직 설정되지 않았어요.', 503)
    q = lambda k: (query.get(k) or [''])[0]
    if q('error'):
        return _fail(handler, '로그인이 취소되었거나 허용되지 않았어요.')
    jar = SimpleCookie()
    try:
        jar.load(handler.headers.get('Cookie', ''))
    except Exception:
        pass
    expected = jar[STATE_COOKIE].value if STATE_COOKIE in jar else ''
    if not expected or not secrets.compare_digest(expected, q('state')) or not q('code'):
        return _fail(handler, '로그인 요청이 만료되었어요. 처음부터 다시 시도해 주세요.')
    try:
        form = dict(code=q('code'), grant_type='authorization_code', client_id=cfg['client_id'],
                    client_secret=cfg['client_secret'], redirect_uri=_redirect_url(handler, cfg))
        if cfg['domain']:
            form['domain'] = cfg['domain']
        token = _post_form(f'{AUTH_BASE}/oauth2/v2.0/token', form)
        info = _get_json(f'{AUTH_BASE}/oauth2/v2.0/userinfo', token['access_token'])
    except (HTTPError, URLError, KeyError, ValueError, TimeoutError) as e:
        print(f'works login: token/userinfo failed: {type(e).__name__}', flush=True)  # 토큰·코드 값은 남기지 않는다
        return _fail(handler, 'NAVER WORKS 와 통신하지 못했어요. 잠시 후 다시 시도해 주세요.', 502)
    email = str(info.get('email', '')).strip().lower()
    name = str(info.get('name') or '').strip() or email.split('@')[0]
    if not info.get('sub') or '@' not in email or email.rsplit('@', 1)[1] not in cfg['allowed']:
        return _fail(handler, f'이 서비스는 {", ".join(cfg["allowed"])} 계정만 이용할 수 있어요.', 403)
    try:
        user = find_or_create(handler.server.store, email, name, info['sub'])
    except PermissionError as e:
        return _fail(handler, str(e), 403)
    _, session_token = handler.server.access.new_session(user)
    secure = _secure(handler)
    cookies = [access.COOKIE + '=' + session_token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + str(access.SESSION_SECONDS) + secure,
               f'{STATE_COOKIE}=; Path=/auth/works; HttpOnly; SameSite=Lax; Max-Age=0' + secure]
    return _page(handler, 200, '모모스 온보딩',
                 '<meta http-equiv="refresh" content="0;url=/v1"><p>로그인했어요. 잠시만 기다려 주세요…</p>'
                 '<script>location.replace("/v1")</script><a href="/v1">계속하기</a>', cookies)


def find_or_create(store, email, name, sub):
    """같은 이메일의 계정으로 로그인. 처음이면 '이용 중'인 일반 구성원(member, 모모스)으로 만든다.
    관리자 권한은 여기서 주지 않는다 — 기존 관리자 화면에서 따로 지정한다. 중지된 계정은 막는다."""
    now = time.time()
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT * FROM access_users WHERE email=?', (email,)).fetchone()
        if row:
            if row['status'] != 'active':
                raise PermissionError('이용이 중지되었거나 승인 대기 중인 계정이에요. 관리자에게 문의해 주세요.')
            db.execute('INSERT INTO access_audit(at,actor_id,kind,target_id,detail) VALUES(?,?,?,?,?)',
                       (now, row['id'], 'works.login', row['id'], json.dumps({'sub': hashlib.sha256(sub.encode()).hexdigest()[:16]})))
            return access.public_user(row)
        base, n = name[:54], 1
        while db.execute('SELECT 1 FROM access_users WHERE name=?', (name,)).fetchone():  # 이름은 고유해야 한다(동명이인)
            n += 1
            name = f'{base} ({n})'
        ident, salt = secrets.token_hex(16), secrets.token_hex(16)
        unusable = 'works:' + secrets.token_hex(32)  # 비밀번호 로그인은 막는다(어떤 비밀번호의 해시와도 같아질 수 없음)
        db.execute('INSERT INTO access_users VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                   (ident, name, email, unusable, salt, 'member', 'momos', '', '', 'active', now, now))
        db.execute('INSERT INTO access_audit(at,actor_id,kind,target_id,detail) VALUES(?,?,?,?,?)',
                   (now, ident, 'works.signup', ident, json.dumps({'sub': hashlib.sha256(sub.encode()).hexdigest()[:16]})))
        return access.public_user(db.execute('SELECT * FROM access_users WHERE id=?', (ident,)).fetchone())
