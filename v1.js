// Momos onboarding · v1: one unit, read → check → trainer confirm. Phone first.
// Data: /v1_content.json (the course slice) and /api/onboarding (records). No local-only state.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const STATUS = {ready: '시작 전', practice: '진행 중', review: '교육자 확인 대기', done: '완료'};
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
  const unit = () => content.units[0];
  const steps = () => unit().steps;
  const record = id => cloud.learner.records[id];
  const stepIndex = id => steps().findIndex(s => s.id === id);
  const canWrite = () => cloud.enrolled && cloud.scheduled;
  const role = () => {
    const p = cloud.permissions;
    if (p.own) return 'learner';
    if (p.trainer) return 'trainer';
    if (p.admin) return 'admin';
    return 'viewer';
  };
  const others = () => cloud.roster.filter(r => r.id !== cloud.user.id && r.join);

  // --- rendering
  function render() {
    if (!cloud || !content) return;
    const step = view.startsWith('step:') ? steps()[stepIndex(view.slice(5))] : null;
    $('v1Back').hidden = !step;
    $('v1Title').textContent = step ? step.title : unit().title;
    $('v1Who').textContent = cloud.user.name;
    $('app').innerHTML = step ? stepView(step) : homeView();
    bind(step);
    if (step) window.scrollTo(0, 0);
  }

  function peopleBar() {
    const list = others();
    if (!list.length || role() === 'learner' && cloud.target === cloud.user.id && !cloud.workspaceRoles.trainer && !cloud.workspaceRoles.admin) return '';
    return '<div class="v1-card"><div class="v1-muted">교육 기록 대상</div><div class="v1-people">' +
      list.map(r => `<button data-person="${esc(r.id)}" class="${r.id === cloud.target ? 'on' : ''}">${esc(r.name)}</button>`).join('') +
      '</div></div>';
  }

  function enrolNotice() {
    if (canWrite()) return '';
    const admin = cloud.permissions.admin;
    const why = !cloud.enrolled ? '아직 교육 배정 전이에요.' : '교육 시작일이 아직 정해지지 않았어요.';
    return `<div class="v1-note warn">${why} 교재는 볼 수 있고, 체크와 확인 요청은 배정 후에 할 수 있어요.` +
      (admin ? ` <a class="v1-link" href="/onboarding?view=account">교육 배정하기</a>` : '') + '</div>';
  }

  function homeView() {
    const u = unit(), list = steps();
    const done = list.filter(s => record(s.id).status === 'done').length;
    const mine = cloud.target === cloud.user.id;
    const who = mine ? '' : `<div class="v1-muted">${esc(cloud.name)}님의 교육 기록</div>`;
    return peopleBar() +
      `<section class="v1-card">${who}<h2>${esc(u.title)}</h2><div class="v1-muted">${esc(u.summary)} · 교육 시작 후 ${u.plan[0]}~${u.plan[1]}일차</div>` +
      `<div class="v1-progress"><i style="width:${list.length ? Math.round(done / list.length * 100) : 0}%"></i></div>` +
      `<div class="v1-muted">${done}/${list.length} 완료</div>${enrolNotice()}</section>` +
      '<ul class="v1-list">' + list.map((s, i) => {
        const r = record(s.id), st = r.status;
        const sub = st === 'done' ? '확인 완료 · ' + dateLabel(r.done) : st === 'review' ? '확인 요청 ' + dateLabel(r.request) :
          `확인 ${r.self.filter(Boolean).length}/${s.checks.length}`;
        return `<li><button class="v1-item ${st}" data-step="${esc(s.id)}"><span class="v1-num">${i + 1}</span><span class="v1-body"><strong>${esc(s.title)}</strong><small>${esc(STATUS[st])} · ${sub}</small></span><span class="v1-chev">›</span></button></li>`;
      }).join('') + '</ul>' +
      `<p class="v1-src">교재 ${esc(content.sourceVersion)} · 교육안 ${esc(content.courseVersion)} · 기록은 서버에 저장됩니다</p>`;
  }

  function stepView(s) {
    const r = record(s.id), st = r.status, who = role(), own = who === 'learner';
    const i = stepIndex(s.id), next = steps()[i + 1];
    const editSelf = own && canWrite() && (st === 'ready' || st === 'practice');
    const editTeacher = who === 'trainer' && canWrite() && st === 'review';
    const checks = '<ul class="v1-checks">' + s.checks.map((c, k) => {
      if (who === 'trainer') {
        return `<li><label><input type="checkbox" data-teacher="${k}" ${r.teacher[k] ? 'checked' : ''} ${editTeacher && !busy ? '' : 'disabled'}><span>${esc(c)}` +
          `<span class="v1-by">교육생 ${r.self[k] ? '체크 ' + dateLabel(r.selfAt[k]) : '미체크'}${r.teacher[k] ? ' · 교육자 확인 ' + dateLabel(r.teacherAt[k]) : ''}</span></span></label></li>`;
      }
      return `<li><label><input type="checkbox" data-self="${k}" ${r.self[k] ? 'checked' : ''} ${editSelf && !busy ? '' : 'disabled'}><span>${esc(c)}` +
        (r.teacher[k] ? `<span class="v1-by">교육자 확인 ${dateLabel(r.teacherAt[k])}</span>` : '') + '</span></label></li>';
    }).join('') + '</ul>';
    const photos = s.photos.map(p => content.photos[p]).filter(Boolean).map(p =>
      `<figure class="v1-photo"><img src="${p.src}" alt="${esc(p.caption)}"><figcaption>${esc(p.caption)}</figcaption></figure>`).join('');
    const guides = s.refs.map(ref => content.guides[ref]).filter(Boolean).map(g =>
      `<details class="v1-guide"><summary>교재 · ${esc(g.title)}</summary><div class="v1-guide-body">${g.html}<p class="v1-src">출처: ${esc(g.file)} · ${esc(content.sourceVersion)}</p></div></details>`).join('');
    let status = '';
    if (st === 'review') status = `<div class="v1-note">${dateLabel(r.request)}에 교육자 확인을 요청했어요. 교육자가 확인하면 완료됩니다.</div>`;
    if (st === 'done') status = `<div class="v1-note ok">${dateLabel(r.done)} 교육자 확인 완료</div>`;
    if (r.feedback) status += `<div class="v1-note warn">재교육 사유: ${esc(r.feedback)}</div>`;
    let actions = '';
    if (own && (st === 'ready' || st === 'practice')) {
      const ready = r.self.every(Boolean);
      actions = `<button class="v1-btn primary" data-request ${ready && canWrite() && !busy ? '' : 'disabled'}>교육자 확인 요청</button>`;
    } else if (who === 'trainer' && st === 'review') {
      actions = `<button class="v1-btn primary" data-complete ${r.teacher.every(Boolean) && !busy ? '' : 'disabled'}>확인 완료</button>`;
    }
    if (next) actions += `<button class="v1-btn" data-step="${esc(next.id)}">다음 항목 ›</button>`;
    const memo = own || r.memo ? `<section class="v1-card"><h2>메모</h2><div class="v1-muted">어려웠던 점, 교육자에게 확인할 내용</div>` +
      `<textarea class="v1-memo" data-memo ${editSelf && !busy ? '' : 'disabled'} placeholder="${own ? '적어 두면 교육자가 확인할 때 함께 봅니다' : ''}">${esc(r.memo)}</textarea></section>` : '';
    return `<section class="v1-card"><span class="v1-pill ${st}">${esc(STATUS[st])}</span> <span class="v1-muted">${i + 1}/${steps().length} · ${esc(cloud.name)}</span>` +
      `<div class="v1-copy" style="margin-top:10px">${s.copy.map(p => `<p>${esc(p)}</p>`).join('')}</div>${photos}` +
      (s.note ? `<div class="v1-note warn">${esc(s.note)}</div>` : '') + `${enrolNotice()}${status}</section>` +
      `<section class="v1-card"><h2>배운 내용·수행 확인</h2><div class="v1-muted">${own ? '직접 해 보고 하나씩 체크하세요. 다 체크하면 교육자에게 확인을 요청할 수 있어요.' : who === 'trainer' ? '교육생이 체크한 항목을 현장에서 확인하고 체크하세요.' : '교육생 본인과 배정된 교육자만 체크할 수 있어요.'}</div>${checks}</section>` +
      memo + guides + (actions ? `<div class="v1-actions">${actions}</div>` : '');
  }

  function bind(step) {
    const app = $('app');
    app.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { view = 'step:' + b.dataset.step; render(); });
    app.querySelectorAll('[data-person]').forEach(b => b.onclick = () => load(b.dataset.person).catch(e => toast(e.message)));
    if (!step) return;
    app.querySelectorAll('[data-self]').forEach(c => c.onchange = () => act('step.self', {step: step.id, index: Number(c.dataset.self), on: c.checked}));
    app.querySelectorAll('[data-teacher]').forEach(c => c.onchange = () => act('step.teacher', {step: step.id, index: Number(c.dataset.teacher), on: c.checked}));
    const memo = app.querySelector('[data-memo]');
    if (memo) memo.onchange = () => { if (memo.value !== record(step.id).memo) act('step.memo', {step: step.id, memo: memo.value}).then(ok => ok && toast('메모를 저장했어요.')); };
    const request = app.querySelector('[data-request]');
    if (request) request.onclick = () => act('step.request', {step: step.id}).then(ok => ok && toast('교육자에게 확인을 요청했어요.'));
    const complete = app.querySelector('[data-complete]');
    if (complete) complete.onclick = () => act('step.complete', {step: step.id}).then(ok => ok && toast('확인 완료로 기록했어요.'));
  }

  $('v1Back').onclick = () => { view = 'home'; render(); };
  $('v1Who').onclick = () => ERPAuth.openAccount();

  // --- start: wait for login, load the slice and the record, pick a sensible first target
  ERPAuth.ensureSession().then(async () => {
    const response = await fetch('/v1_content.json', {credentials: 'same-origin', cache: 'no-store'});
    if (!response.ok) throw new Error('교육 내용을 불러오지 못했습니다.');
    content = await response.json();
    cloud = await api('GET');
    if (!cloud.enrolled && (cloud.workspaceRoles.trainer || cloud.workspaceRoles.admin) && others().length) cloud = await api('GET', null, others()[0].id);
    render();
  }).catch(e => { $('app').innerHTML = `<div class="v1-card"><h2>불러오지 못했어요</h2><p class="v1-muted">${esc(e.message)}</p><button class="v1-btn" onclick="location.reload()">다시 시도</button></div>`; });
})();
