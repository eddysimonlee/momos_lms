
'use strict';
const source=JSON.parse(document.getElementById('source-data').textContent);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const curriculumData=source.courseData;
const course=curriculumData.units;
const courseUnit=id=>course.find(u=>u.id===id);
const allSteps=()=>course.flatMap(u=>u.steps),findStep=id=>allSteps().find(s=>s.id===id),unitOf=id=>course.find(u=>u.steps.some(s=>s.id===id));
const DAY=86400000,KEY='momos-onboarding-demo-v03',NAMES={A:'체험 교육생 A',B:'체험 교육생 B'};
const dayNumber=d=>Date.parse(d+'T00:00:00Z')/DAY,validDate=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(dayNumber(d));
const addDay=(d,n)=>new Date((dayNumber(d)+n)*DAY).toISOString().slice(0,10);
const koreanToday=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function blankLearner(){return{join:koreanToday(),records:Object.fromEntries(allSteps().map(s=>[s.id,{status:'ready',self:s.checks.map(()=>false),teacher:s.checks.map(()=>false),selfAt:s.checks.map(()=>null),teacherAt:s.checks.map(()=>null),start:null,done:null,request:null,attempt:1,memo:'',feedback:'',history:[],lessonVersion:'0.5'}])) ,exam:null,examArchive:[]};}
function blankState(){return{version:3,person:'A',today:koreanToday(),plans:course.map(u=>[...u.plan]),learners:{A:blankLearner(),B:blankLearner()},events:[]};}
let state=blankState(),storageOK=true,view='home',selected=allSteps()[0].id;

const person=()=>state.learners[state.person],record=id=>person().records[id],nowDay=()=>state.today,dayOf=d=>dayNumber(d)-dayNumber(scheduleBase())+1;
const dateLabel=d=>d?d.replaceAll('-','.'):'—';
const elapsed=r=>r.start?Math.max(0,dayNumber(r.done||nowDay())-dayNumber(r.start)):null;
const statusNames={ready:'미시작',practice:'교육 중',review:'교육자 확인 대기',done:'확인 완료'};
const pct=(n,d)=>d?Math.round(n/d*100):0;
function stats(){const rs=allSteps().map(s=>record(s.id));return{self:rs.reduce((n,r)=>n+r.self.filter(Boolean).length,0),checks:allSteps().reduce((n,s)=>n+s.checks.length,0),done:rs.filter(r=>r.status==='done').length,total:rs.length,review:rs.filter(r=>r.status==='review').length};}
function save(){}
function event(id,text){state.events.push({person:state.person,date:nowDay(),id,text,attempt:id&&record(id)?record(id).attempt:null,lessonVersion:'0.5',sourceVersion:'0.3'});}
let toastTimer;
function toast(text){const t=document.getElementById('toast');clearTimeout(toastTimer);t.textContent=text;t.hidden=false;toastTimer=setTimeout(()=>t.hidden=true,6500);}
function earliestDate(){const dates=Object.values(person().records).flatMap(r=>[r.start,r.done,r.request,...r.selfAt,...r.teacherAt,...r.history.flatMap(h=>[h.start,h.done,h.archived])]).filter(Boolean);if(person().exam?.submitted)dates.push(person().exam.submitted);for(const e of state.events)if(e.person===state.person)dates.push(e.date);return dates.length?dates.sort().at(-1):null;}
function mutate(fn){fn();save();render();}
function start(){}
function toggleSelf(){}
function requestReview(){}
function toggleTeacher(){}
function complete(){}
function retry(){}
function pill(r){return `<span class="pill ${r.status==='done'?'green':r.status==='review'?'amber':r.status==='practice'?'blue':''}">${statusNames[r.status]}</span>`;}
const wiki=id=>source.wikiPath+(id?'#'+id:'');
function refButtons(id){return `<button class="reference-button" data-guide="${id}"><span aria-hidden="true">▤</span>${esc(source.refs[id].title)}</button>`;}
function photo(id){const p=source.photos[id];return p?`<button class="photo" data-photo="${id}" aria-label="${esc(p.caption)} 확대"><img src="${p.src}" alt="${esc(p.caption)}"><span>${esc(p.caption)} · 확대</span></button>`:'';}
const TEST_DEFS=curriculumData.tests.map(t=>({...t}));
const expandedScheduleUnits=new Set();
let ganttScale='week',ganttLevel='unit',ganttMonth=0,ganttMode='compare',testRole='learner';
function practiceGroups(u){
 // Group only existing lessons; preserve all IDs, checklists and source references.
 const groups=u.id==='making'?[
  ['메이킹',[['업무 · KDS · 소통',['position-making','making-kds','making-quality']],['시음 · 고객 설명',['making-tasting']]]],
  ['라떼',[['이론 · 스팀 · 플랫화이트',['making-steam-heat','making-steam-foam']],['라떼아트 · 결하트',['making-stabilize','making-heart','making-push','making-handle','making-texture']]]],
  ['평가 준비',[['테스트 · 일지',['making-test-prep']]]]
 ]:u.id==='brewing'?[
  ['브루잉 이론',[['학습 · 원두 · 추출 변수',['position-brewing','brewing-variables','brewing-beans']]]],
  ['브루잉 실습',[['제조 · 칼리브레이션',['brewing-recipe','brewing-calibration']],['동료 협업',['brewing-collaboration']]]],
  ['평가 준비',[['테스트 · 일지',['brewing-test-prep']]]]
 ]:u.id==='espresso'?[
  ['에스프레소 이론',[['추출 이해',['position-espresso','espresso-theory']]]],
  ['에스프레소 실습',[['샷 · 실험 · 칼리브레이션',['espresso-shot','espresso-lab','espresso-calibration']],['장비 · 피크 협업',['espresso-equipment','espresso-overview']]]],
  ['평가 준비',[['테스트 · 일지',['espresso-test-prep']]]]
 ]:[[u.title,[['학습 · 실습',u.steps.map(s=>s.id)]]]];
 return groups.map(([title,sections])=>({title,sections:sections.map(([title,ids])=>({title,steps:ids.map(id=>u.steps.find(s=>s.id===id)).filter(Boolean)}))}));
}
function practiceNavigation(u){return '<nav class="practice-tree" aria-label="'+esc(u.title)+' 교육 분류">'+practiceGroups(u).map(g=>'<details '+(g.sections.some(x=>x.steps.some(s=>s.id===selected))?'open':'')+'><summary>'+esc(g.title)+'</summary>'+g.sections.map(x=>'<section><h3>'+esc(x.title)+'</h3><div class="practice-links">'+x.steps.map(s=>'<button data-step="'+s.id+'" class="'+(s.id===selected?'chosen':'')+'" '+(s.id===selected?'aria-current="step"':'')+'>'+esc(s.title)+(record(s.id).status==='done'?' ✓':'')+'</button>').join('')+'</div></section>').join('')+'</details>').join('')+'</nav>';}
function scheduleTiming(item){
 if(item.startsWith('test-')){const id=item.slice(5),attempts=person().tests[id].attempts,a=firstPass(id)||attempts.at(-1);return {start:a?.date||null,end:a?.date||null,attempt:a?.attempt||null,status:a?({pass:'통과 기록',retry:'보완 · 재시험',deferred:'평가 보류'}[a.result]):'미응시'};}
 const r=record(item);return {start:r.start,end:r.done,attempt:r.attempt,status:statusNames[r.status]};
}
function scheduleDelay(item){
 if(!trainingStart())return {startDays:0,endDays:0,late:false};
 const p=planOf(item),a=scheduleTiming(item),startDays=a.start?Math.max(0,dayNumber(a.start)-dayNumber(p.start)):0,endDays=Math.max(0,dayNumber(a.end||nowDay())-dayNumber(p.end));
 return {startDays,endDays,late:startDays>0||endDays>0};
}
function delayLabel(d){return [d.startDays?'시작 '+d.startDays+'일 지연':'',d.endDays?'완료 '+d.endDays+'일 지연':''].filter(Boolean).join(' · ')||'계획 범위 내';}
function delayPanel(item,includeHistory=true){
 const p=planOf(item),a=scheduleTiming(item),d=scheduleDelay(item),notes=(person().delayNotes||[]).filter(n=>n.item===item),editable=cloud?.enrolled&&trainingStart()&&(cloud.permissions.own||(item.startsWith('test-')?cloud.permissions.assessor:cloud.permissions.trainer));
 const changes=(person().planHistory||[]).filter(h=>h.previous?.[item]&&h.next?.[item]);
 return '<section class="card schedule-detail"><h2>Plan · Action</h2><div class="schedule-pair"><div><span class="pill blue">Plan · 계획</span><p>'+planLabel(p.start)+' ~ '+planLabel(p.end)+'</p></div><div><span class="pill green">Action · 실제 수행</span><p>시작 '+dateLabel(a.start)+' · 완료 '+dateLabel(a.end)+'</p><small>'+esc(a.status)+'</small></div></div>'+(d.late?'<p class="notice warning">'+delayLabel(d)+'</p>':'')+(d.late&&editable?'<label>지연 사유 <textarea id="delayReason-'+item+'" maxlength="2000" placeholder="지연된 이유와 다음 조치" required></textarea></label><button data-delay-reason="'+item+'">지연 사유 저장</button>':'')+(includeHistory?(notes.length?'<details><summary>지연 사유 이력 · '+notes.length+'건</summary>'+notes.slice().reverse().map(n=>'<div class="result"><b>'+dateLabel(n.date)+' · '+esc(n.actor)+'</b><p>'+esc(n.reason)+'</p><small>당시 계획 '+dateLabel(n.plan.start)+' ~ '+dateLabel(n.plan.end)+' · '+delayLabel(n)+' · 실제 시작 '+dateLabel(n.start)+' / 완료 '+dateLabel(n.end)+'</small></div>').join('')+'</details>':'<p class="empty-history">지연 사유 기록 없음</p>')+(changes.length?'<details><summary>계획 변경 이력 · '+changes.length+'건</summary>'+changes.slice().reverse().map(h=>'<p>'+esc(h.actor)+' · '+esc(h.at.slice(0,10))+'<br>'+dateLabel(h.previous[item].start)+' ~ '+dateLabel(h.previous[item].end)+' → '+dateLabel(h.next[item].start)+' ~ '+dateLabel(h.next[item].end)+'</p>').join('')+'</details>':''):'')+'</section>';
}
function scheduleTreeControls(){
 const setup=!cloud?.enrolled||!trainingStart();
 return (setup?'<div class="notice"><strong>'+(!cloud?.enrolled?'교육생 미배정 · 과정 미리보기':'교육 시작일 미설정')+'</strong><p>'+(!cloud?.enrolled?'교육생과 담당자를 배정하면 실제 교육을 시작할 수 있습니다.':'교육 시작일을 저장하면 교육생 본인이 교육을 시작할 수 있습니다.')+'</p>'+(cloud?.permissions.admin?'<button class="primary" data-view="account">교육 배정 설정</button>':'<small>관리자에게 교육 배정을 요청하세요.</small>')+'</div>':'')+'<div class="actions"><button data-schedule-expand="all">하위 교육 항목 모두 펼치기</button><button data-schedule-expand="none">하위 교육 항목 접기</button></div>';
}
function scheduleTitle(row){
 const u=courseUnit(row.id),s=findStep(row.id),parent=u||(s?unitOf(s.id):null),number=parent?(course.indexOf(parent)+1)+(s?'.'+s.sequence+' ':'. '):'';
 const toggle=u?'<button class="schedule-toggle" data-schedule-toggle="'+u.id+'" aria-expanded="'+expandedScheduleUnits.has(u.id)+'" aria-label="'+esc(u.title)+' 하위 교육 항목 '+(expandedScheduleUnits.has(u.id)?'접기':'펼치기')+'">'+(expandedScheduleUnits.has(u.id)?'▾':'▸')+'</button>':'';
 return '<div class="schedule-title">'+toggle+scheduleItemButton(row.id,number+row.title,'text-button')+'</div>'+(u?'<small class="schedule-progress">완료 '+pct(unitProgress(u),u.steps.length)+'%<progress max="'+u.steps.length+'" value="'+unitProgress(u)+'"></progress></small>':'');
}
function scheduleProgressNote(){const s=stats();return '<p class="notice">전체 WBS 교육 확인 '+pct(s.done,s.total)+'% · '+s.done+'/'+s.total+'개 완료. 하위 교육 항목의 교육자 확인 완료가 단원과 전체에 반영됩니다. 포지션 시험은 ★ 별도 평가입니다.</p>';}
function learningDetails(s,open=false){
 const r=record(s.id),p=planOf(s.id),previous=(s.recommendedAfter||[]).map(findStep).filter(Boolean);
 return '<details class="learning-task" '+(open?'open':'')+'><summary><span class="pill">'+s.sequence+'</span><strong>'+esc(s.title)+'</strong>'+pill(r)+'</summary><div class="learning-task-body"><p>Plan '+planLabel(p.start)+' ~ '+planLabel(p.end)+' · Action '+dateLabel(r.start)+' ~ '+dateLabel(r.done)+'</p><p class="muted">원본 권장: 교육 '+s.defaultDays[0]+'~'+s.defaultDays[1]+'일차 · '+esc(s.sequenceStatus||'원본 목록 순서 · 병행 가능')+(previous.length?' · 권장 선행: '+previous.map(x=>esc(x.title)+(record(x.id).status==='done'?' ✓':' · 미완료')).join(', '):'')+'</p>'+s.copy.map(x=>'<p>'+esc(x)+'</p>').join('')+lessonSource(s,open)+'<div class="actions"><button class="primary" data-open-lesson="'+s.id+'">'+(r.status==='done'?'완료 기록·다시 연습 보기':r.status==='review'&&cloud?.permissions.trainer?'항목 확인·완료 처리하기':'교육 시작·체크하기')+'</button></div><small>직원이 실제 수행 후 확인 요청 → 배정 교육자가 항목 확인 후 완료. 앞 항목 확인 후 다음 실습을 권장하며 교육자 판단에 따라 병행할 수 있습니다.</small></div></details>';
}
function peekScheduleUnit(id){
 const u=courseUnit(id);if(!u)return;
 const current=u.steps.find(s=>record(s.id).status!=='done');
 document.getElementById('dialogTitle').textContent=u.title;document.getElementById('dialogLink').hidden=true;
 document.getElementById('dialogBody').innerHTML='<p>'+esc(u.summary)+'</p><p class="notice">단원 교육 확인 '+pct(unitProgress(u),u.steps.length)+'% · '+unitProgress(u)+'/'+u.steps.length+'개 완료 → 전체 '+pct(stats().done,stats().total)+'%</p>'+(u.sequenceNote?'<p>'+esc(u.sequenceNote)+'</p>':'<p>원본 목록 순서로 안내합니다. 일정이 겹치는 실습은 병행할 수 있습니다.</p>')+(cloud?.permissions.trainer&&trainingStart()?'<button data-unit-plan-preview="'+u.id+'">이 단원의 원본 권장 일정 검토하기</button>':'')+u.steps.map(s=>learningDetails(s,s.id===current?.id)).join('');
 const dialog=document.getElementById('dialog');if(!dialog.open)dialog.showModal();
}

function scheduleItemButton(id,label,cls='',style='',title=''){const test=id.startsWith('test-');return '<button class="'+cls+(test?' test-milestone':'')+'" data-gantt-item="'+id+'" style="'+style+'" title="'+esc(title)+'" aria-label="'+esc((test?'평가 · ':'')+label+' · 교육 내용 보기')+'">'+(test?'★ ':'')+esc(label.replace(/^◆\s*/,''))+'</button>';}

function addMonths(date,n){const [y,m,d]=date.split('-').map(Number),last=new Date(Date.UTC(y,m-1+n+1,0)).getUTCDate();return new Date(Date.UTC(y,m-1+n,Math.min(d,last))).toISOString().slice(0,10);}
const goalDate=()=>addMonths(scheduleBase(),6),planOf=id=>person().planDates[id];

function trainingStart(){return cloud?.enrolled?(person().startDate===undefined?person().join:person().startDate):null;}
function scheduleBase(){return trainingStart()||person().join;}
function planLabel(d){return trainingStart()?dateLabel(d):(d?'교육 '+(dayNumber(d)-dayNumber(scheduleBase())+1)+'일차':'미설정');}
function validTrainingDate(v){try{return /^\d{4}-\d{2}-\d{2}$/.test(v)&&addDay(v,0)===v;}catch{return false;}}
function templateTimeline(startDate=''){
 const dated=validTrainingDate(startDate),base=dated?startDate:'2000-01-01',finish=addMonths(base,6),cols=Math.ceil((dayNumber(finish)-dayNumber(base)+1)/7),span=s=>s.defaultDays||unitOf(s.id).plan;
 const label=d=>dated?dateLabel(addDay(base,d-1)):Math.ceil(d/7)+'주';
 const rows=course.flatMap(u=>[{id:u.id,title:u.title,sub:u.steps.length+'개 하위 실습',begin:Math.min(...u.steps.map(s=>span(s)[0])),end:Math.max(...u.steps.map(s=>span(s)[1]))},...(expandedScheduleUnits.has(u.id)?u.steps.map(s=>({id:s.id,title:s.title,sub:s.sequenceStatus,child:true,begin:span(s)[0],end:span(s)[1]})):[])]);
 for(const t of TEST_DEFS){const d=dayNumber(addDay(addMonths(base,t.month),-t.buffer))-dayNumber(base)+1;rows.push({id:'test-'+t.id,title:'◆ '+t.title,sub:'별도 현장 평가',begin:d,end:d});}
 return scheduleTreeControls()+scheduleProgressNote()+'<div class="gantt-legend"><span>파랑 · 교육 계획</span><span>초록 · 실제 수행</span><strong>★ 보라 · 포지션 평가</strong></div><div class="notice">'+(dated?'교육 배정 저장 전의 Plan 미리보기입니다. 실제 수행 기록은 별도입니다.':'교육 시작일 미설정 · 기본 Plan을 주 단위로 미리 봅니다. 항목을 누르면 교육 내용이 열립니다.')+'</div><div class="curriculum six-month"><div class="gantt" style="--cols:'+cols+';min-width:'+Math.max(1060,360+cols*34)+'px"><div class="ghead"><div>교육 항목 · 6개월 ESP 목표</div><div>구분</div>'+Array.from({length:cols},(_,i)=>'<div>'+(i+1)+'주'+(dated?'<br>'+dateLabel(addDay(base,i*7)).slice(5):'')+'</div>').join('')+'</div>'+rows.map(r=>'<div class="grow schedule-compare '+(r.child?'schedule-child':'')+'" data-lanes="2"><div class="gname">'+scheduleTitle(r)+'</div><div class="schedule-lane plan-lane"><div class="gkind">Plan · 계획</div>'+scheduleItemButton(r.id,'Plan','gplan','grid-column:'+(Math.floor((r.begin-1)/7)+3)+' / '+(Math.min(cols,Math.floor((r.end-1)/7)+1)+3),r.title+' · '+label(r.begin)+' ~ '+label(r.end))+'</div><div class="schedule-lane action-lane"><div class="gkind">Action · 실제</div>'+scheduleItemButton(r.id,'아직 실제 수행 기록 없음','gempty','grid-column:3 / -1',r.title+' 교육 내용 보기')+'</div></div>').join('')+'</div></div>';
}
function enrolPreview(){
 const input=document.getElementById('enrolStart');if(!input)return;
 document.getElementById('enrolPreview').innerHTML=templateTimeline(input.value);
}
function prepSummary(){return '<div class="metrics"><div class="metric"><span>전체 커리큘럼</span><strong>'+course.length+'단원</strong><small>'+allSteps().length+'단계 · '+stats().checks+'개 실습 항목</small></div><div class="metric"><span>교육 진척률</span><strong>'+pct(stats().done,stats().total)+'%</strong><small>교육자 확인 '+stats().done+'/'+stats().total+'단계</small></div><div class="metric"><span>교육 시작일</span><strong>미설정</strong><small>실제 수행 이력과 별도</small></div><div class="metric"><span>교육 종료 목표</span><strong>시작 후 6개월</strong><small>ESP 통과 목표 · 예정 기준</small></div></div>';}
function initSixMonth(){for(const [key,l] of Object.entries(state.learners)){l.planDates??={};l.tests??={};l.practiceLogs??=[];for(const s of allSteps()){l.records[s.id]??={status:'ready',self:s.checks.map(()=>false),teacher:s.checks.map(()=>false),selfAt:s.checks.map(()=>null),teacherAt:s.checks.map(()=>null),start:null,done:null,request:null,attempt:1,memo:'',feedback:'',history:[],lessonVersion:'0.5'};l.records[s.id].lessonVersion??='0.3';const u=unitOf(s.id),i=course.indexOf(u),p=s.defaultDays||state.plans?.[i]||u.plan;l.planDates[s.id]??={start:addDay(l.join,p[0]-1),end:addDay(l.join,p[1]-1),edited:false};}for(const t of TEST_DEFS){l.tests[t.id]??={attempts:[]};l.tests[t.id].planHistory??=[];l.planDates['test-'+t.id]??={start:addDay(addMonths(l.join,t.month),-t.buffer),end:addDay(addMonths(l.join,t.month),-t.buffer),edited:false};}}state.courseVersion='0.5';}
initSixMonth();
function rebasePlans(oldJoin,newJoin){const delta=dayNumber(newJoin)-dayNumber(oldJoin);for(const [id,p] of Object.entries(person().planDates)){const t=TEST_DEFS.find(t=>'test-'+t.id===id);if(!p.edited&&t){p.start=p.end=addDay(addMonths(newJoin,t.month),-t.buffer);}else{p.start=addDay(p.start,delta);p.end=addDay(p.end,delta);}}event(null,'입사일 변경 · 교육·시험 예정일 함께 이동');}
function unitPlan(u){const ps=u.steps.map(s=>planOf(s.id));return{start:ps.map(p=>p.start).sort()[0],end:ps.map(p=>p.end).sort().at(-1)};}
function firstPass(id){return person().tests[id].attempts.filter(a=>a.result==='pass').slice().sort((a,b)=>a.date.localeCompare(b.date))[0]||null;}
function goalPanel(){if(!trainingStart())return '<div class="card"><h2>교육 시작 후 6개월 ESP 통과 목표</h2><p>시작일 미정 · 메이킹 2개월 / 브루잉 4개월 / ESP 목표 14일 전은 조정 가능한 제안입니다.</p></div>';const due=goalDate(),pass=firstPass('espresso'),inTime=pass&&pass.date<=due,left=dayNumber(due)-dayNumber(nowDay());return `<div class="card"><div class="actions"><span class="pill blue">교육 시작 후 6개월</span><span class="pill ${pass&&inTime?'green':left<0?'red':'amber'}">${pass?(inTime?'6개월 내 ESP 통과 기록':'목표일 이후 ESP 통과 기록'):left<0?'목표일 경과 · 통과 미기록':'목표까지 '+left+'일'}</span></div><h2 style="margin-top:12px">${dateLabel(due)}까지 ESP 테스트 통과 목표</h2><p>교육 시작일 ${dateLabel(trainingStart())} · 6개월은 달력 월 기준입니다. 시험일·재시험일은 각각 정하고 실제 통과일을 별도로 기록합니다.</p><div class="milestones">${TEST_DEFS.map(t=>{const p=planOf('test-'+t.id),done=firstPass(t.id);return `<div><strong>${esc(t.title)}</strong><p>예정 ${planLabel(p.start)}<br>${done?'통과 기록 '+dateLabel(done.date):'통과 기록 없음'}</p><button data-test-select="${t.id}">시험 준비·결과 보기</button></div>`;}).join('')}</div><small>메이킹 2개월·브루잉 4개월·ESP 첫 시험 목표 14일 전은 조정 가능한 계획 제안입니다. 합격·단독 수행 기준은 매장 확인 사항이며 체크·퀴즈 점수로 시험 합격을 만들지 않습니다.</small></div>`;}
function metrics(){if(!trainingStart())return prepSummary();const s=stats(),left=dayNumber(goalDate())-dayNumber(nowDay());return `<div class="metrics"><div class="metric"><span>직원 수행률</span><strong>${pct(s.self,s.checks)}%</strong><small>${s.self}/${s.checks}개 실습 항목</small></div><div class="metric"><span>교육 확인 진척률</span><strong>${pct(s.done,s.total)}%</strong><small>${s.done}/${s.total}단계 · 시험 통과와 별도</small></div><div class="metric"><span>교육 시작 후 현재 위치</span><strong>${dayOf(nowDay())<1?"시작까지 "+(1-dayOf(nowDay()))+"일":dayOf(nowDay())+"일차"}</strong><small>교육 시작일=1일차 · 달력일</small></div><div class="metric"><span>6개월 ESP 목표까지</span><strong>${Math.abs(left)}일</strong><small>${left<0?'목표일 경과':'남은 기간'} · ${dateLabel(goalDate())}</small></div></div>`;}
function ganttItems(){
 const child=s=>({id:s.id,title:s.title,sub:s.sequenceStatus,child:true,p:planOf(s.id),...scheduleTiming(s.id),late:scheduleDelay(s.id).late});
 const rows=ganttLevel==='step'?allSteps().map(child):course.flatMap(u=>{const t=unitTiming(u);return[{id:u.id,title:u.title,sub:u.steps.length+'개 하위 실습',p:unitPlan(u),start:t.start,end:t.end,status:t.end?'확인 완료':t.start?'진행 중':'미시작',late:u.steps.some(s=>scheduleDelay(s.id).late)},...(expandedScheduleUnits.has(u.id)?u.steps.map(child):[])];});
 for(const t of TEST_DEFS)rows.push({id:'test-'+t.id,title:'◆ '+t.title,sub:t.evaluator,p:planOf('test-'+t.id),...scheduleTiming('test-'+t.id),late:scheduleDelay('test-'+t.id).late,test:true});return rows;
}

