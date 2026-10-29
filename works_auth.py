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
API_BASE = os.environ.get('WORKS_API_BASE', 'https://www.worksapis.com/v1.0')
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


# 로그인 후 돌아갈 곳(정해진 것만 — 임의 주소로 보내지 않는다)
NEXT = {'v1': '/v1', 'graph': '/v1/graph'}


def login(handler, query=None):
    cfg = config()
    if not cfg['enabled']:
        return _fail(handler, 'NAVER WORKS 로그인이 아직 설정되지 않았어요. 관리자에게 문의해 주세요.', 503)
    state, nonce = secrets.token_urlsafe(24), secrets.token_urlsafe(16)
    nxt = ((query or {}).get('next') or ['v1'])[0]
    nxt = nxt if nxt in NEXT else 'v1'
    params = dict(client_id=cfg['client_id'], redirect_uri=_redirect_url(handler, cfg), scope='openid email profile user.read',  # user.read: 구성원 사진
                  response_type='code', state=state, nonce=nonce)
    if cfg['domain']:
        params['domain'] = cfg['domain']
    handler.send_response(302)
    handler.send_header('Location', f'{AUTH_BASE}/oauth2/v2.0/authorize?' + urlencode(params))
    # 돌아올 때(다른 사이트에서 오는 최상위 이동) 실려야 하므로 Lax. 10분, 이 경로에서만.
    handler.send_header('Set-Cookie', f'{STATE_COOKIE}={state}.{nonce}.{nxt}; Path=/auth/works; HttpOnly; SameSite=Lax; Max-Age={STATE_SECONDS}' + _secure(handler))
    handler.send_header('Content-Length', '0')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Referrer-Policy', 'no-referrer')
    handler.end_headers()


UA = {'User-Agent': 'MomosLMS/1', 'Accept': 'application/json'}


def _post_form(url, data):
    req = Request(url, data=urlencode(data).encode(), headers={**UA, 'Content-Type': 'application/x-www-form-urlencoded'}, method='POST')
    with urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def _get_json(url, token):
    req = Request(url, headers={**UA, 'Authorization': 'Bearer ' + token})
    with urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def _log_failure(step, e):
    """Render 로그에 남길 실패 이유: 단계·HTTP 상태·WORKS 오류 코드만. 코드·토큰·시크릿 값은 남기지 않는다."""
    detail = ''
    if isinstance(e, HTTPError):
        try:
            body = json.loads(e.read() or b'{}')
            detail = f" error={body.get('error') or body.get('code')} description={str(body.get('error_description') or body.get('description') or '')[:200]}"
        except Exception:
            detail = ''
        detail = f' status={e.code}' + detail
    print(f'works login: {step} failed: {type(e).__name__}{detail}', flush=True)


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
    expected, nonce, nxt = ((jar[STATE_COOKIE].value if STATE_COOKIE in jar else '').split('.') + ['', '', ''])[:3]
    dest = NEXT.get(nxt, '/v1')
    if not expected or not secrets.compare_digest(expected, q('state')) or not q('code'):
        return _fail(handler, '로그인 요청이 만료되었어요. 처음부터 다시 시도해 주세요.')
    step = 'token'
    try:
        # domain 은 고객사 SSO(WORKS as SP)를 쓸 때만 필요하다고 문서에 있어 토큰 요청에는 넣지 않는다
        form = dict(code=q('code'), grant_type='authorization_code', client_id=cfg['client_id'],
                    client_secret=cfg['client_secret'], redirect_uri=_redirect_url(handler, cfg))
        token = _post_form(f'{AUTH_BASE}/oauth2/v2.0/token', form)
        step = 'id_token'
        info = id_token_claims(token.get('id_token', ''), cfg['client_id'], nonce)
        if not info.get('email'):  # id_token 에 email 이 없으면(scope 설정 등) userinfo 로 보충
            step = 'userinfo'
            info = {**info, **_get_json(f'{AUTH_BASE}/oauth2/v2.0/userinfo', token['access_token'])}
    except (HTTPError, URLError, KeyError, ValueError, TimeoutError) as e:
        _log_failure(step, e)
        return _fail(handler, f'NAVER WORKS 와 통신하지 못했어요({ {"token": "토큰", "id_token": "로그인 정보", "userinfo": "구성원 정보"}[step] } 단계). 잠시 후 다시 시도해 주세요.', 502)
    email = str(info.get('email', '')).strip().lower()
    name = display_name(info) or email.split('@')[0]
    if not info.get('sub') or '@' not in email or email.rsplit('@', 1)[1] not in cfg['allowed']:
        return _fail(handler, f'이 서비스는 {", ".join(cfg["allowed"])} 계정만 이용할 수 있어요.', 403)
    try:
        user = find_or_create(handler.server.store, email, name, info['sub'])
    except PermissionError as e:
        return _fail(handler, str(e), 403)
    try:  # 프로필 사진: 로그인할 때마다 WORKS 사진을 받아 둔다(없거나 실패해도 로그인은 계속)
        save_avatar(handler.server.store, user['id'], fetch_photo(token['access_token'], info['sub']))
    except Exception as e:
        _log_failure('photo', e)
    remember_token(user['id'], token)  # 주소록 검색(교육한 관리자 선택)에 쓴다. 서버 메모리에만, 화면·DB 로는 보내지 않는다
    handler.server.access.logout(handler.headers.get('Cookie'))  # 이전 LMS 세션이 있으면 끝내고 새로 시작
    _, session_token = handler.server.access.new_session(user)
    secure = _secure(handler)
    cookies = [access.COOKIE + '=' + session_token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + str(access.SESSION_SECONDS) + secure,
               f'{STATE_COOKIE}=; Path=/auth/works; HttpOnly; SameSite=Lax; Max-Age=0' + secure]
    return _page(handler, 200, '모모스 온보딩',
                 f'<meta http-equiv="refresh" content="0;url={dest}"><p>로그인했어요. 잠시만 기다려 주세요…</p>'
                 f'<script>location.replace("{dest}")</script><a href="{dest}">계속하기</a>', cookies)


