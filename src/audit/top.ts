/**
 * 감사 첫 화면 맨 위 "가장 중요한 발견"(0.9.1 #4·#12·#13)과 끝의 "다음에 할 일"(#6).
 * 발견 하나 = 장면 한 문장: "무엇이 어떻게 어긋남 → 이대로면 AI 가 어떻게 됨 → 처방" + 근거(사용자 실제 교정 인용 또는 "파일 비교").
 * 순서(근거 있는 것 먼저): 부딪힘 확정 > 적혀 있는데도 또 말한 교정 > 다른 프로젝트 섞임 확정 > 빠진 중요 지침 > 없는 것을 가리킴 > 같은 뜻 중복. 종류마다 하나, 최대 3개.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Rule } from '../store/types.js';
import { fixId, ident, importantMissing, baselinePath } from './fix.js';
import { shortPath } from './html.js';
import { maskQuote } from './quote.js';
import { judgeChanges, latestRecurrence, STALE_JUDGE_NOTE } from './recurrence.js';
import { unitKey, type AuditRun } from './run.js';
import type { Unit } from './checks.js';

const KIND: Record<string, string> = { 'forgen-rule': 'forgen 룰', 'memory-topic': '메모 파일', 'memory-index': 'MEMORY.md', 'host-md': '지침 파일' };
const REASON: Record<string, string> = {
  scope: '다른 폴더 전용으로 적혀 있어서', 'budget-or-other': '세션 시작에 넣는 forgen 룰 분량 상한 때문에 빠져서', 'topic-only': '메모 파일 본문에만 있어(세션 시작에 안 실림)', truncated: 'MEMORY.md 상한(200줄·25KB) 뒤에 있어서',
  'other-folder': '다른 폴더 기억에 있어서', conditional: '특정 파일을 다룰 때만 실리는 룰이라', 'tier2-missed': '상황 맞춤 룰인데 그때 안 들어와서',
};

export interface Finding { kind: 'conflict' | 'repeat' | 'mix' | 'missing' | 'stale' | 'dup'; scene: string; effect: string; fix: string; evidence: string }

export function renderFinding(f: Finding): string {
  return `${f.scene} → 이대로면 ${f.effect} → 처방: ${f.fix}\n     근거: ${f.evidence}`;
}

const where = (x: { ruleId?: string; path: string; line: number }) => (x.ruleId ? 'forgen 룰' : `${shortPath(x.path)}:${x.line}`);
/** 이름(짧게): 파일은 이름:줄, forgen 룰은 앞 8자 id. */
const nameOf = (x: { ruleId?: string; path: string; line: number }) => (x.ruleId ? `forgen 룰 ${x.ruleId.slice(0, 8)}` : `${path.basename(x.path)}:${x.line}`);
/** 그 지시가 마지막으로 쓰인 날: 파일은 git 마지막 커밋 날(git 밖이면 수정 시각), forgen 룰은 만든 날. */
function dateOf(x: { ruleId?: string; path: string }, rules: Map<string, Rule>): { at: string; verb: string } | null {
  if (x.ruleId) { const r = rules.get(x.ruleId); return r?.created_at ? { at: r.created_at, verb: '만듦' } : null; }
  try {
    const out = spawnSync('git', ['log', '-1', '--format=%cI', '--', path.basename(x.path)], { cwd: path.dirname(x.path), encoding: 'utf-8', timeout: 5000 });
    const iso = out.status === 0 ? out.stdout.trim() : '';
    if (iso) {
      // 커밋 뒤 손으로 고쳤으면 수정 시각이 더 최근이다
      const m = fs.statSync(x.path).mtime.toISOString();
      const c = new Date(iso).toISOString();
      return { at: m > c ? m : c, verb: '고침' };
    }
    return { at: fs.statSync(x.path).mtime.toISOString(), verb: '고침' };
  } catch { return null; }
}
const qq = (t: string, n = 50) => `"${maskQuote(t.replace(/^\s*[-*]\s+/, ''), n)}"`;

