'use strict';
/* Authentication UI deliberately loads without seed or project data. */
(() => {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const passwordRule='10자 이상 · 영문 대문자·숫자·특수문자 각각 1개 이상';
  const validPassword=value=>value.length>=10&&value.length<=256&&/[A-Z]/.test(value)&&/[0-9]/.test(value)&&/[^\p{L}\p{N}_\s]/u.test(value);
  const roleNames = {admin:'관리자',lead:'업무 책임자',member:'수행자',viewer:'열람자'};
  const allowedAdminNames = ['고성운','최상민','채수민'];
  let companyNames = {momos:'모모스커피',viewcs:'뷰시에스'};
  function setCompanies(items){if(items)companyNames={...items,momos:'모모스커피'};}
  const statusNames = {active:'이용 중',pending:'승인 대기',revoked:'이용 중지'};
  let waiting, resolveReady, setupRequired = false, currentMode = 'login';
  const gate = document.getElementById('authGate');
  const accountDialog = document.getElementById('accountDialog');
  const Auth = {user:null,csrfToken:null,ensureSession,logout,manageUsers,openAccount,manageInvitations,manageResetRequests,editMember,issueResetLink};
  window.ERPAuth = Auth;

  async function request(path, body, method) {
    const response = await fetch(path, {method:method || (body === undefined?'GET':'POST'),credentials:'same-origin',cache:'no-store',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(Auth.csrfToken?{'X-CSRF-Token':Auth.csrfToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    let data;
    try { data = await response.json(); } catch { throw new Error('로그인 서버의 응답을 확인할 수 없습니다. 서버를 다시 실행해 주세요.'); }
    if (!response.ok) { const error = new Error(data.error || data.message || '요청을 처리하지 못했습니다.'); error.status=response.status; throw error; }
    return data;
  }
  function layout(content) {
    gate.innerHTML = `<div class="auth-layout"><div class="auth-story"><div class="brand"><img class="momos-logo" src="assets/momos-white.png" alt="MOMOS COFFEE"><span>PROJECT WORKSPACE</span></div><h1>프로젝트의 다음 일을,<br>같은 화면에서.</h1><p>계획과 실제 진행을 연결하고<br>놓친 업무와 필요한 결정을 확인합니다.</p><div class="auth-steps"><span><i>1</i> 프로젝트에서 이번 주 할 일 확인</span><span><i>2</i> 결과와 근거를 한 번만 기록</span><span><i>3</i> 미결과 다음 약속을 함께 확인</span></div><footer>모모스커피 · 프로젝트 워크스페이스</footer></div><div class="auth-content">${content}</div></div>`;
  }
  function errorBox(message) { const box = gate.querySelector('[data-auth-error]'); if(box){box.textContent=message;box.hidden=false;} }
  function formField(label,name,type,attrs='') { return `<label class="field"><span>${label}</span><input name="${name}" type="${type}" ${attrs}></label>`; }
  function renderForm(mode='login',message='') {
    currentMode=mode;
    const signup=mode==='signup', setup=mode==='setup';
    const title=setup?'첫 관리자 계정 만들기':signup?'회원가입 신청':'워크스페이스 로그인';
    const intro=setup?'업무 기록을 관리할 본인 계정을 등록해 주세요. 이후 참여자는 가입 신청 또는 관리자 초대로 참여합니다.':signup?'초대 없이 신청할 수 있습니다. 고성운·최상민·채수민 관리자가 본인과 소속을 확인하고 승인하면 로그인할 수 있습니다.':'ERP·업무혁신·매장 교육은 같은 계정으로 이용합니다. 로그인 후 접근 가능한 프로젝트를 선택하거나, 열고 있던 화면으로 바로 이동합니다.';
    let fields='';
    if(setup) fields += formField('PC 운영자가 설정한 초기 등록 키','bootstrapToken','password','minlength="32" autocomplete="off" required')+'<label class="field"><span>관리자 이름</span><select name="name" required><option value="">본인 이름을 선택해 주세요</option><option>고성운</option><option>최상민</option><option>채수민</option></select></label>';
    if(signup) fields += formField('이름','name','text','autocomplete="name" maxlength="60" required');
    if(signup) fields += `<div class="form-grid"><label class="field"><span>소속</span><select name="company" required>${selectOptions(companyNames,'momos')}</select></label><label class="field"><span>부서 · 선택</span><input name="department" autocomplete="organization-title" maxlength="80"></label></div>`;
    fields += formField('업무 이메일','email','email','autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" maxlength="254" required');
    fields += formField('비밀번호','password','password',`autocomplete="${setup||signup?'new-password':'current-password'}" ${setup||signup?'minlength="10"':''} maxlength="256" required`);
    if(setup||signup) fields += `<p class="auth-form-note">${passwordRule}</p>${formField('비밀번호 확인','confirmPassword','password','autocomplete="new-password" minlength="10" maxlength="256" required')}`;
    layout(`${signup?'<button class="auth-back" type="button" data-auth-back>← 로그인으로</button>':''}<div class="eyebrow">${setup?'GET STARTED':signup?'JOIN WORKSPACE':'WELCOME BACK'}</div><h2>${title}</h2><p class="auth-intro">${intro}</p>${message?`<div class="auth-success" role="status">${escapeHtml(message)}</div>`:''}<form id="authForm">${fields}<div class="auth-error" data-auth-error hidden role="alert"></div><button class="primary auth-submit" type="submit">${setup?'관리자 계정 만들고 시작하기':signup?'가입 승인 요청':'로그인'}</button></form>${!signup&&!setup?'<div class="auth-switch">계정이 없다면 관리자에게 초대를 요청해 주세요.</div>':''}<p class="auth-note">${setup?'현재 PC의 프로젝트 기록에 접근할 계정입니다. 이메일 인증·비밀번호 재설정 메일은 연결 전입니다.':signup?'가입 신청만으로 관리자 권한이나 프로젝트 자료 접근이 허용되지 않습니다.':Auth.runtime==='cloud'?'전사 공용 워크스페이스입니다. 업무와 첨부는 서버에 저장됩니다. 메일·푸시 연결 상태는 로그인 후 설정에서 확인하세요.':'현재는 이 PC에서 사용합니다. 외부 접속과 모바일 푸시는 연결·설정에서 준비 상태를 확인할 수 있습니다.'}</p>`);
    const signupLink=gate.querySelector('.auth-switch');
    if(signupLink)signupLink.innerHTML='<div class="auth-account-links"><button type="button" data-auth-signup>회원가입 신청</button><button type="button" data-auth-forgot>비밀번호 찾기</button></div><p class="auth-form-note">관리자 승인 후 이용할 수 있습니다. 받은 초대 링크로도 가입할 수 있습니다.</p>';
    gate.querySelector('[data-auth-back]')?.addEventListener('click',()=>renderForm('login'));
    gate.querySelector('[data-auth-signup]')?.addEventListener('click',()=>renderForm('signup'));
    gate.querySelector('[data-auth-forgot]')?.addEventListener('click',renderForgot);
    gate.querySelector('form').addEventListener('submit',submitForm);
    const logo=gate.querySelector('.brand');if(logo)logo.innerHTML='<img class="momos-logo" src="assets/momos-white.png" alt="MOMOS COFFEE"><span>PROJECT WORKSPACE</span>';
  }
  async function submitForm(event) {
    event.preventDefault();
    const form=event.currentTarget, values=Object.fromEntries(new FormData(form)), button=form.querySelector('button[type=submit]');
    if((currentMode==='setup'||currentMode==='signup')&&values.password!==values.confirmPassword){errorBox('비밀번호와 확인 입력이 다릅니다.');return;}
    if((currentMode==='setup'||currentMode==='signup')&&!validPassword(values.password)){errorBox(passwordRule);return;}
    delete values.confirmPassword;
    button.disabled=true;gate.querySelector('[data-auth-error]').hidden=true;
    try {
      const result=await request('/api/auth/'+currentMode,values);
      if(currentMode==='signup') {renderForm('login','가입 신청을 보냈습니다. 관리자 승인 후 로그인해 주세요.');return;}
      if(!result.user)throw new Error('계정 확인을 완료하지 못했습니다. 다시 로그인해 주세요.');
      activate(result);
    } catch(error) {errorBox(error.message);}
    finally {button.disabled=false;}
  }
  function activate(result) {
    Auth.runtime=result.runtime||Auth.runtime||'local';
    Auth.user=result.user;Auth.csrfToken=result.csrfToken;
    document.getElementById('accountName').textContent=result.user.name;
    document.getElementById('accountInitial').textContent=result.user.name?.slice(0,1)||'M';
    document.querySelectorAll('[data-auth-manage]').forEach(el=>el.hidden=result.user.role!=='admin');
    gate.hidden=true;document.body.classList.remove('auth-pending');
    const shell=document.getElementById('appShell');shell.inert=false;shell.removeAttribute('aria-hidden');
    if(document.body.hasAttribute('data-onboarding')) {
      const profile=document.getElementById('profileButton');
      if(profile) {
        profile.title='내 계정';profile.onclick=openAccount;
        if(!document.getElementById('educationProjectHome')) {
          const projects=document.createElement('a');projects.id='educationProjectHome';projects.className='button';projects.href='/?room=home';projects.textContent='프로젝트 목록';
          profile.before(projects);
        }
        if(!document.getElementById('educationLogout')) {
          const button=document.createElement('button');button.id='educationLogout';button.type='button';button.textContent='로그아웃';button.onclick=logout;
          profile.after(button);
        }
      }
    }
    resolveReady?.(result.user);
    const entry=new URL(location.href);
    if(entry.searchParams.get('admin')==='signups'&&result.user.role==='admin'){
      entry.searchParams.delete('admin');history.replaceState(null,'',entry.pathname+entry.search+entry.hash);
      setTimeout(manageUsers,0);
    }
    if('serviceWorker' in navigator && location.protocol!=='file:') navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{});
  }
  async function checkStatus() {
    try {
      if(!/^https?:$/.test(location.protocol)) {layout('<h2>로컬 서버로 열어 주세요</h2><p class="auth-intro">프로젝트 폴더의 <b>ERP_웹앱_실행.cmd</b>를 실행하면 로그인과 저장 기능을 사용할 수 있습니다.</p><p>파일을 직접 여는 방식에서는 업무 기록에 접근하지 않습니다.</p>');return;}
      const result=await request('/api/auth/status');setCompanies(result.companies);Auth.runtime=result.runtime||'local';setupRequired=!!result.setupRequired;
      if(location.hash.startsWith('#account-reset=')){await renderPasswordSetup(location.hash.slice('#account-reset='.length));return;}
      if(location.hash.startsWith('#invite=')){await renderInvitation(location.hash.slice(8));return;}
      if(setupRequired&&!result.setupAllowed){layout('<h2>첫 관리자 등록 준비</h2><p>PC 운영자가 초기 등록 키를 설정한 뒤 관리자 계정을 만들 수 있습니다. 기존 계정이 있던 PC라면 원래 저장 폴더로 서버를 실행해 주세요.</p>');return;}
      if(result.user)activate(result);else renderForm(setupRequired?'setup':'login');
    } catch(error) {
      layout(`<div class="eyebrow">CONNECTION</div><h2>서버 연결을 확인해 주세요</h2><p class="auth-intro">${escapeHtml(error.message)}</p><button class="primary" data-auth-retry>다시 연결</button><p class="auth-note">프로젝트 폴더의 ERP_웹앱_실행.cmd로 서버를 시작할 수 있습니다.</p>`);
      gate.querySelector('[data-auth-retry]').onclick=checkStatus;
    }
  }
  function ensureSession() {
    if(Auth.user)return Promise.resolve(Auth.user);
    if(!waiting){waiting=new Promise(resolve=>resolveReady=resolve);checkStatus();}
    return waiting;
  }
  function dialog(title,body,footer='') {
    accountDialog.oncancel=null;
    accountDialog.innerHTML=`<div class="dialog-head"><div><div class="eyebrow">WORKSPACE ACCOUNT</div><h2>${escapeHtml(title)}</h2></div><button data-account-close aria-label="닫기">✕</button></div><div class="dialog-body">${body}<div class="auth-error" data-account-error role="alert" hidden></div></div><div class="dialog-footer"><button data-account-close>닫기</button>${footer}</div>`;
    accountDialog.querySelectorAll('[data-account-close]').forEach(button=>button.onclick=()=>accountDialog.close());
    if(!accountDialog.open)accountDialog.showModal();
  }
  function accountError(error){const box=accountDialog.querySelector('[data-account-error]');if(box){box.textContent=error.message||error;box.hidden=false;}}
  function openAccount() {
    const user=Auth.user;if(!user)return;
    accountDialog.classList.add('account-dialog-small');
    dialog('내 계정',`<div class="account-detail"><span class="account-avatar">${escapeHtml(user.name.slice(0,1))}</span><div><b>${escapeHtml(user.name)}</b><p class="small muted">${escapeHtml(user.email)}</p><p class="small">${escapeHtml(companyNames[user.company]||user.company)} · ${escapeHtml(roleNames[user.role]||user.role)}</p></div></div><div class="account-actions">${user.role==='admin'?'<button data-account-users>가입 승인·권한 관리</button>':''}<button data-account-install>홈 화면 설치 안내</button><button data-account-logout class="danger">로그아웃</button></div><p class="auth-note">기록에는 로그인한 계정의 이름이 남습니다. 계정 권한은 관리자가 승인하고 회수합니다.</p>`);
    accountDialog.querySelector('[data-account-users]')?.addEventListener('click',manageUsers);
    if(user.role==='admin'){const link=document.createElement('a');link.className='button';link.href='/?room=admin';link.textContent='워크스페이스 관리';accountDialog.querySelector('.account-actions').prepend(link);}
    if(user.role==='admin'){const button=document.createElement('button');button.textContent='참여자 초대';button.onclick=manageInvitations;accountDialog.querySelector('.account-actions').prepend(button);}
    const projectSettings=document.querySelector('#piSettings, #roomSettings');
    if(new URLSearchParams(location.search).get('room')!=='admin'&&(projectSettings||new URLSearchParams(location.search).get('room')==='erp')){
      const settings=document.createElement('button');settings.textContent=projectSettings?'프로젝트 설정':'연결·설정';
      settings.onclick=()=>{accountDialog.close();if(projectSettings)projectSettings.click();else navigateWorkspace('settings');};
      accountDialog.querySelector('.account-actions').append(settings);
    }
    accountDialog.querySelector('[data-account-install]').onclick=installationHelp;
    accountDialog.querySelector('[data-account-logout]').onclick=logout;
  }
  function installationHelp(){
    const installed=matchMedia('(display-mode: standalone)').matches||navigator.standalone;
    dialog('홈 화면에서 열기',`${installed?'<div class="notice success">홈 화면 앱으로 실행 중입니다.</div>':'<p>공유 가능한 HTTPS 주소로 배포한 뒤 아이폰에서 홈 화면에 추가할 수 있습니다.</p>'}<ol><li>아이폰 Safari에서 배포된 웹앱 주소를 엽니다.</li><li>공유 버튼에서 <b>홈 화면에 추가</b>를 선택합니다.</li><li>MOMOS ERP 아이콘을 누르고 로그인합니다.</li></ol><p class="notice">현재 127.0.0.1 주소는 이 PC에서만 열립니다. 아이폰의 같은 주소로는 이 PC에 접속할 수 없습니다.</p><h3>업무 알림</h3><p class="small muted">현재는 앱 안의 알림을 사용합니다. 홈 화면 설치만으로 푸시 알림이 켜지지 않으며, 외부 서버 연결과 알림 구독을 추가로 설정해야 합니다.</p>`);
  }
  async function logout() {
    try {await request('/api/auth/logout',{});Auth.user=null;Auth.csrfToken=null;document.getElementById('view')?.replaceChildren();const shell=document.getElementById('appShell');if(shell){shell.inert=true;shell.setAttribute('aria-hidden','true');}accountDialog?.close();document.body.classList.add('auth-pending');location.reload();}
    catch(error){if(!accountDialog?.open)openAccount();accountError(error);}
  }
  function selectOptions(items,value){return Object.entries(items).map(([id,label])=>`<option value="${escapeHtml(id)}" ${id===value?'selected':''}>${escapeHtml(label)}</option>`).join('');}
  async function editMember(id, onSaved) {
    if(Auth.user?.role!=='admin')return;
    accountDialog.classList.remove('account-dialog-small');
    dialog('구성원 수정','<p role="status">구성원 정보를 불러오고 있습니다.</p>');
    try {
      const data=await request('/api/auth/users/'+encodeURIComponent(id));setCompanies(data.companies);
      const u=data.user,p=data.profile||{},text=(label,name,value='',type='text',extra='')=>`<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${escapeHtml(value)}" ${extra}></label>`;
      const options=allowedAdminNames.includes(u.name)?roleNames:Object.fromEntries(Object.entries(roleNames).filter(([key])=>key!=='admin'));
      const date=at=>new Date(at*1000).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});
      dialog('구성원 수정',`<div class="member-editor"><div class="member-summary"><span class="account-avatar">${escapeHtml(u.name.slice(0,1))}</span><div><h3>${escapeHtml(u.name)}</h3><p>${escapeHtml(u.email)}</p></div><span class="pill ${u.status==='active'?'green':'gray'}">${escapeHtml(statusNames[u.status])}</span></div><form id="memberEditForm"><section class="member-section"><h3>기본 정보</h3><div class="form-grid">${text('이름', 'identityName',u.name,'text','readonly aria-describedby="memberIdentityNote"')}${text('닉네임 · 선택','profile.nickname',p.nickname,'text','maxlength="60"')}${text('로그인 ID · 업무 이메일','email',u.email,'email','required maxlength="254" autocomplete="off"')}<label class="field"><span>소속 · 필수</span><select name="company" required>${selectOptions(companyNames,u.company)}</select></label></div><p class="small muted" id="memberIdentityNote">이름은 기존 업무 배정·이력과 연결되어 고정합니다. 닉네임은 구성원 정보에 별도로 보관합니다. WORKS 구성원 정보와 자동 동기화되지 않습니다.</p><label class="checkline" id="memberEmailConfirm" hidden><input type="checkbox" name="confirmEmailChange">새 이메일의 계정 소유자를 확인했습니다. 변경하면 이전 로그인은 종료되며 새 이메일로 로그인합니다.</label></section><section class="member-section"><h3>조직 · 근무 정보</h3><div class="form-grid">${text('부서','department',u.department,'text','maxlength="100"')}${text('직책','title',u.title,'text','maxlength="100"')}${text('입사일 · 선택','profile.joinedOn',p.joinedOn,'date')}${text('사원 번호 · 선택','profile.employeeNo',p.employeeNo,'text','maxlength="40"')}${text('근무처 · 선택','profile.workplace',p.workplace,'text','maxlength="100"')}</div><label class="field"><span>담당 업무 · 선택</span><textarea name="profile.responsibilities" rows="3" maxlength="1000">${escapeHtml(p.responsibilities||'')}</textarea></label><p class="small muted">구성원 입사일은 인사 정보입니다. 교육 시작일·개인 WBS 일정은 ‘계정 · 교육 배정’에서 별도로 관리합니다.</p></section><section class="member-section"><h3>연락처 · 관리자만 조회</h3><div class="form-grid">${text('사내번호 · 선택','profile.workPhone',p.workPhone,'tel','maxlength="40"')}${text('휴대폰 · 선택','profile.mobile',p.mobile,'tel','maxlength="40"')}</div></section><section class="member-section"><h3>접근 권한</h3><div class="form-grid"><label class="field"><span>워크스페이스 역할</span><select name="role">${selectOptions(options,u.role)}</select></label><label class="field"><span>이용 상태</span><select name="status">${selectOptions(statusNames,u.status)}</select></label></div><p class="small muted">개별 프로젝트·교육자·평가자 배정과는 별도입니다. 권한·소속·이용 상태가 바뀌면 이전 로그인을 종료합니다. 이용을 중지해도 기록은 남습니다.</p></section></form><section class="member-section member-password"><div><h3>비밀번호 재설정</h3><p class="small muted">최근 설정 ${escapeHtml(date(data.passwordChangedAt))}${data.resetRequestedAt?'<br><strong>재설정 요청 접수 · '+escapeHtml(date(data.resetRequestedAt))+'</strong>':''}</p><p class="small muted">직원이 일회용 링크에서 새 비밀번호를 직접 설정합니다. 기존 비밀번호는 조회할 수 없습니다.<br>${data.recoveryEmailConnected?'비밀번호 찾기 안내 메일이 연결되어 있습니다.':'현재 비밀번호 찾기는 관리자에게 요청을 접수합니다. 자동 안내 메일은 연결 전입니다.'}</p></div><button type="button" id="memberReset" ${u.status!=='active'?'disabled':''}>재설정 링크 발급</button></section><p class="member-save-status" role="status"></p></div>`, '<button class="primary" id="saveMember" type="submit" form="memberEditForm">변경 사항 저장</button>');
      const form=accountDialog.querySelector('#memberEditForm'),button=accountDialog.querySelector('#saveMember');let busy=false;
      const emailChanged=()=>form.elements.email.value.trim().toLowerCase()!==u.email;
      form.elements.email.oninput=()=>{accountDialog.querySelector('#memberEmailConfirm').hidden=!emailChanged();form.elements.confirmEmailChange.checked=false;};
      accountDialog.oncancel=event=>{if(busy)event.preventDefault();};
      const close=()=>{if(!busy)accountDialog.close();};accountDialog.querySelectorAll('[data-account-close]').forEach(b=>b.onclick=close);
      accountDialog.querySelector('.dialog-footer [data-account-close]').textContent='취소';
      accountDialog.querySelector('#memberReset').onclick=()=>issueResetLink(u.email,()=>editMember(id,onSaved));
      form.onsubmit=async event=>{
        event.preventDefault();if(busy)return;
        if(emailChanged()&&!form.elements.confirmEmailChange.checked){accountError('새 이메일의 계정 소유자 확인을 체크해 주세요.');return;}
        const values=Object.fromEntries(new FormData(form)),profile={};for(const key of Object.keys(values)){if(key.startsWith('profile.')){profile[key.slice(8)]=values[key];delete values[key];}}delete values.identityName;delete values.confirmEmailChange;
        if(values.status==='revoked'&&u.status!=='revoked'&&!confirm(u.name+'님의 이용을 중지할까요? 기존 기록은 남습니다.'))return;
        busy=true;accountDialog.querySelector('[data-account-error]').hidden=true;const disabledBefore=new Map([...accountDialog.querySelectorAll('button,input,select,textarea')].map(el=>[el,el.disabled]));accountDialog.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=true);button.textContent='저장 중…';
        try{
          const result=await request('/api/auth/users/'+encodeURIComponent(id),{...values,profile});
          const securityChanged=['email','role','company','status'].some(k=>result.user[k]!==u[k]);
          if(id===Auth.user.id){if(securityChanged){location.reload();return;}Auth.user=result.user;}
          busy=false;accountDialog.close();
          if(onSaved){try{await onSaved(result.user);}catch{dialog('구성원 정보 저장 완료','<p>저장은 완료했습니다. 목록은 새로고침으로 다시 확인해 주세요.</p>');}}
          else {await editMember(id);const status=accountDialog.querySelector('.member-save-status');if(status)status.textContent='변경 사항을 저장했습니다.';}
        }catch(error){accountError(error);}finally{busy=false;button.textContent='변경 사항 저장';if(accountDialog.contains(form))disabledBefore.forEach((disabled,el)=>el.disabled=disabled);}
      };
    }catch(error){accountError(error);}
  }
  function issueResetLink(email, returnTo) {
    if(Auth.user?.role!=='admin')return;
    accountDialog.classList.remove('account-dialog-small');
    dialog('비밀번호 재설정',`<p><b>${escapeHtml(email)}</b></p><p>본인에게 전달할 일회용 링크를 발급합니다. 링크는 1시간 동안 유효하며 PC·휴대폰에서 한 번 사용할 수 있습니다.</p><label class="checkline"><input type="checkbox" id="resetIdentityChecked">등록된 이메일의 실제 계정 소유자인지 확인했습니다.</label><p class="small muted">새 링크를 발급하면 이전 재설정 링크는 만료됩니다. 직원이 새 비밀번호를 저장할 때 기존 로그인이 종료됩니다.</p>`, `${returnTo?'<button id="resetReturn">← 구성원으로</button>':''}<button class="primary" id="issueResetLink" disabled>일회용 링크 발급</button>`);
    accountDialog.oncancel=null;let busy=false;
    const check=accountDialog.querySelector('#resetIdentityChecked'),button=accountDialog.querySelector('#issueResetLink');check.onchange=()=>button.disabled=!check.checked;
    accountDialog.querySelector('#resetReturn')?.addEventListener('click',()=>{if(!busy)returnTo();});
    accountDialog.oncancel=event=>{if(busy)event.preventDefault();};
    accountDialog.querySelectorAll('[data-account-close]').forEach(b=>b.onclick=()=>{if(!busy)accountDialog.close();});
    button.onclick=async()=>{if(busy||!check.checked)return;busy=true;button.disabled=true;check.disabled=true;try{
      const data=await request('/api/auth/reset-link',{email,identityConfirmed:check.checked});
      dialog('일회용 재설정 링크',`<p>${escapeHtml(data.message)}</p><label class="field"><span>본인에게만 전달할 링크</span><textarea id="issuedResetLink" readonly rows="4">${escapeHtml(data.link)}</textarea></label><p class="small muted">직원이 링크를 열어 새 비밀번호를 저장한 뒤 다른 기기에서도 같은 이메일과 새 비밀번호로 로그인할 수 있습니다.</p><p id="resetCopyStatus" role="status"></p>`,`${returnTo?'<button id="resetReturn">← 구성원으로</button>':''}<button class="primary" id="copyResetLink">링크 복사</button>`);
      accountDialog.oncancel=null;accountDialog.querySelector('#resetReturn')?.addEventListener('click',returnTo);
      accountDialog.querySelector('#copyResetLink').onclick=async()=>{try{await navigator.clipboard.writeText(data.link);accountDialog.querySelector('#resetCopyStatus').textContent='복사했습니다. 확인한 계정 소유자에게만 전달해 주세요.';}catch{accountDialog.querySelector('#issuedResetLink').select();accountDialog.querySelector('#resetCopyStatus').textContent='링크를 선택했습니다. 직접 복사해 주세요.';}};
    }catch(error){accountError(error);button.disabled=!check.checked;check.disabled=false;}finally{busy=false;}};
  }
  async function manageUsers() {
    if(Auth.user?.role!=='admin')return;
    accountDialog.classList.remove('account-dialog-small');
    dialog('가입 승인·권한 관리','<p role="status">가입 신청을 확인하고 있습니다.</p>');
    try {
      const data=await request('/api/auth/users');setCompanies(data.companies);
      if(!accountDialog.open)return;
      const users=[...(data.users||[])].sort((a,b)=>(a.status==='pending'?-1:0)-(b.status==='pending'?-1:0)||a.name.localeCompare(b.name,'ko'));
      const pending=users.filter(user=>user.status==='pending').length;
      dialog('가입 승인·권한 관리',`<p class="muted small">가입 대기 ${pending}명 · 전체 ${users.length}명. 소속과 역할을 확인한 뒤 이용을 승인해 주세요.</p><div class="notice">신청자의 이메일과 소속을 확인한 뒤 승인해 주세요. 관리자 권한은 모모스커피의 고성운·최상민·채수민에게만 부여할 수 있습니다. 이름만 같다고 승인하지 않습니다.</div>${users.map(user=>`<form class="user-access-row" data-user-id="${escapeHtml(user.id)}"><div class="split"><b>${escapeHtml(user.name)}</b><span class="pill ${user.status==='pending'?'amber':user.status==='active'?'green':'gray'}">${escapeHtml(statusNames[user.status]||user.status)}</span>${user.id===Auth.user.id?'<span class="pill blue">내 계정</span>':''}</div><p class="small muted">${escapeHtml(user.email)}${user.department?' · '+escapeHtml(user.department):''}</p><button type="button" data-member-edit="${escapeHtml(user.id)}">구성원 정보 · 비밀번호</button><div class="form-grid"><label class="field"><span>소속</span><select name="company">${selectOptions(companyNames,user.company)}</select></label><label class="field"><span>역할</span><select name="role">${selectOptions(allowedAdminNames.includes(user.name)?roleNames:Object.fromEntries(Object.entries(roleNames).filter(([role])=>role!=='admin')),user.role)}</select></label></div><div class="split"><button class="primary" type="submit" name="status" value="active">${user.status==='pending'?'가입 승인':user.status==='revoked'?'이용 재개':'권한 저장'}</button>${user.id!==Auth.user.id&&user.status!=='revoked'?`<button class="danger" type="submit" name="status" value="revoked">${user.status==='pending'?'신청 거절':'이용 중지'}</button>`:''}</div></form>`).join('')||'<div class="empty">가입 신청이 없습니다.</div>'}`);
      if(data.signupMail){
        const mail=data.signupMail,box=document.createElement('details');box.className='signup-mail-status';
        const names={queued:'발송 대기',sent:'발송 완료',sending:'전송 중',failed:'발송 실패',unknown:'수신 확인 필요',suppressed:'발송 취소'};
        box.innerHTML=`<summary>가입 신청 이메일 알림 · ${mail.config.canSend?'사용 중':'연결 필요'}</summary><p>${escapeHtml(mail.config.message)}</p><p class="small">수신 관리자: ${mail.recipients.map(u=>escapeHtml(u.name+' · '+u.email)).join(' / ')||'승인된 관리자 없음'}</p>${mail.items.length?`<ul>${mail.items.map(r=>`<li>${escapeHtml(r.applicant)} → ${escapeHtml(r.recipient)} · ${escapeHtml(names[r.status]||r.status)}<small> ${escapeHtml(r.error||'')}</small></li>`).join('')}</ul>`:'<p class="small muted">아직 가입 알림 발송 기록이 없습니다.</p>'}`;
        accountDialog.querySelector('.dialog-body').prepend(box);
      }
      accountDialog.querySelectorAll('[data-user-id]').forEach(form=>form.onsubmit=async event=>{
        event.preventDefault();const values=Object.fromEntries(new FormData(form));values.status=event.submitter?.value||'active';
        if(values.role==='admin'&&values.company!=='momos'){accountError('관리자는 모모스커피 소속으로 지정해 주세요.');return;}
        const buttons=[...form.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);
        try {await request('/api/auth/users/'+encodeURIComponent(form.dataset.userId),values);if(form.dataset.userId===Auth.user.id){const result=await request('/api/auth/status');if(result.user?.role!=='admin'){location.reload();return;}Auth.user=result.user;Auth.csrfToken=result.csrfToken;}await manageUsers();}
        catch(error){accountError(error);buttons.forEach(button=>button.disabled=false);}
      });
      accountDialog.querySelectorAll('[data-member-edit]').forEach(b=>b.onclick=()=>editMember(b.dataset.memberEdit,manageUsers));
      const resets=document.createElement('button');resets.textContent='비밀번호 재설정 요청';resets.onclick=manageResetRequests;accountDialog.querySelector('.dialog-footer').append(resets);
      const invite=document.createElement('button');invite.className='primary';invite.textContent='참여자 초대';invite.onclick=manageInvitations;accountDialog.querySelector('.dialog-footer').append(invite);
    }catch(error){accountError(error);}
  }
  function renderForgot(){
    layout(`<button class="auth-back" type="button" data-auth-back>← 로그인으로</button><div class="eyebrow">ACCOUNT RECOVERY</div><h2>비밀번호 찾기</h2><p class="auth-intro">가입할 때 사용한 업무 이메일을 입력해 주세요. 기존 비밀번호를 보여주는 대신 새 비밀번호를 설정합니다.</p><form>${formField('업무 이메일','email','email','autocomplete="username" required maxlength="254"')}<div class="auth-error" data-auth-error hidden role="alert"></div><button class="primary auth-submit" type="submit">재설정 안내 요청</button></form><div data-reset-result role="status"></div>`);
    gate.querySelector('[data-auth-back]').onclick=()=>renderForm('login');
    gate.querySelector('form').onsubmit=async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;try{const data=await request('/api/auth/forgot-password',Object.fromEntries(new FormData(event.currentTarget)));const box=gate.querySelector('[data-reset-result]');box.className='auth-success';box.textContent=data.message;}catch(e){errorBox(e.message);}finally{button.disabled=false;}};
  }
  async function manageResetRequests(){
    try{
      const data=await request('/api/auth/reset-requests');
      dialog('비밀번호 재설정 요청',`<p>등록된 이메일의 본인인지 확인한 뒤 일회용 링크를 발급하세요.</p>${data.items.filter(r=>r.status==='pending').map(r=>`<div class="source"><b>${escapeHtml(r.name)}</b><p>${escapeHtml(r.email)}</p><small>${escapeHtml(new Date(r.requested_at*1000).toLocaleString('ko-KR'))}</small><p><button data-reset-email="${escapeHtml(r.email)}">본인 확인 후 링크 발급</button></p></div>`).join('')||'<p>대기 중인 재설정 요청이 없습니다.</p>'}`);
      accountDialog.querySelectorAll('[data-reset-email]').forEach(button=>button.onclick=()=>issueResetLink(button.dataset.resetEmail,manageResetRequests));
    }catch(e){accountError(e);}
  }
  async function renderPasswordSetup(token){
    try{
      const {account:a}=await request('/api/auth/recovery-info',{token});
      layout(`<div class="eyebrow">ACCOUNT RECOVERY</div><h2>비밀번호 재설정</h2><p class="auth-intro">${escapeHtml(a.name)}님의 계정입니다. 사용할 비밀번호를 직접 설정해 주세요.</p><form id="passwordSetupForm">${formField('아이디 · 업무 이메일','email','email',`value="${escapeHtml(a.email)}" readonly autocomplete="username" required`)}${formField('새 비밀번호','password','password','minlength="10" maxlength="256" autocomplete="new-password" required')}${formField('비밀번호 확인','confirmPassword','password','minlength="10" maxlength="256" autocomplete="new-password" required')}<p class="auth-form-note">${passwordRule}</p><div class="auth-error" data-auth-error hidden role="alert"></div><button class="primary auth-submit" type="submit">비밀번호 저장하고 시작하기</button></form><p class="auth-note">기존 업무와 계정 권한을 유지합니다. 저장하면 이전 비밀번호와 다른 로그인 세션은 사용할 수 없습니다.</p><p class="auth-note">PC·휴대폰에서 한 번 사용할 수 있는 설정 링크입니다.<br>유효시간: ${escapeHtml(new Date(a.expiresAt*1000).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))}까지</p>`);
      gate.querySelector('form').onsubmit=async event=>{
        event.preventDefault();const form=event.currentTarget,values=Object.fromEntries(new FormData(form)),button=form.querySelector('button');
        if(values.password!==values.confirmPassword){errorBox('비밀번호와 확인 입력이 다릅니다.');return;}
        if(!validPassword(values.password)){errorBox(passwordRule);return;}
        button.disabled=true;gate.querySelector('[data-auth-error]').hidden=true;
        try{const result=await request('/api/auth/reset-password',{token,email:values.email,password:values.password});form.reset();token='';history.replaceState(null,'',location.pathname+location.search+'#overview');activate(result);}
        catch(error){errorBox(error.message);}finally{button.disabled=false;}
      };
    }catch(error){layout(`<h2>설정 링크를 확인해 주세요</h2><p>${escapeHtml(error.message)}</p><p class="auth-note">관리자에게 새 설정 링크를 요청해 주세요. 일반 가입으로 기존 계정을 대신할 수는 없습니다.</p><a class="button" href="/">로그인으로</a>`);}
  }
  async function renderInvitation(token){
    try{
      const {invitation:i}=await request('/api/auth/invite-info',{token});
      layout(`<div class="eyebrow">INVITATION</div><h2>${escapeHtml(i.name)}님, 초대받으셨습니다</h2><p>${escapeHtml(companyNames[i.company])} · ${escapeHtml(roleNames[i.role])}</p><form id="inviteAcceptForm">${formField('초대받은 이메일','email','email',`value="${escapeHtml(i.email)}" readonly required`)}${formField('새 비밀번호','password','password','minlength="10" maxlength="256" autocomplete="new-password" required')}${formField('비밀번호 확인','confirmPassword','password','minlength="10" autocomplete="new-password" required')}<div class="auth-error" data-auth-error hidden role="alert"></div><button class="primary auth-submit">가입하고 시작하기</button></form><p class="auth-note">초대에 지정된 소속과 역할로 가입합니다. 비밀번호는 ${passwordRule}</p>`);
      gate.querySelector('form').onsubmit=async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));if(values.password!==values.confirmPassword)return errorBox('비밀번호 확인이 다릅니다.');if(!validPassword(values.password))return errorBox(passwordRule);const b=e.target.querySelector('button');b.disabled=true;try{const r=await request('/api/auth/accept-invite',{token,email:values.email,password:values.password});history.replaceState(null,'','#work');activate(r);}catch(err){errorBox(err.message);}finally{b.disabled=false;}};
    }catch(error){layout(`<h2>초대를 확인해 주세요</h2><p>${escapeHtml(error.message)}</p><a href="/">로그인으로</a>`);}
  }
  async function manageInvitations(){
    if(Auth.user?.role!=='admin')return;
    dialog('참여자 초대','<p>초대 상태를 불러오고 있습니다.</p>');
    try{
      const data=await request('/api/auth/invitations');setCompanies(data.companies);if(!accountDialog.open)return;
      const names={pending:'가입 대기',accepted:'가입 완료',cancelled:'취소',expired:'만료'};
      dialog('참여자 초대',`<p class="notice">${escapeHtml(data.config.message)}</p><form id="createInvitation"><div class="form-grid">${formField('이름','name','text','maxlength="60" required')}${formField('업무 이메일','email','email','maxlength="254" required')}<div class="field"><label for="invitationCompany">소속</label><select id="invitationCompany" name="company">${selectOptions(companyNames,'momos')}</select><small class="muted">모모스커피는 고정 소속입니다.</small><button type="button" id="showCompanyAdd">＋ 소속 추가</button><div id="companyAdd" hidden><label class="field"><span>새 소속 이름</span><input id="newCompanyName" type="text" maxlength="60" autocomplete="organization"></label><div class="split"><button type="button" id="saveCompanyAdd">소속 저장</button><button type="button" id="cancelCompanyAdd">취소</button></div><p id="companyAddStatus" class="small" role="status"></p></div></div><label class="field"><span>역할</span><select name="role">${selectOptions(roleNames,'member')}</select></label>${formField('부서 · 선택','department','text','maxlength="100"')}</div><label class="checkline"><input name="sendEmail" type="checkbox" ${data.config.canSend?'':'disabled'}>초대 메일 보내기${data.config.canSend?'':data.config.publicUrlReady?' · 발신 계정 연결 필요':' · 운영 초대 주소 설정 필요'}</label><button class="primary" type="submit">초대 만들기</button></form><div id="invitationResult" aria-live="polite"></div><h3>초대 이력</h3>${data.items.map(i=>`<div class="list-row"><div class="row-body"><b>${escapeHtml(i.name)}</b> · ${escapeHtml(i.email)}<p>${escapeHtml(companyNames[i.company])} · ${escapeHtml(roleNames[i.role])} · ${escapeHtml(names[i.status])}</p><p>메일 ${i.delivery==='sent'?'발송됨':i.delivery==='failed'?'발송 실패':'미발송'} · 만료 ${new Date(i.expires_at*1000).toLocaleString('ko-KR')}</p></div>${i.status!=='accepted'?`<button data-reinvite="${i.id}">재발급</button>`:''}${i.status==='pending'?`<button data-cancel-invite="${i.id}">취소</button>`:''}</div>`).join('')||'<p class="muted">아직 만든 초대가 없습니다.</p>'}`);
      const invitationForm=accountDialog.querySelector('#createInvitation');
      const companyAdd=accountDialog.querySelector('#companyAdd'),companyInput=accountDialog.querySelector('#newCompanyName'),companyStatus=accountDialog.querySelector('#companyAddStatus');
      accountDialog.querySelector('#showCompanyAdd').onclick=()=>{companyAdd.hidden=false;companyInput.focus();};
      accountDialog.querySelector('#cancelCompanyAdd').onclick=()=>{companyAdd.hidden=true;companyStatus.textContent='';};
      const saveCompanyButton=accountDialog.querySelector('#saveCompanyAdd');
      saveCompanyButton.onclick=async()=>{
        const name=companyInput.value.trim();if(!name){companyStatus.textContent='추가할 소속 이름을 입력해 주세요.';return;}
        saveCompanyButton.disabled=true;companyStatus.textContent='소속을 저장하고 있습니다.';
        try{const result=await request('/api/auth/companies',{name});setCompanies(result.companies);const select=invitationForm.elements.company;select.innerHTML=selectOptions(companyNames,result.company);select.value=result.company;select.dispatchEvent(new Event('change',{bubbles:true}));companyAdd.hidden=true;companyInput.value='';companyStatus.textContent='';}
        catch(error){companyStatus.textContent=error.message;}finally{saveCompanyButton.disabled=false;}
      };
      companyInput.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();saveCompanyButton.click();}};

      const syncInvitationRole=()=>{
        const name=invitationForm.elements.name.value.trim(),company=invitationForm.elements.company.value;
        const role=invitationForm.elements.role,option=role.querySelector('option[value="admin"]');
        option.disabled=company!=='momos'||!allowedAdminNames.includes(name);
        if(option.disabled&&role.value==='admin')role.value='member';
      };
      invitationForm.elements.name.addEventListener('input',syncInvitationRole);
      invitationForm.elements.company.addEventListener('change',syncInvitationRole);
      syncInvitationRole();
      const showResult=r=>{const box=accountDialog.querySelector('#invitationResult');box.innerHTML=`<p class="notice">${escapeHtml(r.message)}</p><label class="field"><span>초대 링크 · 72시간 / 한 번만 사용</span><input id="invitationLink" value="${escapeHtml(r.link)}" readonly></label><button id="copyInvite">링크 복사</button><button id="reloadInvites">초대 이력 확인</button>`;box.querySelector('#copyInvite').onclick=async()=>{try{await navigator.clipboard.writeText(r.link);box.querySelector('#copyInvite').textContent='복사됨';}catch{box.querySelector('input').select();}};box.querySelector('#reloadInvites').onclick=manageInvitations;};
      accountDialog.querySelector('#createInvitation').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button[type=submit]');b.disabled=true;const v=Object.fromEntries(new FormData(e.target));v.sendEmail=v.sendEmail==='on';try{showResult(await request('/api/auth/invitations',v));}catch(err){accountError(err);}finally{b.disabled=false;}};
      accountDialog.querySelectorAll('[data-cancel-invite]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await request('/api/auth/invitations/'+b.dataset.cancelInvite+'/cancel',{});await manageInvitations();}catch(err){accountError(err);b.disabled=false;}});
      accountDialog.querySelectorAll('[data-reinvite]').forEach(b=>b.onclick=async()=>{const i=data.items.find(x=>x.id===b.dataset.reinvite);b.disabled=true;try{showResult(await request('/api/auth/invitations',{email:i.email,name:i.name,company:i.company,role:i.role,department:i.department,sendEmail:false}));}catch(err){accountError(err);}finally{b.disabled=false;}});
    }catch(error){accountError(error);}
  }
  document.querySelectorAll('[data-auth-account]').forEach(button=>button.addEventListener('click',openAccount));
  document.querySelectorAll('[data-auth-manage]').forEach(button=>button.addEventListener('click',manageUsers));
})();

