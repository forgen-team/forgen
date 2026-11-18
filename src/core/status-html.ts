/**
 * `forgen status --html [--out <경로>]` — 룰·건강·후보·이력을 파일 하나짜리 HTML 로 (docs/plans/2026-11-18-forgen-own-metrics.md §3).
 *
 * 외부 리소스 0(스크립트·폰트·이미지 없음, CSP 로 막음), 밖으로 아무것도 보내지 않는다.
 * 데이터는 <script type="application/json"> 에 이스케이프해 넣고, 화면은 인라인 JS 가 textContent 로만 그린다(룰 문구의 HTML 은 실행되지 않음).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { STATE_DIR } from './paths.js';

/** JSON 을 <script> 안에 안전하게 — `</script>`·`<!--`·U+2028/2029 로 스크립트가 끊기거나 깨지지 않게. */
export function embedJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function renderStatusHtml(data: unknown): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="referrer" content="no-referrer">
<title>forgen 상태</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>forgen 상태</h1>
  <p id="meta"></p>
  <nav id="tabs" role="tablist"></nav>
</header>
<main id="view"></main>
<script type="application/json" id="forgen-data">${embedJson(data)}</script>
<script>${JS}</script>
</body>
</html>
`;
}

export function defaultHtmlPath(): string {
  return path.join(STATE_DIR, 'report', 'forgen-status.html');
}

export function writeStatusHtml(html: string, out: string): void {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, { mode: 0o600 });
  try { fs.chmodSync(out, 0o600); } catch { /* 윈도우 등 */ }
}

/** 기본 브라우저로 열기. 열 수 없는 환경(화면 없는 리눅스 등)이면 false. */
export function openInBrowser(file: string): boolean {
  try {
    let cmd: string; let args: string[];
    if (process.platform === 'darwin') { cmd = 'open'; args = [file]; }
    else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', file]; }
    else {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
      cmd = 'xdg-open'; args = [file];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* 경로는 이미 출력됨 */ });
    child.unref();
    return true;
  } catch { return false; }
}

const CSS = `
:root{--bg:#fbfaf8;--fg:#1d1d1f;--muted:#6b6b70;--line:#e4e2dd;--card:#fff;--accent:#2f5d50;--warn:#a1520c;--bad:#a12c2c;--chip:#f0eee9}
@media (prefers-color-scheme:dark){:root{--bg:#141415;--fg:#ececee;--muted:#9a9aa1;--line:#2c2c30;--card:#1c1c1f;--accent:#7fb8a6;--warn:#e0a060;--bad:#e07a7a;--chip:#26262a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Segoe UI","Noto Sans KR",sans-serif}
header{padding:20px 20px 0;max-width:1200px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:15px;margin:24px 0 8px}
#meta{color:var(--muted);margin:0 0 12px;font-size:12px}
nav{display:flex;gap:4px;border-bottom:1px solid var(--line);overflow-x:auto}
nav button{background:none;border:0;border-bottom:2px solid transparent;padding:8px 12px;color:var(--muted);font:inherit;cursor:pointer;white-space:nowrap}
nav button[aria-selected=true]{color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
main{max-width:1200px;margin:0 auto;padding:16px 20px 48px}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
input,select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
input[type=search]{flex:1;min-width:180px}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{position:sticky;top:0;background:var(--card);font-weight:600;white-space:nowrap;cursor:pointer;user-select:none}
th[data-sort]::after{content:" ↕";color:var(--muted)}
th.asc::after{content:" ↑";color:var(--fg)}th.desc::after{content:" ↓";color:var(--fg)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tbody tr{cursor:pointer}tbody tr:hover{background:var(--chip)}
.stmt{max-width:420px}
.chip{display:inline-block;padding:0 6px;border-radius:4px;background:var(--chip);font-size:12px;white-space:nowrap}
.s-active{color:var(--accent)}.s-candidate{color:var(--warn)}.s-suppressed,.s-removed,.s-superseded{color:var(--muted)}
.flag{color:var(--bad);white-space:nowrap}
td .s-active,td .s-candidate,td .s-suppressed,td .s-removed,td .s-superseded{white-space:nowrap}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
.card b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.card span{color:var(--muted);font-size:12px}
.muted{color:var(--muted)}
dialog{max-width:760px;width:calc(100% - 32px);border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);padding:20px}
dialog::backdrop{background:rgba(0,0,0,.35)}
dialog h3{margin:0 0 8px;font-size:15px}
dialog p.stmt{white-space:pre-wrap;max-width:none}
dialog ul{padding-left:18px}
.close{float:right}
button.plain{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:4px 10px;cursor:pointer}
svg{display:block;width:100%;height:auto}
.note{font-size:12px;color:var(--muted)}
@media (max-width:640px){header,main{padding-left:16px;padding-right:16px}.stmt{max-width:220px}}
`;

const JS = String.raw`
(function(){
var D = JSON.parse(document.getElementById('forgen-data').textContent);
var rules = (D.ruleList && D.ruleList.rules) || [];
var health = D.health || null;
var history = D.history || null;
var view = document.getElementById('view');

function el(tag, attrs, kids){ var e=document.createElement(tag); if(attrs) for(var k in attrs){ if(k==='text') e.textContent=attrs[k]; else if(k==='cls') e.className=attrs[k]; else e.setAttribute(k, attrs[k]); } (kids||[]).forEach(function(c){ if(c==null) return; e.appendChild(typeof c==='string'?document.createTextNode(c):c); }); return e; }
function day(s){ return s ? String(s).slice(0,10) : '—'; }
var L = {
  status:{active:'사용 중',candidate:'후보',suppressed:'꺼짐',removed:'정리됨',superseded:'대체됨'},
  origin:{user:'직접',mined:'추론',default:'기본',other:'기타'},
  strength:{hard:'hard',strong:'strong',default:'default',soft:'soft'}
};
function lab(map, v){ return map[v] || v || '—'; }

document.getElementById('meta').textContent = 'forgen ' + (D.forgenVersion||'') + ' · ' + (D.generatedAt||'').replace('T',' ').slice(0,16) + ' UTC · 이 파일은 내 컴퓨터에서만 열리며 밖으로 아무것도 보내지 않습니다';

var tabs = [['rules','룰 ('+rules.length+')'],['health','건강'],['candidates','추론 후보 ('+rules.filter(function(r){return r.status==='candidate';}).length+')'],['history','이력']];
var nav = document.getElementById('tabs');
tabs.forEach(function(t){ var b=el('button',{role:'tab','data-tab':t[0],text:t[1]}); b.onclick=function(){ show(t[0]); }; nav.appendChild(b); });
function show(name){ Array.prototype.forEach.call(nav.children,function(b){ b.setAttribute('aria-selected', b.getAttribute('data-tab')===name?'true':'false'); }); view.textContent=''; ({rules:renderRules,health:renderHealth,candidates:renderCandidates,history:renderHistory})[name](); try{ location.hash=name; }catch(e){} }

// ── 정렬 가능한 표 ──
function table(cols, rows, onRow){
  var state={key:null,dir:1};
  var wrap=el('div',{cls:'tablewrap'}); var t=el('table'); var thead=el('thead'); var tr=el('tr'); var tbody=el('tbody');
  cols.forEach(function(c){ var th=el('th',{text:c.label, cls:c.num?'num':''}); if(c.sort!==false){ th.setAttribute('data-sort',''); th.onclick=function(){ state.dir = state.key===c.key ? -state.dir : (c.num?-1:1); state.key=c.key; Array.prototype.forEach.call(tr.children,function(x){x.classList.remove('asc','desc');}); th.classList.add(state.dir>0?'asc':'desc'); draw(); }; } tr.appendChild(th); });
  thead.appendChild(tr); t.appendChild(thead); t.appendChild(tbody); wrap.appendChild(t);
  function val(r,c){ var v = c.value ? c.value(r) : r[c.key]; return v==null?'':v; }
  function draw(){
    var list = rows().slice();
    if(state.key){ var c=cols.filter(function(x){return x.key===state.key;})[0]; list.sort(function(a,b){ var x=val(a,c), y=val(b,c); return (typeof x==='number'&&typeof y==='number' ? x-y : String(x).localeCompare(String(y)))*state.dir; }); }
    tbody.textContent='';
    list.forEach(function(r){ var row=el('tr'); cols.forEach(function(c){ var td=el('td',{cls:(c.num?'num ':'')+(c.cls||'')}); var v=c.render?c.render(r):val(r,c); if(v instanceof Node) td.appendChild(v); else td.textContent=String(v); row.appendChild(td); }); if(onRow) row.onclick=function(){ onRow(r); }; tbody.appendChild(row); });
    if(!list.length){ var e=el('tr'); e.appendChild(el('td',{colspan:String(cols.length),cls:'muted',text:'해당하는 항목이 없습니다.'})); tbody.appendChild(e); }
  }
  wrap.redraw=draw; draw(); return wrap;
}

function scope(r){ return r.projects && r.projects.length ? r.projects.join(', ') : '전역'; }
function statusCell(r){ var s=el('span',{cls:'s-'+r.status,text:lab(L.status,r.status)}); if(r.phase==='flagged'){ return el('span',null,[s,' ',el('span',{cls:'flag',text:'⚑ 검토'})]); } return s; }

function renderRules(){
  var q=el('input',{type:'search',placeholder:'문구·트리거·범위 검색','aria-label':'검색'});
  function sel(label, values, map){ var s=el('select',{'aria-label':label}); s.appendChild(el('option',{value:'',text:label+': 전체'})); values.forEach(function(v){ s.appendChild(el('option',{value:v,text:lab(map||{},v)})); }); return s; }
  function uniq(k){ var m={}; rules.forEach(function(r){ m[r[k]]=1; }); return Object.keys(m).sort(); }
  var fs=sel('상태',uniq('status'),L.status), fo=sel('출처',uniq('origin'),L.origin), fc=sel('분류',uniq('category')), fe=sel('막는 방식',['차단','탐지','자문']);
  fs.value='active';
  var ctr=el('div',{cls:'controls'},[q,fs,fo,fc,fe]);
  function rows(){ var t=q.value.trim().toLowerCase(); return rules.filter(function(r){
    if(fs.value && r.status!==fs.value) return false; if(fo.value && r.origin!==fo.value) return false; if(fc.value && r.category!==fc.value) return false; if(fe.value && r.enforce.label!==fe.value) return false;
    if(t && (r.statement+' '+r.trigger+' '+scope(r)+' '+r.id).toLowerCase().indexOf(t)<0) return false; return true; }); }
  var tb=table([
    {key:'statement',label:'정책',cls:'stmt',render:function(r){ return r.statement.length>120? r.statement.slice(0,120)+'…' : r.statement; }},
    {key:'category',label:'분류'},
    {key:'strength',label:'강도'},
    {key:'origin',label:'출처',value:function(r){return lab(L.origin,r.origin);}},
    {key:'status',label:'상태',render:statusCell,value:function(r){return r.status;}},
    {key:'enforce',label:'막는 방식',value:function(r){return r.enforce.label;}},
    {key:'inject',label:'적용',num:true,value:function(r){return r.counts.inject;}},
    {key:'violation',label:'어김',num:true,value:function(r){return r.counts.violation;}},
    {key:'bypass',label:'우회',num:true,value:function(r){return r.counts.bypass;}},
    {key:'lastInjectAt',label:'마지막 적용',value:function(r){return day(r.lastInjectAt);}},
    {key:'scope',label:'범위',value:scope}
  ], rows, detail);
  [q,fs,fo,fc,fe].forEach(function(x){ x.oninput=tb.redraw; x.onchange=tb.redraw; });
  view.appendChild(ctr); view.appendChild(tb);
  view.appendChild(el('p',{cls:'note',text:'자문 룰은 위반을 탐지할 수 없어 "어김 0"이 준수를 뜻하지 않습니다. 행을 누르면 정책 문구·근거 교정·상태 이력을 봅니다.'}));
}

var dlg=el('dialog'); document.body.appendChild(dlg);
function detail(r){
  dlg.textContent='';
  var close=el('button',{cls:'plain close',text:'닫기'}); close.onclick=function(){ dlg.close(); };
  dlg.appendChild(close);
  dlg.appendChild(el('h3',{text:lab(L.status,r.status)+' · '+r.category+' · '+r.strength+' · '+lab(L.origin,r.origin)+' · '+scope(r)}));
  dlg.appendChild(el('p',{cls:'stmt',text:r.statement}));
  dlg.appendChild(el('p',{cls:'muted',text:'id '+r.id+' · 트리거 '+r.trigger+' · 만든 날 '+day(r.createdAt)+' · 적용 '+r.counts.inject+' · 어김 '+r.counts.violation+' · 우회 '+r.counts.bypass+' · 막는 방식 '+r.enforce.label}));
  dlg.appendChild(el('h3',{text:'근거 교정 ('+r.evidence.length+(r.evidenceTruncated?' + '+r.evidenceTruncated:'')+')'}));
  var ul=el('ul'); r.evidence.forEach(function(e){ ul.appendChild(el('li',{text:day(e.at)+' · '+({user:'직접',mined:'추론',other:'기타'})[e.kind]+' · '+(e.summary||'(기록을 찾지 못함)')})); }); if(!r.evidence.length) ul.appendChild(el('li',{cls:'muted',text:'없음'})); dlg.appendChild(ul);
  dlg.appendChild(el('h3',{text:'상태 이력'}));
  var ul2=el('ul'); r.statusHistory.forEach(function(h){ ul2.appendChild(el('li',{text:h.at.replace('T',' ').slice(0,16)+' · '+lab(L.status,h.from)+' → '+lab(L.status,h.to)+' · '+h.reason})); }); if(!r.statusHistory.length) ul2.appendChild(el('li',{cls:'muted',text:'없음'})); dlg.appendChild(ul2);
  if(dlg.showModal) dlg.showModal(); else dlg.setAttribute('open','');
}

function card(n,label){ return el('div',{cls:'card'},[el('b',{text:String(n)}),el('span',{text:label})]); }
function bars(days, key, label){
  var w=Math.max(days.length*8,240), h=80, max=Math.max.apply(null,[1].concat(days.map(function(d){return d[key]||0;})));
  var ns='http://www.w3.org/2000/svg'; var svg=document.createElementNS(ns,'svg'); svg.setAttribute('viewBox','0 0 '+w+' '+(h+14)); svg.setAttribute('role','img'); svg.setAttribute('aria-label',label);
  days.forEach(function(d,i){ var v=d[key]||0; var bh=Math.round(v/max*h); var r=document.createElementNS(ns,'rect'); r.setAttribute('x',String(i*(w/days.length)+1)); r.setAttribute('y',String(h-bh)); r.setAttribute('width',String(Math.max(w/days.length-2,1))); r.setAttribute('height',String(bh)); r.setAttribute('fill','currentColor'); var t=document.createElementNS(ns,'title'); t.textContent=d.day+' · '+v; r.appendChild(t); svg.appendChild(r); });
  var wrap=el('div',{cls:'card'},[el('span',{text:label+' (최대 '+max+')'})]); wrap.style.color='var(--accent)'; wrap.appendChild(svg); return wrap;
}
function dayTable(days){
  return table([
    {key:'day',label:'날짜(UTC)'},
    {key:'correctionsUser',label:'교정 직접',num:true},{key:'correctionsMined',label:'교정 추론',num:true},
    {key:'rulesCreated',label:'생성',num:true},{key:'rulesRetired',label:'은퇴',num:true},{key:'rulesPromoted',label:'승급',num:true},
    {key:'blocks',label:'차단',num:true},{key:'advisories',label:'자문',num:true},{key:'bypasses',label:'우회',num:true},
    {key:'source',label:'출처',value:function(d){ return ({live:'계산',closed:'보관',backfill:'보관(사후)'})[d.source]||d.source||''; }}
  ], function(){ return days.slice().reverse(); });
}
function renderHealth(){
  if(!health){ view.appendChild(el('p',{cls:'muted',text:'건강 지표가 없습니다.'})); return; }
  var f=health.flow, a=health.rules.active, fl=health.rules.flagged;
  view.appendChild(el('h2',{text:'흐름 — 최근 '+health.windowDays+'일'}));
  view.appendChild(el('div',{cls:'grid'},[
    card(f.correctionsUser+' / '+f.correctionsMined,'교정 (직접 / 추론)'),
    card(f.rulesCreatedExplicit+' / '+f.rulesCreatedMined,'룰 생성 (직접 / 추론)'),
    card(a.total,'활성 룰 (직접 '+a.explicit+' · 추론 '+a.mined+' · 기본 '+a.onboarding+')'),
    card(f.checksPass+' / '+f.checksViolation,'평가 통과 / 위반'),
    card(f.blocks,'차단 (고쳐서 통과 '+f.acknowledgments+')'),
    card(f.advisories,'자문'),card(f.bypasses,'우회'),card(f.retired,'은퇴'),card(f.promotions,'승급')
  ]));
  view.appendChild(el('h2',{text:'대기열'}));
  view.appendChild(el('div',{cls:'grid'},[
    card(fl.total,'검토 대기 → forgen rule review'),
    card(health.rules.duplicateGroups.length,'같은 문장 묶음 → forgen rule dedupe'),
    card(health.rules.candidates||0,'추론 후보 → forgen rule candidates'),
    card(health.rules.neverInjected,'주입 0회'),
    card(health.rules.unscopedLearned,'범위 없는 학습 룰 → classify-projects --from-sessions')
  ]));
  if(health.top.blocking.length){ view.appendChild(el('h2',{text:'많이 막은 룰'})); view.appendChild(table([{key:'blocks',label:'차단',num:true},{key:'policy',label:'룰',cls:'stmt',value:function(t){return t.policy||t.ruleId;}}], function(){return health.top.blocking;})); }
  if(health.top.recorrected.length){ view.appendChild(el('h2',{text:'다시 교정된 룰'})); view.appendChild(table([{key:'count',label:'횟수',num:true},{key:'policy',label:'룰',cls:'stmt',value:function(t){return t.policy||t.ruleId;}}], function(){return health.top.recorrected;})); }
  view.appendChild(el('h2',{text:'일별'}));
  view.appendChild(el('div',{cls:'grid'},[bars(health.days,'corrections','교정'),bars(health.days,'blocks','차단'),bars(health.days,'advisories','자문')]));
  view.appendChild(el('div',{style:'height:10px'}));
  view.appendChild(dayTable(health.days));
}
function renderCandidates(){
  var list=rules.filter(function(r){return r.status==='candidate';});
  view.appendChild(el('p',{cls:'note',text:'추론(채굴) 룰 후보는 주입되지 않습니다. 다른 세션에서 같은 교정이 한 번 더 잡히면 활성이 됩니다. 바로 켜기: forgen activate-rule <id>'}));
  view.appendChild(table([
    {key:'statement',label:'정책',cls:'stmt'},
    {key:'sessions',label:'근거',num:true,value:function(r){return r.evidence.length;}},
    {key:'last',label:'마지막 근거',value:function(r){return day(r.evidence[0]&&r.evidence[0].at);}},
    {key:'scope',label:'범위',value:scope},
    {key:'id',label:'id',value:function(r){return r.id.slice(0,8);}}
  ], function(){return list;}, detail));
}
function renderHistory(){
  var days=(history && history.days) || (health && health.days) || [];
  view.appendChild(el('p',{cls:'note',text: history && history.oldestDay ? '보관 '+history.retentionDays+'일 · 가장 오래된 기록 '+history.oldestDay+' · "보관(사후)"는 처음 기록할 때 과거 원천으로 계산한 값이라 차단·자문이 일부 빠졌을 수 있습니다.' : '아직 보관된 일별 기록이 없습니다.'}));
  view.appendChild(el('div',{cls:'grid'},[bars(days,'corrections','교정'),bars(days,'rulesCreated','생성'),bars(days,'blocks','차단')]));
  view.appendChild(el('div',{style:'height:10px'}));
  view.appendChild(dayTable(days));
}
var start=(location.hash||'').slice(1); show(['rules','health','candidates','history'].indexOf(start)>=0?start:'rules');
})();
`;