export function findings(run: AuditRun): Finding[] {
  const r = run.result;
  const ctx = run.ctx;
  const byKey = new Map<string, Unit>();
  for (const u of [...ctx.units, ...ctx.topics]) byKey.set(unitKey(u), u);
  const out: Finding[] = [];
  const m = r.checks.model;
  // 1. 부딪힘(모델 판정 "예")
  const conflict = (m?.conflict ?? []).filter((p) => p.verdict === 'yes').sort((a, b) => b.score - a.score)[0];
  if (conflict) {
    const md = [conflict.a, conflict.b].find((x) => !x.ruleId);
    const rule = [conflict.a, conflict.b].find((x) => x.ruleId);
    const [na, nb] = [nameOf(conflict.a), nameOf(conflict.b)];
    // 모델 설명의 라벨 A·B(판정기가 호출 순서로 맞춤)를 이름으로 바꾼다
    const why = conflict.reason ? maskQuote(conflict.reason.replace(/(^|[^A-Za-z])([AB])(?![A-Za-z])/g, (_m, pre: string, l: string) => `${pre}${l === 'A' ? na : nb}`), 90) : '';
    // 어느 쪽이 낡았나: 파일은 git 마지막 수정일(없으면 수정 시각), forgen 룰은 만든 날 — 더 최근 쪽을 지금 사실로 본다
    const da = dateOf(conflict.a, ctx.rules);
    const db = dateOf(conflict.b, ctx.rules);
    let fix = `낡은 쪽만 고치세요 — ${[md ? `파일이면 ${where(md)} 를 직접 고치고` : '', rule ? `forgen 룰이면 forgen rule suppress ${(rule.ruleId as string).slice(0, 8)} 로 끕니다` : ''].filter(Boolean).join(', ')}(forgen 이 자동으로 고치지 않음)`;
    if (da && db && da.at.slice(0, 10) !== db.at.slice(0, 10)) {
      const [old, cur] = da.at < db.at ? [{ x: conflict.a, d: da, n: na }, { x: conflict.b, d: db, n: nb }] : [{ x: conflict.b, d: db, n: nb }, { x: conflict.a, d: da, n: na }];
      fix = `${old.n}(${old.d.at.slice(0, 10)} ${old.d.verb})이 ${cur.n}(${cur.d.at.slice(0, 10)} ${cur.d.verb})보다 오래돼 낡았을 가능성이 큽니다 → ${old.x.ruleId ? `forgen rule suppress ${old.x.ruleId.slice(0, 8)}` : `${where(old.x)} 를 직접 고치세요`}`;
    }
    out.push({
      kind: 'conflict',
      scene: `${na} 은 ${qq(conflict.a.text)}, ${nb} 은 ${qq(conflict.b.text)} — 서로 맞지 않습니다${why ? `(${why})` : ''}`,
      effect: 'AI 가 둘 중 아무거나 따르거나 낡은 쪽을 사실로 믿습니다',
      fix,
      evidence: da && db ? `파일 비교(모델 판정) · 날짜: ${na} ${da.at.slice(0, 10)} ${da.verb}, ${nb} ${db.at.slice(0, 10)} ${db.verb}` : '파일 비교(모델 판정)',
    });
  }
  // 2. 적혀 있는데도 또 말한 교정(가장 최근)
  const rec = latestRecurrence();
  const rep = (rec?.items ?? []).filter((it) => (it.branch === 'ignored' || it.branch === 'not-loaded') && it.match).sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
  if (rep?.match) {
    const nowLoaded = rep.match.ruleId ? (ctx.loadedIn.get(`${rep.match.ruleId}:0`) ?? []).length > 0 : false;
    const why = rep.branch === 'ignored' ? '그 세션에 실렸는데도' : REASON[rep.match.reason ?? ''] ?? '그 세션에 안 실려서';
    out.push({
      kind: 'repeat',
      scene: `${KIND[rep.match.kind] ?? '기억'}에 ${qq(rep.match.text)} 로 이미 적혀 있는데, ${why} 같은 교정을 다시 했습니다`,
      effect: '같은 말을 또 해야 합니다',
      fix: rep.branch === 'ignored'
        ? '룰 문장을 더 분명하게 고치세요(forgen rule list 에서 찾아 수정)'
        : nowLoaded ? '지금은 세션 시작에 실립니다(0.9.1 부터 직접 교정은 분량 상한 때문에 먼저 빠지지 않음 — 그래도 넘치면 세션 시작 블록에 빠진 수를 적음) — forgen audit recurrence 로 다시 재서 확인' : 'forgen fix --list 에서 이 기억을 다루는 처방을 보세요',
      evidence: `${rep.ts.slice(0, 10)} 내가 한 말 "${maskQuote(rep.utterance || rep.gist, 80)}"${rec && judgeChanges(rec).length ? ` · ${STALE_JUDGE_NOTE}` : ''}`,
    });
  }
  // 3. 다른 프로젝트 섞임(모델 판정 "프로젝트 전용")
  const mix = (m?.mix ?? []).find((x) => x.verdict === 'project' && x.judgedProject);
  if (mix) {
    const u = byKey.get(unitKey(mix));
    const id = u ? fixId(mix.ruleId ? 'scope' : 'move', ident(u)) : null;
    out.push({
      kind: 'mix',
      scene: `${where(mix)} 의 ${qq(mix.text)} 는 ${mix.judgedProject} 에서만 뜻이 있는데 모든 프로젝트 세션에 실립니다`,
      effect: '다른 프로젝트 작업에서도 AI 가 이 지시를 따르려 듭니다',
      fix: id ? `forgen fix ${id} --apply (${mix.judgedProject} 에서만 실리게)` : 'forgen fix --list 에서 범위 옮기기',
      evidence: mix.reason ? `파일 비교(모델 판정: ${maskQuote(mix.reason, 60)})` : '파일 비교(모델 판정)',
    });
  }
  // 4. 그 폴더의 중요 지침이 안 실림
  const miss = importantMissing(run).filter((x) => x.rules.length).sort((a, b) => b.rules.length - a.rules.length)[0];
  if (miss) {
    out.push({
      kind: 'missing',
      scene: `${shortPath(miss.folder)} 세션에 직접 교정한 중요 지침 ${miss.rules.length}개가 안 실립니다(예 ${qq(miss.rules[0].policy)})`,
      effect: '이미 한 교정을 또 말해야 합니다',
      fix: 'forgen rule list 로 확인 — 그 폴더에 맞는 룰인지 보고 범위를 고치세요',
      evidence: '세션 시작 블록 비교',
    });
  }
  // 5. 지금 없는 것을 가리킴
  const stale = r.checks.stale[0];
  if (stale) {
    const u = byKey.get(unitKey(stale));
    out.push({
      kind: 'stale',
      scene: `${where(stale)} 의 ${qq(stale.text)} 가 지금 없는 ${stale.ref} 를 가리킵니다`,
      effect: 'AI 가 없는 파일·명령을 찾거나 고치려 듭니다',
      fix: u && u.layer !== 'memory-index' ? `forgen fix ${fixId('remove', ident(u))} --apply (그 줄을 지움)` : '그 줄의 경로를 직접 고치세요',
      evidence: '파일 비교(가리키는 파일이 디스크에 없음)',
    });
  }
  // 6. 같은 뜻 중복
  const dup = (m?.dup ?? []).filter((p) => p.verdict === 'yes').sort((a, b) => b.score - a.score)[0];
  if (dup && m) {
    out.push({
      kind: 'dup',
      scene: `같은 뜻 지시가 ${m.counts.dupGroups}묶음 있습니다(예 ${where(dup.a)} ${qq(dup.a.text, 40)} ↔ ${where(dup.b)} ${qq(dup.b.text, 40)})`,
      effect: '같은 내용이 세션마다 여러 번 실려 자리를 차지합니다',
      fix: 'forgen fix --list 의 "합치기"에서 골라 적용',
      evidence: '파일 비교(모델 판정)',
    });
  }
  return out.slice(0, 3);
}