function gantt(){
 if(!trainingStart())return templateTimeline();
 const rows=ganttItems(),begin=ganttScale==='week'?scheduleBase():addMonths(scheduleBase(),ganttMonth),overall=[goalDate(),...rows.flatMap(r=>[r.p.end,r.end||r.start&&nowDay()]).filter(Boolean)].sort().at(-1),finish=ganttScale==='week'?overall:ganttMonth===5?goalDate():addDay(addMonths(scheduleBase(),ganttMonth+1),-1),width=ganttScale==='week'?7:1,cols=Math.ceil((dayNumber(finish)-dayNumber(begin)+1)/width),idx=d=>Math.floor((dayNumber(d)-dayNumber(begin))/width)+1,today=idx(nowDay()),gridRange=(a,b)=>[Math.max(1,idx(a))+2,Math.min(cols,idx(b))+3];
 return scheduleTreeControls()+scheduleProgressNote()+'<div class="gantt-legend"><span>파랑 · 교육 계획</span><span>초록 · 실제 수행</span><strong>★ 보라 · 포지션 평가</strong></div><div class="actions"><button data-scale="week" class="'+(ganttScale==='week'?'primary':'')+'">전체 · 주 눈금</button><button data-scale="day" class="'+(ganttScale==='day'?'primary':'')+'">월별 · 날짜 눈금</button>'+(ganttScale==='day'?'<label>기간 <select id="ganttMonth">'+Array.from({length:6},(_,i)=>'<option value="'+i+'" '+(ganttMonth===i?'selected':'')+'>'+dateLabel(addMonths(scheduleBase(),i)).slice(0,7)+'</option>').join('')+'</select></label>':'')+'<button data-level="unit" class="'+(ganttLevel==='unit'?'primary':'')+'">단원 보기</button><button data-level="step" class="'+(ganttLevel==='step'?'primary':'')+'">교육 항목 보기</button></div><div class="actions gantt-modes">'+[['compare','Plan · Action 비교'],['plan','Plan만 보기'],['action','Action만 보기']].map(([id,label])=>'<button data-gantt-mode="'+id+'" class="'+(ganttMode===id?'primary':'')+'">'+label+'</button>').join('')+'</div><p class="muted">교육 항목은 하나의 셀로 묶고 Plan · Action을 위아래로 비교합니다. 항목 이름이나 막대를 누르면 해당 교육 내용이 열립니다. 파란 선은 기준일입니다.</p><div class="curriculum six-month"><div class="gantt" style="--cols:'+cols+';min-width:'+Math.max(1060,360+cols*34)+'px"><div class="ghead"><div>교육 항목</div><div>구분</div>'+Array.from({length:cols},(_,i)=>'<div class="'+(today===i+1?'todaycell':'')+'" title="'+dateLabel(addDay(begin,i*width))+'">'+(ganttScale==='week'?(i+1)+'주<br>':'')+addDay(begin,i*width).slice(5).replace('-','.')+'</div>').join('')+'</div>'+rows.map(row=>{
  const p=row.p,realEnd=row.end||nowDay(),planned=p.end>=begin&&p.start<=finish,actual=row.start&&realEnd>=begin&&row.start<=finish,pr=gridRange(p.start,p.end),ar=actual?gridRange(row.start,realEnd):null;
  const lane=(kind,bar)=>'<div class="schedule-lane '+kind+'-lane"><div class="gkind">'+(kind==='plan'?'Plan · 계획':'Action · 실제')+'</div>'+(today>=1&&today<=cols?'<div class="gmarker" style="grid-column:'+(today+2)+'"></div>':'')+bar+'</div>';
  return '<div class="grow schedule-compare '+(row.child?'schedule-child':'')+'" data-lanes="'+(ganttMode==='compare'?2:1)+'"><div class="gname">'+scheduleTitle(row)+'<small class="gstatus">'+esc(row.status)+(row.late?' · 지연':'')+'</small></div>'+(ganttMode!=='action'?lane('plan',planned?scheduleItemButton(row.id,'Plan','gplan','grid-column:'+pr[0]+'/'+pr[1],row.title+' · 계획 '+dateLabel(p.start)+' ~ '+dateLabel(p.end)):scheduleItemButton(row.id,'이 기간 밖의 계획','gempty','grid-column:3 / -1')):'')+(ganttMode!=='plan'?lane('action',actual?scheduleItemButton(row.id,'Action · '+row.status,'gactual '+(row.end?'':'pending'),'grid-column:'+ar[0]+'/'+ar[1],row.title+' · 실제 '+dateLabel(row.start)+' ~ '+dateLabel(realEnd)+(row.end?'':' · 진행 중, 완료일 미확정')):scheduleItemButton(row.id,row.start?'이 기간 밖의 수행 기록':'아직 실제 수행 기록 없음','gempty','grid-column:3 / -1',row.title+' · 교육 내용 보기')):'')+'</div>';
 }).join('')+'</div></div><small>진행 중 막대는 실제 시작일부터 기준일까지 표시하며 실제 완료일로 저장하지 않습니다. 지연 사유는 교육 · 확인의 Plan · Action에서 기록합니다.</small>';
}
function groupedUnitRows(units){return units.map(u=>{const p=unitPlan(u),n=unitProgress(u);return `<div class="unitrow"><div><h3>${esc(u.title)} ${trainingStart()&&nowDay()>p.end&&n<u.steps.length?'<span class="pill amber">계획 구간 경과</span>':''}</h3><small>${u.summary} · ${planLabel(p.start)}~${planLabel(p.end)}</small><div class="bar" style="position:static;top:auto"><i style="width:${pct(n,u.steps.length)}%"></i></div><details ${u.steps.some(s=>s.id===selected)?'open':''}><summary>상세 교육 항목 ${u.steps.length}단계</summary><div class="stepnav">${u.steps.map(s=>`<button data-step="${s.id}" class="${selected===s.id?'chosen':''}">${esc(s.title)} ${record(s.id).status==='done'?'✓':''}</button>`).join('')}</div></details></div><span class="pill">${n}/${u.steps.length} 확인</span></div>`;}).join('');}
function curriculumRows(){return curriculumData.journey.map(g=>'<section class="curriculum-track '+(g.test?'skill-track':'operation-track')+'"><header><span class="pill '+(g.test?'violet':'blue')+'">'+(g.test?'제조 기술 · 평가':'현장 적응 · 운영')+'</span><h3>'+g.order+'. '+esc(g.title)+'</h3><p>'+esc(g.purpose)+'</p></header>'+groupedUnitRows(g.units.map(courseUnit))+(g.test?'<div class="actions"><button data-test-select="'+g.test+'">★ '+esc(TEST_DEFS.find(t=>t.id===g.test).title)+' · 준비/결과</button></div>':'')+'</section>').join('');}
function unitJourney(u){return curriculumData.journey.find(g=>g.units.includes(u.id));}
function coveragePanel(){return `<div class="card"><h2>정본의 학습·실습 대상 목록 대조</h2><p class="muted">교육 원고의 목록 ${source.learningTargets.length}개를 그대로 연결했습니다. 체크는 교육용 구성 제안이며 아래 목록이나 공식 기록 양식을 대체하지 않습니다.</p><details><summary>누락 확인용 전체 목록 펼치기</summary><div class="scroll"><table><thead><tr><th>원고 구분</th><th>원고 학습 대상</th><th>연결 내용</th></tr></thead><tbody>${source.learningTargets.map(x=>`<tr><td>${esc(x.type)}</td><td>${esc(x.title)}</td><td><button data-step="${x.step}">교육 단계 · ${esc(findStep(x.step).title)}</button><br>${refButtons(x.ref)}</td></tr>`).join('')}</tbody></table></div></details><p>원고의 외부 브루잉·ESP 실험 설계 매뉴얼/실험 일지는 상세 내용 미수집입니다. 수율 허용값·평가 점수·재시험 조건·단독 수행 권한도 매장에서 확인해 보완해야 합니다.</p></div>`;}
function home(){
 if(cloud&&homeRole()!=='learner')return roleHome();
 const p=cloud?.permissions||{},a=educationAssignments(),s=stats(),next=findStep(a.next),admin=p.admin&&!p.own,own=Boolean(cloud?.enrolled&&p.own),preview=!cloud?.enrolled;
 const roster=cloud?.roster.find(r=>r.id===cloud.target),start=trainingStart(),completed=cloud?.enrolled&&s.done===s.total&&TEST_DEFS.every(t=>firstPass(t.id));
 const end=completed?[...allSteps().map(x=>record(x.id).done),...TEST_DEFS.map(t=>firstPass(t.id).date)].sort().at(-1):null;
 let title=admin?'교육을 시작하고,<br>직원의 성장을 확인합니다.':own?'현장을 배우고,<br>함께 확인합니다.':'현장에 익숙해지는 과정,<br>한 단계씩 함께합니다.';
 let description=admin?'참여자를 배정하고, 직원별 교육 확인과 포지션 평가를 챙기는 공간입니다.':own?'오늘 이어갈 교육을 확인하고 교육자와 함께 다음 단계로 나아가세요.':'교재를 읽는 것부터 교육 확인과 포지션 평가까지, 전체 흐름을 먼저 살펴보세요.';
 let taskTitle,taskNote,primary;
 if(admin){taskTitle=preview?'교육을 시작할 직원을 배정하세요':esc(cloud.name)+'님의 교육을 확인하세요';taskNote=preview?'참여자와 교육 시작일·교육자·평가자를 지정하면 과정 전체가 배정됩니다.':'위의 교육 기록 대상에서 직원을 선택합니다. 교육 확인과 평가 판정은 배정된 담당자가 기록합니다.';primary='<button class="primary" data-view="account">교육 배정 설정 →</button>';}
 else if(p.trainer&&s.review){taskTitle='확인을 기다리는 실습 '+s.review+'개';taskNote='배정된 직원의 실습 항목을 확인하고 피드백을 남겨주세요.';primary='<button class="primary" data-view="trainer">확인 대기 처리 →</button>';}
 else if(own&&next){taskTitle=esc(next.title);taskNote=esc(unitOf(next.id).title)+' · '+(record(next.id).status==='practice'?'진행 중인 교육을 이어서 확인하세요.':'예정 '+planLabel(planOf(next.id).start)+' ~ '+planLabel(planOf(next.id).end));primary='<button class="primary" '+(a.nextAvailable?'data-step':'data-peek')+'="'+next.id+'">'+(a.nextAvailable?'현재 교육 이어하기 →':'예정 과제 미리보기 →')+'</button>';}
 else if(own&&a.waiting.length){taskTitle='교육자 확인을 기다리고 있어요';taskNote='요청한 교육 항목 '+a.waiting.length+'개 · 확인이 끝나면 결과와 다음 과제를 살펴보세요.';primary='<button class="primary" data-step="'+a.waiting[0]+'">요청한 교육 확인 →</button>';}
 else if(own&&s.done===s.total){taskTitle=completed?'교육 과정 확인을 마쳤습니다':'교육 확인 완료 · 포지션 평가 확인';taskNote='교육 확인과 메이킹·브루잉·ESP 통과 기록은 각각 관리합니다.';primary='<button class="primary" data-view="certification">포지션 평가·결과 보기 →</button>';}
 else if(own&&!start){taskTitle='교육 시작일을 기다리고 있어요';taskNote='교육자에게 시작일을 확인하고, 아래 과정과 교재를 먼저 살펴보세요.';primary='<button class="primary" data-view="curriculum">교육 목록 살펴보기 →</button>';}
 else{taskTitle=preview?'먼저 전체 교육 과정을 살펴보세요':esc(cloud.name)+'님의 교육 과정';taskNote=preview?'배정 전에는 과정과 교재를 미리 볼 수 있습니다. 실제 기록은 교육 배정 후 시작합니다.':'직원 체크 → 교육자 확인 요청 → 교육자 확인 완료 순서로 진행합니다.';primary='<button class="primary" data-view="curriculum">교육 목록 살펴보기 →</button>';}
 const utilities=(p.admin?'<button data-invite-participants>참여자 초대</button><button data-manage-users>구성원·권한 관리</button>':'')+(p.trainer?'<button data-view="trainer">교육자 확인</button>':'')+(p.assessor?'<button data-view="certification">평가 결과 기록</button>':'')+'<button data-view="schedule">교육 일정 · 간트차트</button><button data-view="curriculum">교육 목록</button>';
 return '<section class="education-home" aria-label="교육 개요"><div class="home-intro"><div class="home-intro-main"><p class="home-eyebrow">온천본점 · 현장 온보딩 <span>'+esc(educationIdentity())+'</span></p><h1>'+title+'</h1><p class="home-description">'+description+'</p><div class="home-status-strip"><div><span>교육 시작일</span><strong>'+(start?dateLabel(start):'미설정')+'</strong></div><div><span>교육자 확인 진척</span><strong>'+pct(s.done,s.total)+'% <small>'+s.done+'/'+s.total+'단계</small></strong></div><div><span>'+(end?'교육 완료일':'ESP 통과 목표')+'</span><strong>'+(end?dateLabel(end):start?dateLabel(goalDate()):'교육 시작 후 6개월')+'</strong></div></div></div><div class="home-next"><span class="home-next-label">'+(admin?'관리자의 다음 행동':own?'지금 할 일':p.trainer?'교육자가 챙길 일':'시작 안내')+'</span><h2>'+taskTitle+'</h2><p>'+taskNote+'</p>'+primary+'<small>'+(preview?'기본 과정 미리보기 · 실제 교육 기록 없음':'진행 가능 '+a.available.length+'개 · 확인 대기 '+a.waiting.length+'개 · 담당 교육자 '+esc(roster?.trainer||'미배정'))+'</small></div></div><div class="home-quick-actions"><span>바로가기</span>'+utilities+'<a href="/updates.html" target="_blank" rel="noopener">패치 내역 ↗</a></div>'+homeJourneyOverview()+workspaceSection('home-journey','단계별 교육·평가 자세히 보기','단원과 관련 교재를 확인',journeyPanel(),false)+workspaceSection('goal','포지션 평가 목표·결과','메이킹 · 브루잉 · ESP',goalPanel(),false)+workspaceSection('home-gantt','교육 일정 · 간트차트','Plan과 실제 수행을 날짜별로 비교',gantt(),false)+workspaceSection('home-course','전체 교육 항목','단원별 교육·확인 내용',curriculumRows(),false)+workspaceSection('home-source','정본·학습 대상 대조','원고와 교육 단계 연결',coveragePanel(),false)+'</section>';
}
function homeJourneyOverview(){
 const groups=curriculumData.journey.map(g=>{const steps=g.units.flatMap(id=>courseUnit(id).steps),done=steps.filter(s=>record(s.id).status==='done').length,test=g.test?person().tests[g.test].attempts.at(-1):null;return {g,steps,done,active:steps.some(s=>['practice','review'].includes(record(s.id).status)),finished:done===steps.length&&(!g.test||test?.result==='pass'),next:steps.find(s=>record(s.id).status!=='done')||steps[0]};});
 const current=groups.find(x=>x.active)||groups.find(x=>!x.finished),preview=!cloud?.enrolled;
 return '<section class="home-route" aria-labelledby="home-route-title"><div class="home-route-heading"><div><p class="home-eyebrow">현장 적응 → 운영 → 제조 기술·평가</p><h2 id="home-route-title">온보딩은 이렇게 진행됩니다</h2></div><span class="pill blue">교육안 '+esc(curriculumData.version)+'</span></div><ol class="home-route-list">'+groups.map(x=>{const {g,steps,done,next}=x,isCurrent=!preview&&x===current;return '<li class="home-route-stage '+(g.test?'skill ':'operation ')+(x.finished?'finished':isCurrent?'current':'')+'"><div class="home-route-stage-top"><span class="home-route-number">'+g.order+'</span><span>'+(g.test?'★ 제조 기술·평가':'현장 적응·운영')+'</span></div><h3>'+esc(g.title)+'</h3><p>'+esc(g.purpose)+'</p><div class="home-route-bottom"><span class="home-route-status">'+(preview?'과정 미리보기':x.finished?'확인 완료':isCurrent?x.active?'현재 교육 중':'다음으로 배울 단계':'교육 확인 '+done+'/'+steps.length)+'</span><button '+(g.test&&done===steps.length?'data-gantt-item="test-'+g.test+'"':'data-peek="'+next.id+'"')+'>'+(g.test&&done===steps.length?'평가 준비·결과 보기':'교육·확인 열기')+' →</button></div></li>';}).join('')+'</ol><p class="home-route-note">교재 읽기 <span>→</span> 실제 학습·수행 확인 <span>→</span> 교육자 확인 요청 <span>→</span> 확인 완료 <small>예정이 겹치는 교육은 병행할 수 있습니다. 포지션 시험은 별도로 평가합니다.</small></p></section>';
}
function schedule(){return page('교육 일정 · 간트차트','계획을 유지하고 실제 수행·지연 사유를 별도로 비교합니다.',workspaceSection('timeline-goal','6개월 ESP 목표와 포지션 시험','개별 예정일 · 평가/재시험 결과',goalPanel(),false)+workspaceSection('timeline-gantt','Plan · Action · 교육 일정 간트차트','별도 행 · 단원/교육 내용 열기',gantt(),true)+workspaceSection('timeline-records','실제 수행 · 지연 사유','내용과 기록은 항목을 눌러 확인합니다.',`<div class="scroll"><table><thead><tr><th>교육 항목</th><th>Plan · 계획</th><th>Action · 실제 수행</th><th>지연</th><th>사유</th></tr></thead><tbody>${allSteps().map(s=>{const p=planOf(s.id),r=record(s.id),d=scheduleDelay(s.id),note=(person().delayNotes||[]).filter(n=>n.item===s.id).at(-1);return `<tr><td><button data-peek="${s.id}">${esc(s.title)}</button><br><small>${esc(unitOf(s.id).title)}</small></td><td>${planLabel(p.start)} ~ ${planLabel(p.end)}</td><td>시작 ${dateLabel(r.start)}<br>확인 완료 ${dateLabel(r.done)}<br>${pill(r)}</td><td>${d.late?delayLabel(d):'—'}</td><td>${note?esc(note.reason):d.late?'미기록':'—'}<br><button data-step="${s.id}">내용 · 수행 기록${d.late?' · 사유 기록':''}</button></td></tr>`;}).join('')}</tbody></table></div>`,true));}
function planEditor(){if(!trainingStart())return '<div class="card"><h2>교육 시작일 미설정</h2><p>상대 기간 WBS를 먼저 확인하고 관리자에게 시작일 지정을 요청하세요.</p>'+templateTimeline()+'</div>';return `<div class="card"><h2>${NAMES[state.person]} · 개별 교육·시험 날짜 지정</h2><p>교육 시작일 ${dateLabel(trainingStart())} / 6개월 ESP 목표 ${dateLabel(goalDate())}. 아래 날짜는 이 교육생에게만 적용됩니다. 정본을 수정하지 않습니다.</p><details><summary>학습·실습 ${allSteps().length}단계 날짜 설정</summary><button data-load-source-plan>원본 권장 일정 불러오기 · 저장 전 미리보기</button><p class="muted">기존 개인 계획을 자동 변경하지 않습니다. 입력값을 검토하고 아래 ‘이 교육생의 실습 일정 반영’을 누르면 계획 변경 이력과 함께 저장합니다.</p><div class="scroll"><table><thead><tr><th>단원 / 단계</th><th>예정 시작일</th><th>예정 끝일</th></tr></thead><tbody>${allSteps().map(s=>`<tr><td>${unitOf(s.id).title}<br>${esc(s.title)}</td><td><input type="date" id="plan-start-${s.id}" value="${planOf(s.id).start}" aria-label="${esc(s.title)} 시작일"></td><td><input type="date" id="plan-end-${s.id}" value="${planOf(s.id).end}" aria-label="${esc(s.title)} 끝일"></td></tr>`).join('')}</tbody></table></div><button id="savePlan" style="margin-top:12px">이 교육생의 실습 일정 반영</button></details><div class="scroll" style="margin-top:16px"><table><thead><tr><th>시험</th><th>예정일</th><th>담당</th><th>반영</th></tr></thead><tbody>${TEST_DEFS.map(t=>`<tr><td>${esc(t.title)}</td><td><input type="date" id="test-plan-${t.id}" value="${planOf('test-'+t.id).start}"></td><td>${t.evaluator}</td><td><button data-save-test-plan="${t.id}">예정일 반영</button></td></tr>`).join('')}</tbody></table></div><small>입사일을 바꾸면 예정일도 함께 이동합니다. 첫 ESP 시험은 목표 14일 전으로 제안해 보완/재시험 여유를 둡니다. 재시험이 필요하면 다음 예정일을 지정하고 이전 예정일은 변경 이력에 보존합니다.</small></div>`;}
function loadSourcePlanPreview(unitId=null){
 if(!cloud?.permissions.trainer||!trainingStart()){toast('배정 교육자가 교육 시작일 지정 후 사용할 수 있습니다.');return;}
 for(const s of (unitId?courseUnit(unitId).steps:allSteps())){const p=s.defaultDays||unitOf(s.id).plan;document.getElementById('plan-start-'+s.id).value=addDay(trainingStart(),p[0]-1);document.getElementById('plan-end-'+s.id).value=addDay(trainingStart(),p[1]-1);}
 toast('원본 권장 일정을 입력란에 불러왔습니다. 검토 후 일정 반영을 눌러 저장하세요. 실제 수행 이력은 유지됩니다.');
}
function savePlan(){}
function saveTestPlan(){}
function recordPositionTest(){}
let activePositionTest=TEST_DEFS[0].id;
function certificationContent(){return positionTestCards()+`<div class="notice warning">배정된 평가자가 현장에서 시행한 평가 결과를 서버에 기록합니다. 체크·퀴즈만으로 시험 합격이 되지 않습니다. 합격 점수·허용 편차·재평가 조건은 원고 공란이며 교육자가 현재 기준을 확인해야 합니다.</div><div class="card"><label>접근 역할 <select id="testRole"><option value="learner" ${testRole==='learner'?'selected':''}>교육생 · 준비/결과 조회</option><option value="assessor" ${testRole==='assessor'?'selected':''}>평가 담당자 · 결과 기록</option></select></label></div>${TEST_DEFS.filter(t=>t.id===activePositionTest).map(t=>{const attempts=person().tests[t.id].attempts,u=course.find(u=>u.id===t.unit);return `<div class="card assessment" id="test-card-${t.id}"><header class="assessment-heading"><div><p class="assessment-kicker">포지션 평가</p><h2>${esc(t.title)}</h2><p class="muted">평가 준비 내용: ${esc(t.topics)}</p></div><dl class="assessment-meta"><div><dt>예정일</dt><dd>${planLabel(planOf('test-'+t.id).start)}</dd></div><div><dt>평가 담당자</dt><dd>${esc(t.evaluator)}</dd></div></dl></header><p class="assessment-route">점장 안내 → 매니저에게 문서/일지 받기 → 메인바리스타와 연습 일정 조율 → 이론·실습·일지 → 테스트 때 제출 → 결과·보완 확인</p>${positionPreparation(t,u)}${delayPanel("test-"+t.id)}<div class="actions">${refButtons('U47')}${refButtons('U48')}${testRole==='assessor'?'<button data-view="trainer">시험·실습 예정일 조정</button>':''}</div>${person().tests[t.id].planHistory.length?`<details><summary>시험 예정일 변경 이력 · ${person().tests[t.id].planHistory.length}건</summary>${person().tests[t.id].planHistory.map(x=>`<p>${dateLabel(x.changed)} 변경 · ${dateLabel(x.previous)} → ${dateLabel(x.next)}</p>`).join('')}</details>`:'<p class="empty-history">시험 예정일 변경 없음</p>'}<h3 id="position-result-${t.id}" style="margin-top:20px">응시·보완·재시험 이력</h3>${attempts.map(a=>`<div class="result"><strong>${a.attempt}차 · ${dateLabel(a.date)} · ${{pass:'통과 기록',retry:'보완·재시험',deferred:'평가 보류'}[a.result]}</strong><p>평가자 ${a.assessor}<br>근거: ${esc(a.criteria)}<br>피드백: ${esc(a.feedback)}</p><small>당시 교육안 ${a.educationVersion} / ${a.sourceVersion} · 기록 당시 판본 · 공식 평가 근거 별도</small></div>`).join('')||'<p class="muted">아직 평가 결과가 없습니다. 준비 체크만으로 통과 처리하지 않습니다.</p>'}${testRole==='assessor'?`<section class="assessment-entry"><h3>평가 결과 기록</h3><label>실제 시험일 <input type="date" id="test-date-${t.id}" value="${nowDay()}"></label><label>판정 <select id="test-result-${t.id}"><option value="">선택하세요</option><option value="pass">통과 기록</option><option value="retry">보완·재시험</option><option value="deferred">평가 보류</option></select></label><label style="display:block;margin-top:12px">평가 기준·근거 문서/판본<input type="text" id="test-criteria-${t.id}" style="width:100%" placeholder="현장에서 확인한 평가 기준·근거"></label><label>관찰·판정 이유·보완할 내용<textarea id="test-feedback-${t.id}"></textarea></label><label class="choice"><input type="checkbox" id="test-confirm-${t.id}">현장 평가 기준을 확인하고 판정한 결과입니다.</label><button class="primary" data-record-test="${t.id}">현장 평가 결과 저장</button></section>`:''}</div>`;}).join('')}`;}
function certification(){return page('포지션 테스트 · 준비·결과','메이킹(스팀 포함) · 브루잉 · ESP · 예정일과 평가 시도별 결과를 분리합니다.',certificationContent());}
function practiceLogPanel(s,includeHistory=true){if(!['making','brewing','espresso'].includes(unitOf(s.id).id))return '';const logs=person().practiceLogs.filter(l=>l.step===s.id);return `<div class="card"><h2>반복 연습 기록 · ${logs.length}회</h2><p class="muted">조건·관찰·피드백·다음 연습을 회차별로 남깁니다. 원고가 지정한 실험/연습 일지의 실제 제출을 대신하지 않습니다.</p><label>연습일 <input type="date" id="practice-date" value="${nowDay()}"></label><label style="display:block;margin-top:12px">원두·메뉴·실험 조건<input type="text" id="practice-condition" style="width:100%"></label><label>관찰·교육자 피드백·다음 연습<textarea id="practice-observation"></textarea></label><button data-log-practice="${s.id}">연습 회차 기록</button>${includeHistory?logs.slice().reverse().map(l=>`<div class="result"><strong>${dateLabel(l.date)} · ${esc(l.condition)}</strong><p>${esc(l.observation)}</p><small>기록 당시 실습 시도 ${l.attempt}차 · 교육안 ${l.educationVersion}</small></div>`).join(''):''}</div>`;}
function addPracticeLog(){}

