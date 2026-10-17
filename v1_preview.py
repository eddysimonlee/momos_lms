"""v1 화면 미리보기 HTML 한 장 만들기 — 서버·로그인·VPN 없이 글만 확인할 때.

    python3 v1_preview.py            → v1_preview.html 생성 (브라우저로 열기)

v1_lessons.json(교육 목적·교육 내용·인용)과 v1_content.json(절·사진)을 읽어
실제 /v1 과 같은 스타일(v1.html의 CSS + WDS 토큰)로 6개 항목을 그린다.
체크·요청·저장 같은 서버 기능은 없고, 글과 배치만 본다.
v1_lessons.json 을 고친 뒤 이 스크립트를 다시 돌리면 바로 반영된다.
"""
import base64
import json
import re
from pathlib import Path

APP = Path(__file__).parent


def main():
    content = json.loads((APP / 'v1_content.json').read_text(encoding='utf-8'))
    lessons = json.loads((APP / 'v1_lessons.json').read_text(encoding='utf-8')).get('lessons', {})
    for unit in content['units']:
        for step in unit['steps']:
            l = lessons.get(step['id'])
            if not l:
                continue
            if l.get('title'): step['title'] = l['title']
            step['purpose'] = l.get('purpose', step.get('purpose', ''))
            step['keyPoints'] = [dict(text=k['text'], cites=['|'.join(c) for c in k.get('cites', [])]) for k in l.get('keyPoints', [])]
            step['sources'] = ['|'.join(c) for c in l.get('sources', [])]
    # 사진은 data URI 로 심어 파일 하나로 만든다
    for p in content.get('photos', {}).values():
        src = p.get('src', '')
        if src.startswith('data:') or not src:
            continue
        f = APP / src.lstrip('/')
        if f.exists():
            p['src'] = 'data:image/' + f.suffix.lstrip('.').replace('jpg', 'jpeg') + ';base64,' + base64.b64encode(f.read_bytes()).decode()
    v1 = (APP / 'v1.html').read_text(encoding='utf-8')
    style = re.search(r'<style>(.*?)</style>', v1, re.S).group(1)
    wds = (APP / 'wds/web/variables.css').read_text(encoding='utf-8')
    font = APP / 'assets/PretendardVariable.woff2'
    font_css = ''
    if font.exists():
        font_css = ("@font-face{font-family:'Pretendard';font-weight:45 920;src:url(data:font/woff2;base64,%s) format('woff2')}"
                    "html,body,button,input,textarea{font-family:Pretendard,-apple-system,BlinkMacSystemFont,sans-serif}") % base64.b64encode(font.read_bytes()).decode()
    data = json.dumps(content, ensure_ascii=False).replace('</', '<\\/')
    html = TEMPLATE.replace('/*WDS*/', wds).replace('/*V1*/', style).replace('/*FONT*/', font_css).replace('/*DATA*/', 'const content=' + data + ';')
    (APP / 'v1_preview.html').write_text(html, encoding='utf-8')
    print('v1_preview.html:', sum(len(u['steps']) for u in content['units']), 'steps —', (APP / 'v1_preview.html').resolve())


