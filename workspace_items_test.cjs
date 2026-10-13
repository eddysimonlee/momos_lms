const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/workspace_items.js','utf8');
const target={room:'erp',kind:'task',id:'task 1 / 한글',person:''};
function harness(){
 const widgets=new Map(),calls=[],responses=[],session=new Map();
 const widget=key=>{if(!widgets.has(key))widgets.set(key,{value:'',textContent:'',hidden:false,disabled:false,dataset:{},setAttribute(){},matches:()=>false});return widgets.get(key);};
 const panel={
  isConnected:true,dataset:{},querySelector:selector=>widget(selector),
  querySelectorAll:selector=>{
   if(selector==='[data-item-input]')return ['text','reason','resolver','resolution'].map(k=>{const w=widget('[data-item-input="'+k+'"]');w.dataset.itemInput=k;return w;});
   if(selector==='[data-item-save]')return ['comment','block','resolve'].map(k=>{const w=widget('[data-item-save="'+k+'"]');w.dataset.itemSave=k;return w;});
   if(selector==='button,textarea,select')return [...widgets.values()];
   return [];
  }
 };
 const content=widget('[data-item-content]');content.querySelector=panel.querySelector;content.querySelectorAll=panel.querySelectorAll;
 const host={querySelector:()=>null,append(){},isConnected:true};
 const context={
  window:{},URL,URLSearchParams,location:{origin:'https://workspace.example.test'},
  ERPAuth:{user:{id:'user-1'},csrfToken:'test-csrf'},
  crypto:{randomUUID:()=>require('node:crypto').randomUUID()},
  sessionStorage:{getItem:k=>session.get(k),setItem:(k,v)=>session.set(k,v)},
  document:{createElement:()=>panel,addEventListener(){},dispatchEvent(){}},CustomEvent:class{},
  navigator:{clipboard:{writeText:async()=>{}}},
  fetch:async(url,options={})=>{calls.push({url,options,body:options.body&&JSON.parse(options.body)});const next=responses.shift();if(next instanceof Error)throw next;return {ok:next.status===200,status:next.status,json:async()=>next.body};},
 };
 vm.runInNewContext(source,context);
 const data=(revision=0,acceptedRequests=[])=>({target,canWrite:true,people:[{id:'user-1',name:'격리 담당'}],revision,comments:[],history:[],blocker:null,acceptedRequests});
 const next=(status,body)=>responses.push({status,body});
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const mount=async()=>{next(200,data());context.window.WorkspaceItems.mount(host,target);await tick();};
 const write=async text=>{const w=widget('[data-item-input="text"]');w.value=text;w.oninput();};
 const click=async selector=>{await widget(selector).onclick();await tick();};
 return {context,widgets,calls,next,data,tick,mount,write,click,responses};
}
test('shared links preserve room/item/learner and encode IDs safely',()=>{
 const h=harness(),build=h.context.window.WorkspaceItems.url;
 const t=new URL(build(target));assert.equal(t.searchParams.get('task'),target.id);assert.equal(t.searchParams.get('room'),'erp');
 const p=new URL(build({room:'abc',kind:'case',id:'pi-1',person:''}));assert.equal(p.searchParams.get('case'),'pi-1');
 const e=new URL(build({room:'onboarding',kind:'step',id:'making-kds',person:'learner-1'}));assert.equal(e.pathname,'/onboarding');assert.equal(e.searchParams.get('learner'),'learner-1');assert.equal(e.searchParams.get('step'),'making-kds');
});
test('validation 400 permits corrected content with new request identity',async()=>{
 const h=harness();await h.mount();await h.write('invalid');h.next(400,{error:'입력 확인'});
 await h.click('[data-item-save="comment"]');const first=h.calls.at(-1).body;
 await h.write('corrected');h.next(200,h.data(1));await h.click('[data-item-save="comment"]');
 const second=h.calls.at(-1).body;assert.notEqual(second.requestId,first.requestId);assert.equal(second.text,'corrected');
});
test('401 and network failure preserve exact pending payload for retry',async()=>{
 for(const failure of [{status:401,body:{error:'login'}},new Error('transport')]){
  const h=harness();await h.mount();await h.write('pending');h.responses.push(failure);
  await h.click('[data-item-save="comment"]');const first=h.calls.at(-1).body;
  assert.equal(h.widgets.get('[data-item-save="comment"]').disabled,true);
  h.next(200,h.data(1,[first.requestId]));await h.click('[data-item-retry]');
  assert.deepEqual(h.calls.at(-1).body,first);
 }
});
test('409 refresh keeps draft and sends new payload with fresh revision',async()=>{
 const h=harness();await h.mount();await h.write('my draft');h.next(409,{error:'conflict'});await h.click('[data-item-save="comment"]');
 const old=h.calls.at(-1).body;h.next(200,h.data(3));await h.click('[data-item-refresh]');
 h.next(200,h.data(4));await h.click('[data-item-save="comment"]');
 const fresh=h.calls.at(-1).body;assert.equal(fresh.text,'my draft');assert.equal(fresh.revision,3);assert.notEqual(fresh.requestId,old.requestId);
});
test('lost response then GET reconciliation cannot create duplicate comment',async()=>{
 const h=harness();await h.mount();await h.write('already committed');h.responses.push(new Error('response lost'));await h.click('[data-item-save="comment"]');
 const old=h.calls.at(-1).body;h.next(200,h.data(1,[old.requestId]));await h.click('[data-item-refresh]');
 h.next(200,h.data(2));await h.click('[data-item-save="comment"]');
 assert.equal(h.calls.at(-1).body.text,'');
});
test('failed GET leaves pending payload retryable',async()=>{
 const h=harness();await h.mount();await h.write('pending');h.next(401,{error:'login'});await h.click('[data-item-save="comment"]');
 const old=h.calls.at(-1).body;h.responses.push(new Error('get failed'));await h.click('[data-item-refresh]');
 h.next(200,h.data(1,[old.requestId]));await h.click('[data-item-retry]');assert.deepEqual(h.calls.at(-1).body,old);
});