function lessonGuideMarkup(s,body,expanded=true){
 return guideMarkup(body);
}
function lessonReviewNotes(s){
 const notes=(cloud?.lessonReviewNotes||[]).filter(r=>(r.relatedSteps||[r.step]).includes(s.id));
 if(!notes.length)return '';
 return '<aside class="notice warning lesson-review-notes" aria-label="이 교육 항목의 자료 보완 안내"><strong>교육자와 먼저 확인할 자료가 있어요.</strong>'+notes.map(r=>'<details open><summary>'+esc(r.title)+'</summary><p>'+esc(r.needed)+'</p><small>'+esc(r.evidence)+'</small><p class="muted">'+esc(r.sourceFile)+' · '+esc(r.sourceVersion)+' · 기준 확인 '+dateLabel(r.checkedAt)+'</p>'+(r.id==='glass-hand-photo'?'<p>현재 참고 사진은 잔 배열·트레이 구성을 보여줍니다. 잔을 잡는 손 위치는 교육자의 현장 시범으로 확인하세요.</p>':'')+'</details>').join('')+'<small>매장 내용 담당자에게 원본을 확인해 주세요. 보완 자료가 등록돼도 교재 반영은 별도로 확인합니다.</small></aside>';
}
function lessonSource(s,expanded=true){const id=s.ref||unitOf(s.id).ref,body=s.section?source.fragments[id+"|"+s.section]:source.guides[id];return `${lessonReviewNotes(s)}<section class="source-detail" data-canonical-ref="${esc(id)}"><h3>관련 정본 · ${esc(s.section||source.refs[id].title)}</h3><p class="source-dates">정본 기준 확인일 ${dateLabel(source.sourceInfo?.canonical?.checkedAt)} · 교육자료 반영일 ${dateLabel(source.sourceInfo?.canonical?.reflectedAt)}</p><div class="notice warning">원고 검토본 0.3의 읽기 사본입니다. 교육용 체크는 구성 제안이며 원고 승인·시행 상태를 바꾸지 않습니다.</div><div class="guide">${lessonGuideMarkup(s,body,expanded)||"해당 상세를 교육자에게 확인하세요."}</div>${s.section?`<button data-full-guide="${esc(id)}">전체 정본 내용 보기</button>`:""}</section>`;}
function page(title,desc,body){return `<div class="pagehead"><div><h1>${title}</h1><p class="muted">${desc}</p></div><span class="pill blue">교육안 ${esc(curriculumData.version)}</span></div><div class="education-navigation"><button data-education-back>← 이전 화면</button><button data-view="home">교육 홈</button><button data-education-top>맨 위로 ↑</button><a href="/updates.html" target="_blank" rel="noopener">패치 내역 ↗</a></div>${workspaceTabs()}${body}`;}
function unitProgress(u){return u.steps.filter(s=>record(s.id).status==='done').length;}
function unitTiming(u){const rs=u.steps.map(s=>record(s.id)),starts=rs.flatMap(r=>[r.start,...r.history.map(h=>h.start)]).filter(Boolean).sort();return{start:starts[0]||null,end:rs.every(r=>r.status==='done')?rs.map(r=>r.done).sort().at(-1):null,active:starts.length>0};}
function checks(id,teacher=false){const s=findStep(id),r=record(id),a=teacher?r.teacher:r.self,disabled=teacher?r.status!=='review':['done','review'].includes(r.status);return s.checks.map((text,i)=>`<label class="checkrow ${a[i]?'checked':''} ${disabled?'disabled':''}"><input type="checkbox" data-check="${id}" data-index="${i}" data-role="${teacher?'teacher':'self'}" ${a[i]?'checked':''} ${disabled?'disabled':''}><div><strong>${esc(text)}</strong><small>직원 ${dateLabel(r.selfAt[i])} · 교육자 ${dateLabel(r.teacherAt[i])} · ${r.attempt}차 시도</small></div></label>`).join('');}
function lessonTeacherConfirmation(s){
 const r=record(s.id);if(!cloud?.permissions.trainer||r.status!=='review')return '';
 return '<section class="card" id="lesson-teacher"><h2>교육자 · 교육 내용 합의와 확인</h2><p>직원 체크·메모와 배운 내용·수행 항목을 함께 확인한 뒤 항목별 확인을 기록하세요.</p><p>직원 메모: '+esc(r.memo||'없음')+'</p>'+checks(s.id,true)+'<button data-complete="'+s.id+'" '+(!r.teacher.every(Boolean)?'disabled':'')+'>합의 후 확인 완료 · 상위/전체 진척 반영</button><small>배정된 교육자만 완료할 수 있습니다. 다음 미완료 교육 항목을 안내하며 시험 통과는 별도입니다.</small></section>';
}
function unitSequencePanel(s){
 const u=unitOf(s.id);return '<section class="task-sequence"><h2>'+esc(u.title)+'</h2><p>항목을 선택하면 같은 교육창에서 내용이 바뀝니다. 읽기·설명·실제 수행은 정본과 체크 항목에 따라 교육자와 확인하세요.</p><ol>'+u.steps.map(x=>'<li '+(x.id===s.id?'aria-current="step"':'')+'>'+(x.id===s.id?'<strong>'+esc(x.title)+'</strong> <span class="pill blue">현재 항목</span>':'<button data-sequence-step="'+x.id+'">'+esc(x.title)+'</button>')+' '+pill(record(x.id))+'</li>').join('')+'</ol><p>단원 확인 '+unitProgress(u)+'/'+u.steps.length+' · 전체 확인 '+stats().done+'/'+stats().total+'</p></section>';
}
function lessonHistoryContent(id){const s=findStep(id),r=record(id);return `<section class="card"><h2>교육 이력</h2><p class="muted">${esc(s.title)} · 수행·확인·재교육·연습과 협업 기록을 여기서 확인합니다. 교육 항목으로 돌아가면 보던 위치에서 이어집니다.</p></section><div class="card" id="lesson-history"><h2>교육 재확인 · 수행 이력</h2><p class="muted">이전 체크·확인을 보존하고 이 단계의 새 시도만 시작합니다.</p><label>다시 연습할 이유<textarea id="retryReason" placeholder="예: 잔 잡는 동작을 다시 연습하기"></textarea></label><button data-retry="${s.id}" style="margin-top:10px">다시 연습</button><div class="history" style="margin-top:20px">${state.events.filter(e=>e.person===state.person&&e.id===s.id).slice().reverse().map(e=>`<p><strong>${dateLabel(e.date)} · ${e.attempt}차</strong><br>${esc(e.text)}</p>`).join('')||'<p>아직 교육 이력이 없습니다.</p>'}</div>${r.history.map(h=>`<details><summary>${h.attempt}차 보존 기록 · ${statusNames[h.status]} · ${dateLabel(h.start)}~${dateLabel(h.done)}</summary><p>직원 ${h.self.filter(Boolean).length}/${h.self.length} · 교육자 ${h.teacher.filter(Boolean).length}/${h.teacher.length}<br>${esc(h.memo||'메모 없음')}<br>당시 교육안 ${esc(h.lessonVersion||'0.3')} · 원고 0.3</p></details>`).join('')}</div>`+practiceLogPanel(s)+delayPanel(s.id);}
function lessonContent(id){const s=findStep(id),u=unitOf(s.id),r=record(s.id),ref=source.refs[s.ref||u.ref],p=planOf(s.id);return `<details class="card" data-education-sequence><summary>단원 교육 항목·진척 · ${unitProgress(u)}/${u.steps.length} 확인</summary>${unitSequencePanel(s)}</details>${practiceAction(s)}<details class="card"><summary>교육 확인·완료 안내</summary>${completionPanel(s)}</details><div class="card" id="lesson-material"><div class="actions">${pill(r)}<span class="pill">${r.attempt}차 시도</span><span class="pill">${r.start?'시작 '+dateLabel(r.start)+' · '+elapsed(r)+'일 경과':'아직 시작하지 않음'}</span></div><h2 style="margin-top:18px">교재와 관련 기준</h2><p class="muted">개별 예정 ${planLabel(p.start)}~${planLabel(p.end)} · 교육안 ${esc(r.lessonVersion)} / 원고 검토본 0.3</p>${s.copy.map(t=>`<p>${esc(t)}</p>`).join('')}${coaching(s)}${s.photos.length?`<div class="photos">${s.photos.map(photo).join('')}</div>`:''}${s.id==='welcome-hygiene'?'<div class="placeholder"><strong>손 위치 시범 사진 보완 필요</strong><br>현재 원고에서 잔을 잡는 손 위치를 직접 보여 주는 사진은 확인되지 않았습니다. 교육자 시범을 먼저 보고 연습합니다. 함께 표시한 잔 사진은 손잡이·잔 상태 확인용입니다.</div>':''}${s.note?`<div class="notice warning">${esc(s.note)}</div>`:''}${r.feedback?`<div class="notice">교육자 피드백 · ${esc(r.feedback)}</div>`:''}<section class="lesson-references"><div class="reference-heading"><h3>관련 기준</h3><small>아래에 있는 기준은 그 위치로 이동합니다. 다른 기준은 같은 창에서 열고 돌아옵니다.</small></div><div class="reference-buttons">${(s.refs||[s.ref||u.ref]).map(refButtons).join('')}</div><div class="reference-footer"><button class="reference-contact" data-contact="${s.id}">이 단계에서 문의 · 답변</button><a href="${esc(wiki(s.ref||u.ref))}" target="_blank" rel="noopener noreferrer">전체 업무 가이드 ↗</a></div></section><small>출처: ${esc(ref.file)} · 검토본 0.3 · ${esc(ref.title)}</small>${lessonSource(s)}</div><div><div class="card" id="lesson-checks"><h2>배운 내용·수행 항목 확인 <span class="pill green">${r.self.filter(Boolean).length}/${r.self.length}</span></h2><p class="muted">정본과 체크 항목에 따라 배운 내용이나 수행한 내용을 하나씩 확인하세요. ‘교육 시작’을 먼저 누르세요. 시작하지 않고 첫 항목을 체크해도 실제 시작일이 기록됩니다.</p>${checks(s.id)}${r.status==='done'?'<div class="notice">교육자가 확인한 완료 기록입니다. ‘교육 이력’의 ‘다시 연습’으로 새 시도를 시작할 수 있습니다.</div>':r.status==='review'?'<div class="notice">확인 요청 후 체크는 잠겨 있습니다. 배정 교육자의 확인을 기다리는 상태입니다. 수정이 필요하면 ‘교육 이력’에서 사유를 남기고 다시 연습하세요.</div>':''}<label>교육 메모<textarea data-memo="${s.id}" ${['done','review'].includes(r.status)?'disabled':''} placeholder="어려운 부분·교육자에게 확인할 내용">${esc(r.memo)}</textarea></label><div class="actions" style="margin-top:12px"><button data-request="${s.id}" ${r.status!=='practice'||!r.self.every(Boolean)?'disabled':''}>교육자 확인 요청</button></div></div></div>`+lessonTeacherConfirmation(s)+practiceLogPanel(s,false)+delayPanel(s.id,false);}
function lesson(){return page(unitOf(selected).title,findStep(selected).title,lessonContent(selected));}
const bank=[{"id": "hygiene-1", "type": "choice", "ref": "U03", "title": "잔을 들기 전에 확인할 내용으로 알맞은 것은?", "explain": "제출 후 서버에서 원고와 대조합니다."}, {"id": "iced-1", "type": "choice", "ref": "U25", "title": "ICED 아메리카노에서 물과 얼음을 넣는 순서는?", "explain": "제출 후 서버에서 원고와 대조합니다."}, {"id": "iced-2", "type": "choice", "ref": "U25", "title": "ICED 라떼에서 얼음과 우유를 넣는 순서는?", "explain": "제출 후 서버에서 원고와 대조합니다."}, {"id": "report-1", "type": "choice", "ref": "U07", "title": "오픈 중 현장에서 발견한 이상은 누구에게 먼저 전달하도록 원고에 되어 있나요?", "explain": "제출 후 서버에서 원고와 대조합니다."}, {"id": "photo-1", "type": "photo", "ref": "U16", "title": "원고에서 냅킨 로고가 보이도록 배치한 좋은 예는 어느 사진인가요?", "explain": "제출 후 서버에서 원고와 대조합니다."}, {"id": "photo-2", "type": "photo", "ref": "U16", "title": "HOT 라떼에 맞는 소서는 어느 사진인가요?", "explain": "제출 후 서버에서 원고와 대조합니다."}, {"id": "match-1", "type": "match", "ref": "U16", "title": "음료와 소서를 원고 기준에 맞게 연결하세요.", "explain": "제출 후 서버에서 원고와 대조합니다."}, {"id": "match-2", "type": "match", "ref": "U25", "title": "ICED 메뉴의 두 재료 투입 순서를 연결하세요.", "explain": "제출 후 서버에서 원고와 대조합니다."}, {"id": "order-1", "type": "order", "ref": "U25", "title": "네 음료가 한 주문으로 들어왔습니다. 어떤 제조·완성 순서로 진행하겠나요?", "explain": "제출 후 서버에서 원고와 대조합니다."}, {"id": "order-2", "type": "order", "ref": "U25", "title": "뜨거운 음료 두 잔과 차가운 음료 두 잔을 함께 제공하려 합니다. 순서와 이유를 정하세요.", "explain": "제출 후 서버에서 원고와 대조합니다."}, {"id": "order-3", "type": "order", "ref": "U25", "title": "라떼와 아메리카노 네 잔 주문입니다. 제조 보조라면 어떤 순서를 제안하겠나요?", "explain": "제출 후 서버에서 원고와 대조합니다."}];
const typeNames={choice:'선택형',photo:'사진 판단형',match:'짝 맞추기',order:'제조 순서 · 이유 설명'};
function shuffle(list){const a=[...list];for(let i=a.length-1;i>0;i--){const bytes=new Uint32Array(1);crypto.getRandomValues(bytes);const j=Math.floor(bytes[0]/4294967296*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function assignExam(){}
function setAnswer(id,value){const t=person().exam;if(t?.status==='assigned'&&t.questions.some(q=>q.id===id&&['choice','photo'].includes(q.type)))t.answers[id]=value;}
function setMatch(id,index,value){const t=person().exam,q=t?.questions.find(q=>q.id===id);if(t?.status==='assigned'&&q?.type==='match'&&index>=0&&index<q.pairs.length)t.answers[id][index]=value;}
function setReason(id,value){const t=person().exam;if(t?.status==='assigned'&&t.questions.some(q=>q.id===id&&q.type==='order'))t.answers[id].reason=value;}
function moveAnswer(id,index,delta){const t=person().exam;if(t?.status!=='assigned')return;const a=t.answers[id]?.order;if(!a||index+delta<0||index+delta>=a.length)return;[a[index],a[index+delta]]=[a[index+delta],a[index]];}
function submitExam(){}
function gradeEssay(){}
const resultNames={correct:'원고와 일치',incorrect:'원고 재확인',pending:'교육자 확인 대기',adequate:'설명 확인',repractice:'재실습 필요'};
function questionBody(q,t){const a=t.answers[q.id],disabled=t.status!=='assigned';if(['choice','photo'].includes(q.type))return q.options.map((o,i)=>`<label class="choice"><input type="radio" name="${q.id}" data-answer="${q.id}" value="${esc(o)}" ${a===o?'checked':''} ${disabled?'disabled':''}>${q.type==='photo'?`<span>사진 ${i+1}<br><img src="${source.photos[o].src}" alt="판단할 사진 ${i+1}" style="width:200px;max-width:100%;height:150px;object-fit:contain"></span>`:esc(o)}</label>`).join('');if(q.type==='match')return q.pairs.map((p,i)=>`<label class="choice"><span style="min-width:130px">${esc(p.left)}</span><select data-match="${q.id}" data-pair="${i}" ${disabled?'disabled':''}><option value="">선택하세요</option>${q.choices.map(o=>`<option ${a[i]===o?'selected':''} value="${esc(o)}">${esc(o)}</option>`).join('')}</select></label>`).join('');return `<p>${esc(q.context)}</p><p class="muted">처음 배열은 무작위입니다. 위·아래 버튼으로 원하는 순서를 만들고, 병행 구간·판단 이유를 적으세요.</p>${a.order.map((o,i)=>`<div class="orderrow"><span>${i+1}</span><strong>${esc(o)}</strong><button data-move="${q.id}" data-index="${i}" data-delta="-1" aria-label="${esc(o)} 위로" ${disabled||i===0?'disabled':''}>↑</button><button data-move="${q.id}" data-index="${i}" data-delta="1" aria-label="${esc(o)} 아래로" ${disabled||i===a.order.length-1?'disabled':''}>↓</button></div>`).join('')}<label>이 순서의 이유 · 동시에 할 작업 · 교육자에게 확인할 조건<textarea data-reason="${q.id}" ${disabled?'disabled':''}>${esc(a.reason)}</textarea></label><small>교육자 서술 검토형 · 공식 정답 순서 미등록</small>`;}
function examSummary(t){const res=Object.values(t.results),correct=res.filter(r=>r.status==='correct').length,auto=t.questions.filter(q=>q.type!=='order').length,pending=res.filter(r=>r.status==='pending').length;return `<div class="notice">${t.attempt}차 테스트 · 배정 ${dateLabel(t.date)} ${t.submitted?'· 제출 '+dateLabel(t.submitted):''} · ${t.status==='assigned'?'답안 작성 중':'원고 대조 '+correct+'/'+auto+'문항 · 교육자 대기 '+pending+'문항'}<br>교육자 교육 확인·공식 포지션 인증과 별도입니다. 자동 대조 결과로 교육 진척률을 올리지 않습니다.</div>`;}
function exam(){const t=person().exam;return page('학습 퀴즈','원고 기반 지식 문항과 상황 판단 문항을 이 화면에서 풀어 봅니다.',`<div class="notice warning">문항 ${bank.length}개에서 유형별 한 문항씩 배정합니다. 배정한 문제는 새로고침해도 유지됩니다. 서버가 유형별 문항과 선택지를 무작위 배정합니다. 답안·문항은 서버에 보존하며 제출 전 정답 필드는 내려보내지 않습니다.</div><div class="card">${t?examSummary(t):'<h2>아직 배정된 테스트가 없습니다.</h2><p>선택형 · 사진형 · 짝 맞추기 · 제조 순서/이유 설명, 총 4문항을 배정합니다.</p><button id="startExam" class="primary">무작위 문제 배정 · 시작</button>'}${t?t.questions.map((q,i)=>`<div class="question"><span class="pill">${i+1}. ${typeNames[q.type]}</span><h2 style="margin-top:10px">${esc(q.title)}</h2>${questionBody(q,t)}${t.results[q.id]?`<div class="result"><strong>${resultNames[t.results[q.id].status]}</strong><p>${esc(t.results[q.id].feedback)}</p>${q.type==='order'?'<small>예시 제조 순서를 고정 정답으로 확정하지 않았습니다.</small>':q.type==='photo'?`<small>원고의 해당 사진: ${q.answer==='3'?'냅킨·커트러리 좋은 예':'라떼 소서'}</small>`:q.type==='match'?`<small>${q.pairs.map(p=>esc(p.left+' → '+p.right)).join(' / ')}</small>`:`<small>원고 기준: ${esc(q.answer)}</small>`}</div>`:''}<div class="actions" style="margin-top:12px">${refButtons(q.ref)}</div></div>`).join(''):''}${t?`<div class="actions">${t.status==='assigned'?'<button id="submitExam" class="primary">답안 제출 · 원고 대조</button>':'<button id="newExam">이전 답안 보존하고 새 문제로 재응시</button><button data-view="trainer">교육자 답안 확인</button>'}</div>`:''}</div>${person().examArchive.length?`<div class="card"><h2>보존된 이전 테스트</h2>${person().examArchive.map(x=>`<details><summary>${x.attempt}차 · ${dateLabel(x.submitted)} · 문항 ${x.questions.length}개</summary>${examSummary(x)}${x.questions.map(q=>`<p><strong>${esc(q.title)}</strong><br>답안: ${esc(q.type==='order'?x.answers[q.id].order.join(' → ')+' / '+x.answers[q.id].reason:q.type==='match'?x.answers[q.id].join(' / '):q.type==='photo'?'사진 선택 기록 보존':x.answers[q.id])}<br>결과: ${resultNames[x.results[q.id]?.status]||'미제출'} · ${esc(x.results[q.id]?.feedback||'')}</p>`).join('')}</details>`).join('')}</div>`:''}`);}
function trainer(){const rs=allSteps().filter(s=>record(s.id).status==='review'),t=person().exam,order=t?.questions.find(q=>q.type==='order');return page('교육 담당자','실습 항목을 확인하고, 교육 일정과 테스트 답안을 검토합니다.',metrics()+`<div class="notice">${NAMES[state.person]}에게 배정된 교육자의 확인 화면입니다. 확인자·날짜·이력이 서버에 보존됩니다.</div><div class="card"><h2>확인 요청 ${rs.length}건</h2>${rs.map(s=>`<div class="question"><h3>${esc(s.title)}</h3><small>요청 ${dateLabel(record(s.id).request)} · ${dayNumber(nowDay())-dayNumber(record(s.id).request)}일 대기</small><p>직원 메모: ${esc(record(s.id).memo||'없음')}</p>${checks(s.id,true)}<div class="actions"><button class="primary" data-complete="${s.id}" ${!record(s.id).teacher.every(Boolean)?'disabled':''}>항목 확인 완료 · 진척 반영</button><button data-step="${s.id}">교재 보기</button></div><label>교육 재확인 피드백<textarea id="feedback-${s.id}" placeholder="보완할 동작·기준·다시 연습할 이유"></textarea></label><button data-return="${s.id}">피드백 후 다시 연습</button></div>`).join('')||'<p class="muted">교육 항목을 모두 체크하고 확인을 요청하면 여기에 표시됩니다.</p>'}</div>${planEditor()}<div class="card"><h2>포지션 시험 결과</h2><p>교육 확인과 별도로 메이킹·브루잉·ESP의 실제 평가 시도·근거·결과를 기록합니다.</p><button data-view="certification">포지션 테스트 열기</button></div><div class="card"><h2>메뉴 제조 순서 답안 검토</h2>${t?.status==='submitted'&&order?`${examSummary(t)}<h3>${esc(order.title)}</h3><p>${esc(t.answers[order.id].order.join(' → '))}</p><p style="white-space:pre-wrap">${esc(t.answers[order.id].reason)}</p><div class="notice warning">교육자 검토 관점 초안: ${esc(order.rubric)}<br>아이스 라떼를 마지막에 만드는 사례를 공식 정답으로 등록하지 않았습니다.</div><label>교육자 판단 <select id="gradeResult"><option value="adequate">설명 확인</option><option value="repractice">재실습 필요</option></select></label><label style="display:block;margin-top:10px">확인 근거 · 피드백<textarea id="gradeFeedback">${esc(t.results[order.id]?.status==='pending'?'':t.results[order.id]?.feedback||'')}</textarea></label><button data-grade="${order.id}" style="margin-top:10px">근거와 함께 확인 기록</button>${t.results[order.id]?.status!=='pending'?`<p>${resultNames[t.results[order.id]?.status]} · ${dateLabel(t.results[order.id]?.date)}</p>`:''}`:'<p class="muted">교육생이 테스트 답안을 제출하면 제조 순서와 설명을 확인할 수 있습니다.</p>'}</div><div class="card"><h2>문제은행 구성</h2><p>유형별 문제를 여러 개 보관하고 교육생·재응시마다 새 조합을 배정합니다. 선택지와 최초 순서도 섞습니다. 정본이 바뀌면 답안 근거와 해당 교육 자료를 함께 재검토해야 합니다.</p><div class="scroll"><table><thead><tr><th>유형</th><th>변형 수</th><th>대조 방식</th><th>출처·상태</th></tr></thead><tbody>${['choice','photo','match','order'].map(type=>`<tr><td>${typeNames[type]}</td><td>${bank.filter(q=>q.type===type).length}개</td><td>${type==='order'?'교육자 서술 확인':'검토 원고와 자동 대조'}</td><td>${type==='order'?'교육용 상황 초안 · 허용 순서 미정':'근무 준비·픽업·오픈·음료 제조 원고'}</td></tr>`).join('')}</tbody></table></div><details style="margin-top:16px"><summary>문항·원고 근거 펼치기</summary>${bank.map(q=>`<p style="margin-top:12px"><span class="pill">${typeNames[q.type]}</span> ${esc(q.title)}<br><small>${esc(source.refs[q.ref].title)} · ${q.type==='order'?'자동 정답 미등록':esc(q.explain)}</small></p>`).join('')}</details></div><div class="card"><h2>오래 머문 단계</h2>${allSteps().filter(s=>record(s.id).start&&record(s.id).status!=='done').sort((a,b)=>elapsed(record(b.id))-elapsed(record(a.id))).map(s=>`<p><button data-step="${s.id}">${esc(s.title)}</button> · ${elapsed(record(s.id))}일 경과 · ${statusNames[record(s.id).status]}</p>`).join('')||'<p class="muted">시작한 미완료 단계가 없습니다.</p>'}<small>휴무·담당자 대기를 포함하므로 경과일을 개인 성과로 해석하지 않습니다.</small></div>`);}
const supportTypes={technical:{label:'기술 문의',owner:'치얼스',categories:['체크·저장 오류','화면·사용성','가입·로그인·권한','기타 기술 문의']},content:{label:'내용 문의',owner:'매장 지정 담당자 · 치얼스 지원',categories:['내용 상충','기준 변경','설명·사진 보완','문제·채점 기준','기타 내용 문의']}};
const ticketNames={received:'접수',working:'기술 확인 중',review:'매장 검토 중',answered:'답변 완료',approved:'변경안 승인 · 정본 반영 대기',closed:'종료'};
const faqItems=[
 {title:'완료한 교육 항목의 체크를 다시 바꾸고 싶어요.',answer:'교육자 확인 대기·완료 단계는 기존 기록을 보존하기 위해 체크가 잠깁니다. 해당 교재에서 다시 연습할 이유를 적고 새 시도를 시작하세요. 이전 확인 이력은 남습니다.',type:'사용 방법'},
 {title:'원고와 현장 방식이 다르거나 내용이 상충해요.',answer:'문의 · 답변에서 내용 문의를 선택하고 내용 상충 또는 기준 변경을 고르세요. 현재 기준·현장 상황·바꾸려는 내용을 함께 적으면 매장 담당자가 검토합니다. 접수나 답변만으로 정본이 바뀌지는 않습니다.',type:'내용 변경'},
 {title:'셀프 체크를 했는데 교육 진척률이 그대로예요.',answer:'직원 수행률은 직접 체크한 항목 비율이고 교육 진척률은 교육자가 확인 완료한 단계 비율입니다. 항목을 모두 체크한 뒤 확인을 요청하세요.',type:'사용 방법'},
 {title:'테스트 대조 결과가 포지션 인증인가요?',answer:'이 초안의 원고 대조·교육자 서술 확인은 공식 포지션 인증과 구분합니다. 공식 평가 준비·일지 제출·담당자 진행은 평가 절차에서 확인하세요.',type:'평가 안내',ref:'U48'}
];
let supportRole='employee',ticketSelection=null,faqSearch='',inquiryDrafts={A:{},B:{}},accountStage='form';
function initSupport(){state.support??={tickets:[],faqCandidates:[]};state.support.tickets??=[];state.support.faqCandidates??=[];}
initSupport();
function inquiryDraft(){return inquiryDrafts[state.person]||{};}
function captureInquiry(){const d={...inquiryDraft()};for(const id of ['inquiryType','inquiryTitle','inquiryChange','inquiryVisibility']){const n=document.getElementById(id);if(n)d[id]=n.value;}for(const id of ['inquiryBody','inquiryExpected']){const n=document.getElementById(id);if(n){d[id]=n.innerText||n.textContent||'';d[id+'Html']=n.innerHTML;}}inquiryDrafts[state.person]=d;return d;}
function beginInquiry(stepId,refId){inquiryDrafts[state.person]={inquiryStep:stepId||selected,refOverride:refId||null};ticketSelection=null;supportRole='employee';view='inquiries';render();}
function createInquiry(){}
function visibleTickets(){initSupport();return state.support.tickets.filter(t=>supportRole==='employee'?t.person===state.person:supportRole==='store'?t.type==='content'&&t.store==='온천본점':true);}
function canHandle(t){return supportRole==='cheers'&&t.type==='technical'||supportRole==='store'&&t.type==='content';}
function replyTicket(){}
function changeTicket(){}
function nominateFAQ(){}
function faq(){const q=faqSearch.trim().toLowerCase(),items=faqItems.filter(f=>(f.title+' '+f.answer).toLowerCase().includes(q));return page('FAQ','반복되는 사용 질문을 먼저 찾아보고, 내 상황은 문의 · 답변로 남깁니다.',`<div class="notice">이 초안의 사용 방법 FAQ입니다. 문의 답변은 자동 공개하지 않습니다. 운영 내용 FAQ는 매장 담당자의 근거 확인·승인 후 공개할 구성입니다.</div><div class="card"><div class="actions"><input id="faqSearch" type="text" placeholder="FAQ 검색" value="${esc(faqSearch)}" aria-label="FAQ 검색"><button id="searchFAQ">검색</button><button data-view="inquiries">문의 · 답변</button></div>${items.map(f=>`<details class="question"><summary><span class="pill">${f.type}</span> <strong>${esc(f.title)}</strong></summary><p style="margin-top:12px">${esc(f.answer)}</p>${f.ref?refButtons(f.ref):''}</details>`).join('')||'<p style="margin-top:20px">해당 FAQ가 없습니다. 문의 · 답변에서 상황을 남겨 주세요.</p>'}</div>`);}
function ticketDetail(t){const mayReply=t.person===(cloud.target===cloud.user.id?'A':cloud.user.id)||canHandle(t);return `<section class="card" id="inquiry-detail"><div class="actions"><span class="pill ${t.type==='technical'?'blue':'green'}">${supportTypes[t.type].label}</span><span class="pill">${ticketNames[t.status]}</span><span class="pill">${t.visibility==='shared'?'교육 참여자 공유':'작성자·담당자만'}</span></div><h2>${esc(t.title)}</h2><p class="muted">${esc(t.author)} · ${dateLabel(t.created)} · 담당 ${supportTypes[t.type].owner}</p><h3>상황 설명</h3><div class="inquiry-rich">${t.bodyHtml||esc(t.body).replace(/\n/g,'<br>')}</div>${t.expected||t.expectedHtml?`<h3>기대 동작·원하는 도움</h3><div class="inquiry-rich">${t.expectedHtml||esc(t.expected).replace(/\n/g,'<br>')}</div>`:''}${t.proposal?`<h3>내용 변경 제안</h3><p>${esc(t.proposal)}</p>`:''}${attachmentLinks(t.attachments)}${t.decision?`<div class="notice">${esc(t.decision.reason)} · ${esc(t.decision.status)}</div>`:''}<h3>답변·추가 설명</h3>${t.messages.map(m=>`<article class="inquiry-answer"><strong>${esc(m.actor)} · ${dateLabel(m.date)}</strong><div class="inquiry-rich">${m.html||esc(m.text).replace(/\n/g,'<br>')}</div>${attachmentLinks(m.attachments)}</article>`).join('')||'<p class="muted">아직 답변이 없습니다.</p>'}${mayReply&&t.status!=='closed'?richEditor('ticketReply','답변·추가 설명',replyDrafts[t.id]?.html||'')+attachmentPicker('reply',replyDrafts[t.id]?.attachments||[])+`<button class="primary" data-ticket-reply="${t.id}">답변 저장</button><small>이 문의와 같은 공유 범위로 답변을 저장합니다.</small>`:''}${canHandle(t)?`<details><summary>담당자 처리</summary><label>처리 근거<textarea id="ticketReason" maxlength="2000"></textarea></label><div class="actions"><button data-ticket-action="work" data-ticket="${t.id}" ${t.status!=='received'?'disabled':''}>${t.type==='technical'?'기술 확인 시작':'매장 검토 시작'}</button><button data-ticket-action="answer" data-ticket="${t.id}" ${!['received','working','review'].includes(t.status)?'disabled':''}>답변 완료</button>${t.type==='content'?`<button data-ticket-action="approve" data-ticket="${t.id}" ${!['review','answered'].includes(t.status)||!t.proposal?'disabled':''}>변경안 승인 · 정본 반영 대기</button>`:''}<button data-ticket-action="close" data-ticket="${t.id}" ${t.status!=='answered'?'disabled':''}>처리 종료</button></div><small>문의 답변은 정본 수정·승인된 운영 기준을 대신하지 않습니다.</small></details>`:''}<details><summary>처리 이력</summary>${t.history.map(h=>`<p>${dateLabel(h.date)} · ${esc(h.actor)} · ${esc(h.action)} ${esc(h.reason||'')}</p>`).join('')}</details></section>`;}
function inquiries(){initSupport();const d=inquiryDraft(),kind=supportTypes[d.inquiryType],tickets=visibleTickets(),current=state.support.tickets.find(t=>t.id===ticketSelection);return page('문의 · 답변','기술 문제는 치얼스, 내용 문제는 매장이 확인합니다. 함께 보는 답변으로 같은 질문을 다시 찾을 수 있습니다.',`<div class="actions"><button data-view="faq">FAQ 먼저 보기</button><button data-new-inquiry class="primary">새 문의 작성</button></div><section class="card"><h2>새 문의</h2><div class="inquiry-fields"><label>문의 구분 · 필수<select id="inquiryType"><option value="">선택하세요</option>${Object.entries(supportTypes).map(([id,k])=>`<option value="${id}" ${d.inquiryType===id?'selected':''}>${k.label}</option>`).join('')}</select></label><label>답변 공유 범위<select id="inquiryVisibility"><option value="shared" ${(d.inquiryVisibility||'shared')==='shared'?'selected':''}>교육 참여자와 함께 보기</option><option value="private" ${d.inquiryVisibility==='private'?'selected':''}>작성자·담당자만 보기</option></select></label></div>${kind?`<p class="notice">담당: ${kind.owner} · ${d.inquiryType==='technical'?'버튼·저장·화면·로그인 문제':'내용 상충·기준 변경·설명 보완'}</p>`:''}<label class="field">제목 · 필수<input id="inquiryTitle" maxlength="120" value="${esc(d.inquiryTitle||'')}" placeholder="무엇을 확인하거나 고쳐야 하나요?"></label>${richEditor('inquiryBody','상황 설명 · 글 또는 사진 필수',d.inquiryBodyHtml||esc(d.inquiryBody||''))}${richEditor('inquiryExpected','기대 동작·원하는 도움',d.inquiryExpectedHtml||esc(d.inquiryExpected||''))}${d.inquiryType==='content'?`<details><summary>내용 변경 제안 · 선택</summary><textarea id="inquiryChange" maxlength="2000">${esc(d.inquiryChange||'')}</textarea></details>`:''}${attachmentPicker('inquiry',d.attachments||[])}<button class="primary" id="createInquiry">문의 접수</button><p class="muted">공유 문의와 답변은 승인된 교육 참여자만 볼 수 있습니다. 개인정보가 포함된 내용은 ‘작성자·담당자만’을 선택하세요. 기존 비공개 문의는 공개되지 않습니다.</p></section><section class="card"><div class="actions">${[['shared','함께 보는 문의'],['mine','내 문의'],['assigned','담당 문의']].filter(([id])=>id!=='assigned'||cloud.permissions.technical||cloud.permissions.content).map(([id,label])=>`<button data-inquiry-list="${id}" class="${inquiryList===id?'primary':''}">${label}</button>`).join('')}<input id="inquirySearch" type="search" value="${esc(inquirySearch)}" placeholder="질문·답변 검색" aria-label="질문·답변 검색"></div>${tickets.slice().reverse().map(t=>`<article class="unitrow"><div><button data-ticket-open="${t.id}">${esc(t.title)}</button><small>${supportTypes[t.type].label} · ${esc(t.author)} · ${dateLabel(t.created)} · ${t.messages.length}개 답변</small></div><span class="pill">${ticketNames[t.status]}</span></article>`).join('')||'<p class="muted">이 목록에 문의가 없습니다.</p>'}</section>${current?ticketDetail(current):''}`);}
function account(){}

const WS_ICONS={home:'<path d="M3 10l9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>',list:'<path d="M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1"/>',board:'<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="10" rx="1"/>',schedule:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M6 14h6M12 18h6"/>',lesson:'<path d="M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3zM12 6v15"/>',certification:'<circle cx="12" cy="9" r="6"/><path d="M8 14l-1 7 5-3 5 3-1-7M9 9l2 2 4-4"/>',exam:'<path d="M8 3h8v4H8zM8 5H5v16h14V5h-3M8 12h8M8 16h5"/>',trainer:'<circle cx="9" cy="7" r="4"/><path d="M2 21v-3c0-7 14-7 14 0v3M17 7l2 2 3-3"/>',faq:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.1"/>',inquiries:'<path d="M3 4h18v13H8l-5 4zM7 8h10M7 12h7"/>',account:'<circle cx="12" cy="7" r="4"/><path d="M4 21v-3c0-7 16-7 16 0v3"/>',bell:'<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4"/>',menu:'<path d="M4 6h16M4 12h16M4 18h16"/>'};
const wsIcon=id=>`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WS_ICONS[id]||WS_ICONS.list}</svg>`;
function initWorkspace(){state.ui??={};state.ui.collapsed??=false;state.ui.groups??={};state.ui.sections??={};state.ui.readNotifications??={A:[],B:[]};state.ui.readNotifications.A??=[];state.ui.readNotifications.B??=[];}
initWorkspace();
let workspaceSearch='',workspaceStatus='all',workspaceMenuOpen=false;

// The mobile drawer is temporary UI state; desktop collapse preferences stay intact.
let educationMobileNavOpen=false;
const educationMobileQuery=typeof matchMedia==='function'?matchMedia('(max-width:720px)'):null;
function educationMobile(){return Boolean(educationMobileQuery?.matches);}
function syncEducationMobileChrome(){
 const mobile=educationMobile(),rail=document.getElementById('educationNav'),main=document.querySelector?.('.main'),actions=document.querySelector?.('.header-actions'),account=document.getElementById('mobileAccountActions'),profile=document.getElementById('profileButton');
 const open=mobile&&educationMobileNavOpen;
 document.body.classList.toggle('mobile-nav-open',open);
 document.getElementById('toggleNav').setAttribute('aria-expanded',String(mobile?open:!state.ui.collapsed));
 document.getElementById('toggleNav').setAttribute('aria-label',mobile?(open?'메뉴 닫기':'메뉴 열기'):'왼쪽 메뉴 펼치기·접기');
 if(rail){rail.inert=mobile&&!open;if(mobile&&!open)rail.setAttribute('aria-hidden','true');else rail.removeAttribute('aria-hidden');}
 if(main)main.inert=open;
 if(profile)profile.setAttribute('aria-label','내 계정');
 if(actions&&account){
  for(const id of ['inviteParticipants','educationProjectHome','educationLogout']){
   const el=document.getElementById(id);if(!el)continue;
   if(mobile){if(el.parentElement!==account)account.append(el);}
   else if(el.parentElement!==actions){if(id==='inviteParticipants')document.getElementById('notificationToggle').before(el);else if(id==='educationProjectHome')profile.before(el);else profile.after(el);}
  }
 }
 const header=document.querySelector?.('.workspace-header');
 if(mobile&&header)document.body.style?.setProperty('--mobile-header-height',header.getBoundingClientRect().height+'px');
}
function closeEducationMobileNav(focus=false){educationMobileNavOpen=false;syncEducationMobileChrome();if(focus)document.getElementById('toggleNav').focus();}
document.getElementById('mobileNavClose').onclick=()=>closeEducationMobileNav(true);
document.getElementById('mobileNavBackdrop').onclick=()=>closeEducationMobileNav(true);
educationMobileQuery?.addEventListener('change',()=>{educationMobileNavOpen=false;updateWorkspaceChrome();});
if(typeof ResizeObserver==='function'){new ResizeObserver(()=>syncEducationMobileChrome()).observe(document.querySelector('.workspace-header'));}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&educationMobileNavOpen){closeEducationMobileNav(true);}});
document.getElementById('mobileAccountActions').addEventListener('click',()=>closeEducationMobileNav());
document.getElementById('profileButton').addEventListener('click',()=>closeEducationMobileNav());
document.getElementById('nav').addEventListener('click',e=>{if(e.target.closest?.('[data-nav],a'))closeEducationMobileNav();});

const WS_TABS=[['home','개요'],['curriculum','교육 목록'],['board','교육 보드'],['schedule','교육 일정 · 간트차트'],['certification','포지션 테스트']];
function workspaceTabs(){if(!['home','curriculum','board','schedule'].includes(view))return '';return `<div class="workspace-tabs" aria-label="교육 보기">${WS_TABS.filter(([id])=>id!=='certification').map(([id,name])=>`<button data-view="${id}" class="${view===id?'selected':''}" ${view===id?'aria-current="page"':''}>${id==='home'?'교육 과정':name}</button>`).join('')}</div>`;}
function workspaceSection(key,title,sub,body,defaultOpen=true){const open=state.ui.sections[key]??defaultOpen;return `<details class="workspace-section" data-section="${key}" ${open?'open':''}><summary><div><strong>${title}</strong><small>${sub}</small></div><span class="section-toggle" aria-hidden="true">⌄</span></summary><div class="section-body">${body}</div></details>`;}
function visibleLessons(){const q=workspaceSearch.toLocaleLowerCase();return allSteps().filter(s=>(workspaceStatus==='all'||record(s.id).status===workspaceStatus)&&(!q||[s.title,unitOf(s.id).title,...s.copy].join(' ').toLocaleLowerCase().includes(q)));}
function workspaceFilters(){return `<div class="workspace-toolbar"><label class="searchbox"><span aria-hidden="true">⌕</span><input id="lessonSearch" type="search" value="${esc(workspaceSearch)}" placeholder="교육 내용·단계 검색" aria-label="교육 내용·단계 검색"><button data-search-lessons>검색</button></label><label>상태 <select id="lessonStatus"><option value="all">전체</option>${Object.entries(statusNames).map(([id,name])=>`<option value="${id}" ${workspaceStatus===id?'selected':''}>${name}</option>`).join('')}</select></label><span class="muted">${visibleLessons().length}개 단계</span><button data-clear-filters>필터 초기화</button></div>`;}
function curriculum(){const groupHeadings=new Set();const list=visibleLessons(),ids=new Set(list.map(s=>s.id));return page('교육 목록','단원을 펼쳐 교육 항목을 찾고, 상세 패널에서 예정일과 내용을 확인합니다.',workspaceFilters()+`<div class="workspace-toolbar"><button data-expand-all="true">전체 펼치기</button><button data-expand-all="false">전체 접기</button><span class="muted">교육생별 일정 · 교육 확인과 시험 결과는 별도</span></div><div class="card workspace-table"><div class="scroll"><table><thead><tr><th style="min-width:300px">교육 단원 / 항목</th><th>상태</th><th>예정 시작~끝</th><th>직원 체크</th><th>교육자 확인</th></tr></thead><tbody>${course.filter(u=>u.steps.some(s=>ids.has(s.id))).map(u=>{const p=unitPlan(u),open=state.ui.groups[u.id]??false;const g=unitJourney(u),groupHeader=groupHeadings.has(g.id)?'':`<tr class="curriculum-track-heading"><td colspan="5"><span class="pill ${g.test?'violet':'blue'}">${g.test?'제조 기술 · 평가':'현장 적응 · 운영'}</span><strong>${g.order}. ${esc(g.title)}</strong><small>${esc(g.purpose)}</small></td></tr>`;groupHeadings.add(g.id);return `${groupHeader}<tr class="group-row"><td><button data-group="${u.id}" aria-expanded="${open}"><span aria-hidden="true">${open?'⌄':'›'}</span> ${esc(u.title)}</button><small>${esc(u.summary)}</small></td><td>${unitProgress(u)}/${u.steps.length}단계 확인</td><td>${planLabel(p.start)}~${planLabel(p.end)}</td><td colspan="2"><div class="bar" style="position:static;top:auto"><i style="width:${pct(unitProgress(u),u.steps.length)}%"></i></div></td></tr>${open?u.steps.filter(s=>ids.has(s.id)).map(s=>{const r=record(s.id),p=planOf(s.id);return `<tr class="lesson-row"><td><button class="text-button" data-peek="${s.id}">${esc(s.title)}</button></td><td>${pill(r)}</td><td>${planLabel(p.start)}~${planLabel(p.end)}</td><td>${r.self.filter(Boolean).length}/${r.self.length}</td><td>${r.teacher.filter(Boolean).length}/${r.teacher.length}<br>${dateLabel(r.done)}</td></tr>`;}).join(''):''}`;}).join('')||'<tr><td colspan="5">검색 조건에 맞는 교육이 없습니다.</td></tr>'}</tbody></table></div></div>`);}
function board(){const list=visibleLessons();return page('교육 보드','교육생의 미시작·교육 중·확인 대기·완료를 같은 기록으로 봅니다.',workspaceFilters()+`<div class="board-grid">${Object.entries(statusNames).map(([status,name])=>{const rows=list.filter(s=>record(s.id).status===status);return `<section class="board-column"><h2>${name} <span class="pill">${rows.length}</span></h2>${rows.map(s=>{const r=record(s.id),p=planOf(s.id);return `<button class="board-card" data-peek="${s.id}"><small>${esc(unitOf(s.id).title)}</small><strong>${esc(s.title)}</strong><span>${planLabel(p.start)}~${planLabel(p.end)}</span><div class="bar" style="position:static;top:auto"><i style="width:${pct(r.self.filter(Boolean).length,r.self.length)}%"></i></div><span>실습 ${r.self.filter(Boolean).length}/${r.self.length} · 교육자 ${r.teacher.filter(Boolean).length}/${r.teacher.length}</span>${r.request?`<span class="pill amber">확인 요청 ${dateLabel(r.request)}</span>`:''}</button>`;}).join('')||'<p class="muted">해당 단계가 없습니다.</p>'}</section>`;}).join('')}</div><p class="muted">단계 완료는 교육자가 실제 항목을 확인한 뒤 반영됩니다.</p>`);}
function coaching(s){const c=source.coaching?.[s.id];return c?`<div class="coaching"><span class="pill blue">교육 이해 돕기</span><h3>${esc(c.title)}</h3>${c.points.map(x=>`<p>${esc(x)}</p>`).join('')}<div class="practice-question"><strong>교육자와 이야기해 보기</strong><p>${esc(c.question)}</p></div><details><summary>설명 근거·확인 사항</summary><small>기존 Notion 확보본(2026.09.24) · ${esc(c.sourceTitle)}. 드라이브 정본을 우선해 설명을 보완했으며 별도 합격/운영 기준을 만들지 않았습니다.</small><br><button data-guide="${esc(s.ref||unitOf(s.id).ref)}">관련 드라이브 정본 내용 보기</button>${c.caution?`<p>${esc(c.caution)}</p>`:''}</details></div>`:'';}
function peekLesson(id){const s=findStep(id);if(!s)return;const r=record(id),p=planOf(id);document.getElementById('dialogTitle').textContent=s.title;document.getElementById('dialogLink').hidden=true;document.getElementById('dialogBody').innerHTML=`<p class="muted">${esc(unitOf(id).title)}</p><div class="actions">${pill(r)}<span class="pill">${r.attempt}차 실습</span></div><div class="result"><p>예정 ${planLabel(p.start)}~${planLabel(p.end)}<br>실제 시작 ${dateLabel(r.start)} · 확인 완료 ${dateLabel(r.done)}<br>직원 체크 ${r.self.filter(Boolean).length}/${r.self.length} · 교육자 ${r.teacher.filter(Boolean).length}/${r.teacher.length}</p></div><h2 style="margin-top:20px">배우고 연습할 내용</h2>${completionPanel(s)}${s.copy.map(x=>`<p>${esc(x)}</p>`).join('')}${lessonSource(s)}${coaching(s)}<div class="actions"><button class="primary" data-open-lesson="${id}">실습 화면으로 이동 →</button><button data-peek-guide="${s.ref}">관련 정본 조회</button></div><small>교육안 ${esc(curriculumData.version)} · 원고 검토본 0.3 · 기록의 판정 상태를 유지합니다.</small>`;const dialog=document.getElementById('dialog');if(!dialog.open)dialog.showModal();}
function notifications(){const items=[];for(const s of allSteps()){const r=record(s.id);if(r.status==='review')items.push({id:'review:'+s.id+':'+r.attempt,date:r.request,title:s.title+' · 교육자 확인 요청',detail:'항목별 교육 확인이 필요합니다.',step:s.id});if(r.feedback)items.push({id:'feedback:'+s.id+':'+r.attempt,date:state.events.filter(e=>e.person===state.person&&e.id===s.id&&e.attempt===r.attempt&&e.text.startsWith('새 시도')).at(-1)?.date||r.history.at(-1)?.archived||r.start,title:s.title+' · 교육 재확인 피드백',detail:r.feedback,step:s.id});}for(const t of TEST_DEFS){const p=planOf('test-'+t.id),days=dayNumber(p.start)-dayNumber(nowDay());if(!firstPass(t.id)&&days<=7)items.push({id:'test:'+t.id+':'+p.start,date:p.start,title:t.title+(days<0?' · 예정일 경과':' · '+days+'일 후'),detail:'교육 담당자와 준비·응시 일정을 확인하세요.',view:'certification'});for(const a of person().tests[t.id].attempts)items.push({id:'result:'+t.id+':'+a.attempt,date:a.date,title:t.title+' · '+a.attempt+'차 결과',detail:({pass:'통과 기록',retry:'보완·재시험',deferred:'평가 보류'}[a.result])+' · '+a.feedback,view:'certification'});}for(const t of state.support.tickets.filter(t=>t.person===state.person)){for(let i=0;i<(t.messages||[]).length;i++){const m=t.messages[i];if(m.actor!==NAMES[t.person])items.push({id:'ticket:'+t.id+':'+i,date:m.date,title:'문의 · 답변 답변 · '+t.title,detail:m.body||m.text||'답변을 확인하세요.',ticket:t.id,view:'inquiries'});}}return items.sort((a,b)=>(b.date||'').localeCompare(a.date||''));}
function notificationPanel(){const read=new Set(state.ui.readNotifications[state.person]),items=notifications();return `<div class="notification-heading"><strong>내 알림</strong><button id="readAllNotifications">모두 읽음</button></div><small>교육 기록의 확인 요청·피드백·시험·문의 답변</small>${items.map(n=>`<button class="notification-item ${read.has(n.id)?'read':''}" data-notification="${esc(n.id)}"><strong>${esc(n.title)}</strong><span>${esc(n.detail)}</span><small>${dateLabel(n.date)} · ${read.has(n.id)?'읽음':'읽지 않음'}</small></button>`).join('')||'<div class="empty-notifications">새 알림이 없습니다.<p>교육 기록에 확인 요청이나 피드백이 생기면 여기에 표시됩니다.</p></div>'}`;}
function updateWorkspaceChrome(){initWorkspace();for(const [key,label] of [['lesson','교육 · 확인'],['board','교육 보드']]){const n=document.querySelector('[data-nav="'+key+'"] .nav-text');if(n)n.textContent=label;}document.body.classList.toggle('nav-collapsed',state.ui.collapsed);document.getElementById('toggleNav').setAttribute('aria-expanded',String(!state.ui.collapsed));document.getElementById('profileName').textContent=NAMES[state.person];document.getElementById('profileAvatar').textContent=state.person;document.getElementById('globalSearch').value=workspaceSearch;const unread=notifications().filter(n=>!state.ui.readNotifications[state.person].includes(n.id)).length;document.getElementById('notificationCount').textContent=unread;document.getElementById('notificationToggle').setAttribute('aria-expanded',String(workspaceMenuOpen));document.getElementById('notifications').hidden=!workspaceMenuOpen;if(workspaceMenuOpen)document.getElementById('notifications').innerHTML=notificationPanel();syncEducationMobileChrome();}
function searchLessons(value){workspaceSearch=value.trim();view='curriculum';render();}
function workspaceClick(e){const b=e.target.closest('button');if(!b)return;if(b.dataset.group){state.ui.groups[b.dataset.group]=!(state.ui.groups[b.dataset.group]??false);save();render();}else if(b.dataset.expandAll){for(const u of course)state.ui.groups[u.id]=b.dataset.expandAll==='true';save();render();}else if(b.dataset.peek){peekLesson(b.dataset.peek);}else if(b.dataset.unitPlanPreview){closeEducationDetail();view='trainer';render();loadSourcePlanPreview(b.dataset.unitPlanPreview);document.getElementById('plan-start-'+courseUnit(b.dataset.unitPlanPreview).steps[0].id)?.closest('details')?.setAttribute('open','');document.getElementById('plan-start-'+courseUnit(b.dataset.unitPlanPreview).steps[0].id)?.scrollIntoView?.({block:'center'});}else if(b.dataset.openLesson){closeEducationDetail();selected=b.dataset.openLesson;view='lesson';render();}else if(b.dataset.peekGuide){openGuide(b.dataset.peekGuide);}else if(b.hasAttribute('data-search-lessons')){searchLessons(document.getElementById('lessonSearch').value);}else if(b.hasAttribute('data-clear-filters')){workspaceSearch='';workspaceStatus='all';render();}}
document.getElementById('app').addEventListener('click',workspaceClick);
document.getElementById('dialogBody').addEventListener('click',workspaceClick);
document.getElementById('app').addEventListener('change',e=>{if(e.target.id==='lessonStatus'){workspaceStatus=e.target.value;render();}});
document.getElementById('app').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='lessonSearch'){e.preventDefault();searchLessons(e.target.value);}});
document.getElementById('app').addEventListener('toggle',e=>{const key=e.target.dataset?.section;if(key){state.ui.sections[key]=e.target.open;save();}},true);
document.getElementById('toggleNav').onclick=()=>{if(educationMobile()){educationMobileNavOpen=!educationMobileNavOpen;workspaceMenuOpen=false;}else{state.ui.collapsed=!state.ui.collapsed;save();}updateWorkspaceChrome();};
document.getElementById('globalSearch').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();searchLessons(e.target.value);}};
document.getElementById('profileButton').onclick=()=>{view='account';render();};
document.getElementById('notificationToggle').onclick=()=>{workspaceMenuOpen=!workspaceMenuOpen;updateWorkspaceChrome();};
document.getElementById('notifications').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='readAllNotifications'){state.ui.readNotifications[state.person]=notifications().map(n=>n.id);save();updateWorkspaceChrome();}else if(b.dataset.notification){const n=notifications().find(n=>n.id===b.dataset.notification);if(!n)return;state.ui.readNotifications[state.person].push(n.id);workspaceMenuOpen=false;if(n.step){render();openEducationDetail('lesson',n.step);return;}else if(n.view){view=n.view;if(n.ticket)ticketSelection=n.ticket;}save();render();}};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&workspaceMenuOpen){workspaceMenuOpen=false;updateWorkspaceChrome();document.getElementById('notificationToggle').focus();}});


