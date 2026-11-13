'use strict';
// Exercise the actual v1 navigation helpers and click handler with isolated course/record fixtures.
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const source = readFileSync(join(__dirname, 'v1.js'), 'utf8');

test('preview uses server check moves and preserves inserted-topic records once', () => {
  const preview = readFileSync(join(__dirname, 'v1_preview.py'), 'utf8');
  const helper = preview.split('// >>> preview-kp-moves')[1].split('// <<< preview-kp-moves')[0];
  const moves = JSON.parse(execFileSync('python3', ['-c', 'import json,onboarding;print(json.dumps(onboarding.KP_MOVES))'], {cwd: __dirname, encoding: 'utf8'}));
  const context = vm.createContext({KP_MOVES: moves});
  vm.runInContext(helper + ';globalThis.fit = fitMovedChecks;', context);
  for (const status of ['practice', 'done']) {
    const r = {status, self: [true, false, true, false, true], teacher: [true, true, false, true, false],
      done: status === 'done' ? '2026-11-01' : null, memo: 'keep', history: [{event: 'keep'}]};
    for (const key of ['selfAt', 'teacherAt', 'selfBy', 'teacherBy', 'teacherName', 'teacherWhen']) r[key] = Array.from({length: 5}, (_, i) => `${key}-${i}`);
    const before = structuredClone(r), room = {records: {'safety-greet': r}};
    assert.equal(context.fit(room), true);
    for (const key of ['self', 'teacher', 'selfAt', 'teacherAt', 'selfBy', 'teacherBy', 'teacherName', 'teacherWhen']) {
      const empty = key === 'teacher' ? status === 'done' : key === 'self' ? false : null;
      assert.deepEqual(Array.from(r[key]), [...before[key].slice(0, 3), empty, ...before[key].slice(3)]);
    }
    for (const key of ['status', 'done', 'memo', 'history']) assert.deepEqual(r[key], before[key]);
    const once = JSON.stringify(r);
    assert.equal(context.fit(room), false);
    assert.equal(JSON.stringify(r), once);
  }
  const fresh = {records: {'safety-greet': {status: 'ready', teacher: Array(6).fill(false)}}};
  context.fit(fresh);
  assert.deepEqual(fresh.records['safety-greet'].teacher, Array(6).fill(false));
});
test('preview archives split OP1 checks and completion without copying them into four new topics', () => {
  const preview = readFileSync(join(__dirname, 'v1_preview.py'), 'utf8');
  const helper = preview.split('// >>> preview-kp-moves')[1].split('// <<< preview-kp-moves')[0];
  const moves = JSON.parse(execFileSync('python3', ['-c', 'import json,onboarding;print(json.dumps(onboarding.KP_MOVES))'], {cwd: __dirname, encoding: 'utf8'}));
  const context = vm.createContext({KP_MOVES: moves});
  vm.runInContext(helper + ';globalThis.fit = fitMovedChecks;', context);
  for (const status of ['ready', 'practice', 'review', 'done']) {
    const r = {status, teacher: status === 'ready' ? [false, false, false] : status === 'done' ? [true, true, true] : [true, false, true],
      self: [true, false, true], checkBasis: 'older-check-basis', done: status === 'done' ? '2026-11-01' : null,
      request: status === 'review' ? '2026-10-31' : null, history: [{event: 'keep'}], memo: 'keep', start: '2026-10-30'};
    if (status === 'done') Object.assign(r, {completedBy: 'before', completedByName: '이전 확인자', trainedBy: {name: '교육자'}});
    for (const key of ['selfAt', 'teacherAt', 'selfBy', 'teacherBy', 'teacherName', 'teacherWhen']) r[key] = Array.from({length: 3}, (_, i) => `${key}-${i}`);
    const before = structuredClone(r), room = {records: {'esp-shift': r}};
    assert.equal(context.fit(room), true);
    for (const key of ['self', 'teacher', 'selfAt', 'teacherAt', 'selfBy', 'teacherBy', 'teacherName', 'teacherWhen']) {
      const empty = ['self', 'teacher'].includes(key) ? false : null;
      assert.deepEqual(Array.from(r[key]), [empty, empty, empty, empty, ...before[key].slice(1)]);
    }
    const archived = JSON.parse(JSON.stringify(r.history.at(-1)));
    for (const [key, value] of Object.entries(before)) if (key !== 'history') assert.deepEqual(archived[key], value);
    assert.deepEqual(JSON.parse(JSON.stringify(r.history.slice(0, -1))), before.history);
    assert.deepEqual(archived.checkTexts, moves['esp-shift'][3].previousChecks);
    assert.equal(archived.splitMigration, moves['esp-shift'][0]);
    assert.ok(archived.splitAt);
    assert.equal(r.status, ['review', 'done'].includes(status) ? 'practice' : status);
    if (['review', 'done'].includes(status)) { assert.equal(r.done, null); assert.equal(r.request, null); assert.equal(r.completedBy, undefined); }
    const once = JSON.stringify(r);
    assert.equal(context.fit(room), false);
    assert.equal(JSON.stringify(r), once);
  }
  for (const status of ['ready', 'done']) {
    const r = {status, teacher: Array(6).fill(status === 'done'), history: []}, room = {records: {'esp-shift': r}};
    context.fit(room);
    assert.equal(r.status, status); assert.equal(r.history.length, 0);
    assert.deepEqual(r.teacher, Array(6).fill(status === 'done'));
  }
});

