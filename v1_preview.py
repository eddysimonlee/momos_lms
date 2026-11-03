"""v1 화면 미리보기 HTML 한 장 만들기 — 서버·로그인·VPN 없이, 실제 화면 그대로.

    python3 v1_preview.py            → v1_preview.html 생성 (브라우저로 열기)

실제 v1.html·v1.js·CSS 를 그대로 쓰고, 서버(/api/onboarding, 로그인)만 브라우저 안의 가짜 서버로 바꾼다.
지점·역할 선택, 체크, 확인 요청, 관리자 확인 완료·재교육까지 서버 배포본과 같게 동작한다.
WORKS 로그인 대신 상단 띠에서 체험 계정(담당자·교육생·신입)을 고른다. 기록은 이 브라우저(localStorage)에만 남고,
탭끼리 공유되어 탭 두 개로 교육생·관리자 화면을 나란히 볼 수 있다. '기록 초기화'로 지운다.

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
    font = APP / 'assets/PretendardVariable.woff2'  # v1.html 의 @font-face 주소를 data URI 로(ERP styles.css 는 v1 에서 쓰지 않는다)
    if font.exists():
        page = page.replace("url('/assets/PretendardVariable.woff2')", "url(data:font/woff2;base64,%s)" % base64.b64encode(font.read_bytes()).decode())
    page = page.replace('<link rel="stylesheet" href="/wds/web/variables.css">', '<style>' + inline_file(APP / 'wds/web/variables.css') + '</style>')
    page = re.sub(r'<link rel="icon"[^>]*>\s*', '', page)
    page = re.sub(r'<link rel="apple-touch-icon"[^>]*>\s*', '', page)
    data = json.dumps(content, ensure_ascii=False).replace('</', '<\\/')
    log = json.dumps(json.loads((APP / 'source_log.json').read_text(encoding='utf-8')).get('entries', []), ensure_ascii=False).replace('</', '<\\/') if (APP / 'source_log.json').exists() else '[]'
    mock = MOCK.replace('/*CONTENT*/', 'const CONTENT=' + data + ';const SOURCE_LOG=' + log + ';')
    page = page.replace('<script src="/auth.js"></script>', '<script>' + mock + '</script>')
    page = page.replace('<script src="/v1.js"></script>', '<script>' + (APP / 'v1.js').read_text(encoding='utf-8').replace('</script', '<\\/script') + '</script>')
    page = page.replace('<body class="auth-pending">', '<body class="auth-pending">' + BANNER, 1)
    page = page.replace('</head>', '<style>' + BANNER_CSS + '</style></head>', 1)
    (APP / 'v1_preview.html').write_text(page, encoding='utf-8')
    # 11/03 연결도(/v1/graph) 미리보기: 같은 가짜 서버를 넣고 '체험 담당자(admin)'로 연다. 수정 요청은 v1_preview 와 같은 기록(localStorage)에 쌓인다
    g = (APP / 'v1_graph.html').read_text(encoding='utf-8')
    g = g.replace('<link rel="stylesheet" href="/wds/web/variables.css">', '<style>' + inline_file(APP / 'wds/web/variables.css') + '</style>')
    g = re.sub(r'<link rel="icon"[^>]*>\s*', '', g)
    if font.exists():
        g = g.replace("url('/assets/PretendardVariable.woff2')", "url(data:font/woff2;base64,%s)" % base64.b64encode(font.read_bytes()).decode())
    who = "<script>try{sessionStorage.setItem('" + re.search(r"const KEY = '([^']+)'", MOCK).group(1) + "-who','u-staff')}catch(e){}</script>"
    g = g.replace('<script>', who + '<script>' + mock + '</script><script>', 1)
    g = g.replace('href="/v1"', 'href="v1_preview.html"')
    (APP / 'v1_graph_preview.html').write_text(g, encoding='utf-8')
    print('v1_preview.html:', sum(len(u['steps']) for u in content['units']), 'steps —', (APP / 'v1_preview.html').resolve())


BANNER = '<div class="pv-bar">미리보기 · 로그인 계정(WORKS 대신) <span id="pvWho"></span> · 기록은 이 브라우저에만 남아요 <button id="pvReset" type="button">기록 초기화</button></div>'
BANNER_CSS = '.pv-bar{background:#FFF4CC;color:#5A4A00;font:500 12px/1.4 -apple-system,sans-serif;padding:6px 12px;text-align:center}.pv-bar button.on{background:#5A4A00;color:#fff;border-color:#5A4A00}.pv-bar button{margin-left:8px;font:inherit;border:1px solid #C9B86A;background:#fff;border-radius:6px;padding:1px 8px;cursor:pointer}'

MOCK = r'''
/*CONTENT*/
// ---- 브라우저 안의 가짜 서버: onboarding.py 의 v1 관련 동작만 흉내 낸다 ----
(function(){
  const today = () => new Date().toISOString().slice(0, 10);
  const plus = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const STEPS = {}; for (const u of CONTENT.units) for (const s of u.steps) STEPS[s.id] = s;
  // 체크 = 교육 내용 항목(없으면 체크 목록) — onboarding.STEPS 와 같은 규칙
  const N = s => (s.keyPoints && s.keyPoints.length ? s.keyPoints : s.checks).map(() => null);
  const ACCOUNTS = [
    {id: 'u-staff', name: '체험 담당자', email: 'staff@local.test', role: 'admin'},
    {id: 'u-learner', name: '체험 교육생', email: 'learner@local.test', role: 'member'},
    {id: 'u-newbie', name: '체험 신입', email: 'newbie@local.test', role: 'member'}];
  // 미리보기용 입사일(WORKS hiredDate 대신). 체험 신입은 비어 있음 → N/A
  const HIRED = {'u-staff': '2024-08-31', 'u-learner': '2026-09-15'};
  const target6 = h => { if (!h) return null; const [y, m, d] = h.split('-').map(Number); const t = m - 1 + 6, Y = y + Math.floor(t / 12), M = t % 12;
    const last = new Date(Date.UTC(Y, M + 1, 0)).getUTCDate(); return `${Y}-${String(M + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`; };
  const dates = id => ({hiredDate: HIRED[id] || null, targetDate: target6(HIRED[id])});
  // 미리보기용 직책·부서(WORKS positionName·orgUnitName 대신). 체험 신입은 부서를 못 읽은 경우 → '부서 미확인'
  const POSITION = {'u-staff': '매니저', 'u-learner': '사원', 'u-newbie': '사원'};
  const ORG = {'u-staff': '온천본점', 'u-learner': '온천본점'};
  // 미리보기용 주소록(WORKS 부서·구성원 대신). 체험 미접속 구성원은 교육을 시작하지 않은 사람
  const UNITS = [['exec', '임원실', null], ['brand', '브랜드전략사업부', null], ['brand-plan', '브랜드기획팀', 'brand'], ['ecom', '이커머스파트', 'brand-plan'],
    ['store', '매장사업부', null], ['bakery', '베이커리팀', 'store'], ['oncheon', '온천본점', 'store'], ['marine', '마린점', 'store'], ['yeongdo', '영도점', 'store'],
    ['bean', '생두사업부', null], ['tech', '기술부', null], ['qa', '품질개발팀', 'tech'], ['ops', '경영지원실', null]].map(([id, name, parent], order) => ({id, name, parent, order}));
  const UNIT_OF = {'u-staff': 'oncheon', 'u-learner': 'oncheon'};
  const OFFLINE = [['체험 바리스타', 'oncheon', '사원'], ['가나 바리스타', 'oncheon', '사원'], ['체험 점장', 'oncheon', '점장'], ['체험 매니저', 'oncheon', '매니저'], ['체험 베이커', 'bakery', '사원'], ['체험 마린', 'marine', '매니저'], ['체험 본부장', 'store', '본부장']];
  const SEED = ['staff@local.test'];  // 미리보기의 기본 LMS관리자
  // 미리보기 전용 주소록(WORKS 대신). 실제 서비스는 /api/works/members 가 NAVER WORKS 주소록을 검색한다(admin 만)
  const DIRECTORY = [
    {id: 'w-staff', name: '체험 담당자', email: 'staff@local.test', org: '바리스타팀 · 메인바리스타'},
    {id: 'w-manager', name: '체험 매니저', email: 'manager@local.test', org: '바리스타팀 · 매니저'},
    {id: 'w-store', name: '체험 점장', email: 'store@local.test', org: '온천 본점 · 점장'},
    {id: 'w-newbie', name: '체험 신입', email: 'newbie@local.test', org: '바리스타팀'}];
  const KEY = 'momos-v1-preview-20';
  function blank(join) {
    const records = {};
    for (const [id, s] of Object.entries(STEPS)) records[id] = {status: 'ready', self: N(s).map(() => false), teacher: N(s).map(() => false),
      selfAt: N(s), teacherAt: N(s), teacherBy: N(s), teacherName: N(s), start: null, done: null, request: null, attempt: 1, memo: '', feedback: '', history: []};
    return {revision: 0, join, startDate: join, records};
  }
  function fresh() {
    const st = {rootRevision: 0, learners: {}, rooms: {}, profiles: {}, lmsAdmins: [], feedback: []};
    st.learners['u-learner'] = {join: plus(today(), -4), startDate: plus(today(), -4), trainer: null, assessor: null};
    st.rooms['u-learner'] = blank(plus(today(), -4));
    return st;
  }
  // 기록은 탭끼리 공유(localStorage) — 탭 두 개로 교육생·관리자를 나란히 볼 수 있다. 로그인한 계정은 탭마다(sessionStorage).
  const load = () => { let st; try { st = JSON.parse(localStorage.getItem(KEY)); } catch (e) {} return st && st.rooms ? st : fresh(); };
  let state = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} };
  let current = 'u-learner'; try { current = sessionStorage.getItem(KEY + '-who') || current; } catch (e) {}
  const setCurrent = id => { current = id; try { sessionStorage.setItem(KEY + '-who', id); } catch (e) {} };
  const user = () => ACCOUNTS.find(a => a.id === current);
  const levels = () => { const m = {}; for (const x of state.lmsAdmins || []) if (x && x.email && x.level === 'admin') m[x.email] = 'admin'; for (const e of SEED) m[e] = 'admin'; return m; };
  const levelOf = u => levels()[u.email] || null;
  const isLms = u => Boolean(levelOf(u));  // onboarding.lms_staff: 지정된 이메일(admin)만 LMS관리자
  function roles(u, target) {  // 11/02: 모든 직원이 다른 사람 교육을 보고 체크(본인 제외)
    const entry = state.learners[target]; const own = u.id === target && !!entry; const staff = true;
    return {own, trainer: !!entry && !own && staff, assessor: !!entry && !own && staff, admin: false};
  }
  function context(u, target) {
    target = target || u.id;
    const p = roles(u, target);
    if (!(target === u.id || p.trainer)) throw {status: 403, error: '본인 또는 배정된 교육생의 기록만 열 수 있습니다.'};
    const entry = state.learners[target];
    const learner = entry ? state.rooms[target] : blank(today());
    const roster = Object.entries(state.learners).filter(([i]) => i === u.id || roles(u, i).trainer)
      .map(([i, x]) => ({id: i, name: ACCOUNTS.find(a => a.id === i)?.name || i, join: x.join, startDate: x.startDate}));
    if (!roster.some(r => r.id === u.id)) roster.unshift({id: u.id, name: u.name, join: null, startDate: null});
    const nameOf = id => ACCOUNTS.find(a => a.id === id)?.name || id;
    const mentorsOf = id => { const out = new Map(), take = x => { (x.teacherBy || []).forEach((w, k) => { if (w && !out.has(w)) out.set(w, (x.teacherName || [])[k] || nameOf(w)); }); if (x.completedBy && !out.has(x.completedBy)) out.set(x.completedBy, x.completedByName || nameOf(x.completedBy)); };
      const room = state.rooms[id]; if (room) Object.values(room.records).forEach(x => { take(x); (x.history || []).forEach(h => h && take(h)); }); return [...out.values()]; };
    const educationSummary = roster.filter(r => state.learners[r.id]).map(r => { const recs = state.rooms[r.id].records;
      const states = {}; for (const [k, x] of Object.entries(recs)) if (x.status !== 'ready') states[k] = x.status;
      const ever = Object.values(recs).some(x => (x.teacherBy || []).includes(u.id) || (x.status === 'done' && x.completedBy === u.id));  // 지금 체크·완료한 것만(체크를 풀면 빠진다)
      return {...r, ...dates(r.id), org: ORG[r.id] || null, position: POSITION[r.id] || null, states, trainedByMe: r.id !== u.id && ever}; });
    const lms = isLms(u);
    return {educationSummary, user: {id: u.id, name: u.name, email: u.email}, profile: (state.profiles || {})[u.id] || null, target, name: ACCOUNTS.find(a => a.id === target)?.name || target, permissions: p,
      workspaceRoles: {admin: false, staff: lms, learner: !!state.learners[u.id]}, roster, myDates: dates(u.id), profileMissing: false, orgChart: {units: UNITS, positions: ['본부장', '점장', '매니저', '사원'], mine: UNIT_OF[u.id] || null, members: ACCOUNTS.map(a => ({id: state.learners[a.id] ? a.id : null, name: a.name, position: POSITION[a.id] || null, org: UNIT_OF[a.id] || null})).concat(OFFLINE.map(([name, org, position]) => ({id: null, name, org, position})))}, lmsAdmin: lms, lmsLevel: levelOf(u),
      ...(lms ? {contentRequests: (state.contentRequests || []).slice().reverse(), sourceLog: SOURCE_LOG, lmsAdmins: Object.entries(levels()).sort((a, b) => a[0].localeCompare(b[0])).map(([e, l]) => ({email: e, level: l, seed: SEED.includes(e)})), feedback: (state.feedback || []).slice().reverse().map(f => { const m = 'mentee' in f ? f.mentee : f.user; return {...f, mentee: m, menteeName: m ? (f.menteeName || nameOf(m)) : '', mentors: m ? mentorsOf(m) : []}; })} : {}),
      enrolled: !!entry, scheduled: !!(learner && learner.startDate), today: today(), rootRevision: state.rootRevision, learner: JSON.parse(JSON.stringify(learner))};
  }
  function update(u, v) {
    const target = v.target || u.id, p = roles(u, target), d = v.data || {};
    if (v.action === 'profile.set') {
      if (target !== u.id) throw {status: 403, error: '본인의 지점·역할만 바꿀 수 있습니다.'};
      if (d.role === 'staff' && !isLms(u)) throw {status: 403, error: '관리자는 LMS관리자로 지정된 구성원만 선택할 수 있습니다.'};
      (state.profiles = state.profiles || {})[u.id] = {branch: d.branch, role: d.role, at: new Date().toISOString()}; state.rootRevision++;
      save(); return context(u, target);
    }
    if (v.action === 'config.selfEnrol') {
      if (!state.learners[u.id]) { const t = today(); state.learners[u.id] = {join: t, startDate: t, trainer: null, assessor: null}; state.rooms[u.id] = blank(t); state.rootRevision++; }
      save(); return context(u, target);
    }
    if (v.action === 'lms.admin') {
      if (levelOf(u) !== 'admin') throw {status: 403, error: 'LMS관리자 권한은 admin 만 바꿀 수 있습니다.'};
      const email = String(d.email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw {status: 400, error: '이메일 주소를 확인해 주세요.'};
      if (SEED.includes(email) || email === u.email) throw {status: 400, error: '기본 admin 과 본인의 권한은 바꿀 수 없어요.'};
      state.lmsAdmins = (state.lmsAdmins || []).filter(x => x.email !== email).concat(d.level === 'admin' ? [{email, level: 'admin'}] : []); state.rootRevision++; save(); return context(u, target);
    }
    if (v.action === 'content.request' || v.action === 'content.status') {  // 11/03 수정 요청(onboarding.content_request/status 와 같은 규칙)
      if (levelOf(u) !== 'admin') throw {status: 403, error: '수정 요청은 LMS관리자 admin 만 보낼 수 있어요.'};
      const at = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19) + '+09:00', list = state.contentRequests = state.contentRequests || [];
      if (v.action === 'content.request') {
        if (!String(d.tobe || '').trim()) throw {status: 400, error: '바꿀 내용을 적어 주세요.'};
        list.push({id: String(Date.now()), at, user: u.id, name: u.name, email: u.email, target: d.target, type: d.type, field: d.field || '', asis: d.asis || '', tobe: d.tobe, note: d.note || '', status: '요청', history: [{at, by: u.name, status: '요청'}]});
      } else {
        const r = list.find(x => x.id === d.id); if (!r) throw {status: 400, error: '수정 요청을 찾지 못했어요.'};
        if (d.status === '반려' && !d.note) throw {status: 400, error: '반려 사유를 적어 주세요.'};
        if (d.commit && !/^[0-9a-f]{7,40}$/.test(d.commit)) throw {status: 400, error: '커밋 번호(7자리 이상)를 확인해 주세요.'};
        r.status = d.status; if (d.note) r.reply = d.note; if (d.commit) r.commit = d.commit;
        r.history = (r.history || []).concat([{at, by: u.name, status: d.status, ...(d.note ? {note: d.note} : {}), ...(d.commit ? {commit: d.commit} : {})}]);
      }
      state.rootRevision++; save(); return context(u, target);
    }
    if (v.action === 'feedback.send') {
      if (target !== u.id && !p.trainer) throw {status: 403, error: '본인 교육 화면이나 구성원의 교육 화면에서만 의견을 보낼 수 있어요.'};
      const mentee = target;
      const text = String(d.text || '').trim(); if (!text) throw {status: 400, error: '입력 내용의 길이와 필수 항목을 확인해 주세요.'};
      (state.feedback = state.feedback || []).push({id: String(Date.now()), at: new Date(Date.now() + 9 * 3600e3).toISOString(), user: u.id, name: u.name, email: u.email, step: d.step, text: text.slice(0, 2000), mentee, menteeName: mentee ? (ACCOUNTS.find(a => a.id === mentee)?.name || mentee) : ''});
      state.rootRevision++; save(); return context(u, target);
    }
    const l = state.rooms[target]; if (!l) throw {status: 400, error: '교육 시작일을 먼저 지정하세요.'};
    const teacher = ['step.mark', 'step.close', 'step.reopen'].includes(v.action);
    if (teacher && !p.trainer) throw {status: 403, error: '배정된 교육자·평가자만 확인합니다. 자기 승인은 허용하지 않습니다.'};
    if (!teacher) throw {status: 400, error: '지원하지 않는 작업: ' + v.action};
    const r = l.records[d.step]; if (!r) throw {status: 400, error: '배정된 교육 단계를 선택하세요.'};
    const t = today();
    if (v.action === 'step.mark') {
      if (!['ready', 'practice'].includes(r.status)) throw {status: 400, error: '완료한 교육은 체크를 바꿀 수 없어요. 완료를 취소한 뒤 바꿔 주세요.'};
      for (const k of ['teacherBy', 'teacherName', 'teacherWhen']) if (!r[k]) r[k] = r.teacher.map(() => null);
      r.teacher[d.index] = !!d.on; r.teacherAt[d.index] = d.on ? t : null; r.teacherWhen[d.index] = d.on ? new Date().toISOString() : null; r.teacherBy[d.index] = d.on ? u.id : null; r.teacherName[d.index] = d.on ? u.name : null;
      r.status = r.teacher.some(Boolean) ? 'practice' : 'ready'; r.start = r.start || t;
    } else if (v.action === 'step.close') {
      if (!['ready', 'practice'].includes(r.status) || !r.teacher.every(Boolean)) throw {status: 400, error: '교육 내용을 모두 체크한 뒤 완료할 수 있어요.'};
      Object.assign(r, {status: 'done', done: t, completedBy: u.id, completedByName: u.name});
    } else {
      if (r.status !== 'done') throw {status: 400, error: '완료한 항목만 완료를 취소할 수 있어요.'};
      r.history = (r.history || []).concat([{...r, history: undefined, reopened: t}]); r.status = 'practice'; r.done = null; delete r.completedBy; delete r.completedByName;
    }
    l.revision++; save(); return context(u, target);
  }
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {status, headers: {'Content-Type': 'application/json'}});
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://preview.local');
    const method = (init.method || 'GET').toUpperCase();
    try {
      state = load();  // 다른 탭의 변경을 반영
      if (url.pathname === '/v1_content.json') return json(CONTENT);
      if (url.pathname === '/api/auth/status') return json({user: user(), works: false});
      if (url.pathname === '/api/dev/accounts') {
        if (method === 'POST') { const id = url.searchParams.get('id'); if (ACCOUNTS.some(a => a.id === id)) { setCurrent(id); return json({ok: true}); } return json({error: '없는 계정'}, 404); }
        return json({accounts: ACCOUNTS.map(a => ({id: a.id, name: a.name, email: a.email})), current});
      }
      if (url.pathname === '/api/works/members') {
        if (levelOf(user()) !== 'admin') return json({error: '구성원 검색은 LMS관리자 admin 만 할 수 있습니다.'}, 403);
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        await new Promise(r => setTimeout(r, 200));
        return json({members: DIRECTORY.filter(m => m.email !== user().email && (!q || `${m.name} ${m.email} ${m.org}`.toLowerCase().includes(q))).slice(0, 20)});
      }
      if (url.pathname === '/api/onboarding') {
        const target = url.searchParams.get('target') || undefined;
        if (method === 'GET') return json(context(user(), target));
        return json(update(user(), JSON.parse(init.body || '{}')));
      }
    } catch (e) { if (e && e.status) return json({error: e.error}, e.status); throw e; }
    return realFetch(input, init);
  };
  window.ERPAuth = {csrfToken: 'preview', openAccount: () => {},
    ensureSession: async () => {  // auth.js 의 activate() 가 하던 일: 게이트를 닫고 화면을 연다
      const u = user(); const gate = document.getElementById('authGate'); if (gate) gate.hidden = true;
      document.body.classList.remove('auth-pending');
      const shell = document.getElementById('appShell'); if (shell) { shell.inert = false; shell.removeAttribute('aria-hidden'); }
      const who = document.getElementById('v1Who'); if (who) who.textContent = u.name;
      const an = document.getElementById('accountName'); if (an) an.textContent = u.name;
      return {user: u};
    }};
  document.addEventListener('DOMContentLoaded', () => {
    const b = document.getElementById('pvReset'); if (b) b.onclick = () => { state = fresh(); save(); location.reload(); };
    // 미리보기 전용: WORKS 로그인 대신 체험 계정을 고른다(실제 서비스에는 없음)
    const box = document.getElementById('pvWho');
    if (box) { box.innerHTML = ACCOUNTS.map(a => `<button type="button" data-pv="${a.id}" class="${a.id === current ? 'on' : ''}">${a.name}</button>`).join('');
      box.querySelectorAll('[data-pv]').forEach(x => x.onclick = () => { setCurrent(x.dataset.pv); location.reload(); }); }
  });
})();
'''


if __name__ == '__main__':
    main()