document.addEventListener('click',e=>{if(workspaceMenuOpen&&e.target.closest&&!e.target.closest('.header-actions')){workspaceMenuOpen=false;updateWorkspaceChrome();}});
function render(){document.getElementById('person').value=state.person;document.getElementById('join').value=person().join;document.getElementById('today').value=state.today;document.getElementById('wikiLink').href=wiki('');document.getElementById('storageNote').textContent=storageOK?'체험 기록은 이 브라우저의 로컬 저장소에 보관합니다. A/B는 가상 교육생이며 다른 기기·교육자와 공유되지 않습니다.':'이 환경은 로컬 저장을 허용하지 않아 현재 화면에서만 체험 기록을 유지합니다. 새로고침하면 사라집니다.';document.querySelectorAll('[data-nav]').forEach(b=>b.classList.toggle('active',b.dataset.nav===view));document.getElementById('app').innerHTML=({home,curriculum,board,schedule,lesson,certification,exam,trainer,faq,inquiries,account,system:systemRequests,access:accessManagement}[view]||home)();document.querySelectorAll("[data-icon]").forEach(n=>n.innerHTML=wsIcon(n.dataset.icon));updateWorkspaceChrome();}
function openGuide(id){document.getElementById('dialogTitle').textContent=source.refs[id].title+' · 원고 검토본';document.getElementById('dialogLink').hidden=false;document.getElementById('dialogLink').href=wiki(id);document.getElementById('dialogBody').innerHTML=`<div class="notice">기준 조회용 읽기 사본입니다. 학습·수행 확인·진척은 바뀌지 않습니다. 사진은 교재에서 보거나 전체 업무 가이드에서 조회하세요.<br>출처: ${esc(source.refs[id].file)} · 원고 검토본 0.3 · 정본 대조 2026.10.01</div><div class="guide" data-canonical-ref="${esc(id)}">${guideMarkup(source.guides[id])}</div><button data-guide-contact="${id}">이 기준 내용 문의하기</button>`;if(!document.getElementById('dialog').open)document.getElementById('dialog').showModal();}
function openPhoto(id){const p=source.photos[id];document.getElementById('dialogTitle').textContent=p.caption;document.getElementById('dialogLink').hidden=true;document.getElementById('dialogBody').innerHTML=`<img src="${p.src}" alt="${esc(p.caption)}"><p>${esc(p.caption)} · 원고 사진 그대로</p>`;if(!document.getElementById('dialog').open)document.getElementById('dialog').showModal();}
document.getElementById('dialogBody').addEventListener('click',e=>{const b=e.target.closest('[data-guide-contact]');if(b){closeEducationDetail();beginInquiry(null,b.dataset.guideContact);}});
document.getElementById('closeDialog').onclick=()=>closeEducationDetail();
// Change geometry only, preserving content, scroll and training state.
let educationDetailView='side',educationDetailWidth=730,educationBackdropStart=false;
function educationDetailLayout(){
 const d=document.getElementById('dialog'),select=document.getElementById('detailView'),width=document.getElementById('detailWidth');
 d.dataset.detailView=educationDetailView;d.style.setProperty('--detail-width',educationDetailWidth+'px');
 select.value=educationDetailView;width.value=educationDetailWidth;
 document.getElementById('detailWidthControl').hidden=true;
}
function educationBackdrop(e){const d=document.getElementById('dialog');if(!d.open||e.target!==d)return false;const r=d.getBoundingClientRect();return e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom;}
document.getElementById('detailView').onchange=e=>{educationDetailView=e.target.value;educationDetailLayout();saveDetailPreference();};
document.getElementById('detailWidth').oninput=e=>{educationDetailWidth=Math.min(1200,Math.max(360,Number(e.target.value)||730));educationDetailLayout();};
document.getElementById('dialog').addEventListener('pointerdown',e=>{educationBackdropStart=e.button===0&&educationBackdrop(e);});
document.getElementById('dialog').addEventListener('pointercancel',()=>{educationBackdropStart=false;});
document.getElementById('dialog').addEventListener('click',e=>{const close=educationBackdropStart&&educationBackdrop(e);educationBackdropStart=false;if(close)closeEducationDetail();});
document.getElementById('dialog').addEventListener('close',()=>{educationBackdropStart=false;});
educationDetailLayout();

