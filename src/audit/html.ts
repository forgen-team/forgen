/**
 * 감사 결과 페이지 — `forgen status --html` 과 같은 틀(htmlPage: CSP 로 외부 리소스 0, textContent 로만 그림).
 * 첫 화면 맨 위 네 줄(docs/plans/2026-11-25-v1.0-plan.md §0)은 터미널 요약과 같은 문장을 쓴다(topLines).
 */
import * as os from 'node:os';
import { DOM_HELPERS_JS, htmlPage } from '../core/status-html.js';
import type { AuditResult } from './run.js';

const kb = (b: number) => `${(b / 1024).toFixed(1)}KB`;

export function shortPath(p: string, home = os.homedir()): string {
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

/** 맨 위 네 줄: 다시 말한 교정 · 상시 로드 토큰과 줄일 몫 · 부딪힘·중복·섞임 · 잘림 여유. */
export function topLines(r: AuditResult): string[] {
  const t = r.summary.tokens;
  const f = r.summary.findings;
  const tr = r.summary.truncation;
  const range = (a: number, b: number, unit: string) => (a === b ? `${a}${unit}` : `${a}~${b}${unit}`);
  const tight = tr.tightest
    ? `가장 빠듯한 곳(${shortPath(tr.tightest.folder ?? tr.tightest.dir)}) 여유 ${tr.tightest.spareLines}줄·${kb(tr.tightest.spareBytes)} — 약 ${tr.tightest.spareItems}항목 (${tr.tightest.firstLimit === 'bytes' ? '25KB' : '200줄'} 상한이 먼저)`
    : '메모 색인(MEMORY.md) 없음';
  return [
    r.summary.recurrence.line,
    `세션마다 실리는 기억 약 ${range(t.min, t.max, '')} 토큰 (폴더 ${t.folders}곳, 중앙값 ${t.median}) · 결정적으로 줄일 수 있는 몫 ${range(t.reduciblePctMin, t.reduciblePctMax, '%')} (같은 문장 사본·낡은 줄)`,
    // 첫 화면에는 확정된 지적만 센다. 섞임 "후보"는 일반 원칙도 섞여 나오므로(근거 위치만 본 신호) 모델 판정 전에는 탭에만 둔다.
    f.conflicts === 'pending' || f.dupGroups === null || f.mixConfirmed === null
      ? `같은 문장 ${f.sameSentence}묶음 · 낡은 참조 ${f.stale}개 · paths: 없는 룰 ${f.unscopedRules}개 (부딪힘·같은 뜻 중복·다른 프로젝트 섞임은 모델 판정이 꺼져 세지 않음)`
      : `부딪힘 ${f.conflicts}쌍 · 같은 뜻 중복 ${f.dupGroups}묶음 · 다른 프로젝트 섞임 ${f.mixConfirmed}개 (모델 판정${r.checks.model?.status === 'incomplete' ? ', 판정 불완전' : ''}) · 같은 문장 ${f.sameSentence}묶음 · 낡은 참조 ${f.stale}개 · paths: 없는 룰 ${f.unscopedRules}개`,
    `MEMORY.md 잘림 ${tr.truncated}곳 / 메모 폴더 ${tr.memoryDirs}곳 · ${tight}`,
    ...tier2Line(r),
  ];
}

/** 0.9.0 두 층: 2층 룰 수(폴더 최대)와 2층 미발동(재생). 두 층을 안 쓰면 줄이 없다. */
function tier2Line(r: AuditResult): string[] {
  const n = Math.max(0, ...r.folders.map((f) => f.forgenTier2?.rules ?? 0));
  const missed = r.summary.recurrence.tier2Missed ?? 0;
  if (!n && !missed) return [];
  const exp = r.folders.filter((f) => f.forgenTier2).map((f) => `${shortPath(f.folder)} ${f.totalTokens}→${f.totalTokens + (f.forgenTier2?.expected ?? 0)}`);
  return [`두 층: 세션 시작에는 색인 줄로만 보이는 2층 룰 최대 ${n}개(상황이 맞으면 한 번 들어옴) · 2층 미발동 재발 ${missed}건(누락으로 셈, 그 룰은 1층으로 복귀) — 한계: 교정 없이 지나간 미발동·무시는 못 잡는다`,
    ...(exp.length ? [`세션당 토큰 최대치(상시 로드)→기대치(발동률 추정 반영, 넓은 조건은 절감 0): ${exp.join(' · ')} — 선전에는 기대치를 쓴다`] : [])];
}

export function renderAuditHtml(r: AuditResult, runId: string): string {
  return htmlPage({ title: 'forgen 감사', data: { ...r, runId, home: os.homedir(), top: topLines(r) }, js: JS, css: CSS });
}

const CSS = `
#top{list-style:none;margin:0 0 14px;padding:0;display:grid;gap:6px}
#top li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:14px}

.loc{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:nowrap}
`;

const JS = `
(function(){
var D = JSON.parse(document.getElementById('forgen-data').textContent);
var view = document.getElementById('view');
${DOM_HELPERS_JS}
var HOME = D.home || '';
function sp(p){ return HOME && p && (p===HOME || p.indexOf(HOME+'/')===0) ? '~'+p.slice(HOME.length) : (p||''); }
function loc(x){ return x.ruleId ? 'forgen 룰 '+x.ruleId.slice(0,8) : sp(x.path)+(x.line?':'+x.line:''); }
function clip(s,n){ s=String(s||''); return s.length>n ? s.slice(0,n-1)+'…' : s; }
var LAYER={managed:'관리형 정책',user:'사용자 CLAUDE.md','user-rules':'사용자 .claude/rules',project:'프로젝트 CLAUDE.md','project-local':'CLAUDE.local.md','project-rules':'프로젝트 .claude/rules',agents:'AGENTS.md','import':'@import','memory-index':'MEMORY.md','memory-topic':'메모 주제 파일','forgen-render':'forgen 주입','forgen-rule':'forgen 룰'};
function lay(l){ return LAYER[l]||l; }

document.getElementById('meta').textContent = 'forgen ' + (D.forgenVersion||'') + ' · ' + (D.generatedAt||'').replace('T',' ').slice(0,16) + ' UTC · 회차 ' + (D.runId||'') + ' · ' + (D.model && D.model.used ? '셋째 줄(부딪힘·중복·섞임)은 모델 판정' : '셋째 줄은 결정적 검사만(모델 판정 꺼짐)') + (D.summary && D.summary.recurrence && D.summary.recurrence.status !== 'none' ? ' · 첫 줄은 저장된 audit recurrence 결과(모델 판정)' : '') + ' · 이 파일은 내 컴퓨터에서만 열리며 밖으로 아무것도 보내지 않습니다';
var top = el('ul',{id:'top'}); (D.top||[]).forEach(function(t){ top.appendChild(el('li',{text:t})); });
var header = document.querySelector('header'); header.insertBefore(top, document.getElementById('tabs'));

var C = D.checks || {};
var M = C.model || null;
function yesN(xs){ return (xs||[]).filter(function(p){return p.verdict==='yes';}).length; }
var tabs = [['tokens','폴더별 토큰 ('+(D.folders||[]).length+')']];
if (M) { tabs.push(['conflict','부딪힘 ('+yesN(M.conflict)+')']); tabs.push(['dup','같은 뜻 중복 ('+M.counts.dupGroups+'묶음)']); }
tabs = tabs.concat([['same','같은 문장 ('+(C.sameSentence||[]).length+')'],['mix',(M?'섞임 ('+M.counts.mixConfirmed+' 확정 / 후보 '+(C.mix||[]).length+')':'섞임 후보 ('+(C.mix||[]).length+')')],['stale','낡음 ('+(C.stale||[]).length+')'],['trunc','잘림 ('+(C.truncation||[]).length+')'],['rules','paths: 없는 룰 ('+(C.unscopedRules||[]).length+')'],['sources','원천']];
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
  var rows=f.entries.slice(); if(f.byLayer['forgen-render']) rows.push({path:'(forgen 세션 시작 렌더, 룰 '+f.forgenRules+'개)',layer:'forgen-render',always:true,tokens:f.byLayer['forgen-render']});
  dlg.appendChild(table([
    {key:'layer',label:'층',value:function(e){return lay(e.layer);}},
    {key:'path',label:'파일',cls:'loc',value:function(e){return sp(e.path)+(e.via?' ← '+sp(e.via):'');}},
    {key:'always',label:'실림',value:function(e){return e.always?'항상':'조건부(paths:)';}},
    {key:'tokens',label:'토큰',num:true}
  ], function(){return rows;}));
  if(dlg.showModal) dlg.showModal(); else dlg.setAttribute('open','');
}
function renderTokens(){
  note('토큰은 로컬 근사(영문 4자≈1, 그 밖 글자 1자≈0.9). "줄일 몫"은 결정적으로 셀 수 있는 것(같은 문장의 남는 사본, 지금 없는 경로를 가리키는 줄)만이고, 섞임 후보 몫은 모델 판정 전 상한입니다. 행을 누르면 층별 파일을 봅니다.');
  var keys=['managed','user','user-rules','import','project','project-local','agents','project-rules','memory-index','forgen-render'];
  var cols=[{key:'folder',label:'폴더',cls:'loc',value:function(f){return sp(f.folder);}},{key:'totalTokens',label:'합계',num:true}];
  keys.forEach(function(k){ if((D.folders||[]).some(function(f){return f.byLayer[k];})) cols.push({key:k,label:lay(k),num:true,value:function(f){return f.byLayer[k]||0;}}); });
  cols.push({key:'red',label:'줄일 몫',num:true,value:function(f){return f.reducible.total;}});
  cols.push({key:'pct',label:'%',num:true,value:function(f){return f.reducible.pct;}});
  cols.push({key:'mix',label:'섞임 후보',num:true,value:function(f){return f.mixCandidateTokens;}});
  view.appendChild(table(cols, function(){return D.folders||[];}, folderDetail));
  if((C.claudeMdOver200||[]).length){ view.appendChild(el('h2',{text:'200줄 넘는 지침 파일 (권장 200줄 이하)'})); view.appendChild(table([{key:'path',label:'파일',cls:'loc',value:function(x){return sp(x.path);}},{key:'layer',label:'층',value:function(x){return lay(x.layer);}},{key:'lines',label:'줄',num:true}], function(){return C.claudeMdOver200;})); }
}
function renderSame(){
  note('정규화(목록 표지·강조·문장부호·대소문자)한 문장이 서로 다른 파일·룰에 두 번 이상 있는 것. 하나만 남기면 남는 사본만큼 줄어듭니다.');
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
    ? '모델 판정(Haiku): 같은 세션에 함께 실리는 두 지시가 같은 뜻인가(하나만 남겨도 잃는 것이 없는가). 후보는 글자 2-gram 상위 5 · 점수 ≥ '+M.judge.dup.min+'. "예"만 셉니다(묶음 = 예 쌍을 이은 것). 모델 판정 표시가 붙은 줄은 오너 검수(forgen audit review --kind dup) 대상입니다.'
    : '모델 판정(Haiku): 같은 세션에 함께 실리는 두 지시를 동시에 지킬 수 없는가. 후보는 같은 주제(2-gram 상위 5 · 점수 ≥ '+M.judge.conflict.min+')이면서 부정 표지 극성이 다른 쌍. "예"만 셉니다. 검수: forgen audit review --kind conflict');
  var rows=xs.slice().sort(function(a,b){ var o={yes:0,unknown:1,no:2}; var x=(a.verdict in o)?o[a.verdict]:3, y=(b.verdict in o)?o[b.verdict]:3; return (x-y) || b.score-a.score; });
  view.appendChild(table([
    {key:'verdict',label:'판정',value:function(p){return vl(p.verdict);}},
    {key:'a',label:'지시 A',cls:'stmt',value:function(p){return clip(p.a.text,140);}},
    {key:'b',label:'지시 B',cls:'stmt',value:function(p){return clip(p.b.text,140);}},
    {key:'reason',label:'근거(모델 판정)',cls:'stmt',value:function(p){return p.reason||'';}},
    {key:'score',label:'후보 점수',num:true},
    {key:'where',label:'위치',cls:'loc',sort:false,render:function(p){ var d=el('div'); d.appendChild(el('div',{text:lay(p.a.layer)+' · '+loc(p.a)})); d.appendChild(el('div',{text:lay(p.b.layer)+' · '+loc(p.b)})); return d; }}
  ], function(){return rows;}));
}
function renderMix(){
  if(M){
    note('전역 층(사용자 CLAUDE.md·사용자 룰·forgen 전역 룰)의 섞임 후보를 모델(Haiku)이 내용으로 판정했습니다: 한 프로젝트에서만 뜻이 있으면 섞임, 말투·언어·검증 같은 일반 원칙이면 섞임 아님. 홈 메모 색인은 홈에서 연 세션에만 실려 판정에 보내지 않았습니다. 검수: forgen audit review --kind mix');
  } else note('전역 층(사용자 CLAUDE.md·사용자 룰·홈 메모 색인·forgen 전역 룰)의 지시 중 한 프로젝트에만 묶여 보이는 것. 결정적 신호만으로 고른 후보이고, 일반 원칙도 섞여 나옵니다 — 모델 판정이 꺼져 내용 판정을 하지 않았습니다.');
  var rows=M?M.mix:(C.mix||[]);
  var cols=[];
  if(M) cols.push({key:'verdict',label:'판정',value:function(c){return c.skipped?'판정 안 함(홈 메모)':vl(c.verdict);}});
  cols=cols.concat([
    {key:'text',label:'지시',cls:'stmt',value:function(c){return clip(c.text,160);}},
    {key:'project',label:'프로젝트',value:function(c){return (M?(c.judgedProject||c.project):c.project)||'—';}},
    {key:'why',label:'신호',value:function(c){return c.why.join(' · ');}}]);
  if(M) cols.push({key:'reason',label:'근거(모델 판정)',cls:'stmt',value:function(c){return c.reason||'';}});
  cols=cols.concat([{key:'tokens',label:'토큰',num:true},{key:'loc',label:'위치',cls:'loc',value:function(c){return lay(c.layer)+' · '+loc(c);}}]);
  view.appendChild(table(cols, function(){return rows;}));
}
function renderStale(){
  note('지금 없는 파일·링크·npm 스크립트를 가리키는 줄(결정적인 것만). 자리 표시 경로(<…>, *, /path/to)는 보지 않습니다. 메모 주제 파일 본문은 지난 기록이라 제외합니다.');
  var K={file:'파일',link:'링크','npm-script':'npm 스크립트'};
  view.appendChild(table([
    {key:'ref',label:'가리키는 것',cls:'loc'},
    {key:'kind',label:'종류',value:function(s){return K[s.kind]||s.kind;}},
    {key:'text',label:'줄',cls:'stmt',value:function(s){return clip(s.text,140);}},
    {key:'loc',label:'위치',cls:'loc',value:function(s){return lay(s.layer)+' · '+loc(s);}}
  ], function(){return C.stale||[];}));
}
function renderTrunc(){
  note('MEMORY.md 는 앞 200줄 또는 25KB 중 먼저 닿는 곳까지만 세션 시작에 실립니다. 넘은 줄은 실리지 않습니다. "색인에 없는 주제 파일"은 세션 시작에 존재가 알려지지 않습니다.');
  view.appendChild(table([
    {key:'folder',label:'메모 폴더',cls:'loc',value:function(t){return sp(t.folder||t.dir);}},
    {key:'lines',label:'줄',num:true},{key:'bytes',label:'KB',num:true,value:function(t){return Math.round(t.bytes/102.4)/10;}},
    {key:'cut',label:'잘린 줄',num:true,value:function(t){return t.cutItems.length;}},
    {key:'spareItems',label:'남은 항목(약)',num:true},
    {key:'first',label:'먼저 오는 상한',value:function(t){return t.firstLimit==='bytes'?'25KB':'200줄';}},
    {key:'orphan',label:'색인에 없는 주제 파일',num:true,value:function(t){return t.unindexedTopics.length;}}
  ], function(){return C.truncation||[];}, function(t){
    dlg.textContent=''; var close=el('button',{cls:'plain close',text:'닫기'}); close.onclick=function(){ dlg.close(); }; dlg.appendChild(close);
    dlg.appendChild(el('h3',{text:sp(t.dir)}));
    dlg.appendChild(el('h3',{text:'잘린 줄 ('+t.cutItems.length+')'})); var ul=el('ul'); t.cutItems.forEach(function(c){ ul.appendChild(el('li',{text:c.line+': '+clip(c.text,200)})); }); if(!t.cutItems.length) ul.appendChild(el('li',{cls:'muted',text:'없음'})); dlg.appendChild(ul);
    dlg.appendChild(el('h3',{text:'색인에 없는 주제 파일 ('+t.unindexedTopics.length+')'})); var ul2=el('ul'); t.unindexedTopics.forEach(function(n){ ul2.appendChild(el('li',{text:n})); }); if(!t.unindexedTopics.length) ul2.appendChild(el('li',{cls:'muted',text:'없음'})); dlg.appendChild(ul2);
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
  note('읽은 파일 '+(S.files||0)+'개 · '+Math.round((S.bytes||0)/1024)+'KB. 원천 목록·해시는 이 회차 폴더의 manifest.json 에 있습니다. '+(D.model&&D.model.note||''));
  if((S.unreadable||[]).length){ view.appendChild(el('h2',{text:'읽지 못한 파일'})); view.appendChild(table([{key:'path',label:'파일',cls:'loc',value:function(x){return sp(x.path);}},{key:'error',label:'오류'}], function(){return S.unreadable;})); }
  if((S.brokenRules||[]).length){ view.appendChild(el('h2',{text:'깨진 forgen 룰 파일'})); view.appendChild(table([{key:'file',label:'파일',cls:'loc'},{key:'error',label:'오류'}], function(){return S.brokenRules;})); }
}
var start=(location.hash||'').slice(1); show(R[start]?start:'tokens');
})();
`;
