/**
 * 오너 검수 — `forgen audit review` · `review --import` · `forgen audit score` (docs/plans/2026-11-25-v1.0-plan.md §4.2-6, §1.2 N2, §12.1-2).
 *
 * 오너 결정(2026-11-25): 판정 쌍 25개를 직접 본다 — "예" 무작위 10 + "아니오" 중 사전 필터 점수가 높은 것 10 + "모름" 5(시드 고정).
 * 페이지는 파일 하나(외부 리소스 0, CSP, 권한 600)이고 판정자의 답은 보여 주지 않는다(검수자가 끌려가지 않게).
 * 답은 페이지가 JSON 파일로 내려받게 하고(Blob), `review --import <파일>` 이 <FORGEN_HOME>/audit/review/ 에 넣는다.
 * 기기 밖으로 아무것도 보내지 않는다. 교정 요지·기억 문장은 오너 본인 데이터라 보이되, 경로는 줄여 보인다.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FORGEN_HOME } from '../core/paths.js';
import { DOM_HELPERS_JS, htmlPage } from '../core/status-html.js';
import type { PairVerdict } from './judge.js';
import { latestRecurrenceRun, type RecurrenceResult } from './recurrence.js';
import type { AuditResult } from './run.js';
import type { ModelChecks } from './model-checks.js';

export const REVIEW_SAMPLE_SCHEMA = 'forgen-audit-review-sample/1' as const;
export const REVIEW_ANSWERS_SCHEMA = 'forgen-audit-review-answers/1' as const;
const SEED = 'forgen-review-20261125';
export const REVIEW_QUOTA = { yes: 10, no: 10, unknown: 5 } as const;
/** 판정자-오너 일치 기준(§12.1-2: 무작위 일치 검수에서 ≥ 90%). */
export const AGREEMENT_TARGET = 0.9;

export type OwnerAnswer = 'same' | 'different' | 'unsure';

export interface ReviewPair {
  pairId: string;
  /** 표본 칸: 판정자 "예" 무작위 / "아니오" 중 점수 높은 것 / "모름" */
  bucket: 'yes-random' | 'no-top-score' | 'unknown';
  judge: PairVerdict;
  ts: string;
  gist: string;
  utterance: string;
  memory: string;
  memoryWhere: string;
  memoryKind: string;
  tier: string;
  score: number;
  /** 지시 검사(--kind) 표본만: 지시 A 의 위치(지시 B 는 memoryWhere) */
  whereA?: string;
}

export type ReviewKind = 'dup' | 'conflict' | 'mix';
/** 지시 검사 표본의 판정자(N4 표본은 recurrence 의 JudgeInfo). */
export interface CheckJudgeInfo { check: { kind: ReviewKind; model: string; version: string } }
export interface ReviewSample { schema: typeof REVIEW_SAMPLE_SCHEMA; runId: string; createdAt: string; judge: RecurrenceResult['judge'] | CheckJudgeInfo; digest: string; pairs: ReviewPair[]; kind?: ReviewKind }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const reviewDir = () => path.join(FORGEN_HOME, 'audit', 'review');

/** 경로를 줄여 보인다: 홈 → ~, 메모 폴더는 …/memory/<파일>, forgen 룰은 ID 앞 8자리. */
export function shortWhere(p: string | undefined, line: number | undefined, key: string, home = os.homedir()): string {
  if (key.startsWith('rule:')) return `forgen 룰 ${key.slice(5, 13)}`;
  if (key.startsWith('replay:')) return '앞선 다른 세션의 교정';
  if (key.startsWith('evidence:')) return 'forgen 이 기록한 앞선 교정';
  if (!p) return key.split(':')[0];
  const m = /[\\/]memory[\\/](.+)$/.exec(p);
  const s = m ? `…/memory/${m[1]}` : home && p.startsWith(`${home}/`) ? `~/${path.relative(home, p).split(path.sep).slice(-3).join('/')}` : path.basename(p);
  return line ? `${s}:${line}` : s;
}

