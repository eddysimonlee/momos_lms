'use strict';
// Shared collaboration never edits the host item's status, schedule or completion.
window.WorkspaceItems = (() => {
 const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const drafts = new Map();
 const when = value => new Date(value).toLocaleString('ko-KR', {timeZone:'Asia/Seoul'});
 const storageKey = target => 'momos-item-draft:' + ERPAuth.user.id + ':' + JSON.stringify(target);
 const url = target => {
  const result = new URL(target.room === 'onboarding' ? '/onboarding' : '/', location.origin);
  if(target.room === 'onboarding') {
   result.searchParams.set('learner', target.person);
   result.searchParams.set(target.kind, target.id);
  } else {
   result.searchParams.set('room', target.room);
   result.searchParams.set(target.kind === 'case' ? 'case' : 'task', target.id);
   if(target.room === 'erp')result.hash = 'work';
  }
  return result.href;
 };
 async function api(target, value) {
  const query = new URLSearchParams(target);
  const response = await fetch('/api/item-collaboration' + (value ? '' : '?' + query), {
   method:value?'POST':'GET', credentials:'same-origin', cache:'no-store',
   headers:{'Content-Type':'application/json','X-CSRF-Token':ERPAuth.csrfToken || ''},
   ...(value?{body:JSON.stringify(value)}:{})
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('서버 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.'); }
  if(!response.ok) { const error = new Error(data.error || '협업 기록을 확인하지 못했습니다.');error.status=response.status;throw error; }
  return data;
 }
 function draftFor(target) {
  const key=storageKey(target);
  if(!drafts.has(key)) {
   let stored={};try{stored=JSON.parse(sessionStorage.getItem(key)||'{}');}catch{}
   drafts.set(key,{text:stored.text||'',reason:stored.reason||'',resolver:stored.resolver||'',resolution:stored.resolution||'',pending:stored.pending||null,mode:['talk','block','history'].includes(stored.mode)?stored.mode:'talk'});
  }
  return drafts.get(key);
 }
 function persist(target,draft) {
  try{sessionStorage.setItem(storageKey(target),JSON.stringify(draft));}catch{}
 }
 function mount(host,target,options={}) {
  if(!host || !ERPAuth.user)return;
  const old=host.querySelector('[data-item-collaboration]');if(old)old.remove();
  if(options.summaryOnly){
   const notice=document.createElement('aside');notice.dataset.itemCollaboration='true';notice.className='notice warning';notice.hidden=true;host.append(notice);
   api(target).then(data=>{
    if(!notice.isConnected||!data.blocker)return;
    notice.hidden=false;notice.innerHTML='<strong>진행 중 확인이 필요해요</strong><p>'+escape(data.blocker.reason)+'</p><button type="button">교육 이력에서 확인</button>';
    notice.querySelector('button').onclick=options.openHistory;
   }).catch(()=>{if(!notice.isConnected)return;notice.hidden=false;notice.innerHTML='<p>현재 진행 문제를 확인하지 못했습니다.</p><button type="button">교육 이력에서 다시 확인</button>';notice.querySelector('button').onclick=options.openHistory;});
   return notice;
  }
  const panel=document.createElement('section');panel.className='item-collaboration';panel.dataset.itemCollaboration='true';
  const panelId='item-'+crypto.randomUUID();
  panel.innerHTML='<header><div><p class="item-eyebrow">이 항목에서 함께 확인</p><h3>협업</h3></div><button type="button" data-item-copy>링크 복사</button></header><div class="item-tabs" role="tablist" aria-label="항목 협업">'+[['talk','대화'],['block','진행 문제'],['history','이력']].map(([mode,title])=>'<button type="button" role="tab" id="'+panelId+'-'+mode+'" aria-controls="'+panelId+'-pane-'+mode+'" data-item-mode="'+mode+'">'+title+'</button>').join('')+'</div><div data-item-content><p class="small muted">협업 기록을 불러오고 있습니다.</p></div><p class="item-message" role="status" aria-live="polite"></p>';
  host.append(panel);
  const draft=draftFor(target);let data=null,busy=false;
  const content=panel.querySelector('[data-item-content]');
  const modes=['talk','block','history'];
  function choose(mode){
   draft.mode=mode;persist(target,draft);
   panel.querySelectorAll('[data-item-mode]').forEach(button=>{const selected=button.dataset.itemMode===mode;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
   content.querySelectorAll('[data-item-pane]').forEach(pane=>pane.hidden=pane.dataset.itemPane!==mode);
  }
  panel.querySelectorAll('[data-item-mode]').forEach(button=>{
   button.onclick=()=>choose(button.dataset.itemMode);
   button.onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const index=modes.indexOf(draft.mode),mode=modes[event.key==='Home'?0:event.key==='End'?2:(index+(event.key==='ArrowLeft'?2:1))%3];
    choose(mode);panel.querySelector('[data-item-mode="'+mode+'"]').focus();
   };
  });
  const pane=mode=>'<section role="tabpanel" id="'+panelId+'-pane-'+mode+'" aria-labelledby="'+panelId+'-'+mode+'" data-item-pane="'+mode+'">';
  function accept(value) {
   draft.pending=null;
   if(value.action==='comment')draft.text='';
   else if(value.action==='block'){draft.reason='';draft.resolver='';}
   else draft.resolution='';
   persist(target,draft);
  }
  const message=(text,error=false)=>{const el=panel.querySelector('.item-message');el.textContent=text;el.dataset.error=String(error);};
  panel.querySelector('[data-item-copy]').onclick=async()=>{
   const link=url(target);
   try { await navigator.clipboard.writeText(link);message('이 항목의 링크를 복사했습니다. 접근 권한이 있는 구성원이 열 수 있습니다.'); }
   catch { const box=document.createElement('input');box.type='text';box.value=link;box.readOnly=true;box.setAttribute('aria-label','복사할 항목 링크');panel.querySelector('header').after(box);box.focus();box.select();message('표시된 링크를 길게 눌러 복사하세요.'); }
  };
  function paint() {
   const content=panel.querySelector('[data-item-content]');
   const b=data.blocker,people=data.people;
   panel.querySelector('[data-item-mode="talk"]').textContent='대화 '+data.comments.length;
   panel.querySelector('[data-item-mode="block"]').textContent=b?'진행 문제 1':'진행 문제';
   panel.querySelector('[data-item-mode="history"]').textContent='이력 '+data.history.length;
   content.innerHTML=(b?'<aside class="item-blocked"><strong>진행이 막혀 있어요</strong><p>'+escape(b.reason)+'</p><small>해결 담당: '+escape(people.find(p=>p.id===b.resolver)?.name||b.resolverName)+' · 등록 '+escape(when(b.at))+'</small></aside>':'')+
    pane('talk')+'<p class="small muted">질문과 피드백은 이 항목에 남습니다. 교육·시험·성과의 완료는 각 화면의 확인 절차를 따릅니다.</p>'+
    (options.help?'<button type="button" data-item-help>기술·내용 문의 / 파일 첨부</button>':'')+
    '<div class="item-discussion">'+(data.comments.length?data.comments.slice().reverse().map(c=>'<article><small>'+escape(c.actor)+' · '+escape(when(c.at))+'</small><p>'+escape(c.text)+'</p></article>').join(''):'<p class="small muted">아직 협업 기록이 없습니다.</p>')+'</div>'+
    (data.canWrite?'<label class="field"><span>질문 또는 진행 경과</span><textarea rows="3" maxlength="4000" data-item-input="text" placeholder="어려운 점, 확인할 내용, 전달할 피드백">'+escape(draft.text)+'</textarea></label><div class="item-actions"><button type="button" class="primary" data-item-save="comment">기록 남기기</button></div>':'<p class="small muted">'+(people.length?'이 계정은 협업 기록을 조회할 수 있습니다.':'교육 배정 후 담당 교육생·교육자와 협업 기록을 남길 수 있습니다.')+'</p>')+'</section>'+pane('block')+
    (data.canWrite?'<div class="item-block-editor"><p class="small muted">'+(b?'막힌 이유·담당자를 수정하거나 해결 내용을 남기세요.':'진행이 막혔을 때 이유와 해결 담당자를 남기세요.')+'</p><label class="field"><span>막힌 이유</span><textarea rows="2" maxlength="4000" data-item-input="reason">'+escape(draft.reason)+'</textarea></label><label class="field"><span>해결 담당자</span><select data-item-input="resolver"><option value="">담당자를 선택하세요</option>'+people.map(p=>'<option value="'+escape(p.id)+'" '+(p.id===(draft.resolver||b?.resolver)?'selected':'')+'>'+escape(p.name)+'</option>').join('')+'</select></label><button type="button" data-item-save="block">막힌 이유·담당자 저장</button>'+
     (b?'<label class="field"><span>어떻게 해결했나요?</span><textarea rows="2" maxlength="4000" data-item-input="resolution">'+escape(draft.resolution)+'</textarea></label><button type="button" data-item-save="resolve">진행 장애 해결</button>':'')+'<p class="small muted">이 기록은 항목의 진행률·완료 상태나 담당 배정을 변경하지 않습니다.</p></div>':'<p class="small muted">'+(b?'현재 진행 문제는 위 안내에서 확인하세요.':'등록된 진행 문제가 없습니다.')+'</p>')+'</section>'+pane('history')+
    '<div class="item-events">'+(data.history.length?data.history.slice().reverse().map(h=>'<p><strong>'+escape({comment:'기록 추가',block:'진행 장애 등록·변경',resolve:'진행 장애 해결'}[h.action])+'</strong> · '+escape(h.actor)+' · '+escape(when(h.at))+'<br>'+escape(h.text)+'</p>').join(''):'<p class="small muted">아직 협업 변경 이력이 없습니다.</p>')+'</div></section><div class="item-actions"><button type="button" data-item-refresh>최신 협업 기록 확인</button>'+(draft.pending?'<button type="button" data-item-retry>같은 요청 다시 저장</button>':'')+'</div>';
   content.querySelectorAll('[data-item-input]').forEach(input=>input.oninput=()=>{
    draft[input.dataset.itemInput]=input.value;persist(target,draft);
   });
   content.querySelectorAll('[data-item-save]').forEach(button=>button.onclick=()=>save(button.dataset.itemSave));
   content.querySelector('[data-item-refresh]').onclick=refresh;
   const retry=content.querySelector('[data-item-retry]');if(retry)retry.onclick=()=>save(null,true);
   const help=content.querySelector('[data-item-help]');if(help)help.onclick=options.help;
   choose(draft.mode);setBusy(busy);
  }
  function setBusy(value) {
   busy=value;
   panel.querySelectorAll('button,textarea,select').forEach(el=>{if(!el.matches('[data-item-copy]'))el.disabled=value;});
   if(draft.pending)panel.querySelectorAll('[data-item-save]').forEach(el=>el.disabled=true);
  }
  async function refresh() {
   if(busy)return;setBusy(true);
   try { const fresh=await api(target);if(!panel.isConnected)return;data=fresh;
    const committed=draft.pending&&data.acceptedRequests.includes(draft.pending.requestId);
    if(committed)accept(draft.pending);else{draft.pending=null;persist(target,draft);}
    paint();message(committed?'이전 요청이 이미 저장된 것을 확인했습니다. 중복 기록을 만들지 않았습니다.':'최신 협업 기록을 확인했습니다. 작성 중인 내용은 유지했습니다.'); }
   catch(error){message(error.message,true);}
   finally{setBusy(false);}
  }
  async function save(action,retry=false) {
   if(busy || (!retry&&draft.pending))return;
   if(!data?.canWrite)return;
   const value=retry?draft.pending:{
    target,action,revision:data.revision,requestId:crypto.randomUUID(),
    text:action==='comment'?draft.text:action==='block'?draft.reason:draft.resolution,
    ...(action==='block'?{resolver:panel.querySelector('[data-item-input="resolver"]').value}:{})
   };
   if(!value)return;
   draft.pending=value;persist(target,draft);
   setBusy(true);
   try {
    const result=await api(target,value);
    data=result;accept(value);
    if(panel.isConnected){paint();message(value.action==='resolve'?'진행 장애를 해결했습니다. 항목 완료는 별도로 확인하세요.':'이 항목에 협업 기록을 저장했습니다.');}
    options.changed?.();
    document.dispatchEvent(new CustomEvent('workspace-item-change',{detail:target}));
   } catch(error) {
    // Validation rejection is certain: corrected fields use a new request.
    draft.pending=[400,403,404,422].includes(error.status)?null:value;
    persist(target,draft);
    if(panel.isConnected){paint();message(error.status===409?'다른 기록이 먼저 저장되었습니다. 최신 협업 기록을 확인한 뒤 작성 내용을 다시 저장하세요.':error.status===401?'로그인 상태를 확인한 뒤 같은 요청을 다시 저장하세요. 작성 내용은 유지했습니다.':error.message,true);}
   } finally {setBusy(false);}
  }
  api(target).then(result=>{
   if(!panel.isConnected)return;data=result;
   if(draft.pending&&data.acceptedRequests.includes(draft.pending.requestId))accept(draft.pending);
   if(draft.pending)draft.mode=draft.pending.action==='comment'?'talk':'block';
   paint();
  }).catch(error=>{
   if(!panel.isConnected)return;panel.querySelector('[data-item-content]').innerHTML='<p class="small muted">링크 공유는 현재 접근 권한을 유지합니다.</p><button type="button" data-item-load-retry>협업 기록 다시 확인</button>';panel.querySelector('[data-item-load-retry]').onclick=refresh;message(error.message,true);
  });
  return panel;
 }
 const overviewTargets=new Map();
 document.addEventListener('workspace-item-change',event=>{
  for(const [host,entry] of overviewTargets){
   if(!host.isConnected){overviewTargets.delete(host);continue;}
   if(entry.scope.room===event.detail.room&&entry.scope.person===event.detail.person)overview(host,entry.scope,entry.open);
  }
 });
 async function overview(host,scope,open) {
  if(!host||!ERPAuth.user)return;
  overviewTargets.set(host,{scope,open});
  host.querySelector('[data-item-overview]')?.remove();
  const panel=document.createElement('aside');panel.className='item-overview';panel.dataset.itemOverview='true';panel.hidden=true;host.prepend(panel);
  try {
   const response=await fetch('/api/item-collaboration?'+new URLSearchParams(scope),{credentials:'same-origin',cache:'no-store'});
   if(!response.ok)throw new Error();
   const data=await response.json();if(!panel.isConnected)return;
   panel.hidden=!data.items.length;
   panel.innerHTML='<strong>진행이 막힌 항목 · '+data.items.length+'개</strong><p class="small muted">해결 담당자와 확인할 내용을 먼저 살펴보세요.</p>'+data.items.map((item,i)=>'<button type="button" data-blocked-item="'+i+'">'+escape(item.title)+'<small>'+escape(item.blocker.reason)+' · 해결 담당 '+escape(item.blocker.resolverName)+'</small></button>').join('');
   panel.querySelectorAll('button').forEach(b=>b.onclick=()=>open(data.items[Number(b.dataset.blockedItem)].target));
  } catch {if(panel.isConnected){panel.hidden=false;panel.textContent='진행 장애 목록을 확인하지 못했습니다. 기존 업무·교육 기록은 유지됩니다.';}}
 }
 return {mount,overview,url};
})();
