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
function feedbackHarness(admin = true, done = false) {
  const f = {id: 'f1', name: '작성자', step: 'space-walk', at: '2026-11-06', text: '<script>의견</script>',
    comments: [{id: 'c1', name: '관리자', at: '2026-11-06', text: '<b>답변</b>'}],
    ...(done ? {status: 'done', resolved: {at: '2026-11-06'}} : {})};
  const context = vm.createContext({
    cloud: {lmsLevel: admin ? 'admin' : null, ...(admin ? {feedback: [f]} : {myFeedback: [f]})},
    feedbackDrafts: new Map([['f1', '<답변 초안>']]), busy: false,
    steps: () => [{id: 'space-walk', title: '교육 항목'}], stepIndex: () => 2,
    kstAt: x => String(x || ''), reqOfKey: () => null, reqHead: () => ({name: ''}),
  });
  vm.runInContext(line('const esc =') + '\n' + between('  const fbOf =', '  const openFb =') + '\nglobalThis.detail = fbView;', context);
  return context;
}
test('authors reuse the detail with escaped comments but no admin controls/ticket data', () => {
  const context = feedbackHarness(false, true), html = context.detail('f1');
  assert.match(html, /&lt;script&gt;의견/);
  assert.match(html, /&lt;b&gt;답변/);
  assert.match(html, /data-comment-id="c1"/);
  assert.match(html, /반영 완료됨/);
  assert.match(html, /data-step="space-walk">수정된 교육 보기/);
  assert.doesNotMatch(html, /data-fb-send|data-fb-resolve|수정 요청 티켓|textarea/);
  assert.match(context.detail('another-author'), /의견을 찾지 못했어요/);
});
test('admin completion control is independent of the comment draft and disabled after completion', () => {
  const before = feedbackHarness(true), html = before.detail('f1');
  assert.match(html, /data-fb-comment[^>]*>&lt;답변 초안&gt;<\/textarea>/);
  assert.match(html, /data-fb-send >댓글 달기/);
  assert.match(html, /data-fb-resolve >반영 완료/);
  const after = feedbackHarness(true, true).detail('f1');
  assert.match(after, /data-fb-resolve disabled>반영 완료됨/);
  assert.match(after, /data-fb-send >댓글 달기/);
});
function noticeHarness(fail = false) {
  const elements = new Map(), calls = [], opened = [], messages = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {hidden: true, innerHTML: '', textContent: '',
      setAttribute() {}, focus() {}, querySelector: () => ({scrollIntoView() {}})});
    return elements.get(id);
  };
  const ctx = {
    cloud: {user: {id: 'author'}, target: 'another-learner', learner: {revision: 3}, rootRevision: 4,
      notifications: [
        {id: 'reply', kind: 'feedback.reply', feedback: 'f1', comment: 'c1', step: 'space-walk', title: '答 <script>', detail: '교육 항목', read: false},
        {id: 'done', kind: 'feedback.resolved', feedback: 'f1', step: 'space-walk', title: '반영되었습니다.', detail: '교육 항목', read: false},
        {id: 'legacy', title: '기존 다른 종류 알림', read: false},
      ]},
    noticeBusy: false, busy: false, $: element, kstAt: () => '2026-11-06', uid: () => 'request-id',
    steps: () => [{id: 'space-walk'}], unitOf: () => ({stage: {order: 1}}),
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
  vm.runInContext(line('const esc =') + '\n' + between('  const opinionNotices =', "  $('v1NoticeToggle').onclick") +
    '\nglobalThis.noticeAPI = {drawNotices,openNotice};', ctx);
  return {ctx, calls, opened, messages, element, api: ctx.noticeAPI};
}
test('opening the list shows only opinion notifications without marking any read', () => {
  const h = noticeHarness(); h.element('v1Notices').hidden = false;
  h.api.drawNotices();
  assert.equal(h.element('v1NoticeCount').textContent, 2);
  assert.match(h.element('v1NoticeList').innerHTML, /&lt;script&gt;/);
  assert.match(h.element('v1NoticeList').innerHTML, /수정된 교육 보기/);
  assert.doesNotMatch(h.element('v1NoticeList').innerHTML, /기존 다른 종류/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.ctx.cloud.notifications.filter(n => n.read).length, 0);
});
test('reply selection marks only that notice read as the author and opens its opinion', async () => {
  const h = noticeHarness();
  await h.api.openNotice('reply');
  assert.equal(h.calls[0].value.action, 'notification.read');
  assert.equal(h.calls[0].value.target, 'author');
  assert.deepEqual(Array.from(h.calls[0].value.data.ids), ['reply']);
  assert.deepEqual(h.opened, ['f1']);
  assert.equal(h.ctx.cloud.target, 'author');
  assert.equal(h.ctx.cloud.notifications.find(n => n.id === 'reply').read, true);
  assert.equal(h.ctx.cloud.notifications.find(n => n.id === 'done').read, false);
});
test('completion CTA opens the exact education item with a return path to the opinion', async () => {
  const h = noticeHarness();
  await h.api.openNotice('done', true);
  assert.equal(h.ctx.view, 'step:space-walk');
  assert.equal(h.ctx.returnView, 'fb:f1');
  assert.equal(h.ctx.stageSel, 1);
  assert.deepEqual(h.opened, []);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].value.action, 'notification.read');
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
    view: 'fb:f1', cloud: {lmsLevel: 'admin'}, busy: false, feedbackDrafts: drafts, succeed: true, done: false,
    $: () => ({addEventListener: (type, fn) => {listeners[type] = fn;}, querySelector: () => box}),
    fbOf: () => ({status: ctx.done ? 'done' : 'open'}), render() {}, toast() {},
    act: async (action, data) => {calls.push({action, data}); return ctx.succeed;},
  };
  vm.createContext(ctx);
  vm.runInContext(between("  $('app').addEventListener('click', async e => {\n    if (!view.startsWith('fb:'))", "  $('app').addEventListener('click', e => {\n    const f = e.target.closest('[data-req-filter]')"), ctx);
  const click = selector => listeners.click({target: {closest: s => s === selector ? {} : null}});
  return {ctx, calls, drafts, box, click};
}
test('complete does not submit an unsent comment; duplicate completion is blocked', async () => {
  const h = actionHarness(); h.drafts.set('f1', h.box.value);
  await h.click('[data-fb-resolve]');
  assert.equal(h.calls[0].action, 'feedback.resolve');
  assert.deepEqual(Object.keys(h.calls[0].data), ['id']);
  assert.equal(h.drafts.get('f1'), h.box.value);
  h.ctx.done = true; await h.click('[data-fb-resolve]');
  assert.equal(h.calls.length, 1);
});
test('comment save failures retain drafts; a successful comment clears only that draft', async () => {
  const h = actionHarness(); h.ctx.succeed = false;
  await h.click('[data-fb-send]');
  assert.equal(h.drafts.get('f1'), h.box.value);
  h.ctx.succeed = true; h.ctx.done = true;
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
test('preview reproduces independent replies/completion, author privacy and persistent read state', () => {
  const h = previewHarness(), p = h.api, author = p.ACCOUNTS[1], admin = p.ACCOUNTS[0], other = p.ACCOUNTS[2];
  p.update(author, {action: 'feedback.send', target: author.id, data: {step: 'space-walk', text: '確認'}});
  const id = p.context(author).myFeedback[0].id;
  assert.throws(() => p.update(other, {action: 'feedback.resolve', data: {id}}));
  p.update(admin, {action: 'feedback.comment', data: {id, text: '回答'}});
  p.update(admin, {action: 'feedback.resolve', data: {id}});
  p.update(admin, {action: 'feedback.resolve', data: {id}});
  assert.equal(p.feedbackNotices(author).length, 2);
  assert.equal(p.feedbackNotices(other).length, 0);
  const notice = p.feedbackNotices(author)[0];
  assert.throws(() => p.update(other, {action: 'notification.read', data: {ids: [notice.id]}}));
  const before = JSON.stringify(p.context(author).learner);
  p.update(author, {action: 'notification.read', data: {ids: [notice.id]}});
  assert.equal(JSON.stringify(p.context(author).learner), before);
  const reloaded = previewHarness(h.saved).api;
  assert.equal(reloaded.feedbackNotices(author).find(n => n.id === notice.id).read, true);
  assert.equal(reloaded.context(author).myFeedback[0].comments.length, 1);
});