/** 시드 고정 표본: 예 무작위 10 + 아니오 점수 높은 순 10 + 모름 무작위 5. 같은 결과면 같은 표본. */
export function buildReviewSample(r: RecurrenceResult, runId: string, now = new Date()): ReviewSample {
  const all: Array<Omit<ReviewPair, 'bucket'>> = [];
  for (const it of r.items) {
    for (const p of it.pairs ?? []) {
      if (!p.verdict) continue;
      all.push({
        pairId: sha(`${it.id}|${p.tier}|${p.key}`).slice(0, 12), judge: p.verdict, ts: it.ts, gist: it.gist, utterance: it.utterance.slice(0, 300),
        memory: p.text, memoryWhere: shortWhere(p.path, p.line, p.key), memoryKind: p.kind, tier: p.tier, score: p.score,
      });
    }
  }
  const rnd = (x: { pairId: string }) => sha(`${SEED}:${x.pairId}`);
  const byRnd = (a: { pairId: string }, b: { pairId: string }) => (rnd(a) < rnd(b) ? -1 : 1);
  const yes = all.filter((x) => x.judge === 'yes').sort(byRnd).slice(0, REVIEW_QUOTA.yes).map((x) => ({ ...x, bucket: 'yes-random' as const }));
  const no = all.filter((x) => x.judge === 'no').sort((a, b) => b.score - a.score || byRnd(a, b)).slice(0, REVIEW_QUOTA.no).map((x) => ({ ...x, bucket: 'no-top-score' as const }));
  const unk = all.filter((x) => x.judge === 'unknown').sort(byRnd).slice(0, REVIEW_QUOTA.unknown).map((x) => ({ ...x, bucket: 'unknown' as const }));
  // 화면 순서는 칸을 섞는다(칸 순서가 판정자의 답을 드러내지 않게).
  const pairs = [...yes, ...no, ...unk].sort(byRnd);
  return { schema: REVIEW_SAMPLE_SCHEMA, runId, createdAt: now.toISOString(), judge: r.judge, digest: sha(JSON.stringify(pairs.map((p) => [p.pairId, p.judge]))), pairs };
}

function write600(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(p), 0o700); } catch { /* 윈도우 등 */ }
  fs.writeFileSync(p, body, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* 윈도우 등 */ }
}

/** 표본·페이지를 쓴다: review/sample-<회차>.json, review/review-<회차>.html. */
export function writeReview(): { htmlPath: string; samplePath: string; sample: ReviewSample } | { error: string } {
  const run = latestRecurrenceRun();
  if (!run) return { error: '재생 결과가 없다 — 먼저 forgen audit recurrence' };
  const sample = buildReviewSample(run.result, run.runId);
  if (!sample.pairs.length) return { error: '판정한 쌍이 없다(모델 판정 꺼짐이거나 교정이 없음)' };
  const samplePath = path.join(reviewDir(), `sample-${run.runId}.json`);
  const htmlPath = path.join(reviewDir(), `review-${run.runId}.html`);
  write600(samplePath, `${JSON.stringify(sample, null, 2)}\n`);
  const shown = { runId: sample.runId, digest: sample.digest, schema: REVIEW_ANSWERS_SCHEMA, pairs: sample.pairs.map(({ judge: _j, bucket: _b, ...rest }) => rest) };
  write600(htmlPath, htmlPage({ title: 'forgen 판정 검수', data: shown, js: JS, css: CSS }));
  return { htmlPath, samplePath, sample };
}

const CSS = `
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:0 0 10px}
.card.done{opacity:.6}
.q{font-size:13px;color:var(--muted);margin:0 0 6px}
.gist{font-weight:600;margin:0 0 4px}
.utter,.mem{white-space:pre-wrap;font-size:13px;margin:0 0 6px}
.mem{border-left:3px solid var(--line);padding-left:8px}
.where{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--muted)}
.btns{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
.btns button{padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
.btns button.on{outline:2px solid currentColor}
#bar{position:sticky;top:0;background:var(--bg, inherit);padding:8px 0;display:flex;gap:10px;align-items:center}
`;

