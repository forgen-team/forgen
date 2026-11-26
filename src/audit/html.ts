/**
 * 감사 결과 페이지 — `forgen status --html` 과 같은 틀(htmlPage: CSP 로 외부 리소스 0, textContent 로만 그림).
 * 첫 화면 맨 위 네 줄(docs/plans/2026-11-25-v1.0-plan.md §0)은 터미널 요약과 같은 문장을 쓴다(topLines).
 */
import * as os from 'node:os';
import { DOM_HELPERS_JS, htmlPage } from '../core/status-html.js';
import type { AuditResult } from './run.js';
import { representative } from './activity.js';

const kb = (b: number) => `${(b / 1024).toFixed(1)}KB`;

/** 홈으로 볼 경로: HOME + 이 계정의 홈(/home/<이름>·/Users/<이름>) — HOME 을 바꿔 돌려도 계정 홈은 ~ 로 줄인다(B9). */
export function homeDirs(home = os.homedir()): string[] {
  let user = '';
  try { user = os.userInfo().username; } catch { /* 없음 */ }
  return [...new Set([home, ...(user ? [`/home/${user}`, `/Users/${user}`] : [])].filter(Boolean))].sort((a, b) => b.length - a.length);
}

export function shortPath(p: string, home = os.homedir()): string {
  for (const h of homeDirs(home)) if (p === h || p.startsWith(`${h}/`)) return `~${p.slice(h.length)}`;
  return p;
}

/** 요약 줄(첫 화면 "가장 중요한 발견" 아래): 다시 한 교정 · 세션 시작 토큰 · 지적 수 · MEMORY.md 여유 · 상황 맞춤 룰 · 처방 전후. */
/** 첫 화면 맨 위 한 줄: 화면에 나오는 낱말의 뜻(B1). */
export const TERMS_LINE = '"실린다" = 세션이 시작될 때 AI 에게 자동으로 보내지는 지시 · "부딪힘" = 동시에 지킬 수 없는 두 지시';

/** 같은 말 다시 하기 한 줄(첫 화면용, 퍼센트 없이) — 어느 재생 결과인지(날짜·전부/표본)를 같이 적는다(B2). */
export function recurrenceShort(r: AuditResult): string {
  const rc = r.summary.recurrence;
  if (rc.status === 'none' || !rc.per30d) return rc.line;
  const f = (x: number) => String(Math.round(x));
  const src = `${rc.generatedAt?.slice(0, 10) ?? ''} 에 지난 대화 기록 요청 ${rc.prompts?.window ?? '?'}개 ${rc.sampled ? `중 ${rc.prompts?.judged ?? '?'}개 표본으로 잰 참고값` : '전부로 잰 값 — audit recurrence --limit 로 표본만 다시 재면 숫자가 다르게 나옴'}`;
  const rg = (lo: number, hi: number | undefined) => { const a = f(Math.min(lo, hi ?? lo)); const b = f(Math.max(lo, hi ?? lo)); return a === b ? a : `${a}~${b}`; };
  const L = rc.lenient?.per30d;
  const written = rg(rc.per30d.written, L?.written);
  const unwritten = rg(Math.max(0, rc.per30d.total - rc.per30d.written), L ? Math.max(0, L.total - L.written) : undefined);
  const pct = (x: number) => `${Math.round(x) / 10}%`;
  const share = rc.per1000 ? (L && rc.lenient ? `${pct(Math.min(rc.per1000.total, rc.lenient.per1000.total))}~${pct(Math.max(rc.per1000.total, rc.lenient.per1000.total))}` : pct(rc.per1000.total)) : '';
  return `지난 30일 교정 약 ${f(rc.per30d.corrections)}번 중 이미 적혀 있는데 또 말한 것 약 ${written}번 · 어디에도 안 적혀 또 말한 것 약 ${unwritten}번${share ? ` — 같은 말 다시 하기 ${share}` : ''}${L ? '(판정 기준에 따라 — 경계가 애매한 교정이 있어 범위로 보여 줍니다)' : ''} (${src} — 자세히: forgen audit recurrence)`;
}