TEMPLATE = r'''<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>v1 미리보기 · 입사·근무 준비</title>
<style>/*FONT*/</style>
<style>/*WDS*/</style>
<style>/*V1*/</style>
<style>
body{margin:0;background:var(--surface-secondary,#f4f5f7)}
.pv-bar{position:sticky;top:0;z-index:5;background:#FFF4CC;color:#5A4A00;font:var(--label-sm);padding:6px 16px;text-align:center}
.pv-frame{max-width:430px;margin:0 auto;min-height:100vh;background:var(--surface-default,#fff);box-shadow:0 0 0 1px var(--border-default)}
</style></head>
<body>
<div class="pv-bar">미리보기 · 글과 배치만 확인 (체크·저장 안 됨)</div>
<div class="pv-frame">
  <header class="v1-top"><button id="v1Back" class="v1-back" aria-label="뒤로" hidden>‹</button><h1 id="v1Title">입사·근무 준비</h1><span class="v1-who">미리보기</span></header>
  <main id="app" class="v1-main"></main>
</div>
<script>
/*DATA*/
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const br=s=>esc(s).replace(/\n/g,'<br>');
const unit=content.units[0], steps=unit.steps;
let view=location.hash.slice(1)||'home';
function srcLabel(key){const sec=content.sections[key],doc=sec&&content.documents[sec.doc];return sec?`${doc?doc.title:''} ${sec.no} ${sec.title}`.trim():key}
const table=t=>`<div class="table-wrap"><table><thead><tr>${t.header.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map(r=>r.length===1&&t.header.length>1?`<tr><td class="v1-grp" colspan="${t.header.length}">${esc(r[0])}</td></tr>`:`<tr>${r.map(c=>`<td>${br(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
function home(){return `<section class="v1-card"><h2>${esc(unit.title)}</h2><div class="v1-muted">${esc(unit.summary)} · 교육 시작 후 ${unit.plan[0]}~${unit.plan[1]}일차</div><div class="v1-progress"><i style="width:0%"></i></div><div class="v1-muted">0/${steps.length} 완료</div></section><ul class="v1-list">${steps.map((s,i)=>`<li><button class="v1-item ready" data-step="${esc(s.id)}"><span class="v1-num">${i+1}</span><span class="v1-body"><strong>${esc(s.title)}</strong><small>시작 전 · 확인 0/${s.checks.length}</small></span><span class="v1-chev">›</span></button></li>`).join('')}</ul><p class="v1-src">원본 색인 ${esc((content.sourceIndexedAt||'').slice(0,10))} · 교육안 ${esc(content.courseVersion)} · 미리보기</p>`}
function step(s){const i=steps.indexOf(s),next=steps[i+1];
 const purpose=s.purpose?`<p class="v1-purpose">${br(s.purpose)}</p>`:`<div class="v1-copy">${(s.copy||[]).map(p=>`<p>${esc(p)}</p>`).join('')}</div>`;
 const photos=(s.photos||[]).map(p=>content.photos[p]).filter(Boolean).map(p=>`<figure class="v1-photo"><img src="${p.src}" alt="${esc(p.caption)}"><figcaption>${esc(p.caption)}</figcaption></figure>`).join('');
 const cite=k=>`<button type="button" class="v1-cite" data-cite="${esc(k)}">${esc(srcLabel(k))}</button>`;
 const kp=s.keyPoints&&s.keyPoints.length?`<ol class="v1-kp">${s.keyPoints.map(k=>`<li><div>${br(k.text)}</div><div class="v1-cites">${k.cites.map(cite).join('')}</div></li>`).join('')}</ol>`:`<div class="v1-copy">${(s.copy||[]).map(p=>`<p>${esc(p)}</p>`).join('')}</div>`;
 const checks=`<ul class="v1-checks">${s.checks.map((c,k)=>`<li><label><input type="checkbox" data-self="${k}"><span class="v1-box"></span><span>${esc(c)}</span></label></li>`).join('')}</ul>`;
 const sources=(s.sources||[]).map(key=>{const sec=content.sections[key];if(!sec)return `<div class="v1-note warn">색인에 없는 절: ${esc(key)} — v1_build.py 를 다시 돌려야 합니다</div>`;const doc=content.documents[sec.doc]||{};
  return `<details class="v1-guide" id="src-${esc(key).replace(/[^0-9A-Za-z.-]/g,'_')}"><summary><span>${esc(doc.title||'')} <b>${esc(sec.no)} ${esc(sec.title)}</b></span><span class="v1-tag">${esc(doc.type||'')} ${esc(doc.version||'')}</span></summary><div class="v1-guide-body"><p class="v1-src">${esc(doc.title||'')} · ${esc(doc.type||'')} ${esc(doc.version||'')} (${esc(doc.revised||'')}) · ${esc(sec.kind)}${sec.images?` · 사진 ${sec.images}장은 원본 파일에서`:''}</p>${sec.paragraphs.map(p=>`<p>${esc(p)}</p>`).join('')}${sec.tables.map(table).join('')}<p class="v1-src">파일: ${esc(doc.file||'')}</p></div></details>`}).join('');
 return `<section class="v1-card"><span class="v1-pill ready">시작 전</span> <span class="v1-muted">${i+1}/${steps.length} · 미리보기</span><h2 style="margin-top:var(--spacing-12)">교육 목적</h2>${purpose}${photos}${s.note?`<div class="v1-note warn">${esc(s.note)}</div>`:''}</section>`+
  `<section class="v1-card"><h2>교육 내용</h2>${kp}</section>`+
  `<section class="v1-card"><h2>수행 확인</h2><div class="v1-muted">직접 해 보고 하나씩 체크하세요. 다 체크하면 담당자에게 확인을 요청할 수 있어요.</div>${checks}</section>`+
  `<section class="v1-card"><h2>메모</h2><div class="v1-muted">어려웠던 점, 담당자에게 확인할 내용</div><textarea class="v1-memo" placeholder="적어 두면 담당자가 확인할 때 함께 봅니다"></textarea></section>`+
  (sources?`<section class="v1-card"><h2>원본 보기</h2><div class="v1-muted">이 항목이 인용한 매뉴얼의 절. 문서 전체는 Works Drive의 원본 파일에서 봅니다.</div><div class="v1-sources">${sources}</div></section>`:'')+
  `<div class="v1-actions"><button class="v1-btn primary" disabled>담당자 확인 요청</button>${next?`<button class="v1-btn" data-step="${esc(next.id)}">다음 항목 ›</button>`:''}</div>`}
function render(){const s=steps.find(x=>x.id===view);$('app').innerHTML=s?step(s):home();$('v1Title').textContent=s?s.title:unit.title;$('v1Back').hidden=!s;try{history.replaceState(null,'','#'+(s?s.id:''))}catch(e){}
 document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{view=b.dataset.step;render();scrollTo(0,0)});
 document.querySelectorAll('[data-cite]').forEach(b=>b.onclick=()=>{const el=document.getElementById('src-'+b.dataset.cite.replace(/[^0-9A-Za-z.-]/g,'_'));if(!el)return;el.open=true;el.scrollIntoView({behavior:'smooth',block:'start'});el.classList.add('flash');setTimeout(()=>el.classList.remove('flash'),1600)});}
$('v1Back').onclick=()=>{view='home';render()};
render();
</script></body></html>'''


if __name__ == '__main__':
    main()