const JS = `
(function(){
var D = JSON.parse(document.getElementById('forgen-data').textContent);
var view = document.getElementById('view');
${DOM_HELPERS_JS}
var A = {};
document.getElementById('meta').textContent = '회차 ' + D.runId + ' · 쌍 ' + D.pairs.length + '개 · 판정자의 답은 숨겼습니다 · 이 파일은 내 컴퓨터에서만 열리며 밖으로 아무것도 보내지 않습니다';
var count = el('span',{text:''});
var dl = el('button',{text:'답 저장(JSON 내려받기)'});
var bar = el('div',{id:'bar'},[count, dl, el('span',{cls:'where',text:'저장한 파일: forgen audit review --import <파일>'})]);
view.appendChild(bar);
function upd(){ var n=Object.keys(A).length; count.textContent = n + ' / ' + D.pairs.length + ' 답함'; }
var LBL = [['same','같은 뜻(기억이 이미 지시함)'],['different','다름'],['unsure','모르겠음']];
D.pairs.forEach(function(p, i){
  var card = el('div',{cls:'card'});
  card.appendChild(el('p',{cls:'q',text:(i+1)+'. 이 교정이 고치려는 행동을, 아래 기억이 그 시점('+String(p.ts).slice(0,10)+')에 이미 지시하고 있었나?'}));
  card.appendChild(el('p',{cls:'gist',text:'교정 요지: '+p.gist}));
  card.appendChild(el('p',{cls:'utter',text:'발화: '+p.utterance}));
  card.appendChild(el('p',{cls:'mem',text:p.memory}));
  card.appendChild(el('p',{cls:'where',text:p.memoryWhere+' · '+(p.tier==='earlier'?'앞선 교정':'기억')}));
  var btns = el('div',{cls:'btns'});
  LBL.forEach(function(l){ var b=el('button',{text:l[1]}); b.onclick=function(){ A[p.pairId]=l[0]; Array.prototype.forEach.call(btns.children,function(x){x.classList.remove('on');}); b.classList.add('on'); card.classList.add('done'); upd(); }; btns.appendChild(b); });
  card.appendChild(btns);
  view.appendChild(card);
});
dl.onclick = function(){
  var body = JSON.stringify({ schema: D.schema, runId: D.runId, digest: D.digest, answeredAt: new Date().toISOString(), answers: A }, null, 2);
  var url = URL.createObjectURL(new Blob([body], {type:'application/json'}));
  var a = el('a',{href:url, download:'forgen-review-'+D.runId+'.json'}); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
};
upd();
})();
`;


/** 가장 최근 `forgen audit` 회차 중 모델 판정 검사가 붙은 것. */
export function latestAuditRun(): { runId: string; result: AuditResult } | null {
  const base = path.join(FORGEN_HOME, 'audit');
  let names: string[] = [];
  try { names = fs.readdirSync(base).filter((n) => /^\d{8}T\d{6}Z-/.test(n)).sort().reverse(); } catch { return null; }
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(base, n, 'result.json'), 'utf-8')) as AuditResult;
      if (r.checks?.model) return { runId: n, result: r };
    } catch { /* result.json 이 없는 회차(0.9.0 C1)·깨진 회차 */ }
  }
  return null;
}

const KIND_VERDICT = (kind: ReviewKind, v: string | null): PairVerdict | null => {
  if (kind !== 'mix') return v === 'yes' || v === 'no' || v === 'unknown' ? v : null;
  return v === 'project' ? 'yes' : v === 'general' ? 'no' : v === 'unknown' ? 'unknown' : null;
};

/**
 * 지시 검사 표본(N2): 같은 칸 구성(예 무작위 10 · 아니오 중 후보 점수 높은 10 · 모름 5, 시드 고정)·같은 답 파일 형식.
 * 회차 이름을 "<종류>-<감사 회차>" 로 해서 N4 표본·답(sample-<회차>.json)과 섞이지 않고, import·score 는 그대로 쓴다.
 */