document.getElementById('nav').onclick=e=>{const b=e.target.closest('[data-nav]');if(b){view=b.dataset.nav;render();}};
document.getElementById('person').onchange=e=>{state.person=e.target.value;selected=allSteps().find(s=>record(s.id).status!=='done')?.id||allSteps()[0].id;save();render();};
document.getElementById('join').onchange=e=>{if(!validDate(e.target.value)||dayNumber(e.target.value)>dayNumber(state.today))return toast('입사일은 유효한 기준일 이전 날짜로 설정하세요.'),render();const earliest=[...Object.values(person().records).flatMap(r=>[r.start,...r.history.map(h=>h.start)]),...person().practiceLogs.map(l=>l.date),...Object.values(person().tests).flatMap(t=>t.attempts.map(a=>a.date))].filter(Boolean).sort()[0];if(earliest&&e.target.value>earliest)return toast('이미 기록된 교육 시작일보다 늦게 입사일을 바꿀 수 없습니다.'),render();mutate(()=>{const oldJoin=person().join;person().join=e.target.value;rebasePlans(oldJoin,person().join);});};
document.getElementById('today').onchange=e=>{const date=e.target.value,latest=Object.keys(state.learners).flatMap(key=>{const l=state.learners[key];return [l.join,...l.practiceLogs.map(x=>x.date),...Object.values(l.tests).flatMap(t=>t.attempts.map(a=>a.date)),...Object.values(l.records).flatMap(r=>[r.start,r.done,r.request,...r.selfAt,...r.teacherAt,...r.history.flatMap(h=>[h.start,h.done,h.archived])]),l.exam?.submitted,...l.examArchive.map(t=>t.submitted)];}).filter(Boolean).sort().at(-1);if(!validDate(date)||(latest&&date<latest)||state.events.some(x=>date<x.date))return toast('기록이 있는 날짜보다 기준일을 뒤로 돌릴 수 없습니다.'),render();mutate(()=>state.today=date);};
document.getElementById('nextDay').onclick=()=>mutate(()=>state.today=addDay(state.today,1));
document.getElementById('app').addEventListener('change',e=>{const t=e.target;if(t.id==='ganttMonth'){ganttMonth=Number(t.value);render();}else if(t.id==='testRole'){testRole=t.value;render();}else if(t.id==='inquiryType'){captureInquiry();render();}else if(t.id==='inquiryStep'){captureInquiry();delete inquiryDrafts[state.person].refOverride;}else if(t.id?.startsWith('inquiry')){captureInquiry();}else if(t.id==='supportRole'){supportRole=t.value;ticketSelection=null;render();}else if(t.dataset.check)mutate(()=>t.dataset.role==='teacher'?toggleTeacher(t.dataset.check,Number(t.dataset.index),t.checked):toggleSelf(t.dataset.check,Number(t.dataset.index),t.checked));else if(t.dataset.memo){record(t.dataset.memo).memo=t.value;save();}else if(t.dataset.answer)mutate(()=>setAnswer(t.dataset.answer,t.value));else if(t.dataset.match)mutate(()=>setMatch(t.dataset.match,Number(t.dataset.pair),t.value));else if(t.dataset.reason){setReason(t.dataset.reason,t.value);save();}});
document.getElementById('app').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.scale){ganttScale=b.dataset.scale;render();}else if(b.dataset.level){ganttLevel=b.dataset.level;render();}else if(b.dataset.saveTestPlan){mutate(()=>saveTestPlan(b.dataset.saveTestPlan,document.getElementById('test-plan-'+b.dataset.saveTestPlan).value));}else if(b.dataset.recordTest){const id=b.dataset.recordTest;mutate(()=>recordPositionTest(id,document.getElementById('test-date-'+id).value,document.getElementById('test-result-'+id).value,document.getElementById('test-criteria-'+id).value,document.getElementById('test-feedback-'+id).value,document.getElementById('test-confirm-'+id).checked));}else if(b.dataset.logPractice){mutate(()=>addPracticeLog(b.dataset.logPractice,document.getElementById('practice-date').value,document.getElementById('practice-condition').value,document.getElementById('practice-observation').value));}else if(b.dataset.contact){beginInquiry(b.dataset.contact);}else if(b.id==='createInquiry'){mutate(()=>createInquiry(captureInquiry()));}else if(b.dataset.ticketOpen){ticketSelection=b.dataset.ticketOpen;render();}else if(b.dataset.ticketReply){mutate(()=>replyTicket(b.dataset.ticketReply,document.getElementById('ticketReply').innerText));}else if(b.dataset.ticketAction){mutate(()=>changeTicket(b.dataset.ticket,b.dataset.ticketAction,document.getElementById('ticketReason').value));}else if(b.dataset.faqNominate){mutate(()=>nominateFAQ(b.dataset.faqNominate));}else if(b.id==='searchFAQ'){faqSearch=document.getElementById('faqSearch').value;render();}else if(b.id==='signupPreview'){accountStage='pending';render();}else if(b.dataset.step){selected=b.dataset.step;view='lesson';render();}else if(b.dataset.view){view=b.dataset.view;render();}else if(b.dataset.guide)openGuide(b.dataset.guide);else if(b.dataset.photo)openPhoto(b.dataset.photo);else if(b.dataset.request)mutate(()=>requestReview(b.dataset.request));else if(b.dataset.retry)mutate(()=>retry(b.dataset.retry,document.getElementById('retryReason').value));else if(b.dataset.complete)mutate(()=>complete(b.dataset.complete));else if(b.dataset.return){const input=document.getElementById('feedback-'+b.dataset.return);mutate(()=>retry(b.dataset.return,input.value));}else if(b.id==='startExam')mutate(assignExam);else if(b.id==='submitExam')mutate(submitExam);else if(b.id==='newExam')mutate(()=>{person().examArchive.push(JSON.parse(JSON.stringify(person().exam)));person().exam=null;assignExam();});else if(b.dataset.move)mutate(()=>moveAnswer(b.dataset.move,Number(b.dataset.index),Number(b.dataset.delta)));else if(b.dataset.grade)mutate(()=>gradeEssay(b.dataset.grade,document.getElementById('gradeResult').value,document.getElementById('gradeFeedback').value));else if(b.id==='savePlan')mutate(savePlan);});
// Authenticated education actions. Browser storage contains only UI preferences.
let cloud=null,busy=false,lastFailed=null,lastValidationError='',queue=Promise.resolve();
let educationEntryView=globalThis.location?new URL(globalThis.location.href).searchParams.get("view"):null;
const clone=x=>JSON.parse(JSON.stringify(x));
save=function(){try{localStorage.setItem('momos-onboarding-ui:'+cloud.user.id+':'+cloud.target,JSON.stringify(state.ui));}catch{}};
mutate=function(fn){return fn();};
async function api(method,value,target){
 const response=await fetch('/api/onboarding'+(target?'?target='+encodeURIComponent(target):''),{method,credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':ERPAuth.csrfToken||''},...(value?{body:JSON.stringify(value)}:{})});
 let data;try{data=await response.json();}catch{throw new Error('서버 응답을 확인하지 못했습니다. 마지막 정상 기록을 유지합니다.');}
 if(!response.ok){const e=new Error(data.error||data.message||'교육 저장에 실패했습니다.');e.status=response.status;throw e;}return data;
}
function applyCloud(c){
 const changing=!cloud||cloud.target!==c.target;cloud=c;state.person='A';state.today=c.today;state.learners.A=clone(c.learner);state.events=clone(c.learner.events);
 NAMES.A=esc(c.name);Object.assign(NAMES,Object.fromEntries(Object.entries(c.names).map(([id,n])=>[id,esc(n)])));
 state.support={tickets:clone(c.tickets).map(t=>({...t,person:t.person===c.target?'A':t.person})),faqCandidates:[]};
 testRole=c.permissions.assessor?'assessor':'learner';
 for(const t of TEST_DEFS)t.evaluator=esc(c.roster.find(r=>r.id===c.target)?.assessor||'평가자 미배정');
 for(const t of Object.values(person().tests))for(const a of t.attempts)a.assessor=esc(a.assessor);
 if(changing){state.ui={};try{state.ui=JSON.parse(localStorage.getItem('momos-onboarding-ui:'+c.user.id+':'+c.target)||'{}');}catch{}initWorkspace();ticketSelection=null;}
 if(educationEntryView){if(['account','access'].includes(educationEntryView)&&c.permissions.admin)view=educationEntryView;educationEntryView=null;}
 render();
}
function statusLine(message,failed=false){
 const el=document.getElementById('storageNote');el.hidden=false;el.replaceChildren();const span=document.createElement('span');span.textContent=message;el.append(span);
 if(failed){const retry=document.createElement('button');retry.textContent='같은 요청 다시 저장';retry.onclick=()=>retryFailed();const refresh=document.createElement('button');refresh.textContent='서버 기록 새로 불러오기';refresh.onclick=()=>refreshCloud();el.append(' ',retry,' ',refresh);}
}
function act(action,data={}){
 if(lastFailed){toast('저장하지 못한 요청이 있습니다. 재시도하거나 서버 기록을 다시 불러오세요.');return Promise.resolve(false);}
 const requestedTarget=cloud.target,copy=clone(data);
 queue=queue.then(async()=>{
  if(lastFailed)return false;
  if(cloud.target!==requestedTarget){toast('선택 교육생이 바뀌어 요청을 취소했습니다.');return false;}
  const payload={action,target:requestedTarget,revision:person().revision,rootRevision:cloud.rootRevision,requestId:crypto.randomUUID(),data:copy};
  return transmit(payload);
 });return queue;
}
async function transmit(payload){
 busy=true;lastValidationError='';statusLine('서버에 저장 중…');lockControls();
 try{const c=await api('POST',payload);lastFailed=null;if(payload.action==='notification.read'){cloud.notifications=c.notifications;updateWorkspaceChrome();}else applyCloud(c);statusLine('서버 저장 완료 · '+new Intl.DateTimeFormat('ko-KR',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date()));return true;}
 catch(e){lastValidationError=e.status===400?e.message:'';lastFailed=e.status===400?null:payload;statusLine((e.status===409?'다른 기기에서 기록이 변경되었습니다. 새로 불러온 뒤 내용을 확인하세요. ':e.status===401?'로그인이 만료되었습니다. 다시 로그인 후 확인하세요. ':'저장 실패. ')+e.message,e.status!==400);toast(e.status===400?'입력 내용을 수정한 뒤 다시 저장하세요. '+e.message:'아직 서버 저장이 완료되지 않았습니다.');return false;}
 finally{busy=false;lockControls();if(payload.action==='notification.read')updateWorkspaceChrome();}
}
async function retryFailed(){if(lastFailed&&!busy)await transmit(lastFailed);}
async function refreshCloud(target=cloud?.target){
 if(busy)return;
 try{const c=await api('GET',null,target);lastFailed=null;lastValidationError='';applyCloud(c);return true;}catch(e){statusLine('불러오기 실패 · '+e.message);toast(e.message);return false;}
}
start=id=>act('step.start',{step:id}).then(ok=>{if(ok)toast((trainingStart()>nowDay()?'예정 시작일 '+dateLabel(trainingStart())+'은 유지하고 실제 시작일 '+dateLabel(nowDay())+'로 교육을 시작했어요.':'교육을 시작했어요.')+' 정본과 체크 항목에 따라 배운 내용·수행 항목을 확인한 뒤 교육자에게 확인을 요청하세요.');return ok;});
toggleSelf=(id,index,on)=>act('step.self',{step:id,index,on});
requestReview=id=>act('step.request',{step:id}).then(ok=>{if(ok)toast('교육자에게 확인을 요청했어요. 확인 대기에서 진행 상황을 볼 수 있어요.');return ok;});
toggleTeacher=(id,index,on)=>act('step.teacher',{step:id,index,on});
complete=async id=>{if(await act('step.complete',{step:id})){const next=unitOf(id).steps.find(s=>record(s.id).status!=='done')||findStep(cloud.assignments?.next);toast('교육자 확인 완료 · '+(next?'다음 과제: '+next.title:'남은 포지션 평가를 확인하세요.'));}};
retry=(id,reason)=>act('step.retry',{step:id,reason});
savePlan=()=>act('plan.save',{plans:Object.fromEntries(allSteps().map(s=>[s.id,{start:document.getElementById('plan-start-'+s.id).value,end:document.getElementById('plan-end-'+s.id).value}]))});
saveTestPlan=(test,date)=>act('plan.test',{test,date});
recordPositionTest=(test,date,result,criteria,feedback,confirmed)=>act('test.record',{test,date,result,criteria,feedback,confirmed});
addPracticeLog=(step,date,condition,observation)=>act('practice.add',{step,date,condition,observation});
assignExam=()=>act('quiz.assign');
submitExam=()=>act('quiz.submit',{answers:person().exam.answers});
gradeEssay=(question,result,feedback)=>act('quiz.grade',{question,result,feedback});
const oldAnswer=setAnswer,oldMatch=setMatch,oldReason=setReason,oldMove=moveAnswer;
setAnswer=(id,value)=>{oldAnswer(id,value);return act('quiz.answers',{answers:person().exam.answers});};
setMatch=(id,index,value)=>{oldMatch(id,index,value);return act('quiz.answers',{answers:person().exam.answers});};
setReason=(id,value)=>{oldReason(id,value);return act('quiz.answers',{answers:person().exam.answers});};
moveAnswer=(id,index,delta)=>{oldMove(id,index,delta);return act('quiz.answers',{answers:person().exam.answers});};
createInquiry=async d=>{
 if(uploadingAttachment){toast('파일 업로드가 끝난 뒤 접수하세요.');return;}
 const ok=await act('ticket.create',{type:d.inquiryType||'',category:d.inquiryType==='technical'?'기타 기술 문의':'기타 내용 문의',title:d.inquiryTitle||'',body:d.inquiryBody||'',bodyHtml:d.inquiryBodyHtml||'',expected:d.inquiryExpected||'',expectedHtml:d.inquiryExpectedHtml||'',proposal:d.inquiryType==='content'?(d.inquiryChange||''):'',step:d.inquiryStep||'',ref:d.refOverride||'',visibility:d.inquiryVisibility||'shared',attachments:d.attachments||[]});
 if(ok){inquiryDrafts.A={};ticketSelection=state.support.tickets.at(-1)?.id;inquiryList=d.inquiryVisibility==='private'?'mine':'shared';render();document.getElementById('inquiry-detail')?.scrollIntoView?.({block:'start'});}
};
replyTicket=async ticket=>{captureReply();const d=replyDrafts[ticket]||{};if(uploadingAttachment){toast('파일 업로드가 끝난 뒤 저장하세요.');return;}if(await act('ticket.reply',{ticket,text:d.text||'',html:d.html||'',attachments:d.attachments||[]})){delete replyDrafts[ticket];render();}};
changeTicket=(ticket,operation,reason)=>act('ticket.status',{ticket,operation,reason});
visibleTickets=()=>state.support.tickets.filter(t=>(inquiryList==='shared'?t.visibility==='shared':inquiryList==='mine'?t.person===(cloud.target===cloud.user.id?'A':cloud.user.id):Boolean(cloud.permissions[t.type]))&&(!inquirySearch||[t.title,t.body,t.expected,...t.messages.map(m=>m.text)].join(' ').toLocaleLowerCase().includes(inquirySearch.toLocaleLowerCase())));
canHandle=t=>Boolean(cloud.permissions[t.type]);
nominateFAQ=()=>toast('개인 문의의 FAQ 공개 전환은 담당자가 별도로 검토합니다.');
function lockControls(){
 if(!cloud)return;const p=cloud.permissions,blocked=busy||uploadingAttachment||Boolean(lastFailed),trainingBlocked=!trainingStart();
 const lock=(selector,denied)=>document.querySelectorAll(selector).forEach(n=>{if(n.dataset.intrinsicDisabled===undefined)n.dataset.intrinsicDisabled=String(n.disabled);n.disabled=n.dataset.intrinsicDisabled==='true'||blocked||denied;});
 document.querySelectorAll('[data-check]').forEach(n=>{n.disabled=blocked||trainingBlocked||!(n.dataset.role==='teacher'?p.trainer:p.own)|| (n.dataset.role==='teacher'?record(n.dataset.check).status!=='review':['done','review'].includes(record(n.dataset.check).status));});
 document.querySelectorAll('[data-memo]').forEach(n=>n.disabled=blocked||trainingBlocked||!p.own||['done','review'].includes(record(n.dataset.memo).status));
 lock('[data-start-practice]',!p.own||!trainingStart());
 lock('[data-request],[data-retry],[data-log-practice],[data-answer],[data-match],[data-reason],[data-move],#startExam,#submitExam,#newExam',!p.own||trainingBlocked);
 lock('[data-complete],[data-return],[data-grade],#savePlan,[data-save-test-plan]',!p.trainer||!trainingStart());
 lock('[data-record-test]',!p.assessor||trainingBlocked);
 document.querySelectorAll('[data-delay-reason]').forEach(n=>{n.disabled=blocked||trainingBlocked||!(p.own||(n.dataset.delayReason.startsWith('test-')?p.assessor:p.trainer));});
 lock('#createInquiry,[data-ticket-reply],[data-ticket-action],#saveEnrol,#saveSupport,[data-inquiry-upload],input[data-file-upload],[data-save-access],[data-save-system]',uploadingAttachment);
 document.getElementById('person').disabled=blocked;
}
const oldRender=render;
const originalChrome=updateWorkspaceChrome;
updateWorkspaceChrome=function(){originalChrome();if(cloud){document.getElementById('profileName').textContent=educationIdentity()+' · '+cloud.user.name;document.getElementById('profileAvatar').textContent=cloud.user.name.slice(0,1);}};
render=function(){
 oldRender();if(!cloud)return;
 const p=cloud.permissions,sel=document.getElementById('person');sel.innerHTML=cloud.roster.map(r=>`<option value="${esc(r.id)}" ${r.id===cloud.target?'selected':''}>${esc(r.name)}${r.join?' · 교육 배정':' · 교육 미배정'}</option>`).join('');
 document.getElementById('join').disabled=true;document.getElementById('today').disabled=true;document.getElementById('nextDay').hidden=true;
 document.getElementById('profileName').textContent=educationIdentity()+' · '+cloud.user.name;document.getElementById('profileAvatar').textContent=cloud.user.name.slice(0,1);
 document.getElementById('wikiLink').href='/onboarding/wiki';
 document.getElementById('storageNote').textContent=cloud.enrolled?'직원별 서버 저장 · 교육 기록 대상 '+cloud.name+' · 기록 판본 '+person().revision+' · 확인자는 배정 계정으로 기록됩니다.':'교육 과정 미배정 · 관리자가 계정·입사일·교육자·평가자를 배정하면 실제 기록을 시작합니다.';
 if(lastFailed)statusLine('저장하지 못한 요청이 있습니다. 재시도하거나 서버 기록을 다시 불러오세요.',true);
 const tr=document.getElementById('testRole');if(tr)tr.closest('.card').hidden=true;
 const sr=document.getElementById('supportRole');if(sr){sr.innerHTML='<option value="employee">내 문의</option>'+(p.technical?'<option value="cheers">담당 기술 문의</option>':'')+(p.content?'<option value="store">담당 내용 문의</option>':'');sr.value=supportRole;if(!sr.value){supportRole='employee';sr.value='employee';}}
 document.querySelectorAll('[data-faq-nominate]').forEach(n=>n.hidden=true);
 if(view==='trainer'&&!p.trainer){document.getElementById('app').innerHTML=page('교육 담당자','배정된 교육자 계정으로 교육생을 선택해 주세요.','<div class="card">교육 확인·예정일 변경·서술 답안 검토는 배정 교육자만 수행합니다.</div>');}
 lockControls();
};
let enrollmentFeedback=null;
function clearEnrollmentFeedback(){enrollmentFeedback=null;document.getElementById('enrolResult')?.remove();}
document.getElementById('app').addEventListener('input',e=>{if(['enrolLearner','enrolJoin','enrolStart','enrolTrainer','enrolAssessor'].includes(e.target.id))clearEnrollmentFeedback();});
document.getElementById('app').addEventListener('change',e=>{if(['enrolLearner','enrolJoin','enrolStart','enrolTrainer','enrolAssessor'].includes(e.target.id))clearEnrollmentFeedback();});
function enrollmentResult(){
 const saved=enrollmentFeedback;if(!saved||saved.learner!==cloud.target)return '';
 const next=findStep(educationAssignments().next)||allSteps()[0];
 return '<section class="notice enrol-success" id="enrolResult" tabindex="-1" role="status"><h3>'+esc(saved.name)+'님의 교육 배정을 저장했어요.</h3><p>'+(saved.startDate?'교육 시작일 '+dateLabel(saved.startDate)+'을 기준으로 예정 일정이 만들어졌습니다.':'담당자 배정은 끝났습니다. 교육 시작일을 지정하면 날짜별 일정과 교육 시작을 사용할 수 있어요.')+'</p><p>교육 진행은 교육생 본인이 교재에서 <strong>교육 시작</strong>을 눌러 시작합니다. 이번 저장으로 수행·완료 기록이 생기지는 않습니다.</p><div class="actions"><button class="primary" data-open-lesson="'+next.id+'">'+(saved.startDate?'교육 내용 보기':'교재 먼저 살펴보기')+'</button><button data-view="schedule">교육 일정 보기</button></div><small>이 화면에서 담당자나 시작일을 계속 수정할 수 있어요.</small></section>';
}
account=function(){
 const c=cloud.configuration,choices=(selected='',internal=false)=>'<option value="">선택하세요</option>'+c.users.filter(u=>!internal||u.company==='momos').map(u=>'<option value="'+esc(u.id)+'" '+(u.id===selected?'selected':'')+'>'+esc(u.name)+' · '+(u.company==='momos'?'모모스':'외부 협력')+'</option>').join('');
 const current=c?.learners[cloud.target],start=current?(current.startDate===undefined?current.join:current.startDate):'';
 let body=(cloud.permissions.admin?'<div class="card"><h2>교육을 시작하기 전, 배정을 준비해요.</h2><p>초대는 계정을 만드는 단계입니다. 교육 배정은 누가 배우고 누가 확인할지 정하는 단계예요.</p><ol class="enrol-help"><li><strong>교육생·담당자 선택</strong><span>교육생, 교육 확인 교육자, 포지션 평가자를 지정해요.</span></li><li><strong>교육 시작일 지정</strong><span>입사일과 별도로 정해요. 이 날짜로 예정 일정이 계산됩니다.</span></li><li><strong>배정 저장</strong><span>설정을 저장한 뒤 교육생이 교재에서 교육을 시작해요.</span></li></ol>'+educationEntryActions()+'</div>':'')+'<div class="card account-profile"><div><strong>'+esc(cloud.user.name)+'</strong><p class="muted">계정 권한과 교육 역할을 구분합니다. 교육 일정은 교육 시작일을 기준으로 계산합니다.</p></div><div class="actions"><button data-auth-onboarding>계정 · 로그아웃</button><a href="/?room=home" target="_blank" rel="noopener">프로젝트 워크스페이스 ↗</a><button data-refresh-cloud>서버 기록 새로 불러오기</button></div></div>';
 if(c){
 body+='<section class="card enrol-card"><div class="section-heading"><h2>교육 배정 설정</h2><span class="pill blue">입사일과 교육 시작일을 따로 관리</span></div><p class="muted">교육 시작일로 교육·시험 예정일을 계산합니다. 실제 수행일과 완료일은 체크·평가 기록에서 별도로 남깁니다.</p><div class="enrol-fields"><label>교육생<select id="enrolLearner">'+choices(cloud.target,true)+'</select></label><label>실제 입사일<input type="date" id="enrolJoin" max="'+cloud.today+'" value="'+esc(current?.join||'')+'"></label><label>교육 시작일<input type="date" id="enrolStart" value="'+esc(start||'')+'"><small>미정이면 비워두기</small></label><label>교육 확인 교육자<select id="enrolTrainer">'+choices(current?.trainer)+'</select></label><label>포지션 평가자<select id="enrolAssessor">'+choices(current?.assessor)+'</select></label></div><div class="enrol-actions"><small>교육생·담당자와 시작일을 저장해요. 교육 진행은 교육생이 별도로 시작합니다.</small><button id="saveEnrol" class="primary">교육 배정 저장</button></div>'+enrollmentResult()+'<h3>시작일 기준 WBS 미리보기</h3><div id="enrolPreview">'+templateTimeline(start||'')+'</div></section>';
 body+='<section class="card"><h2>배정 현황</h2><div class="scroll"><table><thead><tr><th>교육생</th><th>입사일</th><th>교육 시작일</th><th>교육자 / 평가자</th></tr></thead><tbody>'+Object.entries(c.learners).map(([id,r])=>'<tr><td>'+esc(c.users.find(u=>u.id===id)?.name||'이용 중지 계정')+'</td><td>'+dateLabel(r.join)+'</td><td>'+dateLabel(r.startDate===undefined?r.join:r.startDate)+'</td><td>'+esc(c.users.find(u=>u.id===r.trainer)?.name||'확인 필요')+' / '+esc(c.users.find(u=>u.id===r.assessor)?.name||'확인 필요')+'</td></tr>').join('')+'</tbody></table></div>'+(Object.keys(c.learners).length?'':'<p>아직 교육 배정이 없습니다. 과정과 WBS는 먼저 살펴볼 수 있습니다.</p>')+'</section>';
 body+='<details class="card support-assignment"><summary><strong>문의 종류별 담당 배정</strong></summary><p>기술 담당은 기술 문의만, 매장 내용 담당은 내용 문의만 열람·처리합니다. 교육자 배정으로 다른 직원 문의를 볼 수는 없습니다.</p><h3>기술 문의 · 치얼스</h3>'+c.users.map(u=>'<label class="choice"><input type="checkbox" data-support-technical value="'+esc(u.id)+'" '+(c.technical.includes(u.id)?'checked':'')+'>'+esc(u.name)+'</label>').join('')+'<h3>내용 문의 · 매장</h3>'+c.users.filter(u=>u.company==='momos').map(u=>'<label class="choice"><input type="checkbox" data-support-content value="'+esc(u.id)+'" '+(c.content.includes(u.id)?'checked':'')+'>'+esc(u.name)+'</label>').join('')+'<button id="saveSupport">문의 담당 저장</button></details>';
 }
 body+='<details class="card"><summary>전체 교육 항목 미리보기</summary>'+curriculumRows()+'</details>';
 return page('계정 · 교육 배정','배정 설정과 실제 교육 시작은 각각 진행합니다.',body);
};

document.getElementById('person').onchange=e=>refreshCloud(e.target.value);
document.getElementById('join').onchange=null;document.getElementById('today').onchange=null;document.getElementById('nextDay').onclick=null;
document.getElementById('app').addEventListener('change',e=>{if(e.target.dataset.memo){e.stopImmediatePropagation();act('step.memo',{step:e.target.dataset.memo,memo:e.target.value});}},true);
document.getElementById('app').addEventListener('change',e=>{if(e.target.id==='enrolLearner'){const r=cloud.configuration.learners[e.target.value];document.getElementById('enrolJoin').value=r?.join||'';document.getElementById('enrolStart').value=r?(r.startDate===undefined?r.join:r.startDate)||'':'';document.getElementById('enrolTrainer').value=r?.trainer||'';document.getElementById('enrolAssessor').value=r?.assessor||'';enrolPreview();}else if(e.target.id==='enrolStart')enrolPreview();});
document.getElementById('app').addEventListener('input',e=>{if(e.target.id==='enrolStart')enrolPreview();});
async function saveEnrollment(){
 const learner=document.getElementById('enrolLearner').value,join=document.getElementById('enrolJoin').value,startDate=document.getElementById('enrolStart').value,trainer=document.getElementById('enrolTrainer').value,assessor=document.getElementById('enrolAssessor').value;
 if(!learner||!validTrainingDate(join)||!trainer||!assessor){toast('교육생·실제 입사일·교육자·평가자를 선택하세요.');return;}
 if(startDate&&(!validTrainingDate(startDate)||startDate<join)){toast('교육 시작일은 입사일 이후 날짜로 입력하세요.');return;}
 if(await act('config.enrol',{learner,join,startDate:startDate||null,trainer,assessor})){
  enrollmentFeedback={learner,startDate,name:cloud.configuration.users.find(u=>u.id===learner)?.name||'교육생'};
  view='account';
  if(cloud.target!==learner&&!await refreshCloud(learner)){toast('교육 배정은 저장됐지만 결과를 다시 불러오지 못했어요. 서버 기록 새로 불러오기를 눌러 확인하세요.');return;}
  render();document.getElementById('enrolResult')?.focus({preventScroll:true});document.getElementById('enrolResult')?.scrollIntoView({block:'center',behavior:'smooth'});
  toast('교육 배정을 저장했어요. 교육 내용 또는 교육 일정을 직접 선택하세요.');
 }
}

document.getElementById('app').addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.id==='newExam'){e.stopImmediatePropagation();act('quiz.retry');}
 else if(b.id==='saveEnrol'){e.stopImmediatePropagation();saveEnrollment();}
 else if(b.id==='saveSupport'){e.stopImmediatePropagation();act('config.support',{technical:[...document.querySelectorAll('[data-support-technical]:checked')].map(n=>n.value),content:[...document.querySelectorAll('[data-support-content]:checked')].map(n=>n.value)});}
 else if(b.hasAttribute('data-manage-users')){e.stopImmediatePropagation();if(cloud.permissions.admin)ERPAuth.manageUsers();}
 else if(b.hasAttribute('data-start-practice')){e.stopImmediatePropagation();start(b.dataset.startPractice);}
 else if(b.hasAttribute('data-lesson-anchor')){e.stopImmediatePropagation();educationAnchor(b.dataset.lessonAnchor);}
 else if(b.hasAttribute('data-invite-participants')){e.stopImmediatePropagation();if(cloud.permissions.admin)ERPAuth.manageInvitations();}
  else if(b.hasAttribute('data-auth-onboarding')){e.stopImmediatePropagation();ERPAuth.openAccount();}
 else if(b.hasAttribute('data-refresh-cloud')){e.stopImmediatePropagation();refreshCloud();}
},true);
// Source status is separate from training records and formal assessment.
const materialById=id=>source.materials?.find(x=>x.id===id);
function sourceStamp(kind='canonical'){
 const info=source.sourceInfo?.[kind];if(!info)return '';
 return `<details class="source-stamp"><summary>자료 상태 · ${esc(info.status)} · 기준 확인 ${dateLabel(info.checkedAt)}</summary><p>정본 기준 확인일 ${dateLabel(info.checkedAt)} · 교육자료 반영일 ${dateLabel(info.reflectedAt)}</p><small>원문 확인과 교육자료 반영은 서로 다른 날짜입니다. 내용이 바뀌었거나 현장과 다르면 내용 문의로 알려주세요.</small></details>`;
}
function educationIdentity(){
 if(!cloud)return '계정 확인 중';const p=cloud.workspaceRoles||cloud.permissions,labels=[];
 if(p.admin)labels.push('관리자');if(p.trainer)labels.push('교육자');if(p.assessor)labels.push('평가자');if(p.learner||p.own)labels.push('교육생');
 if(!labels.length)labels.push(p.technical?'기술 문의 담당':p.content?'내용 문의 담당':({lead:'업무 책임자',viewer:'열람자',member:'직원'}[cloud.user.role]||'직원'));
 return labels.join(' · ');
}
function educationEntryActions(){return '<div class="actions">'+(cloud?.permissions.admin?'<button data-invite-participants>참여자 초대</button><button data-manage-users>가입 승인·권한 관리</button><button class="primary" data-view="account">교육 배정 설정</button>':'')+'<button data-view="schedule">교육 일정 · 간트차트</button></div>';}
function materialPanel(id='enspace-pos'){
 const doc=materialById(id);if(!doc)return '';
 return `<div class="card"><div class="actions"><span class="pill blue source-badge">${esc(doc.badge)} · 기존 확보 사본</span><button data-guide="U14">POS 드라이브 정본 내용 보기</button><span class="pill amber">${esc(doc.status)}</span></div><h2>${esc(doc.title)}</h2><p>원문 확인일 ${dateLabel(doc.checkedAt)} · 교육자료 반영일 ${dateLabel(doc.reflectedAt)}</p><p class="muted">${esc(doc.contentMode||'')} · ${esc(doc.scope.replace('이미지·영상·초기설치 PDF는 원문에서 조회.','').trim())} 화면과 기능은 설치 버전에 따라 다를 수 있습니다. 현행 적용 기준은 웍스 드라이브 정본·정본 기반 위키에서 확인하세요.</p>${doc.sections.map(s=>`<details class="material-section"><summary><strong>${esc(s.title)}</strong></summary><ul>${s.points.map(p=>`<li>${esc(p)}</li>`).join('')}</ul>${(s.instructions||[]).map(g=>`<div class="material-instructions"><h3>${esc(g.title)}</h3><ol>${g.steps.map(p=>`<li>${esc(p)}</li>`).join('')}</ol></div>`).join('')}<small>원문 수정일 ${dateLabel(s.originalEditedAt)} · 확보일 ${dateLabel(doc.checkedAt)}</small></details>`).join('')}<details class="material-section"><summary>아직 매장 확인이 필요한 내용</summary><ul>${doc.missing.map(p=>`<li>${esc(p)}</li>`).join('')}</ul></details><details class="material-section"><summary>교육자와 모의 상황 연습하기</summary><p>아래는 토의용 사례입니다. 미확정 절차를 정답으로 채점하거나 실제 결제·환불을 실행하지 않습니다.</p>${doc.scenarios.map(s=>`<h3>${esc(s.title)}</h3><p>${esc(s.prompt)}</p>`).join('')}</details><button data-view="inquiries">내용 변경·보완 문의하기</button></div>`;
}
let materialUpdates={items:[],next:'',loaded:false,busy:false,error:'',user:null,checked:0};
function materialUpdateTime(value){return new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));}
function materialUpdatesPanel(){
 const feed=materialUpdates,labels={added:'자료 추가',updated:'원고 파일 변경',replaced:'원고 교체',removed:'제공 항목 제외',review:'보완 자료 변경'};
 return '<section class="card" id="material-updates" aria-label="자료 업데이트"><div class="section-heading"><h2>자료 업데이트</h2><button data-material-updates="refresh" '+(feed.busy?'disabled':'')+'>새로 확인</button></div><p class="muted">정본을 바탕으로 만든 업무 가이드에 어떤 자료가 반영됐는지 확인합니다.</p><div role="status" aria-live="polite">'+(feed.busy?'<p>업데이트 기록을 불러오고 있습니다.</p>':'')+(feed.error?'<p class="notice warning">'+esc(feed.error)+' <button data-material-updates="retry">다시 불러오기</button></p>':'')+'</div>'+feed.items.map(note=>'<article style="border-top:1px solid var(--line);padding:18px 0;overflow-wrap:anywhere"><h3 style="margin:0">'+esc(materialUpdateTime(note.published_at))+' · '+(note.basis==='baseline'?'기록 시작 시점의 제공본':note.changes.length+'개 자료 반영')+'</h3><p class="muted">서버 반영 시각 · 한국시간 · 판본 '+esc(note.id.slice(0,8))+'</p>'+(note.basis==='baseline'?'<p>이전 판본과의 비교 기록이 없어 변경 내용을 확정하지 않습니다.</p>':'<ul style="padding-left:20px">'+note.changes.map(change=>'<li style="margin:14px 0"><span class="pill '+(change.kind==='added'?'green':'blue')+'">'+esc(labels[change.kind]||'자료 변경')+'</span> <strong>'+esc(change.units.map(u=>u.title).join(' · ')||change.file)+'</strong><p class="muted" style="margin:4px 0">'+esc(change.file)+'</p>'+(change.previous_file&&change.previous_file!==change.file?'<small>이전 원고: '+esc(change.previous_file)+'</small>':'')+'<div class="actions">'+(change.kind==='removed'?'':change.units.filter(u=>/^(U\d+|[a-z][a-z_-]{0,63})$/.test(u.id)).map(u=>'<a href="/onboarding/wiki#'+encodeURIComponent(u.id)+'" target="_blank" rel="noopener noreferrer">'+esc(u.title)+' · 현행 내용 보기 ↗</a>').join(''))+'</div></li>').join('')+'</ul>')+'</article>').join('')+(!feed.busy&&!feed.error&&feed.loaded&&!feed.items.length?'<p>새로 반영된 자료 변경 기록이 없습니다.</p>':'')+(feed.next?'<button data-material-updates="more" '+(feed.busy?'disabled':'')+'>이전 기록 더 보기</button>':'')+'<small>원고 파일의 해시·목록을 비교한 기록입니다. 세부 문장은 연결된 현행 내용에서 확인하세요. 작성자·업로더를 추정하지 않으며, 자료 반영과 원고 승인·현장 시행·교육 완료는 각각 확인합니다.</small></section>';
}
async function loadMaterialUpdates(more=false){
 if(materialUpdates.busy||!cloud)return;
 const user=cloud.user.id;
 if(materialUpdates.user!==user)materialUpdates={items:[],next:'',loaded:false,busy:false,error:'',user,checked:0};
 const feed=materialUpdates;feed.busy=true;feed.error='';paintMaterialUpdates();
 try{
  const response=await fetch('/api/onboarding/material-updates'+(more&&feed.next?'?cursor='+encodeURIComponent(feed.next):''),{credentials:'same-origin',cache:'no-store'});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'자료 업데이트 기록을 불러오지 못했습니다.');
  if(cloud?.user.id!==user)return;
  feed.items=more?[...feed.items,...data.items.filter(n=>!feed.items.some(old=>old.id===n.id))]:data.items;feed.next=data.next;feed.loaded=true;feed.checked=Date.now();
 }catch(e){if(cloud?.user.id===user)feed.error=e.message;}
 finally{feed.busy=false;paintMaterialUpdates();}
}
function paintMaterialUpdates(){const host=document.getElementById('material-updates');if(host&&view==='materials')host.outerHTML=materialUpdatesPanel();}
document.getElementById('app').addEventListener('click',e=>{const button=e.target.closest('[data-material-updates]');if(button&&!button.disabled)loadMaterialUpdates(button.dataset.materialUpdates==='more');});
function materials(){return page('자료 · 판본','웍스 드라이브 정본과 업무 가이드의 자료 업데이트를 확인합니다.',materialUpdatesPanel()+`<div class="card"><h2>드라이브 정본 기반 업무 가이드</h2>${sourceStamp()}<a href="/onboarding/wiki" target="_blank" rel="noopener noreferrer">현행 업무 가이드 조회 ↗</a><p>교육 자료의 외부 이동은 웍스 드라이브 정본과 정본을 토대로 만든 위키로만 연결합니다. 기존 교육 보충·제조사 자료 사본은 출처와 확보일을 남기고, 현행 기준은 정본에서 확인합니다.</p></div>`+materialPanel()+`<div class="card"><h2>자료가 바뀌었을 때</h2><p>웍스 드라이브 정본 수정 → 예약 갱신에서 검증 → 서버 반영 성공 → 위 자료 업데이트에 자동 기록.</p><p>내용 변경·보완이 필요하면 내용 문의로 원문과 달라진 부분을 알려주세요. 이미 진행한 교육·응시 기록은 보존하며 새 자료가 나왔다고 자동 취소하지 않습니다.</p><small>업무 가이드 갱신과 커리큘럼·퀴즈·교육 내용의 변경은 별도로 검토합니다. 시스템 기능 변경은 ‘패치 내역’에서 확인합니다.</small></div>`);}
const beforeSourceLesson=lesson;
lesson=function(){const body=beforeSourceLesson();return body+sourceStamp()+(selected==='orders-pos'?materialPanel():'');};
const beforeSourcePeek=peekLesson;
peekLesson=function(id){beforeSourcePeek(id);document.getElementById('dialogBody').innerHTML+=sourceStamp()+(id==='orders-pos'?materialPanel():'');};
const beforeSourceGuide=openGuide;
openGuide=function(id){beforeSourceGuide(id);document.getElementById('dialogBody').innerHTML=sourceStamp()+document.getElementById('dialogBody').innerHTML;};
const beforeCoaching=coaching;
coaching=function(s){const body=beforeCoaching(s);return body?body+sourceStamp('notion'):'';};
document.getElementById('inviteParticipants').onclick=()=>{if(cloud?.permissions.admin)ERPAuth.manageInvitations();};
const beforeAssignedHome=home;
home=function(){return beforeAssignedHome();};
const beforeStartSchedule=schedule;
schedule=function(){return !trainingStart()?page('교육 일정 · 간트차트','교육 시작일을 지정하면 날짜에 맞춘 예정 WBS가 만들어집니다.',templateTimeline()+'<div class="card">'+curriculumRows()+'</div>'):beforeStartSchedule();};
notifications=function(){return cloud?.notifications||[];};
notificationPanel=function(){const items=notifications(),unread=items.filter(n=>!n.read);return `<div class="notification-heading"><strong>내 알림 · ${unread.length}개 읽지 않음</strong><button id="readAllNotifications" ${!unread.length||busy?'disabled':''}>모두 읽음</button><button data-refresh-notifications>새로고침</button></div><small>담당 교육생 전체의 확인 요청 · 내 결과 · 담당 문의 · 자료 반영</small>${items.map(n=>`<button class="notification-item ${n.read?'read':''}" data-notification="${esc(n.id)}"><strong>${esc(n.title)}</strong><span>${esc(n.detail)}</span><small>${dateLabel(n.date)} · ${n.read?'읽음':'읽지 않음'}</small></button>`).join('')||'<div class="empty-notifications">새 알림이 없습니다.</div>'}`;};
const beforeNoticeChrome=updateWorkspaceChrome;
updateWorkspaceChrome=function(){beforeNoticeChrome();const items=notifications();document.getElementById('notificationCount').textContent=items.filter(n=>!n.read).length;document.getElementById('notificationToggle').setAttribute('aria-label','내 알림 · 읽지 않음 '+items.filter(n=>!n.read).length+'개');if(workspaceMenuOpen)document.getElementById('notifications').innerHTML=notificationPanel();};
async function refreshNotificationFeed(){if(!cloud||busy||lastFailed)return;try{const target=cloud.target,c=await api('GET',null,target);if(cloud.target!==target||busy||lastFailed)return;if(view==='home'||cloud.permissions.own&&educationDetail?.kind==='lesson'&&record(educationDetail.id)?.status==='review'&&c.learner.records[educationDetail.id]?.status==='done'&&!detailElement('retryReason')?.value||cloud.permissions.own&&view==='lesson'&&record(selected)?.status==='review'&&c.learner.records[selected]?.status==='done'&&!document.getElementById('retryReason')?.value)applyCloud(c);else{cloud.notifications=c.notifications;updateWorkspaceChrome();}}catch(e){toast('알림을 새로 확인하지 못했습니다. '+e.message);}}
document.getElementById('notificationToggle').onclick=async()=>{closeEducationMobileNav();workspaceMenuOpen=!workspaceMenuOpen;updateWorkspaceChrome();if(workspaceMenuOpen)await refreshNotificationFeed();};
document.getElementById('notifications').onclick=async e=>{
 const b=e.target.closest('button');if(!b||busy)return;
 if(b.id==='readAllNotifications'){await act('notification.read',{ids:notifications().filter(n=>!n.read).map(n=>n.id)});}
 else if(b.hasAttribute('data-refresh-notifications'))await refreshNotificationFeed();
 else if(b.dataset.notification){
  const n=notifications().find(x=>x.id===b.dataset.notification);if(!n)return;
  if(!n.read&&!await act('notification.read',{ids:[n.id]}))return;
  if(n.target&&n.target!==cloud.target)await refreshCloud(n.target);
  if(n.target&&n.target!==cloud.target)return;
  workspaceMenuOpen=false;
  if(n.step){render();openEducationDetail('lesson',n.step);return;}else{view=n.view||'home';if(n.ticket){ticketSelection=n.ticket;supportRole=n.kind==='technical'&&cloud.permissions.technical?'cheers':n.kind==='content'&&cloud.permissions.content?'store':'employee';}}
  render();
 }
};
const beforeOverviewRender=render;
render=function(){
 if(view==='materials'){view='home';beforeOverviewRender();view='materials';document.getElementById('app').innerHTML=materials();document.querySelectorAll('[data-nav]').forEach(b=>b.classList.toggle('active',b.dataset.nav==='materials'));if(!materialUpdates.busy&&(materialUpdates.user!==cloud?.user.id||!materialUpdates.loaded||Date.now()-materialUpdates.checked>120000))loadMaterialUpdates();}else beforeOverviewRender();
 if(!cloud)return;
 const s=stats(),current=allSteps().find(x=>record(x.id).status==='practice')||allSteps().find(x=>record(x.id).status!=='done'),assigned=cloud.enrolled,scheduled=Boolean(trainingStart());
 const enrolled=cloud.roster.find(r=>r.id===cloud.target);
 const completed=assigned&&s.done===s.total&&TEST_DEFS.every(t=>firstPass(t.id));
 const actualEnd=completed?[...allSteps().map(x=>record(x.id).done),...TEST_DEFS.map(t=>firstPass(t.id).date)].sort().at(-1):null;
 document.getElementById('inviteParticipants').hidden=!cloud.permissions.admin;
 document.getElementById('educationContextTitle').textContent=cloud.permissions.admin?'온천본점 교육 관리':cloud.permissions.own?'나의 교육 과정':'온천본점 교육 과정';
 document.getElementById('recordTargetLabel').textContent=cloud.permissions.own?'내 교육 기록':'교육 기록 대상';
 document.getElementById('educationOverview').hidden=view==='home';
 document.getElementById('storageNote').hidden=view==='home'&&!lastFailed;
 document.getElementById('educationOverview').innerHTML='<div><span>교육 시작일</span><strong>'+(scheduled?dateLabel(trainingStart()):'미설정')+'</strong><small>'+(assigned?'입사일 '+dateLabel(person().join):'과정 먼저 살펴보기')+'</small></div><div><span>교육 진척률</span><strong>'+pct(s.done,s.total)+'%</strong><small>교육자 확인 '+s.done+'/'+s.total+'단계 · 실제 수행 '+pct(s.self,s.checks)+'%</small></div><div><span>진행 상황</span><strong>'+(scheduled?(trainingStart()>nowDay()&&!allSteps().some(x=>record(x.id).start)?'교육 시작 예정':current?esc(current.title):'교육 확인 완료'):'교육 시작 준비')+'</strong><small>'+(assigned?'담당 멘토 '+esc(enrolled?.trainer||'미배정'):'15단원 · 82단계 커리큘럼')+'</small></div><div><span>'+(actualEnd?'교육 완료일':'교육 종료 목표일')+'</span><strong>'+(actualEnd?dateLabel(actualEnd):scheduled?dateLabel(goalDate()):'시작 후 6개월')+'</strong><small>'+(actualEnd?'교육 확인·포지션 통과 기록 기준':'ESP 통과 목표 · 실제 종료와 별도')+'</small></div>';
};
document.getElementById('dialogBody').addEventListener('click',e=>{const b=e.target.closest('[data-view="materials"]');if(b){closeEducationDetail();view='materials';render();}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshNotificationFeed();});
ERPAuth.ensureSession().then(()=>refreshCloud(new URLSearchParams(location.search).get('learner')||undefined)).catch(e=>statusLine(e.message));

