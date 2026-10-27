// Momos onboarding · v1: 단계 → 단원 → 세션. read → check → trainer confirm. Phone first.
// Data: /v1_content.json (the course slice) and /api/onboarding (records). No local-only state.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const STATUS = {ready: '시작 전', practice: '진행 중', review: '담당자 확인 대기', done: '완료', planned: '준비 중'};
  const dateLabel = d => d ? d.replace(/-/g, '.') : '-';

  let shownView = null, keepFocus = null, devBar = false;
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
  const isStaff = () => Boolean(cloud.workspaceRoles.admin || cloud.workspaceRoles.trainer || cloud.workspaceRoles.assessor);
  const role = () => cloud.permissions.own ? 'learner' : isStaff() ? 'staff' : 'viewer';
  const mayConfirm = () => Boolean(cloud.permissions.trainer);
  const others = () => cloud.roster.filter(r => r.id !== cloud.user.id && r.join);

  // --- rendering
  function render() {
    if (!cloud || !content) return;
    const step = view.startsWith('step:') ? steps()[stepIndex(view.slice(5))] : null;
    const branch = view === 'branch';
    // 지점 선택(첫 화면) ← 홈(교육 목록) ← 항목. 꺽쇠는 한 단계 위로. 역할 전환·계정 칩은 지점을 고른 뒤에만.
    $('v1Back').hidden = branch;
    $('v1Back').setAttribute('aria-label', step ? '교육 목록으로' : '지점 선택으로');
    $('v1Title').textContent = step ? step.title : '모모스 온보딩';
    const stg = step && unitOf(step.id).stage;  // 항목 화면: 제목 위에 '1. 입사·현장 적응'
    $('v1Stage').hidden = !stg;
    $('v1Stage').textContent = stg ? `${stg.order}. ${stg.title}` : '';
    $('v1Who').textContent = cloud.user.name;
    $('v1Who').hidden = branch;
    $('v1More').hidden = !step || planned(step);
    closeMenu();
    if (devBar) $('v1Dev').hidden = branch;
    // 같은 화면을 다시 그릴 때(체크·저장 등)는 보던 위치·펼친 원본·포커스를 그대로 둔다. 다른 항목으로 갈 때만 맨 위로.
    const app = $('app'), same = view === shownView, y = window.scrollY;
    if (!same && shownView === 'home') homeScroll = {stage: stageSel, y};  // 항목을 누른 직후라 stageSel 은 보던 탭(= 그 항목의 단계)
    const opened = same ? [...app.querySelectorAll('details[open][id]')].map(d => d.id) : [];
    const f = same && app.contains(document.activeElement) ? document.activeElement : null;
    const focusSel = f && ['data-self', 'data-teacher', 'data-step'].map(a => f.hasAttribute(a) ? `[${a}="${CSS.escape(f.getAttribute(a))}"]` : '').find(Boolean);
    // 기준점: 방금 누른 체크박스. 그 위쪽 내용 높이가 바뀌어도(상태 문구 등) 화면에서 같은 자리에 머물게 한다.
    const anchorSel = same && (focusSel || keepFocus), anchor = anchorSel && app.querySelector(anchorSel);
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
    app.innerHTML = branch ? branchView() : step ? stepView(step) : homeView();
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
    return `<section class="v1-branch"><h2>교육을 진행할 지점을 선택해 주세요.</h2><p class="v1-muted">선택한 지점의 교육 과정으로 이동합니다.</p>` +
      `<div class="v1-branches">${BRANCHES.map(b => b.ready
        ? `<button type="button" class="v1-branch-card" data-branch="${b.id}"><span class="v1-branch-icon">${STORE_ICON}</span><span class="v1-branch-name">${esc(b.name)}</span></button>`
        : `<button type="button" class="v1-branch-card" disabled aria-disabled="true" title="교육 과정 준비 중"><span class="v1-branch-icon">${STORE_ICON}</span><span class="v1-branch-name">${esc(b.name)}</span><span class="v1-branch-soon">준비 중</span></button>`).join('')}</div></section>`;
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
    const editTeacher = staff && mayConfirm() && canWrite() && st === 'review';
    const srcLabel = key => { const sec = content.sections[key], doc = sec && content.documents[sec.doc]; return sec ? `${doc ? doc.title : ''} ${sec.no} ${sec.title}`.trim() : key; };
    const table = t => `<div class="table-wrap"><table><thead><tr>${t.header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map(r =>
      r.length === 1 && t.header.length > 1 ? `<tr><td class="v1-grp" colspan="${t.header.length}">${esc(r[0])}</td></tr>` : `<tr>${r.map(c => `<td>${esc(c).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    // 원본 절 하나의 본문(문서·판본·파일 + 단락·표). 예전 '원본 보기' 카드 대신 읽던 자리에서 펼친다.
    const inlineSource = key => {
      const sec = content.sections[key];
      if (!sec) return '<p class="v1-muted">연결된 본문을 찾지 못했어요. 교육 담당자에게 확인해 주세요.</p>';
      const doc = content.documents[sec.doc] || {};
      return `<section class="v1-inline">` +
        `<h3>${esc(sec.no)} ${esc(sec.title)}</h3>${sec.paragraphs.map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}${sec.tables.map(table).join('')}` +
        `<p class="v1-inline-file">원본 파일: ${esc(doc.folder ? doc.folder + ' / ' : '')}${esc(doc.file || '')}</p></section>`;
    };
    const hint = '<span class="v1-toggle"><span class="when-closed">본문 펼치기</span><span class="when-open">본문 접기</span><svg class="v1-chev" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
    const body = keys => `<div class="v1-src-body" role="region">${keys.map(inlineSource).join('')}<div class="v1-src-end"><button type="button" class="v1-tbtn" data-close-src>본문 접기</button></div></div>`;
    // 수행 확인에는 근거 본문을 달지 않는다(근거 문서는 교육 내용에서 본다). checkCites 데이터·매핑은 그대로 둔다.
    const checkCites = () => '';
    const checks = '<ul class="v1-checks">' + s.checks.map((c, k) => {
      if (staff) {
        return `<li><label><input type="checkbox" data-teacher="${k}" ${r.teacher[k] ? 'checked' : ''} ${editTeacher && !busy ? '' : 'disabled'}><span class="v1-box"></span><span>${esc(c)}` +
          `<span class="v1-by">교육생 ${r.self[k] ? '체크 ' + dateLabel(r.selfAt[k]) : '미체크'}${r.teacher[k] ? ' · 담당자 확인 ' + dateLabel(r.teacherAt[k]) : ''}</span></span></label>${checkCites(k)}</li>`;
      }
      return `<li><label><input type="checkbox" data-self="${k}" ${r.self[k] ? 'checked' : ''} ${editSelf && !busy ? '' : 'disabled'}><span class="v1-box"></span><span>${esc(c)}` +
        (r.teacher[k] ? `<span class="v1-by">담당자 확인 ${dateLabel(r.teacherAt[k])}</span>` : '') + '</span></label>' + checkCites(k) + '</li>';
    }).join('') + '</ul>';
    const shots = s.photos.map(p => content.photos[p]).filter(Boolean);
    const photos = (shots.length > 1 ? '<div class="v1-photos">' : '') + shots.map((p, n) =>
      // 사진도 원본 docx 의 절에서만 가져온다. 아래 토글 = 그 사진이 들어 있는 절(펼치면 사진 칸이 한 줄 전체로 넓어진다).
      `<figure class="v1-photo${p.wide ? ' v1-photo-wide' : ''}"><img src="${p.src}" alt="${esc(p.caption)}" loading="lazy"><figcaption>${esc(p.caption)}</figcaption></figure>`).join('') + (shots.length > 1 ? '</div>' : '');
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
    } else if (staff && st === 'review') {
      actions = `<button class="v1-btn primary" data-complete ${r.teacher.every(Boolean) && mayConfirm() && !busy ? '' : 'disabled'}>확인 완료</button>`;
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
      `<section class="v1-card"><h2>수행 확인</h2><div class="v1-muted">${own ? '직접 해 보고 하나씩 체크하세요. 다 체크하면 담당자에게 확인을 요청할 수 있어요.' : staff ? (mayConfirm() ? '교육생이 체크한 항목을 현장에서 확인하고 체크하세요.' : '이 교육생의 확인 담당자는 ' + esc(cloud.roster.find(x => x.id === cloud.target)?.trainer || '미배정') + '님이에요.') : '교육생 본인과 담당자만 체크할 수 있어요.'}</div>${checks}</section>` +
      memo +
      (actions ? `<div class="v1-actions">${actions}</div>` : '');
  }

  function bind(step) {
    const app = $('app');
    app.querySelectorAll('[data-branch]').forEach(b => b.onclick = () => { view = 'home'; render(); });
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
    app.querySelectorAll('[data-teacher]').forEach(c => c.onchange = () => (keepFocus = `[data-teacher="${c.dataset.teacher}"]`, act('step.teacher', {step: step.id, index: Number(c.dataset.teacher), on: c.checked})));  // 누른 체크박스 = 다시 그릴 때의 기준점·포커스(Safari 는 클릭해도 포커스를 안 준다)
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
      devBar = true; bar.hidden = view === 'branch';
      bar.querySelectorAll('[data-dev]').forEach(b => b.onclick = async () => {
        const r = await fetch('/api/dev/accounts?id=' + encodeURIComponent(b.dataset.dev), {method: 'POST', credentials: 'same-origin',
          headers: {'Content-Type': 'application/json', 'X-CSRF-Token': ERPAuth.csrfToken || ''}, body: '{}'});
        if (r.ok) { try { sessionStorage.setItem('v1.skipBranch', '1'); } catch {} location.reload(); } else toast('계정을 바꾸지 못했어요.');
      });
    } catch {}
  }


  // --- 더보기 메뉴 · PDF 내보내기(항목 하나). 브라우저 인쇄 → 'PDF로 저장'.
  // 원문 본문·상태 안내·메모·버튼은 빼고, 수행 확인은 빈 체크박스로 찍는다.
  function closeMenu() { $('v1Menu').hidden = true; $('v1MoreBtn').setAttribute('aria-expanded', 'false'); }
  function printView(s) {
    const i = stepIndex(s.id), u = unitOf(s.id), stg = u.stage;
    const srcLabel = key => { const sec = content.sections[key], doc = sec && content.documents[sec.doc]; return sec ? `${doc ? doc.title : ''} ${sec.no} ${sec.title}`.replace(/\s+/g, ' ').trim() : key; };
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
      (shots.length ? `<div class="p-photos">${shots.map(p => `<figure><img src="${p.src}" alt="${esc(p.caption)}"><figcaption>${esc(p.caption)}</figcaption></figure>`).join('')}</div>` : '') +
      (s.note ? `<div class="p-note">${esc(s.note)}</div>` : '') + kp +
      `<h2>수행 확인</h2><ul class="p-checks">${s.checks.map(c => `<li><span class="p-box"></span><span>${esc(c)}</span></li>`).join('')}</ul>` +
      `<div class="p-foot">콘텐츠 기준 ${esc(dateLabel(content.curriculumVersion))} · 출력 ${printed}</div>`;
  }

  // --- 임시: 공유 테스트. WORKS 앱 안 브라우저에서 Web Share(파일)가 되는지 확인한다. 확인이 끝나면 지운다.
  function testPdf() {
    // 한 쪽짜리 최소 PDF(영문 한 줄). xref 위치를 계산해 유효한 파일로 만든다.
    const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>', null,
      '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
    const text = 'BT /F1 20 Tf 72 760 Td (MOMOS share test) Tj ET';
    objs[3] = `<</Length ${text.length}>>\nstream\n${text}\nendstream`;
    let out = '%PDF-1.4\n'; const at = [];
    objs.forEach((o, n) => { at.push(out.length); out += `${n + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + at.map(x => String(x).padStart(10, '0') + ' 00000 n \n').join('') +
      `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
    return new File([out], 'momos_share_test.pdf', {type: 'application/pdf'});
  }
  function shareTest() {
    closeMenu();
    const file = testPdf(), lines = [];
    const yn = v => v ? '예' : '아니오';
    let canFiles = false;
    try { canFiles = Boolean(navigator.canShare && navigator.canShare({files: [file]})); } catch (e) { lines.push('canShare 오류: ' + e.message); }
    lines.unshift(`navigator.share 있음: ${yn(typeof navigator.share === 'function')}`, `navigator.canShare 있음: ${yn(typeof navigator.canShare === 'function')}`,
      `PDF 파일 공유 가능: ${yn(canFiles)}`, `window.print 있음: ${yn(typeof window.print === 'function')}`, `UA: ${navigator.userAgent}`);
    const show = extra => {
      let box = $('v1Diag');
      if (!box) { box = document.createElement('div'); box.id = 'v1Diag'; box.className = 'v1-note v1-diag'; $('app').prepend(box); }
      box.textContent = '[공유 테스트]\n' + lines.concat(extra || []).join('\n');
      window.scrollTo({top: 0, behavior: 'instant'});
    };
    show(['공유 시도 중…']);
    // 누른 직후(같은 클릭 안)에 바로 share 를 불러야 iOS 가 공유 시트를 허용한다
    if (typeof navigator.share !== 'function') return show(['결과: 이 화면에서는 공유 기능을 쓸 수 없음']);
    const data = canFiles ? {files: [file], title: 'MOMOS 공유 테스트'} : {title: 'MOMOS 공유 테스트', url: location.href};
    navigator.share(data).then(() => show([`결과: 공유 시트 열림 → 완료 (${canFiles ? 'PDF 파일' : '링크만'})`]))
      .catch(e => show([`결과: ${e.name} — ${e.message}`, e.name === 'AbortError' ? '(공유 시트는 열렸고 취소함)' : '']));
  }
  async function exportPdf() {
    closeMenu();
    const s = view.startsWith('step:') && steps()[stepIndex(view.slice(5))];
    if (!s) return;
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

  $('v1Back').onclick = () => { view = view.startsWith('step:') ? 'home' : 'branch'; render(); };
  $('v1Who').onclick = () => ERPAuth.openAccount();
  $('v1MoreBtn').onclick = e => { e.stopPropagation(); const open = $('v1Menu').hidden; $('v1Menu').hidden = !open; $('v1MoreBtn').setAttribute('aria-expanded', String(open)); };
  $('v1ExportPdf').onclick = exportPdf;
  $('v1ShareTest').onclick = shareTest;
  document.addEventListener('click', e => { if (!$('v1More').contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('v1Menu').hidden) { closeMenu(); $('v1MoreBtn').focus(); } });

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
    try { if (sessionStorage.getItem('v1.skipBranch')) { sessionStorage.removeItem('v1.skipBranch'); view = 'home'; } } catch {}  // 역할 전환 직후의 새로고침
    cloud = await api('GET');
    if (!cloud.enrolled && !isStaff()) await act('config.selfEnrol', {});  // 처음 들어온 날이 교육 시작일
    if (!cloud.enrolled && isStaff() && others().length) cloud = await api('GET', null, others()[0].id);
    render();
    devSwitcher();
  }).catch(e => { $('app').innerHTML = `<div class="v1-card"><h2>불러오지 못했어요</h2><p class="v1-muted">${esc(e.message)}</p><button class="v1-btn" onclick="location.reload()">다시 시도</button></div>`; });
})();
