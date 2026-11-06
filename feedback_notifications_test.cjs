'use strict';
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const source = readFileSync(join(__dirname, 'v1.js'), 'utf8').replace(/\r\n/g, '\n');
const line = start => source.split('\n').find(s => s.trimStart().startsWith(start));
const between = (a, b) => {
  const start = source.indexOf(a), end = source.indexOf(b, start + a.length);
  assert.ok(start >= 0 && end > start, a);
  return source.slice(start, end);
};
const FB = {FB_ST: {'진행중': 'b', '반영됨': 'g', '반려': 'r', '닫힘': 'n'}, REQ_ST: {'진행중': 'b', '반영됨': 'g', '반려': 'r'}};
function feedbackHarness(admin = true, status = '', pop = '') {
  const f = {id: 'f1', name: '작성자', step: 'space-walk', at: '2026-11-06', text: '<script>의견</script>', ...(status ? {status} : {}),
    comments: [{id: 'c1', name: '관리자', at: '2026-11-06', text: '<b>답변</b>'}, {id: 'c2', name: '관리자', at: '2026-11-06', text: '', status: '진행중', auto: 'REQ-1 수정 요청과 연결'}]};
  const context = vm.createContext({...FB,
    cloud: {lmsLevel: admin ? 'admin' : null, ...(admin ? {feedback: [f], contentRequests: [{no: 'REQ-1', status: '진행중', target: {title: 'A'}}]} : {myFeedback: [f]})},
    feedbackDrafts: new Map([['f1', '<답변 초안>']]), busy: false,
    steps: () => [{id: 'space-walk', title: '교육 항목'}], stepIndex: () => 2,
    kstAt: x => String(x || ''), reqOfKey: () => null, reqHead: () => ({name: 'A'}),
  });
  vm.runInContext(line('const esc =') + '\n' + between('  const fbOf =', '  const openFb =') + `\nfbPop = ${JSON.stringify(pop)};\nglobalThis.detail = fbView;`, context);
  return context;
}
test('authors see status, every comment and the education title link, but no admin controls/ticket data', () => {
  const context = feedbackHarness(false, '반영됨'), html = context.detail('f1');
  assert.match(html, /&lt;script&gt;의견/);
  assert.match(html, /&lt;b&gt;답변/);
  assert.match(html, /data-comment-id="c1"/);
  assert.match(html, /data-comment-id="c2"/);
  assert.match(html, /<dt>상태<\/dt><dd><span class="v1-lst g">반영됨/);
  assert.match(html, /class="v1-fbtitle" data-step="space-walk">3\. 교육 항목/);
  assert.doesNotMatch(html, /수정된 교육 보기|data-fb-send|data-fb-pop|data-fb-status|수정 요청 티켓|textarea/);
  assert.match(context.detail('another-author'), /의견을 찾지 못했어요/);
});
test('admin tools: ticket link entry and status dropdown with transitions and a comment box', () => {
  const closed = feedbackHarness(true).detail('f1');
  assert.match(closed, /data-fb-pop="link"/);
  assert.match(closed, /data-fb-pop="status"[^>]*>상태 없음/);
  assert.match(closed, /data-fb-comment[^>]*>&lt;답변 초안&gt;<\/textarea>/);
  assert.match(closed, /data-fb-send >댓글 달기/);
  const open = feedbackHarness(true, '진행중', 'status').detail('f1');
  assert.match(open, /v1-stbtn b"[^>]*>진행중/);
  assert.doesNotMatch(open, /data-fb-status="진행중"/);  // 지금 상태로는 바꾸지 않는다
  for (const to of ['반영됨', '반려', '닫힘']) assert.match(open, new RegExp(`data-fb-status="${to}"`));
  assert.match(open, /닫기<\/span><span class="v1-starrow"/);
  assert.match(open, /data-fb-status-text/);
  assert.match(feedbackHarness(true, '', 'link').detail('f1'), /<option value="REQ-1">/);
});
function noticeHarness(fail = false) {
  const elements = new Map(), calls = [], opened = [], messages = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {hidden: true, innerHTML: '', textContent: '',
      setAttribute() {}, focus() {}, querySelector: () => ({scrollIntoView() {}})});
    return elements.get(id);
  };
  const now = Date.now(), iso = d => new Date(now - d * 864e5).toISOString();
  const ctx = {...FB,
    cloud: {user: {id: 'author'}, target: 'another-learner', learner: {revision: 3}, rootRevision: 4,
      notifications: [
        {id: 'reply', kind: 'feedback.reply', feedback: 'f1', comment: 'c1', step: 'space-walk', title: '答 <script>', detail: '교육 항목', text: '<b>답</b>', by: '관리자', date: iso(2), read: false},
        {id: 'done', kind: 'feedback.status', status: '반영됨', feedback: 'f1', comment: 'c2', step: 'space-walk', title: "'반영됨' 상태로", detail: '교육 항목', date: iso(0), read: false},
        {id: 'old', kind: 'feedback.status', status: '닫힘', feedback: 'f1', step: 'space-walk', title: '오래된 알림', detail: '교육 항목', date: iso(40), read: false},
        {id: 'legacy', title: '기존 다른 종류 알림', date: iso(0), read: false},
      ]},
    noticeBusy: false, busy: false, $: element, kstAt: () => '2026-11-06', uid: () => 'request-id',
    steps: () => [{id: 'space-walk'}], stepIndex: () => 2, unitOf: () => ({stage: {order: 1}}),
    document: {body: {style: {}}}, CSS: {escape: s => s},
    render() {}, openFb: id => {opened.push(id);}, toast: text => messages.push(text),
    api: async (method, value) => {
      calls.push({method, value});
      if (fail) throw new Error('저장 실패');
      const fresh = structuredClone(ctx.cloud); fresh.target = 'author';
      if (value) fresh.notifications.find(n => n.id === value.data.ids[0]).read = true;
      return fresh;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(line('const esc =') + '\n' + between('  const NOTICE_DAYS =', "  $('v1NoticeToggle').onclick") +
    '\nglobalThis.noticeAPI = {drawNotices,openNotice};', ctx);
  return {ctx, calls, opened, messages, element, api: ctx.noticeAPI};
}
test('the layer lists the last 30 days newest first, ends with the all-read line and marks nothing read', () => {
  const h = noticeHarness(); h.element('v1Notices').hidden = false;
  h.api.drawNotices();
  const html = h.element('v1NoticeList').innerHTML;
  assert.equal(h.element('v1NoticeCount').textContent, 2);
  assert.ok(html.indexOf('data-open-notice="done"') < html.indexOf('data-open-notice="reply"'));
  assert.match(html, /의견 상태 변경<\/span><span class="v1-lst g">반영됨/);
  assert.match(html, /의견 댓글/);
  assert.match(html, /&lt;b&gt;답&lt;\/b&gt;/);
  assert.match(html, /3\. 교육 항목/);
  assert.doesNotMatch(html, /오래된 알림|기존 다른 종류|수정된 교육 보기/);
  assert.match(html, /최근 30일간 받은 알림을 모두 확인했습니다\./);
  assert.equal(h.calls.length, 0);
});
test('no notices shows the centered empty message', () => {
  const h = noticeHarness(); h.ctx.cloud.notifications = []; h.element('v1Notices').hidden = false;
  h.api.drawNotices();
  assert.match(h.element('v1NoticeList').innerHTML, /v1-notices-empty">최근 받은 알림이 없습니다\./);
  assert.equal(h.element('v1NoticeCount').hidden, true);
});
test('selecting a notice marks only that notice read as the author and opens its opinion', async () => {
  const h = noticeHarness();
  await h.api.openNotice('done');
  assert.equal(h.calls[0].value.action, 'notification.read');
  assert.equal(h.calls[0].value.target, 'author');
  assert.deepEqual(Array.from(h.calls[0].value.data.ids), ['done']);
  assert.deepEqual(h.opened, ['f1']);
  assert.equal(h.ctx.cloud.notifications.find(n => n.id === 'done').read, true);
  assert.equal(h.ctx.cloud.notifications.find(n => n.id === 'reply').read, false);
});
test('failed read acknowledgement keeps the notice unread and prevents navigation', async () => {
  const h = noticeHarness(true);
  await h.api.openNotice('reply');
  assert.equal(h.ctx.cloud.notifications[0].read, false);
  assert.equal(h.ctx.noticeBusy, false);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.messages, ['저장 실패']);
});
function actionHarness() {
  const listeners = {}, calls = [], drafts = new Map(), statusDraft = new Map(), box = {value: '작성 중인 댓글'}, ctx = {
    view: 'fb:f1', cloud: {lmsLevel: 'admin'}, busy: false, feedbackDrafts: drafts, statusDraft, fbPop: 'status', keepFocus: '', succeed: true,
    $: () => ({addEventListener: (type, fn) => {listeners[type] = fn;}, querySelector: () => box}),
    fbOf: () => ({status: '진행중'}), render() {}, toast() {},
    act: async (action, data) => {calls.push({action, data}); return ctx.succeed;},
  };
  vm.createContext(ctx);
  vm.runInContext(between("  $('app').addEventListener('click', async e => {\n    if (!view.startsWith('fb:'))", "  $('app').addEventListener('click', e => {\n    const f = e.target.closest('[data-req-filter]')"), ctx);
  const click = (selector, dataset = {}) => listeners.click({target: {closest: s => s === selector ? {dataset} : null}});
  return {ctx, calls, drafts, statusDraft, box, click};
}
test('status change sends the optional comment and keeps the plain comment draft untouched', async () => {
  const h = actionHarness(); h.drafts.set('f1', h.box.value); h.statusDraft.set('f1', ' 답하고 닫을게요 ');
  await h.click('[data-fb-status]', {fbStatus: '닫힘'});
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), {action: 'feedback.status', data: {id: 'f1', status: '닫힘', text: '답하고 닫을게요'}});
  assert.equal(h.statusDraft.has('f1'), false);
  assert.equal(h.drafts.get('f1'), h.box.value);
  assert.equal(h.ctx.fbPop, '');
  await h.click('[data-fb-status]', {fbStatus: '반영됨'});
  assert.deepEqual(Object.keys(h.calls[1].data), ['id', 'status']);
});
test('comment save failures retain drafts; a successful comment clears only that draft', async () => {
  const h = actionHarness(); h.ctx.succeed = false;
  await h.click('[data-fb-send]');
  assert.equal(h.drafts.get('f1'), h.box.value);
  h.ctx.succeed = true;
  await h.click('[data-fb-send]');
  assert.equal(h.calls[1].action, 'feedback.comment');
  assert.equal(h.drafts.has('f1'), false);
});
function previewHarness(saved = new Map()) {
  const file = readFileSync(join(__dirname, 'v1_preview.py'), 'utf8');
  const start = file.indexOf("MOCK = r'''") + "MOCK = r'''".length;
  let mock = file.slice(start, file.indexOf("\n'''", start));
  const content = JSON.parse(readFileSync(join(__dirname, 'v1_content.json'), 'utf8'));
  mock = mock.replace('/*CONTENT*/', 'const CONTENT=' + JSON.stringify(content) + ';const SOURCE_LOG=[];');
  mock = mock.replace(/\}\)\(\);\s*$/, 'globalThis.previewAPI={update,context,feedbackNotices,ACCOUNTS};})();');
  const ctx = vm.createContext({window: {fetch: async () => {}}, document: {addEventListener() {}},
    localStorage: {getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v)},
    sessionStorage: {getItem() {}}, crypto: webcrypto, Response, URL, URLSearchParams});
  vm.runInContext(mock, ctx);
  return {api: ctx.previewAPI, saved};
}
test('preview reproduces comments/status notices, author privacy and persistent read state', () => {
  const h = previewHarness(), p = h.api, author = p.ACCOUNTS[1], admin = p.ACCOUNTS[0], other = p.ACCOUNTS[2];
  const base = p.feedbackNotices(author).length;
  p.update(author, {action: 'feedback.send', target: author.id, data: {step: 'space-walk', text: '確認'}});
  const id = p.context(author).myFeedback[0].id;
  assert.throws(() => p.update(other, {action: 'feedback.status', data: {id, status: '닫힘'}}));
  p.update(admin, {action: 'feedback.comment', data: {id, text: '回答'}});
  p.update(admin, {action: 'feedback.status', data: {id, status: '닫힘', text: '닫을게요'}});
  p.update(admin, {action: 'feedback.status', data: {id, status: '닫힘'}});
  assert.equal(p.feedbackNotices(author).length, base + 2);
  assert.equal(p.context(author).myFeedback[0].status, '닫힘');
  assert.equal(p.feedbackNotices(other).length, 0);
  const notice = p.feedbackNotices(author).find(n => n.feedback === id);
  assert.throws(() => p.update(other, {action: 'notification.read', data: {ids: [notice.id]}}));
  const before = JSON.stringify(p.context(author).learner);
  p.update(author, {action: 'notification.read', data: {ids: [notice.id]}});
  assert.equal(JSON.stringify(p.context(author).learner), before);
  const reloaded = previewHarness(h.saved).api;
  assert.equal(reloaded.feedbackNotices(author).find(n => n.id === notice.id).read, true);
  assert.equal(reloaded.context(author).myFeedback[0].comments.length, 2);
});
