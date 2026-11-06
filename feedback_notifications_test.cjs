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
const FB = {REQ_ST: {'진행중': 'b', '반영됨': 'g', '반려': 'r'}};
function feedbackHarness(admin = true, pop = '') {
  const f = {id: 'f1', name: '작성자', step: 'space-walk', at: '2026-11-06', text: '<script>의견</script>',
    comments: [{id: 'c1', name: '관리자', at: '2026-11-06', text: '<b>답변</b>'}]};
  const context = vm.createContext({...FB,
    cloud: {lmsLevel: admin ? 'admin' : null, ...(admin ? {feedback: [f], contentRequests: [{no: 'REQ-1', status: '진행중', target: {title: 'A'}}]} : {myFeedback: [f]})},
    feedbackDrafts: new Map([['f1', '<답변 초안>']]), busy: false,
    steps: () => [{id: 'space-walk', title: '교육 항목'}], stepIndex: () => 2,
    kstAt: x => String(x || ''), reqOfKey: () => null, reqHead: () => ({name: 'A'}),
  });
  vm.runInContext(line('const esc =') + '\n' + between('  const fbOf =', '  const openFb =') + `\nfbPop = ${JSON.stringify(pop)};\nglobalThis.detail = fbView;`, context);
  return context;
}
test('authors see the opinion, comments and the education title link, with no status, admin controls or ticket data', () => {
  const context = feedbackHarness(false), html = context.detail('f1');
  assert.match(html, /&lt;script&gt;의견/);
  assert.match(html, /&lt;b&gt;답변/);
  assert.match(html, /data-comment-id="c1"/);
  assert.match(html, /class="v1-fbtitle" data-step="space-walk">3\. 교육 항목/);
  assert.doesNotMatch(html, /상태|수정된 교육 보기|data-fb-send|data-fb-pop|수정 요청 티켓|textarea/);
  assert.match(context.detail('another-author'), /의견을 찾지 못했어요/);
});
test('admins get the ticket link entry and the comment box, but no status controls', () => {
  const closed = feedbackHarness(true).detail('f1');
  assert.match(closed, /data-fb-pop="link"/);
  assert.doesNotMatch(closed, /data-fb-pop="status"|data-fb-pick|data-fb-status|상태/);
  assert.match(closed, /data-fb-comment[^>]*>&lt;답변 초안&gt;<\/textarea>/);
  assert.match(closed, /data-fb-send >댓글 달기/);
  assert.match(feedbackHarness(true, 'link').detail('f1'), /<option value="REQ-1">/);
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
        {id: 'done', kind: 'feedback.reply', feedback: 'f1', comment: 'c2', step: 'space-walk', title: '댓글', detail: '교육 항목', text: '반영했어요', date: iso(0), read: false},
        {id: 'old', kind: 'feedback.reply', feedback: 'f1', step: 'space-walk', title: '오래된 알림', text: '오래된 알림', detail: '교육 항목', date: iso(40), read: false},
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
  assert.match(html, /의견 댓글/);
  assert.doesNotMatch(html, /상태/);
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
  const listeners = {}, calls = [], drafts = new Map(), box = {value: '작성 중인 댓글'}, ctx = {
    view: 'fb:f1', cloud: {lmsLevel: 'admin'}, busy: false, feedbackDrafts: drafts, fbPop: '', keepFocus: '', succeed: true,
    $: () => ({addEventListener: (type, fn) => {listeners[type] = fn;}, querySelector: () => box}),
    fbOf: () => ({}), render() {}, toast() {},
    act: async (action, data) => {calls.push({action, data}); return ctx.succeed;},
  };
  vm.createContext(ctx);
  vm.runInContext(between("  $('app').addEventListener('click', async e => {\n    if (!view.startsWith('fb:'))", "  $('app').addEventListener('click', e => {\n    const f = e.target.closest('[data-req-filter]')"), ctx);
  const click = (selector, dataset = {}) => listeners.click({target: {closest: s => s === selector ? {dataset} : null}});
  return {ctx, calls, drafts, box, click};
}
test('the ticket link entry toggles its card without saving anything', async () => {
  const h = actionHarness();
  await h.click('[data-fb-pop]', {fbPop: 'link'});
  assert.equal(h.ctx.fbPop, 'link');
  await h.click('[data-fb-pop]', {fbPop: 'link'});
  assert.equal(h.ctx.fbPop, '');
  assert.equal(h.calls.length, 0);
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
test('preview reproduces comment notices, author privacy and persistent read state', () => {
  const h = previewHarness(), p = h.api, author = p.ACCOUNTS[1], admin = p.ACCOUNTS[0], other = p.ACCOUNTS[2];
  const base = p.feedbackNotices(author).length;
  p.update(author, {action: 'feedback.send', target: author.id, data: {step: 'space-walk', text: '確認'}});
  const id = p.context(author).myFeedback[0].id;
  assert.throws(() => p.update(other, {action: 'feedback.comment', data: {id, text: 'x'}}));
  assert.throws(() => p.update(admin, {action: 'feedback.status', data: {id, status: '닫힘'}}));
  p.update(admin, {action: 'feedback.comment', data: {id, text: '回答'}});
  p.update(admin, {action: 'feedback.link', data: {id, ticket: 'REQ-1', on: true}});
  assert.equal(p.feedbackNotices(author).length, base + 1);
  assert.equal(p.feedbackNotices(other).length, 0);
  assert.equal('status' in p.context(author).myFeedback[0], false);
  const notice = p.feedbackNotices(author).find(n => n.feedback === id);
  assert.throws(() => p.update(other, {action: 'notification.read', data: {ids: [notice.id]}}));
  const before = JSON.stringify(p.context(author).learner);
  p.update(author, {action: 'notification.read', data: {ids: [notice.id]}});
  assert.equal(JSON.stringify(p.context(author).learner), before);
  const reloaded = previewHarness(h.saved).api;
  assert.equal(reloaded.feedbackNotices(author).find(n => n.id === notice.id).read, true);
  assert.equal(reloaded.context(author).myFeedback[0].comments.length, 1);
});
