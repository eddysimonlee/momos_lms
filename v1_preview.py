"""v1 화면 미리보기 HTML 한 장 만들기 — 서버·로그인·VPN 없이, 실제 화면 그대로.

    python3 v1_preview.py            → v1_preview.html 생성 (브라우저로 열기)

실제 v1.html·v1.js·CSS 를 그대로 쓰고, 서버(/api/onboarding, /api/dev/accounts, 로그인)만
브라우저 안의 가짜 서버로 바꾼다. 그래서 역할 전환 바, 체크, 확인 요청, 담당자 확인 완료까지
서버 배포본과 같게 동작한다. 기록은 이 브라우저(localStorage)에만 남고, 체험 계정은
staff / learner / newbie 셋이다(dev_seed 와 같음). 미리보기 상단 띠에서 '기록 초기화'로 지운다.

v1_lessons.json 을 고친 뒤 다시 돌리면 바로 반영된다.
"""
import base64
import json
import re
from pathlib import Path

APP = Path(__file__).parent


def inline_file(path):
    return path.read_text(encoding='utf-8') if path.exists() else ''


def main():
    # 서버와 똑같은 내용: 빌드 산출물(v1_content.json) 위에 v1_lessons.json 을 덮는 것은 server.v1_content() 하나로만 한다.
    import server
    content = server.v1_content()
    for ph in content.get('photos', {}).values():  # 미리보기는 한 파일이므로 사진을 안에 넣는다
        f = APP / ph['src']
        if f.exists():
            ph['src'] = 'data:image/jpeg;base64,' + base64.b64encode(f.read_bytes()).decode()
    page = (APP / 'v1.html').read_text(encoding='utf-8')
    # 외부 파일을 전부 안에 넣는다
    font = APP / 'assets/PretendardVariable.woff2'
    font_css = ''
    if font.exists():
        font_css = "<style>@font-face{font-family:'Pretendard Variable';font-weight:45 920;src:url(data:font/woff2;base64,%s) format('woff2')}</style>" % base64.b64encode(font.read_bytes()).decode()
    styles = re.sub(r"url\('assets/PretendardVariable.woff2'\)", "url(data:,)", inline_file(APP / 'styles.css'))
    page = page.replace('<link rel="stylesheet" href="/styles.css">', font_css + '<style>' + styles + '</style>')
    page = page.replace('<link rel="stylesheet" href="/wds/web/variables.css">', '<style>' + inline_file(APP / 'wds/web/variables.css') + '</style>')
    page = re.sub(r'<link rel="icon"[^>]*>\s*', '', page)
    page = re.sub(r'<link rel="apple-touch-icon"[^>]*>\s*', '', page)
    data = json.dumps(content, ensure_ascii=False).replace('</', '<\\/')
    mock = MOCK.replace('/*CONTENT*/', 'const CONTENT=' + data + ';')
    page = page.replace('<script src="/auth.js"></script>', '<script>' + mock + '</script>')
    page = page.replace('<script src="/v1.js"></script>', '<script>' + (APP / 'v1.js').read_text(encoding='utf-8').replace('</script', '<\\/script') + '</script>')
    page = page.replace('<body class="auth-pending">', '<body class="auth-pending">' + BANNER, 1)
    page = page.replace('</head>', '<style>' + BANNER_CSS + '</style></head>', 1)
    (APP / 'v1_preview.html').write_text(page, encoding='utf-8')
    print('v1_preview.html:', sum(len(u['steps']) for u in content['units']), 'steps —', (APP / 'v1_preview.html').resolve())


BANNER = '<div class="pv-bar">미리보기 · 실제 화면과 같이 동작하지만 기록은 이 브라우저에만 남아요 <button id="pvReset" type="button">기록 초기화</button></div>'
BANNER_CSS = '.pv-bar{background:#FFF4CC;color:#5A4A00;font:500 12px/1.4 -apple-system,sans-serif;padding:6px 12px;text-align:center}.pv-bar button{margin-left:8px;font:inherit;border:1px solid #C9B86A;background:#fff;border-radius:6px;padding:1px 8px;cursor:pointer}'