export function nextSteps(run: AuditRun): string[] {
  const r = run.result;
  const out = ['forgen fix --list — 처방을 추천 순서(되돌리기 쉬운 것부터)로 봅니다'];
  const c = r.summary.findings.conflicts;
  if (typeof c === 'number' && c > 0) out.push(`서로 부딪히는 지시 ${c}쌍은 forgen 이 고치지 않습니다 — 위 "가장 중요한 발견"의 파일을 직접 정리하세요`);
  if (r.summary.recurrence.status === 'none') out.push('forgen audit recurrence — 지난 30일 대화 기록에서 같은 말을 다시 한 횟수를 잽니다');
  else if (r.summary.recurrence.staleJudge?.length) out.push('forgen audit recurrence — 저장된 같은 말 다시 하기 값이 이전 판정 방식이라 지금 방식으로 다시 잽니다');
  else if (fs.existsSync(baselinePath())) out.push('forgen fix --report — 처방 전후 세션 시작 토큰과 빠진 중요 지침을 봅니다');
  return out.slice(0, 3);
}

const KIND_NAME: Record<Finding['kind'], string> = {
  conflict: '서로 부딪히는 지시', repeat: '적혀 있는데 또 말한 교정', mix: '다른 프로젝트 지시가 섞임', missing: '중요 지침이 안 실림', stale: '없는 파일·명령을 가리키는 줄', dup: '같은 뜻 지시 중복',
};