export function buildKindSample(kind: ReviewKind, mc: ModelChecks, auditRunId: string, home = os.homedir(), now = new Date()): ReviewSample {
  const where = (x: { ruleId?: string; path: string; line: number }) => shortWhere(x.path, x.line, x.ruleId ? `rule:${x.ruleId}` : 'md', home);
  const all: Array<Omit<ReviewPair, 'bucket'>> = [];
  if (kind === 'mix') {
    for (const m of mc.mix) {
      const judge = KIND_VERDICT(kind, m.verdict);
      if (!judge) continue;
      all.push({ pairId: m.id, judge, ts: '', gist: m.text, utterance: '', memory: m.judgedProject ?? m.project ?? '', memoryWhere: where(m), memoryKind: m.layer, tier: 'mix', score: m.why.length });
    }
  } else {
    for (const p of kind === 'dup' ? mc.dup : mc.conflict) {
      const judge = KIND_VERDICT(kind, p.verdict);
      if (!judge) continue;
      all.push({ pairId: p.id, judge, ts: '', gist: p.a.text, utterance: '', memory: p.b.text, memoryWhere: where(p.b), whereA: where(p.a), memoryKind: p.b.layer, tier: kind, score: p.score });
    }
  }
  const rnd = (x: { pairId: string }) => sha(`${SEED}:${kind}:${x.pairId}`);
  const byRnd = (a: { pairId: string }, b: { pairId: string }) => (rnd(a) < rnd(b) ? -1 : 1);
  const yes = all.filter((x) => x.judge === 'yes').sort(byRnd).slice(0, REVIEW_QUOTA.yes).map((x) => ({ ...x, bucket: 'yes-random' as const }));
  const no = all.filter((x) => x.judge === 'no').sort((a, b) => b.score - a.score || byRnd(a, b)).slice(0, REVIEW_QUOTA.no).map((x) => ({ ...x, bucket: 'no-top-score' as const }));
  const unk = all.filter((x) => x.judge === 'unknown').sort(byRnd).slice(0, REVIEW_QUOTA.unknown).map((x) => ({ ...x, bucket: 'unknown' as const }));
  const pairs = [...yes, ...no, ...unk].sort(byRnd);
  const version = mc.judge.versions[kind];
  return { schema: REVIEW_SAMPLE_SCHEMA, runId: `${kind}-${auditRunId}`, createdAt: now.toISOString(), judge: { check: { kind, model: mc.judge.model, version } }, digest: sha(JSON.stringify(pairs.map((p) => [p.pairId, p.judge]))), pairs, kind };
}

export function writeKindReview(kind: ReviewKind): { htmlPath: string; samplePath: string; sample: ReviewSample } | { error: string } {
  const run = latestAuditRun();
  if (!run?.result.checks.model) return { error: '모델 판정 검사가 붙은 감사 회차가 없다 — 먼저 forgen audit (--no-model 없이)' };
  const sample = buildKindSample(kind, run.result.checks.model, run.runId);
  if (!sample.pairs.length) return { error: `판정한 ${kind} 후보가 없다` };
  const samplePath = path.join(reviewDir(), `sample-${sample.runId}.json`);
  const htmlPath = path.join(reviewDir(), `review-${sample.runId}.html`);
  write600(samplePath, `${JSON.stringify(sample, null, 2)}\n`);
  const shown = { runId: sample.runId, digest: sample.digest, schema: REVIEW_ANSWERS_SCHEMA, kind, pairs: sample.pairs.map(({ judge: _j, bucket: _b, ...rest }) => rest) };
  write600(htmlPath, htmlPage({ title: `forgen 판정 검수 — ${KIND_TITLE[kind]}`, data: shown, js: KIND_JS, css: CSS }));
  return { htmlPath, samplePath, sample };
}

const KIND_TITLE: Record<ReviewKind, string> = { dup: '같은 뜻 중복', conflict: '부딪힘', mix: '다른 프로젝트 섞임' };

