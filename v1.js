// Momos onboarding · v1: 단계 → 단원 → 세션. read → check → trainer confirm. Phone first.
// Data: /v1_content.json (the course slice) and /api/onboarding (records). No local-only state.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const STATUS = {ready: '시작 전', practice: '진행 중', review: '담당자 확인 대기', done: '완료', planned: '준비 중'};
  const dateLabel = d => d ? d.replace(/-/g, '.') : '-';

  let shownView = null, keepFocus = null, pickBranch = null;  // pickBranch: 지점을 고른 뒤 역할을 고르기 전
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

  async function act(action, data) {
    if (busy) return false;
    busy = true; render();
    try {
      cloud = await api('POST', {action, target: cloud.target, revision: cloud.learner.revision, rootRevision: cloud.rootRevision,
        requestId: crypto.randomUUID(), data});
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
  const planned = s => s.lessonStatus === 'planned';  // 교육안 준비 중(추가·교체 세션): 수행 확인 없음
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
  const isStaff = () => profile() ? profile().role === 'staff' : Boolean(cloud.workspaceRoles.admin || cloud.workspaceRoles.trainer || cloud.workspaceRoles.assessor);
  const role = () => cloud.permissions.own ? 'learner' : isStaff() ? 'staff' : 'viewer';
  const mayConfirm = () => Boolean(cloud.permissions.trainer);
  const others = () => cloud.roster.filter(r => r.id !== cloud.user.id && r.join);

  // --- rendering
  function render() {
    if (!cloud || !content) return;
    const step = view.startsWith('step:') ? steps()[stepIndex(view.slice(5))] : null;
    const branch = view === 'branch' || view === 'role';
    // 처음: 지점 선택 → 역할 선택 → 홈. 저장된 뒤에는 홈이 첫 화면이고, 지점·역할은 우상단 ⋮ 에서 바꾼다.
    // 꺽쇠: 항목 → 홈, 역할 → 지점, (바꾸는 중인) 지점 → 홈. 처음 지점 화면에서는 숨긴다.
    const backTo = step ? 'home' : view === 'role' ? 'branch' : view === 'branch' && profile() ? 'home' : null;
    $('v1Back').hidden = !backTo;
    $('v1Back').dataset.to = backTo || '';
    $('v1Back').setAttribute('aria-label', backTo === 'branch' ? '지점 선택으로' : '교육 목록으로');
    $('v1Title').textContent = step ? step.title : '모모스 온보딩';
    const stg = step && unitOf(step.id).stage;  // 항목 화면: 제목 위에 '1. 입사·현장 적응'
    $('v1Stage').hidden = !stg;
    $('v1Stage').textContent = stg ? `${stg.order}. ${stg.title}` : '';
    if ($('v1Who').dataset.id !== cloud.user.id) {  // 사람이 바뀔 때만 다시 그린다(사진을 매번 다시 받지 않게)
      $('v1Who').dataset.id = cloud.user.id; $('v1Who').innerHTML = avatarInner(cloud.user);
      $('v1Who').setAttribute('aria-label', cloud.user.name + ' 님'); $('v1Who').title = cloud.user.name + ' 님';
    }
    $('v1Who').hidden = branch && !profile();
    $('v1More').hidden = !profile();  // 지점·역할을 정한 뒤부터: 지점·역할 변경, (항목 화면) PDF
    closeMenu();
    // 같은 화면을 다시 그릴 때(체크·저장 등)는 보던 위치·펼친 원본·포커스를 그대로 둔다. 다른 항목으로 갈 때만 맨 위로.
    const app = $('app'), same = view === shownView, y = window.scrollY;
    if (!same && shownView === 'home') homeScroll = {stage: stageSel, y};  // 항목을 누른 직후라 stageSel 은 보던 탭(= 그 항목의 단계)
    const opened = same ? [...app.querySelectorAll('details[open][id]')].map(d => d.id) : [];
    const f = same && app.contains(document.activeElement) ? document.activeElement : null;
    const focusSel = f && ['data-self', 'data-teacher', 'data-step'].map(a => f.hasAttribute(a) ? `[${a}="${CSS.escape(f.getAttribute(a))}"]` : '').find(Boolean);
    // 기준점: 방금 누른 체크박스. 그 위쪽 내용 높이가 바뀌어도(상태 문구 등) 화면에서 같은 자리에 머물게 한다.
    const anchorSel = same && (focusSel || keepFocus), anchor = anchorSel && app.querySelector(anchorSel);
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
    app.innerHTML = view === 'branch' ? branchView() : view === 'role' ? roleView() : step ? stepView(step) : homeView();
    bind(step);
    if (same) {
      opened.forEach(id => { const d = document.getElementById(id); if (d) d.open = true; });
      // 저장 중에는 체크박스가 잠깐 disabled 라 포커스를 못 받는다 → 기억해 두었다가 저장 후 다시 그릴 때 돌려준다
      keepFocus = focusSel || keepFocus;
      const nf = keepFocus && app.querySelector(keepFocus);
      if (nf && !nf.disabled) { nf.focus({preventScroll: true}); if (!busy) keepFocus = null; }
      // styles.css 의 html{scroll-behavior:smooth} 때문에 그냥 scrollTo 는 애니메이션이 된다 → 'instant' 로 바로 제자리
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
      if (homeScroll && homeScroll.stage === stageSel) window.scrollTo({top: homeScroll.y, behavior: 'instant'});
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
    if (role === 'staff' && others().length) cloud = await api('GET', null, others()[0].id);
    if (role === 'learner' && cloud.target !== cloud.user.id) cloud = await api('GET');
    view = 'home'; stageSel = null; render();
    toast(`${BRANCHES.find(x => x.id === branch).name} · ${ROLES.find(x => x.id === role).name}(으)로 들어왔어요.`);
  }

  // WORKS 프로필 사진(/v1/avatar/<id>, 로그인할 때 받아 둔 것). 없으면 이름 첫 글자
  const avatarInner = u => `<span aria-hidden="true">${esc((u.name || '?').trim().slice(0, 1))}</span><img src="/v1/avatar/${encodeURIComponent(u.id)}" alt="" loading="lazy" onerror="this.remove()">`;
  const avatar = u => `<span class="v1-avatar">${avatarInner(u)}</span>`;

  function peopleBar() {
    if (!isStaff()) return '';
    const list = others();
    return '<section class="v1-card"><h2>교육생</h2>' +
      (list.length ? '<div class="v1-muted">이름을 누르면 그 교육생의 기록이 열려요.</div><div class="v1-people">' +
        list.map(r => `<button data-person="${esc(r.id)}" class="${r.id === cloud.target ? 'on' : ''}">${avatar(r)}${esc(r.name)}</button>`).join('') + '</div>'
        : '<div class="v1-muted">아직 교육을 시작한 교육생이 없어요. 교육생이 처음 접속하면 여기에 나타나요.</div>') +
      '</section>';
  }

  function enrolNotice() {
    if (canWrite() || isStaff()) return '';
    return `<div class="v1-note warn">교육 기록을 아직 시작하지 못했어요. 새로고침해 보세요.</div>`;
  }

  function homeView() {
    const list = steps(), live = list.filter(s => !planned(s));
    const isDone = s => !planned(s) && record(s.id).status === 'done';
    const done = live.filter(isDone).length;
    const mine = cloud.target === cloud.user.id;
    if (isStaff() && mine) return peopleBar();
    const who = mine ? '' : `<div class="v1-muted">${esc(cloud.name)}님의 교육 기록</div>`;
    const all = stages();
    // 처음 열면: 끝나지 않은 첫 세션이 있는 단계
    if (!all.some(g => g.order === stageSel)) stageSel = (all.find(g => g.units.some(u => u.steps.some(s => !planned(s) && !isDone(s)))) || all[0]).order;
    const g = all.find(x => x.order === stageSel);
    const item = s => {
      const r = record(s.id), st = statusOf(s), n = stepIndex(s.id) + 1;
      const sub = st === 'planned' ? '교육안 준비 중' : st === 'done' ? '확인 완료 · ' + dateLabel(r.done) : st === 'review' ? '확인 요청 ' + dateLabel(r.request) :
        `확인 ${r.self.filter(Boolean).length}/${s.checks.length}`;
      return `<li><button class="v1-item ${st}" data-step="${esc(s.id)}"><span class="v1-num">${n}</span><span class="v1-body"><strong>${esc(s.title)}</strong><small>${st === 'planned' ? '교육안 준비 중' : esc(STATUS[st]) + ' · ' + sub}</small></span><span class="v1-chev">›</span></button></li>`;
    };
    const tabs = '<nav class="v1-stages" aria-label="교육 단계">' + all.map(x => {
      const xs = x.units.flatMap(u => u.steps).filter(s => !planned(s));
      return `<button data-stage="${x.order}" class="${x.order === stageSel ? 'on' : ''}" aria-pressed="${x.order === stageSel}"><b>${x.order}</b><span>${esc(x.title)}</span><small>${xs.filter(isDone).length}/${xs.length}</small></button>`;
    }).join('') + '</nav>';
    const units = g.units.map(u => {
      const us = u.steps.filter(s => !planned(s));
      const meta = [us.length ? `${us.filter(isDone).length}/${us.length}` : '준비 중', u.plan ? `교육 시작 후 ${u.plan[0]}~${u.plan[1]}일차` : ''].filter(Boolean).join(' · ');
      return `<h3 class="v1-unit"><span class="v1-uno">${esc(u.no || '')}</span>${esc(u.title)}<small>${meta}</small></h3>` +
        (u.summary ? `<p class="v1-unote">${esc(u.summary)}</p>` : '') + '<ul class="v1-list">' + u.steps.map(item).join('') + '</ul>';
    }).join('');
    const extra = (content.extra || []).map(e => `<section class="v1-card v1-extra"><h2>${esc(e.title)}</h2><div class="v1-muted">${e.sessions.map(x => esc(x.title)).join(' · ')}${e.note ? ' — ' + esc(e.note) : ''}</div></section>`).join('');
    return peopleBar() +
      `<section class="v1-card">${who}` +
      `<div class="v1-progress"><i style="width:${live.length ? Math.round(done / live.length * 100) : 0}%"></i></div>` +
      `<div class="v1-muted">${done}/${live.length} 완료${list.length > live.length ? ` · 교육안 준비 중 ${list.length - live.length}개` : ''}</div>${enrolNotice()}</section>` +
      tabs + `<h2 class="v1-stage">${g.order}. ${esc(g.title)}</h2>${g.summary ? `<p class="v1-unote">${esc(g.summary)}</p>` : ''}` + units +
      (g.note ? `<div class="v1-note">${esc(g.note)}</div>` : '') + (g.order === all[all.length - 1].order ? extra : '') +
      `<p class="v1-src">교육과정 ${esc(content.curriculumVersion || content.courseVersion)} · 원본 색인 ${esc((content.sourceIndexedAt || '').slice(0, 10))} · 기록은 서버에 저장됩니다 · <a class="v1-link" href="/v1/graph">교육항목·원본 문서 연결도</a></p>`;
  }

  function plannedView(s) {
    const i = stepIndex(s.id), next = steps()[i + 1], u = unitOf(s.id);
    return `<section class="v1-card"><span class="v1-pill planned">${STATUS.planned}</span> <span class="v1-muted">${i + 1}/${steps().length} · ${esc(u.no || '')} ${esc(u.title)}</span>` +
      `<h2 style="margin-top:var(--spacing-12)">교육 목적</h2><p class="v1-muted">이 세션의 교육 목적·교육 내용·수행 확인은 원본 문서를 바탕으로 준비 중이에요.</p>` +
      (s.topics && s.topics.length ? `<h2 style="margin-top:var(--spacing-16)">다룰 내용</h2><ol class="v1-kp">${s.topics.map(t => `<li><div>${esc(t)}</div></li>`).join('')}</ol>` : '') +
      (s.plannedSources ? `<h2 style="margin-top:var(--spacing-16)">근거 문서</h2><p class="v1-muted">${esc(s.plannedSources)}</p>` : '') +
      (s.sessionNote ? `<div class="v1-note">${esc(s.sessionNote)}</div>` : '') + '</section>' +
      (next ? `<div class="v1-actions"><button class="v1-btn" data-step="${esc(next.id)}">다음 항목 ›</button></div>` : '');
  }

  function stepView(s) {
    if (planned(s)) return plannedView(s);
    const r = record(s.id), st = r.status, who = role(), own = who === 'learner', staff = who === 'staff';
    const i = stepIndex(s.id), next = steps()[i + 1];
    const editSelf = own && canWrite() && (st === 'ready' || st === 'practice');
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
    // 수행 확인에는 근거 본문을 달지 않는다(근거 문서는 교육 내용에서 본다). checkCites 데이터·매핑은 그대로 둔다.
    const checkCites = () => '';
    const checks = '<ul class="v1-checks">' + s.checks.map((c, k) => {
      if (staff) {  // 관리자: 교육생이 체크한 상태를 보기만 한다(항목별 체크 없음, 승인은 아래 버튼)
        return `<li><label><input type="checkbox" ${r.self[k] ? 'checked' : ''} disabled><span class="v1-box"></span><span>${esc(c)}` +
          `<span class="v1-by">교육생 ${r.self[k] ? '체크 ' + dateLabel(r.selfAt[k]) : '미체크'}${r.teacher[k] ? ' · 담당자 확인 ' + dateLabel(r.teacherAt[k]) : ''}</span></span></label>${checkCites(k)}</li>`;
      }
      return `<li><label><input type="checkbox" data-self="${k}" ${r.self[k] ? 'checked' : ''} ${editSelf && !busy ? '' : 'disabled'}><span class="v1-box"></span><span>${esc(c)}` +
        (r.teacher[k] ? `<span class="v1-by">담당자 확인 ${dateLabel(r.teacherAt[k])}</span>` : '') + '</span></label>' + checkCites(k) + '</li>';
    }).join('') + '</ul>';
    const shots = s.photos.map(p => content.photos[p]).filter(Boolean);
    const photos = (shots.length > 1 ? '<div class="v1-photos">' : '') + shots.map((p, n) =>
      // 사진도 원본 docx 의 절에서만 가져온다. 아래 토글 = 그 사진이 들어 있는 절(펼치면 사진 칸이 한 줄 전체로 넓어진다).
      `<figure class="v1-photo${p.wide ? ' v1-photo-wide' : ''}"><img src="${p.src}" alt="${esc(p.caption)}" loading="lazy">${p.hideCaption ? '' : `<figcaption>${esc(p.caption)}</figcaption>`}</figure>`).join('') + (shots.length > 1 ? '</div>' : '');
    // 교육 내용: 요약 카드 전체가 토글. 접힌 상태에서도 근거 절(문서·절)이 보이고, 펼치면 카드 안에 본문이 나온다.
    const keyPoints = s.keyPoints && s.keyPoints.length ? `<ol class="v1-kp">${s.keyPoints.map((k, n) => {
      const keys = [...new Set(k.cites || [])];
      return `<li>${keys.length ? `<details class="v1-topic${k.text.length <= 12 ? ' short' : ''}" id="kp-${n}"><summary><span class="v1-topic-text">${esc(k.text).replace(/\n/g, '<br>')}</span><span class="v1-topic-foot">${hint}</span></summary>${body(keys)}</details>`
        : `<div class="v1-topic"><span class="v1-topic-text">${esc(k.text).replace(/\n/g, '<br>')}</span></div>`}</li>`;
    }).join('')}</ol>` : `<div class="v1-copy">${s.copy.map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
    const refDocs = (s.refDocs || []).map(d => `<p class="v1-inline-file">원고 문서: ${esc(d.title)} (${esc(d.ref)}) · ${esc(d.file)}</p>`).join('');
    let status = '';
    if (st === 'review') status = `<div class="v1-note">${dateLabel(r.request)}에 담당자 확인을 요청했어요. 담당자가 확인하면 완료됩니다.</div>`;
    if (st === 'done') status = `<div class="v1-note ok">${dateLabel(r.done)} 담당자 확인 완료</div>`;
    if (r.feedback) status += `<div class="v1-note warn">재교육 사유: ${esc(r.feedback)}</div>`;
    let actions = '';
    if (own && (st === 'ready' || st === 'practice')) {
      const ready = r.self.every(Boolean);
      actions = `<button class="v1-btn primary" data-request ${ready && canWrite() && !busy ? '' : 'disabled'}>담당자 확인 요청</button>`;
    } else if (staff && (st === 'review' || st === 'done') && mayConfirm()) {
      // 관리자 승인: 확인 요청된 항목은 확인 완료 또는 재교육(사유), 완료된 항목은 재교육만
      if (st === 'review') actions = `<button class="v1-btn primary" data-complete ${busy ? 'disabled' : ''}>확인 완료</button>`;
      actions += `<button class="v1-btn" data-retry-open ${busy ? 'disabled' : ''}>재교육</button>`;
    }
    if (next) actions += `<button class="v1-btn" data-step="${esc(next.id)}">다음 항목 ›</button>`;
    const memo = own || r.memo ? `<section class="v1-card"><h2>메모</h2><div class="v1-muted">어려웠던 점, 담당자에게 확인할 내용</div>` +
      `<textarea class="v1-memo" data-memo ${editSelf && !busy ? '' : 'disabled'} placeholder="${own ? '적어 두면 담당자가 확인할 때 함께 봅니다' : ''}">${esc(r.memo)}</textarea></section>` : '';
    const purpose = s.purpose ? `<p class="v1-purpose">${esc(s.purpose).replace(/\n/g, '<br>')}</p>` : `<div class="v1-copy">${s.copy.map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
    const u = unitOf(s.id);
    const rework = s.reworkPending ? `<div class="v1-note">보완 예정 세션 — 지금 내용은 이전 교육안이에요.${s.sessionNote ? ' ' + esc(s.sessionNote) : ''}</div>` : '';
    return `<section class="v1-card"><span class="v1-pill ${st}">${esc(STATUS[st])}</span> <span class="v1-muted">${i + 1}/${steps().length} · ${esc(u.no || '')} ${esc(u.title)}</span>${rework}` +
      `<h2 style="margin-top:var(--spacing-12)">교육 목적</h2>${purpose}${photos}` +
      (s.note ? `<div class="v1-note warn">${esc(s.note)}</div>` : '') + `${enrolNotice()}${status}</section>` +
      (s.contentOmitted ? '' : `<section class="v1-card"><h2>교육 내용</h2><p class="v1-muted">항목을 누르면 근거가 된 원본 본문이 그 자리에서 펼쳐져요.</p>${keyPoints}${refDocs}</section>`) +
      `<section class="v1-card"><h2>수행 확인</h2><div class="v1-muted">${own ? '직접 해 보고 하나씩 체크하세요. 다 체크하면 담당자에게 확인을 요청할 수 있어요.' : staff ? (mayConfirm() ? '교육생이 체크한 내용이에요. 확인 요청이 오면 현장에서 보고 확인 완료 또는 재교육을 눌러 주세요.' : '이 교육생의 확인 담당자는 ' + esc(cloud.roster.find(x => x.id === cloud.target)?.trainer || '미배정') + '님이에요.') : '교육생 본인과 담당자만 체크할 수 있어요.'}</div>${checks}</section>` +
      memo +
      (actions ? `<div class="v1-actions">${actions}</div>` : '') +
      (staff && mayConfirm() && (st === 'review' || st === 'done') ? `<section class="v1-card v1-retry" id="v1Retry" hidden><h2>재교육 사유</h2><div class="v1-muted">교육생에게 보여요. 이 항목은 다시 실습할 수 있는 상태로 돌아가요.</div>` +
        `<textarea class="v1-memo" data-retry-reason maxlength="2000" placeholder="예: 소서 매칭을 다시 연습해 주세요"></textarea><div class="v1-actions"><button class="v1-btn primary" data-retry-send>재교육 요청</button><button class="v1-btn" data-retry-cancel>취소</button></div></section>` : '');
  }

  function bind(step) {
    const app = $('app');
    app.querySelectorAll('[data-branch]').forEach(b => b.onclick = () => { pickBranch = b.dataset.branch; view = 'role'; render(); });
    app.querySelectorAll('[data-role]').forEach(b => b.onclick = () => chooseRole(b.dataset.role).catch(e => toast(e.message)));
    app.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { view = 'step:' + b.dataset.step; stageSel = unitOf(b.dataset.step).stage.order; render(); });
    app.querySelectorAll('[data-stage]').forEach(b => b.onclick = () => { stageSel = Number(b.dataset.stage); render(); window.scrollTo(0, 0); });
    app.querySelectorAll('[data-person]').forEach(b => b.onclick = () => load(b.dataset.person).catch(e => toast(e.message)));
    // 본문 끝의 '본문 접기': 접은 뒤 요약 줄이 화면 밖이면 그 줄까지만(가장 가까운 위치로) 바로 이동
    app.querySelectorAll('[data-close-src]').forEach(b => b.onclick = () => {
      const d = b.closest('details'); d.open = false;
      const sum = d.querySelector('summary'); sum.focus({preventScroll: true});
      sum.scrollIntoView({block: 'nearest', behavior: 'instant'});
    });
    if (!step) return;
    app.querySelectorAll('[data-self]').forEach(c => c.onchange = () => (keepFocus = `[data-self="${c.dataset.self}"]`, act('step.self', {step: step.id, index: Number(c.dataset.self), on: c.checked})));
    const memo = app.querySelector('[data-memo]');
    if (memo) memo.onchange = () => { if (memo.value !== record(step.id).memo) act('step.memo', {step: step.id, memo: memo.value}).then(ok => ok && toast('메모를 저장했어요.')); };
    const request = app.querySelector('[data-request]');
    if (request) request.onclick = () => act('step.request', {step: step.id}).then(ok => ok && toast('담당자에게 확인을 요청했어요.'));
    const complete = app.querySelector('[data-complete]');
    if (complete) complete.onclick = () => act('step.complete', {step: step.id}).then(ok => ok && toast('확인 완료로 기록했어요.'));
    const retryBox = app.querySelector('#v1Retry'), open = app.querySelector('[data-retry-open]');
    if (open && retryBox) open.onclick = () => { retryBox.hidden = false; retryBox.querySelector('textarea').focus(); retryBox.scrollIntoView({block: 'nearest', behavior: 'instant'}); };
    const cancel = app.querySelector('[data-retry-cancel]');
    if (cancel) cancel.onclick = () => { retryBox.hidden = true; };
    const send = app.querySelector('[data-retry-send]');
    if (send) send.onclick = () => {
      const reason = retryBox.querySelector('textarea').value.trim();
      if (!reason) { toast('재교육 사유를 적어 주세요.'); return; }
      act('step.retry', {step: step.id, reason}).then(ok => ok && toast('재교육으로 돌렸어요. 교육생 화면에 사유가 보여요.'));
    };
  }

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
    const kp = s.contentOmitted ? '' : '<h2>교육 내용</h2>' + (s.keyPoints && s.keyPoints.length
      ? `<ol>${s.keyPoints.map(k => `<li>${esc(k.text).replace(/\n/g, '<br>')}${(k.cites || []).length ? `<span class="p-src">출처: ${[...new Set(k.cites)].map(c => esc(srcLabel(c))).join(' · ')}</span>` : ''}</li>`).join('')}</ol>`
      : s.copy.map(p => `<p>${esc(p)}</p>`).join('')) +
      (s.refDocs || []).map(d => `<p class="p-src">원고 문서: ${esc(d.title)} (${esc(d.ref)})</p>`).join('');
    return `<header class="p-head"><div class="p-brand">모모스 온보딩 · 온천 본점</div>` +
      `<div class="p-meta">${stg ? `<span class="p-tag">${stg.order}. ${esc(stg.title)}</span>` : ''}${esc(u.no || '')} ${esc(u.title)} · ${i + 1}/${steps().length}</div>` +
      `<h1>${esc(s.title)}</h1></header>` +
      `<h2>교육 목적</h2>${purpose}` +
      (shots.length ? `<div class="p-photos">${shots.map(p => `<figure><img src="${p.src}" alt="${esc(p.caption)}">${p.hideCaption ? '' : `<figcaption>${esc(p.caption)}</figcaption>`}</figure>`).join('')}</div>` : '') +
      (s.note ? `<div class="p-note">${esc(s.note)}</div>` : '') + kp +
      `<h2>수행 확인</h2><ul class="p-checks">${s.checks.map(c => `<li><span class="p-box"></span><span>${esc(c)}</span></li>`).join('')}</ul>` +
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
    const p = profile(), b = p && BRANCHES.find(x => x.id === p.branch), r = p && ROLES.find(x => x.id === p.role);
    $('v1MenuBranch').innerHTML = `지점 변경<small>${esc(b ? b.name : '')}</small>`;
    $('v1MenuRole').innerHTML = `역할 변경<small>${esc(r ? r.name : '')}</small>`;
    $('v1ExportPdf').hidden = !s || planned(s);
    $('v1MenuSep').hidden = $('v1ExportPdf').hidden;
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

  $('v1Back').onclick = () => { const to = $('v1Back').dataset.to; if (to) { view = to; render(); } };
  $('v1MoreBtn').onclick = e => { e.stopPropagation(); const open = $('v1Menu').hidden; if (open) onMenuOpen(); $('v1Menu').hidden = !open; $('v1MoreBtn').setAttribute('aria-expanded', String(open)); };
  $('v1ExportPdf').onclick = exportPdf;
  $('v1MenuBranch').onclick = () => { closeMenu(); pickBranch = null; view = 'branch'; render(); };
  $('v1MenuRole').onclick = () => { closeMenu(); pickBranch = profile() && profile().branch; view = 'role'; render(); };
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
    if (!cloud || !content || busy || document.visibilityState !== 'visible' || view === 'branch' || view === 'role') return;
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' && a.type === 'text')) return;
    if ($('v1Retry') && !$('v1Retry').hidden) return;
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
      if (isStaff() && others().length) cloud = await api('GET', null, others()[0].id);
    }
    render();
  }).catch(e => { $('app').innerHTML = `<div class="v1-card"><h2>불러오지 못했어요</h2><p class="v1-muted">${esc(e.message)}</p><button class="v1-btn" onclick="location.reload()">다시 시도</button></div>`; });
})();
