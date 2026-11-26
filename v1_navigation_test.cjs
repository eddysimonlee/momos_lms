'use strict';
// Exercise the actual v1 navigation helpers and click handler with isolated course/record fixtures.
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const source = readFileSync(join(__dirname, 'v1.js'), 'utf8');

function alignmentCaptionHarness() {
  const helper = source.split('// >>> photo-alignment-caption')[1].split('// <<< photo-alignment-caption')[0];
  const escapeLine = source.split('\n').find(line => line.trimStart().startsWith('const esc ='));
  const context = vm.createContext({});
  vm.runInContext(escapeLine + '\n' + helper + ';globalThis.caption=photoCaptionHTML;', context);
  return context.caption;
}

test('rounding photos show their area and original alignment criteria inline without a heading', () => {
  const caption = alignmentCaptionHarness();
  const content = JSON.parse(readFileSync(join(__dirname, 'v1_content.json'), 'utf8'));
  const steps = content.units.flatMap(u => u.steps), step = steps.find(s => s.id === 'floor-round');
  assert.equal(steps[11].id, step.id);
  const rows = content.sections['라운딩-점검-기준|6'].tables[0].rows;
  const before = JSON.stringify(content);
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  step.photos.slice(0, 5).forEach((pid, i) => {
    const p = content.photos[pid], html = caption(p, step.id);
    assert.equal(p.row.cells[0], rows[i][0]);
    assert.equal(html, `<figcaption>${escape(p.caption)} · ${escape(rows[i][1])}</figcaption>`);
  });
  for (const s of steps) for (const pid of s.photos) {
    const p = content.photos[pid];
    if (s.id === step.id && step.photos.slice(0, 5).includes(pid)) continue;
    assert.equal(caption(p, s.id), p.hideCaption ? '' : `<figcaption>${escape(p.caption)}</figcaption>`);
  }
  assert.equal(JSON.stringify(content), before);
});

test('alignment captions preserve original line breaks and escape text without affecting other lessons', () => {
  const caption = alignmentCaptionHarness();
  const p = {caption:'구역 <a>', row:{header:['정렬 기준','구역'], cells:['첫째\n둘째 <script>\r\n셋째 & 마지막','구역']}};
  assert.equal(caption(p,'floor-round'), '<figcaption>구역 &lt;a&gt; · 첫째<br>둘째 &lt;script&gt;<br>셋째 &amp; 마지막</figcaption>');
  assert.equal(caption(p,'other-step'), '<figcaption>구역 &lt;a&gt;</figcaption>');
  assert.equal(caption({...p,hideCaption:true},'floor-round'), '');
  assert.equal(caption({caption:'기존 사진'},'floor-round'), '<figcaption>기존 사진</figcaption>');
});

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
test('preview transfers facility checks into separate sessions without overwriting saved targets', () => {
  const preview=readFileSync(join(__dirname,'v1_preview.py'),'utf8');
  const helper=preview.split('// >>> preview-kp-moves')[1].split('// <<< preview-kp-moves')[0];
  const moves=JSON.parse(execFileSync('python3',['-c','import json,onboarding;print(json.dumps(onboarding.KP_MOVES))'],{cwd:__dirname,encoding:'utf8'}));
  const ctx=vm.createContext({KP_MOVES:moves});vm.runInContext(helper+';globalThis.fit=fitMovedChecks;',ctx);
  const ids=['marine-facilities','marine-automatic-door','marine-folding-door','marine-flood-barrier'];
  for(const status of ['ready','practice','review','done']){
    const r={status,teacher:status==='done'?[true,true,true,true]:[false,true,false,true],teacherBy:['a','b','c','d'],teacherWhen:['t1','t2','t3','t4'],done:status==='done'?'2026-11-25':null,history:[]};
    const before=structuredClone(r),room={records:{[ids[0]]:r}};ctx.fit(room);
    ids.forEach((id,i)=>{const out=room.records[id];assert.deepEqual(Array.from(out.teacher),[before.teacher[i]]);assert.deepEqual(Array.from(out.teacherBy),[before.teacherBy[i]]);assert.equal(out.status,status);assert.equal(out.done,before.done);assert.deepEqual(Array.from(out.history[0].teacher),before.teacher);});
    const once=JSON.stringify(room);ctx.fit(room);assert.equal(JSON.stringify(room),once);
  }
  const saved={status:'practice',teacher:[false],memo:'keep'},room={records:{[ids[0]]:{status:'done',teacher:Array(4).fill(true),history:[]},[ids[1]]:saved}};
  ctx.fit(room);assert.equal(room.records[ids[1]],saved);assert.equal(saved.status,'practice');assert.equal(saved.memo,'keep');
});

