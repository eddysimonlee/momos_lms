'use strict';
// Exercise the actual v1 navigation helpers and click handler with isolated course/record fixtures.
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const source = readFileSync(join(__dirname, 'v1.js'), 'utf8');
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