/** 요약 줄(첫 화면 "가장 중요한 발견" 아래). 퍼센트는 처방 전후 하나만(B6) — 나머지는 자세히 화면에. */
export function topLines(r: AuditResult): string[] {
  const f = r.summary.findings;
  const tr = r.summary.truncation;
  const tight = tr.tightest
    ? `가장 빠듯한 곳(${shortPath(tr.tightest.folder ?? tr.tightest.dir)}) ${tr.tightest.spareLines}줄·${kb(tr.tightest.spareBytes)} 남음(약 ${tr.tightest.spareItems}개 더 적을 수 있음)`
    : 'MEMORY.md 없음';
  const rep = representative(r.folders.map((x) => ({ value: x.totalTokens, sessions: x.sessions30d ?? 0 })));
  const tokens = r.folders.map((x) => x.totalTokens);
  const n3 = r.summary.n3;
  const n3rep = n3?.rep;
  const pc = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x)}%`;
  return [
    recurrenceShort(r),
    rep
      ? `세션 시작에 실리는 기억: ${rep.weighted ? `자주 쓰는 폴더(최근 30일 세션 3개 이상) ${rep.folders}곳 평균` : `폴더 ${rep.folders}곳 평균`} 약 ${Math.round(rep.value)}토큰 (폴더별 ${Math.min(...tokens)}~${Math.max(...tokens)})`
      : '세션 시작에 실리는 기억: 감사한 폴더 없음',
    f.conflicts === 'pending' || f.dupGroups === null || f.mixConfirmed === null
      ? `같은 문장 ${f.sameSentence}묶음 · 지금 없는 것을 가리키는 줄 ${f.stale}개 · 늘 실리는 .claude/rules 파일 ${f.unscopedRules}개(paths: 없음 = 특정 파일을 다룰 때만 실리게 하는 표시가 없음) (부딪힘·같은 뜻·섞임은 모델을 꺼서 세지 않음)`
      : `서로 부딪히는 지시 ${f.conflicts}쌍 · 같은 뜻 중복 ${f.dupGroups}묶음 · 다른 프로젝트 지시 섞임 ${f.mixConfirmed}개 (모델 판정${r.checks.model?.status === 'incomplete' ? ', 일부 못 함' : ''}) · 같은 문장 ${f.sameSentence}묶음 · 지금 없는 것을 가리키는 줄 ${f.stale}개 · 늘 실리는 .claude/rules 파일 ${f.unscopedRules}개(paths: 없음 = 특정 파일을 다룰 때만 실리게 하는 표시가 없음)`,
    `MEMORY.md 가 상한(200줄·25KB)에 잘린 곳 ${tr.truncated}/${tr.memoryDirs} · ${tight}`,
    ...situationalLine(r),
    ...(n3 ? [`처방 전(${n3.baselineAt.slice(0, 10)}) 대비 ${n3rep?.weighted ? '자주 쓰는 폴더의 ' : ''}세션 시작 기억 ${pc(n3rep ? n3rep.pct : n3.medianPct)} — 자세히: forgen fix --report`] : []),
  ];
}

/** 상황 맞춤 룰(조건이 맞을 때만 들어오는 룰) 수와 필요한 순간에 안 들어와 다시 말한 횟수. 없으면 줄이 없다. */
function situationalLine(r: AuditResult): string[] {
  const n = Math.max(0, ...r.folders.map((f) => f.forgenTier2?.rules ?? 0));
  const missed = r.summary.recurrence.tier2Missed ?? 0;
  if (!n && !missed) return [];
  return [`상황 맞춤 룰 최대 ${n}개(세션 시작엔 목록 한 줄, 조건이 맞을 때만 들어옴) · 필요한 순간에 안 들어와 같은 교정을 다시 한 일 ${missed}번 — 다시 교정하지 않고 넘어간 경우는 셀 수 없음`];
}

export function renderAuditHtml(r: AuditResult, runId: string): string {
  return htmlPage({ title: 'forgen 감사', data: { ...r, runId, home: os.homedir(), homes: homeDirs(), terms: TERMS_LINE, top: topLines(r), findingsTop: r.summary.top?.findings ?? [], next: r.summary.top?.next ?? [] }, js: JS, css: CSS });
}

const CSS = `
#top{list-style:none;margin:0 0 14px;padding:0;display:grid;gap:6px}
#top li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:14px;white-space:pre-wrap}
.toph{font-size:15px;margin:10px 0 6px}