test('preview splits Marine sound tasks without copying completion and preserves the first checker', () => {
  const preview = readFileSync(join(__dirname, 'v1_preview.py'), 'utf8');
  const helper = preview.split('// >>> preview-kp-moves')[1].split('// <<< preview-kp-moves')[0];
  const moves = JSON.parse(execFileSync('python3', ['-c', 'import json,onboarding;print(json.dumps(onboarding.KP_MOVES))'], {cwd: __dirname, encoding: 'utf8'}));
  const ctx = vm.createContext({KP_MOVES:moves});
  vm.runInContext(helper + ';globalThis.fit=fitMovedChecks;',ctx);
  const r={status:'done',teacher:[true,true,true],teacherBy:['a','b','c'],teacherWhen:['t1','t2','t3'],done:'2026-11-25',completedBy:'c',history:[]};
  const before=structuredClone(r),room={records:{'marine-sound':r}};
  ctx.fit(room);
  assert.deepEqual(Array.from(r.teacher),[true,...Array(7).fill(false)]);
  assert.deepEqual(Array.from(r.teacherBy),['a',...Array(7).fill(null)]);
  assert.deepEqual(Array.from(r.teacherWhen),['t1',...Array(7).fill(null)]);
  assert.equal(r.status,'practice');assert.equal(r.done,null);
  assert.deepEqual(Array.from(r.history[0].teacher),before.teacher);
  assert.equal(r.history[0].completedBy,'c');
  r.teacher[3]=true;
  const once=JSON.stringify(r);ctx.fit(room);assert.equal(JSON.stringify(r),once);
  const fresh={records:{'marine-sound':{status:'done',teacher:Array(8).fill(true),done:'2026-11-26',history:[]}}};
  ctx.fit(fresh);assert.equal(fresh.records['marine-sound'].status,'done');assert.deepEqual(fresh.records['marine-sound'].teacher,Array(8).fill(true));
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

test('preview preserves combined grinder evidence and never resets new same-length completions', () => {
  const preview = readFileSync(join(__dirname, 'v1_preview.py'), 'utf8');
  const helper = preview.split('// >>> preview-kp-moves')[1].split('// <<< preview-kp-moves')[0];
  const moves = JSON.parse(execFileSync('python3', ['-c', 'import json,onboarding;print(json.dumps(onboarding.KP_MOVES))'], {cwd: __dirname, encoding: 'utf8'}));
  const context = vm.createContext({KP_MOVES: moves});
  vm.runInContext(helper + ';globalThis.fit = fitMovedChecks;', context);
  const old = {status: 'done', teacher: [true, true, true, true], teacherBy: ['retired', 'retired', 'retired', 'retired'],
    teacherWhen: ['t1', 't2', 't3', 't4'], completedBy: 'retired', completedByName: '이전 확인자', done: '2026-11-20', history: []};
  const before = structuredClone(old), existing = {status: 'done', teacher: [true, true, true, true], history: []};
  const room = {records: {'grinder-blade': old, 'grinder-blade-robur-s': existing}};
  context.fit(room);
  const archive = JSON.parse(JSON.stringify(old.history.at(-1)));
  for (const [key, value] of Object.entries(before)) if (key !== 'history') assert.deepEqual(archive[key], value);
  assert.equal(archive.lessonTitle, '그라인더 날 분해·청소');
  assert.deepEqual(Array.from(old.teacher), [false, false, false]);
  assert.equal(old.status, 'practice');
  assert.equal(room.records['grinder-blade-robur-s'], existing);
  assert.deepEqual(Array.from(room.records['grinder-blade-major-vp'].teacher), [false, false, false]);
  Object.assign(old, {status: 'done', teacher: [true, true, true], done: '2026-11-24'});
  const once = JSON.stringify(room);
  assert.equal(context.fit(room), false);
  assert.equal(JSON.stringify(room), once);
  const blank = preview.split('  function blank(join) {')[1].split('  function fresh()')[0];
  vm.runInContext('const STEPS={"grinder-blade":{keyPoints:[1,2,3]}}; const N=s=>s.keyPoints.map(()=>null); function blank(join){' + blank + ';globalThis.blank=blank;', context);
  const fresh = context.blank('2026-11-24');
  fresh.records['grinder-blade'].status = 'done';
  context.fit(fresh);
  assert.equal(fresh.records['grinder-blade'].status, 'done');
  assert.equal(fresh.records['grinder-blade'].history.length, 0);
});

test('preview removes only first model topic and preserves the other checkers and completion', () => {
  const preview = readFileSync(join(__dirname, 'v1_preview.py'), 'utf8');
  const helper = preview.split('// >>> preview-kp-moves')[1].split('// <<< preview-kp-moves')[0];
  const moves = JSON.parse(execFileSync('python3', ['-c', 'import json,onboarding;print(json.dumps(onboarding.KP_MOVES))'], {cwd: __dirname, encoding: 'utf8'}));
  const context = vm.createContext({KP_MOVES: moves});
  vm.runInContext(helper + ';globalThis.fit=fitMovedChecks;', context);
  for (const id of ['grinder-blade', 'grinder-blade-robur-s', 'grinder-blade-major-vp']) {
    const r = {status:'done', teacher:[true,true,true,true], self:[false,true,false,true],
      teacherName:['a','b','c','d'], teacherWhen:['t0','t1','t2','t3'], completedBy:'retired',
      done:'2026-11-20', history:[], kpMoves:id==='grinder-blade'?[moves[id][0]]:[]};
    const before=structuredClone(r), room={records:{[id]:r}};
    context.fit(room);
    assert.deepEqual(Array.from(r.teacher),before.teacher.slice(1));
    assert.deepEqual(Array.from(r.teacherName),before.teacherName.slice(1));
    assert.deepEqual(Array.from(r.teacherWhen),before.teacherWhen.slice(1));
    assert.equal(r.status,'done'); assert.equal(r.done,before.done); assert.equal(r.completedBy,'retired');
    const archive=JSON.parse(JSON.stringify(r.history.at(-1)));
    for (const [key,value] of Object.entries(before)) if(key!=='history') assert.deepEqual(archive[key],value);
    const once=JSON.stringify(room); context.fit(room); assert.equal(JSON.stringify(room),once);
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