def id_token_claims(id_token, client_id, nonce, now=None):
    """토큰 엔드포인트에서 TLS 로 직접 받은 ID Token 의 클레임(OIDC Core 3.1.3.7: 이 경우 TLS 서버 검증으로 서명 검증을 대신할 수 있다).
    발급자·대상(client_id)·만료·nonce 는 확인한다."""
    import base64
    parts = id_token.split('.')
    if len(parts) != 3:
        raise ValueError('id_token missing')
    claims = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
    now = now or time.time()
    aud = claims.get('aud')
    if not str(claims.get('iss', '')).startswith(AUTH_BASE) or (client_id not in aud if isinstance(aud, list) else aud != client_id) \
            or not (float(claims.get('exp', 0)) > now - 60) or (nonce and claims.get('nonce') and claims['nonce'] != nonce):
        raise ValueError('id_token claims invalid')
    return {k: claims.get(k) for k in ('sub', 'email', 'name', 'family_name', 'given_name') if claims.get(k)}


def display_name(info):
    """한국식 이름: 성 + 이름을 붙여 쓴다('이' + '재현' → '이재현'). WORKS 의 name 은 '재현 이'처럼 올 수 있다.
    한글이 아닌 이름은 WORKS 대표 이름 그대로."""
    import re
    family, given = str(info.get('family_name') or '').strip(), str(info.get('given_name') or '').strip()
    hangul = lambda t: bool(t) and bool(re.fullmatch(r'[가-힣 ]+', t))
    if hangul(family) and hangul(given):
        return (family + given).replace(' ', '')
    name = str(info.get('name') or '').strip()
    parts = name.split()
    if len(parts) == 2 and all(hangul(p) for p in parts) and len(parts[1]) == 1 and len(parts[0]) >= 2:
        return parts[1] + parts[0]  # '재현 이' → '이재현' (성이 한 글자로 뒤에 온 경우)
    return name


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
            # WORKS 로 만든 계정은 WORKS 이름을 따른다(바뀐 이름·표기 반영). 같은 이름이 이미 있으면 그대로 둔다
            if row['password_hash'].startswith('works:') and name and row['name'] != name[:60] \
                    and not db.execute('SELECT 1 FROM access_users WHERE name=? AND id<>?', (name[:60], row['id'])).fetchone():
                db.execute('UPDATE access_users SET name=?, updated_at=? WHERE id=?', (name[:60], now, row['id']))
                row = db.execute('SELECT * FROM access_users WHERE id=?', (row['id'],)).fetchone()
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