document.getElementById('app').addEventListener('click',async e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.scheduleToggle){e.stopImmediatePropagation();const id=b.dataset.scheduleToggle;expandedScheduleUnits.has(id)?expandedScheduleUnits.delete(id):expandedScheduleUnits.add(id);render();}
 else if(b.dataset.scheduleExpand){e.stopImmediatePropagation();expandedScheduleUnits.clear();if(b.dataset.scheduleExpand==='all')course.forEach(u=>expandedScheduleUnits.add(u.id));render();}
 else if(b.dataset.loadSourcePlan!==undefined){e.stopImmediatePropagation();loadSourcePlanPreview();}
 else if(b.dataset.ganttMode){e.stopImmediatePropagation();ganttMode=b.dataset.ganttMode;render();}
 else if(b.dataset.ganttItem){e.stopImmediatePropagation();const id=b.dataset.ganttItem;if(findStep(id))peekLesson(id);else if(id.startsWith('test-')){openEducationDetail('test',id.slice(5));}else{expandedScheduleUnits.add(id);render();peekScheduleUnit(id);}}
 else if(b.dataset.delayReason){e.stopImmediatePropagation();const item=b.dataset.delayReason,reason=document.getElementById('delayReason-'+item).value.trim();if(!reason){toast('지연 사유를 입력하세요.');return;}await act('schedule.reason',{item,reason});}
},true);

// Navigation, personal viewing preferences and existing curriculum assignments.
function educationAssignments(){
 if(cloud?.assignments)return cloud.assignments;
 const available=[],waiting=[],upcoming=[],completed=[];
 for(const s of allSteps()){const r=record(s.id);if(r.status==='done')completed.push(s.id);else if(r.status==='review')waiting.push(s.id);else if(cloud?.enrolled&&trainingStart()&&(r.start||planOf(s.id).start<=nowDay()))available.push(s.id);else upcoming.push(s.id);}
 const next=available.find(id=>record(id).status==='practice')||available[0]||(cloud?.enrolled&&trainingStart()?upcoming[0]:null);
 return {available,waiting,upcoming,completed,next,nextAvailable:available.includes(next),total:allSteps().length};
}
function assignmentPanel(){
 const a=educationAssignments(),s=findStep(a.next);
 return '<section class="card assignment-panel"><span class="pill blue">커리큘럼 자동 과제</span><h2>'+(s?esc(s.title):!cloud?.enrolled?'교육 배정 전 · 전체 과정 미리보기':!trainingStart()?'교육 시작일 지정 대기':a.waiting.length?'교육자 확인 대기':a.completed.length===a.total?'교육 확인 완료 · 남은 포지션 평가 확인':'진행 가능한 과제를 확인하세요.')+'</h2><p>'+(s?esc(unitOf(s.id).title)+' · 예정 '+planLabel(planOf(s.id).start)+' ~ '+planLabel(planOf(s.id).end):'관리자가 교육생·시작일·멘토를 저장하면 기존 커리큘럼 전체가 배정됩니다.')+'</p><p>진행 가능한 과제 '+a.available.length+'개 · 교육자 확인 대기 '+a.waiting.length+'개 · 확인 완료 '+a.completed.length+'/'+a.total+'개</p><div class="actions">'+(s?'<button class="primary" '+(a.nextAvailable?'data-step':'data-peek')+'="'+s.id+'">'+(a.nextAvailable?'현재 교육 이어하기':'예정 과제 미리보기')+'</button>':'')+'<button data-view="curriculum">전체 커리큘럼</button>'+(a.waiting.length&&cloud?.permissions.trainer?'<button data-view="trainer">확인 대기 처리</button>':'')+'</div><small>시작일·개별 예정일에 맞춰 과제를 안내합니다. 병행 과제는 함께 진행할 수 있고, 교육자 확인 완료 후 다음 미완료 과제로 안내가 바뀝니다. 예정일만으로 수행·완료 기록을 만들지 않습니다.</small></section>';
}
function completionPanel(s){
 const r=record(s.id),stage=r.status==='done'?3:r.status==='review'?2:r.self.every(Boolean)?1:0,a=educationAssignments();
 const next=allSteps().find(x=>x.id!==s.id&&a.available.includes(x.id));
 return '<section class="card completion-flow"><h2>이 교육 항목을 완료하는 방법</h2><ol>'+['직원: 항목별 실제 학습·수행 확인','직원: 교육자 확인 요청','교육자: 모든 항목 확인','교육자: 확인 완료 → 다음 과제'].map((t,i)=>'<li class="'+(i===stage?'current':i<stage?'finished':'')+'">'+t+'</li>').join('')+'</ol><p>'+({ready:'교재를 읽고 교육 시작을 누르세요. 첫 체크로 시작해도 실제 시작일이 기록됩니다.',practice:r.self.every(Boolean)?'교육 항목을 모두 체크했습니다. 아래 교육자 확인 요청을 누르세요.':'정본과 체크 항목에 따라 배우거나 수행한 내용을 확인하고, 모두 확인하면 교육자 확인을 요청하세요.',review:'교육자에게 확인을 요청했습니다. 교육자가 항목을 확인하고 완료 처리하면 교육 진척률에 반영됩니다.',done:'교육자 확인이 완료되어 진척률에 반영되었습니다.'}[r.status])+'</p><div class="actions">'+(r.status==='review'&&cloud?.permissions.trainer?'<button data-lesson-anchor="lesson-teacher">이 교육 항목의 교육자 확인 보기</button>':'')+(r.status==='done'&&next?'<button data-step="'+next.id+'">다음 과제 · '+esc(next.title)+' →</button>':'')+'</div><small>학습·수행 확인·메모·퀴즈 제출만으로 확인 완료되지 않습니다. 포지션 테스트는 평가자가 별도로 결과를 기록합니다.</small></section>';
}
function detailPreferenceKey(){return cloud?'momos-onboarding-view:'+cloud.user.id:null;}
function saveDetailPreference(){const key=detailPreferenceKey();if(!key)return;try{localStorage.setItem(key,JSON.stringify({mode:educationDetailView,width:educationDetailWidth}));}catch{toast('이 브라우저에서 보기 설정을 저장하지 못했습니다.');}}
function loadDetailPreference(){const key=detailPreferenceKey();let p={};try{p=JSON.parse(localStorage.getItem(key)||'{}');}catch{}educationDetailView=['side','center','full'].includes(p.mode)?p.mode:'side';educationDetailWidth=Number.isFinite(p.width)?Math.min(1200,Math.max(360,p.width)):730;educationDetailLayout();}
function resizeDetail(value){educationDetailWidth=Math.round(Math.min(1200,Math.max(360,value)));educationDetailLayout();}
let detailDrag=null;
const resizeHandle=document.getElementById('educationResize');
if(resizeHandle){
 resizeHandle.onpointerdown=e=>{if(e.button!==0||educationDetailView!=='side')return;e.preventDefault();e.stopPropagation();educationBackdropStart=false;detailDrag={id:e.pointerId,x:e.clientX,width:document.getElementById('dialog').getBoundingClientRect().width};resizeHandle.setPointerCapture(e.pointerId);};
 resizeHandle.onpointermove=e=>{if(detailDrag?.id!==e.pointerId)return;resizeDetail(detailDrag.width+detailDrag.x-e.clientX);};
 const stop=e=>{if(detailDrag?.id!==e.pointerId)return;detailDrag=null;if(resizeHandle.hasPointerCapture(e.pointerId))resizeHandle.releasePointerCapture(e.pointerId);educationBackdropStart=false;saveDetailPreference();};
 resizeHandle.onpointerup=stop;resizeHandle.onpointercancel=stop;
 resizeHandle.onkeydown=e=>{if(educationDetailView!=='side'||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();resizeDetail(e.key==='Home'?360:e.key==='End'?1200:educationDetailWidth+(e.key==='ArrowLeft'?40:-40));saveDetailPreference();};
 document.getElementById('dialog').addEventListener('close',()=>{detailDrag=null;});
}
let navigationScope='',navigationPage='',navigationIndex=0,navigationRestoring=false,viewPreferenceUser='';
function navigationState(){return {scope:cloud.user.id+':'+cloud.target,view,selected,index:navigationIndex};}
function syncEducationNavigation(){
 if(!cloud)return;
 if(viewPreferenceUser!==cloud.user.id){viewPreferenceUser=cloud.user.id;loadDetailPreference();}
 const page=view+':'+(view==='lesson'?selected:''),scope=cloud.user.id+':'+cloud.target;
 if(!globalThis.history){navigationPage=page;return;}
 if(navigationScope!==scope){navigationScope=scope;navigationIndex=0;navigationPage=page;history.replaceState({...history.state,education:navigationState()},'');}
 else if(!navigationRestoring&&navigationPage!==page){navigationIndex++;navigationPage=page;history.pushState({...history.state,education:navigationState()},'');globalThis.scrollTo?.({top:0,behavior:'instant'});}
}
const beforeUsabilityRender=render;
function updateEducationHeaderHeight(){const h=document.querySelector?.('.workspace-header')?.getBoundingClientRect?.().height;if(h>0)document.documentElement?.style.setProperty('--header-height',Math.ceil(h)+'px');}
render=function(){beforeUsabilityRender();syncEducationNavigation();updateEducationHeaderHeight();};
globalThis.addEventListener?.('resize',updateEducationHeaderHeight);
globalThis.addEventListener?.('popstate',e=>{
 if(!cloud||busy||lastFailed)return;
 const v=e.state?.education;if(!v)return;
 navigationRestoring=true;closeEducationDetail();
 if(v.scope===navigationScope&&['home','curriculum','board','schedule','lesson','certification','exam','trainer','faq','inquiries','account','materials'].includes(v.view)){view=v.view;if(findStep(v.selected))selected=v.selected;navigationIndex=v.index;}else{view='home';navigationIndex=0;}
 navigationPage=view+':'+(view==='lesson'?selected:'');render();navigationRestoring=false;
});
document.getElementById('app').addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.hasAttribute('data-education-back')){e.stopImmediatePropagation();if(busy||lastFailed){toast('저장 상태를 먼저 확인하세요.');return;}if(navigationIndex>0&&globalThis.history)history.back();else{view='home';render();}}
 else if(b.hasAttribute('data-education-top')){e.stopImmediatePropagation();globalThis.scrollTo?.({top:0,behavior:'smooth'});}
},true);
const beforeProgressCloud=applyCloud;
applyCloud=function(c){
 const advance=cloud?.target===c.target&&cloud.permissions.own&&view==='lesson'&&record(selected)?.status!=='done'&&c.learner.records[selected]?.status==='done';
 if(advance)toast('멘토 확인 완료 · 결과를 확인하고 다음 교육 항목을 선택하세요.');
 beforeProgressCloud(c);
};