.loc{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:nowrap}
`;

const JS = `
(function(){
var D = JSON.parse(document.getElementById('forgen-data').textContent);
var view = document.getElementById('view');
${DOM_HELPERS_JS}
var HOME = D.home || '';
var HOMES = D.homes || [HOME];
function sp(p){ p = p||''; for (var i=0;i<HOMES.length;i++){ var h=HOMES[i]; if (h && (p===h || p.indexOf(h+'/')===0)) return '~'+p.slice(h.length); } return p; }
function loc(x){ return x.ruleId ? 'forgen 룰 '+x.ruleId.slice(0,8) : sp(x.path)+(x.line?':'+x.line:''); }
function clip(s,n){ s=String(s||''); return s.length>n ? s.slice(0,n-1)+'…' : s; }
var LAYER={managed:'관리형 정책',user:'사용자 CLAUDE.md','user-rules':'사용자 .claude/rules',project:'프로젝트 CLAUDE.md','project-local':'CLAUDE.local.md','project-rules':'프로젝트 .claude/rules',agents:'AGENTS.md','import':'@import 로 불러온 파일','memory-index':'MEMORY.md','memory-topic':'메모 파일','forgen-render':'forgen 룰(세션 시작)','forgen-rule':'forgen 룰'};
function lay(l){ return LAYER[l]||l; }

document.getElementById('meta').textContent = 'forgen ' + (D.forgenVersion||'') + ' · ' + (D.generatedAt||'').replace('T',' ').slice(0,16) + ' UTC · ' + (D.model && D.model.used ? '부딪힘·같은 뜻·섞임은 모델 판정' : '모델을 끄고 검사함') + ' · 이 파일은 내 컴퓨터에서만 열리며 밖으로 아무것도 보내지 않습니다';
var header = document.querySelector('header');
function block(title, xs, ordered){ if(!xs.length) return; header.insertBefore(el('h2',{cls:'toph',text:title}), document.getElementById('tabs')); var ul=el(ordered?'ol':'ul',{id:'top'}); xs.forEach(function(t){ ul.appendChild(el('li',{text:t})); }); header.insertBefore(ul, document.getElementById('tabs')); }
if(D.terms) header.insertBefore(el('p',{cls:'note',text:D.terms}), document.getElementById('tabs'));
block('가장 중요한 발견', D.findingsTop||[], true);
block('요약', D.top||[], false);
block('다음에 할 일', D.next||[], true);

var C = D.checks || {};
var M = C.model || null;
function yesN(xs){ return (xs||[]).filter(function(p){return p.verdict==='yes';}).length; }
var tabs = [['tokens','폴더별 토큰 ('+(D.folders||[]).length+')']];
if (M) { tabs.push(['conflict','부딪힘 ('+yesN(M.conflict)+')']); tabs.push(['dup','같은 뜻 중복 ('+M.counts.dupGroups+'묶음)']); }
tabs = tabs.concat([['same','같은 문장 ('+(C.sameSentence||[]).length+')'],['mix',(M?'다른 프로젝트 섞임 ('+M.counts.mixConfirmed+')':'다른 프로젝트 섞임 의심 ('+(C.mix||[]).length+')')],['stale','없는 것을 가리킴 ('+(C.stale||[]).length+')'],['trunc','MEMORY.md 여유 ('+(C.truncation||[]).length+')'],['rules','늘 실리는 rules 파일 ('+(C.unscopedRules||[]).length+')'],['sources','읽은 파일']];
var nav = document.getElementById('tabs');
tabs.forEach(function(t){ var b=el('button',{role:'tab','data-tab':t[0],text:t[1]}); b.onclick=function(){ show(t[0]); }; nav.appendChild(b); });
var R = {tokens:renderTokens,conflict:function(){renderPairs('conflict');},dup:function(){renderPairs('dup');},same:renderSame,mix:renderMix,stale:renderStale,trunc:renderTrunc,rules:renderRules,sources:renderSources};
function show(name){ Array.prototype.forEach.call(nav.children,function(b){ b.setAttribute('aria-selected', b.getAttribute('data-tab')===name?'true':'false'); }); view.textContent=''; R[name](); try{ location.hash=name; }catch(e){} }
function note(t){ view.appendChild(el('p',{cls:'note',text:t})); }

var dlg=el('dialog'); document.body.appendChild(dlg);
function folderDetail(f){
  dlg.textContent='';
  var close=el('button',{cls:'plain close',text:'닫기'}); close.onclick=function(){ dlg.close(); }; dlg.appendChild(close);
  dlg.appendChild(el('h3',{text:sp(f.folder)+' · '+f.totalTokens+' 토큰'}));
  var rows=f.entries.slice(); if(f.byLayer['forgen-render']) rows.push({path:'(forgen 이 세션 시작에 넣는 룰 '+f.forgenRules+'개)',layer:'forgen-render',always:true,tokens:f.byLayer['forgen-render']});
  dlg.appendChild(table([
    {key:'layer',label:'층',value:function(e){return lay(e.layer);}},
    {key:'path',label:'파일',cls:'loc',value:function(e){return sp(e.path)+(e.via?' ← '+sp(e.via):'');}},
    {key:'always',label:'실림',value:function(e){return e.always?'항상':'조건부(paths:)';}},
    {key:'tokens',label:'토큰',num:true}
  ], function(){return rows;}));
  if(dlg.showModal) dlg.showModal(); else dlg.setAttribute('open','');
}
function renderTokens(){
  note('토큰은 어림값입니다(영문 4자≈1, 한글 1자≈0.9). "줄일 수 있는 양"은 모델 없이 확실히 셀 수 있는 것(같은 문장의 남는 사본, 지금 없는 경로를 가리키는 줄)만입니다. 행을 누르면 그 폴더에서 실리는 파일을 봅니다.');
  var keys=['managed','user','user-rules','import','project','project-local','agents','project-rules','memory-index','forgen-render'];
  var cols=[{key:'folder',label:'폴더',cls:'loc',value:function(f){return sp(f.folder);}},{key:'totalTokens',label:'합계',num:true}];
  keys.forEach(function(k){ if((D.folders||[]).some(function(f){return f.byLayer[k];})) cols.push({key:k,label:lay(k),num:true,value:function(f){return f.byLayer[k]||0;}}); });
  cols.push({key:'red',label:'줄일 수 있는 양',num:true,value:function(f){return f.reducible.total;}});
  cols.push({key:'pct',label:'%',num:true,value:function(f){return f.reducible.pct;}});
  if(!M) cols.push({key:'mix',label:'섞임 의심',num:true,value:function(f){return f.mixCandidateTokens;}});
  cols.push({key:'s30',label:'최근 30일 세션',num:true,value:function(f){return f.sessions30d||0;}});
  view.appendChild(table(cols, function(){return D.folders||[];}, folderDetail));
  if((C.claudeMdOver200||[]).length){ view.appendChild(el('h2',{text:'200줄 넘는 지침 파일 (권장 200줄 이하)'})); view.appendChild(table([{key:'path',label:'파일',cls:'loc',value:function(x){return sp(x.path);}},{key:'layer',label:'층',value:function(x){return lay(x.layer);}},{key:'lines',label:'줄',num:true}], function(){return C.claudeMdOver200;})); }
}
function renderSame(){
  note('목록 표시·강조·문장부호·대소문자만 다른 같은 문장이 서로 다른 파일·룰에 두 번 이상 있는 것. 하나만 남기면 남는 사본만큼 줄어듭니다.');
  view.appendChild(table([
    {key:'text',label:'문장',cls:'stmt',value:function(g){return clip(g.text,160);}},
    {key:'n',label:'곳',num:true,value:function(g){return g.occurrences.length;}},
    {key:'tokens',label:'토큰',num:true},
    {key:'where',label:'위치',cls:'loc',sort:false,render:function(g){ var d=el('div'); g.occurrences.forEach(function(o){ d.appendChild(el('div',{text:lay(o.layer)+' · '+loc(o)})); }); return d; }}
  ], function(){return C.sameSentence||[];}));
}
var VL={yes:'예',no:'아니오',unknown:'모름',project:'섞임(프로젝트 전용)',general:'일반 원칙',null:'판정 못 함'};
function vl(v){ return VL[v===null||v===undefined?'null':v]||v; }
function renderPairs(kind){
  var xs=(M&&M[kind])||[];
  note(kind==='dup'
    ? '같은 세션에 함께 실리는 두 지시가 같은 뜻인지(하나만 남겨도 잃는 것이 없는지) 모델이 판정했습니다. 글자가 많이 겹치는 지시끼리만 물었고(목록·링크·표·설명 줄은 뺌), "예"만 셉니다. 판정이 맞는지 직접 확인: forgen audit review --kind dup'
    : '같은 세션에 함께 실리는 두 지시를 동시에 지킬 수 없는지 모델이 판정했습니다. 같은 주제인데 한쪽은 "하라", 다른 쪽은 "하지 마라"인 지시끼리만 물었고, "예"만 셉니다. 직접 확인: forgen audit review --kind conflict');
  var rows=xs.slice().sort(function(a,b){ var o={yes:0,unknown:1,no:2}; var x=(a.verdict in o)?o[a.verdict]:3, y=(b.verdict in o)?o[b.verdict]:3; return (x-y) || b.score-a.score; });
  view.appendChild(table([
    {key:'verdict',label:'판정',value:function(p){return vl(p.verdict);}},
    {key:'a',label:'지시 A',cls:'stmt',value:function(p){return clip(p.a.text,140);}},
    {key:'b',label:'지시 B',cls:'stmt',value:function(p){return clip(p.b.text,140);}},
    {key:'reason',label:'모델이 든 이유',cls:'stmt',value:function(p){return p.reason||'';}},
    {key:'score',label:'글자 겹침',num:true},
    {key:'where',label:'위치',cls:'loc',sort:false,render:function(p){ var d=el('div'); d.appendChild(el('div',{text:lay(p.a.layer)+' · '+loc(p.a)})); d.appendChild(el('div',{text:lay(p.b.layer)+' · '+loc(p.b)})); return d; }}
  ], function(){return rows;}));
}
function renderMix(){
  if(M){
    note('모든 프로젝트에 실리는 지시(사용자 CLAUDE.md·사용자 .claude/rules·모든 폴더용 forgen 룰)가 한 프로젝트에서만 뜻이 있는지 모델이 판정했습니다. 말투·언어·검증 같은 일하는 방식이면 섞임이 아닙니다. 홈 MEMORY.md 는 홈에서 연 세션에만 실려 묻지 않았습니다. 직접 확인: forgen audit review --kind mix');
  } else note('모든 프로젝트에 실리는 지시 중 프로젝트 이름이 나오는 등 한 프로젝트에 묶여 보이는 것입니다. 모델을 꺼서 내용은 보지 않았고, 일하는 방식 같은 일반 원칙도 섞여 나옵니다.');
  var rows=M?M.mix:(C.mix||[]);
  var cols=[];
  if(M) cols.push({key:'verdict',label:'판정',value:function(c){return c.skipped?'묻지 않음(홈 MEMORY.md)':vl(c.verdict);}});
  cols=cols.concat([
    {key:'text',label:'지시',cls:'stmt',value:function(c){return clip(c.text,160);}},
    {key:'project',label:'프로젝트',value:function(c){return (M?(c.judgedProject||c.project):c.project)||'—';}},
    {key:'why',label:'의심한 까닭',value:function(c){return c.why.join(' · ');}}]);
  if(M) cols.push({key:'reason',label:'모델이 든 이유',cls:'stmt',value:function(c){return c.reason||'';}});
  cols=cols.concat([{key:'tokens',label:'토큰',num:true},{key:'loc',label:'위치',cls:'loc',value:function(c){return lay(c.layer)+' · '+loc(c);}}]);
  view.appendChild(table(cols, function(){return rows;}));
}
function renderStale(){
  note('지금 디스크에 없는 파일·링크·npm 스크립트를 가리키는 줄입니다. 자리 표시 경로(<…>, *, /path/to)는 보지 않고, 메모 파일 본문은 지난 기록이라 뺐습니다.');
  var K={file:'파일',link:'링크','npm-script':'npm 스크립트'};
  view.appendChild(table([
    {key:'ref',label:'가리키는 것',cls:'loc'},
    {key:'kind',label:'종류',value:function(s){return K[s.kind]||s.kind;}},
    {key:'text',label:'줄',cls:'stmt',value:function(s){return clip(s.text,140);}},
    {key:'loc',label:'위치',cls:'loc',value:function(s){return lay(s.layer)+' · '+loc(s);}}
  ], function(){return C.stale||[];}));
}
function renderTrunc(){
  note('MEMORY.md 는 앞 200줄 또는 25KB 중 먼저 닿는 곳까지만 세션 시작에 실립니다. 넘은 줄은 실리지 않습니다. "MEMORY.md 에 없는 메모 파일"은 세션 시작에 있다는 것조차 알려지지 않습니다.');
  view.appendChild(table([
    {key:'folder',label:'메모 폴더',cls:'loc',value:function(t){return sp(t.folder||t.dir);}},
    {key:'lines',label:'줄',num:true},{key:'bytes',label:'KB',num:true,value:function(t){return Math.round(t.bytes/102.4)/10;}},
    {key:'cut',label:'잘린 줄',num:true,value:function(t){return t.cutItems.length;}},
    {key:'spareItems',label:'남은 항목(약)',num:true},
    {key:'first',label:'먼저 오는 상한',value:function(t){return t.firstLimit==='bytes'?'25KB':'200줄';}},
    {key:'orphan',label:'MEMORY.md 에 없는 메모 파일',num:true,value:function(t){return t.unindexedTopics.length;}}
  ], function(){return C.truncation||[];}, function(t){
    dlg.textContent=''; var close=el('button',{cls:'plain close',text:'닫기'}); close.onclick=function(){ dlg.close(); }; dlg.appendChild(close);
    dlg.appendChild(el('h3',{text:sp(t.dir)}));
    dlg.appendChild(el('h3',{text:'잘린 줄 ('+t.cutItems.length+')'})); var ul=el('ul'); t.cutItems.forEach(function(c){ ul.appendChild(el('li',{text:c.line+': '+clip(c.text,200)})); }); if(!t.cutItems.length) ul.appendChild(el('li',{cls:'muted',text:'없음'})); dlg.appendChild(ul);
    dlg.appendChild(el('h3',{text:'MEMORY.md 에 없는 메모 파일 ('+t.unindexedTopics.length+')'})); var ul2=el('ul'); t.unindexedTopics.forEach(function(n){ ul2.appendChild(el('li',{text:n})); }); if(!t.unindexedTopics.length) ul2.appendChild(el('li',{cls:'muted',text:'없음'})); dlg.appendChild(ul2);
    if(dlg.showModal) dlg.showModal(); else dlg.setAttribute('open','');
  }));
}
function renderRules(){
  note('앞머리에 paths: 가 없는 .claude/rules 파일은 세션마다 항상 실립니다. 특정 파일·폴더에만 해당하면 paths: 를 달아 그 파일을 다룰 때만 실리게 할 수 있습니다.');
  view.appendChild(table([
    {key:'path',label:'파일',cls:'loc',value:function(x){return sp(x.path);}},
    {key:'layer',label:'층',value:function(x){return lay(x.layer);}},
    {key:'lines',label:'줄',num:true},{key:'tokens',label:'토큰',num:true},{key:'folders',label:'실리는 폴더',num:true}
  ], function(){return C.unscopedRules||[];}));
}
function renderSources(){
  var S=D.sources||{};
  note('읽은 파일 '+(S.files||0)+'개 · '+Math.round((S.bytes||0)/1024)+'KB. 파일 목록과 내용 지문은 이 결과 폴더의 manifest.json 에 있습니다.');
  if((S.unreadable||[]).length){ view.appendChild(el('h2',{text:'읽지 못한 파일'})); view.appendChild(table([{key:'path',label:'파일',cls:'loc',value:function(x){return sp(x.path);}},{key:'error',label:'오류'}], function(){return S.unreadable;})); }
  if((S.brokenRules||[]).length){ view.appendChild(el('h2',{text:'깨진 forgen 룰 파일'})); view.appendChild(table([{key:'file',label:'파일',cls:'loc'},{key:'error',label:'오류'}], function(){return S.brokenRules;})); }
}
var start=(location.hash||'').slice(1); show(R[start]?start:'tokens');
})();
`;