TRIAL_DOMAIN = 'local.test'  # dev_seed.py 의 체험 계정(staff / learner / newbie @local.test)


def allowed_email(email):
    email = str(email or '').lower()
    return '@' in email and email.rsplit('@', 1)[1] in config()['allowed']


def purge_trial_accounts(store):
    """WORKS 로그인을 켠 서버에서 체험 계정과 그 교육 기록·지점/역할·세션을 지운다(되돌릴 수 없음).
    서버가 시작할 때 한 번 돈다. 다른 계정의 담당 교육자·평가자로 지정돼 있었다면 '미배정'으로 돌린다."""
    import onboarding as ob
    import lms_store as projects
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        ids = [r['id'] for r in db.execute('SELECT id FROM access_users WHERE email LIKE ?', ('%@' + TRIAL_DOMAIN,)).fetchall()]
        if not ids:
            return 0
        root = projects.Rooms.read(db, ob.ROOT)
        if root:
            for i in ids:
                entry = root.get('learners', {}).pop(i, None)
                if entry:
                    db.execute('DELETE FROM metadata WHERE id=?', (entry['key'],))
                root.get('profiles', {}).pop(i, None)
                root.get('accessOverrides', {}).pop(i, None)
                for k in ('technical', 'content'):
                    root[k] = [x for x in root.get(k, []) if x != i]
            for entry in root.get('learners', {}).values():
                for k in ('trainer', 'assessor'):
                    if entry.get(k) in ids:
                        entry[k] = None
            root['revision'] = root.get('revision', 0) + 1
            projects.Rooms.write(db, ob.ROOT, root)
        for i in ids:
            db.execute('DELETE FROM metadata WHERE id=?', (avatar_key(i),))
            for table in ('access_sessions', 'access_recovery', 'access_reset_requests', 'file_access'):
                db.execute(f'DELETE FROM {table} WHERE user_id=?', (i,))
            db.execute('DELETE FROM access_users WHERE id=?', (i,))
        db.execute('INSERT INTO access_audit(at,actor_id,kind,target_id,detail) VALUES(?,?,?,?,?)',
                   (time.time(), 'system', 'trial.purge', None, json.dumps({'count': len(ids)})))
    return len(ids)


AVATAR_PX, AVATAR_MAX = 160, 200_000


def avatar_key(user_id):
    """프로필 사진을 담는 metadata 행 번호(교육 기록 행과 겹치지 않는 범위)."""
    return 9_000_000_000 + int(hashlib.sha256(('avatar:' + user_id).encode()).hexdigest()[:8], 16)


def fetch_photo(access_token, member_id):
    """WORKS 구성원 사진(GET /users/{userId}/photo → 302 파일 주소). 사진이 없으면 None."""
    from urllib.parse import quote
    req = Request(f'{API_BASE}/users/{quote(member_id, safe="")}/photo', headers={**UA, 'Authorization': 'Bearer ' + access_token, 'Accept': '*/*'})  # image/* 는 406(NOT_ACCEPTABLE)
    try:
        with urlopen(req, timeout=10) as r:  # 302 는 urllib 가 따라간다(Authorization 헤더 유지)
            raw = r.read(5_000_001)
    except HTTPError as e:
        if e.code == 404:
            return None
        raise
    if not raw or len(raw) > 5_000_000:
        return None
    return raw


def save_avatar(store, user_id, raw):
    """작은 정사각형 JPEG(160px)로 줄여 저장한다. raw 가 None 이면(사진 없음) 지운다."""
    import base64, io
    import lms_store as projects
    data = None
    if raw:
        from PIL import Image, ImageOps
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert('RGB')
        img = ImageOps.fit(img, (AVATAR_PX, AVATAR_PX))
        out = io.BytesIO(); img.save(out, 'JPEG', quality=82); data = out.getvalue()
        if len(data) > AVATAR_MAX:
            data = None
    with store.connect() as db:
        if data:
            projects.Rooms.write(db, avatar_key(user_id), dict(kind='avatar', user=user_id, mime='image/jpeg',
                                                               data=base64.b64encode(data).decode(), at=time.time()))
        else:
            db.execute('DELETE FROM metadata WHERE id=?', (avatar_key(user_id),))


def read_avatar(store, user_id):
    import base64
    import lms_store as projects
    with store.connect() as db:
        row = projects.Rooms.read(db, avatar_key(user_id))
    if not row or row.get('kind') != 'avatar' or row.get('user') != user_id:
        return None
    return base64.b64decode(row['data'])


