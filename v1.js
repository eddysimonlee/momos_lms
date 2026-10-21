// Momos onboarding · v1: one unit, read → check → trainer confirm. Phone first.
// Data: /v1_content.json (the course slice) and /api/onboarding (records). No local-only state.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const STATUS = {ready: '시작 전', practice: '진행 중', review: '담당자 확인 대기', done: '완료'};
  const dateLabel = d => d ? d.replace(/-/g, '.') : '-';

  let content = null, cloud = null, view = 'home', busy = false, toastTimer = null;

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
  // 1차: 교육과정 1~2단계(12개 단원, 55개 항목)를 한 목록으로 이어서 보여 준다.
  const steps = () => content.units.flatMap(u => u.steps);
  const record = id => cloud.learner.records[id];
  const stepIndex = id => steps().findIndex(s => s.id === id);
  const canWrite = () => cloud.enrolled && cloud.scheduled;
  // Two roles on screen: 교육생 (own record) and 담당자 (store staff: any admin confirms; no assignment in 1차).
  // The record still stores who confirmed each check, so trainers can be split out later.
  const isStaff = () => Boolean(cloud.workspaceRoles.admin || cloud.workspaceRoles.trainer || cloud.workspaceRoles.assessor);
  const role = () => cloud.permissions.own ? 'learner' : isStaff() ? 'staff' : 'viewer';
  const mayConfirm = () => Boolean(cloud.permissions.trainer);
  const others = () => cloud.roster.filter(r => r.id !== cloud.user.id && r.join);

  // --- rendering
  function render() {
    if (!cloud || !content) return;
    const step = view.startsWith('step:') ? steps()[stepIndex(view.slice(5))] : null;
    $('v1Back').hidden = !step;
    $('v1Title').textContent = step ? step.title : '모모스 온보딩';
    $('v1Who').textContent = cloud.user.name;
    $('app').innerHTML = step ? stepView(step) : homeView();
    bind(step);
    if (step) window.scrollTo(0, 0);
  }

  function peopleBar() {
    if (!isStaff()) return '';
    const list = others();
    return '<section class="v1-card"><h2>교육생</h2>' +
      (list.length ? '<div class="v1-muted">이름을 누르면 그 교육생의 기록이 열려요.</div><div class="v1-people">' +
        list.map(r => `<button data-person="${esc(r.id)}" class="${r.id === cloud.target ? 'on' : ''}">${esc(r.name)}</button>`).join('') + '</div>'
        : '<div class="v1-muted">아직 교육을 시작한 교육생이 없어요. 교육생이 처음 접속하면 여기에 나타나요.</div>') +
      '</section>';
  }

  function enrolNotice() {
    if (canWrite() || isStaff()) return '';
    return `<div class="v1-note warn">교육 기록을 아직 시작하지 못했어요. 새로고침해 보세요.</div>`;
  }

  function homeView() {
    const list = steps();
    const isDone = s => record(s.id).status === 'done';
    const done = list.filter(isDone).length;
    const mine = cloud.target === cloud.user.id;
    if (isStaff() && mine) return peopleBar();
    const who = mine ? '' : `<div class="v1-muted">${esc(cloud.name)}님의 교육 기록</div>`;
    const item = s => {
      const r = record(s.id), st = r.status, n = stepIndex(s.id) + 1;
      const sub = st === 'done' ? '확인 완료 · ' + dateLabel(r.done) : st === 'review' ? '확인 요청 ' + dateLabel(r.request) :
        `확인 ${r.self.filter(Boolean).length}/${s.checks.length}`;
      return `<li><button class="v1-item ${st}" data-step="${esc(s.id)}"><span class="v1-num">${n}</span><span class="v1-body"><strong>${esc(s.title)}</strong><small>${esc(STATUS[st])} · ${sub}</small></span><span class="v1-chev">›</span></button></li>`;
    };
    let stage = null, groups = '';
    for (const u of content.units) {
      if (!stage || stage !== u.stage.order) { stage = u.stage.order; groups += `<h2 class="v1-stage">${u.stage.order}. ${esc(u.stage.title)}</h2>`; }
      groups += `<h3 class="v1-unit">${esc(u.title)}<small>${u.steps.filter(isDone).length}/${u.steps.length} · 교육 시작 후 ${u.plan[0]}~${u.plan[1]}일차</small></h3>` +
        '<ul class="v1-list">' + u.steps.map(item).join('') + '</ul>';
    }
    return peopleBar() +
      `<section class="v1-card">${who}` +
      `<div class="v1-progress"><i style="width:${list.length ? Math.round(done / list.length * 100) : 0}%"></i></div>` +
      `<div class="v1-muted">${done}/${list.length} 완료</div>${enrolNotice()}</section>` + groups +
      `<p class="v1-src">원본 색인 ${esc((content.sourceIndexedAt || '').slice(0, 10))} · 교육안 ${esc(content.courseVersion)} · 기록은 서버에 저장됩니다</p>`;
  }

  function stepView(s) {
    const r = record(s.id), st = r.status, who = role(), own = who === 'learner', staff = who === 'staff';
    const i = stepIndex(s.id), next = steps()[i + 1];
    const editSelf = own && canWrite() && (st === 'ready' || st === 'practice');
    const editTeacher = staff && mayConfirm() && canWrite() && st === 'review';
    const checks = '<ul class="v1-checks">' + s.checks.map((c, k) => {
      if (staff) {
        return `<li><label><input type="checkbox" data-teacher="${k}" ${r.teacher[k] ? 'checked' : ''} ${editTeacher && !busy ? '' : 'disabled'}><span class="v1-box"></span><span>${esc(c)}` +
          `<span class="v1-by">교육생 ${r.self[k] ? '체크 ' + dateLabel(r.selfAt[k]) : '미체크'}${r.teacher[k] ? ' · 담당자 확인 ' + dateLabel(r.teacherAt[k]) : ''}</span></span></label></li>`;
      }
      return `<li><label><input type="checkbox" data-self="${k}" ${r.self[k] ? 'checked' : ''} ${editSelf && !busy ? '' : 'disabled'}><span class="v1-box"></span><span>${esc(c)}` +
        (r.teacher[k] ? `<span class="v1-by">담당자 확인 ${dateLabel(r.teacherAt[k])}</span>` : '') + '</span></label></li>';
    }).join('') + '</ul>';
    const shots = s.photos.map(p => content.photos[p]).filter(Boolean);
    const photos = (shots.length > 1 ? '<div class="v1-photos">' : '') + shots.map(p =>
      `<figure class="v1-photo"><img src="${p.src}" alt="${esc(p.caption)}"><figcaption>${esc(p.caption)}</figcaption></figure>`).join('') + (shots.length > 1 ? '</div>' : '');
    const srcLabel = key => { const sec = content.sections[key], doc = sec && content.documents[sec.doc]; return sec ? `${doc ? doc.title : ''} ${sec.no} ${sec.title}`.trim() : key; };
    const cite = key => `<button type="button" class="v1-cite" data-cite="${esc(key)}">${esc(srcLabel(key))}</button>`;
    const keyPoints = s.keyPoints && s.keyPoints.length ? `<ol class="v1-kp">${s.keyPoints.map(k => `<li><div>${esc(k.text).replace(/\n/g, '<br>')}</div><div class="v1-cites">${k.cites.map(cite).join('')}</div></li>`).join('')}</ol>` : `<div class="v1-copy">${s.copy.map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
    const table = t => `<div class="table-wrap"><table><thead><tr>${t.header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map(r =>
      r.length === 1 && t.header.length > 1 ? `<tr><td class="v1-grp" colspan="${t.header.length}">${esc(r[0])}</td></tr>` : `<tr>${r.map(c => `<td>${esc(c).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    const sources = (s.sources || []).map(key => {
      const sec = content.sections[key]; if (!sec) return '';
      const doc = content.documents[sec.doc] || {};
      return `<details class="v1-guide" id="src-${esc(key).replace(/[^0-9A-Za-z.-]/g, '_')}"><summary><span>${esc(doc.title || '')} <b>${esc(sec.no)} ${esc(sec.title)}</b></span><span class="v1-tag">${esc(doc.type || '')} ${esc(doc.version || '')}</span></summary>` +
        `<div class="v1-guide-body"><p class="v1-src">${esc(doc.title || '')} · ${esc(doc.type || '')} ${esc(doc.version || '')} (${esc(doc.revised || '')}) · ${esc(sec.kind)}${sec.images ? ` · 사진 ${sec.images}장은 원본 파일에서` : ''}</p>` +
        sec.paragraphs.map(p => `<p>${esc(p)}</p>`).join('') + sec.tables.map(table).join('') + `<p class="v1-src">파일: ${esc(doc.file || '')}</p></div></details>`;
    }).join('') + (s.refDocs || []).map(d =>
      `<div class="v1-guide"><div class="v1-refdoc"><span>${esc(d.title)}</span><span class="v1-tag">${esc(d.ref)}</span></div><p class="v1-src">파일: ${esc(d.file)}</p></div>`).join('');
    let status = '';
    if (st === 'review') status = `<div class="v1-note">${dateLabel(r.request)}에 담당자 확인을 요청했어요. 담당자가 확인하면 완료됩니다.</div>`;
    if (st === 'done') status = `<div class="v1-note ok">${dateLabel(r.done)} 담당자 확인 완료</div>`;
    if (r.feedback) status += `<div class="v1-note warn">재교육 사유: ${esc(r.feedback)}</div>`;
    let actions = '';
    if (own && (st === 'ready' || st === 'practice')) {
      const ready = r.self.every(Boolean);
      actions = `<button class="v1-btn primary" data-request ${ready && canWrite() && !busy ? '' : 'disabled'}>담당자 확인 요청</button>`;
    } else if (staff && st === 'review') {
      actions = `<button class="v1-btn primary" data-complete ${r.teacher.every(Boolean) && mayConfirm() && !busy ? '' : 'disabled'}>확인 완료</button>`;
    }
    if (next) actions += `<button class="v1-btn" data-step="${esc(next.id)}">다음 항목 ›</button>`;
    const memo = own || r.memo ? `<section class="v1-card"><h2>메모</h2><div class="v1-muted">어려웠던 점, 담당자에게 확인할 내용</div>` +
      `<textarea class="v1-memo" data-memo ${editSelf && !busy ? '' : 'disabled'} placeholder="${own ? '적어 두면 담당자가 확인할 때 함께 봅니다' : ''}">${esc(r.memo)}</textarea></section>` : '';
    const purpose = s.purpose ? `<p class="v1-purpose">${esc(s.purpose).replace(/\n/g, '<br>')}</p>` : `<div class="v1-copy">${s.copy.map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
    return `<section class="v1-card"><span class="v1-pill ${st}">${esc(STATUS[st])}</span> <span class="v1-muted">${i + 1}/${steps().length} · ${esc(cloud.name)}</span>` +
      `<h2 style="margin-top:var(--spacing-12)">교육 목적</h2>${purpose}${photos}` +
      (s.note ? `<div class="v1-note warn">${esc(s.note)}</div>` : '') + `${enrolNotice()}${status}</section>` +
      `<section class="v1-card"><h2>교육 내용</h2>${keyPoints}</section>` +
      `<section class="v1-card"><h2>수행 확인</h2><div class="v1-muted">${own ? '직접 해 보고 하나씩 체크하세요. 다 체크하면 담당자에게 확인을 요청할 수 있어요.' : staff ? (mayConfirm() ? '교육생이 체크한 항목을 현장에서 확인하고 체크하세요.' : '이 교육생의 확인 담당자는 ' + esc(cloud.roster.find(x => x.id === cloud.target)?.trainer || '미배정') + '님이에요.') : '교육생 본인과 담당자만 체크할 수 있어요.'}</div>${checks}</section>` +
      memo + (sources ? `<section class="v1-card"><h2>원본 보기</h2><div class="v1-muted">${s.sources && s.sources.length ? '이 항목이 인용한 매뉴얼의 절. 문서 전체는 Works Drive의 원본 파일에서 봅니다.' : '이 항목의 원고 문서. 내용은 원본 파일에서 봅니다.'}</div><div class="v1-sources">${sources}</div></section>` : '') +
      (actions ? `<div class="v1-actions">${actions}</div>` : '');
  }

  function bind(step) {
    const app = $('app');
    app.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { view = 'step:' + b.dataset.step; render(); });
    app.querySelectorAll('[data-person]').forEach(b => b.onclick = () => load(b.dataset.person).catch(e => toast(e.message)));
    app.querySelectorAll('[data-cite]').forEach(b => b.onclick = () => {
      const el = document.getElementById('src-' + b.dataset.cite.replace(/[^0-9A-Za-z.-]/g, '_'));
      if (!el) return; el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600);
    });
    if (!step) return;
    app.querySelectorAll('[data-self]').forEach(c => c.onchange = () => act('step.self', {step: step.id, index: Number(c.dataset.self), on: c.checked}));
    app.querySelectorAll('[data-teacher]').forEach(c => c.onchange = () => act('step.teacher', {step: step.id, index: Number(c.dataset.teacher), on: c.checked}));
    const memo = app.querySelector('[data-memo]');
    if (memo) memo.onchange = () => { if (memo.value !== record(step.id).memo) act('step.memo', {step: step.id, memo: memo.value}).then(ok => ok && toast('메모를 저장했어요.')); };
    const request = app.querySelector('[data-request]');
    if (request) request.onclick = () => act('step.request', {step: step.id}).then(ok => ok && toast('담당자에게 확인을 요청했어요.'));
    const complete = app.querySelector('[data-complete]');
    if (complete) complete.onclick = () => act('step.complete', {step: step.id}).then(ok => ok && toast('확인 완료로 기록했어요.'));
  }

  // Trial only: the server answers /api/dev/accounts on a local run or when started with LMS_TRIAL=1.
  async function devSwitcher() {
    const bar = $('v1Dev');
    try {
      const response = await fetch('/api/dev/accounts', {credentials: 'same-origin', cache: 'no-store'});
      if (!response.ok) return;
      const data = await response.json();
      if (!data.accounts.length) return;
      bar.innerHTML = '<span>역할 전환</span>' + data.accounts.map(a =>
        `<button data-dev="${esc(a.id)}" class="${a.id === data.current ? 'on' : ''}">${esc(a.name)}</button>`).join('');
      bar.hidden = false;
      bar.querySelectorAll('[data-dev]').forEach(b => b.onclick = async () => {
        const r = await fetch('/api/dev/accounts?id=' + encodeURIComponent(b.dataset.dev), {method: 'POST', credentials: 'same-origin',
          headers: {'Content-Type': 'application/json', 'X-CSRF-Token': ERPAuth.csrfToken || ''}, body: '{}'});
        if (r.ok) location.reload(); else toast('계정을 바꾸지 못했어요.');
      });
    } catch {}
  }

  $('v1Back').onclick = () => { view = 'home'; render(); };
  $('v1Who').onclick = () => ERPAuth.openAccount();

  // Local trial only: with no session yet, sign in as the first trial learner so nobody types a password.
  // The server answers /api/dev/accounts only on a local run or with LMS_TRIAL=1; elsewhere this is a no-op
  // and the normal login gate appears. WORKS SSO replaces both later.
  async function devAutoLogin() {
    try {
      const status = await fetch('/api/auth/status', {credentials: 'same-origin', cache: 'no-store'}).then(r => r.json());
      if (status.user) return;
      const response = await fetch('/api/dev/accounts', {credentials: 'same-origin', cache: 'no-store'});
      if (!response.ok) return;
      const {accounts} = await response.json();
      const pick = accounts.find(a => a.email === 'learner@local.test') || accounts[0];
      if (!pick) return;
      await fetch('/api/dev/accounts?id=' + encodeURIComponent(pick.id), {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, body: '{}'});
    } catch {}
  }

  // --- start: sign in (automatically on a local trial), load the slice and the record, pick a sensible first target
  devAutoLogin().then(() => ERPAuth.ensureSession()).then(async () => {
    const response = await fetch('/v1_content.json', {credentials: 'same-origin', cache: 'no-store'});
    if (!response.ok) throw new Error('교육 내용을 불러오지 못했습니다.');
    content = await response.json();
    cloud = await api('GET');
    if (!cloud.enrolled && !isStaff()) await act('config.selfEnrol', {});  // 처음 들어온 날이 교육 시작일
    if (!cloud.enrolled && isStaff() && others().length) cloud = await api('GET', null, others()[0].id);
    render();
    devSwitcher();
  }).catch(e => { $('app').innerHTML = `<div class="v1-card"><h2>불러오지 못했어요</h2><p class="v1-muted">${esc(e.message)}</p><button class="v1-btn" onclick="location.reload()">다시 시도</button></div>`; });
})();