MOCK = r'''
/*CONTENT*/
// ---- 브라우저 안의 가짜 서버: onboarding.py 의 v1 관련 동작만 흉내 낸다 ----
(function(){
  const today = () => new Date().toISOString().slice(0, 10);
  const plus = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const STEPS = {}; for (const u of CONTENT.units) for (const s of u.steps) STEPS[s.id] = s;
  const ACCOUNTS = [
    {id: 'u-staff', name: '체험 담당자', email: 'staff@local.test', role: 'admin'},
    {id: 'u-learner', name: '체험 교육생', email: 'learner@local.test', role: 'member'},
    {id: 'u-newbie', name: '체험 신입', email: 'newbie@local.test', role: 'member'}];
  const KEY = 'momos-v1-preview-6';
  function blank(join) {
    const records = {};
    for (const [id, s] of Object.entries(STEPS)) records[id] = {status: 'ready', self: s.checks.map(() => false), teacher: s.checks.map(() => false),
      selfAt: s.checks.map(() => null), teacherAt: s.checks.map(() => null), start: null, done: null, request: null, attempt: 1, memo: '', feedback: '', history: []};
    return {revision: 0, join, startDate: join, records};
  }
  function fresh() {
    const st = {current: 'u-learner', rootRevision: 0, learners: {}, rooms: {}};
    st.learners['u-learner'] = {join: plus(today(), -4), startDate: plus(today(), -4), trainer: 'u-staff', assessor: 'u-staff'};
    st.rooms['u-learner'] = blank(plus(today(), -4));
    return st;
  }
  let state; try { state = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!state || !state.rooms) state = fresh();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} };
  const user = () => ACCOUNTS.find(a => a.id === state.current);
  const isAdmin = u => u.role === 'admin';
  function roles(u, target) {
    const entry = state.learners[target]; const own = u.id === target && !!entry; const admin = isAdmin(u);
    return {own, trainer: !!entry && !own && (admin || entry.trainer === u.id), assessor: !!entry && !own && (admin || entry.assessor === u.id), admin};
  }
  function context(u, target) {
    target = target || u.id;
    const p = roles(u, target);
    if (!(target === u.id || p.trainer || p.assessor || p.admin)) throw {status: 403, error: '본인 또는 배정된 교육생의 기록만 열 수 있습니다.'};
    const entry = state.learners[target];
    const learner = entry ? state.rooms[target] : blank(today());
    const roster = Object.entries(state.learners).filter(([i]) => { const q = roles(u, i); return i === u.id || q.trainer || q.assessor || q.admin; })
      .map(([i, x]) => ({id: i, name: ACCOUNTS.find(a => a.id === i)?.name || i, join: x.join, startDate: x.startDate,
        trainer: ACCOUNTS.find(a => a.id === x.trainer)?.name || '미배정', assessor: ACCOUNTS.find(a => a.id === x.assessor)?.name || '미배정'}));
    if (!roster.some(r => r.id === u.id)) roster.unshift({id: u.id, name: u.name, join: null, startDate: null, trainer: '미배정', assessor: '미배정'});
    const workspaceRoles = {admin: isAdmin(u), learner: !!state.learners[u.id],
      trainer: Object.values(state.learners).some(x => x.trainer === u.id), assessor: Object.values(state.learners).some(x => x.assessor === u.id)};
    return {user: {id: u.id, name: u.name}, target, name: ACCOUNTS.find(a => a.id === target)?.name || target, permissions: p, workspaceRoles, roster,
      enrolled: !!entry, scheduled: !!(learner && learner.startDate), today: today(), rootRevision: state.rootRevision, learner: JSON.parse(JSON.stringify(learner))};
  }
  function update(u, v) {
    const target = v.target || u.id, p = roles(u, target), d = v.data || {};
    if (v.action === 'config.selfEnrol') {
      if (!state.learners[u.id]) { const t = today(); state.learners[u.id] = {join: t, startDate: t, trainer: null, assessor: null}; state.rooms[u.id] = blank(t); state.rootRevision++; }
      save(); return context(u, target);
    }
    const l = state.rooms[target]; if (!l) throw {status: 400, error: '교육 시작일을 먼저 지정하세요.'};
    const teacher = ['step.teacher', 'step.complete'].includes(v.action);
    if (teacher && !p.trainer) throw {status: 403, error: '배정된 교육자·평가자만 확인합니다. 자기 승인은 허용하지 않습니다.'};
    if (!teacher && !p.own) throw {status: 403, error: '직원 실습·답안은 해당 직원만 기록합니다.'};
    const r = l.records[d.step]; if (!r) throw {status: 400, error: '배정된 교육 단계를 선택하세요.'};
    const t = today();
    if (v.action === 'step.self' || v.action === 'step.teacher') {
      const k = v.action === 'step.teacher' ? 'teacher' : 'self';
      if ((k === 'teacher' && r.status !== 'review') || (k === 'self' && !['ready', 'practice'].includes(r.status))) throw {status: 400, error: '현재 단계 상태에서 이 체크를 변경할 수 없습니다.'};
      r[k][d.index] = !!d.on; r[k + 'At'][d.index] = d.on ? t : null;
      if (k === 'self') { r.status = 'practice'; r.start = r.start || t; }
    } else if (v.action === 'step.memo') { r.memo = String(d.memo || '').slice(0, 4000); }
    else if (v.action === 'step.request') { if (r.status !== 'practice' || !r.self.every(Boolean)) throw {status: 400, error: '직원 실습 체크를 모두 완료하세요.'}; r.status = 'review'; r.request = t; }
    else if (v.action === 'step.complete') { if (r.status !== 'review' || !r.teacher.every(Boolean)) throw {status: 400, error: '교육자 확인 항목을 모두 체크하세요.'}; r.status = 'done'; r.done = t; r.completedBy = u.id; }
    else throw {status: 400, error: '지원하지 않는 작업: ' + v.action};
    l.revision++; save(); return context(u, target);
  }
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {status, headers: {'Content-Type': 'application/json'}});
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://preview.local');
    const method = (init.method || 'GET').toUpperCase();
    try {
      if (url.pathname === '/v1_content.json') return json(CONTENT);
      if (url.pathname === '/api/auth/status') return json({user: user()});
      if (url.pathname === '/api/dev/accounts') {
        if (method === 'POST') { const id = url.searchParams.get('id'); if (ACCOUNTS.some(a => a.id === id)) { state.current = id; save(); return json({ok: true}); } return json({error: '없는 계정'}, 404); }
        return json({accounts: ACCOUNTS.map(a => ({id: a.id, name: a.name, email: a.email})), current: state.current});
      }
      if (url.pathname === '/api/onboarding') {
        const target = url.searchParams.get('target') || undefined;
        if (method === 'GET') return json(context(user(), target));
        return json(update(user(), JSON.parse(init.body || '{}')));
      }
    } catch (e) { if (e && e.status) return json({error: e.error}, e.status); throw e; }
    return realFetch(input, init);
  };
  window.ERPAuth = {csrfToken: 'preview', openAccount: () => alert('미리보기에서는 계정 메뉴가 없어요. 상단 ‘역할 전환’으로 바꾸세요.'),
    ensureSession: async () => {  // auth.js 의 activate() 가 하던 일: 게이트를 닫고 화면을 연다
      const u = user(); const gate = document.getElementById('authGate'); if (gate) gate.hidden = true;
      document.body.classList.remove('auth-pending');
      const shell = document.getElementById('appShell'); if (shell) { shell.inert = false; shell.removeAttribute('aria-hidden'); }
      const who = document.getElementById('v1Who'); if (who) who.textContent = u.name;
      const an = document.getElementById('accountName'); if (an) an.textContent = u.name;
      return {user: u};
    }};
  document.addEventListener('DOMContentLoaded', () => { const b = document.getElementById('pvReset'); if (b) b.onclick = () => { state = fresh(); save(); location.reload(); }; });
})();
'''


if __name__ == '__main__':
    main()