const KIND_JS = `
(function(){
var D = JSON.parse(document.getElementById('forgen-data').textContent);
var view = document.getElementById('view');
${DOM_HELPERS_JS}
var A = {};
var Q = {
  dup: ['두 지시가 같은 뜻인가 — 하나만 남겨도 잃는 지시가 없나?', [['same','같은 뜻(하나만 남겨도 됨)'],['different','다름(둘 다 필요)'],['unsure','모르겠음']]],
  conflict: ['두 지시를 동시에 지킬 수 없나 — 하나를 지키면 다른 하나를 어기게 되나?', [['same','부딪힘(동시에 못 지킴)'],['different','둘 다 지킬 수 있음'],['unsure','모르겠음']]],
  mix: ['모든 프로젝트에 실리는 이 지시는 아래 프로젝트에서만 뜻이 있나?', [['same','그 프로젝트 전용(섞임)'],['different','어디서나 통하는 일반 원칙'],['unsure','모르겠음']]]
}[D.kind];
document.getElementById('meta').textContent = '회차 ' + D.runId + ' · ' + D.pairs.length + '개 · 판정자의 답은 숨겼습니다 · 이 파일은 내 컴퓨터에서만 열리며 밖으로 아무것도 보내지 않습니다';
var count = el('span',{text:''});
var dl = el('button',{text:'답 저장(JSON 내려받기)'});
view.appendChild(el('div',{id:'bar'},[count, dl, el('span',{cls:'where',text:'저장한 파일: forgen audit review --import <파일>'})]));
function upd(){ count.textContent = Object.keys(A).length + ' / ' + D.pairs.length + ' 답함'; }
D.pairs.forEach(function(p, i){
  var card = el('div',{cls:'card'});
  card.appendChild(el('p',{cls:'q',text:(i+1)+'. '+Q[0]}));
  if (D.kind === 'mix') {
    card.appendChild(el('p',{cls:'mem',text:p.gist}));
    card.appendChild(el('p',{cls:'gist',text:'프로젝트: '+(p.memory||'(짐작 없음)')}));
    card.appendChild(el('p',{cls:'where',text:p.memoryWhere}));
  } else {
    card.appendChild(el('p',{cls:'mem',text:'A: '+p.gist}));
    card.appendChild(el('p',{cls:'where',text:p.whereA||''}));
    card.appendChild(el('p',{cls:'mem',text:'B: '+p.memory}));
    card.appendChild(el('p',{cls:'where',text:p.memoryWhere}));
  }
  var btns = el('div',{cls:'btns'});
  Q[1].forEach(function(l){ var b=el('button',{text:l[1]}); b.onclick=function(){ A[p.pairId]=l[0]; Array.prototype.forEach.call(btns.children,function(x){x.classList.remove('on');}); b.classList.add('on'); card.classList.add('done'); upd(); }; btns.appendChild(b); });
  card.appendChild(btns);
  view.appendChild(card);
});
dl.onclick = function(){
  var body = JSON.stringify({ schema: D.schema, runId: D.runId, digest: D.digest, answeredAt: new Date().toISOString(), answers: A }, null, 2);
  var url = URL.createObjectURL(new Blob([body], {type:'application/json'}));
  var a = el('a',{href:url, download:'forgen-review-'+D.runId+'.json'}); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
};
upd();
})();
`;

export interface ReviewAnswers { schema: typeof REVIEW_ANSWERS_SCHEMA; runId: string; digest: string; answeredAt: string; answers: Record<string, OwnerAnswer> }

function readSample(runId: string): ReviewSample | null {
  try { return JSON.parse(fs.readFileSync(path.join(reviewDir(), `sample-${runId}.json`), 'utf-8')) as ReviewSample; } catch { return null; }
}