# --- 주소록(구성원 목록): 교육생이 '나에게 교육을 제공한 관리자'를 고를 때 쓴다 ---
# 로그인할 때 받은 그 사람의 WORKS 토큰(scope user.read)으로 GET /users 를 부른다.
# 토큰은 이 서버 프로세스 메모리에만 두고(재시작하면 사라짐 → 다시 로그인), 화면·DB·로그로 보내지 않는다.
# 목록 API 에는 이름 검색이 없어 구성원 전체를 받아 서버에서 거른다(10분 캐시).
_TOKENS = {}       # LMS 사용자 id → (access_token, 만료 시각)
_DIRECTORY = {}    # 'list' → (받은 시각, [구성원])
DIRECTORY_SECONDS = 600


class DirectoryUnavailable(Exception):
    """주소록을 읽을 수 없다(토큰 없음·만료·권한). 화면에는 다시 로그인하라고 안내한다."""


def remember_token(user_id, token):
    if token.get('access_token'):
        _TOKENS[user_id] = (token['access_token'], time.time() + max(60, int(token.get('expires_in') or 3600)) - 60)


def _token_for(user_id):
    tok = _TOKENS.get(user_id)
    if not tok or tok[1] < time.time():
        raise DirectoryUnavailable('WORKS 주소록을 불러오려면 다시 로그인해 주세요.')
    return tok[0]


def _member(u, allowed):
    """WORKS 구성원 1명 → 화면에 보일 최소 정보(이름·이메일·조직·직책)."""
    email = str(u.get('email') or '').strip().lower()
    if not email or u.get('isDeleted') or u.get('isSuspended') or u.get('isPending') or (allowed and email.rsplit('@', 1)[-1] not in allowed):
        return None
    n = u.get('userName') or {}
    name = display_name(dict(family_name=n.get('lastName'), given_name=n.get('firstName'), name=f"{n.get('firstName') or ''} {n.get('lastName') or ''}".strip())) or email.split('@')[0]
    org = next((o for o in u.get('organizations') or [] if o.get('primary')), (u.get('organizations') or [{}])[0] if u.get('organizations') else {})
    unit = next((x for x in org.get('orgUnits') or [] if x.get('primary')), (org.get('orgUnits') or [{}])[0] if org.get('orgUnits') else {})
    return dict(id=str(u.get('userId') or email), name=name, email=email,
                org=' · '.join(x for x in (unit.get('orgUnitName'), unit.get('positionName') or org.get('levelName')) if x))


def directory(user_id, now=None):
    """momos.co.kr 구성원 전체(이름순). 10분 동안은 다시 받지 않는다."""
    now = now or time.time()
    cached = _DIRECTORY.get('list')
    if cached and now - cached[0] < DIRECTORY_SECONDS:
        return cached[1]
    token, allowed = _token_for(user_id), config()['allowed']
    people, cursor = [], ''
    try:
        for _ in range(50):  # 100명 × 50쪽까지
            data = _get_json(f'{API_BASE}/users?' + urlencode(dict(count=100, **({'cursor': cursor} if cursor else {}))), token)
            people += [m for m in (_member(u, allowed) for u in data.get('users') or []) if m]
            cursor = (data.get('responseMetaData') or {}).get('nextCursor') or ''
            if not cursor:
                break
    except HTTPError as e:
        _log_failure('directory', e)
        if e.code in (401, 403):
            _TOKENS.pop(user_id, None)
            raise DirectoryUnavailable('WORKS 주소록 권한이 없거나 로그인이 만료됐어요. 다시 로그인해 주세요.')
        raise DirectoryUnavailable('WORKS 주소록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.')
    except (URLError, TimeoutError, ValueError) as e:
        _log_failure('directory', e)
        raise DirectoryUnavailable('WORKS 주소록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.')
    people.sort(key=lambda m: m['name'])
    _DIRECTORY['list'] = (now, people)
    return people


def search(people, q, exclude_email='', limit=20):
    q = ' '.join(str(q or '').lower().split())
    hits = [m for m in people if m['email'] != exclude_email and (not q or all(w in f"{m['name']} {m['email']} {m['org']}".lower() for w in q.split()))]
    return hits[:limit]
