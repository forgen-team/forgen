/**
 * 모델 판정 검사 (docs/plans/2026-11-25-v1.0-plan.md §4.1 중 모델이 필요한 것, §2.4, §1.2 N2).
 *
 *   같은 뜻 중복  지시마다 어휘 후보 상위 5(글자 2-gram, 같은 폴더에 함께 실리는 것만) → Haiku "하나만 남겨도 잃는 것이 없는가"
 *   부딪힘        같은 주제 후보 중 부정 표지(src/way/conflict.ts)의 극성이 다른 쌍 → Haiku "동시에 지킬 수 없는가"
 *   섞임 확정     C1 의 섞임 후보(전역 층) → Haiku "한 프로젝트에서만 뜻이 있나, 일반 원칙인가" — 일반 원칙이면 섞임 아님
 *
 * 판정기·캐시·판본은 judge.ts 를 그대로 쓴다(새 판정기 없음). 후보 고르기는 결정적이고, 같은 원천·같은 캐시면 같은 결과.
 * 홈 폴더의 메모 색인(MEMORY.md)은 홈에서 연 세션에만 실려(§3.1 의 "전역"은 사용자 CLAUDE.md·사용자 룰·forgen 전역 룰) 섞임 판정에 보내지 않는다.
 * forgen 룰과 메모 주제 파일(feedback)의 같은 뜻은 처방 "겹치는 교정 한 곳만"(Q4)의 근거라 주제 파일도 후보에 넣는다.
 */
import { isNeg } from '../way/conflict.js';
import { bigrams, topK } from './lexical.js';
import { CHECK_MODEL, CONFLICT_PROMPT_VERSION, DUP_PROMPT_VERSION, MIX_PROMPT_VERSION, type CheckVerdict, type Judge, type MixVerdict } from './judge.js';
import type { MixCandidate, Unit, UnitLayer } from './checks.js';
import { unitKey, type AuditContext, type AuditResult } from './run.js';
import { createHash } from 'node:crypto';

/** 후보 수·하한(사전 등록 — 바꾸면 결과가 바뀌므로 manifest 에 남는다). */
export const DUP_TOP = 5;
export const DUP_MIN = 0.3;
export const CONFLICT_TOP = 5;
export const CONFLICT_MIN = 0.2;
const MIN_NORM = 12;

