// Momos onboarding · v1: 단계 → 단원 → 세션. read → check → trainer confirm. Phone first.
// Data: /v1_content.json (the course slice) and /api/onboarding (records). No local-only state.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const STATUS = {ready: '시작 전', practice: '진행 중', review: '담당자 확인 대기', done: '완료', planned: '준비 중'};
  const dateLabel = d => d ? d.replace(/-/g, '.') : '-';

  let shownView = null, keepFocus = null, pickBranch = null;  // pickBranch: 지점을 고른 뒤 역할을 고르기 전
  let returnView = 'home';  // 항목 화면의 꺽쇠가 돌아갈 화면
  let homeScroll = null;  // 홈을 떠날 때의 {단계 탭, 스크롤 위치}. 항목에 들어갔다 뒤로 오면 그 자리로 돌아간다.
  let lastStep = null;    // 마지막으로 본 항목(저장된 위치가 없을 때 목록에서 그 항목을 보여 준다)  // 마지막으로 그린 화면(같은 화면 다시 그리기와 이동을 구분)
  let content = null, cloud = null, view = 'branch', busy = false, toastTimer = null, stageSel = null;

  function toast(message) {
    const el = $('v1Toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function api(method, value, target) {
    const url = '/api/onboarding' + (target ? '?target=' + encodeURIComponent(target) : '');
    const response = await fetch(url, {method, credentials: 'same-origin', cache: 'no-store',
      headers: {'Content-Type': 'application/json', 'X-CSRF-Token': ERPAuth.csrfToken || ''},
      ...(value ? {body: JSON.stringify(value)} : {})});
    let data; try { data = await response.json(); } catch { throw new Error('서버 응답을 확인하지 못했습니다.'); }
    if (!response.ok) throw new Error(data.error || data.message || '저장하지 못했습니다.');
    return data;
  }

  async function load(target) {
    cloud = await api('GET', null, target);
    render();
  }

  // 요청 id: 오래된 iOS WebView 에는 crypto.randomUUID 가 없다 → getRandomValues 로 만든다
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

  // 관리자의 교육 내용 체크: 화면을 다시 그리지 않고 그 자리에서 바꾼 뒤 서버에 저장한다(스크롤·포커스가 그대로).
  // 빠르게 여러 개를 눌러도 순서대로 하나씩 저장한다. 저장에 실패하면 서버 기록으로 화면을 되돌린다.
  let selfQueue = Promise.resolve(), selfPending = 0;
  function toggleMark(step, k, on) {
    const r = record(step.id), n = checkItems(step).length;
    if (!r.teacherName) r.teacherName = Array(n).fill(null);
    r.teacher[k] = on; r.teacherAt[k] = on ? cloud.today : null; r.teacherName[k] = on ? cloud.user.name : null;
    r.status = r.teacher.some(Boolean) ? 'practice' : 'ready';
    const box = $('app').querySelector(`[data-mark="${k}"]`);
    if (box) box.closest('li').classList.toggle('on', on);
    const by = $('app').querySelector(`[data-by="${k}"]`);
    if (by) by.textContent = on ? `${cloud.user.name} · ${dateLabel(cloud.today)}` : '미체크';
    const pill = $('app').querySelector('.v1-pill');
    if (pill) { pill.className = 'v1-pill ' + r.status; pill.textContent = STATUS[r.status]; }
    const close = $('app').querySelector('[data-close]');
    if (close) close.disabled = !checkItems(step).every((_, i) => r.teacher[i]);
    selfPending++;
    selfQueue = selfQueue.then(async () => {
      try {
        const fresh = await api('POST', {action: 'step.mark', target: cloud.target, revision: cloud.learner.revision, rootRevision: cloud.rootRevision,
          requestId: uid(), data: {step: step.id, index: k, on}});
        if (fresh.target === cloud.target) { const mine = record(step.id); cloud = fresh; Object.assign(record(step.id), {teacher: mine.teacher.slice(), teacherAt: mine.teacherAt.slice(), teacherName: mine.teacherName.slice(), status: mine.status}); }
      } catch (e) {
        toast(e.message || '체크를 저장하지 못했어요. 다시 눌러 주세요.');
        try { cloud = await api('GET', null, cloud.target); } catch {}
        if (selfPending === 1) render();
      } finally { selfPending--; }
    });
  }

  async function act(action, data) {
    if (busy) return false;
    busy = true; render();
    try {
      cloud = await api('POST', {action, target: cloud.target, revision: cloud.learner.revision, rootRevision: cloud.rootRevision,
        requestId: uid(), data});
      return true;
    } catch (e) {
      toast(e.message);
      if (e.status === 409) { try { cloud = await api('GET', null, cloud.target); } catch {} }
      return false;
    } finally { busy = false; render(); }
  }

  // --- helpers over the course slice and the learner record
  // 교육과정(curriculum.json): 단계 → 단원 → 세션. 세션이 기록 단위(항목)다.
  const steps = () => content.units.flatMap(u => u.steps);
  const planned = s => s.lessonStatus === 'planned';
  // 체크할 항목 = 교육 내용(keyPoints). 교육 내용이 없는 항목(첫날 OJT)은 체크 목록 자체. 서버(onboarding.STEPS)와 같은 규칙.
  const checkItems = s => s.keyPoints && s.keyPoints.length ? s.keyPoints : (s.checks || []).map(text => ({text, cites: []}));  // 교육안 준비 중(추가·교체 세션): 수행 확인 없음
  // 서버에 아직 기록 칸이 없는 새 세션도 화면이 깨지지 않도록 빈 기록을 돌려준다.
  const EMPTY = {status: 'ready', self: [], teacher: [], selfAt: [], teacherAt: [], memo: '', feedback: ''};
  const record = id => cloud.learner.records[id] || EMPTY;
  const statusOf = s => planned(s) ? 'planned' : record(s.id).status;
  const unitOf = id => content.units.find(u => u.steps.some(s => s.id === id));
  const stages = () => { const out = []; for (const u of content.units) { let g = out.find(x => x.order === u.stage.order); if (!g) out.push(g = Object.assign({units: []}, u.stage)); g.units.push(u); } return out; };
  const stepIndex = id => steps().findIndex(s => s.id === id);
  const canWrite = () => cloud.enrolled && cloud.scheduled;
  // Two roles on screen: 교육생 (own record) and 담당자 (store staff: any admin confirms; no assignment in 1차).
  // The record still stores who confirmed each check, so trainers can be split out later.
  // 화면의 역할은 첫 진입에서 고른 것(계정에 저장)을 따른다. 고르기 전(예전 계정)에는 서버 권한으로 판단.
  const profile = () => cloud.profile || null;
  const isStaff = () => Boolean(cloud.lmsAdmin);  // 10/30: 관리자 = 지정된 LMS관리자(이메일)만. 역할 선택은 없다
  const role = () => cloud.permissions.own ? 'learner' : isStaff() ? 'staff' : 'viewer';
  const mayConfirm = () => Boolean(cloud.permissions.trainer);
  const others = () => cloud.roster.filter(r => r.id !== cloud.user.id && r.join);

  // --- 홈 목록 필터(근무조·포지션, 모모스 분류표). 같은 84개 목록을 좁혀 볼 뿐 기록은 하나다.
  // 고른 값은 이 기기에만 기억한다(localStorage). 교육 화면에는 아무것도 더하지 않는다.
  const FILTER_KEY = 'v1.filter', FKIND = {shift: '근무조', position: '포지션'};
  let filt = (() => { try { return JSON.parse(localStorage.getItem(FILTER_KEY)); } catch { return null; } })(), sheetPick = null;
  const validFilter = f => f && f.k in FKIND && ((content.filters || {})[f.k] || []).includes(f.v) ? {k: f.k, v: f.v} : null;
  const matches = (s, f = filt) => !f || (s[f.k] || []).includes(f.v);
  // '다음 항목 ›': 필터를 걸었으면 그 필터 안의 다음 항목으로(번호는 전체 번호 그대로)
  const nextOf = s => { const f = returnView === 'all' ? validFilter(filt) : null; return steps().slice(stepIndex(s.id) + 1).find(x => matches(x, f)); };
  function setFilter(f) {
    filt = f;
    try { f ? localStorage.setItem(FILTER_KEY, JSON.stringify(f)) : localStorage.removeItem(FILTER_KEY); } catch {}
    homeScroll = null; lastStep = null; render(); window.scrollTo({top: 0, behavior: 'instant'});
  }
  function drawSheet() {
    const live = steps().filter(s => !planned(s)), n = f => live.filter(s => matches(s, f)).length;
    const on = f => sheetPick ? f && sheetPick.k === f.k && sheetPick.v === f.v : !f;
    const chip = f => `<button type="button" class="v1-fchip${on(f) ? ' on' : ''}" aria-pressed="${on(f)}" data-pick="${f ? esc(f.k + '|' + f.v) : ''}">${esc(f ? f.v : '전체')} <small>${n(f)}</small></button>`;
    const group = k => ((content.filters || {})[k] || []).length ? `<h3>${FKIND[k]}</h3><div class="v1-fwrap">${content.filters[k].map(v => chip({k, v})).join('')}</div>` : '';
    $('v1Sheet').querySelector('.v1-sheet-panel').innerHTML = '<div class="v1-sheet-grab" aria-hidden="true"></div><h2 id="v1SheetTitle">보기 필터</h2>' +
      '<p class="v1-muted">근무조나 포지션을 고르면 그 교육만 보여요. 완료 기록은 전체와 같아요.</p>' +
      `<div class="v1-fwrap" style="margin-top:var(--spacing-16)">${chip(null)}</div>${group('shift')}${group('position')}` +
      `<div class="v1-actions"><button type="button" class="v1-btn primary" data-sheet-apply>${n(sheetPick)}개 보기</button></div>`;
  }
  function openSheet() { sheetPick = filt; drawSheet(); $('v1Sheet').hidden = false; document.body.style.overflow = 'hidden'; $('v1Sheet').querySelector('[data-sheet-apply]').focus(); }
  function closeSheet() { $('v1Sheet').hidden = true; document.body.style.overflow = ''; const b = $('app').querySelector('[data-filter-open]'); if (b) b.focus({preventScroll: true}); }
  $('v1Sheet').addEventListener('click', e => {
    const t = e.target.closest('[data-pick],[data-sheet-apply],[data-sheet-close]');
    if (!t) return;
    if (t.hasAttribute('data-pick')) { const [k, v] = t.dataset.pick.split('|'); sheetPick = t.dataset.pick ? {k, v} : null; drawSheet(); }
    else if (t.hasAttribute('data-sheet-apply')) { closeSheet(); setFilter(sheetPick); }
    else closeSheet();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('v1Sheet').hidden) closeSheet(); });

  // --- rendering
  function render() {
    if (!cloud || !content) return;
    const step = view.startsWith('step:') ? steps()[stepIndex(view.slice(5))] : null;
    const branch = view === 'branch' || view === 'role';
    // 처음: 지점 선택 → 역할 선택 → 홈. 저장된 뒤에는 홈이 첫 화면이고, 지점·역할은 우상단 ⋮ 에서 바꾼다.
    // 꺽쇠: 항목 → 홈, 역할 → 지점, (바꾸는 중인) 지점 → 홈. 처음 지점 화면에서는 숨긴다.
    // 꺽쇠: 항목 → 들어온 화면(진행 현황·교육생·교육 단계), 교육생 진행 → 교육생 목록, 역할 → 지점, (바꾸는 중인) 지점 → 홈.
    // 꺽쇠가 없는 화면(홈·교육 단계)에는 왼쪽 메뉴(☰)
    const backTo = step ? returnView : view === 'person' && cloud.target !== cloud.user.id ? 'home' : view === 'role' ? 'branch' : view === 'branch' && profile() ? 'home' : null;
    $('v1Back').hidden = !backTo;
    $('v1Back').dataset.to = backTo || '';
    $('v1Back').setAttribute('aria-label', backTo === 'branch' ? '지점 선택으로' : backTo === 'home' && view === 'person' ? '교육생 목록으로' : '이전 화면으로');
    $('v1Ham').hidden = Boolean(backTo) || branch || !profile();
    $('v1Title').textContent = step ? step.title : view === 'home' ? '교육 진행 현황' : view === 'person' ? (cloud.target === cloud.user.id ? '내 교육' : cloud.name + '님') : view === 'stage' ? '교육 단계' : view === 'all' ? '전체 교육' : view === 'admin' ? 'LMS관리자' : '모모스 온보딩';
    const stg = step && unitOf(step.id).stage;  // 항목 화면: 제목 위에 '1. 입사·현장 적응'
    $('v1Stage').hidden = !stg;
    $('v1Stage').textContent = stg ? `${stg.order}. ${stg.title}` : '';
    if ($('v1Who').dataset.id !== cloud.user.id) {  // 사람이 바뀔 때만 다시 그린다(사진을 매번 다시 받지 않게)
      $('v1Who').dataset.id = cloud.user.id; $('v1Who').innerHTML = avatarInner(cloud.user);
      $('v1Who').setAttribute('aria-label', cloud.user.name + ' 님'); $('v1Who').title = cloud.user.name + ' 님';
    }
    $('v1Who').hidden = branch && !profile();
    $('v1More').hidden = !step || planned(step);  // ⋮ = 항목 화면의 PDF 만(지점·역할 변경은 왼쪽 메뉴)
    closeMenu();
    // 같은 화면을 다시 그릴 때(체크·저장 등)는 보던 위치·펼친 원본·포커스를 그대로 둔다. 다른 항목으로 갈 때만 맨 위로.
    const app = $('app'), same = view === shownView, y = window.scrollY;
    if (!same && shownView && !shownView.startsWith('step:') && view.startsWith('step:')) homeScroll = {view: shownView, stage: stageSel, target: cloud.target, y};  // 목록에서 항목으로 들어갈 때 보던 위치
    const opened = same ? [...app.querySelectorAll('details[open][id]')].map(d => d.id) : [];
    const f = same && app.contains(document.activeElement) ? document.activeElement : null;
    const focusSel = f && ['data-self', 'data-teacher', 'data-step'].map(a => f.hasAttribute(a) ? `[${a}="${CSS.escape(f.getAttribute(a))}"]` : '').find(Boolean);
    // 기준점: 방금 누른 체크박스. 그 위쪽 내용 높이가 바뀌어도(상태 문구 등) 화면에서 같은 자리에 머물게 한다.
    const anchorSel = same && (focusSel || keepFocus), anchor = anchorSel && app.querySelector(anchorSel);
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
    app.innerHTML = view === 'admin' ? adminView() : view === 'branch' ? branchView() : view === 'role' ? roleView() : step ? stepView(step) : view === 'stage' ? stageView() : view === 'all' ? stageView(true) : view === 'person' ? progressView() : homeView();
    bind(step);
    const lbar = app.querySelector('.v1-learner-bar');  // 고정 위치 = 상단바 바로 아래(항목 화면은 상단바가 두 줄이라 높이를 잰다)
    if (lbar) lbar.style.top = document.querySelector('.v1-top').offsetHeight + 'px';
    if (same) {
      opened.forEach(id => { const d = document.getElementById(id); if (d) d.open = true; });
      // 저장 중에는 체크박스가 잠깐 disabled 라 포커스를 못 받는다 → 기억해 두었다가 저장 후 다시 그릴 때 돌려준다
      keepFocus = focusSel || keepFocus;
      const nf = keepFocus && app.querySelector(keepFocus);
      if (nf && !nf.disabled) { nf.focus({preventScroll: true}); if (!busy) keepFocus = null; }
      // 브라우저 설정에 따라 scrollTo 가 애니메이션이 될 수 있다 → 'instant' 로 바로 제자리
      window.scrollTo({top: y, behavior: 'instant'});
      const after = anchorTop !== null && app.querySelector(anchorSel);
      if (after) window.scrollTo({top: window.scrollY + after.getBoundingClientRect().top - anchorTop, behavior: 'instant'});
    } else if (branch) {
      keepFocus = null; window.scrollTo({top: 0, behavior: 'instant'});
    } else if (step) {
      keepFocus = null; lastStep = step.id;
      window.scrollTo({top: 0, behavior: 'instant'});
    } else {
      keepFocus = null;
      if (homeScroll && homeScroll.view === view && (view !== 'stage' || homeScroll.stage === stageSel) && homeScroll.target === cloud.target) window.scrollTo({top: homeScroll.y, behavior: 'instant'});
      else {  // '다음 항목'으로 넘어가다 다른 단계까지 온 경우: 그 단계 목록에서 마지막으로 본 항목을 화면 가운데에
        const it = lastStep && app.querySelector(`[data-step="${CSS.escape(lastStep)}"]`);
        if (it) it.scrollIntoView({block: 'center', behavior: 'instant'}); else window.scrollTo({top: 0, behavior: 'instant'});
      }
    }
    shownView = view;
  }

  // 첫 화면: 교육을 진행할 지점 선택. 지금은 온천 본점만 교육과정이 있고, 나머지는 준비 중(선택 불가).
  const BRANCHES = [{id: 'oncheon', name: '온천 본점', ready: true}, {id: 'yeongdo', name: '영도점'}, {id: 'marine', name: '마린시티점'}, {id: 'domoheon', name: '도모헌점'}];
  const STORE_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 9.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9.5M3 9l1.6-4.3A1 1 0 0 1 5.5 4h13a1 1 0 0 1 .9.7L21 9a2.5 2.5 0 0 1-4.5 1.5A2.5 2.5 0 0 1 12 11a2.5 2.5 0 0 1-4.5-.5A2.5 2.5 0 0 1 3 9ZM10 20v-5h4v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';  // wds-allow: 상점 아이콘(mono/24 store 자산 반입 전 임시 인라인 SVG)
  function branchView() {
    const cur = profile() && profile().branch;
    return `<section class="v1-branch"><h2>교육을 진행할 지점을 선택해 주세요.</h2><p class="v1-muted">선택한 지점의 교육 과정으로 이동합니다.</p>` +
      `<div class="v1-branches">${BRANCHES.map(b => b.ready
        ? `<button type="button" class="v1-branch-card${b.id === cur ? ' on' : ''}" data-branch="${b.id}" aria-pressed="${b.id === cur}"><span class="v1-branch-icon">${STORE_ICON}</span><span class="v1-branch-name">${esc(b.name)}</span>${b.id === cur ? '<span class="v1-branch-soon">현재</span>' : ''}</button>`
        : `<button type="button" class="v1-branch-card" disabled aria-disabled="true" title="교육 과정 준비 중"><span class="v1-branch-icon">${STORE_ICON}</span><span class="v1-branch-name">${esc(b.name)}</span><span class="v1-branch-soon">준비 중</span></button>`).join('')}</div></section>`;
  }

  // 지점 다음: 교육생 / 관리자. 고른 값은 계정에 저장되어 다음 로그인에도 유지된다.
  const ROLES = [
    {id: 'learner', name: '교육생', desc: '내 교육을 진행하고 기록해요',
     icon: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'},  // wds-allow: 사람 아이콘(임시 인라인)
    {id: 'staff', name: '관리자', desc: '교육생의 수행을 확인하고 관리해요',
     icon: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 3.5 5 6.2v5.3c0 4.3 2.9 7.7 7 9 4.1-1.3 7-4.7 7-9V6.2L12 3.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m9 12 2.2 2.2L15.5 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'},  // wds-allow: 방패 체크 아이콘(임시 인라인)
  ];
  function roleView() {
    const b = BRANCHES.find(x => x.id === (pickBranch || (profile() && profile().branch))) || BRANCHES[0];
    const cur = profile() && profile().branch === b.id ? profile().role : null;
    return `<section class="v1-branch"><span class="v1-stage-tag">${esc(b.name)}</span><h2>어떤 역할로 들어가시나요?</h2><p class="v1-muted">선택한 역할은 다음 로그인에도 유지돼요. 바꾸려면 오른쪽 위 ⋮ 를 누르세요.</p>` +
      `<div class="v1-branches">${ROLES.map(r => `<button type="button" class="v1-branch-card${r.id === cur ? ' on' : ''}" data-role="${r.id}" aria-pressed="${r.id === cur}" ${busy ? 'disabled' : ''}><span class="v1-branch-icon">${r.icon}</span><span class="v1-branch-name">${esc(r.name)}</span><span class="v1-branch-desc">${esc(r.desc)}</span>${r.id === cur ? '<span class="v1-branch-soon">현재</span>' : ''}</button>`).join('')}</div></section>`;
  }

  // 역할 저장 → 교육생이면 (처음이면) 오늘부터 교육 시작, 관리자면 첫 교육생 기록을 연다 → 홈
  async function chooseRole(role) {
    const branch = pickBranch || (profile() && profile().branch) || BRANCHES[0].id;
    if (cloud.target !== cloud.user.id) cloud = await api('GET');
    if (!(await act('profile.set', {branch, role}))) return;
    pickBranch = null;
    if (role === 'learner' && !cloud.enrolled) await act('config.selfEnrol', {});
    if (cloud.target !== cloud.user.id) cloud = await api('GET');
    view = 'home'; stageSel = null; render();
    toast(`${BRANCHES.find(x => x.id === branch).name}(으)로 들어왔어요.`);
  }

  // WORKS 프로필 사진(/v1/avatar/<id>, 로그인할 때 받아 둔 것). 없으면 이름 첫 글자
  const avatarInner = u => `<span aria-hidden="true">${esc((u.name || '?').trim().slice(0, 1))}</span><img src="/v1/avatar/${encodeURIComponent(u.id)}" alt="" loading="lazy" onerror="this.remove()">`;
  const avatar = u => `<span class="v1-avatar">${avatarInner(u)}</span>`;

  // --- 진행 현황(홈). 교육생: 내 84개 교육 상태를 단계별 칸으로. 관리자: 교육생마다 한 줄(완료·진행 중·시작 전 비중) → 누르면 그 사람 칸.
  // 일정과 무관하게 각 교육의 상태만 본다(순서 없이 듣거나, 체크를 다 안 하고 나온 것도 그대로). 진행 중 칸은 체크한 만큼 아래에서 채운다.
  const liveSteps = () => steps().filter(s => !planned(s));
  const stateOf = st => st === 'done' ? 'done' : st === 'practice' || st === 'review' ? 'prog' : 'none';
  const LABEL = {none: '시작 전', prog: '진행 중', done: '완료'};
  function countsOf(get) { const c = {none: 0, prog: 0, done: 0}; liveSteps().forEach(s => c[stateOf(get(s))]++); return c; }
  const ratioBar = (c, cls = '') => { const n = c.none + c.prog + c.done || 1;
    return `<span class="v1-pbar ${cls}" aria-hidden="true"><i class="done" style="width:${c.done / n * 100}%"></i><i class="prog" style="width:${c.prog / n * 100}%"></i></span>`; };
  function progressView() {
    const mine = cloud.target === cloud.user.id, c = countsOf(s => record(s.id).status);
    const tiles = stages().map(g => {
      const xs = g.units.flatMap(u => u.steps).filter(s => !planned(s));
      if (!xs.length) return '';
      return `<section class="v1-pgroup"><h3>${g.order}. ${esc(g.title)}</h3><div class="v1-tiles">` + xs.map(s => {
        const r = record(s.id), k = stateOf(r.status), items = checkItems(s), n = stepIndex(s.id) + 1;
        const fill = k === 'prog' && items.length ? Math.round(items.filter((_, i) => r.teacher[i]).length / items.length * 100) : 0;
        return `<button type="button" class="v1-tile ${k}" style="--fill:${fill}%" data-step="${esc(s.id)}" aria-label="${n}번 ${esc(s.title)} · ${LABEL[k]}" title="${n}. ${esc(s.title)} · ${LABEL[k]}">${n}</button>`;
      }).join('') + '</div></section>';
    }).join('');
    return learnerBar() + enrolNotice() +
      `<div class="v1-counts"><div><b>${c.done}</b><span><i class="v1-dot done"></i>완료</span></div><div><b>${c.prog}</b><span><i class="v1-dot prog"></i>진행 중</span></div><div><b>${c.none}</b><span><i class="v1-dot none"></i>시작 전</span></div></div>` +
      ratioBar(c, 'lg') + tiles +
      `<p class="v1-muted v1-ptip">칸을 누르면 그 교육으로 이동해요. 진행 중인 칸은 체크한 만큼 채워져요.</p>`;
  }
  function staffHome() {
    const sums = cloud.educationSummary || [], me = cloud.user.id;
    const row = (x, label) => { const c = countsOf(s => (x.states || {})[s.id] || 'ready');
      return `<li><button type="button" class="v1-prow-btn" data-person="${esc(x.id)}" data-name="${esc(x.name)}">${avatar(x)}<span class="v1-pbody"><strong>${esc(label || x.name)}</strong>${ratioBar(c)}<small>완료 ${c.done} · 진행 중 ${c.prog} · 시작 전 ${c.none}</small></span><span class="v1-chev">›</span></button></li>`; };
    const self = sums.find(x => x.id === me);
    const others = sums.filter(x => x.id !== me), mineList = others.filter(x => x.trainedByMe), rest = others.filter(x => !x.trainedByMe);
    // 내 교육: 아직 시작 전이어도 같은 막대로 보여 주고, 누르면(처음이면 교육을 시작하고) 내 진행도로
    const meRow = self ? row(self, '내 교육') : row(Object.assign({}, cloud.user, {states: {}, trainedByMe: false}), '내 교육').replace('data-person=', 'data-enrol-self data-x=');
    return `<ul class="v1-plist">${meRow}</ul>` +
      `<h3 class="v1-pcat">나의 교육생 · ${mineList.length}명</h3>` + (mineList.length ? `<ul class="v1-plist">${mineList.map(x => row(x)).join('')}</ul>` : '<p class="v1-muted">아직 없어요. 전체 교육생에서 교육생을 골라 교육 내용을 체크하거나 완료하면 여기에 모여요.</p>') +
      `<h3 class="v1-pcat">전체 교육생 · ${rest.length}명</h3>` + (rest.length ? `<ul class="v1-plist">${rest.map(x => row(x)).join('')}</ul>` : '<p class="v1-muted">아직 교육을 시작한 교육생이 없어요.</p>');
  }

  function enrolNotice() {
    if (canWrite() || isStaff()) return '';
    return `<div class="v1-note warn">교육 기록을 아직 시작하지 못했어요. 새로고침해 보세요.</div>`;
  }

  function homeView() { return isStaff() ? staffHome() : progressView(); }

  // 관리자가 다른 사람의 기록을 볼 때: 누구를 교육하고 있는지 항상 보이게(화면 위에 고정)
  const learnerBar = () => cloud.target === cloud.user.id ? '' : `<div class="v1-learner-bar" role="status">${avatar({id: cloud.target, name: cloud.name})}<span>교육생 <strong>${esc(cloud.name)}</strong></span></div>`;

  // LMS관리자: 관리자 지정(서로 추가·삭제) · 보낸 의견 표
  function adminView() {
    const titleOf = id => { const st = steps().find(x => x.id === id); return st ? `${stepIndex(id) + 1}. ${st.title}` : ''; };
    const me = String(cloud.user.email || '').toLowerCase(), canEdit = cloud.lmsLevel === 'admin';
    const tag = l => `<span class="v1-tag${l === 'admin' ? ' v1-tag-admin' : ''}">${l}</span>`;
    const admins = (cloud.lmsAdmins || []).map(a => `<li><span class="v1-admin-mail">${esc(a.email)}${a.email === me ? ' <small class="v1-muted">(나)</small>' : ''}</span>` +
      (canEdit && !a.seed && a.email !== me
        ? `<span class="v1-admin-ctl"><select class="v1-admin-level" data-admin-level="${esc(a.email)}" aria-label="${esc(a.email)} 권한"><option value="admin"${a.level === 'admin' ? ' selected' : ''}>admin</option><option value="mentor"${a.level === 'mentor' ? ' selected' : ''}>mentor</option></select><button type="button" class="v1-tbtn v1-danger" data-admin-del="${esc(a.email)}">삭제</button></span>`
        : tag(a.level)) + '</li>').join('');
    const rows = (cloud.feedback || []).map(f => `<tr><td class="v1-nowrap">${esc(f.name)}</td><td class="v1-nowrap">${esc(String(f.at || '').slice(0, 16).replace('T', ' ').replace(/-/g, '.'))}</td><td>${esc(f.text).replace(/\n/g, '<br>')}${titleOf(f.step) ? `<small class="v1-fb-step">${esc(titleOf(f.step))}</small>` : ''}</td></tr>`).join('');
    return `<section class="v1-card"><h2>LMS관리자</h2><p class="v1-muted">admin·mentor 모두 교육생의 교육을 체크·완료할 수 있어요. 권한을 주고 빼는 것은 admin 만 할 수 있어요.</p><ul class="v1-admins">${admins}</ul>` +
      (canEdit ? `<div class="v1-admin-add"><input type="search" class="v1-pop-input" data-admin-email placeholder="이름·이메일 검색" autocomplete="off" enterkeyhint="search" aria-label="추가할 구성원 검색(NAVER WORKS 주소록)" aria-controls="v1AdminResults"><select class="v1-admin-level" data-admin-new-level aria-label="권한"><option value="mentor">mentor</option><option value="admin">admin</option></select><button type="button" class="v1-btn" data-admin-add>추가</button></div><div id="v1AdminResults" class="v1-pop-list v1-admin-results" role="list"></div>` : '') + '</section>' +
      `<section class="v1-card"><h2>보낸 의견</h2>` + (rows ? `<div class="v1-table"><table><thead><tr><th>보낸사람</th><th>시간</th><th>의견</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="v1-muted">아직 보낸 의견이 없어요.</p>') + '</section>';
  }

  const listItem = s => {
    const r = record(s.id), st = statusOf(s), n = stepIndex(s.id) + 1;
    const sub = st === 'done' ? ' · ' + dateLabel(r.done) + ((r.completedByName || (r.trainedBy && r.trainedBy.name)) ? ' · ' + (r.completedByName || r.trainedBy.name) : '') : '';
    return `<li><button class="v1-item ${st}" data-step="${esc(s.id)}"><span class="v1-num">${n}</span><span class="v1-body"><strong>${esc(s.title)}</strong><small>${st === 'planned' ? '교육안 준비 중' : esc(STATUS[st] + sub)}</small></span><span class="v1-chev">›</span></button></li>`;
  };
  const unitBlock = u => {
    const us = u.steps.filter(s => !planned(s));
    const meta = [us.length ? '' : '준비 중', u.plan ? `교육 시작 후 ${u.plan[0]}~${u.plan[1]}일차` : ''].filter(Boolean).join(' · ');
    return `<h3 class="v1-unit"><span class="v1-uno">${esc(u.no || '')}</span>${esc(u.title)}<small>${meta}</small></h3>` +
      (u.summary ? `<p class="v1-unote">${esc(u.summary)}</p>` : '') + '<ul class="v1-list">' + u.steps.map(listItem).join('') + '</ul>';
  };
  const whoLine = () => learnerBar();
  const srcLine = () => `<p class="v1-src">교육과정 ${esc(content.curriculumVersion || content.courseVersion)} · 원본 색인 ${esc((content.sourceIndexedAt || '').slice(0, 10))} · 기록은 서버에 저장됩니다 · <a class="v1-link" href="/v1/graph">교육항목·원본 문서 연결도</a></p>`;
  function wholeView() {
    const all = stages().map(g => Object.assign({}, g, {units: g.units.map(u => Object.assign({}, u, {steps: u.steps.filter(s => matches(s))})).filter(u => u.steps.length)})).filter(g => g.units.length);
    const count = all.reduce((n, g) => n + g.units.reduce((m, u) => m + u.steps.length, 0), 0);
    const extra = (content.extra || []).map(e => `<section class="v1-card v1-extra"><h2>${esc(e.title)}</h2><div class="v1-muted">${e.sessions.map(x => esc(x.title)).join(' · ')}${e.note ? ' — ' + esc(e.note) : ''}</div></section>`).join('');
    return whoLine() + `<div class="v1-prow v1-lhead v1-lhead-top"><h2>전체 교육${filt ? `<small> · ${esc(FKIND[filt.k])} ${esc(filt.v)} ${count}개</small>` : `<small> · ${count}개</small>`}</h2>` +
      (filt ? `<span class="v1-fgroup"><button type="button" class="v1-fchip on" data-filter-open aria-haspopup="dialog" aria-label="보기 필터: ${esc(filt.v)}">${esc(filt.v)} ▾</button><button type="button" class="v1-fchip on" data-filter-clear aria-label="필터 해제">✕</button></span>`
        : (content.filters && content.filters.position ? '<button type="button" class="v1-fchip" data-filter-open aria-haspopup="dialog">필터 ▾</button>' : '')) + '</div>' +
      all.map(g => `<h2 class="v1-stage">${g.order}. ${esc(g.title)}</h2>` + g.units.map(unitBlock).join('')).join('') +
      (!filt ? extra : '') + srcLine();
  }

  // 교육 단계 화면(메뉴 › 교육 단계 › 1~6): 그 단계의 교육 목록(필터는 '전체 교육'에서만)
  function stageView(whole) {
    // whole: 메뉴 › 교육 단계 › 전체 교육 — 84개를 단계별로 한 화면에, 필터(근무조·포지션)는 여기에서만
    filt = validFilter(filt);
    if (whole) return wholeView();
    const all = stages();
    if (!all.some(g => g.order === stageSel)) stageSel = (all.find(g => g.units.some(u => u.steps.some(s => !planned(s) && record(s.id).status !== 'done'))) || all[0]).order;
    const g = all.find(x => x.order === stageSel);
    const extra = (content.extra || []).map(e => `<section class="v1-card v1-extra"><h2>${esc(e.title)}</h2><div class="v1-muted">${e.sessions.map(x => esc(x.title)).join(' · ')}${e.note ? ' — ' + esc(e.note) : ''}</div></section>`).join('');
    return whoLine() + `<h2 class="v1-stage v1-stage-top">${g.order}. ${esc(g.title)}</h2>${g.summary ? `<p class="v1-unote">${esc(g.summary)}</p>` : ''}` +
      g.units.map(unitBlock).join('') +
      (g.note ? `<div class="v1-note">${esc(g.note)}</div>` : '') + (g.order === all[all.length - 1].order ? extra : '') + srcLine();
  }

  // --- 왼쪽 메뉴(LNB, 최대 2단계): 진행 현황 · 교육 단계(펼치기/접기) › 1~6 · 아래쪽 지점·역할 변경
  let navStagesOpen = false;
  function drawNav() {
    const homeLabel = '교육 진행 현황', inStage = view === 'stage';
    const item = (attrs, label, on, depth2) => `<button type="button" class="v1-nav-item${on ? ' on' : ''}${depth2 ? ' d2' : ''}" ${attrs} ${on ? 'aria-current="page"' : ''}>${label}</button>`;
    const b = BRANCHES.find(x => x.id === (profile() && profile().branch)), r = ROLES.find(x => x.id === (profile() && profile().role));
    $('v1Nav').querySelector('.v1-nav-panel').innerHTML =
      `<div class="v1-nav-head">${avatar(cloud.user)}<span><strong>${esc(cloud.user.name)}</strong><small>${esc([b && b.name, r && r.name].filter(Boolean).join(' · '))}</small></span></div>` +
      `<div class="v1-nav-body">${item('data-nav="home"', esc(homeLabel), view === 'home' || view === 'person')}` +
      `<button type="button" class="v1-nav-cat" data-nav-toggle aria-expanded="${navStagesOpen}" aria-controls="v1NavStages"><span>교육 단계</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
      `<div id="v1NavStages" ${navStagesOpen ? '' : 'hidden'}>${item('data-nav="all"', '전체 교육', view === 'all', true)}${stages().map(g => item(`data-nav="stage" data-nav-stage="${g.order}"`, `<span class="v1-nav-no">${g.order}</span>${esc(g.title)}`, inStage && stageSel === g.order, true)).join('')}</div></div>` +
      `<div class="v1-nav-foot">${isStaff() ? item('data-nav="admin"', 'LMS관리자', view === 'admin').replace('class="v1-nav-item', 'class="v1-nav-item v1-nav-danger') : ''}${item('data-nav="branch"', '지점 변경')}</div>`;
  }
  function openNav() { if (view === 'stage' || view === 'all') navStagesOpen = true; drawNav(); $('v1Nav').hidden = false; document.body.style.overflow = 'hidden'; $('v1Nav').querySelector('.v1-nav-item').focus(); }
  function closeNav() { $('v1Nav').hidden = true; document.body.style.overflow = ''; }
  $('v1Nav').addEventListener('click', async e => {
    const t = e.target.closest('[data-nav],[data-nav-toggle],[data-nav-close]');
    if (!t) return;
    if (t.hasAttribute('data-nav-close')) return closeNav();
    if (t.hasAttribute('data-nav-toggle')) { navStagesOpen = !navStagesOpen; return drawNav(); }
    const to = t.dataset.nav; closeNav();
    if (cloud.target !== cloud.user.id && to !== 'branch') { try { cloud = await api('GET'); } catch {} }  // 메뉴는 항상 '나' 기준
    if (isStaff() && !cloud.enrolled && (to === 'all' || to === 'stage')) await act('config.selfEnrol', {});  // 관리자가 처음 교육 목록을 열면 내 교육을 시작
    if (to === 'all') { homeScroll = null; view = 'all'; render(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
    if (to === 'stage') { stageSel = Number(t.dataset.navStage); homeScroll = null; view = 'stage'; render(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
    if (to === 'home') { view = 'home'; render(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
    if (to === 'admin') { view = 'admin'; render(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
    if (to === 'branch') { pickBranch = null; view = 'branch'; render(); return; }
    if (to === 'role') { pickBranch = profile() && profile().branch; view = 'role'; render(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('v1Nav').hidden) { closeNav(); $('v1Ham').focus(); } });

  function plannedView(s) {
    const i = stepIndex(s.id), next = nextOf(s), u = unitOf(s.id);
    return `<section class="v1-card"><span class="v1-pill planned">${STATUS.planned}</span> <span class="v1-muted">${esc(u.no || '')} ${esc(u.title)}</span>` +
      `<h2 style="margin-top:var(--spacing-12)">교육 목적</h2><p class="v1-muted">이 세션의 교육 목적·교육 내용·수행 확인은 원본 문서를 바탕으로 준비 중이에요.</p>` +
      (s.topics && s.topics.length ? `<h2 style="margin-top:var(--spacing-16)">다룰 내용</h2><ol class="v1-kp">${s.topics.map(t => `<li><div>${esc(t)}</div></li>`).join('')}</ol>` : '') +
      (s.plannedSources ? `<h2 style="margin-top:var(--spacing-16)">근거 문서</h2><p class="v1-muted">${esc(s.plannedSources)}</p>` : '') +
      (s.sessionNote ? `<div class="v1-note">${esc(s.sessionNote)}</div>` : '') + '</section>' +
      (next ? `<div class="v1-actions"><button class="v1-btn" data-step="${esc(next.id)}">다음 항목 ›</button></div>` : '');
  }

  function stepView(s) {
    if (planned(s)) return plannedView(s);
    const r = record(s.id), st = r.status, who = role(), own = who === 'learner', staff = who === 'staff';
    const i = stepIndex(s.id), next = nextOf(s);
    // 10/30: 체크·완료는 관리자만 — 교육생 기록에 들어가서 한다. 교육생은 관리자가 체크한 상태를 보고, 의견만 보낸다
    const editMark = staff && mayConfirm() && cloud.target !== cloud.user.id && (st === 'ready' || st === 'practice');
    const srcLabel = key => { const sec = content.sections[key], doc = sec && content.documents[sec.doc]; return sec ? `${doc ? doc.title : ''} ${sec.no} ${sec.title}${sec.partLabel ? ' · ' + sec.partLabel : ''}`.trim() : key; };
    const table = t => `<div class="table-wrap"><table><thead><tr>${t.header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map(r =>
      r.length === 1 && t.header.length > 1 ? `<tr><td class="v1-grp" colspan="${t.header.length}">${esc(r[0])}</td></tr>` : `<tr>${r.map(c => `<td>${esc(c).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    // 원본 절 하나의 본문(문서·판본·파일 + 단락·표). 예전 '원본 보기' 카드 대신 읽던 자리에서 펼친다.
    const inlineSource = key => {
      const sec = content.sections[key];
      if (!sec) return '<p class="v1-muted">연결된 본문을 찾지 못했어요. 교육 담당자에게 확인해 주세요.</p>';
      const doc = content.documents[sec.doc] || {};
      return `<section class="v1-inline">` +
        `<h3>${esc(sec.no)} ${esc(sec.title)}${sec.partLabel ? ` <span class="v1-part">· ${esc(sec.partLabel)}</span>` : ''}</h3>${sec.paragraphs.map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}${sec.tables.map(table).join('')}` +
        `<p class="v1-inline-file">원본 파일: ${esc(doc.folder ? doc.folder + ' / ' : '')}${esc(doc.file || '')}</p></section>`;
    };
    const hint = '<span class="v1-toggle"><span class="when-closed">본문 펼치기</span><span class="when-open">본문 접기</span><svg class="v1-chev" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
    const body = keys => `<div class="v1-src-body" role="region">${keys.map(inlineSource).join('')}<div class="v1-src-end"><button type="button" class="v1-tbtn" data-close-src>본문 접기</button></div></div>`;
    // 10/29: '수행 확인' 카드를 없애고 교육 내용 항목마다 오른쪽에 체크한다(체크 i = 교육 내용 i번째).
    // 교육 내용이 없는 항목(첫날 OJT 17항목)은 그 체크 목록을 교육 내용으로 보여 준다.
    const items = checkItems(s);
    const shots = s.photos.map(p => content.photos[p]).filter(Boolean);
    const photos = (shots.length > 1 ? '<div class="v1-photos">' : '') + shots.map((p, n) =>
      // 사진도 원본 docx 의 절에서만 가져온다. 아래 토글 = 그 사진이 들어 있는 절(펼치면 사진 칸이 한 줄 전체로 넓어진다).
      `<figure class="v1-photo${p.wide ? ' v1-photo-wide' : ''}"><img src="${p.src}" alt="${esc(p.caption)}" loading="lazy">${p.hideCaption ? '' : `<figcaption>${esc(p.caption)}</figcaption>`}</figure>`).join('') + (shots.length > 1 ? '</div>' : '');
    // 교육 내용: 요약 카드 전체가 토글(근거 본문 펼치기). 체크 상자는 카드 오른쪽 위 — 상자만 눌러야 체크된다.
    const box = k => {
      const on = Boolean(r.teacher[k]), name = (r.teacherName || [])[k];
      const by = `<span class="v1-by" data-by="${k}">${on ? esc([name, dateLabel(r.teacherAt[k])].filter(Boolean).join(' · ')) : '미체크'}</span>`;
      return [`<label class="v1-kcheck" title="${on ? '체크 해제' : '교육했으면 체크'}"><input type="checkbox" data-mark="${k}" aria-label="${k + 1}번 교육 내용 체크" ${on ? 'checked' : ''} ${editMark ? '' : 'disabled'}><span class="v1-box"></span></label>`, by];
    };
    const keyPoints = items.length ? `<ol class="v1-kp">${items.map((k, n) => {
      const keys = [...new Set(k.cites || [])], [check, by] = box(n);
      return `<li class="v1-kc${r.teacher[n] ? ' on' : ''}">${keys.length ? `<details class="v1-topic${k.text.length <= 12 ? ' short' : ''}" id="kp-${n}"><summary><span class="v1-topic-text">${esc(k.text).replace(/\n/g, '<br>')}${by}</span><span class="v1-topic-foot">${hint}</span></summary>${body(keys)}</details>`
        : `<div class="v1-topic"><span class="v1-topic-text">${esc(k.text).replace(/\n/g, '<br>')}${by}</span></div>`}${check}</li>`;
    }).join('')}</ol>` : `<div class="v1-copy">${s.copy.map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
    const refDocs = (s.refDocs || []).map(d => `<p class="v1-inline-file">원고 문서: ${esc(d.title)} (${esc(d.ref)}) · ${esc(d.file)}</p>`).join('');
    let status = '';
    const doneBy = r.completedByName || (r.trainedBy && r.trainedBy.name);
    if (st === 'done') status = `<div class="v1-note ok">${dateLabel(r.done)} 완료${doneBy ? ' · ' + esc(doneBy) : ''}</div>`;
    let actions = '';
    const trainer = staff && mayConfirm() && cloud.target !== cloud.user.id;
    if (trainer && (st === 'ready' || st === 'practice')) {
      const ready = items.length && items.every((_, k) => r.teacher[k]);
      actions = `<button class="v1-btn primary" data-close ${ready && !busy ? '' : 'disabled'}>완료</button>`;
    } else if (trainer && st === 'done') actions = `<button class="v1-btn" data-reopen ${busy ? 'disabled' : ''}>완료 취소</button>`;
    if (next) actions += `<button class="v1-btn" data-step="${esc(next.id)}">다음 항목 ›</button>`;
    // 의견 보내기: 본인 교육 화면에서만. 보내면 LMS관리자 화면의 표로 모인다
    const memo = own ? `<section class="v1-card"><h2>의견 보내기</h2>` +
      `<textarea class="v1-memo" data-feedback maxlength="2000" placeholder="궁금하거나 이해가 어려운 점을 입력해주세요."></textarea>` +
      `<div class="v1-actions v1-actions-inline"><button type="button" class="v1-btn" data-feedback-send>보내기</button></div></section>` : '';
    const purpose = s.purpose ? `<p class="v1-purpose">${esc(s.purpose).replace(/\n/g, '<br>')}</p>` : `<div class="v1-copy">${s.copy.map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
    const u = unitOf(s.id);
    const rework = s.reworkPending ? `<div class="v1-note">보완 예정 세션 — 지금 내용은 이전 교육안이에요.${s.sessionNote ? ' ' + esc(s.sessionNote) : ''}</div>` : '';
    const guide = trainer ? (st === 'done' ? '완료한 교육이에요. 고칠 게 있으면 아래 「완료 취소」를 누르세요.' : '교육한 항목을 오른쪽 상자에 체크하세요. 모두 체크하면 「완료」를 누를 수 있어요. 글을 누르면 근거 본문이 펼쳐져요.')
      : '관리자가 교육하면서 체크해요. 글을 누르면 근거 본문이 펼쳐져요.';
    return learnerBar() + `<section class="v1-card"><span class="v1-pill ${st}">${esc(STATUS[st])}</span> <span class="v1-muted">${esc(u.no || '')} ${esc(u.title)}</span>${rework}` +
      `<h2 style="margin-top:var(--spacing-12)">교육 목적</h2>${purpose}${photos}` +
      (s.note ? `<div class="v1-note warn">${esc(s.note)}</div>` : '') + `${enrolNotice()}${status}</section>` +
      `<section class="v1-card"><h2>교육 내용</h2><p class="v1-muted">${guide}</p>${keyPoints}${refDocs}</section>` +
      memo +
      (actions ? `<div class="v1-actions">${actions}</div>` : '');
  }
  function bind(step) {
    const app = $('app');
    // 지점을 고르면 바로 홈(역할은 고르지 않는다: 관리자 = 지정된 LMS관리자)
    app.querySelectorAll('[data-branch]').forEach(b => b.onclick = () => { pickBranch = b.dataset.branch; chooseRole(isStaff() ? 'staff' : 'learner').catch(e => toast(e.message)); });
    app.querySelectorAll('[data-role]').forEach(b => b.onclick = () => chooseRole(b.dataset.role).catch(e => toast(e.message)));
    app.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { if (!view.startsWith('step:')) returnView = view; view = 'step:' + b.dataset.step; if (returnView !== 'stage') stageSel = unitOf(b.dataset.step).stage.order; render(); });
    const addBtn = app.querySelector('[data-admin-add]');
    // 구성원 검색(WORKS 주소록): 이름·이메일·조직으로 찾아 누르면 이메일 칸에 채운다. 이미 관리자인 사람은 뺀다
    const adminQ = app.querySelector('[data-admin-email]'), adminRes = app.querySelector('#v1AdminResults');
    let adminTimer = null, adminSeq = 0;
    if (adminQ) adminQ.oninput = () => {
      clearTimeout(adminTimer);
      const q = adminQ.value.trim();
      if (!q || /@/.test(q) && q === adminQ.dataset.picked) { adminRes.innerHTML = ''; return; }
      adminTimer = setTimeout(async () => {
        const seq = ++adminSeq; adminRes.innerHTML = '<p class="v1-muted">찾는 중…</p>';
        try {
          const res = await fetch('/api/works/members?q=' + encodeURIComponent(q), {credentials: 'same-origin', cache: 'no-store'});
          const data = await res.json().catch(() => ({}));
          if (seq !== adminSeq) return;
          if (!res.ok) throw new Error(data.error || '주소록을 불러오지 못했어요.');
          const taken = new Set((cloud.lmsAdmins || []).map(a => a.email));
          const list = (data.members || []).filter(m => !taken.has(m.email));
          adminRes.innerHTML = list.length ? list.map(m => `<button type="button" class="v1-person" data-admin-pick="${esc(m.email)}"><span class="v1-avatar"><span aria-hidden="true">${esc((m.name || '?').slice(0, 1))}</span></span><span class="v1-person-body"><strong>${esc(m.name)}</strong><small>${esc([m.org, m.email].filter(Boolean).join(' · '))}</small></span></button>`).join('')
            : '<p class="v1-muted">검색 결과가 없어요. 이름이나 이메일을 다시 확인해 주세요.</p>';
        } catch (e) { if (seq === adminSeq) adminRes.innerHTML = `<div class="v1-note warn">${esc(e.message)}</div>`; }
      }, 250);
    };
    if (adminRes) adminRes.onclick = e => { const b = e.target.closest('[data-admin-pick]'); if (!b) return; adminQ.value = adminQ.dataset.picked = b.dataset.adminPick; adminRes.innerHTML = ''; app.querySelector('[data-admin-new-level]').focus(); };
    if (addBtn) addBtn.onclick = async () => { const email = app.querySelector('[data-admin-email]').value.trim(); if (!email) return; if (await act('lms.admin', {email, level: app.querySelector('[data-admin-new-level]').value})) toast('LMS관리자를 추가했습니다.'); };
    app.querySelectorAll('[data-admin-level]').forEach(x => x.onchange = async () => { if (await act('lms.admin', {email: x.dataset.adminLevel, level: x.value})) toast(`${x.value} 권한으로 바꿨습니다.`); });
    app.querySelectorAll('[data-admin-del]').forEach(b => b.onclick = async () => { if (await act('lms.admin', {email: b.dataset.adminDel, level: null})) toast('LMS관리자에서 삭제했습니다.'); });
    const enrolSelf = app.querySelector('[data-enrol-self]');
    if (enrolSelf) enrolSelf.onclick = async () => { if (await act('config.selfEnrol', {})) { cloud = await api('GET'); view = 'person'; render(); window.scrollTo({top: 0, behavior: 'instant'}); } };
    app.querySelectorAll('[data-stage]').forEach(b => b.onclick = () => { stageSel = Number(b.dataset.stage); render(); window.scrollTo(0, 0); });
    const fo = app.querySelector('[data-filter-open]'), fc = app.querySelector('[data-filter-clear]');
    if (fo) fo.onclick = openSheet;
    if (fc) fc.onclick = () => setFilter(null);
    app.querySelectorAll('[data-person]').forEach(b => b.onclick = async () => { try { cloud = await api('GET', null, b.dataset.person); view = 'person'; render(); window.scrollTo({top: 0, behavior: 'instant'}); } catch (e) { toast(e.message); } });
    // 본문 끝의 '본문 접기': 접은 뒤 요약 줄이 화면 밖이면 그 줄까지만(가장 가까운 위치로) 바로 이동
    app.querySelectorAll('[data-close-src]').forEach(b => b.onclick = () => {
      const d = b.closest('details'); d.open = false;
      const sum = d.querySelector('summary'); sum.focus({preventScroll: true});
      sum.scrollIntoView({block: 'nearest', behavior: 'instant'});
    });
    if (!step) return;
    app.querySelectorAll('[data-mark]').forEach(c => c.onchange = () => toggleMark(step, Number(c.dataset.mark), c.checked));
    const fb = app.querySelector('[data-feedback]'), fbSend = app.querySelector('[data-feedback-send]');
    if (fbSend) fbSend.onclick = async () => {
      const text = fb.value.trim();
      if (!text) { toast('보낼 의견을 입력해 주세요.'); fb.focus(); return; }
      if (await act('feedback.send', {step: step.id, text})) { const box = $('app').querySelector('[data-feedback]'); if (box) box.value = ''; toast('의견을 보냈습니다.'); }
    };
    const close = app.querySelector('[data-close]');
    if (close) close.onclick = async () => { await selfQueue; if (await act('step.close', {step: step.id})) toast('완료했습니다.'); };
    const reopen = app.querySelector('[data-reopen]');
    if (reopen) reopen.onclick = () => openReopen(step);
  }

  // --- 확인 팝업(완료 취소)
  let pop = null;  // {kind:'reopen', step}
  const popEl = () => $('v1Pop');
  function closePop() { pop = null; popEl().hidden = true; document.body.style.overflow = ''; }
  function drawPop() {
    if (!pop) return;
    popEl().querySelector('.v1-pop-panel').innerHTML = '<h2 id="v1PopTitle">완료를 취소할까요?</h2><p class="v1-muted">체크한 내용은 그대로 남아요. 고친 뒤 다시 「완료」를 누르면 됩니다.</p>' +
      `<div class="v1-actions"><button type="button" class="v1-btn" data-pop-close>닫기</button><button type="button" class="v1-btn primary" data-pop-reopen ${busy ? 'disabled' : ''}>완료 취소</button></div>`;
  }
  function openReopen(step) {
    pop = {kind: 'reopen', step}; drawPop(); popEl().hidden = false; document.body.style.overflow = 'hidden';
    popEl().querySelector('[data-pop-close]').focus();
  }
  popEl().addEventListener('click', async e => {
    const t = e.target.closest('[data-pop-reopen],[data-pop-close]');
    if (!t || !pop) return;
    if (t.hasAttribute('data-pop-close')) return closePop();
    const step = pop.step; closePop();
    if (await act('step.reopen', {step: step.id})) toast('완료를 취소했습니다.');
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pop) closePop(); });

  // --- 더보기 메뉴 · PDF 내보내기(항목 하나). 브라우저 인쇄 → 'PDF로 저장'.
  // 원문 본문·상태 안내·메모·버튼은 빼고, 수행 확인은 빈 체크박스로 찍는다.
  function closeMenu() { $('v1Menu').hidden = true; $('v1MoreBtn').setAttribute('aria-expanded', 'false'); }
  function printView(s) {
    const i = stepIndex(s.id), u = unitOf(s.id), stg = u.stage;
    const srcLabel = key => { const sec = content.sections[key], doc = sec && content.documents[sec.doc]; return sec ? `${doc ? doc.title : ''} ${sec.no} ${sec.title}${sec.partLabel ? ' · ' + sec.partLabel : ''}`.replace(/\s+/g, ' ').trim() : key; };
    const shots = s.photos.map(p => content.photos[p]).filter(Boolean);
    const today = new Date(), pad = n => String(n).padStart(2, '0');
    const printed = `${today.getFullYear()}.${pad(today.getMonth() + 1)}.${pad(today.getDate())}`;
    const purpose = s.purpose ? `<p>${esc(s.purpose).replace(/\n/g, '<br>')}</p>` : s.copy.map(p => `<p>${esc(p)}</p>`).join('');
    // 교육 내용 = 체크 목록(빈 상자). '수행 확인' 절은 없앴다(10/29)
    const kp = '<h2>교육 내용</h2>' + (checkItems(s).length
      ? `<ul class="p-checks">${checkItems(s).map(k => `<li><span class="p-box"></span><span>${esc(k.text).replace(/\n/g, '<br>')}${(k.cites || []).length ? `<span class="p-src">출처: ${[...new Set(k.cites)].map(c => esc(srcLabel(c))).join(' · ')}</span>` : ''}</span></li>`).join('')}</ul>`
      : s.copy.map(p => `<p>${esc(p)}</p>`).join('')) +
      (s.refDocs || []).map(d => `<p class="p-src">원고 문서: ${esc(d.title)} (${esc(d.ref)})</p>`).join('');
    return `<header class="p-head"><div class="p-brand">모모스 온보딩 · 온천 본점</div>` +
      `<div class="p-meta">${stg ? `<span class="p-tag">${stg.order}. ${esc(stg.title)}</span>` : ''}${esc(u.no || '')} ${esc(u.title)}</div>` +
      `<h1>${esc(s.title)}</h1></header>` +
      `<h2>교육 목적</h2>${purpose}` +
      (shots.length ? `<div class="p-photos">${shots.map(p => `<figure><img src="${p.src}" alt="${esc(p.caption)}">${p.hideCaption ? '' : `<figcaption>${esc(p.caption)}</figcaption>`}</figure>`).join('')}</div>` : '') +
      (s.note ? `<div class="p-note">${esc(s.note)}</div>` : '') + kp +
      `<div class="p-foot">콘텐츠 기준 ${esc(dateLabel(content.curriculumVersion))} · 출력 ${printed}</div>`;
  }

  // 모바일: 서버가 만든 PDF 를 쓴다. iOS(WORKS 포함)는 공유 시트로.
  // 안드로이드 WebView(WORKS)는 공유가 없고, 앱 다운로드는 미디어 권한을 모두 요구한다 → 폰의 기본 브라우저로 넘겨 거기서 받는다.
  // 넘기는 주소에 5분 토큰이 붙어 있어 브라우저에서 따로 로그인하지 않는다.
  // iOS 는 '누른 직후'에만 공유 시트를 허용하므로 ⋮ 를 여는 순간 PDF 를 미리 받아 둔다.
  const androidWebView = /Android/.test(navigator.userAgent) && /; wv\)/.test(navigator.userAgent);
  // PC 브라우저도 파일 공유를 지원하지만 PC 는 인쇄 창이 낫다 → 휴대폰·태블릿에서만 공유 시트
  const mobile = /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const canShareFiles = () => { if (!mobile) return false; try { return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({files: [new File([''], 'a.pdf', {type: 'application/pdf'})]}); } catch { return false; } };
  let pdfPrep = null;  // {id, link: Promise<url>, file: Promise<File>}
  function prepPdf(s) {
    if (pdfPrep && pdfPrep.id === s.id && Date.now() - pdfPrep.at < 4 * 60 * 1000) return pdfPrep;
    const link = fetch('/api/v1/pdf-link?step=' + encodeURIComponent(s.id), {credentials: 'same-origin', cache: 'no-store'})
      .then(r => r.ok ? r.json() : Promise.reject(new Error('PDF 주소를 받지 못했어요'))).then(j => j.url);
    const name = `${stepIndex(s.id) + 1}_${s.title}`.replace(/[\\/:*?"<>|]/g, '·') + '.pdf';
    const file = canShareFiles() ? link.then(u => fetch(u, {credentials: 'same-origin', cache: 'no-store'}))
      .then(r => r.ok ? r.blob() : Promise.reject(new Error('PDF를 만들지 못했어요'))).then(b => new File([b], name, {type: 'application/pdf'})) : null;
    if (file) file.catch(() => {});
    link.catch(() => {});
    pdfPrep = {id: s.id, at: Date.now(), link, file, done: null};
    if (file) file.then(f => { if (pdfPrep && pdfPrep.id === s.id) pdfPrep.done = f; }, () => {});
    return pdfPrep;
  }
  function onMenuOpen() {
    const s = view.startsWith('step:') && steps()[stepIndex(view.slice(5))];
    $('v1ExportPdf').hidden = !s || planned(s);
    if (!s || planned(s)) return;
    if (androidWebView || canShareFiles()) prepPdf(s);
  }
  function sharePdf(s) {
    const prep = prepPdf(s), title = s.title;
    const go = f => navigator.share({files: [f], title}).catch(e => { if (e.name !== 'AbortError') toast(e.name === 'NotAllowedError' ? 'PDF를 준비했어요. 한 번 더 눌러 주세요.' : 'PDF를 공유하지 못했어요.'); });
    if (prep.done) return go(prep.done);  // 미리 받아 둔 파일 — 같은 클릭 안에서 바로 공유 시트
    toast('PDF를 만드는 중이에요…');
    prep.file.then(go, e => toast(e.message));
  }

  // 패키지를 정하지 않은 VIEW intent → 기본 브라우저(Chrome·삼성 인터넷 등). 받을 앱이 없으면 fallback 주소로.
  const browserIntent = u => `intent://${location.host}${u}#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(location.origin + u)};end`;
  function openInBrowser(s) {
    toast('브라우저에서 PDF를 엽니다');
    prepPdf(s).link.then(u => { location.href = browserIntent(u); }, () => toast('PDF 주소를 받지 못했어요. 잠시 후 다시 시도해 주세요.'));
  }

  async function exportPdf() {
    closeMenu();
    const s = view.startsWith('step:') && steps()[stepIndex(view.slice(5))];
    if (!s) return;
    if (canShareFiles()) return sharePdf(s);  // iOS 등: 공유 시트
    if (androidWebView) return openInBrowser(s);  // 안드로이드 WORKS: 기본 브라우저. PC 는 아래 인쇄 창
    const box = $('v1Print');
    box.innerHTML = printView(s);
    // 사진을 다 받은 뒤에 인쇄 창을 연다(늦게 오면 빈 칸으로 찍힌다)
    await Promise.all([...box.querySelectorAll('img')].map(img => img.complete ? null : new Promise(ok => { img.onload = img.onerror = ok; })));
    const title = document.title;
    document.title = `${stepIndex(s.id) + 1}_${s.title}`.replace(/[\\/:*?"<>|]/g, '·');  // 'PDF로 저장' 기본 파일명
    document.body.classList.add('v1-printing');
    const done = () => { document.body.classList.remove('v1-printing'); document.title = title; box.innerHTML = ''; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  }

  $('v1Back').onclick = async () => { const to = $('v1Back').dataset.to; if (!to) return;
    if (to === 'home' && view === 'person' && cloud.target !== cloud.user.id) { try { cloud = await api('GET'); } catch {} }  // 교육생 목록으로: 내 기록으로 돌아온다
    view = to; render(); };
  $('v1Ham').onclick = openNav;
  $('v1MoreBtn').onclick = e => { e.stopPropagation(); const open = $('v1Menu').hidden; if (open) onMenuOpen(); $('v1Menu').hidden = !open; $('v1MoreBtn').setAttribute('aria-expanded', String(open)); };
  $('v1ExportPdf').onclick = exportPdf;
  document.addEventListener('click', e => { if (!$('v1More').contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('v1Menu').hidden) { closeMenu(); $('v1MoreBtn').focus(); } });

  // 로그인되어 있지 않으면: NAVER WORKS 로그인이 설정된 서버는 WORKS 로그인으로 보낸다(MOMOS uni 에서 열면 바로 이어짐).
  // 설정 전(체험)에는 첫 체험 교육생으로 자동 로그인 — /api/dev/accounts 는 로컬 실행이나 LMS_TRIAL=1 에서만 답한다.
  // 둘 다 아니면 기본 로그인 화면이 뜬다.
  async function devAutoLogin() {
    try {
      const status = await fetch('/api/auth/status', {credentials: 'same-origin', cache: 'no-store'}).then(r => r.json());
      if (status.works) {
        // LMS 로그인은 WORKS 와 따로 남아 있으므로, 새로 들어올 때(새 탭·MOMOS uni 를 다시 열 때)마다 WORKS 에 다시 확인한다.
        // WORKS 에 로그인돼 있으면 화면 전환 없이 곧바로 돌아오고, WORKS 에서 로그아웃했다면 WORKS 로그인 화면이 뜬다.
        // 같은 탭 안의 새로고침은 다시 묻지 않는다(sessionStorage).
        let checked = true; try { checked = sessionStorage.getItem('v1.worksVisit') === '1'; } catch {}  // 저장소를 못 쓰면 다시 묻지 않는다(무한 이동 방지)
        if (!status.user || !checked) {
          try { sessionStorage.setItem('v1.worksVisit', '1'); } catch {}
          location.replace('/auth/works/login');
          return new Promise(() => {});  // 이동하는 동안 화면을 그리지 않는다
        }
        return;
      }
      if (status.user) return;
      const response = await fetch('/api/dev/accounts', {credentials: 'same-origin', cache: 'no-store'});
      if (!response.ok) return;
      const {accounts} = await response.json();
      const pick = accounts.find(a => a.email === 'learner@local.test') || accounts[0];
      if (!pick) return;
      await fetch('/api/dev/accounts?id=' + encodeURIComponent(pick.id), {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: '{}'});
    } catch {}
  }

  // 같은 자리에서 함께 보는 현장: 5초마다 지금 보는 기록을 다시 불러와 상대방의 체크·승인을 보여준다.
  // 화면이 보일 때만, 저장 중이 아닐 때만, 글을 입력하는 중(메모·재교육 사유)이 아닐 때만.
  setInterval(async () => {
    if (!cloud || !content || busy || selfPending || document.visibilityState !== 'visible' || view === 'branch' || view === 'role') return;
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.tagName === 'INPUT' && ['text', 'search', 'email'].includes(a.type))) return;
    if (pop) return;  // 완료 팝업을 보는 중
    try {
      const fresh = await api('GET', null, cloud.target);
      if (busy || fresh.target !== cloud.target) return;
      if (fresh.learner.revision !== cloud.learner.revision || fresh.rootRevision !== cloud.rootRevision) { cloud = fresh; render(); }
    } catch {}
  }, 5000);

  // --- start: sign in (automatically on a local trial), load the slice and the record, pick a sensible first target
  devAutoLogin().then(() => ERPAuth.ensureSession()).then(async () => {
    const response = await fetch('/v1_content.json', {credentials: 'same-origin', cache: 'no-store'});
    if (!response.ok) throw new Error('교육 내용을 불러오지 못했습니다.');
    content = await response.json();
    cloud = await api('GET');
    // 지점·역할을 이미 골랐으면 바로 홈. 처음이면 지점 → 역할 화면(교육 시작·첫 교육생 열기는 역할을 고른 뒤)
    if (profile()) {
      view = 'home';
      if (!isStaff() && !cloud.enrolled) await act('config.selfEnrol', {});  // 처음 들어온 날이 교육 시작일
    }
    render();
  }).catch(e => { $('app').innerHTML = `<div class="v1-card"><h2>불러오지 못했어요</h2><p class="v1-muted">${esc(e.message)}</p><button class="v1-btn" onclick="location.reload()">다시 시도</button></div>`; });
})();