document.getElementById('educationToTop').onclick=()=>globalThis.scrollTo?.({top:0,behavior:'smooth'});

function educationActionCenter(){
 const p=cloud?.permissions||{};
 return '<section class="card action-center"><h2>여기서 무엇을 하면 되나요?</h2><div class="actions">'+(p.admin?'<button class="primary" data-view="account">교육 배정 설정</button><button data-manage-users>가입 승인·권한 관리</button><button data-invite-participants>참여자 초대</button>':'')+(p.trainer?'<button class="primary" data-view="trainer">교육자 · 확인 대기 처리</button>':'')+(p.assessor?'<button data-view="certification">평가자 · 포지션 결과 기록</button>':'')+'<button data-view="curriculum">교육·확인 찾기</button><button data-view="schedule">날짜별 진행 상황</button></div><p class="muted">'+(p.own?'본인 교육은 아래 현재 과제 또는 교육 항목에서 시작합니다.':p.admin?'관리자입니다. 위의 교육 기록 대상을 선택해 직원별 상황을 조회합니다. 관리자 권한만으로 교육생이 되거나 대신 실습할 수는 없습니다.':'배정받은 교육 기록을 조회합니다. 교육 기록과 교육자 확인은 각 담당자가 남깁니다.')+'</p><details><summary>처음 사용하는 분 · 시작부터 완료까지</summary><ol><li>관리자: 참여자를 초대하거나 가입을 승인합니다.</li><li>관리자: 교육생·교육 시작일·교육자·평가자를 선택하고 ‘교육 배정 저장’을 누릅니다.</li><li>교육생: ‘현재 교육 이어하기’ → 교재 읽기 → ‘교육 시작’ → 배운 내용·수행 항목 확인 → ‘교육자 확인 요청’.</li><li>배정 교육자: ‘확인 대기 처리’에서 항목별 확인 후 ‘확인 완료’. 이후 다음 미완료 과제가 안내됩니다.</li><li>포지션 평가자: 별도 현장 평가 후 ‘포지션 테스트’에 시험일·판정·근거·피드백을 저장합니다.</li></ol><p>교육 과정은 큰 순서이며 예정일이 겹치는 실습은 병행할 수 있습니다. 교육 확인과 시험 통과는 별도 기록입니다.</p></details></section>';
}
function journeyPanel(){
 const info=curriculumData.curriculumSource;
 return '<section class="card journey"><h2>온보딩은 이렇게 진행됩니다</h2><p>교육 시작 → 기본 운영 적응 → 제조 포지션별 실습·평가 → 교육 시작 6개월 ESP 목표</p><div class="journey-list">'+curriculumData.journey.map(g=>{
  const units=g.units.map(courseUnit),steps=units.flatMap(u=>u.steps),rs=steps.map(s=>record(s.id)),done=rs.filter(r=>r.status==='done').length,active=rs.some(r=>r.status==='practice'||r.status==='review'),test=g.test?person().tests[g.test].attempts.at(-1):null,passed=!g.test||test?.result==='pass',finished=done===steps.length&&passed;
  return '<details class="journey-stage '+(finished?'finished':active?'current':'')+'" '+(active?'open':'')+'><summary><span class="journey-number">'+g.order+'</span><span><strong>'+esc(g.title)+'</strong><small>'+esc(g.purpose)+'</small></span><span class="pill '+(finished?'green':active?'blue':'')+'">'+(finished?'확인 완료':active?'교육 중':'미완료')+' · '+done+'/'+steps.length+'</span></summary><div class="journey-body"><progress max="'+steps.length+'" value="'+done+'" aria-label="'+esc(g.title)+' 교육 확인 진척"></progress><p>'+esc(g.note)+'</p>'+units.map(u=>'<div class="journey-unit"><button data-gantt-item="'+u.id+'">'+esc(u.title)+'</button><span>교육 확인 '+unitProgress(u)+'/'+u.steps.length+'</span><button data-step="'+(u.steps.find(s=>record(s.id).status!=='done')||u.steps[0]).id+'">교육·확인 열기 →</button></div>').join('')+(g.test?'<div class="actions"><button data-gantt-item="test-'+g.test+'">'+esc(TEST_DEFS.find(t=>t.id===g.test).title)+' · 준비/결과</button><span>'+(!test?'평가 결과 미기록':test.result==='pass'?'통과 기록':test.result==='retry'?'보완·재시험':'평가 보류')+'</span></div>':'')+'</div></details>';
 }).join('')+'</div><details class="curriculum-source"><summary>과정 원본 · '+esc(info.status)+' · 반영 '+dateLabel(info.reflectedAt)+'</summary><p>'+esc(info.file)+'<br>'+esc(info.location)+'</p><p>'+esc(info.scheduleStatus)+'. 원본의 과정·단원·실습 표를 배치로 읽은 사본입니다. 교육 기록은 서버에 따로 보존합니다.</p></details></section>';
}
function nextPractice(id){return unitOf(id).steps.find(s=>s.id!==id&&record(s.id).status!=='done')||findStep(cloud?.assignments?.next);}
function practiceAction(s){
 const r=record(s.id),p=cloud?.permissions||{},canStart=cloud?.enrolled&&p.own&&trainingStart(),assignment=cloud?.roster.find(x=>x.id===cloud.target),next=nextPractice(s.id),future=trainingStart()>nowDay();
 let action='';
 if(r.status==='ready')action='<button class="primary" data-start-practice="'+s.id+'" '+(!canStart?'disabled':'')+'>교육 시작</button>';
 else if(p.own&&r.status==='practice')action=r.self.every(Boolean)?'<button class="primary" data-request="'+s.id+'">교육자 확인 요청</button>':'<button class="primary" data-lesson-anchor="lesson-checks">교육 항목 확인 · '+r.self.filter(Boolean).length+'/'+r.self.length+'</button>';
 else if(p.trainer&&r.status==='review')action=r.teacher.every(Boolean)?'<button class="primary" data-complete="'+s.id+'">합의 후 확인 완료</button>':'<button class="primary" data-lesson-anchor="lesson-teacher">교육자 항목 확인 · '+r.teacher.filter(Boolean).length+'/'+r.teacher.length+'</button>';
 else if(r.status==='review')action='<span class="pill amber">'+esc(assignment?.trainer||'교육자')+' 확인 대기 · 요청 '+dateLabel(r.request)+'</span>';
 else if(r.status==='done')action='<span class="pill green">확인 완료 · '+dateLabel(r.done)+'</span>'+(next&&next.id!==s.id?'<button class="primary" data-step="'+next.id+'">다음 교육 항목 열기 · '+esc(next.title)+' →</button>':'<span>이 단원 교육 확인 완료 · 남은 포지션 평가를 확인하세요.</span>');
 else action='<span class="pill">조회 화면 · 본인 교육 기록 아님</span>';
 if(p.admin&&(!cloud?.enrolled||!trainingStart()))action+='<button class="primary" data-view="account">교육 배정 설정</button>';
 const stage=r.status==='done'?4:r.status==='review'?3:r.status==='practice'?(r.self.every(Boolean)?2:1):0;
 return '<section class="card practice-action"><div class="section-heading"><h2>'+esc(s.title)+'</h2>'+pill(r)+'</div>'+(future&&r.status==='ready'?'<p id="lesson-start-notice" class="notice warning" role="status"><strong>예정 시작일은 '+dateLabel(trainingStart())+'입니다.</strong><br>지금 ‘교육 시작’을 누르면 실제 시작일은 '+dateLabel(nowDay())+'이 기록됩니다. 예정일과 계획은 그대로 유지합니다.</p>':'')+'<ol class="practice-stages">'+['교재·시작','학습·수행 확인','확인 요청','교육자 확인','완료'].map((t,i)=>'<li class="'+(i===stage?'current':i<stage?'finished':'')+'">'+t+'</li>').join('')+'</ol><div class="actions">'+action+'<button data-lesson-anchor="lesson-material">교재 읽기</button><button data-education-history="'+s.id+'">교육 이력</button></div><p>교육생 '+esc(cloud?.enrolled?cloud.name:'미배정')+' · 교육자 '+esc(assignment?.trainer||'미배정')+' · 학습·수행 확인 '+r.self.filter(Boolean).length+'/'+r.self.length+' · 교육자 확인 '+r.teacher.filter(Boolean).length+'/'+r.teacher.length+'</p><small>예정 '+planLabel(planOf(s.id).start)+' ~ '+planLabel(planOf(s.id).end)+' · 실제 시작 '+dateLabel(r.start)+' · 확인 완료 '+dateLabel(r.done)+'</small><p class="muted">'+(!cloud?.enrolled?'교육생이 배정되지 않아 시작과 체크가 잠겨 있습니다. 관리자에서 교육생·교육 시작일·담당자를 먼저 배정하세요.':!trainingStart()?'교육 시작일을 지정하면 교육을 시작할 수 있습니다.':!p.own&&r.status==='ready'?'교육 시작과 직원 체크는 교육생 본인 계정에서 합니다. 교육자는 확인 요청 후 항목을 확인합니다.':r.status==='ready'?'교재를 읽거나 교육자와 교육을 진행할 때 ‘교육 시작’을 누르세요. 첫 체크로 시작해도 같은 실제 시작일이 기록됩니다.':r.status==='review'?'요청 후 직원 체크는 잠깁니다. 배정 교육자가 배운 내용·수행 항목을 함께 확인한 뒤 완료합니다.':r.status==='done'?'이 교육 항목의 결과와 피드백을 확인하세요. 다음 교육 항목은 위 버튼을 눌러 직접 엽니다.':'정본과 체크 항목에 따라 배운 내용·수행 항목을 모두 확인한 뒤 교육자 확인을 요청하세요.')+'</p></section>';
}
function positionPreparation(t,u){
 const prep=u.steps.find(s=>s.id===t.id+'-test-prep'),next=u.steps.find(s=>record(s.id).status!=='done'&&s.id!==prep?.id)||u.steps[0];
 return '<div class="position-actions"><button data-step="'+u.steps[0].id+'"><span>1 · 배우기</span><strong>기본 교재 읽기</strong></button><button class="primary" data-step="'+next.id+'"><span>2 · 학습·수행 확인</span><strong>다음 교육 항목 열기 →</strong></button>'+(prep?'<button data-step="'+prep.id+'"><span>3 · 평가 준비</span><strong>제출·준비 항목 확인</strong></button>':'')+'<button data-position-results="'+t.id+'"><span>4 · 결과 확인</span><strong>현장 평가·재시험 이력</strong></button></div><details><summary>'+esc(u.title)+' · 전체 교육 항목</summary>'+practiceNavigation(u)+'</details>';
}


function positionTestCards(){return '<nav class="position-test-steps" aria-label="포지션 평가 단계">'+TEST_DEFS.map((t,i)=>{const a=person().tests[t.id].attempts.at(-1),u=courseUnit(t.unit);return '<button data-test-select="'+t.id+'" class="position-test-step '+(activePositionTest===t.id?'selected':'')+'" '+(activePositionTest===t.id?'aria-current="step"':'')+'><span class="pill violet">STEP '+(i+1)+' · 평가</span><strong>'+esc(t.title)+'</strong><span>예정 '+planLabel(planOf('test-'+t.id).start)+'</span><small>교육 확인 '+unitProgress(u)+'/'+u.steps.length+' · '+(!a?'평가 전':a.result==='pass'?'통과 기록':a.result==='retry'?'보완·재시험':'평가 보류')+'</small></button>';}).join('')+'</nav>';
}
function guideMarkup(body){if(!body)return '';const targets={'OP2 오픈 루틴 (1동·3동)':'U07','픽업 포지션':'U16','트레이 세팅 기준':'U16','레시피 카드 · 커피':'U26','오픈 체크리스트 21항목':'U10','주위생 요일표':'U42'};return body.replace(/(<h3>예시[\s\S]*?<\/h3>)((?:<p>[\s\S]*?<\/p>)+?)(?=<h3>)/g,(_,heading,paragraphs)=>heading+'<ul class="guide-shortcuts">'+paragraphs.replace(/<p>([\s\S]*?)<\/p>/g,(_,text)=>'<li>'+(targets[text]?'<button class="text-button" data-guide="'+targets[text]+'">'+text+' →</button>':text)+'</li>')+'</ul>');}
let inquiryList='shared',inquirySearch='',replyDrafts={},uploadingAttachment=false;
function richEditor(id,label,value){return '<div class="rich-field"><label id="'+id+'Label">'+label+'</label><div class="rich-toolbar" role="toolbar" aria-label="'+label+' 서식">'+[['bold','굵게'],['italic','기울임'],['insertUnorderedList','목록'],['removeFormat','서식 지우기']].map(([cmd,name])=>'<button type="button" data-rich-command="'+cmd+'" data-editor="'+id+'">'+name+'</button>').join('')+'<button type="button" data-inquiry-upload="'+id+'">사진 삽입</button></div><div class="rich-editor" id="'+id+'" contenteditable="true" role="textbox" aria-multiline="true" aria-labelledby="'+id+'Label">'+value+'</div></div>';}
function assetPath(id){return '/api/onboarding/attachments/'+encodeURIComponent(id);}
function attachmentLinks(ids=[],scope=''){return ids.length?'<ul class="attachment-list">'+ids.map(id=>{const a=cloud.assets?.[id];return a?'<li><a href="'+assetPath(id)+'" target="_blank" rel="noopener">'+esc(a.name)+' · '+Math.ceil(a.size/1024)+'KB ↗</a>'+(scope?'<button data-remove-attachment="'+id+'" data-attachment-scope="'+scope+'" aria-label="첨부 제외 '+esc(a.name)+'">×</button>':'')+'</li>':'';}).join('')+'</ul>':'';}
function attachmentPicker(scope,ids){return '<div class="attachment-picker"><label>파일 첨부 · 최대 5개<input type="file" data-file-upload="'+scope+'" multiple accept=".png,.jpg,.jpeg,.pdf,.docx,.xlsx,.txt,.csv"></label><small>파일당 8MB · PNG/JPEG 사진, PDF, Word, Excel, UTF-8 텍스트/CSV</small>'+attachmentLinks(ids,scope)+'<span role="status" id="attachmentStatus"></span></div>';}
function captureReply(){const n=document.getElementById('ticketReply');if(n&&ticketSelection)replyDrafts[ticketSelection]={...replyDrafts[ticketSelection],html:n.innerHTML,text:n.innerText||n.textContent||''};}
function plainPaste(e){const n=e.target.closest?.('.rich-editor');if(!n)return;e.preventDefault();const selection=globalThis.getSelection?.();if(!selection?.rangeCount)return;const range=selection.getRangeAt(0);range.deleteContents();const text=document.createTextNode(e.clipboardData.getData('text/plain'));range.insertNode(text);range.setStartAfter(text);range.collapse(true);selection.removeAllRanges();selection.addRange(range);captureInquiry();captureReply();}
async function uploadInquiryFiles(files,scope,editorId){
 if(!files.length||uploadingAttachment||busy||lastFailed)return;
 captureInquiry();captureReply();const draft=scope.startsWith('system:')?(systemDrafts[scope.slice(7)]??={}):scope==='reply'?(replyDrafts[ticketSelection]??={}):(inquiryDrafts[state.person]??={});draft.attachments??=[];
 if(files.length+draft.attachments.length>5){toast('문의·답변당 첨부는 최대 5개입니다.');return;}
 uploadingAttachment=true;lockControls();
 try{
  for(const file of files){
   if(!file.size||file.size>8*1024*1024)throw new Error('첨부는 파일당 8MB 이하로 올려 주세요.');
   if(editorId&&!/\.(png|jpe?g)$/i.test(file.name))throw new Error('본문 사진은 PNG 또는 JPEG를 선택하세요.');
   const encoded=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=()=>reject(new Error('파일을 읽지 못했습니다.'));r.readAsDataURL(file);});
   const r=await fetch('/api/onboarding/attachments',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':ERPAuth.csrfToken},body:JSON.stringify({requestId:crypto.randomUUID(),name:file.name,contentBase64:encoded})}),data=await r.json();if(!r.ok)throw new Error(data.error||'첨부 저장 실패');
   cloud.rootRevision=data.rootRevision;cloud.assets??={};cloud.assets[data.asset.id]=data.asset;draft.attachments.push(data.asset.id);
   if(editorId){const n=document.getElementById(editorId);n.innerHTML+='<p><img src="'+assetPath(data.asset.id)+'" alt="문의에 첨부한 사진"></p>';if(scope==='reply')captureReply();else captureInquiry();}
  }
  toast(scope.startsWith('system:')?'첨부 업로드 완료 · 처리 내용 저장을 누르면 수정 요청에 연결됩니다.':'첨부 저장 완료 · 문의/답변을 접수하면 함께 연결됩니다.');
 }catch(e){toast(e.message);}
 finally{uploadingAttachment=false;render();}
}
document.getElementById('app').addEventListener('input',e=>{if(e.target.closest?.('.rich-editor')){captureInquiry();captureReply();}else if(e.target.id?.startsWith('inquiry'))captureInquiry();});
document.getElementById('app').addEventListener('paste',plainPaste);
document.getElementById('app').addEventListener('drop',e=>{if(e.target.closest?.('.rich-editor'))e.preventDefault();});
document.getElementById('app').addEventListener('change',e=>{if(e.target.dataset.fileUpload)uploadInquiryFiles([...e.target.files],e.target.dataset.fileUpload);else if(e.target.id==='inquirySearch'){captureInquiry();captureReply();inquirySearch=e.target.value;render();}});
document.getElementById('app').addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.testSelect){e.stopImmediatePropagation();activePositionTest=b.dataset.testSelect;view='certification';render();}
 else if(b.dataset.positionResults){e.stopImmediatePropagation();document.getElementById('position-result-'+b.dataset.positionResults)?.scrollIntoView?.({block:'start',behavior:'smooth'});}
 else if(b.dataset.inquiryList){e.stopImmediatePropagation();captureInquiry();captureReply();inquiryList=b.dataset.inquiryList;ticketSelection=null;render();}
 else if(b.hasAttribute('data-new-inquiry')){e.stopImmediatePropagation();document.getElementById('inquiryTitle')?.focus();}
 else if(b.dataset.removeAttachment){e.stopImmediatePropagation();captureInquiry();captureReply();const reply=b.dataset.attachmentScope==='reply',d=reply?replyDrafts[ticketSelection]:inquiryDrafts[state.person];d.attachments=d.attachments.filter(i=>i!==b.dataset.removeAttachment);for(const key of reply?['html']:['inquiryBodyHtml','inquiryExpectedHtml'])if(d[key])d[key]=d[key].replace(new RegExp('<img[^>]*'+b.dataset.removeAttachment+'[^>]*>','g'),'');render();}
 else if(b.dataset.richCommand){e.stopImmediatePropagation();document.getElementById(b.dataset.editor).focus();document.execCommand(b.dataset.richCommand,false,null);captureInquiry();captureReply();}
 else if(b.dataset.inquiryUpload){e.stopImmediatePropagation();const id=b.dataset.inquiryUpload,input=document.createElement('input');input.type='file';input.accept='.png,.jpg,.jpeg';input.multiple=true;input.onchange=()=>uploadInquiryFiles([...input.files],id==='ticketReply'?'reply':'inquiry',id);input.click();}
 else if(b.dataset.ticketOpen){captureInquiry();captureReply();}
},true);
document.getElementById('dialogBody').addEventListener('click',e=>{const b=e.target.closest('[data-guide]');if(b){e.stopImmediatePropagation();openGuide(b.dataset.guide);}},true);

document.getElementById('app').addEventListener('mousedown',e=>{if(e.target.closest?.('[data-rich-command]'))e.preventDefault();});

// Keep the existing educational workspace behind a linked detail surface.
let educationDetail=null,educationDetailStack=[],educationDetailOrigin=null,educationSequenceCache={scope:'',surfaces:{}};
const educationViewNames={system:'수정 요청(시스템 판단)',access:'온보딩 접근 권한',home:'교육 개요',curriculum:'교육 목록',board:'교육 보드',schedule:'교육 일정',lesson:'교육·확인',certification:'포지션 테스트',trainer:'교육 담당자',materials:'자료·판본'};
function captureEducationSurface(root){
 if(!root)return {};
 return {scrollTop:root.scrollTop||0,scrollLeft:root.scrollLeft||0,details:[...root.querySelectorAll('details')].map(n=>({key:n.hasAttribute('data-education-sequence')?'education-sequence':n.querySelector('summary')?.textContent||'',open:n.open})),scrolls:[...root.querySelectorAll('.curriculum,.scroll,.board-col')].map(n=>({top:n.scrollTop,left:n.scrollLeft})),drafts:[...root.querySelectorAll('textarea,input,select')].filter(n=>n.id&&!['checkbox','radio','file'].includes(n.type)).map(n=>({id:n.id,value:n.value}))};
}
function restoreEducationSurface(root,s={}){
 if(!root)return;
 const counts={};for(const n of root.querySelectorAll('details')){const key=n.hasAttribute('data-education-sequence')?'education-sequence':n.querySelector('summary')?.textContent||'',i=counts[key]||0;counts[key]=i+1;const v=s.details?.filter(x=>x.key===key)[i];if(v)n.open=v.open;}
 for(const d of s.drafts||[]){const n=[...root.querySelectorAll('textarea,input,select')].find(n=>n.id===d.id);if(n)n.value=d.value;}
 [...root.querySelectorAll('.curriculum,.scroll,.board-col')].forEach((n,i)=>{const v=s.scrolls?.[i];if(v){n.scrollTop=v.top;n.scrollLeft=v.left;}});
 root.scrollTop=s.scrollTop||0;root.scrollLeft=s.scrollLeft||0;
}
function revealEducationTarget(target){
 if(!target)return false;
 for(let n=target.parentElement;n;n=n.parentElement)if(n.tagName==='DETAILS')n.open=true;
 target.style.scrollMarginTop=target.closest('#dialogBody')?'16px':'calc(var(--header-height,64px) + 16px)';
 target.setAttribute('tabindex','-1');target.focus?.({preventScroll:true});target.scrollIntoView?.({behavior:'smooth',block:'start'});return true;
}
function educationAnchor(id){
 const dialog=document.getElementById('dialog'),root=document.getElementById(dialog.open?'dialogBody':'app');
 return revealEducationTarget(dialog.open?detailElement(id):root.querySelector('[id="'+id+'"]'));
}
function revealCanonical(id){
 const root=document.getElementById(document.getElementById('dialog').open?'dialogBody':'app');
 return revealEducationTarget(root.querySelector('[data-canonical-ref="'+id+'"]'));
}
function selectEducationSequence(id){
 const current=educationDetail?.kind==='lesson'?educationDetail.id:!educationDetail&&view==='lesson'?selected:null;
 if(!current||!findStep(id)||unitOf(id).id!==unitOf(current).id||current===id)return;
 if(busy||lastFailed){toast('저장 상태를 먼저 확인한 뒤 다른 교육 항목을 선택하세요.');return;}
 const body=document.getElementById(educationDetail?'dialogBody':'app'),old=body.querySelector('[data-education-sequence]'),open=old?.open,top=old?.getBoundingClientRect().top,scroll=body.scrollTop,windowTop=globalThis.scrollY||0,windowLeft=globalThis.scrollX||0;
 const scope=cloud.user.id+':'+cloud.target;if(educationSequenceCache.scope!==scope)educationSequenceCache={scope,surfaces:{}};
 const surfaces=educationDetailOrigin?(educationDetailOrigin.lessonSurfaces??={}):educationSequenceCache.surfaces;surfaces[current]=captureEducationSurface(body);
 if(educationDetail){educationDetail={kind:'lesson',id};renderEducationDetail(surfaces[id]);}
 else{selected=id;render();restoreEducationSurface(body,surfaces[id]);globalThis.scrollTo?.({top:windowTop,left:windowLeft,behavior:'instant'});}
 const next=body.querySelector('[data-education-sequence]');if(next){next.open=!!open;body.scrollTop=scroll;if(Number.isFinite(top))body.scrollTop+=next.getBoundingClientRect().top-top;}
 body.querySelector('[aria-current="step"] strong')?.setAttribute('tabindex','-1');body.querySelector('[aria-current="step"] strong')?.focus?.({preventScroll:true});
 toast('선택한 교육 항목: '+findStep(id).title+' · 아래에서 내용과 확인 항목을 이어서 봅니다.');
}
function detailElement(id){return document.getElementById('dialogBody').querySelector('[data-detail-id="'+id+'"]');}
function detailNamespace(html){return html.replace(/\sid="([^"]+)"/g,(_,id)=>' id="education-detail-'+id+'" data-detail-id="'+id+'"').replace(/\s(for|aria-labelledby|aria-describedby)="([^"]+)"/g,(_,attr,ids)=>' '+attr+'="'+ids.split(' ').map(id=>'education-detail-'+id).join(' ')+'"');}
function detailTitle(d){return d.kind==='education-history'?'교육 이력 · '+findStep(d.id)?.title:d.kind==='lesson'?findStep(d.id)?.title:d.kind==='unit'?courseUnit(d.id)?.title:d.kind==='test'?TEST_DEFS.find(t=>t.id===d.id)?.title:d.kind==='guide'?source.refs[d.id]?.title:d.kind==='photo'?source.photos[d.id]?.caption:'교육 상세';}
const initialPeekScheduleUnit=peekScheduleUnit,initialGuide=openGuide,initialPhoto=openPhoto;
function openEducationDetail(kind,id,push=true){
 const valid=['lesson','education-history'].includes(kind)?findStep(id):kind==='unit'?courseUnit(id):kind==='test'?TEST_DEFS.find(t=>t.id===id):kind==='guide'?source.refs[id]:kind==='photo'?source.photos[id]:null;if(!valid)return;
 if(!educationDetailOrigin){const active=document.activeElement;educationDetailOrigin={scope:cloud.user.id+':'+cloud.target,view,selected,top:globalThis.scrollY||0,left:globalThis.scrollX||0,surface:captureEducationSurface(document.getElementById('app')),focus:active?.dataset?.step?'[data-step="'+active.dataset.step+'"]':active?.dataset?.ganttItem?'[data-gantt-item="'+active.dataset.ganttItem+'"]':null};}
 else if(push&&educationDetail&&(educationDetail.kind!==kind||educationDetail.id!==id))educationDetailStack.push({...educationDetail,surface:captureEducationSurface(document.getElementById('dialogBody'))});
 const same=educationDetail?.kind===kind&&educationDetail?.id===id,surface=same?captureEducationSurface(document.getElementById('dialogBody')):null;
 if(same)return;
 educationDetail={kind,id};renderEducationDetail(surface);
}
function renderEducationDetail(surface){
 if(!educationDetail)return;
 const d=educationDetail,body=document.getElementById('dialogBody'),dialog=document.getElementById('dialog');let html='';
 if(d.kind==='lesson'){const old=selected;selected=d.id;try{html=lessonContent(d.id)+sourceStamp()+(d.id==='orders-pos'?materialPanel():'');}finally{selected=old;}}
 else if(d.kind==='education-history'){html=lessonHistoryContent(d.id);}
 else if(d.kind==='unit'){initialPeekScheduleUnit(d.id);html=body.innerHTML;}
 else if(d.kind==='test'){const old=activePositionTest;activePositionTest=d.id;try{html=certificationContent();}finally{activePositionTest=old;}}
 else if(d.kind==='guide'){initialGuide(d.id);html=body.innerHTML;}
 else if(d.kind==='photo'){initialPhoto(d.id);html=body.innerHTML;}
 const parent=educationDetailStack.at(-1),root=educationViewNames[educationDetailOrigin.view]||'원래 화면';
 document.getElementById('dialogTitle').textContent=detailTitle(d)||'교육 상세';document.getElementById('dialogLink').hidden=d.kind!=='guide';
 body.innerHTML='<nav class="detail-path" aria-label="교육 상세 위치"><button data-detail-back>← '+esc(parent?parent.kind==='lesson'?'교육 항목으로 돌아가기':detailTitle(parent)+'로 돌아가기':root+'로 돌아가기')+'</button><span>'+esc(root)+' › '+esc(d.kind==='lesson'?unitOf(d.id).title+' › ':'')+esc(detailTitle(d))+'</span></nav><div id="educationDetailStatus" role="status" hidden></div>'+detailNamespace(html);
 const role=detailElement('testRole');if(role)role.closest('.card').hidden=true;
 if(cloud&&['education-history','test'].includes(d.kind))WorkspaceItems.mount(body,{room:'onboarding',kind:d.kind==='education-history'?'step':'test',id:d.id,person:cloud.target});
 if(cloud&&d.kind==='lesson')WorkspaceItems.mount(body,{room:'onboarding',kind:'step',id:d.id,person:cloud.target},{summaryOnly:true,openHistory:()=>openEducationDetail('education-history',d.id)});
 restoreEducationSurface(body,surface||{});educationDetailLayout();if(!dialog.open)dialog.showModal();lockControls();updateEducationDetailStatus();
}
function backEducationDetail(){
 if(educationDetailStack.length){const previous=educationDetailStack.pop();educationDetail={kind:previous.kind,id:previous.id};renderEducationDetail(previous.surface);}
 else closeEducationDetail();
}
function updateEducationDetailStatus(){
 const n=document.getElementById('educationDetailStatus');if(!n)return;n.hidden=!busy&&!lastFailed&&!lastValidationError;if(n.hidden)return;
 n.innerHTML='<p>'+esc(document.getElementById('storageNote').textContent)+'</p>'+(lastFailed?'<button data-detail-save-retry>같은 요청 다시 저장</button><button data-detail-refresh>서버 기록 새로 불러오기</button>':'');
}
peekLesson=id=>openEducationDetail('lesson',id);
peekScheduleUnit=id=>openEducationDetail('unit',id);
openGuide=id=>{if(!revealCanonical(id))openEducationDetail('guide',id);};
openPhoto=id=>openEducationDetail('photo',id);
function finishEducationDetail(){
 const origin=educationDetailOrigin;educationDetail=null;educationDetailStack=[];educationDetailOrigin=null;
 if(origin&&cloud&&origin.scope===cloud.user.id+':'+cloud.target){view=origin.view;selected=origin.selected;restoreEducationSurface(document.getElementById('app'),origin.surface);if(origin.focus)document.getElementById('app').querySelector(origin.focus)?.focus?.({preventScroll:true});globalThis.scrollTo?.({top:origin.top,left:origin.left,behavior:'instant'});}
}
function closeEducationDetail(){finishEducationDetail();document.getElementById('dialog').close();}
document.getElementById('dialog').addEventListener('close',()=>{if(!document.getElementById('dialog').open)finishEducationDetail();});
function educationDetailRoute(e){
 const b=e.target.closest?.('button');if(!b||b.disabled)return;
 if(b.dataset.educationHistory){e.stopImmediatePropagation();openEducationDetail('education-history',b.dataset.educationHistory);}
 else if(b.dataset.sequenceStep){e.stopImmediatePropagation();selectEducationSequence(b.dataset.sequenceStep);}
 else if(b.dataset.fullGuide){e.stopImmediatePropagation();openEducationDetail('guide',b.dataset.fullGuide);}
 else if(b.hasAttribute('data-detail-back')){e.stopImmediatePropagation();backEducationDetail();}
 else if(b.dataset.step||b.dataset.openLesson||b.dataset.peek){e.stopImmediatePropagation();openEducationDetail('lesson',b.dataset.step||b.dataset.openLesson||b.dataset.peek);}
}
document.getElementById('app').addEventListener('click',educationDetailRoute,true);
document.getElementById('dialogBody').addEventListener('click',e=>{
 const b=e.target.closest?.('button');if(!b||b.disabled)return;
 educationDetailRoute(e);if(e.cancelBubble)return;
 const use=fn=>{e.stopImmediatePropagation();fn();};
 if(b.dataset.peekGuide||b.dataset.guide)use(()=>openGuide(b.dataset.peekGuide||b.dataset.guide));
 else if(b.dataset.photo)use(()=>openPhoto(b.dataset.photo));
 else if(b.hasAttribute('data-start-practice'))use(()=>start(b.dataset.startPractice));
 else if(b.dataset.request)use(()=>requestReview(b.dataset.request));
 else if(b.dataset.complete)use(()=>complete(b.dataset.complete));
 else if(b.dataset.retry)use(()=>retry(b.dataset.retry,detailElement('retryReason').value));
 else if(b.dataset.lessonAnchor)use(()=>educationAnchor(b.dataset.lessonAnchor));
 else if(b.dataset.logPractice)use(()=>addPracticeLog(b.dataset.logPractice,detailElement('practice-date').value,detailElement('practice-condition').value,detailElement('practice-observation').value));
 else if(b.dataset.delayReason)use(()=>{const reason=detailElement('delayReason-'+b.dataset.delayReason).value.trim();if(!reason)return toast('지연 사유를 입력하세요.');act('schedule.reason',{item:b.dataset.delayReason,reason});});
 else if(b.dataset.testSelect)use(()=>openEducationDetail('test',b.dataset.testSelect));
 else if(b.dataset.positionResults)use(()=>detailElement('position-result-'+b.dataset.positionResults)?.scrollIntoView?.({block:'start',behavior:'smooth'}));
 else if(b.dataset.recordTest)use(()=>{const id=b.dataset.recordTest;recordPositionTest(id,detailElement('test-date-'+id).value,detailElement('test-result-'+id).value,detailElement('test-criteria-'+id).value,detailElement('test-feedback-'+id).value,detailElement('test-confirm-'+id).checked);});
 else if(b.hasAttribute('data-detail-save-retry'))use(retryFailed);
 else if(b.hasAttribute('data-detail-refresh'))use(()=>refreshCloud());
 else if(b.dataset.contact||b.dataset.guideContact)use(()=>{closeEducationDetail();beginInquiry(b.dataset.contact||null,b.dataset.guideContact);});
 else if(b.dataset.view)use(()=>{closeEducationDetail();view=b.dataset.view;render();});
},true);
document.getElementById('dialogBody').addEventListener('change',e=>{
 const t=e.target;if(t.dataset.check){e.stopImmediatePropagation();(t.dataset.role==='teacher'?toggleTeacher:toggleSelf)(t.dataset.check,Number(t.dataset.index),t.checked);}
 else if(t.dataset.memo){e.stopImmediatePropagation();act('step.memo',{step:t.dataset.memo,memo:t.value});}
});
const priorDetailRender=render;
render=function(){
 const samePage=cloud&&navigationScope===cloud.user.id+':'+cloud.target&&navigationPage===view+':'+(view==='lesson'?selected:''),preserve=educationDetailOrigin||samePage;
 document.getElementById('app').style?.setProperty('overflow-anchor','none');
 const background=preserve?captureEducationSurface(document.getElementById('app')):null,panel=educationDetail?captureEducationSurface(document.getElementById('dialogBody')):null,top=globalThis.scrollY||0,left=globalThis.scrollX||0;
 priorDetailRender();if(preserve)restoreEducationSurface(document.getElementById('app'),background);
 if(educationDetailOrigin){educationDetailOrigin.surface=captureEducationSurface(document.getElementById('app'));renderEducationDetail(panel);}
 if(preserve)globalThis.scrollTo?.({top:educationDetailOrigin?.top??top,left:educationDetailOrigin?.left??left,behavior:'instant'});
};
const priorDetailCloud=applyCloud;
applyCloud=function(c){
 if(educationDetailOrigin&&educationDetailOrigin.scope!==c.user.id+':'+c.target){educationDetailOrigin=null;educationDetail=null;educationDetailStack=[];document.getElementById('dialog').close();}
 const id=educationDetail?.kind==='lesson'?educationDetail.id:null,completed=id&&cloud?.target===c.target&&record(id)?.status!=='done'&&c.learner.records[id]?.status==='done';
 priorDetailCloud(c);if(completed)toast('교육자 확인 완료 · 결과와 피드백을 확인한 뒤 다음 교육 항목을 선택하세요.');
};
const priorDetailStatus=statusLine;
statusLine=function(message,failed=false){priorDetailStatus(message,failed);updateEducationDetailStatus();};

