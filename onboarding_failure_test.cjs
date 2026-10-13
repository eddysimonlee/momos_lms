'use strict';
// Source navigation stays within Drive canonical documents and their wiki.
// Run actual request/recovery functions, not a duplicate implementation.
// A small DOM adapter isolates storage controls; real browser checks cover rendering.
// node --test onboarding_failure_test.cjs
// ONBOARDING_SOURCE=/path/to/onboarding.js may select an isolated checkout.
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const vm=require('node:vm');
const {randomUUID,createHash}=require('node:crypto');
const test=require('node:test');
const assert=require('node:assert/strict');
function referenceHarness(){
 const html=readFileSync(resolve(__dirname,'onboarding.html'),'utf8');
 const data=JSON.parse(html.match(/<script id="source-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
 const esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const context=vm.createContext({esc,Intl,dateLabel:s=>s,page:(title,desc,body)=>body,unitOf:()=>({ref:'U48'}),document:{getElementById:()=>({addEventListener(){}})}});
 vm.runInContext(`const source=${JSON.stringify(data)};
 ${section('function coaching(s){','function peekLesson(id){')}
 ${section('const materialById=','function educationIdentity(){')}
 ${section("function materialPanel(id='enspace-pos'){",'const beforeSourceLesson=lesson;')}
 ${section('const beforeCoaching=coaching;',"document.getElementById('inviteParticipants').onclick=")}
 globalThis.api={coaching,materialPanel,materials};`,context);
 return {api:context.api,data,esc};
}
test('all coaching source buttons open the matching canonical guide without external links',()=>{
 const h=referenceHarness();
 for(const unit of h.data.courseData.units){for(const step of unit.steps){
  if(!h.data.coaching[step.id])continue;
  const html=h.api.coaching(step);
  assert.doesNotMatch(html,/href="https?:\/\//);
  assert.match(html,new RegExp('data-guide="'+step.ref+'"'));
  for(const point of h.data.coaching[step.id].points)assert.ok(html.includes(h.esc(point)),'existing coaching text retained');
 }}
});
test('POS text copy and all section instructions remain inline; only canonical/wiki navigation is offered',()=>{
 const h=referenceHarness(),doc=h.data.materials.find(x=>x.id==='enspace-pos');
 const html=h.api.materialPanel(),catalog=h.api.materials();
 assert.doesNotMatch(html,/href="https?:\/\//);
 assert.doesNotMatch(catalog,/href="https?:\/\//);
 assert.match(html,/data-guide="U14"/);
 assert.match(catalog,/href="\/onboarding\/wiki"/);
 assert.doesNotMatch(catalog,/<h2>Notion 교육 보충자료<\/h2>/);
 assert.ok(html.includes(h.esc(doc.status)),'reference status remains distinct from canonical status');
 for(const section of doc.sections){
  assert.ok(html.includes(h.esc(section.title)));
  for(const point of section.points)assert.ok(html.includes(h.esc(point)));
  for(const instruction of section.instructions||[])for(const step of instruction.steps)assert.ok(html.includes(h.esc(step)));
 }
});
function updatesHarness(){
 const host={outerHTML:''},requests=[],replies=[];
 const context=vm.createContext({Intl,Date,encodeURIComponent,esc:x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),cloud:{user:{id:'learner'}},view:'materials',document:{getElementById:id=>id==='app'?{addEventListener(){}}:host},fetch:async(url,opts)=>{requests.push({url,opts});return replies.shift();}});
 vm.runInContext(section('let materialUpdates=','function materials(){')+'globalThis.api={load:loadMaterialUpdates,html:materialUpdatesPanel,feed:()=>materialUpdates};',context);
 return {context,api:context.api,host,requests,replies};
}
const updateFixture=(id='a')=>({id:id.repeat(64),published_at:'2026-10-06T04:20:39+00:00',basis:'compared',changes:[{kind:'replaced',file:'새 정본 <확인>.docx',previous_file:'이전.docx',units:[{id:'U03',title:'근무 준비'}]}]});
test('material updates show confirmed KST time and canonical links, escaping source labels',async()=>{
 const h=updatesHarness();h.replies.push({ok:true,json:async()=>({items:[updateFixture()],next:''})});await h.api.load();
 assert.match(h.api.html(),/13:20/);assert.match(h.api.html(),/1개 자료 반영/);assert.match(h.api.html(),/원고 교체/);assert.match(h.api.html(),/새 정본 &lt;확인&gt;/);assert.match(h.api.html(),/href="\/onboarding\/wiki#U03"/);
 assert.equal(h.requests[0].opts.credentials,'same-origin');assert.equal(h.requests[0].opts.body,undefined);assert.equal(h.requests[0].opts.method,undefined);
 assert.equal(h.api.feed().busy,false);
});
test('failed material update refresh preserves known records and allows a corrected reload',async()=>{
 const h=updatesHarness();h.replies.push({ok:true,json:async()=>({items:[updateFixture()],next:''})});await h.api.load();
 h.replies.push({ok:false,json:async()=>({error:'로그인 확인 필요'})});await h.api.load();
 assert.equal(h.api.feed().items.length,1);assert.match(h.api.html(),/로그인 확인 필요/);assert.match(h.api.html(),/다시 불러오기/);assert.equal(h.api.feed().busy,false);
 h.replies.push({ok:true,json:async()=>({items:[updateFixture('b')],next:''})});await h.api.load();assert.equal(h.api.feed().items[0].id,'b'.repeat(64));assert.equal(h.api.feed().error,'');
});
test('supplemental canonical pages retain their hyphenated wiki anchor and reject non-wiki targets',async()=>{
 const h=updatesHarness(),note=updateFixture();note.changes[0].units=[{id:'field-checks',title:'작성·보완할 내용'},{id:'https://unapproved.test',title:'연결 제외'}];
 h.replies.push({ok:true,json:async()=>({items:[note],next:''})});await h.api.load();
 assert.match(h.api.html(),/href="\/onboarding\/wiki#field-checks"/);assert.doesNotMatch(h.api.html(),/href="https:/);
 assert.doesNotMatch(h.api.html(),/wiki#https/);
});
test('material update pagination keeps older records once and a different account reloads its feed',async()=>{
 const h=updatesHarness();h.replies.push({ok:true,json:async()=>({items:[updateFixture()],next:'b'.repeat(64)})});await h.api.load();
 h.replies.push({ok:true,json:async()=>({items:[updateFixture(),updateFixture('b')],next:''})});await h.api.load(true);assert.equal(h.api.feed().items.length,2);assert.match(h.requests[1].url,/cursor=b{64}$/);
 h.context.cloud.user.id='trainer';h.replies.push({ok:true,json:async()=>({items:[],next:''})});await h.api.load();assert.equal(h.api.feed().user,'trainer');assert.equal(h.api.feed().items.length,0);assert.match(h.api.html(),/변경 기록이 없습니다/);
});
const sourcePath=process.env.ONBOARDING_SOURCE||resolve(__dirname,'onboarding.js');
const source=readFileSync(sourcePath,'utf8').replace(/\r\n/g,'\n');
console.log('Production source SHA256:',createHash('sha256').update(source).digest('hex'));
function section(begin,end){
 const a=source.indexOf(begin),b=source.indexOf(end,a+begin.length);
 assert.ok(a>=0&&b>a,'production function boundaries: '+begin);
 return source.slice(a,b);
}
function navigationHarness(open=true){
 const calls=[],outer={tagName:'DETAILS',open:false,parentElement:null},inner={tagName:'DETAILS',open:false,parentElement:outer};
 const target={parentElement:inner,style:{},closest:()=>open?{}:null,setAttribute:(k,v)=>calls.push(['attr',k,v]),focus:o=>calls.push(['focus',o]),scrollIntoView:o=>calls.push(['scroll',o])};
 const panel={querySelector:q=>q.includes('U03')||q.includes('lesson-material')?target:null},background={querySelector:q=>q.includes('U03')||q.includes('lesson-material')?target:null};
 const context=vm.createContext({document:{getElementById:id=>id==='dialog'?{open}:id==='dialogBody'?panel:background},openEducationDetail:(kind,id)=>calls.push(['open',kind,id])});
 vm.runInContext(section('function revealEducationTarget(target){','function selectEducationSequence(id){')+section('function detailElement(id){','function detailNamespace(html){')+section('openGuide=id=>','openPhoto=id=>')+'globalThis.api={openGuide,educationAnchor,revealCanonical};',context);
 return {api:context.api,calls,target,outer,inner};
}
test('inline canonical criteria land in the active detail and expand collapsed ancestors instead of opening another guide',()=>{
 const h=navigationHarness();h.api.openGuide('U03');
 assert.equal(h.outer.open,true);assert.equal(h.inner.open,true);
 assert.equal(h.calls.filter(x=>x[0]==='scroll').length,1);assert.equal(h.calls.filter(x=>x[0]==='open').length,0);
 assert.equal(h.target.style.scrollMarginTop,'16px');
});
test('canonical criteria absent from the active screen still open a linked guide',()=>{
 const h=navigationHarness();h.api.openGuide('U99');assert.deepEqual(h.calls,[['open','guide','U99']]);
});
test('page education anchors reveal their section and account for the fixed header',()=>{
 const h=navigationHarness(false);assert.equal(h.api.educationAnchor('lesson-material'),true);
 assert.equal(h.target.style.scrollMarginTop,'calc(var(--header-height,64px) + 16px)');assert.equal(h.outer.open,true);
 assert.equal(h.api.educationAnchor('missing'),false);
});
test('an open detail never lands in a matching canonical section hidden behind it',()=>{
 const h=navigationHarness();
 // Only the background has the requested source: its node must not be used.
 const panel={querySelector:()=>null};
 const context=vm.createContext({document:{getElementById:id=>id==='dialog'?{open:true}:id==='dialogBody'?panel:{querySelector:()=>h.target}},openEducationDetail:(kind,id)=>h.calls.push(['open',kind,id])});
 vm.runInContext(section('function revealEducationTarget(target){','function selectEducationSequence(id){')+section('openGuide=id=>','openPhoto=id=>')+'openGuide("U03");',context);
 assert.deepEqual(h.calls,[['open','guide','U03']]);
});
test('all 82 education items retain original explanations/checks and expose valid anchors with one unit list',()=>{
 const data=referenceHarness().data,units=data.courseData.units,steps=units.flatMap(u=>u.steps),records=Object.fromEntries(steps.map(s=>[s.id,{status:'ready',self:s.checks.map(()=>false),teacher:s.checks.map(()=>false),selfAt:[],teacherAt:[],attempt:1,start:null,done:null,history:[],memo:'',lessonVersion:data.courseData.version}]));
 const esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 const context=vm.createContext({source:data,curriculumData:data.courseData,course:units,cloud:{enrolled:true,name:'격리 교육생',target:'learner',permissions:{own:true},roster:[{id:'learner',trainer:'격리 교육자'}],lessonReviewNotes:[]},state:{events:[]},record:id=>records[id],unitOf:id=>units.find(u=>u.steps.some(s=>s.id===id)),allSteps:()=>steps,findStep:id=>steps.find(s=>s.id===id),educationAssignments:()=>({available:steps.map(s=>s.id)}),stats:()=>({done:0,total:steps.length}),person:()=>({practiceLogs:[]}),esc,pct:(n,d)=>Math.round(n/d*100),pill:r=>'<span>'+r.status+'</span>',dateLabel:x=>x||'—',planOf:()=>({start:'2026-10-01',end:'2026-10-14'}),planLabel:x=>x,trainingStart:()=> '2026-10-01',nowDay:()=> '2026-10-06',elapsed:()=>null,coaching:()=>'',photo:()=>'',wiki:id=>'/onboarding/wiki#'+id,refButtons:id=>'<button data-guide="'+id+'">기준</button>',practiceLogPanel:()=>'',delayPanel:()=>''});
 vm.runInContext(section('function guideMarkup(body){','let inquiryList=')+section('function lessonGuideMarkup(s,body,expanded=true){','function page(')+section('function unitProgress(u){','function lesson(){')+section('function nextPractice(id){','function positionPreparation(')+section('function completionPanel(s){','function detailPreferenceKey(){')+'globalThis.renderLesson=lessonContent;globalThis.renderEducationHistory=lessonHistoryContent;',context);
 assert.equal(steps.length,82);
 for(const s of steps){const html=context.renderLesson(s.id);
  for(const copy of s.copy)assert.ok(html.includes(esc(copy)),s.id+' explanation retained');
  for(const check of s.checks)assert.ok(html.includes(esc(check)),s.id+' original check retained');
  assert.equal((html.match(/data-education-sequence/g)||[]).length,1);
  assert.doesNotMatch(html,/같은 단원의 다른 실습|data-step="/);
  assert.match(html,/교육 시작/);assert.match(html,/배운 내용·수행 항목 확인/);
  assert.doesNotMatch(html,/<details class="source-topic"/,'canonical headings stay visible without artificial toggles');
  assert.match(html,new RegExp('data-canonical-ref="'+s.ref+'"'));
  for(const match of html.matchAll(/data-lesson-anchor="([^"]+)"/g))assert.ok(html.includes('id="'+match[1]+'"'),s.id+' anchor '+match[1]);
  for(const match of html.matchAll(/data-sequence-step="([^"]+)"/g))assert.ok(steps.some(x=>x.id===match[1]));
  assert.ok(!html.includes('data-sequence-step="'+s.id+'"'),'current item is not a reset button');
 }
 const first=steps[0],text='이전 교육 확인 기록 <보존>';
 context.state.person='learner';context.state.events.push({person:'learner',id:first.id,date:'2026-10-01',attempt:1,text});
 assert.doesNotMatch(context.renderLesson(first.id),/이전 교육 확인 기록/);
 assert.ok(context.renderEducationHistory(first.id).includes(esc(text)),'education history preserves the event text');
});
test('early start sends the actual start request and announces both planned and actual dates',async()=>{
 const calls=[],messages=[],anchors=[];
 const context=vm.createContext({start:null,trainingStart:()=> '2026-10-09',nowDay:()=> '2026-10-06',dateLabel:d=>d.replaceAll('-','.'),toast:m=>messages.push(m),educationAnchor:id=>anchors.push(id),act:async(action,data)=>{calls.push({action,data});return true;}});
 vm.runInContext(section('start=id=>','toggleSelf='),context);
 assert.equal(await context.start('position-making'),true);assert.equal(calls.length,1);
 assert.match(messages[0],/2026.10.09/);assert.match(messages[0],/2026.10.06/);assert.match(messages[0],/유지/);assert.equal(anchors.length,0);
 context.nowDay=()=> '2026-10-09';assert.equal(await context.start('position-making'),true);
 assert.equal(calls[0].action,'step.start');assert.equal(calls[0].data.step,'position-making');assert.match(messages.at(-1),/교육을 시작했어요/);
});
test('early start and actual checks are enabled; other people, unscheduled and uncertain saves stay locked',()=>{
 const start={disabled:false,dataset:{}},check={disabled:false,dataset:{role:'self',check:'position-making'}};
 const context=vm.createContext({cloud:{permissions:{own:true}},busy:false,uploadingAttachment:false,lastFailed:null,trainingStart:()=> '2026-10-09',nowDay:()=> '2026-10-06',record:()=>({status:'ready'}),document:{getElementById:()=>({}),querySelectorAll:q=>q==='[data-start-practice]'?[start]:q==='[data-check]'?[check]:[]}});
 vm.runInContext(section('function lockControls(){','const oldRender='),context);
 context.lockControls();assert.equal(start.disabled,false);assert.equal(check.disabled,false);
 context.busy=true;context.lockControls();assert.equal(start.disabled,true);
 context.busy=false;context.lastFailed={};context.lockControls();assert.equal(start.disabled,true);
 context.lastFailed=null;context.cloud.permissions.own=false;context.lockControls();assert.equal(start.disabled,true);
 context.cloud.permissions.own=true;context.trainingStart=()=>null;context.lockControls();assert.equal(start.disabled,true);
});
test('education history returns to the same item with its captured scroll and draft',()=>{
 const surface={scrollTop:620,drafts:[{id:'practice-condition',value:'작성 중인 조건'}]},renders=[];
 const context=vm.createContext({educationDetail:{kind:'lesson',id:'one'},educationDetailOrigin:{scope:'user:learner'},educationDetailStack:[],cloud:{user:{id:'user'},target:'learner'},document:{getElementById:()=>({})},findStep:id=>id==='one'?{id,title:'교육 항목'}:null,captureEducationSurface:()=>surface,renderEducationDetail:s=>renders.push(s),closeEducationDetail:()=>assert.fail('must return inside the existing education window')});
 vm.runInContext(section('function openEducationDetail(kind,id,push=true){','function renderEducationDetail(surface){')+section('function backEducationDetail(){','function updateEducationDetailStatus(){')+'openEducationDetail("education-history","one");',context);
 assert.equal(vm.runInContext('educationDetail.kind',context),'education-history');
 vm.runInContext('backEducationDetail()',context);
 assert.equal(vm.runInContext('educationDetail.kind',context),'lesson');assert.equal(vm.runInContext('educationDetail.id',context),'one');
 assert.equal(renders.at(-1).scrollTop,620);assert.equal(renders.at(-1).drafts[0].value,'작성 중인 조건');
});
function sequenceHarness(blocked=false){
 const body={scrollTop:250,querySelector:q=>q==='[data-education-sequence]'?sequence:{setAttribute(){},focus(){}}},sequence={open:true,getBoundingClientRect:()=>({top:120-body.scrollTop})},origin={},calls=[];
 const context=vm.createContext({educationDetail:{kind:'lesson',id:'one'},educationDetailOrigin:origin,educationSequenceCache:{scope:'',surfaces:{}},cloud:{user:{id:'user'},target:'learner'},busy:blocked,lastFailed:null,document:{getElementById:()=>body},findStep:id=>['one','two'].includes(id)?{id,title:id}:null,unitOf:()=>({id:'unit'}),captureEducationSurface:()=>({drafts:[{id:'retryReason',value:'keep my draft'}]}),renderEducationDetail:surface=>{calls.push(['render',surface]);body.scrollTop=0;sequence.open=false;},toast:t=>calls.push(['toast',t])});
 vm.runInContext(section('function selectEducationSequence(id){','function detailElement(id){')+'globalThis.choose=selectEducationSequence;globalThis.current=()=>educationDetail;',context);
 return {choose:context.choose,current:context.current,body,sequence,origin,calls};
}
test('same-unit selection keeps the open menu, scroll position and prior draft without another detail stack',()=>{
 const h=sequenceHarness();h.choose('two');assert.equal(h.current().id,'two');assert.equal(h.body.scrollTop,250);assert.equal(h.sequence.open,true);
 assert.equal(h.origin.lessonSurfaces.one.drafts[0].value,'keep my draft');h.choose('one');assert.equal(h.calls.filter(x=>x[0]==='render')[1][1].drafts[0].value,'keep my draft');
});
test('current item and an in-flight save cannot trigger a sequence reset',()=>{
 const h=sequenceHarness();h.choose('one');assert.equal(h.calls.length,0);
 const pending=sequenceHarness(true);pending.choose('two');assert.equal(pending.current().id,'one');assert.equal(pending.calls.filter(x=>x[0]==='render').length,0);
});
test('unit selection also works in the main education page without opening a dialog',()=>{
 const body={scrollTop:0,querySelector:q=>q==='[data-education-sequence]'?sequence:{setAttribute(){},focus(){}}},sequence={open:true,getBoundingClientRect:()=>({top:140})};let renders=0;
 const context=vm.createContext({educationDetail:null,educationDetailOrigin:null,educationSequenceCache:{scope:'',surfaces:{}},view:'lesson',selected:'one',cloud:{user:{id:'user'},target:'learner'},busy:false,lastFailed:null,document:{getElementById:()=>body},findStep:id=>({id,title:id}),unitOf:()=>({id:'unit'}),captureEducationSurface:()=>({drafts:[]}),render:()=>{renders++;sequence.open=false;},restoreEducationSurface:()=>{},scrollY:210,scrollX:0,scrollTo:p=>assert.equal(p.top,210),toast:()=>{}});
 vm.runInContext(section('function selectEducationSequence(id){','function detailElement(id){')+'selectEducationSequence("two");globalThis.result=selected;',context);
 assert.equal(context.result,'two');assert.equal(renders,1);assert.equal(sequence.open,true);
});
test('unit menu stays open when its confirmation count changes after a save',()=>{
 const detail={open:true,hasAttribute:()=>true,querySelector:()=>({textContent:'0/6 확인'})},root={scrollTop:80,scrollLeft:0,querySelectorAll:q=>q==='details'?[detail]:[]};
 const context=vm.createContext({});vm.runInContext(section('function captureEducationSurface(root){','function revealEducationTarget(target){')+'globalThis.api={captureEducationSurface,restoreEducationSurface};',context);
 const saved=context.api.captureEducationSurface(root);detail.open=false;detail.querySelector=()=>({textContent:'1/6 확인'});context.api.restoreEducationSurface(root,saved);assert.equal(detail.open,true);assert.equal(root.scrollTop,80);
});
test('same-page rerender retains chart horizontal/vertical scroll; a different page starts normally',()=>{
 let restored=0,positioned=0;const root={},context=vm.createContext({cloud:{user:{id:'user'},target:'learner'},view:'schedule',selected:'one',navigationScope:'user:learner',navigationPage:'schedule:',educationDetail:null,educationDetailOrigin:null,document:{getElementById:()=>root},captureEducationSurface:()=>({scrolls:[{top:490,left:120}]}),restoreEducationSurface:(r,s)=>{assert.equal(s.scrolls[0].top,490);assert.equal(s.scrolls[0].left,120);restored++;},render:()=>{},scrollY:720,scrollX:0,scrollTo:p=>{assert.equal(p.top,720);positioned++;}});
 vm.runInContext(section('const priorDetailRender=render;','const priorDetailCloud=applyCloud;')+'render();',context);
 assert.equal(restored,1);assert.equal(positioned,1);
 vm.runInContext('view="home";render();',context);assert.equal(restored,1);assert.equal(positioned,1);
});
const requestCode=section('async function api(','function applyCloud(')
 +section('function statusLine(','start=id=>')
 +section('recordPositionTest=','addPracticeLog=')
 +section('createInquiry=async d=>','replyTicket=async ticket=>')
 +section('function lockControls(){','const oldRender=');
function harness(outcomes){
 const elements={};
 const make=(tag='button')=>({tag,dataset:{},disabled:false,hidden:false,textContent:'',children:[],
  replaceChildren(){this.children=[];},append(...xs){this.children.push(...xs);}});
 for(const id of ['storageNote','createInquiry','person'])elements[id]=make();
 elements.assessment=make();elements.intrinsic=make();elements.intrinsic.disabled=true;
 const calls=[],toasts=[];
 const initial={target:'learner',rootRevision:11,learner:{revision:3},
  permissions:{own:true,assessor:true,trainer:true},tickets:[]};
 let serverState=structuredClone(initial);
 const context=vm.createContext({Intl,Date,Promise,URL,crypto:{randomUUID},
  ERPAuth:{csrfToken:'test-csrf'},
  document:{getElementById:id=>elements[id]||null,createElement:make,
   querySelectorAll:selector=>selector.split(',').flatMap(s=>s==='#createInquiry'?[elements.createInquiry,elements.intrinsic]:s==='[data-record-test]'?[elements.assessment]:[])},
  toast:message=>toasts.push(message),trainingStart:()=> '2026-09-01',nowDay:()=> '2026-10-03',record:()=>({status:'review'}),
  render(){},updateWorkspaceChrome(){},
  fetch:async(url,options)=>{
   const payload=options.body?JSON.parse(options.body):null;
   calls.push({url,method:options.method,payload});
   assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');
   assert.equal(options.headers['X-CSRF-Token'],'test-csrf');
   const outcome=outcomes.shift();assert.ok(outcome,'unexpected request');
   if(outcome.error)throw outcome.error;
   if(outcome.check)outcome.check(payload);
   if(outcome.state)serverState=structuredClone(outcome.state);
   if(outcome.status===200&&options.method==='POST'){
    serverState.learner.revision++;serverState.rootRevision++;
    if(payload.action==='ticket.create')serverState.tickets.push({id:'saved-'+calls.length,...payload.data});
   }
   return {ok:outcome.status===200,status:outcome.status,json:async()=>{
    if(outcome.invalidJson)throw new SyntaxError('truncated response');
    return outcome.status===200?structuredClone(serverState):{error:'fixture '+outcome.status};
   }};
  }
 });
 vm.runInContext(`let cloud=${JSON.stringify(initial)},busy=false,lastFailed=null,lastValidationError='',queue=Promise.resolve();
 const clone=x=>JSON.parse(JSON.stringify(x));
 let uploadingAttachment=false,recordPositionTest,createInquiry,ticketSelection=null,inquiryList='shared';
 let state={support:{tickets:[]}},inquiryDrafts={A:{inquiryTitle:'unsaved draft'}};
 function person(){return cloud.learner;}
 function applyCloud(c){cloud=c;state.support.tickets=c.tickets;lockControls();}
 ${requestCode}
 ({act,recordPositionTest,createInquiry,retryFailed,refreshCloud,
 snapshot:()=>({busy,lastFailed:clone(lastFailed),lastValidationError,cloud:clone(cloud),draft:clone(inquiryDrafts.A)})});`,context);
 const api=vm.runInContext('({act,recordPositionTest,createInquiry,retryFailed,refreshCloud,snapshot:()=>({busy,lastFailed:clone(lastFailed),lastValidationError,cloud:clone(cloud),draft:clone(inquiryDrafts.A)})})',context);
 const vmSnapshot=api.snapshot;
 api.snapshot=()=>JSON.parse(JSON.stringify(vmSnapshot()));
 api.message=()=>elements.storageNote.children.map(x=>typeof x==='string'?x:x.textContent).join('');
 return {api,elements,calls,toasts,outcomes};
}
const inquiry={inquiryType:'technical',inquiryTitle:'isolated regression enquiry',inquiryBody:'synthetic situation',inquiryExpected:'synthetic help',inquiryVisibility:'shared'};
function submit(h,kind,valid=true){
 return kind==='ticket.create'?h.api.createInquiry({...inquiry,inquiryType:valid?'technical':''}):
 h.api.recordPositionTest('making','2026-10-03',valid?'deferred':'','approved fixture criteria','synthetic evaluation feedback',true);
}
function unlocked(h){
 assert.equal(h.elements.createInquiry.disabled,false);
 assert.equal(h.elements.assessment.disabled,false);
 assert.equal(h.elements.person.disabled,false);
 assert.equal(h.elements.intrinsic.disabled,true,'intrinsically disabled control stays disabled');
 assert.equal(h.api.snapshot().busy,false);
}
function locked(h){
 assert.equal(h.elements.createInquiry.disabled,true);
 assert.equal(h.elements.assessment.disabled,true);
 assert.equal(h.elements.person.disabled,true);
 assert.equal(h.api.snapshot().busy,false);
}
for(const kind of ['ticket.create','test.record']){
 test(kind+': normal save',async()=>{
  const h=harness([{status:200}]);await submit(h,kind);unlocked(h);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].payload.action,kind);
  assert.equal(h.api.snapshot().lastFailed,null);assert.equal(h.api.snapshot().cloud.learner.revision,4);
  assert.match(h.api.message(),/서버 저장 완료/);
 });
 test(kind+': 400 keeps input editable; corrected payload gets a new request ID',async()=>{
  const h=harness([{status:400},{status:200,check:p=>assert.equal(p.data[kind==='ticket.create'?'type':'result'],kind==='ticket.create'?'technical':'deferred')}]);
  await submit(h,kind,false);unlocked(h);
  assert.equal(h.api.snapshot().lastFailed,null);assert.equal(h.api.snapshot().lastValidationError,'fixture 400');
  assert.equal(h.api.snapshot().draft.inquiryTitle,'unsaved draft');
  assert.doesNotMatch(h.api.message(),/같은 요청 다시 저장/);
  await h.api.retryFailed();assert.equal(h.calls.length,1,'invalid request cannot be replayed');
  await submit(h,kind,true);unlocked(h);assert.equal(h.calls.length,2);
  assert.notEqual(h.calls[0].payload.requestId,h.calls[1].payload.requestId);
  assert.equal(h.calls[1].payload.revision,3);assert.equal(h.api.snapshot().lastValidationError,'');
  if(kind==='ticket.create')assert.deepEqual(h.api.snapshot().draft,{});
 });
 test(kind+': 401 blocks new writes and preserves same request through authentication recovery',async()=>{
  const h=harness([{status:401},{status:401},{status:200}]);await submit(h,kind);locked(h);
  const original=h.calls[0].payload;
  assert.match(h.api.message(),/로그인이 만료/);
  assert.match(h.api.message(),/같은 요청 다시 저장/);
  assert.equal(await h.api.act(kind,{changed:'must not send'}),false);assert.equal(h.calls.length,1);
  await h.api.retryFailed();locked(h);assert.deepEqual(h.calls[1].payload,original);
  await h.api.retryFailed();unlocked(h);assert.deepEqual(h.calls[2].payload,original);
  assert.equal(h.api.snapshot().lastFailed,null);
 });
 test(kind+': 409 retry stays stale; refresh enables a fresh revision/request',async()=>{
  const updated={target:'learner',rootRevision:15,learner:{revision:9},permissions:{own:true,assessor:true,trainer:true},tickets:[]};
  const h=harness([{status:409},{status:409},{status:200,state:updated},{status:200}]);
  await submit(h,kind);locked(h);assert.match(h.api.message(),/다른 기기/);
  const original=h.calls[0].payload;
  await h.api.retryFailed();locked(h);assert.deepEqual(h.calls[1].payload,original);
  await h.api.refreshCloud();unlocked(h);assert.equal(h.calls[2].method,'GET');
  assert.equal(h.api.snapshot().lastFailed,null);
  await submit(h,kind);unlocked(h);
  assert.equal(h.calls[3].payload.revision,9);assert.equal(h.calls[3].payload.rootRevision,15);
  assert.notEqual(h.calls[3].payload.requestId,original.requestId);
 });
 test(kind+': transport failure retains payload and retries with identical request ID',async()=>{
  const h=harness([{error:new TypeError('Failed to fetch')},{status:200}]);
  await submit(h,kind);locked(h);const original=h.calls[0].payload;
  assert.deepEqual(h.api.snapshot().lastFailed,original);
  await h.api.retryFailed();unlocked(h);assert.deepEqual(h.calls[1].payload,original);
 });
}
test('failed GET cannot discard the pending request; later successful GET clears it',async()=>{
 const h=harness([{status:401},{status:401},{status:200}]);await submit(h,'test.record');locked(h);
 const pending=h.api.snapshot().lastFailed;await h.api.refreshCloud();locked(h);
 assert.deepEqual(h.api.snapshot().lastFailed,pending);
 await h.api.refreshCloud();unlocked(h);assert.equal(h.api.snapshot().lastFailed,null);
});
test('non-JSON response is uncertain; original payload remains retryable',async()=>{
 const h=harness([{status:200,invalidJson:true},{status:200}]);await submit(h,'test.record');locked(h);
 const pending=h.calls[0].payload;await h.api.retryFailed();unlocked(h);assert.deepEqual(h.calls[1].payload,pending);
});
test('400 does not block a corrected queued request',async()=>{
 const h=harness([{status:400},{status:200}]);await Promise.all([submit(h,'test.record',false),submit(h,'test.record',true)]);
 assert.equal(h.calls.length,2);unlocked(h);assert.equal(h.calls[1].payload.data.result,'deferred');
});
test('transport failure stops queued new writes until explicit recovery',async()=>{
 const h=harness([{error:new TypeError('Failed to fetch')}]);await Promise.all([submit(h,'test.record'),submit(h,'test.record')]);
 assert.equal(h.calls.length,1);locked(h);
});

// Assignment guidance uses the actual save/render/navigation functions. The DOM
// adapter checks state transitions; it does not claim browser layout coverage.
function assignmentHarness({target='learner',date='',save=true,reload=true}={}){
 const elements=Object.fromEntries(Object.entries({enrolLearner:'learner',enrolJoin:'2026-10-01',enrolStart:date,enrolTrainer:'trainer',enrolAssessor:'trainer'}).map(([id,value])=>[id,{value,focus(){},scrollIntoView(){}}]));
 const app={addEventListener(){},contains:()=>true};
 let removed=false;elements.enrolResult={focus(){},scrollIntoView(){},remove(){removed=true;}};
 const calls=[],toasts=[],handlers=[];let renders=0;
 const context=vm.createContext({
  document:{getElementById:id=>id==='app'?app:elements[id]||null,addEventListener:(event,fn)=>handlers.push(fn)},
  toast:m=>toasts.push(m),esc:s=>String(s),dateLabel:s=>s,
  validTrainingDate:s=>/^\d{4}-\d{2}-\d{2}$/.test(s),
  findStep:id=>id==='next-step'?{id}:null,educationAssignments:()=>({next:'next-step'}),allSteps:()=>[{id:'first-step'}],
  closeEducationDetail(){},render(){renders++;},
  act:async(action,data)=>{calls.push({action,data});return save;},
  refreshCloud:async id=>{calls.push({reload:id});if(reload)vm.runInContext('cloud.target="learner"',context);return reload;}
 });
 const accountCapture=section("document.addEventListener('click',async e=>{\n const b=e.target.closest?.('button');if(!b||!document.getElementById('app').contains(b))return;", " else if(b.dataset.homeRole)");
 vm.runInContext(`let cloud={target:${JSON.stringify(target)},permissions:{admin:true},configuration:{users:[{id:'learner',name:'격리 교육생'}]}};let view='account';
 ${section('let enrollmentFeedback=null;','account=function(){')}
 ${section('async function saveEnrollment(){',"document.getElementById('app').addEventListener('click',e=>{")}
 ${accountCapture}\n},true);
 globalThis.api={saveEnrollment,enrollmentResult,clearEnrollmentFeedback,snapshot:()=>({view,feedback:enrollmentFeedback,target:cloud.target})};`,context);
 return {api:context.api,elements,calls,toasts,handlers,renders:()=>renders,removed:()=>removed};
}

for(const date of ['', '2026-10-05']){
 test('assignment save stays in settings and explains '+(date?'future start date':'unset start date'),async()=>{
  const h=assignmentHarness({date});await h.api.saveEnrollment();
  assert.equal(h.api.snapshot().view,'account');assert.equal(h.renders(),1);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].action,'config.enrol');
  assert.equal(h.calls[0].data.startDate,date||null);
  const html=h.api.enrollmentResult();
  assert.match(html,/role="status"/);assert.match(html,/격리 교육생/);
  assert.match(html,/data-open-lesson="next-step"/);assert.match(html,/data-view="schedule"/);
  assert.match(html,/교육 시작/);assert.match(html,/수행·완료 기록이 생기지는 않습니다/);
  assert.match(html,date?/2026-10-05/:/담당자 배정은 끝났습니다/);
  assert.match(h.toasts.at(-1),/직접 선택/);
 });
}
test('saving a different learner reloads that learner before showing success',async()=>{
 const h=assignmentHarness({target:'admin',date:'2026-10-04'});await h.api.saveEnrollment();
 assert.equal(h.calls[1].reload,'learner');assert.equal(h.api.snapshot().target,'learner');
 assert.match(h.api.enrollmentResult(),/격리 교육생/);assert.equal(h.api.snapshot().view,'account');
});
test('failed assignment save does not show success or reload another learner',async()=>{
 const h=assignmentHarness({save:false,target:'admin'});await h.api.saveEnrollment();
 assert.equal(h.api.snapshot().feedback,null);assert.equal(h.calls.length,1);
 assert.equal(h.api.enrollmentResult(),'');assert.equal(h.toasts.length,0);
});
test('saved assignment with failed reload explains recovery without a false learner view',async()=>{
 const h=assignmentHarness({reload:false,target:'admin'});await h.api.saveEnrollment();
 assert.equal(h.api.snapshot().target,'admin');assert.equal(h.api.enrollmentResult(),'');
 assert.match(h.toasts.at(-1),/저장됐지만/);assert.match(h.toasts.at(-1),/새로 불러오기/);
});
test('invalid date rejects assignment without sending a request',async()=>{
 const h=assignmentHarness({date:'2026-09-30'});await h.api.saveEnrollment();
 assert.equal(h.calls.length,0);assert.match(h.toasts.at(-1),/입사일 이후/);
});
test('editing an assignment clears its previous success announcement',async()=>{
 const h=assignmentHarness();await h.api.saveEnrollment();h.api.clearEnrollmentFeedback();
 assert.equal(h.api.snapshot().feedback,null);assert.equal(h.api.enrollmentResult(),'');assert.equal(h.removed(),true);
});
test('opening the current assignment page preserves an unsaved date',async()=>{
 const h=assignmentHarness({date:'2026-10-05'});let stopped=false;
 await h.handlers[0]({target:{closest:()=>({dataset:{view:'account'}})},stopImmediatePropagation(){stopped=true;}});
 assert.equal(stopped,true);assert.equal(h.renders(),0);assert.equal(h.elements.enrolStart.value,'2026-10-05');
 assert.match(h.toasts.at(-1),/현재 배정 설정 화면/);
});
test('practice start and review request announce only confirmed saves',async()=>{
 const messages=[],calls=[],context=vm.createContext({trainingStart:()=> '2026-10-01',nowDay:()=> '2026-10-06',toast:m=>messages.push(m),act:async(action,data)=>{calls.push({action,data});return calls.length%2===1;}});
 vm.runInContext(section('start=id=>','toggleTeacher='),context);
 assert.equal(await context.start('step-1'),true);assert.equal(await context.start('step-1'),false);
 assert.equal(messages.length,1);assert.match(messages[0],/교육을 시작했어요/);
 assert.equal(await context.requestReview('step-1'),true);assert.equal(await context.requestReview('step-1'),false);
 assert.equal(messages.length,2);assert.match(messages[1],/확인을 요청했어요/);
 assert.equal(calls[2].action,'step.request');
});

function reviewHarness(statuses=['open','working','resolved','hold','applied'],{save=true}={}){
 const handlers=[],calls=[],toasts=[],elements={app:{contains:()=>true}};
 const reviews=statuses.map((status,i)=>({id:'review-'+i,title:'fixture '+status,status,kind:'content',category:'자료 확보',reason:'fixture reason',needed:'fixture material',evidence:'fixture evidence',sourceFile:'fixture.docx',sourceVersion:'v1',checkedAt:'2026-10-01',detectedAt:'2026-10-03',step:'next-step',ref:'U48',comment:status==='applied'?'반영 확인 기록':'',source:status==='applied'?'격리 교재 v2':'',attachments:[],history:status==='applied'?[{actor:'격리 관리자',at:'2026-10-05T01:00:00Z',status:'applied',comment:'반영 확인 기록',source:'격리 교재 v2'}]:[]}));
 let rendered='',renders=0,context;
 const esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 context=vm.createContext({
  document:{getElementById:id=>elements[id]||null,addEventListener:(event,fn)=>handlers.push(fn)},
  esc,dateLabel:s=>s,attachmentPicker:()=>'',attachmentLinks:()=>'',page:(title,desc,body)=>body,
  homeRole:()=> 'admin',homeRoleSwitch:()=>'',homeJourneyOverview:()=>'',TEST_DEFS:[],pct:()=>0,
  toast:m=>toasts.push(m),render(){renders++;rendered=vm.runInContext('systemRequests()',context);},
  act:async(action,data)=>{calls.push({action,data:JSON.parse(JSON.stringify(data))});if(!save)return false;const r=vm.runInContext('cloud.systemReviews',context).find(r=>r.id===data.id);Object.assign(r,{status:data.status,comment:data.comment,source:data.source,attachments:data.attachments});return true;}
 });
 vm.runInContext(`let cloud={reviewAccess:true,permissions:{admin:true},workspaceRoles:{admin:true},educationSummary:[],systemReviews:${JSON.stringify(reviews)}};
 let systemReviewList='pending';const systemDrafts={},systemEvidence={};
 ${section('const reviewStatusNames=','function availableHomeRoles(){')}
 ${section('function roleHome(){','function accessManagement(){')}
 ${section('function systemRequests(){','const beforeRoleRender=render;')}
 ${source.slice(source.indexOf('// Root capture runs before older inquiry handlers'), source.indexOf('\nlet itemIncomingApplied='))}
 globalThis.api={systemRequests,roleHome};`,context);
 const click=async dataset=>handlers[0]({target:{closest:()=>({dataset})},stopImmediatePropagation(){}});
 return {api:context.api,click,elements,calls,toasts,rendered:()=>rendered,renders:()=>renders};
}
test('only reflected requests leave the pending list and both pending counts',()=>{
 const h=reviewHarness(),html=h.api.systemRequests(),home=h.api.roleHome();
 assert.match(html,/처리 필요 4건/);assert.match(home,/4건 처리 필요/);
 for(const i of [0,1,2,3])assert.match(html,new RegExp('id="system-review-'+i+'"'));
 assert.doesNotMatch(html,/id="system-review-4"/);
 assert.match(html,/보완 확인/);assert.match(html,/value="applied"/);
});
test('reflected requests keep their record/history in the completion view',async()=>{
 const h=reviewHarness();await h.click({systemList:'applied'});
 const html=h.rendered();assert.match(html,/id="system-review-4"/);assert.doesNotMatch(html,/id="system-review-[0-3]"/);
 assert.match(html,/반영 완료/);assert.match(html,/격리 관리자/);assert.match(html,/반영 확인 기록/);assert.match(html,/격리 교재 v2/);
 assert.match(html,/처리 필요 4건/);
 await h.click({systemList:'pending'});assert.doesNotMatch(h.rendered(),/id="system-review-4"/);
});
test('all reflected requests show zero pending and an explicit empty state',()=>{
 const h=reviewHarness(['applied','applied']);
 assert.match(h.api.systemRequests(),/처리 필요 0건/);assert.match(h.api.systemRequests(),/처리할 수정 요청이 없습니다/);
 assert.doesNotMatch(h.api.systemRequests(),/<article class="card system-request"/);
 assert.match(h.api.roleHome(),/0건 처리 필요/);
});
test('saving reflection removes it from pending after success; saving failure cannot reduce count',async()=>{
 for(const save of [true,false]){
  const h=reviewHarness(['open'],{save});h.api.systemRequests();
  h.elements['systemStatus-review-0']={value:'applied'};
  h.elements['systemComment-review-0']={value:'격리 교재 반영 확인'};
  h.elements['systemSource-review-0']={value:'검증용 교재 v2 · 2026-10-05'};
  assert.match(h.api.roleHome(),/1건 처리 필요/,'unsaved selection does not count as complete');
  await h.click({saveSystem:'review-0'});assert.equal(h.calls.length,1);assert.equal(h.calls[0].data.status,'applied');
  assert.match(h.api.roleHome(),save?/0건 처리 필요/:/1건 처리 필요/);
  if(save){assert.match(h.toasts.at(-1),/처리 필요 건수에서 제외/);await h.click({systemList:'applied'});assert.match(h.rendered(),/id="system-review-0"/);}
  else assert.equal(h.toasts.length,0);
 }
});
test('reflection without a version/location is rejected before sending',async()=>{
 const h=reviewHarness(['open']);h.api.systemRequests();
 h.elements['systemStatus-review-0']={value:'applied'};h.elements['systemComment-review-0']={value:'격리 확인'};h.elements['systemSource-review-0']={value:''};
 await h.click({saveSystem:'review-0'});assert.equal(h.calls.length,0);assert.match(h.toasts.at(-1),/반영 위치/);
 assert.match(h.api.roleHome(),/1건 처리 필요/);
});