/**
 * 0.9.1 #14 공유용 요약: 숫자와 발견 유형만 — 경로·폴더·프로젝트 이름·기억 본문·인용은 넣지 않는다.
 * 터미널 텍스트와 붙여 넣기 좋은 마크다운 두 가지.
 */
export function shareSummary(run: AuditRun): { text: string[]; markdown: string } {
  const r = run.result;
  const f = r.summary.findings;
  const rec = r.summary.recurrence;
  const kinds = findings(run).map((x) => KIND_NAME[x.kind]);
  const pct = (per1000: number) => `${Math.round(per1000) / 10}%`;
  const rng = (lo: number, hi?: number) => (hi === undefined || pct(lo) === pct(hi) ? pct(lo) : `${pct(Math.min(lo, hi))}~${pct(Math.max(lo, hi))}`);
  const lines = [
    rec.staleJudge?.length ? '같은 말 다시 하기: 이전 판정 방식으로 잰 값이라 뺌(다시 재야 함)'
    : rec.status !== 'none' && rec.per1000
      ? `내 요청 중 같은 교정을 다시 한 비율 ${rng(rec.per1000.total, rec.lenient?.per1000.total)} · 그중 이미 적혀 있던 것 ${rng(rec.per1000.written, rec.lenient?.per1000.written)}${rec.lenient ? '(판정 기준에 따라 범위)' : rec.ci95 ? `(오차 범위 ${pct(rec.ci95[0])}~${pct(rec.ci95[1])})` : ''}${rec.sampled ? ' · 표본으로 잰 참고값' : ''}`
      : '같은 말 다시 하기: 아직 재지 않음',
    `세션 시작에 늘 실리는 기억 약 ${Math.round(representativeTokens(r) / 100) * 100}토큰(자주 쓰는 폴더 평균, 백 단위)`,
    f.conflicts === 'pending' ? `같은 문장 ${f.sameSentence}묶음 · 없는 것을 가리키는 줄 ${f.stale}개 (모델 판정 꺼짐)`
      : `서로 부딪히는 지시 ${f.conflicts}쌍 · 같은 뜻 중복 ${f.dupGroups}묶음 · 다른 프로젝트 지시 섞임 ${f.mixConfirmed}개 · 같은 문장 ${f.sameSentence}묶음 · 없는 것을 가리키는 줄 ${f.stale}개`,
    `MEMORY.md 상한에 잘린 곳 ${r.summary.truncation.truncated}곳 (메모 폴더 ${r.summary.truncation.memoryDirs}곳 중)`,
    ...(kinds.length ? [`가장 중요한 발견 유형: ${kinds.join(' · ')}`] : []),
    'forgen audit(읽기만 함, 아무것도 보내지 않음)으로 잰 값',
  ];
  return { text: lines, markdown: ['**forgen 감사 요약**', '', ...lines.map((l) => `- ${l}`)].join('\n') };
}

function representativeTokens(r: AuditRun['result']): number {
  const active = r.folders.filter((x) => (x.sessions30d ?? 0) >= 3);
  const use = active.length ? active : r.folders;
  const w = active.length ? use.reduce((n, x) => n + (x.sessions30d ?? 0), 0) : use.length;
  return w ? Math.round(use.reduce((n, x) => n + x.totalTokens * (active.length ? (x.sessions30d ?? 0) : 1), 0) / w) : 0;
}

export function attachTop(run: AuditRun): void {
  run.result.summary.top = { findings: findings(run).map(renderFinding), next: nextSteps(run) };
}