const priorDetailLock=lockControls;
lockControls=function(){priorDetailLock();updateEducationDetailStatus();};

// Home modes describe authorized work; switching modes never grants permissions.
let roleHomePreference=null;
const systemDrafts={};
let systemReviewList='pending';
const systemEvidence=JSON.parse(document.getElementById('system-evidence-data')?.textContent||'{}');
const reviewStatusNames={open:'검토 요청',working:'확인 중',resolved:'보완 확인',hold:'보류',applied:'반영 완료'};
function availableHomeRoles(){
 const p=cloud?.workspaceRoles||{};
 return [p.admin?'admin':null,p.trainer||p.assessor?'trainer':null,p.learner?'learner':null,!p.admin&&!p.trainer&&!p.assessor&&!p.learner?'support':null].filter(Boolean);
}
function homeRole(){
 const options=availableHomeRoles();
 if(roleHomePreference===null&&cloud){try{roleHomePreference=localStorage.getItem('momos-onboarding-home-role:'+cloud.user.id)||'';}catch{roleHomePreference='';}}
 return options.includes(roleHomePreference)?roleHomePreference:options[0]||'support';
}
function homeRoleSwitch(){
 const names={admin:'운영관리자 뷰',trainer:'교육자 뷰',learner:'교육생 뷰',support:'과정 안내'};
 return '<div class="role-switch" aria-label="홈 보기 역할"><span>나에게 배정된 역할</span>'+availableHomeRoles().map(r=>'<button data-home-role="'+r+'" aria-pressed="'+(homeRole()===r)+'">'+names[r]+'</button>').join('')+'</div>';
}
function roleHome(){
 const mode=homeRole(),rows=cloud.educationSummary||[],admin=mode==='admin',educator=mode==='trainer',reviews=cloud.systemReviews||[];
 const total=rows.reduce((n,r)=>n+r.total,0),done=rows.reduce((n,r)=>n+r.done,0),waiting=rows.reduce((n,r)=>n+r.waiting.length,0),delayed=rows.filter(r=>r.overdue>0);
 const title=admin?'교육 운영을 한눈에 확인하세요.':educator?'확인할 교육 항목부터,<br>함께 다음 단계로.':'현장 교육을 지원합니다.';
 const note=admin?'교육 배정, 교육 확인 대기, 계획보다 늦어진 과정과 평가 준비를 함께 살펴봅니다.':educator?'배정된 교육생의 수행 내용을 확인하고, 교육자·평가자 역할에 맞춰 기록합니다.':'과정과 자료를 살펴보고 담당 문의를 확인하세요.';
 const action=admin?'<button class="primary" data-view="account">교육 배정 설정</button><button data-view="access">온보딩 접근 권한</button>':educator?'':'<button class="primary" data-view="inquiries">담당 문의 보기</button>';
 const metrics='<div class="role-kpis"><div><span>'+ (admin?'교육 배정':'담당 교육생')+'</span><strong>'+rows.length+'명</strong><small>'+rows.filter(r=>!r.startDate).length+'명 시작일 미설정</small></div><div><span>교육자 확인 대기</span><strong>'+waiting+'개</strong><small>직원의 확인 요청 기준</small></div><div><span>계획보다 늦어진 교육생</span><strong>'+delayed.length+'명</strong><small>계획 종료일 · 실제 미완료 기준</small></div><div><span>교육 확인 진척</span><strong>'+pct(done,total)+'%</strong><small>완료 '+done+' / '+total+'단계 · 평가 통과는 별도</small></div></div>';
 const cards=rows.map(r=>{
  const queue=r.waiting.slice(0,3).map(id=>findStep(id)).filter(Boolean);
  return '<article class="role-person"><div><h3>'+esc(r.name)+'</h3><small>교육 시작 '+dateLabel(r.startDate)+' · 교육자 '+esc(r.trainer)+' · 평가자 '+esc(r.assessor)+'</small><p>교육 확인 '+pct(r.done,r.total)+'% · 확인 대기 '+r.waiting.length+'개'+(r.overdue?' · 계획 종료일 경과 '+r.overdue+'개':'')+'</p><progress max="'+r.total+'" value="'+r.done+'"></progress><small>'+TEST_DEFS.map(t=>esc(t.title)+' '+(r.tests[t.id].passed?'✓ 통과':dateLabel(r.tests[t.id].date)+' 예정')).join(' · ')+'</small></div><div class="actions">'+queue.map(s=>'<button class="primary" data-role-person="'+r.id+'" data-role-lesson="'+s.id+'">'+esc(s.title)+' · '+(r.canConfirm?'항목 확인':'교육 항목 보기')+'</button>').join('')+'<button data-role-person="'+r.id+'" data-role-destination="'+(educator?'trainer':'schedule')+'">'+(educator?'교육 확인·피드백':'일정·진척 상세')+'</button>'+(cloud.workspaceRoles.assessor?'<button data-role-person="'+r.id+'" data-role-destination="certification">평가 준비·결과</button>':'')+'</div></article>';
 }).join('');
 const empty='<div class="empty-state"><h2>'+ (admin?'아직 배정된 교육생이 없습니다.':educator?'아직 담당 교육생이 없습니다.':'교육 과정을 먼저 살펴보세요.')+'</h2><p>'+ (admin?'참여자를 초대한 뒤 교육 시작일과 교육자·평가자를 배정하면 직원별 현황이 나타납니다. 관리자 계정 자체는 교육생이 되지 않습니다.':educator?'관리자에게 교육자 또는 평가자 배정을 요청하세요. 교육생을 선택하면 실제 기록 권한을 확인합니다.':'자료·판본과 교육 목록을 열어 전체 흐름을 확인할 수 있습니다.')+'</p>'+action+'</div>';
 return '<section class="education-home role-home" aria-label="'+(admin?'운영관리자 홈':educator?'교육자 홈':'지원 홈')+'">'+homeRoleSwitch()+'<div class="role-hero"><p>온천본점 · 현장 온보딩</p><h1>'+title+'</h1><p>'+note+'</p><div class="actions">'+action+'</div></div>'+(admin||educator?metrics:'')+'<div class="role-section-head"><h2>'+ (admin?'교육생별 진행 현황':educator?'담당 교육생 · 확인할 교육 항목':'교육 과정')+'</h2><span class="role-view-note">'+(admin?'전체 배정 교육생':'현재 계정에 배정된 교육생')+' · 실제 기록 기준</span></div><div class="role-queue">'+(cards||empty)+'</div>'+(cloud.reviewAccess?'<section class="card"><div class="section-heading"><h2>자료 보완 · 시스템 판단</h2><span class="pill amber">'+reviews.filter(r=>r.status!=='applied').length+'건 처리 필요</span></div><p>근거가 부족한 내용을 확인하고 매장 기준·사진·양식을 보완합니다.</p><button data-view="system">수정 요청(시스템 판단) 보기</button></section>':'')+'<div class="home-quick-actions"><button data-view="curriculum">교육 목록</button><button data-view="materials">자료·판본 확인</button><a href="/updates.html" target="_blank" rel="noopener">패치 내역 ↗</a></div><details class="workspace-section"><summary><strong>교육생이 거치는 전체 과정</strong></summary><div class="section-body">'+homeJourneyOverview()+'</div></details></section>';
}
function accessManagement(){
 if(!cloud.permissions.admin)return page('온보딩 접근 권한','관리자 전용','<div class="notice">온보딩 관리자가 접근 권한을 변경합니다.</div>');
 const c=cloud.configuration;
 return page('온보딩 접근 권한','가입 승인과 별도로 현장 온보딩의 접근을 관리합니다.','<section class="card"><h2>계정별 허용·차단</h2><p>기존 승인된 모모스 계정·배정된 외부 담당자의 접근은 유지합니다. 아래에서 변경한 계정은 온보딩과 로그인 기반 업무 가이드에 즉시 적용됩니다. ERP·업무혁신의 접근, 계정 승인 상태와 기존 교육 기록은 유지합니다.</p><p class="notice">접근 허용은 다른 직원 기록의 열람·확인 권한을 부여하지 않습니다. 본인·배정 교육생만 열람하며, 온보딩 관리자는 차단할 수 없습니다.</p><div class="actions"><button data-manage-users>가입 승인·구성원 관리</button><button data-view="account">교육 역할·담당자 배정</button></div></section><div class="access-list">'+c.users.map(u=>{
 const override=c.accessOverrides[u.id],isAdmin=u.company==='momos'&&u.role==='admin';
 return '<section class="access-member"><div><strong>'+esc(u.name)+'</strong><small>'+ (u.company==='momos'?'모모스커피':'외부 협력')+' · '+(c.learners[u.id]?'교육생':'교육생 미배정')+'</small>'+ (override?'<small>최근 변경 '+esc(override.name)+' · '+dateLabel(override.at.slice(0,10))+'<br>'+esc(override.reason)+'</small>':'')+'</div><label>온보딩 접근<select id="accessAllowed-'+u.id+'" '+(isAdmin?'disabled':'')+'><option value="yes" '+(u.admitted?'selected':'')+'>허용</option><option value="no" '+(!u.admitted?'selected':'')+'>차단</option></select></label><label>변경 사유<input id="accessReason-'+u.id+'" maxlength="1000" placeholder="변경 이유" '+(isAdmin?'disabled':'')+'></label><button data-save-access="'+u.id+'" '+(isAdmin?'disabled':'')+'>'+(isAdmin?'관리자 접근 유지':'접근 권한 저장')+'</button></section>';
 }).join('')+'</div>');
}
function systemRequests(){
 if(!cloud.reviewAccess)return page('수정 요청(시스템 판단)','자료의 확인·보완 요청','<div class="notice">관리자·교육자·평가자·문의 담당자가 이 화면을 확인합니다. 내용 보완 의견은 문의·답변에서 접수할 수 있습니다.</div>');
 const items=(cloud.systemReviews||[]).map(r=>({...r,image:systemEvidence[r.id]||''}));
 const visible=items.filter(r=>systemReviewList==='applied'?r.status==='applied':r.status!=='applied');
 return page('수정 요청(시스템 판단)','근거가 부족한 부분을 모아 매장에서 확인하고 보완합니다.','<section class="card"><h2>판단을 보류한 이유를 남깁니다.</h2><p>내용 부족 · 정본 충돌 · 자료 확보 · 기술 문제 등을 구분합니다. 아래 요청은 시스템이 현재 확보한 자료를 검토한 결과이며 정본 승인이나 현장 시행 판정이 아닙니다.</p><p class="muted">내용 요청은 매장 내용 담당·관리자가, 기술 요청은 기술 담당·관리자가 처리합니다. 교육자는 근거와 관련 실습을 확인합니다. 보완 확인은 자료를 확보한 상태입니다. 실제 교재·시스템에 반영하고 확인한 뒤 반영 완료로 저장하세요. 반영 완료는 처리 필요 건수에서 제외되며 이력은 남습니다. 정본 승인·현장 시행은 별도입니다.</p><span class="pill amber">처리 필요 '+items.filter(r=>r.status!=='applied').length+'건</span><div class="actions"><button data-system-list="pending" aria-pressed="'+(systemReviewList==='pending')+'" class="'+(systemReviewList==='pending'?'primary':'')+'">처리 필요</button><button data-system-list="applied" aria-pressed="'+(systemReviewList==='applied')+'" class="'+(systemReviewList==='applied'?'primary':'')+'">반영 완료 이력</button></div></section>'+(!visible.length?'<div class="notice">'+(systemReviewList==='applied'?'반영 완료된 요청이 없습니다.':'처리할 수정 요청이 없습니다. 지난 기록은 반영 완료 이력에서 확인할 수 있어요.')+'</div>':'')+visible.map(r=>{
 const d=systemDrafts[r.id]??={status:r.status,comment:r.comment,source:r.source,attachments:[...r.attachments]};
 const editable=cloud.permissions.admin||cloud.permissions[r.kind==='technical'?'technical':'content'];
 return '<article class="card system-request" id="system-'+r.id+'"><div class="system-meta"><span class="pill amber">'+esc(r.category)+'</span><span class="pill">'+(r.kind==='technical'?'기술 · 치얼스':'내용 · 매장')+'</span><span class="system-status">'+reviewStatusNames[r.status]+'</span></div><h2>'+esc(r.title)+'</h2><p><strong>왜 결정하기 어려운가</strong><br>'+esc(r.reason)+'</p><p><strong>필요한 보완</strong><br>'+esc(r.needed)+'</p><div class="system-evidence" id="evidence-'+r.id+'"><strong>확인한 교재 근거</strong><blockquote>'+esc(r.evidence)+'</blockquote><small>'+esc(r.sourceFile)+'<br>'+esc(r.sourceVersion)+' · 기준 확인 '+dateLabel(r.checkedAt)+' · 요청 등록 '+dateLabel(r.detectedAt)+'</small>'+(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(r.image)?'<details><summary>근거 화면 이미지 보기</summary><img src="'+r.image+'" alt="'+esc(r.title)+'의 검토 근거 화면"><small>'+esc(r.imageCaption||'교재 검토 근거')+'</small></details>':'')+'</div><div class="actions"><button data-open-lesson="'+r.step+'">관련 교육·확인 열기</button><button data-guide="'+r.ref+'">관련 정본 내용 조회</button></div><details '+(d.status==='working'||d.comment||d.attachments.length?'open':'')+'><summary>처리 내용 · 첨부 · 이력</summary>'+(editable?'<div class="system-processing"><label>처리 상태<select data-system-field="status" data-system-id="'+r.id+'" id="systemStatus-'+r.id+'">'+Object.entries(reviewStatusNames).map(([key,label])=>'<option value="'+key+'" '+(d.status===key?'selected':'')+'>'+label+'</option>').join('')+'</select></label><label>확인 내용·다음 조치 · 필수<textarea data-system-field="comment" data-system-id="'+r.id+'" id="systemComment-'+r.id+'" maxlength="2000">'+esc(d.comment)+'</textarea></label><label>자료 또는 반영 위치·판본 · 보완 확인·반영 완료 시 필수<input data-system-field="source" data-system-id="'+r.id+'" id="systemSource-'+r.id+'" maxlength="2000" value="'+esc(d.source)+'" placeholder="드라이브 자료 또는 교재·패치 위치 · 판본 · 반영 확인일"></label>'+attachmentPicker('system:'+r.id,d.attachments)+'<button class="primary" data-save-system="'+r.id+'">처리 내용 저장</button></div>':'<p>처리 담당: '+(r.kind==='technical'?'기술 문의 담당':'매장 내용 담당')+' 또는 관리자</p><p>'+esc(r.comment||'아직 처리 기록이 없습니다.')+'</p><p>'+esc(r.source)+'</p>'+attachmentLinks(r.attachments))+ (r.history.length?'<h3>처리 이력</h3>'+r.history.slice().reverse().map(h=>'<div class="result"><b>'+esc(h.actor)+' · '+dateLabel(h.at.slice(0,10))+' · '+reviewStatusNames[h.status]+'</b><p>'+esc(h.comment)+'</p><small>'+esc(h.source)+'</small></div>').join(''):'')+'</details></article>';
 }).join(''));
}
const beforeRoleRender=render;
render=function(){
 beforeRoleRender();if(!cloud)return;
 const p=cloud.workspaceRoles;
 document.querySelector('[data-nav="access"]').hidden=!p.admin;
 document.querySelector('[data-nav="system"]').hidden=!cloud.reviewAccess;
 document.querySelector('[data-nav="trainer"]').hidden=!(p.trainer||p.assessor);
 document.querySelector('[data-nav="home"] .nav-text').textContent=p.admin?'운영 개요':p.trainer||p.assessor?'교육자 홈':'교육 개요';
 if(view==='home'&&homeRole()==='learner')document.getElementById('app').insertAdjacentHTML('afterbegin',homeRoleSwitch());
 if(['system','access'].includes(view)){document.getElementById('educationOverview').hidden=true;document.getElementById('storageNote').hidden=!lastFailed;document.querySelector('[data-nav="'+view+'"]').classList.add('active');}
 lockControls();
};
document.getElementById('app').addEventListener('input',e=>{if(e.target.dataset.systemField){const d=systemDrafts[e.target.dataset.systemId];if(d)d[e.target.dataset.systemField]=e.target.value;}});
document.getElementById('app').addEventListener('change',e=>{if(e.target.dataset.systemField){const d=systemDrafts[e.target.dataset.systemId];if(d)d[e.target.dataset.systemField]=e.target.value;}});
// Root capture runs before older inquiry handlers, avoiding attachment-scope confusion.
document.addEventListener('click',async e=>{
 const b=e.target.closest?.('button');if(!b||!document.getElementById('app').contains(b))return;
 if(b.dataset.view==='account'&&cloud.permissions.admin){e.stopImmediatePropagation();const alreadyOpen=view==='account';closeEducationDetail();if(!alreadyOpen){view='account';render();}document.getElementById('enrolLearner')?.scrollIntoView({block:'center',behavior:'smooth'});document.getElementById('enrolLearner')?.focus({preventScroll:true});toast(alreadyOpen?'현재 배정 설정 화면이에요. 입력을 확인한 뒤 교육 배정 저장을 눌러 주세요.':'교육 배정 설정을 열었어요. 교육생·담당자와 시작일을 확인한 뒤 저장하세요.');}
 else if(b.dataset.homeRole){e.stopImmediatePropagation();const role=b.dataset.homeRole;if(!availableHomeRoles().includes(role))return;roleHomePreference=role;try{localStorage.setItem('momos-onboarding-home-role:'+cloud.user.id,role);}catch{}if(role==='learner'&&cloud.target!==cloud.user.id)await refreshCloud(cloud.user.id);view='home';render();}
 else if(b.dataset.rolePerson){e.stopImmediatePropagation();await refreshCloud(b.dataset.rolePerson);if(cloud.target!==b.dataset.rolePerson)return;if(b.dataset.roleLesson)openEducationDetail('lesson',b.dataset.roleLesson);else{view=b.dataset.roleDestination;render();window.scrollTo({top:0,behavior:'smooth'});}}
 else if(b.dataset.saveAccess){e.stopImmediatePropagation();const id=b.dataset.saveAccess,reason=document.getElementById('accessReason-'+id).value;if(!reason.trim()){toast('접근 변경 사유를 입력하세요.');return;}await act('config.access',{user:id,allowed:document.getElementById('accessAllowed-'+id).value==='yes',reason});}
 else if(b.dataset.systemList){e.stopImmediatePropagation();if(!['pending','applied'].includes(b.dataset.systemList))return;systemReviewList=b.dataset.systemList;render();}
 else if(b.dataset.saveSystem){e.stopImmediatePropagation();const id=b.dataset.saveSystem,d=systemDrafts[id];for(const [field,prefix] of [['status','systemStatus-'],['comment','systemComment-'],['source','systemSource-']])d[field]=document.getElementById(prefix+id).value;if(!d.comment.trim()){toast('확인 내용·다음 조치를 입력하세요.');return;}if(['resolved','applied'].includes(d.status)&&!d.source.trim()){toast('자료 또는 반영 위치와 확인 판본을 입력하세요.');return;}if(await act('system.review',{id,...d})){delete systemDrafts[id];render();toast(d.status==='applied'?'반영 완료로 저장했어요. 처리 필요 건수에서 제외되며 반영 완료 이력에서 확인할 수 있어요.':'수정 요청의 처리 기록을 서버에 저장했습니다.');}}
 else if(b.dataset.removeAttachment&&b.dataset.attachmentScope?.startsWith('system:')){e.stopImmediatePropagation();const d=systemDrafts[b.dataset.attachmentScope.slice(7)];d.attachments=d.attachments.filter(i=>i!==b.dataset.removeAttachment);render();}
},true);

let itemIncomingApplied=false;
const priorItemCloud=applyCloud;
applyCloud=function(c){
 priorItemCloud(c);
 if(itemIncomingApplied)return;
 itemIncomingApplied=true;
 const params=new URLSearchParams(location.search),step=params.get('step'),test=params.get('test');
 if(step&&findStep(step))openEducationDetail('lesson',step);
 else if(test&&TEST_DEFS.some(t=>t.id===test))openEducationDetail('test',test);
 else if(step||test)toast('항목을 찾지 못했습니다. 교육 목록에서 다시 확인하세요.');
};
const priorItemRender=render;
render=function(){
 priorItemRender();
 if(!cloud)return;
 if(view==='lesson'&&!educationDetail)WorkspaceItems.mount(document.getElementById('app'),{room:'onboarding',kind:'step',id:selected,person:cloud.target},{summaryOnly:true,openHistory:()=>openEducationDetail('education-history',selected)});
 WorkspaceItems.overview(document.getElementById('app'),{room:'onboarding',person:cloud.target},target=>openEducationDetail(target.kind==='step'?'lesson':'test',target.id));
};