test('preview splits weekly hygiene without copying old checks or overwriting new weekday records', () => {
  const preview = readFileSync(join(__dirname, 'v1_preview.py'), 'utf8');
  const helper = preview.split('// >>> preview-kp-moves')[1].split('// <<< preview-kp-moves')[0];
  const moves = JSON.parse(execFileSync('python3', ['-c', 'import json,onboarding;print(json.dumps(onboarding.KP_MOVES))'], {cwd: __dirname, encoding: 'utf8'}));
  const context = vm.createContext({KP_MOVES: moves});
  vm.runInContext(helper + ';globalThis.fit = fitMovedChecks;', context);
  for (const status of ['ready', 'practice', 'review', 'done']) {
    const old = {status, teacher: Array(9).fill(true), self: Array(9).fill(false), teacherAt: Array(9).fill('2026-11-12'),
      teacherBy: Array(9).fill('old-trainer'), teacherName: Array(9).fill('이전 교육자'), teacherWhen: Array(9).fill('2026-11-12T10:00:00Z'),
      done: status === 'done' ? '2026-11-12' : null, request: status === 'review' ? '2026-11-12' : null,
      completedBy: 'old-trainer', memo: 'keep memo', history: [{event: 'keep'}]};
    const before = structuredClone(old), existing = {status: 'done', teacher: Array(8).fill(true), history: []};
    const room = {records: {'floor-weekly': old, 'floor-weekly-tue': existing}};
    assert.equal(context.fit(room), true);
    assert.deepEqual(Array.from(old.teacher), Array(6).fill(false));
    assert.deepEqual(Array.from(old.teacherWhen), Array(6).fill(null));
    assert.equal(old.status, ['done', 'review'].includes(status) ? 'practice' : status);
    const archived = old.history.at(-1);
    assert.equal(archived.lessonTitle, '요일별 주간 위생 업무');
    assert.equal(archived.checkTexts.length, 9);
    for (const key of Object.keys(before).filter(k => k !== 'history')) assert.deepEqual(JSON.parse(JSON.stringify(archived[key])), before[key]);
    assert.equal(room.records['floor-weekly-tue'], existing);
    for (const [id, n] of Object.entries(moves['floor-weekly'][3].addedSteps)) {
      if (id === 'floor-weekly-tue') continue;
      assert.equal(room.records[id].status, 'ready');
      assert.deepEqual(Array.from(room.records[id].teacher), Array(n).fill(false));
    }
    const once = JSON.stringify(room);
    assert.equal(context.fit(room), false);
    assert.equal(JSON.stringify(room), once);
  }
});

test('tool guide renders numbered tools as an image caption, including no-tools and escaped content', () => {
  const helper = source.split('// >>> tool-guide')[1].split('// <<< tool-guide')[0];
  const context = vm.createContext({content: {photos: {guide: {src: 'v1_photos/fixture.jpg', caption: '제조 도구 안내'}}}});
  const escapeLine = source.split('\n').find(line => line.trimStart().startsWith('const esc ='));
  vm.runInContext(escapeLine + '\n' + helper + '\nglobalThis.renderGuide = toolGuideHTML;', context);
  const html = context.renderGuide({toolGuide: {photo: 'guide', numbers: [2, 3], names: ['거름망', '스푼']}});
  assert.ok(html.indexOf('<img ') < html.indexOf('[사용 도구 목록]'));
  assert.match(html, /<figcaption>\[사용 도구 목록\] \(2 거름망, 3 스푼\)<\/figcaption>/);
  assert.doesNotMatch(html, /checkbox|data-mark|data-kp|v1-note/);
  const empty = context.renderGuide({toolGuide: {photo: 'guide', numbers: [], names: []}});
  assert.match(empty, /\[사용 도구 목록\] \(사용 도구 없음\)/);
  assert.equal(context.renderGuide({}), '');
  assert.equal(context.renderGuide({toolGuide: {photo: 'missing'}}), '');
  const escaped = context.renderGuide({toolGuide: {photo: 'guide', numbers: [1], names: ['<script>bad</script>']}});
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /&lt;script&gt;/);
});