export interface CheckLoc { key: string; path: string; line: number; layer: UnitLayer; ruleId?: string; text: string; tokens: number; memoryType?: string }
export interface PairFinding {
  id: string;
  kind: 'dup' | 'conflict';
  a: CheckLoc;
  b: CheckLoc;
  score: number;
  /** 둘이 함께 실리는 폴더(주제 파일 쌍은 forgen 룰이 실리는 폴더) */
  folders: string[];
  verdict: CheckVerdict['answer'] | null;
  reason: string;
}
export interface MixFinding extends MixCandidate {
  id: string;
  verdict: MixVerdict['answer'] | null;
  /** 판정자가 고친 프로젝트 키(없으면 후보의 짐작) */
  judgedProject: string | null;
  reason: string;
  /** 홈 메모 색인 줄 — 홈 세션에만 실려 판정에 보내지 않음 */
  skipped?: 'home-memory';
}
export interface ModelChecks {
  judge: { model: string; versions: { dup: string; conflict: string; mix: string }; dup: { top: number; min: number }; conflict: { top: number; min: number } };
  status: 'ok' | 'incomplete';
  statusNote: string;
  dup: PairFinding[];
  conflict: PairFinding[];
  mix: MixFinding[];
  /** 확정 지적 수: 같은 뜻 중복은 묶음 수(yes 쌍을 이은 것), 부딪힘은 yes 쌍 수, 섞임은 project 판정 수 */
  counts: { dupGroups: number; dupPairs: number; conflicts: number; mixConfirmed: number; unknown: number };
  /** 같은 뜻 묶음(단위 키 목록) */
  dupGroups: string[][];
  candidates: { dup: number; conflict: number; mix: number };
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const loc = (u: Unit): CheckLoc => ({ key: unitKey(u), path: u.path, line: u.line, layer: u.layer, ...(u.ruleId ? { ruleId: u.ruleId } : {}), text: u.text, tokens: u.tokens, ...(u.memoryType ? { memoryType: u.memoryType } : {}) });
const owner = (u: { ruleId?: string; path: string }) => u.ruleId ?? u.path;

/** 결정적 후보 고르기 — 모델을 부르지 않는다. */
export function pairCandidates(ctx: AuditContext): { dup: Omit<PairFinding, 'verdict' | 'reason'>[]; conflict: Omit<PairFinding, 'verdict' | 'reason'>[] } {
  const units = ctx.units.filter((u) => u.norm.length >= MIN_NORM && (ctx.loadedIn.get(unitKey(u))?.length ?? 0) > 0);
  const feedbackTopics = ctx.topics.filter((t) => t.memoryType === 'feedback' && t.norm.length >= MIN_NORM);
  const grams = new Map<string, Set<string>>();
  const g = (u: Unit) => { const k = unitKey(u); let x = grams.get(k); if (!x) { x = bigrams(u.norm); grams.set(k, x); } return x; };
  const foldersOf = (u: Unit) => ctx.loadedIn.get(unitKey(u)) ?? [];
  const together = (a: Unit, b: Unit) => {
    if (a.layer === 'memory-topic') return foldersOf(b);
    if (b.layer === 'memory-topic') return foldersOf(a);
    const fb = new Set(foldersOf(b));
    return foldersOf(a).filter((f) => fb.has(f)).sort();
  };
  const dup = new Map<string, Omit<PairFinding, 'verdict' | 'reason'>>();
  const conflict = new Map<string, Omit<PairFinding, 'verdict' | 'reason'>>();
  const add = (m: typeof dup, kind: 'dup' | 'conflict', a: Unit, b: Unit, score: number) => {
    const [x, y] = [a, b].sort((p, q) => (unitKey(p) < unitKey(q) ? -1 : 1));
    const id = `${kind}-${sha(`${unitKey(x)}|${unitKey(y)}`).slice(0, 10)}`;
    if (m.has(id)) return;
    const folders = together(x, y);
    if (!folders.length) return;
    m.set(id, { id, kind, a: loc(x), b: loc(y), score, folders });
  };
  const rules = units.filter((u) => u.layer === 'forgen-rule');
  for (const u of units) {
    const others = units.filter((o) => owner(o) !== owner(u) && o.norm !== u.norm);
    for (const { item, score } of topK(g(u), others, DUP_TOP, g, unitKey)) if (score >= DUP_MIN) add(dup, 'dup', u, item, score);
    const opposite = others.filter((o) => isNeg(o.text) !== isNeg(u.text));
    for (const { item, score } of topK(g(u), opposite, CONFLICT_TOP, g, unitKey)) if (score >= CONFLICT_MIN) add(conflict, 'conflict', u, item, score);
  }
  // forgen 룰 ↔ 메모 주제 파일(feedback): 겹치는 교정(Q4)의 근거
  for (const t of feedbackTopics) {
    for (const { item, score } of topK(g(t), rules, DUP_TOP, g, unitKey)) if (score >= DUP_MIN) add(dup, 'dup', t, item, score);
  }
  const sortById = (xs: Iterable<Omit<PairFinding, 'verdict' | 'reason'>>) => [...xs].sort((p, q) => (p.id < q.id ? -1 : 1));
  return { dup: sortById(dup.values()), conflict: sortById(conflict.values()) };
}

export function mixId(c: { ruleId?: string; path: string; line: number; text: string }): string {
  return `mix-${sha(`${c.ruleId ?? c.path}|${c.line}|${c.text}`).slice(0, 10)}`;
}

/** 이은 묶음(union-find) — 같은 뜻 yes 쌍을 묶는다. */
export function groupPairs(pairs: Array<{ a: { key: string }; b: { key: string } }>): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  for (const p of pairs) {
    const [ra, rb] = [find(p.a.key), find(p.b.key)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const groups = new Map<string, string[]>();
  for (const k of parent.keys()) { const r = find(k); groups.set(r, [...(groups.get(r) ?? []), k]); }
  return [...groups.values()].map((g) => g.sort()).sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

/** 모델 판정 검사 한 번. 판정 못 한 쌍(null)은 세지 않고, 10% 넘으면 "판정 불완전". */
export async function runModelChecks(result: AuditResult, ctx: AuditContext, judge: Judge): Promise<ModelChecks> {
  const cand = pairCandidates(ctx);
  const dupV = await judge.checkPairs('dup', cand.dup.map((p) => ({ id: p.id, a: p.a.text, b: p.b.text })));
  const conV = await judge.checkPairs('conflict', cand.conflict.map((p) => ({ id: p.id, a: p.a.text, b: p.b.text })));
  const mixAll = result.checks.mix.map((c) => ({ ...c, id: mixId(c) }));
  const mixToJudge = mixAll.filter((c) => !ctx.homeMemoryIndex.has(c.path));
  const mixV = await judge.mixes(mixToJudge.map((c) => ({ id: c.id, text: c.text, guess: c.project, projects: ctx.projectKeys })));
  const fin = (p: Omit<PairFinding, 'verdict' | 'reason'>, v: CheckVerdict | null | undefined): PairFinding => ({ ...p, verdict: v?.answer ?? null, reason: v?.reason ?? '' });
  const dup = cand.dup.map((p) => fin(p, dupV.get(p.id)));
  const conflict = cand.conflict.map((p) => fin(p, conV.get(p.id)));
  const mix: MixFinding[] = mixAll.map((c) => {
    if (ctx.homeMemoryIndex.has(c.path)) return { ...c, verdict: null, judgedProject: null, reason: '', skipped: 'home-memory' as const };
    const v = mixV.get(c.id) ?? null;
    const known = new Set(ctx.projectKeys);
    const judged = v?.answer === 'project' ? (v.project && known.has(v.project) ? v.project : c.project) : null;
    return { ...c, verdict: v?.answer ?? null, judgedProject: judged, reason: v?.reason ?? '' };
  });
  const yesDup = dup.filter((p) => p.verdict === 'yes');
  const groups = groupPairs(yesDup);
  const total = dup.length + conflict.length + mixToJudge.length;
  const unjudged = dup.filter((p) => !p.verdict).length + conflict.filter((p) => !p.verdict).length + mix.filter((m) => !m.skipped && !m.verdict).length;
  const incomplete = !!judge.stats.stopped || (total > 0 && unjudged > total * 0.1);
  return {
    judge: { model: CHECK_MODEL, versions: { dup: DUP_PROMPT_VERSION, conflict: CONFLICT_PROMPT_VERSION, mix: MIX_PROMPT_VERSION }, dup: { top: DUP_TOP, min: DUP_MIN }, conflict: { top: CONFLICT_TOP, min: CONFLICT_MIN } },
    status: incomplete ? 'incomplete' : 'ok',
    statusNote: incomplete ? `판정 불완전 — 후보 ${total}개 중 ${unjudged}개를 판정하지 못함${judge.stats.stopped ? ` (${judge.stats.stopped})` : judge.stats.lastError ? ` (${judge.stats.lastError})` : ''}. 다시 돌리면 캐시 뒤 나머지만 묻는다` : '',
    dup, conflict, mix,
    counts: {
      dupGroups: groups.length, dupPairs: yesDup.length, conflicts: conflict.filter((p) => p.verdict === 'yes').length,
      mixConfirmed: mix.filter((m) => m.verdict === 'project').length,
      unknown: [...dup, ...conflict].filter((p) => p.verdict === 'unknown').length + mix.filter((m) => m.verdict === 'unknown').length,
    },
    dupGroups: groups,
    candidates: { dup: dup.length, conflict: conflict.length, mix: mixToJudge.length },
  };
}

/** 모델 판정 검사 결과를 회차 결과·manifest 에 넣는다(같은 manifest·같은 캐시면 같은 resultDigest). */
export function attachModelChecks(run: { result: AuditResult; manifest: { model: unknown; resultDigest: string } }, mc: ModelChecks, digest: (r: AuditResult) => string): void {
  const r = run.result;
  r.checks.model = mc;
  r.summary.findings.conflicts = mc.counts.conflicts;
  r.summary.findings.dupGroups = mc.counts.dupGroups;
  r.summary.findings.mixConfirmed = mc.counts.mixConfirmed;
  r.model = { used: true, note: `결정적 검사 + 모델 판정(같은 뜻 중복·부딪힘·섞임 확정, ${mc.judge.model} · 로컬 claude CLI). 보낸 것은 후보 지시 문장(각 ≤ 400~500자)뿐이고 판정은 ~/.forgen/audit/cache/ 에 캐시된다.${mc.status === 'incomplete' ? ` ${mc.statusNote}` : ''}` };
  run.manifest.model = { used: true, judges: [{ model: mc.judge.model, version: mc.judge.versions.dup }, { model: mc.judge.model, version: mc.judge.versions.conflict }, { model: mc.judge.model, version: mc.judge.versions.mix }], candidates: mc.candidates };
  run.manifest.resultDigest = digest(r);
}
