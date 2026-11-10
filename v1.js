// Momos onboarding · v1: 단계 → 단원 → 세션. read → check → trainer confirm. Phone first.
// Data: /v1_content.json (the course slice) and /api/onboarding (records). No local-only state.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const STATUS = {ready: '시작 전', practice: '진행 중', review: '담당자 확인 대기', done: '완료', planned: '준비 중'};
  const dateLabel = d => d ? d.replace(/-/g, '.') : '-';
  // 서버 UTC ISO(…T…+00:00) → 한국 시각 '2026.11.05 15:46'. 시간대 없는 값(반영 기록 등 이미 KST)은 그대로
  const kstAt = a => { const v = String(a || ''); const t = /T.*(Z|[+-]\d\d:?\d\d)$/.test(v) && new Date(v);
    const k = t && !isNaN(t) ? new Date(t.getTime() + 9 * 3600e3).toISOString() : v; return k.slice(0, 16).replace('T', ' ').replace(/-/g, '.'); };
  // 체크 일시(서버 UTC ISO) → '10.30 14:05'(한국 시각). 일시가 없던 예전 기록은 날짜만
  const whenLabel = (iso, day) => { const t = iso && new Date(iso); if (!t || isNaN(t)) return day ? day.slice(5).replace('-', '.') : '';
    const k = new Date(t.getTime() + 9 * 3600e3).toISOString(); return `${k.slice(5, 7)}.${k.slice(8, 10)} ${k.slice(11, 16)}`; };
  const markLabel = (r, k) => [(r.teacherName || [])[k], whenLabel((r.teacherWhen || [])[k], r.teacherAt[k])].filter(Boolean).join(' · ');

  let shownView = null, keepFocus = null, pickBranch = null;  // pickBranch: 지점을 고른 뒤 역할을 고르기 전
  let returnView = 'home';  // 항목 화면의 꺽쇠가 돌아갈 화면
  let homeScroll = null;  // 홈을 떠날 때의 {단계 탭, 스크롤 위치}. 항목에 들어갔다 뒤로 오면 그 자리로 돌아간다.
  let lastStep = null;    // 마지막으로 본 항목(저장된 위치가 없을 때 목록에서 그 항목을 보여 준다)  // 마지막으로 그린 화면(같은 화면 다시 그리기와 이동을 구분)
  let content = null, cloud = null, view = 'branch', busy = false, toastTimer = null, stageSel = null;
  const feedbackDrafts = new Map();
  let ceMode = false, ceEdit = null, ceTimer = null;  // ceMode: ⋮ › 문구 수정 모드(관리자). 항목 화면을 벗어나면 끝난다  // 11/10 교육 문구 직접 수정(관리자): 고치는 중인 줄 하나
  let noticeBusy = false;

  function toast(message) {
    const el = $('v1Toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // 다른 탭·앱 창에서 다시 로그인하면 세션이 새로 바뀌어, 이 화면이 가진 CSRF 토큰이 맞지 않게 된다.
  // 그때(403 code=csrf)는 지금 세션의 토큰을 다시 받아 한 번만 다시 보낸다(같은 requestId 라 두 번 저장되지 않는다).
  async function refreshCsrf() {
    const status = await fetch('/api/auth/status', {credentials: 'same-origin', cache: 'no-store'}).then(r => r.json());
    if (!status.user || !status.csrfToken) return false;
    if (cloud && cloud.user && status.user.id !== cloud.user.id) { location.reload(); return false; }  // 다른 계정으로 바뀌었으면 화면을 새로
    ERPAuth.csrfToken = status.csrfToken; return true;
  }
  async function api(method, value, target, retried) {
    const url = '/api/onboarding' + (target ? '?target=' + encodeURIComponent(target) : '');
    const response = await fetch(url, {method, credentials: 'same-origin', cache: 'no-store',
      headers: {'Content-Type': 'application/json', 'X-CSRF-Token': ERPAuth.csrfToken || ''},
      ...(value ? {body: JSON.stringify(value)} : {})});
    let data; try { data = await response.json(); } catch { throw new Error('서버 응답을 확인하지 못했습니다.'); }
    if (response.status === 403 && data.code === 'csrf' && !retried) {
      let ok = false; try { ok = await refreshCsrf(); } catch {}
      if (ok) return api(method, value, target, true);
    }
    if (!response.ok) { const e = new Error(data.error || data.message || '저장하지 못했습니다.'); e.status = response.status; e.code = data.code; throw e; }
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
    if (!r.teacherWhen) r.teacherWhen = Array(n).fill(null);
    const before = {teacher: r.teacher[k], at: r.teacherAt[k], name: r.teacherName[k], when: r.teacherWhen[k], status: r.status}, who = cloud.target;
    r.teacher[k] = on; r.teacherAt[k] = on ? cloud.today : null; r.teacherName[k] = on ? cloud.user.name : null; r.teacherWhen[k] = on ? new Date().toISOString() : null;
    r.status = r.teacher.some(Boolean) ? 'practice' : 'ready';
    const box = $('app').querySelector(`[data-mark="${k}"]`);
    if (box) box.closest('li').classList.toggle('on', on);
    const by = $('app').querySelector(`[data-by="${k}"]`);
    if (by) by.textContent = on ? markLabel(r, k) : '';
    const pill = $('app').querySelector('.v1-pill');
    if (pill) { pill.className = 'v1-pill ' + r.status; pill.textContent = STATUS[r.status]; }
    const close = $('app').querySelector('[data-close]');
    if (close) close.disabled = !checkItems(step).every((_, i) => r.teacher[i]);
    selfPending++;
    selfQueue = selfQueue.then(async () => {
      try {
        const fresh = await api('POST', {action: 'step.mark', target: cloud.target, revision: cloud.learner.revision, rootRevision: cloud.rootRevision,
          requestId: uid(), data: {step: step.id, index: k, on}});
        if (fresh.target === cloud.target) { const mine = record(step.id); cloud = fresh; Object.assign(record(step.id), {teacher: mine.teacher.slice(), teacherAt: mine.teacherAt.slice(), teacherName: mine.teacherName.slice(), teacherWhen: mine.teacherWhen.slice(), status: mine.status}); }
      } catch (e) {
        toast(e.message || '체크를 저장하지 못했어요. 다시 눌러 주세요.');
        // 화면에서 먼저 바꾼 값을 되돌린 뒤 서버 기록으로 다시 맞춘다(권한이 없어져 기록을 못 읽어도 화면이 저장된 것처럼 남지 않게)
        if (cloud.target === who) { const x = record(step.id); x.teacher[k] = before.teacher; x.teacherAt[k] = before.at; x.teacherName[k] = before.name; x.teacherWhen[k] = before.when; x.status = before.status; }
        try { cloud = await api('GET', null, cloud.target); } catch (e2) { if (e2.status === 403) { try { cloud = await api('GET'); view = 'home'; } catch {} } }
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
  // >>> content-edit-check (11/10 교육 문구 직접 수정 — 입력하는 동안 아래 '수정 필요'. content_edit.py 와 같은 규칙, content_edit_cases.json 으로 함께 테스트)
  // 남기는 규칙은 7개(빈 문구·같은 문구·길이·줄바꿈·태그/링크/이모지·같은 줄 반영 대기·근거 원문에 없는 수치). 변경 종류 = 수치가 바뀌었는지로 자동 추천
  const ContentEdit = (() => {
    const LIMIT = {purpose: 120, kp: 200}, BREAKS = {purpose: 0, kp: 1};
    const UNIT = '(?:kg|g|mL|ml|L|ℓ|℃|°C|cm|mm|%|시간|분|초|잔|배치|통|샷|개월|개|일|장|병|회|번|명|층|동|팩|봉|스푼|펌프|주|년|원)';
    const NUM = new RegExp('\\d[\\d.]*(?:~\\d[\\d.]*)?' + UNIT, 'g');
    const MARKUP = /<[^>]*>|https?:\/\/|www\.|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    const norm = s => String(s ?? '').replace(/\r\n/g, '\n').replace(/(\d),(?=\d{3}(?!\d))/g, '$1').replace(/(\d)\s*[~\-–]\s*(?=\d)/g, '$1~').replace(/(\d)[ \t]+(?=[^\d\s])/g, '$1');
    const numbers = s => [...new Set(norm(s).match(NUM) || [])];
    const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const has = (text, token) => new RegExp('(?<![\\d.])' + reEsc(token)).test(text);
    const sectionText = sec => [...(sec.paragraphs || []), ...(sec.tables || []).map(t => [t.header || [], ...(t.rows || [])].flat().join('\t'))].join('\n');
    function check(part, asis, tobe, cited, others = [], openReq = null) {
      const items = [], add = (code, text) => items.push({level: 'block', code, text});
      const a = String(asis ?? '').replace(/\r\n/g, '\n').trim(), t = String(tobe ?? '').replace(/\r\n/g, '\n').trim(), src = norm(cited.join('\n'));
      if (openReq) add('open', `이 줄은 ${openReq} 로 이미 반영 대기 중이에요. 배포 뒤 다시 고쳐 주세요.`);
      if (!t) add('empty', '바꿀 문구를 적어 주세요.'); else if (t === a) add('same', '지금 문구와 같아요.');
      const len = [...t].length;
      if (len > LIMIT[part]) add('length', `${LIMIT[part]}자까지 쓸 수 있어요. (지금 ${len}자)`);
      if (t.split('\n').length - 1 > BREAKS[part]) add('breaks', part === 'purpose' ? '교육 목적은 줄바꿈 없이 써 주세요.' : '줄바꿈은 한 번까지 쓸 수 있어요.');
      if (MARKUP.test(t)) add('markup', '태그·링크·이모지는 쓸 수 없어요.');
      const numsA = numbers(a), numsT = numbers(t);
      for (const n of numsT) {
        if (has(src, n) || numsA.includes(n)) continue;  // 원래 문구에 있던 값(근거 밖)은 이번 수정의 책임이 아니다
        const where = [...new Set(others.filter(([, text]) => has(norm(text), n)).map(([label]) => label))].slice(0, 2);
        add('number', `근거 원문에 없는 수치: '${n}'` + (where.length ? ` (${where.join(' · ')}에 있음 — 근거를 바꾸려면 '원본 매핑 변경' 요청)` : ''));
      }
      const changed = [...numsT.filter(x => !numsA.includes(x)), ...numsA.filter(x => !numsT.includes(x))];
      return {items, suggest: t && changed.length ? '재확인 필요' : '단순 수정'};
    }
    return {check, sectionText, numbers, LIMIT};
  })();
  // <<< content-edit-check
  // 11/10 교육 문구 직접 수정 — 화면 쪽(관리자만). 보내면 '문구 수정' 티켓(REQ-n)이 되고, 서비스 문구는 검토 → 커밋 뒤에만 바뀐다.
  const ceKeys = (s, part, index) => part === 'purpose' ? [...new Set((s.keyPoints || []).flatMap(k => k.cites || []))] : [...new Set((s.keyPoints[index] || {}).cites || [])];
  const ceOpen = (stepId, part, index) => (cloud.contentRequests || []).find(r => r.status === '진행중' && r.edit && r.target && r.target.id === stepId && r.edit.part === part && (r.edit.index ?? null) === (index ?? null));
  function ceRun() {
    const s = steps().find(x => x.id === ceEdit.step), keys = ceKeys(s, ceEdit.part, ceEdit.index), set = new Set(keys);
    const docs = new Set(keys.map(k => (content.sections[k] || {}).doc));
    const label = k => { const sec = content.sections[k], doc = content.documents[sec.doc] || {}; return `${docs.has(sec.doc) ? '같은 문서' : (doc.title || '')} ${sec.no || ''} ${sec.title || ''}`.trim(); };
    const cited = keys.filter(k => content.sections[k]).map(k => ContentEdit.sectionText(content.sections[k]));
    const others = Object.keys(content.sections).filter(k => !set.has(k)).map(k => [label(k), ContentEdit.sectionText(content.sections[k])]);
    return ContentEdit.check(ceEdit.part, ceEdit.asis, ceEdit.text, cited, others);
  }
  const CE_X = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  // 근거 원문(오른쪽 칸): 지금 고친 문구에 나오는 수치·원래 문구에서 빠진 수치를 원문에서 표시한다
  function ceSource(keys, marks) {
    const tokens = [...new Set(marks)].filter(Boolean).sort((a, b) => b.length - a.length);
    const re = tokens.length ? new RegExp(tokens.map(t => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/~/g, '\\s*[~\\-–]\\s*')).join('|'), 'g') : null;
    const mark = s => { const h = esc(s); return re ? h.replace(re, m => `<mark>${m}</mark>`) : h; };
    return keys.map(k => {
      const sec = content.sections[k]; if (!sec) return '';
      const doc = content.documents[sec.doc] || {};
      const tables = (sec.tables || []).map(t => `<div class="table-wrap"><table><thead><tr>${(t.header || []).map(h => `<th>${mark(h)}</th>`).join('')}</tr></thead><tbody>${(t.rows || []).map(r =>
        `<tr>${r.map(c => `<td>${mark(c).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`).join('');
      return `<section class="v1-ce-sec"><p class="v1-ce-doc">${esc(doc.title || '')}</p><h4>${esc(sec.no)} ${esc(sec.title)}${sec.partLabel ? ' · ' + esc(sec.partLabel) : ''}</h4>` +
        (sec.paragraphs || []).map(p => `<p>${mark(p).replace(/\n/g, '<br>')}</p>`).join('') + tables + '</section>';
    }).join('') || '<p class="v1-muted">연결된 근거 원문이 없어요.</p>';
  }
  const ceNums = s => ContentEdit.numbers(s);
  const ceDlg = () => $('v1Ce');
  function ceRefresh() {
    const box = ceDlg(); if (box.hidden || !ceEdit) return;
    const r = ceRun(), blocked = r.items.some(i => i.level === 'block'), t = ceEdit.text.trim(), untouched = t === ceEdit.asis;
    const n = [...t].length, max = ContentEdit.LIMIT[ceEdit.part];
    box.querySelector('[data-ce-count]').textContent = `${n} / ${max}`;
    box.querySelector('[data-ce-text]').classList.toggle('error', !untouched && blocked);
    // 11/10: 검사에 걸리면 수정 문구 칸 아래 빨간 글씨(WDS Input error: 테두리 border-error · helper text text-error), 통과하면 아무것도 보이지 않음
    const err = untouched ? [] : r.items.map(i => i.text), help = box.querySelector('[data-ce-err]');
    help.innerHTML = err.map(x => `<span>${esc(x)}</span>`).join(''); help.hidden = !err.length;
    box.querySelector('[data-ce-text]').setAttribute('aria-invalid', String(Boolean(err.length)));
    box.querySelector('[data-ce-send]').disabled = busy || untouched || blocked || !ceEdit.reason.trim();
    const s = steps().find(x => x.id === ceEdit.step);
    const na = ceNums(ceEdit.asis), nt = ceNums(t), changed = untouched ? [] : [...na.filter(x => !nt.includes(x)), ...nt.filter(x => !na.includes(x))];  // 바뀐 수치만 원문에서 표시
    box.querySelector('[data-ce-src]').innerHTML = ceSource(ceKeys(s, ceEdit.part, ceEdit.index), changed);
  }
  // WDS Modal dialog(xxl): 왼쪽 = 고치기, 오른쪽 = 근거 원문. 좁은 화면은 전체 화면 + Tab(고치기 / 근거 원문)
  function ceShow() {
    const e = ceEdit, s = steps().find(x => x.id === e.step), title = e.part === 'purpose' ? '교육 목적 수정' : `교육 내용 ${e.index + 1} 수정`;
    const box = ceDlg(), panel = box.querySelector('.v1-ce-panel');
    panel.innerHTML = `<div class="v1-ce-top"><div><h2 id="v1CeTitle">${title}</h2><p class="v1-ce-meta">${stepIndex(s.id) + 1}. ${esc(s.title)}</p></div>` +
      `<button type="button" class="v1-icon-btn v1-ce-x" data-ce-close aria-label="닫기">${CE_X}</button></div>` +
      `<div class="v1-ce-tabs" role="tablist"><button type="button" role="tab" data-ce-tab="edit" aria-selected="true">고치기</button><button type="button" role="tab" data-ce-tab="src" aria-selected="false">근거 원문</button></div>` +
      `<div class="v1-ce-body" data-ce-pane="edit"><div class="v1-ce-edit">` +
        `<p class="v1-ce-label">현재 문구</p><p class="v1-ce-now">${esc(e.asis).replace(/\n/g, '<br>')}</p>` +
        `<label class="v1-ce-label" for="v1CeText">수정 문구</label><textarea id="v1CeText" class="v1-ce-input" data-ce-text rows="4" aria-describedby="v1CeErr">${esc(e.text)}</textarea>` +
        `<div class="v1-ce-helprow"><p class="v1-ce-err" id="v1CeErr" data-ce-err aria-live="polite" hidden></p><p class="v1-ce-count" data-ce-count></p></div>` +
        `<label class="v1-ce-label" for="v1CeReason">수정 사유</label><input id="v1CeReason" class="v1-ce-input v1-ce-one" data-ce-reason maxlength="300" placeholder="반영 기록에 함께 남아요" value="${esc(e.reason)}">` +
      `</div><div class="v1-ce-src" data-ce-src></div></div>` +
      `<div class="v1-ce-foot"><p class="v1-ce-help v1-ce-note">수정하면 '반영 대기'로 저장되고, 다음 배포 때 서비스 문구가 바뀌어요.</p>` +
      `<div class="v1-ce-btns"><button type="button" class="v1-btn" data-ce-close>취소</button><button type="button" class="v1-btn primary" data-ce-send>수정하기</button></div></div>` +
      `<div class="v1-ce-confirm" data-ce-confirm hidden><div class="v1-ce-confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="v1CeAsk"><h3 id="v1CeAsk">고치던 내용을 버릴까요?</h3><p>지금 닫으면 고친 문구와 수정 이유가 사라져요.</p>` +
        `<div class="v1-ce-btns"><button type="button" class="v1-btn" data-ce-keep>계속 고치기</button><button type="button" class="v1-btn v1-btn-danger" data-ce-drop>버리기</button></div></div></div>`;
    box.hidden = false; document.body.classList.add('v1-noscroll');
    ceRefresh();
    const ta = box.querySelector('[data-ce-text]'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  function ceHide(force) {
    if (!ceEdit) return;
    const dirty = ceEdit.text.trim() !== ceEdit.asis || ceEdit.reason.trim();
    if (dirty && !force) { const c = ceDlg().querySelector('[data-ce-confirm]'); c.hidden = false; c.querySelector('[data-ce-keep]').focus(); return; }
    const back = ceEdit.from; ceEdit = null; ceDlg().hidden = true; document.body.classList.remove('v1-noscroll');
    const el = back && $('app').querySelector(back); if (el) el.focus({preventScroll: true});
  }
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
  // 10/30: 관리자(admin·멘토)는 교육을 듣지 않는다. 관리자의 '교육 과정' = 기록 없이 둘러보기(상태·체크 없음)
  // 11/02: 멘토·멘티 관계 없음. 다른 사람 교육(체크 가능) / 내 교육(보기만)
  const mentee = () => cloud.target !== cloud.user.id;
  const mayConfirm = () => Boolean(cloud.permissions.trainer);
  const others = () => cloud.roster.filter(r => r.id !== cloud.user.id && r.join);

  // --- 홈 목록 필터(근무조·포지션, 모모스 분류표). 같은 86개 목록을 좁혀 볼 뿐 기록은 하나다.
  // 고른 값은 이 기기에만 기억한다(localStorage). 교육 화면에는 아무것도 더하지 않는다.
  const FILTER_KEY = 'v1.filter', FKIND = {shift: '근무조', position: '포지션'};
  // 필터는 '전체 교육' 보기 안에서만 유지(거기서 들어간 항목 포함). 다른 화면으로 벗어나면 초기화한다(멘토·멘티 모두, 저장하지 않음)
  let filt = null, sheetPick = null;
  let sheetMode = 'filter';

  // --- 11/02 주소록(조직도): WORKS 부서 목록. 첫 화면은 내 주 부서, 부서를 고르면 그 부서에 직접 속한 사람(주 부서 기준)
  const NOORG = '__none';  // 주소록에서 부서를 찾지 못한 사람
  let orgSel = null; const orgOpen = new Set();
  const chart = () => cloud && cloud.orgChart;
  const unitsOf = () => { const c = chart(), ids = new Set(c.units.map(u => u.id));
    const lost = c.members.some(m => !m.org || !ids.has(m.org));
    return lost ? c.units.concat([{id: NOORG, name: '부서 미확인', parent: null, order: 1e9}]) : c.units; };
  const orgOf = id => unitsOf().find(u => u.id === id);
  const membersOf = id => { const ids = new Set(chart().units.map(u => u.id));
    return chart().members.filter(m => id === NOORG ? !m.org || !ids.has(m.org) : m.org === id); };
  const orgPath = id => { const out = []; let u = orgOf(id); while (u && out.length < 20) { out.unshift(u); u = u.parent && orgOf(u.parent); } return out; };
  const childrenOf = id => unitsOf().filter(u => (u.parent || null) === id || (id === null && u.parent && !orgOf(u.parent))).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ko'));
  function drawOrgSheet() {
    const node = u => { const kids = childrenOf(u.id), open = orgOpen.has(u.id), n = membersOf(u.id).filter(m => m.id !== cloud.user.id).length;  // 첫 화면 표와 같게 나는 빼고 센다
      const mine = chart().mine === u.id ? ' <span class="v1-mine">내 부서</span>' : '';
      return `<li><div class="v1-onode"><button type="button" class="v1-otog${kids.length ? '' : ' leaf'}" ${kids.length ? `data-org-tog="${esc(u.id)}" aria-expanded="${open}" aria-label="${esc(u.name)} ${open ? '접기' : '펼치기'}"` : 'tabindex="-1" aria-hidden="true"'}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
        `<button type="button" class="v1-opick${orgSel === u.id ? ' on' : ''}" data-org-pick="${esc(u.id)}"${orgSel === u.id ? ' aria-current="true"' : ''}><span>${esc(u.name)}${mine}</span><small>${n}명</small></button></div>` +
        (kids.length && open ? `<ul>${kids.map(node).join('')}</ul>` : '') + '</li>'; };
    $('v1Sheet').querySelector('.v1-sheet-panel').innerHTML = '<div class="v1-sheet-grab" aria-hidden="true"></div><h2 id="v1SheetTitle">주소록</h2>' +
      '<p class="v1-muted">부서를 누르면 그 부서 구성원의 교육 현황을 볼 수 있어요.</p>' +
      `<ul class="v1-otree">${childrenOf(null).map(node).join('')}</ul>`;
  }
  function openOrgSheet() {
    sheetMode = 'org'; orgPath(orgSel).slice(0, -1).forEach(u => orgOpen.add(u.id));  // 지금 보는 부서까지 펼쳐 둔다
    drawOrgSheet(); $('v1Sheet').hidden = false; document.body.style.overflow = 'hidden';
    const on = $('v1Sheet').querySelector('.v1-opick.on') || $('v1Sheet').querySelector('.v1-opick'); if (on) { on.focus(); on.scrollIntoView({block: 'nearest'}); }
  }
  try { localStorage.removeItem(FILTER_KEY); } catch {}
  const validFilter = f => f && f.k in FKIND && ((content.filters || {})[f.k] || []).includes(f.v) ? {k: f.k, v: f.v} : null;
  const matches = (s, f = filt) => !f || (s[f.k] || []).includes(f.v);
  // '다음 항목 ›': 필터를 걸었으면 그 필터 안의 다음 항목으로(번호는 전체 번호 그대로)
  const nextOf = s => { const f = returnView === 'all' ? validFilter(filt) : null; return steps().slice(stepIndex(s.id) + 1).find(x => matches(x, f)); };
  const prevOf = s => { const f = returnView === 'all' ? validFilter(filt) : null; return steps().slice(0, stepIndex(s.id)).reverse().find(x => matches(x, f)); };
  const stepActions = (s, action = '') => {
    const prev = prevOf(s), next = nextOf(s);
    if (!prev && !next && !action) return '';
    return `<div class="v1-actions v1-step-actions">${action}` +
      (prev ? `<button type="button" class="v1-btn v1-step-prev" data-step="${esc(prev.id)}">‹ 이전 항목</button>` : '') +
      (next ? `<button type="button" class="v1-btn v1-step-next" data-step="${esc(next.id)}">다음 항목 ›</button>` : '') + '</div>';
  };
  function setFilter(f) {
    filt = f;
    homeScroll = null; lastStep = null; render(); window.scrollTo({top: 0, behavior: 'instant'});
  }
  function drawSheet() {
    const live = steps().filter(s => !planned(s)), n = f => live.filter(s => matches(s, f)).length;
    const on = f => sheetPick ? f && sheetPick.k === f.k && sheetPick.v === f.v : !f;
    const chip = f => `<button type="button" class="v1-fchip${on(f) ? ' on' : ''}" aria-pressed="${on(f)}" data-pick="${f ? esc(f.k + '|' + f.v) : ''}">${esc(f ? f.v : '전체')} <small>${n(f)}</small></button>`;
    const group = k => ((content.filters || {})[k] || []).length ? `<h3>${FKIND[k]}</h3><div class="v1-fwrap">${content.filters[k].map(v => chip({k, v})).join('')}</div>` : '';
    $('v1Sheet').querySelector('.v1-sheet-panel').innerHTML = '<div class="v1-sheet-grab" aria-hidden="true"></div><h2 id="v1SheetTitle">보기 필터</h2>' +
      '<p class="v1-muted">근무조나 포지션을 고르면 해당 교육만 볼 수 있습니다.</p>' +
      `<div class="v1-fwrap" style="margin-top:var(--spacing-16)">${chip(null)}</div>${group('shift')}${group('position')}` +
      `<div class="v1-actions"><button type="button" class="v1-btn primary" data-sheet-apply>${n(sheetPick)}개 보기</button></div>`;
  }
  function openSheet() { sheetMode = 'filter'; sheetPick = filt; drawSheet(); $('v1Sheet').hidden = false; document.body.style.overflow = 'hidden'; $('v1Sheet').querySelector('[data-sheet-apply]').focus(); }
  function closeSheet() { $('v1Sheet').hidden = true; document.body.style.overflow = ''; const b = sheetMode === 'org' ? $('app').querySelector('[data-org-open]') : $('app').querySelector('[data-filter-open]'); if (b && !b.hidden) b.focus({preventScroll: true}); }
  $('v1Sheet').addEventListener('click', e => {
    const o = e.target.closest('[data-org-tog],[data-org-pick]');
    if (o) {
      if (o.hasAttribute('data-org-tog')) { const id = o.dataset.orgTog; orgOpen.has(id) ? orgOpen.delete(id) : orgOpen.add(id); drawOrgSheet(); $('v1Sheet').querySelector(`[data-org-tog="${CSS.escape(id)}"]`).focus(); }
      else { orgSel = o.dataset.orgPick; homeTab = 'org'; closeSheet(); view = 'home'; render(); window.scrollTo({top: 0, behavior: 'instant'}); }
      return;
    }
    const t = e.target.closest('[data-pick],[data-sheet-apply],[data-sheet-close]');
    if (!t) return;
    if (t.hasAttribute('data-pick')) { const [k, v] = t.dataset.pick.split('|'); sheetPick = t.dataset.pick ? {k, v} : null; drawSheet(); }
    else if (t.hasAttribute('data-sheet-apply')) { closeSheet(); setFilter(sheetPick); }
    else closeSheet();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('v1Sheet').hidden) closeSheet(); });

  // --- 11/02 교육 검색(위쪽 바 돋보기): 교육 제목·교육 목적·교육 내용(체크 목록 포함)에서 찾는다. 근거 본문은 찾지 않는다.
  // 띄어쓰기·대소문자 무시, 여러 단어는 모두 들어간 교육만. 순서: 제목에서 찾음 → 목적 → 내용. 근무조·포지션 필터는 적용하지 않는다(86개 전체).
  // 결과를 누르면: 다른 사람의 교육을 보던 중이면 그 사람의 교육, 그 밖(교육 현황·LMS관리자 등)에서는 내 교육. 내용에서 찾았으면 그 항목까지 내려가 잠깐 강조
  const norm = t => String(t || '').toLowerCase().replace(/\s+/g, '');
  const reEsc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function findSteps(q) {
    const words = String(q || '').trim().split(/\s+/).filter(Boolean), ws = words.map(norm);
    if (!ws.length) return {words, list: []};
    const list = [];
    liveSteps().forEach(s => {
      const purpose = s.purpose || (s.copy || []).join(' '), items = checkItems(s).map(k => k.text);
      const fields = [['title', s.title], ['purpose', purpose], ...items.map((t, i) => ['item', t, i])];
      if (!ws.every(w => norm(fields.map(f => f[1]).join(' ')).includes(w))) return;
      // 보여 줄 줄: 검색어가 가장 많이 들어간 칸(같으면 제목 → 목적 → 내용 순)
      const score = f => ws.filter(w => norm(f[1]).includes(w)).length, best = Math.max(...fields.map(score)), hit = fields.find(f => score(f) === best);
      list.push({s, rank: {title: 0, purpose: 1, item: 2}[hit[0]], field: hit[0], text: hit[1], kp: hit[0] === 'item' ? hit[2] : null});
    });
    list.sort((a, b) => a.rank - b.rank || stepIndex(a.s.id) - stepIndex(b.s.id));
    return {words, list};
  }
  const mark = (text, words) => { let out = esc(text).replace(/\n/g, ' ');
    const ok = words.filter(w => w.length).map(w => reEsc(esc(w))); return ok.length ? out.replace(new RegExp(`(${ok.join('|')})`, 'gi'), '<em>$1</em>') : out; };
  function drawSearch() {
    const {words, list} = findSteps($('v1SearchInput').value), box = $('v1SearchList');
    if (!words.length) { box.innerHTML = '<p class="v1-muted">교육 제목·교육 목적·교육 내용에서 찾아요.</p>'; return; }
    if (!list.length) { box.innerHTML = '<p class="v1-muted">찾는 교육이 없어요. 다른 낱말로 찾아보세요.</p>'; return; }
    const LBL = {purpose: '교육 목적', item: '교육 내용'};
    box.innerHTML = `<p class="v1-muted" style="margin:var(--spacing-8) 0;text-align:left">${list.length}개 교육</p>` + list.map(x => { const st = unitOf(x.s.id).stage;
      return `<button type="button" class="v1-sres" data-sres="${esc(x.s.id)}"${x.kp !== null ? ` data-skp="${x.kp}"` : ''}><small>${stepIndex(x.s.id) + 1}번 · ${st.order}. ${esc(st.title)}</small>` +
        `<strong>${mark(x.s.title, words)}</strong>${x.field === 'title' ? '' : `<span><b class="v1-sfield">${LBL[x.field]}</b>${mark(x.text, words)}</span>`}</button>`; }).join('');
  }
  function openSearch() { $('v1Search').hidden = false; document.body.style.overflow = 'hidden'; drawSearch(); $('v1SearchInput').focus(); $('v1SearchInput').select(); }
  function closeSearch(focus = true) { $('v1Search').hidden = true; document.body.style.overflow = ''; if (focus) $('v1Find').focus({preventScroll: true}); }
  $('v1Find').onclick = () => openSearch();
  $('v1SearchInput').addEventListener('input', () => drawSearch());
  $('v1SearchInput').addEventListener('keydown', e => { if (e.key === 'Enter') { const b = $('v1SearchList').querySelector('[data-sres]'); if (b) { e.preventDefault(); b.click(); } } });
  $('v1Search').addEventListener('click', async e => {
    if (e.target.closest('[data-search-close]')) return closeSearch();
    const b = e.target.closest('[data-sres]'); if (!b) return;
    const id = b.dataset.sres, kp = b.dataset.skp;
    const other = cloud.target !== cloud.user.id && (view === 'person' || view === 'all' || view.startsWith('step:'));
    closeSearch(false);
    if (!other && cloud.target !== cloud.user.id) { try { cloud = await api('GET'); } catch (err) { return toast(err.message); } }
    if (!view.startsWith('step:')) returnView = other ? view : (cloud.target === cloud.user.id && (view === 'person' || view === 'all') ? view : view === 'home' || view === 'admin' ? view : 'home');
    view = 'step:' + id; stageSel = unitOf(id).stage.order; render(); window.scrollTo({top: 0, behavior: 'instant'});
    if (kp !== undefined) setTimeout(() => { const li = $('app').querySelector(`[data-kp="${kp}"]`); if (!li) return;
      li.scrollIntoView({block: 'center', behavior: 'smooth'}); li.classList.add('v1-hit'); setTimeout(() => li.classList.remove('v1-hit'), 2400); }, 60);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('v1Search').hidden) closeSearch(); });

  // --- opinion notifications: opening a list never marks every item read.
  // 11/06 알림 = 내가 보낸 의견에 달린 관리자 댓글. 최근 30일 · 최신이 위
  const NOTICE_DAYS = 30;
  const opinionNotices = () => { const from = Date.now() - NOTICE_DAYS * 864e5;
    return (cloud.notifications || []).filter(n => String(n.kind || '').startsWith('feedback.') && Date.parse(n.date) >= from).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)); };
  const kstDay = t => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
  const noticeWhen = iso => { const t = Date.parse(iso); if (isNaN(t)) return ''; const d = kstDay(t), now = Date.now();
    if (d === kstDay(now)) return new Date(t + 9 * 3600e3).toISOString().slice(11, 16);
    if (d === kstDay(now - 864e5)) return '어제';
    return `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`; };
  function drawNotices() {
    const items = opinionNotices(), unread = items.filter(n => !n.read).length;
    $('v1NoticeCount').hidden = !unread; $('v1NoticeCount').textContent = unread > 99 ? '99+' : unread;
    $('v1NoticeToggle').setAttribute('aria-label', `알림 · 읽지 않은 알림 ${unread}개`);
    if ($('v1Notices').hidden) return;
    $('v1NoticeList').innerHTML = items.length
      ? items.map(n => `<button type="button" class="v1-nb ${n.read ? 'read' : 'unread'}" data-open-notice="${esc(n.id)}" ${noticeBusy ? 'disabled' : ''}>` +
          `<span class="v1-nb-head"><span>의견 댓글</span><time datetime="${esc(n.date)}">${esc(noticeWhen(n.date))}</time></span>` +
          `<span class="v1-nb-title">${esc(steps().some(x => x.id === n.step) ? `${stepIndex(n.step) + 1}. ${n.detail}` : n.detail || n.title)}</span>` +
          `<span class="v1-nb-text">${esc(n.text || n.title)}</span>` +
          (n.by ? `<span class="v1-nb-by">by ${esc(n.by)}</span>` : '') + '</button>').join('') +
        `<p class="v1-notices-end">최근 ${NOTICE_DAYS}일간 받은 알림을 모두 확인했습니다.</p>`
      : '<p class="v1-notices-empty">최근 받은 알림이 없습니다.</p>';
  }
  function closeNotices(focus = true) {
    $('v1Notices').hidden = true; $('v1NoticeToggle').setAttribute('aria-expanded', 'false'); document.body.style.overflow = '';
    if (focus) $('v1NoticeToggle').focus({preventScroll: true});
  }
  async function openNotice(id) {
    if (noticeBusy || busy) return;
    const notice = opinionNotices().find(n => n.id === id); if (!notice) return;
    noticeBusy = true; drawNotices();
    try {
      // Switch back to the signed-in author's context, even when viewing another learner.
      const fresh = notice.read ? await api('GET') : await api('POST', {action: 'notification.read', target: cloud.user.id,
        revision: cloud.learner.revision, rootRevision: cloud.rootRevision, requestId: uid(), data: {ids: [id]}});
      cloud = fresh; closeNotices(false);
      openFb(notice.feedback); if (notice.comment) $('app').querySelector(`[data-comment-id="${CSS.escape(notice.comment)}"]`)?.scrollIntoView({block: 'center', behavior: 'instant'});
    } catch (e) { toast(e.message || '알림을 열지 못했어요. 다시 눌러 주세요.'); }
    finally { noticeBusy = false; drawNotices(); }
  }
  $('v1NoticeToggle').onclick = () => {
    if (!$('v1Notices').hidden) return closeNotices();
    closeSearch(false); closeNav(); closeMenu(); closeMe(); $('v1Sheet').hidden = true;
    const bell = $('v1NoticeToggle').getBoundingClientRect(), top = document.querySelector('.v1-top').getBoundingClientRect().bottom;
    $('v1Notices').style.setProperty('--v1-notice-top', Math.round(top + 4) + 'px');
    $('v1Notices').style.setProperty('--v1-notice-right', Math.max(8, Math.round(window.innerWidth - bell.right)) + 'px');
    $('v1Notices').hidden = false; $('v1NoticeToggle').setAttribute('aria-expanded', 'true');
    if (window.matchMedia('(max-width: 719px)').matches) document.body.style.overflow = 'hidden';  // 모바일만 뒤 화면 스크롤을 막는다
    drawNotices(); $('v1NoticeList').scrollTop = 0; ($('v1NoticeList').querySelector('button') || $('v1NoticeList')).focus({preventScroll: true});
  };
  $('v1Notices').addEventListener('click', e => {
    if (e.target.closest('[data-notices-close]')) return closeNotices();
    const button = e.target.closest('[data-open-notice]');
    if (button) openNotice(button.dataset.openNotice);
  });
  document.addEventListener('keydown', e => {
    if ($('v1Notices').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeNotices(); }
    if (e.key === 'Tab') {
      const buttons = [...$('v1Notices').querySelectorAll('button:not([disabled])')], first = buttons[0], last = buttons[buttons.length - 1];
      if (!buttons.length) { e.preventDefault(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // --- rendering
  function render() {
    if (!cloud || !content) return;
    const step = view.startsWith('step:') ? steps()[stepIndex(view.slice(5))] : null;
    if (ceEdit && !(step && step.id === ceEdit.step)) ceHide(true);  // 다른 화면으로 가면 고치던 것은 버린다
    if (!step) ceMode = false;
    const branch = view === 'branch';
    if (view !== 'all' && !(step && returnView === 'all')) filt = null;  // 전체 교육을 벗어나면 필터 초기화
    // 처음: 지점 선택 → 역할 선택 → 홈. 저장된 뒤에는 홈이 첫 화면이고, 지점·역할은 우상단 ⋮ 에서 바꾼다.
    // 꺽쇠: 항목 → 홈, 역할 → 지점, (바꾸는 중인) 지점 → 홈. 처음 지점 화면에서는 숨긴다.
    // 꺽쇠: 항목 → 들어온 화면(진행 현황·교육생·교육 단계), 교육생 진행 → 교육생 목록, 역할 → 지점, (바꾸는 중인) 지점 → 홈.
    // 꺽쇠가 없는 화면(홈·교육 단계)에는 왼쪽 메뉴(☰)
    const backTo = step ? returnView : view.startsWith('fb:') ? 'opinions' : view.startsWith('log:') || view.startsWith('req:') ? 'admin' : (view === 'person' || view === 'all') && cloud.target !== cloud.user.id ? 'home' : view === 'branch' && profile() ? 'home' : null;
    $('v1Back').hidden = !backTo;
    $('v1Back').dataset.to = backTo || '';
    $('v1Back').setAttribute('aria-label', backTo === 'branch' ? '지점 선택으로' : backTo === 'home' && (view === 'person' || view === 'all') ? '교육 현황으로' : '이전 화면으로');
    $('v1Ham').hidden = Boolean(backTo) || branch || !profile();
    $('v1Title').textContent = step ? step.title : view === 'home' ? '교육 현황' : view === 'person' || view === 'all' ? (cloud.target === cloud.user.id ? '내 교육' : cloud.name + '님') : view === 'stage' ? '교육 단계' : view === 'admin' ? 'LMS관리자' : view === 'opinions' ? '의견 리스트' : view.startsWith('log:') ? '반영 기록' : view.startsWith('req:') ? '수정 요청' : view.startsWith('fb:') ? '의견' : '모모스 온보딩';
    const stg = step && unitOf(step.id).stage;  // 항목 화면: 제목 위에 '1. 입사·현장 적응'
    $('v1Stage').hidden = !stg;
    $('v1Stage').textContent = stg ? `${stg.order}. ${stg.title}` : '';
    if ($('v1Who').dataset.id !== cloud.user.id) {  // 사람이 바뀔 때만 다시 그린다(사진을 매번 다시 받지 않게)
      $('v1Who').dataset.id = cloud.user.id; $('v1Who').innerHTML = avatarInner(cloud.user);
      $('v1Who').setAttribute('aria-label', cloud.user.name + ' 님 — 계정 메뉴'); $('v1Who').title = cloud.user.name + ' 님';
      $('v1MeName').textContent = cloud.user.name + ' 님'; $('v1MeMail').textContent = cloud.user.email || '';
    }
    $('v1Me').hidden = branch && !profile();
    $('v1Find').hidden = branch || !profile();
    $('v1NoticeToggle').hidden = branch || !profile();
    drawNotices();
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
    app.innerHTML = view === 'admin' ? adminView() : view === 'opinions' ? opinionsView() : view.startsWith('log:') ? logView(view.slice(4)) : view.startsWith('req:') ? reqView(view.slice(4)) : view.startsWith('fb:') ? fbView(view.slice(3)) : view === 'branch' ? branchView() : step ? stepView(step) : view === 'stage' ? stageView() : view === 'all' ? stageView(true) : view === 'person' ? progressView() : homeView();
    bind(step);
    if (ceEdit) ceRefresh();
    const lbar = app.querySelector('.v1-learner-bar');  // 고정 위치 = 상단바 바로 아래(항목 화면은 상단바가 두 줄이라 높이를 잰다)
    if (lbar) lbar.style.top = document.querySelector('.v1-top').offsetHeight + 'px';
    const mbar = app.querySelector('.v1-ce-modebar');  // 11/10 문구 수정 모드 띠: 스크롤해도 상단바(+교육생 띠) 바로 아래에 고정
    if (mbar) mbar.style.top = document.querySelector('.v1-top').offsetHeight + (lbar ? lbar.offsetHeight : 0) + 'px';
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

  // --- 진행 현황(홈). 교육생: 내 86개 교육 상태를 단계별 칸으로. 관리자: 교육생마다 한 줄(완료·진행 중·시작 전 비중) → 누르면 그 사람 칸.
  // 일정과 무관하게 각 교육의 상태만 본다(순서 없이 듣거나, 체크를 다 안 하고 나온 것도 그대로). 진행 중 칸은 체크한 만큼 아래에서 채운다.
  const liveSteps = () => steps().filter(s => !planned(s));
  const stateOf = st => st === 'done' ? 'done' : st === 'practice' || st === 'review' ? 'prog' : 'none';
  const LABEL = {none: '시작 전', prog: '진행 중', done: '완료'};
  function countsOf(get, list = liveSteps()) { const c = {none: 0, prog: 0, done: 0}; list.forEach(s => c[stateOf(get(s))]++); return c; }
  const ratioBar = (c, cls = '') => { const n = c.none + c.prog + c.done || 1;
    return `<span class="v1-pbar ${cls}" aria-hidden="true"><i class="done" style="width:${c.done / n * 100}%"></i><i class="prog" style="width:${c.prog / n * 100}%"></i></span>`; };
  // 완료·진행 중·시작 전 숫자 + 비중 막대(멘티의 진행 현황·전체 교육 보기 위쪽에 같은 모양으로)
  // 11/02 진행 현황 위쪽: '시작일 ~ 목표일' 한 줄 → 완료·진행 중·시작 전 숫자 → 완료율(완료 ÷ 전체)·목표율(시작일~목표일 중 오늘까지 지난 비율) 두 막대
  const datesOf = id => id === cloud.user.id ? (cloud.myDates || {}) : ((cloud.educationSummary || []).find(x => x.id === id) || {});
  const dayNo = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
  const goalRate = (from, to, now) => !from || !to || !now || dayNo(to) <= dayNo(from) ? null : Math.max(0, Math.min(100, Math.round((dayNo(now) - dayNo(from)) / (dayNo(to) - dayNo(from)) * 100)));
  const countsBlock = c => { const d = datesOf(cloud.target), n = c.none + c.prog + c.done || 1, done = Math.round(c.done / n * 100);
    const goal = goalRate(d.hiredDate, d.targetDate, cloud.today);
    return `<p class="v1-period">시작일 <b>${esc(d.hiredDate || 'N/A')}</b> ~ 목표일 <b>${esc(d.targetDate || 'N/A')}</b></p>` +
      `<div class="v1-counts"><div><b>${c.done}</b><span><i class="v1-dot done"></i>완료</span></div><div><b>${c.prog}</b><span><i class="v1-dot prog"></i>진행 중</span></div><div><b>${c.none}</b><span><i class="v1-dot none"></i>시작 전</span></div></div>` +
      `<div class="v1-rates"><div class="v1-rate"><span>완료율</span>${ratioBar(c)}<b>${done}%</b></div>` +
      (goal === null ? '' : `<div class="v1-rate"><span>목표율</span><span class="v1-gbar" aria-hidden="true"><i style="width:${goal}%"></i></span><b>${goal}%</b></div>`) + '</div>'; };
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
    return learnerBar() + enrolNotice() + countsBlock(c) + tiles +
      `<p class="v1-muted v1-ptip">칸을 누르면 그 교육으로 이동해요. 진행 중인 칸은 체크한 만큼 채워져요.</p>`;
  }
  // 첫 화면(모든 직원): 맨 위 '내 교육' 줄 + 부서별 구성원 표(교육을 시작한 모든 사람). 누르면 그 사람의 교육
  function homeHtml() {
    const sums = cloud.educationSummary || [], me = cloud.user.id;
    const by = (a, b) => a.name.localeCompare(b.name, 'ko');
    const row = (x, label) => { const c = countsOf(s => (x.states || {})[s.id] || 'ready');
      const meta = [label ? '' : x.position, `시작일: ${x.hiredDate || 'N/A'} · 목표일: ${x.targetDate || 'N/A'}`].filter(Boolean).join(' · ');
      return `<li><button type="button" class="v1-prow-btn" data-person="${esc(x.id)}" data-name="${esc(x.name)}">${avatar(x)}<span class="v1-pbody"><span class="v1-pname"><strong>${esc(label || x.name)}</strong><small class="v1-pdates">${esc(meta)}</small></span>${ratioBar(c)}<small>완료 ${c.done} · 진행 중 ${c.prog} · 시작 전 ${c.none}</small></span><span class="v1-chev">›</span></button></li>`; };
    // 11/02: '내 교육'은 왼쪽 메뉴로 옮겼다
    // 직책순(WORKS 직책 표시 순서, 받지 못하면 직책 이름순, 직책 없음은 맨 뒤) → 같은 직책 안에서는 이름순. 교육 시작·미접속은 섞는다
    const order = (chart() && chart().positions) || [], rank = p => !p ? [2, 0, ''] : order.includes(p) ? [0, order.indexOf(p), ''] : [1, 0, p];
    const byPos = (a, b) => { const x = rank(a.position), y = rank(b.position); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2], 'ko') || by(a, b); };
    // 11/02 교육 현황 = 위쪽 탭 [나의 교육생 | 전체 교육생(부서별)]. 나의 교육생 = 지금 내가 체크해 둔(또는 완료한) 교육이 있는 사람(체크를 풀면 빠진다, 부서 무관)
    const trainees = traineesOf().sort(byPos), tab = homeTabNow();
    if (chart() && (!orgSel || !orgOf(orgSel))) orgSel = chart().mine && orgOf(chart().mine) ? chart().mine : null;
    const segBtn = (k, label) => `<button type="button" role="tab" class="${tab === k ? 'on' : ''}" aria-selected="${tab === k}" data-home-tab="${k}">${label}</button>`;
    const seg = `<div class="v1-hseg" role="tablist" aria-label="교육 현황 보기">${segBtn('mine', `나의 교육생 <b>${trainees.length}</b>`)}${segBtn('org', '전체 교육생')}</div>`;
    if (tab === 'mine') return seg + (trainees.length
      ? `<ul class="v1-plist">${trainees.map(x => row(Object.assign({}, x, {position: [x.position, x.org].filter(Boolean).join(' · ')}))).join('')}</ul>`
      : '<p class="v1-muted v1-hempty">내가 체크한 교육생이 여기에 모여요.<br>전체 교육생 탭에서 구성원을 골라 교육 내용을 체크해 보세요.</p>');
    return seg + orgHtml();
    function orgHtml() {
    // 주소록 버튼: 전체 교육생 탭의 부서 이름 줄 오른쪽(탭 아래 내용이 부서에 따라 바뀌므로 그 자리에서 고른다)
    const orgBtn = `<button type="button" class="v1-org-btn" data-org-open aria-haspopup="dialog"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 3.5h5v4h-5zM2.5 12.5h5v4h-5zM12.5 12.5h5v4h-5zM10 7.5V10M5 12.5V10h10v2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>주소록</button>`;  // wds-allow: 조직도 아이콘 자산 없음, 임시 인라인
    if (chart()) {  // 주소록이 있으면: 고른 부서(처음엔 내 주 부서)에 직접 속한 사람(주 부서 기준)
      if (!orgSel) return `<div class="v1-orghead"><p class="v1-muted">내 부서를 찾지 못했어요. 주소록에서 부서를 골라 주세요.</p>${orgBtn}</div>`;
      const path = orgPath(orgSel), unit = path[path.length - 1];
      const ppl = membersOf(orgSel).filter(m => m.id !== me);
      const list = ppl.map(m => ({m, s: m.id && sums.find(x => x.id === m.id)})).sort((a, b) => byPos(a.m, b.m));
      const offRow = m => `<li class="v1-prow-off"><span class="v1-avatar"><span aria-hidden="true">${esc((m.name || '?').trim().slice(0, 1))}</span></span><span class="v1-pbody"><strong>${esc(m.name)}</strong>${m.position ? ` <small class="v1-pdates">${esc(m.position)}</small>` : ''}</span><span class="v1-off">미접속</span></li>`;
      return `<div class="v1-orghead"><div>${path.length > 1 ? `<small>${path.slice(0, -1).map(u => esc(u.name)).join(' › ')}</small>` : ''}<h2>${esc(unit.name)} <span>· ${ppl.length}명</span></h2></div>${orgBtn}</div>` +
        (ppl.length ? `<ul class="v1-plist">${list.map(({m, s}) => s ? row(Object.assign({}, s, {position: m.position || s.position})) : offRow(m)).join('')}</ul>` : '<p class="v1-muted">이 부서에 직접 속한 구성원이 없어요. 주소록에서 하위 부서를 골라 보세요.</p>');
    }
    const others = sums.filter(x => x.id !== me);
    const groups = {}; others.forEach(x => (groups[x.org || ''] = groups[x.org || ''] || []).push(x));
    const names = Object.keys(groups).sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, 'ko'));
    return names.length ? names.map(g => `<h3 class="v1-pcat">${esc(g || '부서 미확인')} · ${groups[g].length}명</h3><ul class="v1-plist">${groups[g].sort(byPos).map(x => row(x)).join('')}</ul>`).join('')
      : '<p class="v1-muted">아직 교육을 시작한 구성원이 없어요.</p>';
    }
  }

  // 교육 현황 탭: 처음엔 나의 교육생이 있으면 '나의 교육생', 없으면 '부서'. 고른 탭은 화면을 오가도 유지(새로고침하면 다시 처음 규칙)
  let homeTab = null;
  const traineesOf = () => (cloud.educationSummary || []).filter(x => x.trainedByMe && x.id !== cloud.user.id);
  const homeTabNow = () => homeTab || (traineesOf().length ? 'mine' : 'org');

  function enrolNotice() {
    if (canWrite() || mentee()) return '';
    return `<div class="v1-note warn">교육 기록을 아직 시작하지 못했어요. 새로고침해 보세요.</div>`;
  }

  function homeView() { return homeHtml(); }

  const LEVEL_LABEL = {admin: 'admin'};
  // 진행 현황 ↔ 전체 교육(목록·필터) 보기 전환: 오른쪽 위. 다른 사람 교육은 이름 줄 안에, 내 교육은 화면 맨 위 줄에
  const own = () => cloud.target === cloud.user.id;
  const viewSeg = () => { const prog = 'person', list = view === 'all';
    return `<span class="v1-seg" role="group" aria-label="보기 방식"><button type="button" data-mview="${prog}" aria-pressed="${!list}" aria-label="진행 현황" title="진행 현황">${ICON_GRID}</button><button type="button" data-mview="all" aria-pressed="${list}" aria-label="전체 교육" title="전체 교육">${ICON_LIST}</button></span>`; };
  // wds-allow: 보기 전환 아이콘(진행 현황 = 칸 모아보기, 전체 교육 = 목록). WDS 아이콘 자산 반입 전 임시 인라인 SVG
  const ICON_GRID = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="5.5" height="5.5" rx="1.2"/><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.2"/><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.2"/><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.2"/></g></svg>';
  const ICON_LIST = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M7.5 5h9.5M7.5 10h9.5M7.5 15h9.5"/></g><g fill="currentColor"><circle cx="3.8" cy="5" r="1.2"/><circle cx="3.8" cy="10" r="1.2"/><circle cx="3.8" cy="15" r="1.2"/></g></svg>';
  const learnerBar = () => own() ? (view === 'person' || view === 'all' ? `<div class="v1-seg-row">${viewSeg()}</div>` : '')
    : `<div class="v1-learner-bar" role="status">${avatar({id: cloud.target, name: cloud.name})}<span><strong>${esc(cloud.name)}</strong>님의 교육</span>` + (view === 'person' || view === 'all' ? viewSeg() : '') + '</div>';

  // LMS관리자: 관리자 지정(서로 추가·삭제) · 보낸 의견 표
  function adminView() {
    const titleOf = id => { const st = steps().find(x => x.id === id); return st ? `${stepIndex(id) + 1}. ${st.title}` : ''; };
    const me = String(cloud.user.email || '').toLowerCase(), canEdit = cloud.lmsLevel === 'admin';
    const tag = l => `<span class="v1-tag${l === 'admin' ? ' v1-tag-admin' : ''}">${LEVEL_LABEL[l] || l}</span>`;
    // 11/02: LMS관리자 = admin. admin 지정·해제만(기본 admin 과 나는 해제할 수 없다)
    const admins = (cloud.lmsAdmins || []).map(a => `<li><span class="v1-admin-mail">${a.name ? `${esc(a.name)} <span class="v1-muted">(${esc(a.email)})</span>` : esc(a.email)}${a.email === me ? ' <small class="v1-muted">(나)</small>' : ''}</span>` +
      (canEdit && !a.seed && a.email !== me ? `<span class="v1-admin-ctl">${tag('admin')}<button type="button" class="v1-tbtn v1-danger" data-admin-del="${esc(a.email)}">해제</button></span>` : tag('admin')) + '</li>').join('');
    // 11/03: 지정 칸을 제목 바로 아래로(목록이 길어져도 스크롤 없이)
    const adminsHtml = `<section class="v1-card"><h2>admin 지정</h2><p class="v1-muted">admin은 다른 admin을 지정·해제하고 보낸 의견을 볼 수 있어요.</p>` +
      (canEdit ? `<div class="v1-admin-add v1-admin-add-top"><input type="search" class="v1-pop-input" data-admin-email placeholder="이름·이메일 검색" autocomplete="off" enterkeyhint="search" aria-label="추가할 구성원 검색(NAVER WORKS 주소록)" aria-controls="v1AdminResults"><button type="button" class="v1-btn" data-admin-add>지정</button></div><div id="v1AdminResults" class="v1-pop-list v1-admin-results" role="list"></div>` : '') +
      `<ul class="v1-admins">${admins}</ul></section>`;
    // 11/03: admin 지정 · 보낸 의견 · 반영 기록을 탭으로(교육 현황 탭과 같은 모양). 상세에서 돌아와도 고른 탭 유지
    if (adminTab === 'fb') adminTab = 'admins';  // 11/06: 보낸 의견은 LNB '의견 리스트'로 옮겼다
    const tab = adminTab, n = {log: (cloud.sourceLog || []).length, req: (cloud.contentRequests || []).filter(r => r.status === '진행중').length};
    const segBtn = (k, label) => `<button type="button" role="tab" class="${tab === k ? 'on' : ''}" aria-selected="${tab === k}" data-admin-tab="${k}">${label}</button>`;
    return `<div class="v1-hseg" role="tablist" aria-label="LMS관리자 메뉴">${segBtn('admins', 'admin 지정')}${segBtn('req', `수정 요청 <b>${n.req}</b>`)}${segBtn('log', `반영 기록 <b>${n.log}</b>`)}</div>` +
      (tab === 'req' ? reqListCard() : tab === 'log' ? (sourceLogCard() || '<section class="v1-card"><h2>반영 기록</h2><p class="v1-muted">아직 반영 기록이 없어요.</p></section>') : adminsHtml);
  }
  let adminTab = 'admins';
  // 11/06 의견 리스트(LNB): admin 은 모든 의견, 그 밖의 구성원은 내가 보낸 의견. 표 모양은 예전 'LMS관리자 › 보낸 의견' 그대로
  function opinionsView() {
    const titleOf = id => { const st = steps().find(x => x.id === id); return st ? `${stepIndex(id) + 1}. ${st.title}` : ''; };
    const admin = cloud.lmsLevel === 'admin', all = admin ? (cloud.feedback || []) : (cloud.myFeedback || []);
    // 11/09 답변 상태(수정 요청 목록과 같은 모양): 답변중(기본) · 완료 · 전체
    const ff = FB_FILTERS.find(x => x[0] === fbFilter) || FB_FILTERS[1], fbAll = all.filter(ff[2]), fbPage = pageOf('fb', fbAll);
    const chips = FB_FILTERS.map(([k, label, fn]) => `<button type="button" class="v1-fchip${k === ff[0] ? ' on' : ''}" data-fb-filter="${esc(k)}" aria-pressed="${k === ff[0]}">${esc(label)} <b>${all.filter(fn).length}</b></button>`).join('');
    const rows = fbPage.items.map(f => `<tr class="v1-lrow" data-fb="${esc(f.id)}" tabindex="0" role="link" aria-label="${esc(f.name)}님의 의견 상세 보기"><td class="v1-nowrap">${esc(f.name)}</td><td class="v1-nowrap">${esc(kstAt(f.at))}</td><td class="v1-fb-course">${esc(titleOf(f.step) || f.stepTitle || '')}</td><td class="v1-fb-text">${esc(f.text).replace(/\n/g, '<br>')}${(f.comments || []).length || (f.tickets || []).length ? `<span class="v1-fbtags">${(f.tickets || []).map(k => `<span class="v1-lchip b">${esc(k)}</span>`).join('')}${(f.comments || []).length ? `<span class="v1-lchip">댓글 ${f.comments.length}</span>` : ''}</span>` : ''}</td><td class="v1-nowrap v1-fbst"><span class="v1-lst ${FB_ANS[f.answer] || 'b'}">${esc(f.answer || '답변중')}</span>${(f.comments || []).length ? `<span class="v1-fbcm" aria-label="댓글 ${f.comments.length}개">${ICON_CHAT}${f.comments.length}</span>` : ''}</td><td class="v1-chev">›</td></tr>`).join('');
    return `<section class="v1-card"><h2>의견 리스트</h2><p class="v1-muted">${admin ? '교육 › 의견 보내기에서 구성원들이 보내 주신 의견이에요.' : '내가 교육 › 의견 보내기에서 보낸 의견이에요. 댓글이 달리면 알림으로 알려 드려요.'}</p>` +
      `<div class="v1-fbar" role="group" aria-label="답변 상태 필터">${chips}</div>` +
      (rows ? `<div class="v1-table"><table class="v1-llist v1-fblist"><thead><tr><th>보낸사람</th><th>시간</th><th>교육 과정</th><th>${admin ? '의견 · 티켓' : '의견'}</th><th>상태</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${fbPage.nav}` : `<p class="v1-muted">${all.length ? '이 상태의 의견이 없어요.' : '아직 보낸 의견이 없어요.'}</p>`) + '</section>';
  }
  const FB_ANS = {'답변중': 'b', '완료': 'g'};
  const ICON_CHAT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8C13 5.23857 10.7614 3 8 3C5.23857 3 3 5.23857 3 8V13H8C10.7614 13 13 10.7614 13 8ZM14 8C14 11.3137 11.3137 14 8 14H2.52734C2.41089 14 2.26981 13.9607 2.15625 13.8486C2.04197 13.7356 2 13.5923 2 13.4727V8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8Z" fill="currentColor"/><path d="M6.05005 8C6.05005 8.41421 5.71426 8.75 5.30005 8.75C4.88584 8.75 4.55005 8.41421 4.55005 8C4.55005 7.58579 4.88584 7.25 5.30005 7.25C5.71426 7.25 6.05005 7.58579 6.05005 8Z" fill="currentColor"/><path d="M8.75 8C8.75 8.41421 8.41421 8.75 8 8.75C7.58579 8.75 7.25 8.41421 7.25 8C7.25 7.58579 7.58579 7.25 8 7.25C8.41421 7.25 8.75 7.58579 8.75 8Z" fill="currentColor"/><path d="M11.45 8C11.45 8.41421 11.1142 8.75 10.7 8.75C10.2857 8.75 9.94995 8.41421 9.94995 8C9.94995 7.58579 10.2857 7.25 10.7 7.25C11.1142 7.25 11.45 7.58579 11.45 8Z" fill="currentColor"/></svg>';  // WDS mono 16/chat-bubble — 모바일 의견 리스트의 댓글 수(PC 는 의견 칸의 '댓글 n')
  const FB_FILTERS = [['all', '전체', () => true], ['open', '답변중', f => (f.answer || '답변중') === '답변중'], ['done', '완료', f => f.answer === '완료']];  // '전체'가 맨 앞
  let fbFilter = 'open';  // 처음 들어오면 '답변중'
  // 11/03 페이지네이션: 보낸 의견·반영 기록 20개씩(최근 순). 상세에 갔다 와도 보던 페이지 유지
  const PAGE = 20, adminPage = {fb: 1, log: 1, req: 1};
  function pageOf(k, all) {
    const pages = Math.max(1, Math.ceil(all.length / PAGE)), cur = adminPage[k] = Math.min(Math.max(1, adminPage[k] || 1), pages);
    const items = all.slice((cur - 1) * PAGE, cur * PAGE);
    if (pages <= 1) return {items, nav: ''};
    const nums = [...new Set([1, cur - 2, cur - 1, cur, cur + 1, cur + 2, pages])].filter(x => x >= 1 && x <= pages).sort((a, b) => a - b);
    const btn = (x, label, dis, cls = '') => `<button type="button" class="v1-pg${cls}" data-page="${k}:${x}"${dis ? ' disabled' : ''}${x === cur && !label ? ' aria-current="page"' : ''} aria-label="${label || x + '페이지'}">${label ? (label === '이전 페이지' ? '‹' : '›') : x}</button>`;
    const parts = []; nums.forEach((x, i) => { if (i && x - nums[i - 1] > 1) parts.push('<span class="v1-pg-gap">…</span>'); parts.push(btn(x, '', false, x === cur ? ' on' : '')); });
    return {items, nav: `<nav class="v1-pager" aria-label="페이지"><small class="v1-muted">${(cur - 1) * PAGE + 1}–${(cur - 1) * PAGE + items.length} / ${all.length}개</small><span>${btn(cur - 1, '이전 페이지', cur === 1)}${parts.join('')}${btn(cur + 1, '다음 페이지', cur === pages)}</span></nav>`};
  }
  // 11/03 반영 기록: 받은 폴더·파일 1건 = 행 1개(최근 순). 행을 누르면 상세(log:<id>) — 받은 것·결과·바뀐 교육(AS-IS/TO-BE)·문서별 상태
  // 11/03 드라이브 폴더 열기: 문서가 있는 폴더의 resourceKey(드라이브 fileId)로 폴더를 연다(파일을 바로 여는 주소는 없음). 권한은 드라이브 권한 그대로
  // 원본 파일 이름 자체가 링크(별도 버튼 없음). 키가 없으면 그냥 글자
  const DRIVE_LOC = '24101';  // 드라이브 instanceCode(웹 주소의 resourceLocation)
  const driveWeb = key => `https://drive.worksmobile.com/drive/web/share/folder?resourceKey=${encodeURIComponent(key)}&resourceLocation=${DRIVE_LOC}`;
  // 11/03 모바일: 드라이브 앱 스킴(공유 드라이브 폴더). 철자는 resourceLocation(위키 일부의 resouceLocation 은 앱이 못 읽음)
  const driveApp = key => `worksdrive://folder?version=1&resourceLocation=${DRIVE_LOC}&driveType=SHARE_DRIVE&fileId=${encodeURIComponent(key)}`;
  const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const driveText = (key, text, file) => key ? `<a class="v1-drive" href="${esc(driveWeb(key))}" data-drive-key="${esc(key)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" title="드라이브에서 폴더 열기 — ${esc(file || '')} 파일을 누르세요">${text}</a>` : text;
  // 모바일에서 누르면 드라이브 앱을 먼저 연다. 1.5초 안에 앱으로 넘어가지 않으면(앱 없음·막힘) 웹 드라이브를 연다
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-drive-key]'); if (!a || !isMobile()) return;
    e.preventDefault(); e.stopPropagation();
    const key = a.dataset.driveKey; let left = false;
    const onHide = () => { if (document.hidden) left = true; };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    window.location.href = driveApp(key);
    setTimeout(() => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', onHide);
      if (!left && !document.hidden) window.open(driveWeb(key), '_blank', 'noopener'); }, 1500);
  }, true);
  const driveOf = file => { const d = Object.values(content.documents || {}).find(x => x.file === file); return d && d.drive; };
  const LOG_ST = {'바뀌어 교육 반영': 'b', '새 문서로 교육 반영': 'g', '바뀌었지만 교육 영향 없음': 'n', '바뀐 것 없음': 'n', '근거에서 뺌': 'r'};
  const logCount = e => { const ds = e.docs || [], n = k => ds.filter(d => d.status === k).length;
    return {changed: n('바뀌어 교육 반영'), added: n('새 문서로 교육 반영'), noImpact: n('바뀌었지만 교육 영향 없음'), same: n('바뀐 것 없음'), removed: (e.removed || []).length, docs: ds.length, lessons: (e.lessons || []).length}; };
  // 11/03 칩: 무엇을 세는지 앞에 적는다 — 교육(전체 중 수정한 수) / 문서(확인한 수와 상태별 수) / 근거에서 뺀 옛 문서
  const logChips = c => { const all = liveSteps().length;
    return `<span class="v1-lchip b">교육 ${c.lessons}/${all}개 수정</span>${c.docs ? `<span class="v1-lchip">문서 ${c.docs}개 확인: 교육 반영 ${c.changed + c.added}${c.noImpact ? ' · 영향 없음 ' + c.noImpact : ''}${c.same ? ' · 그대로 ' + c.same : ''}</span>` : ''}` +
      (c.removed ? `<span class="v1-lchip r">옛 문서 ${c.removed}개 뺌</span>` : ''); };
  const logSummary = c => { const all = liveSteps().length, chip = (k, cls, label) => c[k] ? `<span class="v1-lchip ${cls}">${label} ${c[k]}</span>` : '';
    return `<dl class="v1-lsum"><dt>교육</dt><dd><span class="v1-lchip b">${all}개 중 ${c.lessons}개 수정</span></dd>` +
      (c.docs ? `<dt>문서</dt><dd><span class="v1-lsum-n">${c.docs}개 확인 →</span>${chip('changed', 'b', '바뀌어 교육 반영')}${chip('added', 'g', '새 문서로 교육 반영')}${chip('noImpact', '', '바뀌었지만 교육 영향 없음')}${chip('same', '', '바뀐 것 없음')}</dd>` : '') +
      (c.removed ? `<dt></dt><dd><span class="v1-lchip r">근거에서 뺀 옛 문서 ${c.removed}</span></dd>` : '') + '</dl>'; };
  function sourceLogCard() {
    const list = cloud.sourceLog || [];
    if (!list.length) return '';
    const lp = pageOf('log', list);
    const rows = lp.items.map(e => { const b = e.basis || {}, c = logCount(e);
      return `<tr class="v1-lrow" data-log="${esc(e.id)}" tabindex="0" role="link" aria-label="${esc(e.at + ' ' + e.title)} 상세 보기"><td class="v1-nowrap">${esc(String(e.at).slice(0, 10).replace(/-/g, '.'))}</td>` +
        `<td><span class="v1-lkind">${esc(b.kind || '')}</span> <b>${esc(e.title)}</b><small>${esc(b.origin || '')}${b.at ? ' · 드라이브 ' + esc(b.at) + ' 기준' : ''}</small></td>` +
        `<td>${logChips(c)}${ticketsOfLog(e).length ? `<span class="v1-lchip">티켓 ${ticketsOfLog(e).map(esc).join(' · ')}</span>` : ''}</td><td class="v1-nowrap">${esc(e.approvedBy || '')}</td><td class="v1-chev">›</td></tr>`; }).join('');
    return `<section class="v1-card"><h2>반영 기록</h2><p class="v1-muted">업무문서(폴더·파일)를 받아 교육 내용에 반영한 기록이에요. 행을 누르면 무엇이 어떻게 바뀌었는지 볼 수 있어요.</p>` +
      `<div class="v1-table"><table class="v1-ltable v1-llist"><thead><tr><th>반영일</th><th>받은 문서</th><th>바뀐 내용</th><th>승인</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${lp.nav}</section>`;
  }
  function logView(id) {
    const e = (cloud.sourceLog || []).find(x => x.id === id);
    if (!e) return '<section class="v1-card"><p class="v1-muted">반영 기록을 찾지 못했어요.</p></section>';
    const b = e.basis || {}, c = logCount(e), ds = e.docs || [], rm = e.removed || [];
    const result = b.kind === '수정 요청' ? `수정 요청 ${(e.tickets || []).length}건 반영 — 교육 ${c.lessons}개 수정`
      : b.kind === '알파 작업' ? `알파 작업 — 교육 ${c.lessons}개 수정`
      : b.kind === '폴더 전체'
      ? `드라이브 최신판 문서 ${c.docs}개를 모두 확인 — LMS 근거 문서 ${e.basisCount || c.docs}개 모두 이 폴더의 최신판`
      : `받은 문서 ${c.docs}개 확인 — 교육 ${c.lessons}개 수정${e.basisCount ? ` · 반영 후 LMS 근거 문서 ${e.basisCount}개` : ''}`;
    const meta = [['받은 것', b.kind], ['폴더', b.origin], b.at ? ['드라이브 기준', b.at] : null, ['받은 방식', b.copy], ['범위', b.range], b.driveCheck ? ['드라이브 대조', b.driveCheck] : null,
      (e.rules || []).length ? ['비교 규칙', e.rules.join(' / ')] : null, e.work ? ['작업 메모', e.work] : null].filter(x => x && x[1]);
    const lessonHtml = (e.lessons || []).map(l => `<div class="v1-lles"><b>${l.no}번 ${esc(l.title)}</b>` + (l.changes || []).map(x =>
      `<div class="v1-lchg"><small>${esc(x.item)}${x.cite ? ' · 근거: ' + esc(x.cite) : ''}</small><div class="v1-lab"><div><i>AS-IS</i>${esc(x.asis)}</div><div><i>TO-BE</i>${esc(x.tobe)}</div></div>${x.note ? `<small class="v1-muted">${esc(x.note)}</small>` : ''}</div>`).join('') + '</div>').join('');
    const folders = [...new Set(ds.map(d => d.folder))];
    const docRows = folders.map(f => (folders.length > 1 ? `<tr class="v1-sfold"><td colspan="3">${esc(f)} <small>${ds.filter(d => d.folder === f).length}개</small></td></tr>` : '') + ds.filter(d => d.folder === f).map(d =>
      `<tr><td><span class="v1-lst ${LOG_ST[d.status] || 'n'}">${esc(d.status)}</span></td><td>${driveText(driveOf(d.file), esc(d.file), d.file)}${d.prev || d.note ? `<small>${d.prev ? '이전: ' + esc(d.prev) : ''}${d.prev && d.note ? ' · ' : ''}${esc(d.note || '')}</small>` : ''}</td><td class="v1-nowrap">${(d.lessons || []).length ? d.lessons.join('·') + '번' : '—'}</td></tr>`).join('')).join('');
    return `<section class="v1-card v1-logd"><span class="v1-lkind">${esc(b.kind || '')}</span><h2>${esc(e.title)}</h2><p class="v1-muted">반영 ${esc(e.at)}${e.approvedBy ? ' · 승인 ' + esc(e.approvedBy) : ''}</p>` +
      `<p class="v1-snap-result">${esc(result)}</p>${logSummary(c)}` +
      `<dl class="v1-snap-meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}` +
      (ticketsOfLog(e).length ? `<dt>수정 요청</dt><dd>${ticketsOfLog(e).map(k => { const r = reqOfKey(k); return r ? `<button type="button" class="v1-link v1-tlink" data-open-req="${esc(k)}">${esc(k)}</button> <span class="v1-lst ${REQ_ST[r.status] || 'n'}">${esc(r.status)}</span>` : `${esc(k)} <small class="v1-muted">(지운 요청)</small>`; }).join(' · ')}</dd>` : '') + `</dl></section>` +
      (lessonHtml ? `<section class="v1-card v1-logd"><h2>바뀐 교육 <small class="v1-muted">${c.lessons}개</small></h2>${lessonHtml}${(e.checks || []).length ? `<p class="v1-muted">체크 기록: ${e.checks.map(esc).join(' / ')}</p>` : ''}</section>` : '') +
      (ds.length ? `<section class="v1-card v1-logd"><h2>확인한 문서 <small class="v1-muted">${ds.length}개</small></h2><div class="v1-table"><table class="v1-ltable"><thead><tr><th>상태</th><th>파일</th><th>바뀐 교육</th></tr></thead><tbody>${docRows}</tbody></table></div></section>` : '') +
      (rm.length ? `<section class="v1-card v1-logd"><h2>근거에서 뺀 문서 <small class="v1-muted">${rm.length}개</small></h2><ul class="v1-srm">${rm.map(r => `<li>${esc(r.file)}<small>${esc(r.note || '')}</small></li>`).join('')}</ul></section>` : '') +
      ((e.skipped || []).length ? `<section class="v1-card v1-logd"><h2>비교했지만 반영하지 않은 것</h2><p class="v1-muted v1-lmore">${e.skipped.map(x => '· ' + esc(x)).join('<br>')}</p></section>` : '');
  }
  // 11/03 콘텐츠 수정 요청: /v1/graph 에서 모모스 담당자가 보낸 요청(AS-IS/TO-BE). 행을 누르면 상세(req:<id>)에서 처리 상태를 바꾼다
  const REQ_ST = {'진행중': 'b', '요청': 'b', '처리 중': 'b', '반영됨': 'g', '반려': 'r'};

  // 교육 요청의 대상은 '단계 › 단원 › 교육' 경로로 저장된다: 앞은 작게, 교육 이름은 크게
  const reqHead = r => { const parts = String(r.target.title).split(' › '), last = parts.pop(); return {path: parts.join(' › '), name: last}; };
  const fmtAt = kstAt;
  // 11/03 티켓 보드: 번호(REQ-n)·상태 필터·담당·연결된 반영 기록. 반영 기록(source_log.json)의 tickets 로 서로 이어진다
  const tkey = r => r.no || 'REQ-?';
  // 11/04 연결 = 반영 기록의 tickets(저장소) 또는 티켓의 logs(화면에서 고름) — 어느 쪽이든 양쪽에 보인다
  const logsOf = r => (cloud.sourceLog || []).filter(e => (e.tickets || []).includes(r.no) || (r.logs || []).includes(e.id));
  const ticketsOfLog = e => [...new Set([...(e.tickets || []), ...(cloud.contentRequests || []).filter(r => r.no && (r.logs || []).includes(e.id)).map(r => r.no)])];
  const reqOfKey = k => (cloud.contentRequests || []).find(x => x.no === k);
  let reqFilter = 'open';
  // 11/09: '전체'를 맨 앞에. 처음 들어오면 '진행중'이 골라져 있다(reqFilter = 'open')
  const REQ_FILTERS = [['all', '전체', () => true], ['open', '진행중', r => r.status === '진행중'],
    ['반영됨', '반영됨', r => r.status === '반영됨'], ['반려', '반려', r => r.status === '반려']];
  function reqListCard() {
    const all = cloud.contentRequests || [], f = REQ_FILTERS.find(x => x[0] === reqFilter) || REQ_FILTERS[1], list = all.filter(f[2]), rp = pageOf('req', list);
    const chips = REQ_FILTERS.map(([k, label, fn]) => `<button type="button" class="v1-fchip${k === reqFilter ? ' on' : ''}" data-req-filter="${esc(k)}" aria-pressed="${k === reqFilter}">${esc(label)} <b>${all.filter(fn).length}</b></button>`).join('');
    const rows = rp.items.map(r => { const logs = logsOf(r);
      return `<tr class="v1-lrow" data-req="${esc(r.id)}" tabindex="0" role="link" aria-label="${esc(tkey(r) + ' ' + reqHead(r).name)} 상세 보기"><td class="v1-nowrap"><b class="v1-tkey">${esc(tkey(r))}</b></td>` +
        `<td>${reqHead(r).path ? `<small class="v1-reqpath">${esc(reqHead(r).path)}</small>` : ''}<b>${esc(reqHead(r).name)}</b><small>${esc(r.type)}${r.field ? ' · ' + esc(r.field) : ''}${logs.length ? ' · 반영 기록 ' + logs.length : ''}${fbsOf(r).length ? ' · 의견 ' + fbsOf(r).length : ''}</small></td>` +
        `<td class="v1-nowrap">${esc(r.name)}<small>${esc(fmtAt(r.at).slice(0, 10))}</small></td><td class="v1-nowrap">${esc(r.assignee || '—')}</td>` +
        `<td><span class="v1-lst ${REQ_ST[r.status] || 'n'}">${esc(r.status)}</span></td><td class="v1-chev">›</td></tr>`; }).join('');
    return `<section class="v1-card"><h2>수정 요청</h2><p class="v1-muted">모모스 담당자가 <a class="v1-link" href="/v1/graph">교육항목·원본 문서 연결도</a>에서 보낸 요청이에요. 티켓 번호(REQ-n)로 반영 기록과 이어져요.</p>` +
      `<div class="v1-fbar" role="group" aria-label="상태 필터">${chips}</div>` +
      (rows ? `<div class="v1-table"><table class="v1-ltable v1-llist v1-tlist"><thead><tr><th>티켓</th><th>대상 · 종류</th><th>요청</th><th>담당</th><th>상태</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>${rp.nav}`
        : `<p class="v1-muted">${all.length ? '이 상태의 요청이 없어요.' : '아직 수정 요청이 없어요.'}</p>`) +
      // 11/10: 진행중 요청은 Codex 가 한 번에 처리 — 내려받은 파일 하나(문구 수정 = 자동 반영, 그 밖의 요청 = 절차대로 제안)
      (ceOpenAll().length ? `<p class="v1-muted v1-reqx"><button type="button" class="v1-tbtn" data-ce-export>진행중 요청 ${ceOpenAll().length}건 내려받기</button> — Codex에 "반영 대기 문구 반영해 줘"라고 하면 검수·커밋까지 해요.${ceWaiting().length ? ` (문구 수정 ${ceWaiting().length}건 포함)` : ''}</p>` : '') +
      (list.length ? `<p class="v1-muted v1-reqx"><button type="button" class="v1-tbtn" data-req-copy-all>지금 목록 ${list.length}건 텍스트로 복사</button> — Claude 대화에 붙여 넣을 때 써요.</p>` : '') + '</section>';
  }
  function reqView(id) {
    const r = (cloud.contentRequests || []).find(x => x.id === id);
    if (!r) return '<section class="v1-card"><p class="v1-muted">수정 요청을 찾지 못했어요.</p></section>';
    const hist = (r.history || []).map(h => h.edit ? `<li><span class="v1-lst n">${esc(h.edit)}</span> ${esc(fmtAt(h.at))} · ${esc(h.by)}</li>`
      : `<li><span class="v1-lst ${REQ_ST[h.status] || 'n'}">${esc(h.status)}</span> ${esc(fmtAt(h.at))} · ${esc(h.by)}${h.commit ? ' · 커밋 ' + esc(h.commit) : ''}${h.note ? `<small>${esc(h.note)}</small>` : ''}</li>`).join('');
    const open = r.status === '진행중', logs = logsOf(r);
    return `<section class="v1-card v1-logd"><div class="v1-reqtop"><p class="v1-snap-chips"><b class="v1-tkey">${esc(tkey(r))}</b><span class="v1-lkind">${esc(r.type)}</span><span class="v1-lst ${REQ_ST[r.status] || 'n'}">${esc(r.status)}</span>${r.commit ? `<span class="v1-lchip">커밋 ${esc(r.commit)}</span>` : ''}</p><button type="button" class="v1-tbtn" data-req-copy>텍스트로 복사</button></div>` +
      `${reqHead(r).path ? `<p class="v1-muted v1-reqpath">${esc(reqHead(r).path)}</p>` : ''}<h2>${esc(reqHead(r).name)}</h2>` +
      `<dl class="v1-snap-meta"><dt>대상</dt><dd>${esc(r.target.kind === 'doc' ? '원본 문서' : '교육')}${r.field ? ' · ' + esc(r.field) : ''}</dd><dt>요청</dt><dd>${esc(r.name)} · ${esc(fmtAt(r.at))}</dd><dt>담당</dt><dd>${esc(r.assignee || '—')}</dd></dl>` +
      `<div class="v1-lab v1-reqab">${r.asis ? `<div><i>AS-IS</i>${esc(r.asis).replace(/\n/g, '<br>')}</div>` : ''}<div><i>TO-BE</i>${esc(r.tobe).replace(/\n/g, '<br>')}</div></div>` +
      (r.edit ? `<p class="v1-muted v1-ce-ticket">변경 종류(자동 추천): <b>${esc(r.edit.kind)}</b>${r.status === '진행중' ? ' · 다음 배포 때 반영' : ''}</p>` : '') +
      (r.note ? `<p class="v1-muted">메모: ${esc(r.note)}</p>` : '') + (r.reply ? (reqEdit === r.id
        ? `<div class="v1-reqform v1-replyedit"><textarea class="v1-pop-input" data-reply-text maxlength="2000" rows="3" aria-label="처리 메모 고치기">${esc(r.reply)}</textarea><div class="v1-actions v1-actions-inline"><button type="button" class="v1-btn" data-reply-cancel>취소</button><button type="button" class="v1-btn primary" data-reply-save>저장</button></div></div>`
        : `<div class="v1-reply"><p class="v1-muted">처리 메모: ${esc(r.reply).replace(/\n/g, '<br>')}</p>${cloud.lmsLevel === 'admin' ? '<span class="v1-reply-ctl"><button type="button" class="v1-tbtn" data-reply-edit>수정</button><button type="button" class="v1-tbtn v1-danger" data-reply-del>삭제</button></span>' : ''}</div>`) : '') + '</section>' +
      (fbsOf(r).length ? `<section class="v1-card v1-logd"><h2>연결된 의견 <small class="v1-muted">${fbsOf(r).length}건</small></h2><ul class="v1-srm v1-tlogs">${fbsOf(r).map(f => `<li><button type="button" class="v1-link v1-tlink" data-open-fb="${esc(f.id)}">${esc(f.name)} · ${esc(String(f.text).slice(0, 60))}</button></li>`).join('')}</ul></section>` : '') +
      `<section class="v1-card v1-logd"><h2>반영 기록 <small class="v1-muted">${logs.length}건</small></h2>` + (logs.length
        ? `<ul class="v1-srm v1-tlogs">${logs.map(e => `<li><button type="button" class="v1-link v1-tlink" data-open-log="${esc(e.id)}">${esc(String(e.at).slice(0, 10))} · ${esc(e.title)}</button>` +
            ((r.logs || []).includes(e.id) && cloud.lmsLevel === 'admin' && !(e.tickets || []).includes(r.no) ? ` <button type="button" class="v1-tbtn" data-log-unlink="${esc(e.id)}">연결 해제</button>` : (e.tickets || []).includes(r.no) ? ' <small class="v1-muted">(반영 기록에 적힘)</small>' : '') + '</li>').join('')}</ul>`
        : `<p class="v1-muted">${r.status === '반영됨' ? '아직 이어진 반영 기록이 없어요. 아래에서 골라 이어 주세요.' : '반영하면 여기에 반영 기록이 이어져요.'}</p>`) +
      (cloud.lmsLevel === 'admin' && logPick(r) ? `<div class="v1-admin-add"><select class="v1-pop-input" data-log-pick aria-label="이을 반영 기록">${logPick(r)}</select><button type="button" class="v1-btn" data-log-link>반영 기록 연결</button></div>` : '') + '</section>' +
      (cloud.lmsLevel === 'admin' ? `<section class="v1-card v1-logd"><h2>처리</h2>` +
        `<div class="v1-reqform"><input type="text" class="v1-pop-input" data-req-commit placeholder="커밋 번호 (반영됨일 때, 예: aa54099)" maxlength="40" aria-label="커밋 번호">${logPick(r) ? `<select class="v1-pop-input" data-req-log aria-label="반영 기록(반영됨일 때)"><option value="">반영 기록 고르기 (반영됨일 때, 선택)</option>${logPick(r)}</select>` : ''}<textarea class="v1-pop-input" data-req-note maxlength="2000" rows="2" placeholder="처리 메모 (반려 시 사유 필수)" aria-label="처리 메모"></textarea>` +
        `<div class="v1-actions v1-actions-inline">${r.status === '반려' ? '<button type="button" class="v1-btn v1-danger" data-req-del>삭제</button>' : ''}${open ? '' : '<button type="button" class="v1-btn" data-req-set="진행중">다시 열기</button>'}${r.status !== '반려' ? '<button type="button" class="v1-btn" data-req-set="반려">반려</button>' : ''}${r.status !== '반영됨' ? '<button type="button" class="v1-btn primary" data-req-set="반영됨">반영됨</button>' : ''}</div></div></section>` : '') +
      (hist ? `<section class="v1-card v1-logd"><h2>이력</h2><ul class="v1-srm v1-reqhist">${hist}</ul></section>` : '');
  }
  // 11/03 보낸 의견 상세(fb:<id>): 의견 · 댓글 · 연결된 수정 요청 티켓
  const fbsOf = r => (cloud.feedback || []).filter(f => (f.tickets || []).includes(r.no));
  const fbOf = id => (cloud.feedback || []).find(x => x.id === id) || (cloud.myFeedback || []).find(x => x.id === id);
  // 11/06 의견 상세: 맨 위 교육 제목(누르면 그 교육으로) · 의견란 우측 상단에 수정 요청 티켓 연결(admin 만) · 댓글(작성자에게 보이고 알림이 간다)
  // 의견에는 상태가 없다 — 진행 상태는 연결한 수정 요청 티켓에서 본다
  const ICON_LINK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 7.9995C11.7759 7.9996 11.9997 8.2236 12 8.4995V10.9995H14.5C14.7759 10.9996 14.9997 11.2236 15 11.4995C15 11.7756 14.7761 11.9995 14.5 11.9995H12V14.4995C12 14.7756 11.7761 14.9995 11.5 14.9995C11.2239 14.9995 11 14.7757 11 14.4995V11.9995H8.5C8.2239 11.9995 8 11.7757 8 11.4995C8.0003 11.2236 8.224 10.9995 8.5 10.9995H11V8.4995C11.0003 8.2236 11.224 7.9995 11.5 7.9995ZM4.5635 6.646C4.7587 6.4512 5.0754 6.451 5.2705 6.646C5.4655 6.8411 5.4653 7.1578 5.2705 7.353L4.3955 8.228C3.4632 9.1603 3.4632 10.6727 4.3955 11.605C4.9493 12.1586 5.7074 12.3834 6.4287 12.2788C6.7016 12.2396 6.9553 12.4288 6.9951 12.7017C7.0347 12.9748 6.8453 13.2292 6.5723 13.269C5.5522 13.417 4.4748 13.0981 3.6885 12.312C2.3656 10.9892 2.3656 8.8438 3.6885 7.521L4.5635 6.646ZM9.6465 5.646C9.8417 5.4511 10.1583 5.451 10.3535 5.646C10.5487 5.8412 10.5485 6.1577 10.3535 6.353L6.3535 10.353C6.1583 10.5483 5.8417 10.5483 5.6465 10.353C5.4514 10.1577 5.4513 9.8412 5.6465 9.646L9.6465 5.646ZM7.5215 3.688C8.8443 2.3654 10.9897 2.3652 12.3125 3.688C13.0986 4.4742 13.4174 5.5518 13.2695 6.5718C13.2299 6.8449 12.9753 7.034 12.7021 6.9946C12.4291 6.9548 12.2398 6.7013 12.2793 6.4282C12.3838 5.707 12.159 4.9487 11.6055 4.395C10.6732 3.4628 9.1609 3.463 8.2285 4.395L7.3535 5.27C7.1583 5.4651 6.8417 5.4651 6.6465 5.27C6.4514 5.0748 6.4514 4.7582 6.6465 4.563L7.5215 3.688Z" fill="currentColor"/></svg>';  // WDS mono 16/link-plus
  let fbPop = '';  // 'link' | ''
  function fbView(id) {
    const f = fbOf(id);
    if (!f) return '<section class="v1-card"><p class="v1-muted">의견을 찾지 못했어요.</p></section>';
    const admin = cloud.lmsLevel === 'admin', st = steps().find(x => x.id === f.step), at = x => esc(kstAt(x));
    const label = st ? `${stepIndex(st.id) + 1}. ${st.title}` : f.stepTitle || '';
    const linked = (f.tickets || []).map(k => { const r = reqOfKey(k); return `<li><button type="button" class="v1-link v1-tlink" data-open-req="${esc(k)}"><b class="v1-tkey">${esc(k)}</b> ${r ? esc(reqHead(r).name) : '(지운 요청)'}</button>${r ? ` <span class="v1-lst ${REQ_ST[r.status] || 'n'}">${esc(r.status)}</span>` : ''} <button type="button" class="v1-tbtn" data-fb-unlink="${esc(k)}" aria-label="${esc(k)} 연결 해제">해제</button></li>`; }).join('');
    const options = (cloud.contentRequests || []).filter(r => r.no && !(f.tickets || []).includes(r.no)).map(r => `<option value="${esc(r.no)}">${esc(r.no)} · ${esc(r.status)} · ${esc(reqHead(r).name)}</option>`).join('');
    const linkPop = `<div class="v1-fbcard v1-fbpop" role="dialog" aria-label="수정 요청 티켓 연결" ${fbPop === 'link' ? '' : 'hidden'}><h3>수정 요청 티켓 연결</h3>` +
      (linked ? `<ul>${linked}</ul>` : '<p class="v1-muted">아직 연결된 티켓이 없어요.</p>') +
      (options ? `<div class="v1-admin-add"><select class="v1-pop-input" data-fb-ticket aria-label="연결할 티켓">${options}</select><button type="button" class="v1-btn" data-fb-link>연결</button></div>`
        : `<p class="v1-muted">연결할 티켓이 없어요. <a class="v1-link" href="/v1/graph">연결도</a>에서 수정 요청을 먼저 만들어 주세요.</p>`) + '</div>';
    const tools = admin ? `<div class="v1-fbtools"><button type="button" class="v1-fbtool" data-fb-pop="link" aria-expanded="${fbPop === 'link'}" aria-label="수정 요청 티켓 연결 (${(f.tickets || []).length}건)">${ICON_LINK}${(f.tickets || []).length ? `<span>${(f.tickets || []).length}</span>` : ''}</button>${linkPop}</div>` : '';
    const shown = f.comments || [];
    const comments = shown.map(c => `<li data-comment-id="${esc(c.id)}"><b>${esc(c.name)}</b> <small class="v1-muted">${at(c.at)}</small><div>${esc(c.text).replace(/\n/g, '<br>')}</div></li>`).join('');
    return `<section class="v1-card v1-logd">${st ? `<button type="button" class="v1-fbtitle" data-step="${esc(st.id)}">${esc(label)}</button>` : `<p class="v1-muted v1-reqpath">${esc(label)}</p>`}<h2>${esc(f.name)}님의 의견</h2>` +
      `<dl class="v1-snap-meta"><dt>보낸 시간</dt><dd>${at(f.at)}</dd><dt>상태</dt><dd><span class="v1-lst ${FB_ANS[f.answer] || 'b'}">${esc(f.answer || '답변중')}</span>${f.answer === '완료' && f.answeredAt ? ` <small class="v1-muted">${at(f.answeredAt)}</small>` : ''}</dd></dl>` +
      (tools ? `<div class="v1-fbtop">${tools}</div>` : '') +
      `<div class="v1-fbq">${esc(f.text).replace(/\n/g, '<br>')}</div></section>` +
      `<section class="v1-card v1-logd"><h2>댓글 <small class="v1-muted">${shown.length}개</small></h2>${comments ? `<ul class="v1-fbc">${comments}</ul>` : `<p class="v1-muted">${admin ? '아직 댓글이 없어요.' : '아직 댓글이 없어요. 댓글이 달리면 알림으로 알려 드려요.'}</p>`}` +
      (admin ? `<div class="v1-reqform"><textarea class="v1-pop-input" data-fb-comment maxlength="2000" rows="2" placeholder="댓글 (의견을 보낸 분에게 보이고 알림이 가요)" aria-label="댓글">${esc(feedbackDrafts.get(id) || '')}</textarea><div class="v1-actions v1-actions-inline"><button type="button" class="v1-btn primary" data-fb-send ${busy ? 'disabled' : ''}>댓글 달기</button></div></div>` : '') + '</section>' +
      (admin ? `<section class="v1-card v1-logd"><h2>답변 상태</h2><p class="v1-muted">${f.answer === '완료' ? '완료로 표시했어요. 다시 답변이 필요하면 답변중으로 되돌려 주세요.' : '답변을 마치면 완료로 표시해 주세요. 상태를 바꿔도 알림은 가지 않아요.'}</p>` +
        `<div class="v1-actions v1-actions-inline">${f.answer === '완료' ? `<button type="button" class="v1-btn" data-fb-answer="off" ${busy ? 'disabled' : ''}>답변중으로 되돌리기</button>` : `<button type="button" class="v1-btn primary" data-fb-answer="on" ${busy ? 'disabled' : ''}>완료로 표시</button>`}</div></section>` : '');
  }
  const openFb = id => { fbPop = ''; view = 'fb:' + id; render(); window.scrollTo({top: 0, behavior: 'instant'}); };
  $('app').addEventListener('click', e => { const t = e.target.closest('[data-fb]'); if (t && view === 'opinions') openFb(t.dataset.fb); const o = e.target.closest('[data-open-fb]'); if (o) openFb(o.dataset.openFb); });
  $('app').addEventListener('keydown', e => { const t = e.target.closest('[data-fb]'); if (t && view === 'opinions' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openFb(t.dataset.fb); } });
  $('app').addEventListener('input', e => { if (!view.startsWith('fb:')) return;
    if (e.target.matches('[data-fb-comment]')) feedbackDrafts.set(view.slice(3), e.target.value); });
  document.addEventListener('click', e => { if (fbPop && view.startsWith('fb:') && !e.target.closest('.v1-fbtools')) { fbPop = ''; render(); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && fbPop && view.startsWith('fb:')) { const k = fbPop; fbPop = ''; keepFocus = `[data-fb-pop="${k}"]`; render(); } });
  $('app').addEventListener('click', async e => {
    if (!view.startsWith('fb:')) return;
    const id = view.slice(3), app = $('app');
    if (e.target.closest('[data-fb-send]')) { const box = app.querySelector('[data-fb-comment]'), text = (box && box.value || '').trim(); if (!text) return toast('댓글을 적어 주세요.');
      feedbackDrafts.set(id, box.value);
      if (await act('feedback.comment', {id, text})) { feedbackDrafts.delete(id); render(); toast('댓글을 달았어요.'); } return; }
    const pop = e.target.closest('[data-fb-pop]');
    if (pop) { fbPop = fbPop === pop.dataset.fbPop ? '' : pop.dataset.fbPop; keepFocus = `[data-fb-pop="${pop.dataset.fbPop}"]`; render(); return; }
    const ans = e.target.closest('[data-fb-answer]');
    if (ans) { if (busy || cloud.lmsLevel !== 'admin') return; const on = ans.dataset.fbAnswer === 'on';
      if (await act('feedback.answer', {id, on})) toast(on ? '완료로 표시했어요.' : '답변중으로 되돌렸어요.'); return; }
    if (e.target.closest('[data-fb-link]')) { const sel = app.querySelector('[data-fb-ticket]'); if (sel && await act('feedback.link', {id, ticket: sel.value, on: true})) toast(sel.value + ' 티켓과 이었어요.'); return; }
    const u = e.target.closest('[data-fb-unlink]'); if (u && await act('feedback.link', {id, ticket: u.dataset.fbUnlink, on: false})) toast(u.dataset.fbUnlink + ' 연결을 풀었어요.');
  });
  $('app').addEventListener('click', e => {
    const ffb = e.target.closest('[data-fb-filter]'); if (ffb && view === 'opinions') { fbFilter = ffb.dataset.fbFilter; adminPage.fb = 1; keepFocus = `[data-fb-filter="${fbFilter}"]`; render(); return; }
    const f = e.target.closest('[data-req-filter]'); if (f && view === 'admin') { reqFilter = f.dataset.reqFilter; adminPage.req = 1; keepFocus = `[data-req-filter="${reqFilter}"]`; render(); return; }
    const l = e.target.closest('[data-open-log]'); if (l) { view = 'log:' + l.dataset.openLog; render(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
    const t = e.target.closest('[data-open-req]'); if (t) { const r = reqOfKey(t.dataset.openReq); if (r) { view = 'req:' + r.id; render(); window.scrollTo({top: 0, behavior: 'instant'}); } }
  });
  // 11/05 텍스트로 복사: 캡처 대신 Claude 세션에 붙여 넣기 좋게(티켓 번호·대상 id·AS-IS/TO-BE·메모)
  const reqText = r => [`[${tkey(r)}] ${r.type} · ${r.status}`,
    `대상: ${r.target.kind === 'doc' ? '원본 문서' : '교육'} — ${r.target.title} (id: ${r.target.id})`,
    r.field ? `항목: ${r.field}` : '', r.edit ? `변경 종류(자동 추천): ${r.edit.kind}` : '',
    `요청: ${r.name} · ${fmtAt(r.at)}`, r.assignee ? `담당: ${r.assignee}` : '',
    `AS-IS:\n${r.asis || '(없음)'}`, `TO-BE:\n${r.tobe}`, r.note ? `메모: ${r.note}` : '', r.reply ? `처리 메모: ${r.reply}` : '',
    r.commit ? `커밋: ${r.commit}` : '', logsOf(r).length ? `반영 기록: ${logsOf(r).map(e => e.id).join(', ')}` : ''].filter(Boolean).join('\n');
  async function copyText(text, done) {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch {} ta.remove();
    }
    toast(ok ? done : '복사하지 못했어요. 다시 눌러 주세요.');
  }
  $('app').addEventListener('click', e => {
    const one = e.target.closest('[data-req-copy]'); if (one && view.startsWith('req:')) { const r = (cloud.contentRequests || []).find(x => x.id === view.slice(4)); if (r) copyText(reqText(r), `${tkey(r)} 내용을 복사했어요. Claude 대화에 붙여 넣으세요.`); return; }
    const all = e.target.closest('[data-req-copy-all]'); if (all && view === 'admin') { const f = REQ_FILTERS.find(x => x[0] === reqFilter) || REQ_FILTERS[1], list = (cloud.contentRequests || []).filter(f[2]);
      copyText(list.map(reqText).join('\n\n----\n\n'), `${f[1]} 요청 ${list.length}건을 복사했어요. Claude 대화에 붙여 넣으세요.`); }
  });
  // 11/10 반영 대기 문구(진행중 '문구 수정' 티켓) → JSON 파일. apply_edits.py 가 읽는다
  const ceWaiting = () => (cloud.contentRequests || []).filter(r => r.status === '진행중' && r.edit);
  const ceOpenAll = () => (cloud.contentRequests || []).filter(r => r.status === '진행중');
  function ceExport() {
    const now = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const data = {format: 'momos-lms-content-edits', version: 1, service: location.host, exportedAt: new Date().toISOString(),
      edits: ceWaiting().map(r => ({no: r.no, id: r.id, step: r.target.id, title: r.target.title, part: r.edit.part, index: r.edit.index, field: r.field,
        asis: r.asis, tobe: r.tobe, kind: r.edit.kind, note: r.note || '', by: r.name, at: r.at})),
      // 문구 수정이 아닌 진행중 요청(사진 교체·매핑 변경·원본 문서 변경 확인 등): Codex 가 AGENTS.md '콘텐츠 수정 요청 처리' 대로 제안하고 승인받아 반영
      requests: ceOpenAll().filter(r => !r.edit).map(r => ({no: r.no, id: r.id, type: r.type, target: r.target, field: r.field, asis: r.asis, tobe: r.tobe, note: r.note || '', by: r.name, at: r.at}))};
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], {type: 'application/json'}));
    a.download = `content_edits_${now}.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`진행중 요청 ${data.edits.length + data.requests.length}건을 내려받았어요.`);
  }
  $('app').addEventListener('click', e => { if (e.target.closest('[data-ce-export]') && cloud.lmsLevel === 'admin') ceExport(); });
  // 11/10 교육 문구 직접 수정: 줄을 누르면 편집 창(Modal dialog). 보내기 = '문구 수정' 티켓. 입력하는 동안 0.3초 뒤 검사 다시
  $('app').addEventListener('click', e => {
    const start = e.target.closest('[data-ce-start]');
    if (start && ceMode && view.startsWith('step:') && cloud.lmsLevel === 'admin') {
      const s = steps().find(x => x.id === view.slice(5)), [part, i] = start.dataset.ceStart.split(':'), index = part === 'kp' ? Number(i) : null;
      const asis = part === 'purpose' ? s.purpose : s.keyPoints[index].text;
      ceEdit = {step: s.id, part, index, asis, text: asis, reason: '', from: `[data-ce-start="${start.dataset.ceStart}"]`}; ceShow();
      return;
    }
    if (e.target.closest('[data-ce-mode-off]')) { ceMode = false; ceHide(true); render(); }
  });
  ceDlg().addEventListener('click', async e => {
    if (!ceEdit) return;
    const box = ceDlg();
    if (e.target.closest('[data-ce-keep]')) { box.querySelector('[data-ce-confirm]').hidden = true; box.querySelector('[data-ce-text]').focus(); return; }
    if (e.target.closest('[data-ce-drop]')) { ceHide(true); return; }
    if (e.target.closest('[data-ce-close]')) { ceHide(); return; }
    const tab = e.target.closest('[data-ce-tab]');
    if (tab) { box.querySelectorAll('[data-ce-tab]').forEach(x => x.setAttribute('aria-selected', String(x === tab))); box.querySelector('.v1-ce-body').dataset.cePane = tab.dataset.ceTab; return; }
    if (e.target.closest('[data-ce-send]')) {
      const s = steps().find(x => x.id === ceEdit.step), r = ceRun(), x = ceEdit;
      if (r.items.some(i => i.level === 'block') || !x.reason.trim()) return;
      const before = new Set((cloud.contentRequests || []).map(q => q.id));
      const ok = await act('content.request', {target: {kind: 'item', id: s.id, title: s.title}, type: '문구 수정', field: x.part === 'purpose' ? '교육 목적' : `교육 내용 ${x.index + 1}`,
        asis: x.asis, tobe: x.text.trim(), note: x.reason.trim(), edit: {part: x.part, index: x.index, kind: r.suggest}});  // 변경 종류는 자동 추천(11/10: 고르는 칸은 BACKLOG 4번 때 다시)
      if (ok) { const n = (cloud.contentRequests || []).find(q => !before.has(q.id)); ceHide(true); render(); toast(`${n ? n.no + ' ' : ''}반영 대기로 저장했어요. 다음 배포 때 반영돼요.`); }
    }
  });
  ceDlg().addEventListener('input', e => {
    if (!ceEdit) return;
    if (e.target.matches('[data-ce-text]')) { ceEdit.text = e.target.value; clearTimeout(ceTimer); ceTimer = setTimeout(ceRefresh, 300); }
    else if (e.target.matches('[data-ce-reason]')) { ceEdit.reason = e.target.value; ceRefresh(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ceEdit && !ceDlg().hidden) { e.preventDefault(); const c = ceDlg().querySelector('[data-ce-confirm]'); if (!c.hidden) { c.hidden = true; return; } ceHide(); } });
  // 아직 이어지지 않은 반영 기록(최근 순) 고르기
  const logPick = r => (cloud.sourceLog || []).filter(e => !logsOf(r).includes(e)).slice(0, 30).map(e => `<option value="${esc(e.id)}">${esc(String(e.at).slice(0, 10))} · ${esc(e.title)}</option>`).join('');
  $('app').addEventListener('click', async e => {
    if (!view.startsWith('req:')) return;
    const id = view.slice(4);
    if (e.target.closest('[data-log-link]')) { const sel = $('app').querySelector('[data-log-pick]'); if (sel && await act('content.log', {id, log: sel.value, on: true})) toast('반영 기록을 이었어요.'); return; }
    const u = e.target.closest('[data-log-unlink]'); if (u && await act('content.log', {id, log: u.dataset.logUnlink, on: false})) toast('반영 기록 연결을 풀었어요.');
  });
  // 11/04 처리 메모 수정·삭제
  let reqEdit = null;
  $('app').addEventListener('click', async e => {
    if (!view.startsWith('req:')) return;
    const id = view.slice(4);
    if (e.target.closest('[data-reply-edit]')) { reqEdit = id; keepFocus = '[data-reply-text]'; return render(); }
    if (e.target.closest('[data-reply-cancel]')) { reqEdit = null; return render(); }
    if (e.target.closest('[data-reply-save]')) { const t = ($('app').querySelector('[data-reply-text]') || {}).value || ''; reqEdit = null;
      if (await act('content.reply', {id, text: t})) toast(t.trim() ? '처리 메모를 고쳤어요.' : '처리 메모를 지웠어요.'); return; }
    if (e.target.closest('[data-reply-del]')) { if (!confirm('처리 메모를 지울까요? 이력에 남은 같은 메모도 함께 지워요.')) return;
      if (await act('content.reply', {id, text: ''})) toast('처리 메모를 지웠어요.'); }
  });
  $('app').addEventListener('click', async e => {
    const b = e.target.closest('[data-req-del]'); if (!b || !view.startsWith('req:')) return;
    if (!confirm('반려한 요청을 목록에서 지울까요? 티켓 번호는 다시 쓰지 않아요.')) return;
    const id = view.slice(4); view = 'admin';
    if (await act('content.delete', {id})) toast('반려한 요청을 지웠어요.'); else { view = 'req:' + id; render(); }
  });
  const openReqView = id => { view = 'req:' + id; render(); window.scrollTo({top: 0, behavior: 'instant'}); };
  $('app').addEventListener('click', e => { const t = e.target.closest('[data-req]'); if (t && view === 'admin') openReqView(t.dataset.req); });
  $('app').addEventListener('keydown', e => { const t = e.target.closest('[data-req]'); if (t && view === 'admin' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openReqView(t.dataset.req); } });
  $('app').addEventListener('click', async e => {
    const b = e.target.closest('[data-req-set]'); if (!b || !view.startsWith('req:')) return;
    const app = $('app'), note = (app.querySelector('[data-req-note]') || {}).value || '', commit = ((app.querySelector('[data-req-commit]') || {}).value || '').trim();
    const log = ((app.querySelector('[data-req-log]') || {}).value || '');
    const data = {id: view.slice(4), status: b.dataset.reqSet, ...(note.trim() ? {note: note.trim()} : {}), ...(commit && b.dataset.reqSet === '반영됨' ? {commit} : {}), ...(log && b.dataset.reqSet === '반영됨' ? {log} : {})};
    if (await act('content.status', data)) toast('처리 상태를 바꿨어요: ' + b.dataset.reqSet);
  });
  const openLog = id => { view = 'log:' + id; render(); window.scrollTo({top: 0, behavior: 'instant'}); };
  $('app').addEventListener('click', e => { const t = e.target.closest('[data-log]'); if (t && view === 'admin') openLog(t.dataset.log); });
  $('app').addEventListener('keydown', e => { const t = e.target.closest('[data-log]'); if (t && view === 'admin' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openLog(t.dataset.log); } });

  const listItem = s => {
    const r = record(s.id), st = statusOf(s), n = stepIndex(s.id) + 1;
    const sub = st === 'done' ? ' · ' + dateLabel(r.done) + ((r.completedByName || (r.trainedBy && r.trainedBy.name)) ? ' · ' + (r.completedByName || r.trainedBy.name) : '') : '';
    const ro = false;
    return `<li><button class="v1-item ${ro ? 'ready' : st}" data-step="${esc(s.id)}"><span class="v1-num">${n}</span><span class="v1-body"><strong>${esc(s.title)}</strong>${ro ? '' : `<small>${st === 'planned' ? '교육안 준비 중' : esc(STATUS[st] + sub)}</small>`}</span><span class="v1-chev">›</span></button></li>`;
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
    return whoLine() + (true ? countsBlock(countsOf(s => record(s.id).status, liveSteps().filter(s => matches(s)))) : '')  /* 필터를 걸면 걸러진 교육만 센다 */ + `<div class="v1-prow v1-lhead"><h2>전체 교육${filt ? `<small> · ${esc(FKIND[filt.k])} ${esc(filt.v)} ${count}개</small>` : `<small> · ${count}개</small>`}</h2>` +
      (filt ? `<span class="v1-fgroup"><button type="button" class="v1-fchip on" data-filter-open aria-haspopup="dialog" aria-label="보기 필터: ${esc(filt.v)}">${esc(filt.v)} ▾</button><button type="button" class="v1-fchip on" data-filter-clear aria-label="필터 해제">✕</button></span>`
        : (content.filters && content.filters.position ? '<button type="button" class="v1-fchip" data-filter-open aria-haspopup="dialog">필터 ▾</button>' : '')) + '</div>' +
      all.map(g => `<h2 class="v1-stage">${g.order}. ${esc(g.title)}</h2>` + g.units.map(unitBlock).join('')).join('') +
      (!filt ? extra : '') + srcLine();
  }

  // 교육 단계 화면(메뉴 › 교육 단계 › 1~6): 그 단계의 교육 목록(필터는 '전체 교육'에서만)
  function stageView(whole) {
    // whole: 메뉴 › 교육 단계 › 전체 교육 — 86개를 단계별로 한 화면에, 필터(근무조·포지션)는 여기에서만
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
    const homeLabel = '교육 현황', inStage = view === 'stage';
    const item = (attrs, label, on, depth2) => `<button type="button" class="v1-nav-item${on ? ' on' : ''}${depth2 ? ' d2' : ''}" ${attrs} ${on ? 'aria-current="page"' : ''}>${label}</button>`;
    // 11/02: 지점 선택·변경과 '교육 과정'은 숨김(모든 조직이 같은 교육 자료를 쓴다). 메뉴 = 내 교육 · 교육 현황 · (admin) LMS관리자(첫 화면은 교육 현황)
    $('v1Nav').querySelector('.v1-nav-panel').innerHTML =
      `<div class="v1-nav-head">${avatar(cloud.user)}<span><strong>${esc(cloud.user.name)}</strong><small>${esc(isStaff() ? 'admin' : '')}</small></span></div>` +
      `<div class="v1-nav-body">${item('data-nav="mine"', '내 교육', (view === 'person' || view === 'all') && own())}${item('data-nav="home"', esc(homeLabel), view === 'home' || ((view === 'person' || view === 'all') && !own()))}</div>` +
      // 11/06: 아래쪽에 '의견 리스트'(검은 글씨) → 그 아래 LMS관리자(admin)
      `<div class="v1-nav-foot">${item('data-nav="opinions"', '의견 리스트', view === 'opinions' || view.startsWith('fb:'))}` +
      (isStaff() ? item('data-nav="admin"', 'LMS관리자', view === 'admin').replace('class="v1-nav-item', 'class="v1-nav-item v1-nav-danger') : '') + '</div>';
  }
  function openNav() { if (view === 'stage') navStagesOpen = true; drawNav(); $('v1Nav').hidden = false; document.body.style.overflow = 'hidden'; $('v1Nav').querySelector('.v1-nav-item').focus(); }
  function closeNav() { $('v1Nav').hidden = true; document.body.style.overflow = ''; }
  $('v1Nav').addEventListener('click', async e => {
    const t = e.target.closest('[data-nav],[data-nav-toggle],[data-nav-close]');
    if (!t) return;
    if (t.hasAttribute('data-nav-close')) return closeNav();
    if (t.hasAttribute('data-nav-toggle')) { navStagesOpen = !navStagesOpen; return drawNav(); }
    const to = t.dataset.nav; closeNav();
    if (cloud.target !== cloud.user.id && to !== 'branch') { try { cloud = await api('GET'); } catch {} }  // 메뉴는 항상 '나' 기준
    if (to === 'all') { homeScroll = null; view = 'all'; render(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
    if (to === 'stage') { stageSel = Number(t.dataset.navStage); homeScroll = null; view = 'stage'; render(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
    if (to === 'mine') { homeScroll = null; view = 'person'; render(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
    if (to === 'home') { view = 'home'; render(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
    if (to === 'admin') { view = 'admin'; render(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
    if (to === 'opinions') { view = 'opinions'; render(); window.scrollTo({top: 0, behavior: 'instant'}); return; }
    if (to === 'branch') { pickBranch = null; view = 'branch'; render(); return; }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('v1Nav').hidden) { closeNav(); $('v1Ham').focus(); } });

  function plannedView(s) {
    const u = unitOf(s.id);
    return `<section class="v1-card"><span class="v1-pill planned">${STATUS.planned}</span> <span class="v1-muted">${esc(u.no || '')} ${esc(u.title)}</span>` +
      `<h2 style="margin-top:var(--spacing-12)">교육 목적</h2><p class="v1-muted">이 세션의 교육 목적·교육 내용·수행 확인은 원본 문서를 바탕으로 준비 중이에요.</p>` +
      (s.topics && s.topics.length ? `<h2 style="margin-top:var(--spacing-16)">다룰 내용</h2><ol class="v1-kp">${s.topics.map(t => `<li><div>${esc(t)}</div></li>`).join('')}</ol>` : '') +
      (s.plannedSources ? `<h2 style="margin-top:var(--spacing-16)">근거 문서</h2><p class="v1-muted">${esc(s.plannedSources)}</p>` : '') +
      (s.sessionNote ? `<div class="v1-note">${esc(s.sessionNote)}</div>` : '') + '</section>' +
      stepActions(s);
  }

  function stepView(s) {
    if (planned(s)) return plannedView(s);
    const r = record(s.id), st = r.status, who = role(), own = who === 'learner', staff = who === 'staff';
    // 10/30: 체크·완료는 관리자만 — 교육생 기록에 들어가서 한다. 교육생은 관리자가 체크한 상태를 보고, 의견만 보낸다
    const editMark = mayConfirm() && cloud.target !== cloud.user.id && (st === 'ready' || st === 'practice');  // 11/02: 모든 직원이 다른 사람 교육을 체크(내 교육은 보기만)
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
        `<p class="v1-inline-file">원본 파일: ${driveText(doc.drive, esc(doc.folder ? doc.folder + ' / ' : '') + esc(doc.file || ''), doc.file)}</p></section>`;
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
    // 교육 내용 카드(번호는 왼쪽 그대로): 위 = 교육 체크 줄, 가운데 = 글, 아래 = 본문 펼치기.
    // 관리자: 체크 상자 + (체크하면) 체크한 관리자·일시. 교육생: 체크된 항목에만 체크한 관리자·일시
    const head = k => {
      const on = Boolean(r.teacher[k]), who = on ? `<span class="v1-by" data-by="${k}">${esc(markLabel(r, k))}</span>` : `<span class="v1-by" data-by="${k}"></span>`;
      if (editMark) return `<div class="v1-khead"><label class="v1-kcheck"><input type="checkbox" data-mark="${k}" aria-label="${k + 1}번 교육 내용 체크" ${on ? 'checked' : ''}><span class="v1-box"></span></label>${who}</div>`;
      return on ? `<div class="v1-khead v1-khead-ro">${who}</div>` : '';
    };
    // 11/10 교육 문구 직접 수정: LMS관리자 admin 에게만 '문구 수정'(검토 중이면 티켓 번호)
    // 11/10: 항목마다 버튼을 두지 않고 ⋮ › '문구 수정 모드'에서만 — 글을 누르면 고치는 칸. 모드 중에는 체크·본문 펼치기 대신 고치기
    const ceOn = ceMode && cloud.lmsLevel === 'admin' && Boolean((s.keyPoints || []).length);
    const cePick = (part, index, text, cls = '') => { const o = ceOpen(s.id, part, index), html = esc(text).replace(/\n/g, '<br>');
      return o ? `<div class="v1-ce-busy ${cls}">${html}<button type="button" class="v1-ce-tag" data-open-req="${esc(o.no)}">반영 대기 · ${esc(o.no)}</button></div>`
        : `<button type="button" class="v1-ce-pick ${cls}" data-ce-start="${part}:${index ?? ''}" aria-label="${part === 'purpose' ? '교육 목적' : `교육 내용 ${index + 1}`} 고치기" ${busy ? 'disabled' : ''}>${html}</button>`; };
    const keyPoints = items.length ? `<ol class="v1-kp">${items.map((k, n) => {
      const keys = [...new Set(k.cites || [])];
      if (ceOn) return `<li class="v1-kc${r.teacher[n] ? ' on' : ''}" data-kp="${n}"><div class="v1-kcard">${cePick('kp', n, k.text)}</div></li>`;
      return `<li class="v1-kc${r.teacher[n] ? ' on' : ''}" data-kp="${n}"><div class="v1-kcard">${head(n)}${keys.length ? `<details class="v1-topic${k.text.length <= 12 ? ' short' : ''}" id="kp-${n}"><summary><span class="v1-topic-text">${esc(k.text).replace(/\n/g, '<br>')}</span><span class="v1-topic-foot">${hint}</span></summary>${body(keys)}</details>`
        : `<div class="v1-topic"><span class="v1-topic-text">${esc(k.text).replace(/\n/g, '<br>')}</span></div>`}</div></li>`;
    }).join('')}</ol>` : `<div class="v1-copy">${s.copy.map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
    const refDocs = (s.refDocs || []).map(d => `<p class="v1-inline-file">원고 문서: ${esc(d.title)} (${esc(d.ref)}) · ${esc(d.file)}</p>`).join('');
    let status = '';
    const doneBy = r.completedByName || (r.trainedBy && r.trainedBy.name);
    if (st === 'done') status = `<div class="v1-note ok">${dateLabel(r.done)} 완료${doneBy ? ' · ' + esc(doneBy) : ''}</div>`;
    let actions = '';
    const trainer = mayConfirm() && cloud.target !== cloud.user.id;
    if (trainer && (st === 'ready' || st === 'practice')) {
      const ready = items.length && items.every((_, k) => r.teacher[k]);
      actions = `<button class="v1-btn primary" data-close ${ready && !busy ? '' : 'disabled'}>완료</button>`;
    } else if (trainer && st === 'done') actions = `<button class="v1-btn" data-reopen ${busy ? 'disabled' : ''}>완료 취소</button>`;
    // 의견 보내기: 멘티는 본인 교육 화면에서, 관리자는 멘티의 교육 화면이나 교육 과정에서. 보내면 LMS관리자 화면의 표로 모인다
    const memo = own || trainer ? `<section class="v1-card"><h2>의견 보내기</h2>` +
      `<textarea class="v1-memo" data-feedback maxlength="2000" placeholder="${trainer ? '교육 내용에서 고칠 점이나 의견을 입력해주세요.' : '궁금하거나 이해가 어려운 점을 입력해주세요.'}"></textarea>` +
      `<div class="v1-actions v1-actions-inline"><button type="button" class="v1-btn" data-feedback-send>보내기</button></div></section>` : '';
    const purpose = s.purpose && ceOn ? cePick('purpose', null, s.purpose, 'v1-purpose') : s.purpose ? `<p class="v1-purpose">${esc(s.purpose).replace(/\n/g, '<br>')}</p>` : `<div class="v1-copy">${s.copy.map(p => `<p>${esc(p)}</p>`).join('')}</div>`;
    const u = unitOf(s.id);
    const rework = s.reworkPending ? `<div class="v1-note">보완 예정 세션 — 지금 내용은 이전 교육안이에요.${s.sessionNote ? ' ' + esc(s.sessionNote) : ''}</div>` : '';
    const guide = ceOn ? '고칠 글을 누르세요. 수정 모드에서는 체크·본문 펼치기가 잠시 꺼져요.' : trainer ? (st === 'done' ? '완료한 교육이에요. 고칠 게 있으면 아래 「완료 취소」를 누르세요.' : '교육한 항목을 체크하세요. 모두 체크하면 「완료」를 누를 수 있어요. 글을 누르면 근거 본문이 펼쳐져요.')
      : '글을 누르면 근거 본문이 펼쳐져요.';
    const ceBanner = ceOn ? `<div class="v1-ce-modebar" role="status"><span>문구 수정 모드 — 고칠 교육 목적이나 교육 내용을 누르세요.</span><button type="button" class="v1-ce-action" data-ce-mode-off>끝내기</button></div>` : '';
    return learnerBar() + ceBanner + `<section class="v1-card"><span class="v1-pill ${st}">${esc(STATUS[st])}</span> <span class="v1-muted">${esc(u.no || '')} ${esc(u.title)}</span>${rework}` +
      `<h2 style="margin-top:var(--spacing-12)">교육 목적</h2>${purpose}${photos}` +
      (s.note ? `<div class="v1-note warn">${esc(s.note)}</div>` : '') + `${enrolNotice()}${status}</section>` +
      `<section class="v1-card"><h2>교육 내용</h2><p class="v1-muted">${guide}</p>${keyPoints}${refDocs}</section>` +
      memo +
      stepActions(s, actions);
  }
  function bind(step) {
    const app = $('app');
    // 지점을 고르면 바로 홈(역할은 고르지 않는다: 관리자 = 지정된 LMS관리자)
    app.querySelectorAll('[data-branch]').forEach(b => b.onclick = () => { pickBranch = b.dataset.branch; chooseRole(isStaff() ? 'staff' : 'learner').catch(e => toast(e.message)); });
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
    if (adminRes) adminRes.onclick = e => { const b = e.target.closest('[data-admin-pick]'); if (!b) return; adminQ.value = adminQ.dataset.picked = b.dataset.adminPick; adminRes.innerHTML = ''; if (addBtn) addBtn.focus(); };
    if (addBtn) addBtn.onclick = async () => { const email = app.querySelector('[data-admin-email]').value.trim(); if (!email) return; if (await act('lms.admin', {email, level: 'admin'})) toast('admin으로 지정했습니다.'); };
    app.querySelectorAll('[data-admin-del]').forEach(b => b.onclick = async () => { if (await act('lms.admin', {email: b.dataset.adminDel, level: null})) toast('admin에서 해제했습니다.'); });
    app.querySelectorAll('[data-mview]').forEach(b => b.onclick = () => { if (view === b.dataset.mview) return; homeScroll = null; view = b.dataset.mview; render(); window.scrollTo({top: 0, behavior: 'instant'}); });
    app.querySelectorAll('[data-stage]').forEach(b => b.onclick = () => { stageSel = Number(b.dataset.stage); render(); window.scrollTo(0, 0); });
    const fo = app.querySelector('[data-filter-open]'), fc = app.querySelector('[data-filter-clear]');
    if (fo) fo.onclick = openSheet;
    if (fc) fc.onclick = () => setFilter(null);
    app.querySelectorAll('[data-org-open]').forEach(b => b.onclick = () => openOrgSheet());
    app.querySelectorAll('[data-page]').forEach(b => b.onclick = () => { const [k, x] = b.dataset.page.split(':'); adminPage[k] = Number(x); render(); b.closest('.v1-card').scrollIntoView({block: 'start', behavior: 'instant'}); });
    app.querySelectorAll('[data-admin-tab]').forEach(b => b.onclick = () => { adminTab = b.dataset.adminTab; keepFocus = `[data-admin-tab="${adminTab}"]`; render(); });
    app.querySelectorAll('[data-home-tab]').forEach(b => b.onclick = () => { homeTab = b.dataset.homeTab; keepFocus = `[data-home-tab="${homeTab}"]`; render(); });
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
    const canEdit = Boolean(s && !planned(s) && cloud.lmsLevel === 'admin' && (s.keyPoints || []).length);
    $('v1EditMode').hidden = $('v1EditSep').hidden = !canEdit; $('v1EditMode').textContent = ceMode ? '문구 수정 끝내기' : '문구 수정 모드';
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
  // 11/05 프로필(오른쪽 위 동그라미)을 누르면 이름·이메일과 로그아웃
  const closeMe = () => { $('v1MeMenu').hidden = true; $('v1Who').setAttribute('aria-expanded', 'false'); };
  $('v1Who').onclick = e => { e.stopPropagation(); const open = $('v1MeMenu').hidden; closeMenu(); $('v1MeMenu').hidden = !open; $('v1Who').setAttribute('aria-expanded', String(open)); if (open) $('v1Logout').focus(); };
  document.addEventListener('click', e => { if (!$('v1Me').contains(e.target)) closeMe(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('v1MeMenu').hidden) { closeMe(); $('v1Who').focus(); } });
  $('v1Logout').onclick = async () => {
    closeMe();
    try { await fetch('/api/auth/logout', {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': (window.ERPAuth && ERPAuth.csrfToken) || ''}, body: '{}'}); } catch {}
    try { sessionStorage.removeItem('v1.worksVisit'); sessionStorage.setItem('v1.loggedOut', '1'); } catch {}  // 다시 열 때 WORKS 로 자동 재로그인하지 않게
    location.replace('/v1');
  };
  $('v1MoreBtn').onclick = e => { e.stopPropagation(); closeMe(); const open = $('v1Menu').hidden; if (open) onMenuOpen(); $('v1Menu').hidden = !open; $('v1MoreBtn').setAttribute('aria-expanded', String(open)); };
  $('v1ExportPdf').onclick = exportPdf;
  $('v1EditMode').onclick = () => { closeMenu(); ceMode = !ceMode; ceEdit = null; render(); window.scrollTo({top: 0, behavior: 'instant'}); };
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
        let out = false; try { out = sessionStorage.getItem('v1.loggedOut') === '1'; } catch {}
        if (out && !status.user) {  // 11/05 방금 로그아웃: WORKS 로 바로 다시 들어가지 않고 안내만
          const gate = document.getElementById('authGate');
          if (gate) gate.innerHTML = '<div class="v1-auth-out"><h1>로그아웃했어요</h1><p>다시 들어오려면 NAVER WORKS로 로그인해 주세요.</p><a class="v1-btn primary" href="/auth/works/login" id="v1Relogin">NAVER WORKS로 로그인</a></div>';
          const re = document.getElementById('v1Relogin'); if (re) re.onclick = () => { try { sessionStorage.removeItem('v1.loggedOut'); sessionStorage.setItem('v1.worksVisit', '1'); } catch {} };
          return new Promise(() => {});
        }
        try { sessionStorage.removeItem('v1.loggedOut'); } catch {}
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
    if (!cloud || !content || busy || selfPending || document.visibilityState !== 'visible' || view === 'branch') return;
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.tagName === 'INPUT' && ['text', 'search', 'email'].includes(a.type))) return;
    if (pop) return;  // 완료 팝업을 보는 중
    try {
      const fresh = await api('GET', null, cloud.target);
      if (busy || fresh.target !== cloud.target) return;
      if (fresh.learner.revision !== cloud.learner.revision || fresh.rootRevision !== cloud.rootRevision || JSON.stringify(fresh.notifications) !== JSON.stringify(cloud.notifications)) { cloud = fresh; render(); }
    } catch {}
  }, 5000);

  // --- start: sign in (automatically on a local trial), load the slice and the record, pick a sensible first target
  devAutoLogin().then(() => ERPAuth.ensureSession()).then(async () => {
    const response = await fetch('/v1_content.json', {credentials: 'same-origin', cache: 'no-store'});
    if (!response.ok) throw new Error('교육 내용을 불러오지 못했습니다.');
    content = await response.json();
    cloud = await api('GET');
    // WORKS 부서·직책을 아직 못 읽은 사람(이 버전 이전에 로그인한 채로 들어온 경우): WORKS 로그인을 한 번 자동으로 거친다(같은 탭에서 한 번만)
    if (cloud.profileMissing) {
      let tried = true; try { tried = sessionStorage.getItem('v1.relogin') === '1'; if (!tried) sessionStorage.setItem('v1.relogin', '1'); } catch {}
      if (!tried) { location.replace('/auth/works/login'); return; }
    }
    // 11/02: 지점 선택은 숨김(모든 조직이 같은 교육 자료) → 처음 들어오면 온천 본점으로 저장하고 바로 교육 현황
    if (!profile()) await act('profile.set', {branch: BRANCHES[0].id, role: isStaff() ? 'staff' : 'learner'});
    view = 'home';
    if (!cloud.enrolled) await act('config.selfEnrol', {});  // 처음 들어온 날이 교육 시작일(admin 도 교육을 듣는다)
    render();
  }).catch(e => { $('app').innerHTML = `<div class="v1-card"><h2>불러오지 못했어요</h2><p class="v1-muted">${esc(e.message)}</p><button class="v1-btn" onclick="location.reload()">다시 시도</button></div>`; });
})();