const line = start => {
  const found = source.split('\n').find(text => text.trimStart().startsWith(start));
  assert.ok(found, start);
  return found;
};
function harness(returnView = 'all', filt = null) {
  const content = {
    filters: {position: ['bar', 'floor', 'solo']},
    units: [{title: 'Fixture', stage: {order: 1}, steps: [
      {id: 'first', position: ['floor']},
      {id: 'second', position: ['bar']},
      {id: 'third', position: ['floor', 'solo'], lessonStatus: 'planned'},
      {id: 'fourth', position: ['bar']},
      {id: 'last', position: ['floor']},
    ]}],
  };
  const context = vm.createContext({content, returnView, filt, FKIND: {position: '포지션'}});
  vm.runInContext([
    line('const esc ='), line('const steps ='), line('const stepIndex ='), line('const unitOf ='),
    line('const validFilter ='), line('const matches ='),
    source.slice(source.indexOf('  const nextOf ='), source.indexOf('  function setFilter(')),
    'globalThis.api = {steps, prevOf, nextOf, stepActions};',
  ].join('\n'), context);
  return {context, api: context.api};
}
test('unfiltered previous/next follow the course order across every item', () => {
  const {api} = harness('person', {k: 'position', v: 'bar'});
  const steps = api.steps();
  steps.forEach((step, i) => {
    assert.equal(api.prevOf(step)?.id, steps[i - 1]?.id);
    assert.equal(api.nextOf(step)?.id, steps[i + 1]?.id);
  });
});
test('first/last items hide only the unavailable direction', () => {
  const {api} = harness();
  const first = api.stepActions(api.steps()[0]);
  const last = api.stepActions(api.steps().at(-1));
  assert.doesNotMatch(first, /‹ 이전 항목/);
  assert.match(first, /data-step="second">다음 항목 ›/);
  assert.match(last, /data-step="fourth">‹ 이전 항목/);
  assert.doesNotMatch(last, /다음 항목 ›/);
});
test('filtered routes skip excluded items in both directions and hide previous at the route start', () => {
  const {api} = harness('all', {k: 'position', v: 'bar'});
  const second = api.steps()[1], fourth = api.steps()[3];
  assert.equal(api.prevOf(second), undefined);
  assert.equal(api.nextOf(second).id, 'fourth');
  assert.equal(api.prevOf(fourth).id, 'second');
  assert.equal(api.nextOf(fourth), undefined);
  assert.doesNotMatch(api.stepActions(second), /‹ 이전 항목/);
});
test('a route containing one item has no navigation; invalid filters fall back to the full route', () => {
  const {api} = harness('all', {k: 'position', v: 'solo'});
  assert.equal(api.stepActions(api.steps()[2]), '');
  const invalid = harness('all', {k: 'position', v: 'missing'}).api;
  assert.equal(invalid.prevOf(invalid.steps()[2]).id, 'second');
  assert.equal(invalid.nextOf(invalid.steps()[2]).id, 'fourth');
});
test('planned detail pages expose the same adjacent items', () => {
  const {context, api} = harness();
  context.STATUS = {planned: '준비 중'};
  vm.runInContext(source.slice(source.indexOf('  function plannedView('), source.indexOf('  function stepView(')) +
    '\nglobalThis.plannedDetail = plannedView;', context);
  const html = context.plannedDetail(api.steps()[2]);
  assert.match(html, /data-step="second">‹ 이전 항목/);
  assert.match(html, /data-step="fourth">다음 항목 ›/);
});
test('completion controls retain their attributes alongside navigation', () => {
  const {api} = harness();
  for (const action of [
    '<button class="v1-btn primary" data-close disabled>완료</button>',
    '<button class="v1-btn" data-reopen>완료 취소</button>',
  ]) {
    const html = api.stepActions(api.steps()[2], action);
    assert.ok(html.includes(action));
    assert.match(html, /data-step="second">‹ 이전 항목/);
    assert.match(html, /data-step="fourth">다음 항목 ›/);
  }
});
test('previous/next clicks keep route context and do not write check or completion records', () => {
  const {context, api} = harness('all', {k: 'position', v: 'floor'});
  const records = {third: {status: 'done', teacher: [true], done: '2026-11-06', history: []}};
  const before = JSON.stringify(records);
  const buttons = ['first', 'last'].map(id => ({dataset: {step: id}}));
  let renders = 0;
  Object.assign(context, {
    view: 'step:third', stageSel: 1, cloud: {learner: {records}},
    app: {querySelectorAll: selector => {assert.equal(selector, '[data-step]'); return buttons;}},
    render: () => {renders++;}, apiRequest: () => {throw new Error('Navigation must not save records');},
  });
  vm.runInContext(line("app.querySelectorAll('[data-step]').forEach"), context);
  buttons.forEach(button => {
    button.onclick();
    assert.equal(context.view, 'step:' + button.dataset.step);
    assert.equal(context.returnView, 'all');
    assert.equal(context.filt.v, 'floor');
    assert.equal(JSON.stringify(records), before);
  });
  assert.equal(renders, 2);
  assert.equal(api.prevOf(api.steps()[2]).id, 'first');
});