/** 내려받은 답 파일을 검사하고 review/answers-<회차>-<시각>.json 으로 넣는다. */
export function importReview(file: string, now = new Date()): { path: string; answered: number } {
  let a: ReviewAnswers;
  try { a = JSON.parse(fs.readFileSync(file, 'utf-8')) as ReviewAnswers; } catch (e) { throw new Error(`답 파일을 읽지 못함: ${file} (${e instanceof Error ? e.message : String(e)})`); }
  if (a?.schema !== REVIEW_ANSWERS_SCHEMA || typeof a.runId !== 'string' || !a.answers || typeof a.answers !== 'object') throw new Error('forgen 검수 답 파일이 아니다');
  if (!/^[A-Za-z0-9-]+$/.test(a.runId)) throw new Error(`회차 이름이 이상하다: ${a.runId}`);
  const sample = readSample(a.runId);
  if (!sample) throw new Error(`이 회차의 검수 표본이 없다: ${a.runId} — forgen audit review 로 만든 페이지의 답인지 확인`);
  if (sample.digest !== a.digest) throw new Error('표본이 바뀌었다(다른 페이지의 답) — 지금 표본으로 다시 검수');
  const ids = new Set(sample.pairs.map((p) => p.pairId));
  const answers: Record<string, OwnerAnswer> = {};
  for (const [k, v] of Object.entries(a.answers)) if (ids.has(k) && (v === 'same' || v === 'different' || v === 'unsure')) answers[k] = v;
  if (!Object.keys(answers).length) throw new Error('맞는 답이 하나도 없다');
  const out = path.join(reviewDir(), `answers-${a.runId}-${now.toISOString().replace(/[-:.]/g, '')}.json`);
  write600(out, `${JSON.stringify({ ...a, answers, importedAt: now.toISOString() }, null, 2)}\n`);
  return { path: out, answered: Object.keys(answers).length };
}

export interface ReviewScore {
  runId: string;
  answered: number;
  /** 예·아니오 쌍 중 오너도 판정한(모르겠음 제외) 것 */
  compared: number;
  agree: number;
  agreement: number | null;
  yes: { compared: number; agree: number };
  no: { compared: number; agree: number };
  /** 판정자 "모름" 쌍에 오너가 낸 답 */
  unknown: Record<OwnerAnswer, number>;
  ownerUnsure: number;
  pass: boolean | null;
  judge: ReviewSample['judge'];
}

/** 회차마다 가장 최근에 넣은 답으로 판정자-오너 일치율. */
export function scoreReviews(): ReviewScore[] {
  let names: string[] = [];
  try { names = fs.readdirSync(reviewDir()).filter((n) => /^answers-.*\.json$/.test(n)).sort(); } catch { return []; }
  const latest = new Map<string, ReviewAnswers>();
  for (const n of names) {
    try { const a = JSON.parse(fs.readFileSync(path.join(reviewDir(), n), 'utf-8')) as ReviewAnswers; latest.set(a.runId, a); } catch { /* 깨진 파일 */ }
  }
  const out: ReviewScore[] = [];
  for (const [runId, a] of latest) {
    const sample = readSample(runId);
    if (!sample) continue;
    const s: ReviewScore = { runId, answered: 0, compared: 0, agree: 0, agreement: null, yes: { compared: 0, agree: 0 }, no: { compared: 0, agree: 0 }, unknown: { same: 0, different: 0, unsure: 0 }, ownerUnsure: 0, pass: null, judge: sample.judge };
    for (const p of sample.pairs) {
      const o = a.answers[p.pairId];
      if (!o) continue;
      s.answered++;
      if (p.judge === 'unknown') { s.unknown[o]++; continue; }
      if (o === 'unsure') { s.ownerUnsure++; continue; }
      const agree = (p.judge === 'yes') === (o === 'same');
      const bucket = p.judge === 'yes' ? s.yes : s.no;
      bucket.compared++; s.compared++;
      if (agree) { bucket.agree++; s.agree++; }
    }
    s.agreement = s.compared ? Math.round((s.agree / s.compared) * 1000) / 1000 : null;
    s.pass = s.agreement === null ? null : s.agreement >= AGREEMENT_TARGET;
    out.push(s);
  }
  return out.sort((x, y) => (x.runId < y.runId ? -1 : 1));
}
