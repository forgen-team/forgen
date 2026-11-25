/**
 * 처방 — `forgen fix` (docs/plans/2026-11-25-v1.0-plan.md §5, §8, §2.3, §4.3, 오너 결정 Q3·Q4).
 *
 * 감사 회차(결정적 검사 + 모델 판정 — 판정은 캐시)를 다시 만들어 지적마다 처방을 낸다. 처방은 "연산"(이 줄을 지움·바꿈·덧붙임,
 * 이 룰의 범위·주입을 바꿈, 이 설정을 끔)이고, 적용할 때 그 파일의 지금 내용에 대고 푼다. 그래서 다른 처방을 먼저 적용해도 같은 처방이 남는다.
 *
 * 쓰는 곳(Q3): 자동 메모(<claude-dir>/projects/*\/memory) · .claude/rules · forgen 룰 · git 안 CLAUDE.md·AGENTS.md. 커밋하지 않는다.
 *   관리형 정책 파일과 git 밖 지침 파일(사용자 CLAUDE.md 등)은 지적만 한다(blocked). 스킬·플러그인은 끄기만(설정 false 또는 백업으로 옮김).
 * 적용 전 스냅샷 <FORGEN_HOME>/backups/fix-<시각>/<id>/ — 되돌리기는 그 처방이 건드린 파일만, 그사이 바뀌었으면 멈추고 3자 diff.
 * 지운 기억은 <FORGEN_HOME>/audit/deleted.jsonl 에 "지움 표시 + 지문"을 남긴다 — 재발 재생(memory-items.deletedItems)이 읽는다.
 * 처방 문안(합치기·짧게·색인·메모 초안)은 Haiku(judge.fixTexts). 모델이 없으면 결정적 처방(같은 문장 정리·지우기·색인 줄 내리기·끄기)만.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FORGEN_HOME, ME_RULES } from '../core/paths.js';
import { applyRuleProjects } from '../engine/rule-project-cli.js';
import { withFileLockSync } from '../hooks/shared/file-lock.js';
import { withStatusChange } from '../store/rule-lifecycle.js';
import { mergeRuleProjects } from '../store/rule-scope.js';
import { loadRule, rulePath, saveRule } from '../store/rule-store.js';
import type { Rule } from '../store/types.js';
import { isImportantRule, normalizeSentence, type Unit } from './checks.js';
import { PAIR_MODEL, type Judge } from './judge.js';
import { latestRecurrenceRun } from './recurrence.js';
import { unitKey, type AuditRun } from './run.js';
import type { ModelChecks } from './model-checks.js';
import { defaultEnv, encodeProjectDir, frontmatterField, gitRootOf, MEMORY_MAX_BYTES, MEMORY_MAX_LINES, splitFrontmatter, type AuditEnv } from './sources.js';
import { estimateTokens } from './tokens.js';
import { shortPath } from './html.js';

export type FixKind = 'plugin-off' | 'remove' | 'merge' | 'overlap' | 'scope' | 'move' | 'rewrite' | 'index' | 'add-memory';
/** 묶음 적용 순서: 끄기 → 지우기 → 합치기 → 겹침 → 범위 → 옮기기 → 짧게 → 색인 → 기억 추가(색인에 덧붙이므로 마지막). */
export const FIX_KINDS: FixKind[] = ['plugin-off', 'remove', 'merge', 'overlap', 'scope', 'move', 'rewrite', 'index', 'add-memory'];
export const KIND_LABEL: Record<FixKind, string> = {
  'plugin-off': '플러그인·스킬 끄기', remove: '지우기·끄기', merge: '합치기', overlap: '겹치는 교정 한 곳만(Q4)', scope: 'forgen 룰 범위 옮기기',
  move: '폴더 전용 룰로 옮기기', rewrite: '짧게 다시 쓰기', index: 'MEMORY.md 색인 줄 내리기', 'add-memory': '기억 추가',
};
/** 처방 대상이 되는 길이(§8): 400자 넘는 룰·지시는 짧게, 110자 넘는 색인 줄은 내린다. */
export const LONG_RULE = 400;
export const LONG_INDEX = 110;
export const INDEX_HOOK_MAX = 60;
/** 예전 이름(forgen 의 앞 이름) — 그 이름의 플러그인·명령 폴더는 끄기 제안. */
export const LEGACY_NAMES = ['tenetx'];
const UNUSED_DAYS = 30;
const DAY = 86_400_000;

export type Op =
  | { op: 'delete-line'; path: string; text: string }
  | { op: 'replace-line'; path: string; text: string; with: string }
  | { op: 'append'; path: string; text: string; create?: string }
  | { op: 'create'; path: string; content: string }
  | { op: 'rule'; ruleId: string; change: 'scope'; projects: string[] }
  | { op: 'rule'; ruleId: string; change: 'host-copy'; host: { path: string; line?: number } }
  | { op: 'rule'; ruleId: string; change: 'suppress' | 'supersede'; reason: string; keeper?: string }
  | { op: 'rule'; ruleId: string; change: 'policy'; policy: string; mergeFrom?: string[] }
  | { op: 'json-set'; path: string; keys: string[]; value: unknown }
  | { op: 'move-away'; path: string };

export interface DeletedMark { text: string; kind: string; path?: string; line?: number; ruleId?: string; since?: string }

export interface Fix {
  id: string;
  kind: FixKind;
  title: string;
  why: string;
  evidence: string[];
  ops: Op[];
  /** 누락 검사용: 이 처방 뒤 from 이 실리지 않아도 to 가 실리면 같은 뜻으로 실린 것 */
  equivalents: Array<{ from: string; to: string }>;
  /** 범위를 옮긴 룰: 이 프로젝트 폴더에서만 실리면 된다 */
  scopedTo?: { key: string; project: string };
  marks: DeletedMark[];
  /** 처방 문안에 모델을 썼는가 */
  model: boolean;
  /** 쓸 수 없는 대상(관리형·git 밖 등) — 지적만 */
  blocked?: string;
  /** 묶음 적용에서 빼는 처방(중요 지침의 범위 옮기기 등) — forgen fix <id> --apply 로만 */
  manual?: string;
  /** 기억 추가: 이 폴더의 상시 로드에 더하는 토큰(N3 다이어트 비교에서 따로 센다) */
  addsTo?: { folder: string; tokens: number };
  /** 이 처방으로 줄어드는 상시 로드 토큰(어림, 폴더마다 다를 수 있어 최대값) */
  tokens: number;
}

export interface FixPlan { fixes: Fix[]; run: AuditRun; model: ModelChecks | null; generatedAt: string }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const fp = (s: string) => sha(normalizeSentence(s)).slice(0, 12);
/** 처방 신원은 줄 번호가 아니라 (파일·정규화 문장) — 앞 처방이 줄을 지워 번호가 밀려도 같은 처방이다. */
const ident = (u: { ruleId?: string; path: string; norm: string }) => u.ruleId ?? `${u.path}|${u.norm}`;
const fixId = (kind: FixKind, identity: string) => `${kind}-${sha(`${kind}|${identity}`).slice(0, 8)}`;
const readText = (p: string): string | null => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } };
const isMdLayer = (l: string) => ['user', 'user-rules', 'project', 'project-local', 'project-rules', 'agents', 'import'].includes(l);
const STRENGTH_RANK: Record<string, number> = { hard: 0, strong: 1, default: 2, soft: 3 };
export { isImportantRule };

/** Q3: 처방이 직접 써도 되는 파일인가. 안 되면 그 까닭. */
export function writeBlock(p: string, env: AuditEnv): string | null {
  if (env.managedPaths.includes(p)) return '관리형 정책 파일 — 지적만';
  const rel = path.relative(path.join(env.claudeDir, 'projects'), p);
  if (!rel.startsWith('..') && rel.split(path.sep)[1] === 'memory') return null;
  if (p.startsWith(`${ME_RULES}${path.sep}`)) return null;
  if (/[\\/]\.claude[\\/]rules[\\/].+\.md$/.test(p)) return null;
  const base = path.basename(p);
  if (base === 'CLAUDE.md' || base === 'CLAUDE.local.md' || base === 'AGENTS.md') {
    return gitRootOf(path.dirname(p), env.home) ? null : 'git 밖 지침 파일 — 되돌릴 기록이 없어 지적만(Q3: git 안 CLAUDE.md·AGENTS.md 만 고친다)';
  }
  return '처방이 쓰지 않는 파일 — 지적만';
}

// ── 파일 연산 풀기(적용·미리보기 공통) ──

function findLine(lines: string[], text: string): number {
  const t = text.trim();
  return lines.findIndex((l) => l.trim() === t);
}

/** 연산을 지금 내용에 대고 푼 새 내용(null = 파일 없음). 대상 줄이 없으면 예외 — 그 처방은 통째로 건너뛴다. */
export function applyTextOps(content: string | null, ops: Op[]): string | null {
  let cur = content;
  for (const o of ops) {
    if (o.op === 'create') { if (cur !== null) throw new Error(`이미 있는 파일: ${o.path}`); cur = o.content; continue; }
    if (o.op === 'append') {
      const base = cur ?? o.create ?? '';
      cur = `${base}${base && !base.endsWith('\n') ? '\n' : ''}${o.text}${o.text.endsWith('\n') ? '' : '\n'}`;
      continue;
    }
    if (o.op === 'delete-line' || o.op === 'replace-line') {
      if (cur === null) throw new Error(`파일이 없다: ${o.path}`);
      const lines = cur.split('\n');
      const i = findLine(lines, o.text);
      if (i < 0) throw new Error(`대상 줄이 바뀌었다: ${o.path}`);
      if (o.op === 'delete-line') lines.splice(i, 1); else lines[i] = o.with;
      cur = lines.join('\n');
      continue;
    }
    if (o.op === 'json-set') {
      let j: Record<string, unknown> = {};
      try { j = cur ? JSON.parse(cur) as Record<string, unknown> : {}; } catch { throw new Error(`JSON 이 아니다: ${o.path}`); }
      let at: Record<string, unknown> = j;
      for (const k of o.keys.slice(0, -1)) { if (typeof at[k] !== 'object' || at[k] === null) at[k] = {}; at = at[k] as Record<string, unknown>; }
      at[o.keys[o.keys.length - 1]] = o.value;
      cur = `${JSON.stringify(j, null, 2)}\n`;
    }
  }
  return cur;
}

const opPath = (o: Op): string => (o.op === 'rule' ? rulePath(o.ruleId) : o.path);
/** 처방이 건드리는 파일들. */
export const fixPaths = (f: Fix): string[] => [...new Set(f.ops.map(opPath))];

/** 룰 연산을 룰 객체에 푼다(미리보기·적용 공통. 적용은 saveRule 이 updated_at·lifecycle 을 채운다). */
function ruleAfter(r: Rule, o: Extract<Op, { op: 'rule' }>, fixIdStr: string, nowIso: string, others: Map<string, Rule>): Rule {
  switch (o.change) {
    case 'scope': { const { scope_state: _s, ...rest } = r; return { ...rest, projects: o.projects }; }
    case 'host-copy': return { ...r, host_copy: { path: o.host.path, ...(o.host.line ? { line: o.host.line } : {}), at: nowIso, fix: fixIdStr } };
    case 'suppress': return withStatusChange(r, 'suppressed', o.reason, 'forgen fix', nowIso);
    case 'supersede': {
      const next = withStatusChange(r, 'superseded', o.reason, 'forgen fix', nowIso);
      return { ...next, ...(next.lifecycle && o.keeper ? { lifecycle: { ...next.lifecycle, superseded_by: o.keeper } } : {}) };
    }
    case 'policy': {
      // 합치기: 근거는 둘 다 남긴다(같은 출처 증거만 — ADR-013), 범위는 합집합
      const from = (o.mergeFrom ?? []).map((id) => others.get(id) ?? loadRule(id)).filter((x): x is Rule => !!x);
      const evidence = [...new Set([...r.evidence_refs, ...from.filter((d) => d.source === r.source).flatMap((d) => d.evidence_refs ?? [])])];
      const projects = from.length ? mergeRuleProjects([r, ...from]) : r.projects;
      const { projects: _p, ...rest } = r;
      return { ...rest, policy: o.policy, evidence_refs: evidence, ...(projects?.length ? { projects } : {}) };
    }
  }
}

// ── 계획 ──

export interface PlanOptions { folders?: string[]; claudeDir?: string; cwd?: string; judge?: Judge | null; now?: Date; run?: AuditRun; model?: ModelChecks | null }

interface Member { u: Unit; key: string; loaded: string[]; rule?: Rule }

const covers = (big: string[], small: string[]) => { const b = new Set(big); return small.every((f) => b.has(f)); };
const shortText = (s: string, n = 70) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const linkOf = (line: string) => /\]\(([^)\s#]+\.md)\)/.exec(line)?.[1] ?? null;

export async function planFixes(opts: PlanOptions = {}): Promise<FixPlan> {
  const now = opts.now ?? new Date();
  const { runAudit, resultDigest } = await import('./run.js');
  const run = opts.run ?? runAudit({ folders: opts.folders, claudeDir: opts.claudeDir, cwd: opts.cwd });
  const judge = opts.judge ?? null;
  let mc: ModelChecks | null = opts.model ?? null;
  if (!mc && judge) {
    const { attachModelChecks, runModelChecks } = await import('./model-checks.js');
    mc = await runModelChecks(run.result, run.ctx, judge);
    attachModelChecks(run, mc, resultDigest);
  }
  const env = defaultEnv(run.result.claudeDir);
  const ctx = run.ctx;
  const byKey = new Map<string, Unit>();
  for (const u of [...ctx.units, ...ctx.topics]) byKey.set(unitKey(u), u);
  const member = (u: Unit): Member => ({ u, key: unitKey(u), loaded: [...(ctx.loadedIn.get(unitKey(u)) ?? [])].sort(), ...(u.ruleId && ctx.rules.get(u.ruleId) ? { rule: ctx.rules.get(u.ruleId) } : {}) });
  const fixes: Fix[] = [];
  const add = (f: Omit<Fix, 'id' | 'marks' | 'equivalents' | 'model' | 'tokens'> & Partial<Pick<Fix, 'marks' | 'equivalents' | 'model' | 'tokens'>>, identity: string) => {
    const id = fixId(f.kind, identity);
    if (fixes.some((x) => x.id === id)) return;
    const blocked = f.blocked ?? f.ops.map((o) => (o.op === 'rule' || o.op === 'json-set' || o.op === 'move-away' ? null : writeBlock(o.path, env))).find((x) => x) ?? undefined;
    fixes.push({ marks: [], equivalents: [], model: false, tokens: 0, ...f, id, ...(blocked ? { blocked } : {}) });
  };
  const unitWhere = (u: Unit) => (u.ruleId ? `forgen 룰 ${u.ruleId.slice(0, 8)}` : `${shortPath(u.path)}:${u.line}`);
  const hostKeyOf = (u: Unit) => { const l = u.layer === 'memory-index' ? linkOf(u.text) : null; return l ? `topic:${path.resolve(path.dirname(u.path), l)}` : `norm:${u.norm}`; };
  const delMark = (u: Unit): DeletedMark => ({ text: u.text, kind: u.layer, ...(u.ruleId ? { ruleId: u.ruleId } : { path: u.path, line: u.line }), ...(u.ruleId && ctx.rules.get(u.ruleId)?.created_at ? { since: ctx.rules.get(u.ruleId)?.created_at } : {}) });
  const fixTexts = async (items: Array<{ id: string; task: 'merge' | 'rewrite' | 'index' | 'memo'; texts: string[] }>) => (judge?.modelEnabled && items.length ? judge.fixTexts(items) : new Map());
  // 처방 문안(Haiku)을 채점하는 쪽은 다른 판정자(Sonnet) — §1.2 판정자 분리, §2.4
  const sameMeaning = async (pairs: Array<{ id: string; a: string; b: string }>) => (judge?.modelEnabled && pairs.length ? judge.checkPairs('dup', pairs, PAIR_MODEL) : new Map());

  // 1. 같은 문장(결정적) + 같은 뜻 묶음(모델) → 합치기 · 겹치는 교정(Q4)
  type Group = { members: Member[]; source: 'same' | 'dup' };
  const groups: Group[] = [];
  for (const g of run.result.checks.sameSentence) {
    const ms = g.occurrences.map((o) => byKey.get(unitKey(o))).filter((u): u is Unit => !!u).map(member);
    if (ms.length >= 2) groups.push({ members: ms, source: 'same' });
  }
  for (const keys of mc?.dupGroups ?? []) {
    const ms = keys.map((k) => byKey.get(k)).filter((u): u is Unit => !!u).map(member);
    if (ms.length >= 2) groups.push({ members: ms, source: 'dup' });
  }
  const mergeTexts: Array<{ id: string; task: 'merge'; texts: string[] }> = [];
  const hostMerges: Array<{ g: Group; keeper: Member; drop: Member[]; tid: string }> = [];
  const ruleMerges: Array<{ g: Group; keeper: Member; drop: Member[]; tid: string }> = [];
  for (const g of groups) {
    const hosts = g.members.filter((m) => isMdLayer(m.u.layer) || m.u.layer === 'memory-index');
    const loadedHosts = hosts.filter((m) => m.loaded.length);
    const rules = g.members.filter((m) => m.rule && m.rule.status === 'active');
    const topics = g.members.filter((m) => m.u.layer === 'memory-topic');
    // 호스트끼리: 모든 사본이 실리는 폴더를 덮는 하나만 남긴다(색인 줄은 주제 파일을 가리키므로 지우지 않음)
    const deletable = loadedHosts.filter((m) => isMdLayer(m.u.layer));
    if (deletable.length + loadedHosts.filter((m) => m.u.layer === 'memory-index').length >= 2 && deletable.length >= 1) {
      const all = [...new Set(loadedHosts.flatMap((m) => m.loaded))];
      const keeper = [...loadedHosts].sort((a, b) => b.loaded.length - a.loaded.length || (a.key < b.key ? -1 : 1)).find((m) => covers(m.loaded, all));
      const drop = keeper ? deletable.filter((m) => m !== keeper) : [];
      if (keeper && drop.length) {
        const tid = `merge|${[keeper, ...drop].map((m) => ident(m.u)).sort().join('|')}`;
        if (g.source === 'dup' && isMdLayer(keeper.u.layer)) mergeTexts.push({ id: tid, task: 'merge', texts: [keeper, ...drop].map((m) => m.u.text.replace(/^\s*[-*]\s+/, '')) });
        hostMerges.push({ g, keeper, drop, tid });
      }
    }
    // forgen 룰 ↔ 호스트 사본(Q4): 룰이 실리는 폴더를 호스트 사본이 다 덮으면 룰은 주입만 뺀다
    const coveredRules = new Set<string>();
    for (const r of rules) {
      if (!r.loaded.length) continue;
      const host = [...loadedHosts].sort((a, b) => b.loaded.length - a.loaded.length).find((h) => covers(h.loaded, r.loaded));
      if (host) {
        coveredRules.add(r.key);
        add({
          kind: 'overlap', title: `forgen 룰 ${r.u.ruleId?.slice(0, 8)} 주입 빼기 — 같은 교정이 ${host.u.layer === 'memory-index' ? '메모 색인' : '호스트 지침'}에 있음`,
          why: '같은 교정이 forgen 룰과 호스트 기억 양쪽에 있다. 호스트 기억을 남기고 forgen 은 세션 시작 주입만 뺀다(룰은 강제·측정용으로 보관 — 오너 결정 Q4).',
          evidence: [`룰: ${shortText(r.u.text)}`, `호스트: ${unitWhere(host.u)} ${shortText(host.u.text)}`, g.source === 'same' ? '같은 문장' : '같은 뜻(모델 판정)'],
          ops: [{ op: 'rule', ruleId: r.u.ruleId as string, change: 'host-copy', host: { path: host.u.path, line: host.u.line } }],
          equivalents: [{ from: `rule:${r.u.ruleId}`, to: hostKeyOf(host.u) }], tokens: r.u.tokens,
        }, `${ident(r.u)}|${ident(host.u)}`);
      } else if (topics.length && !loadedHosts.length) {
        add({
          kind: 'overlap', title: `forgen 룰 ${r.u.ruleId?.slice(0, 8)} ↔ 메모 주제 파일 — 지적만`,
          why: '같은 교정이 메모 주제 파일에만 있다. 주제 파일은 세션 시작에 실리지 않아 forgen 주입을 빼면 그 교정이 어디에도 실리지 않는다(누락).',
          evidence: [`룰: ${shortText(r.u.text)}`, `주제 파일: ${topics[0].u.path}`], ops: [], blocked: '호스트 사본이 세션 시작에 안 실림 — 빼면 누락',
        }, `${ident(r.u)}|${ident(topics[0].u)}`);
      }
    }
    // forgen 룰끼리: 덮이지 않은 활성 룰이 둘 이상이면 하나로(근거는 둘 다)
    const rest = rules.filter((r) => !coveredRules.has(r.key) && r.loaded.length);
    if (rest.length >= 2) {
      // 남길 룰: 중요 지침 먼저 → 강도 → 오래된 순
      const sorted = [...rest].sort((a, b) => Number(!isImportantRule(a.rule as Rule)) - Number(!isImportantRule(b.rule as Rule)) || (STRENGTH_RANK[a.rule?.strength ?? ''] ?? 9) - (STRENGTH_RANK[b.rule?.strength ?? ''] ?? 9) || Date.parse(a.rule?.created_at ?? '') - Date.parse(b.rule?.created_at ?? '') || (a.key < b.key ? -1 : 1));
      const all = [...new Set(rest.flatMap((m) => m.loaded))];
      const keeper = sorted.find((m) => covers(m.loaded, all)) ?? null;
      // 중요 지침(hard·strong·직접 교정)은 지워지는 쪽이 되지 않는다
      const drop = keeper ? rest.filter((m) => m !== keeper && m.rule && !isImportantRule(m.rule)) : [];
      if (keeper && drop.length) {
        const tid = `rmerge|${[keeper, ...drop].map((m) => ident(m.u)).sort().join('|')}`;
        if (g.source === 'dup') mergeTexts.push({ id: tid, task: 'merge', texts: [keeper, ...drop].map((m) => m.u.text) });
        ruleMerges.push({ g, keeper, drop, tid });
      }
    }
  }
  const merged = await fixTexts(mergeTexts);
  const mergedCheck = await sameMeaning([...merged].flatMap(([tid, v]) => (v ? (mergeTexts.find((m) => m.id === tid)?.texts ?? []).map((t, i) => ({ id: `${tid}#${i}`, a: t, b: v.text })) : [])));
  const mergeOk = (tid: string) => { const v = merged.get(tid); if (!v) return null; const n = mergeTexts.find((m) => m.id === tid)?.texts.length ?? 0; for (let i = 0; i < n; i++) if (mergedCheck.get(`${tid}#${i}`)?.answer !== 'yes') return null; return v.text as string; };
  for (const { g, keeper, drop, tid } of hostMerges) {
    const text = g.source === 'dup' && isMdLayer(keeper.u.layer) ? mergeOk(tid) : null;
    if (g.source === 'dup' && isMdLayer(keeper.u.layer) && !text) continue; // 모델 없음·합친 문장이 원문 뜻을 다 담지 못함
    const prefix = /^\s*[-*]\s+/.exec(keeper.u.text)?.[0] ?? '- ';
    const ops: Op[] = [
      ...(text ? [{ op: 'replace-line' as const, path: keeper.u.path, text: keeper.u.text, with: `${prefix}${text}` }] : []),
      ...drop.map((m) => ({ op: 'delete-line' as const, path: m.u.path, text: m.u.text })),
    ];
    add({
      kind: 'merge', title: `${g.source === 'same' ? '같은 문장' : '같은 뜻'} ${drop.length + 1}곳 → 하나만 남김 (${unitWhere(keeper.u)})`,
      why: g.source === 'same' ? '정규화하면 같은 문장이 여러 파일에 있다. 모든 사본이 실리는 폴더를 덮는 하나만 남긴다.' : '같은 뜻 지시(모델 판정)를 하나로 합친다. 합친 문장이 원문마다 같은 뜻인지 다시 판정해 통과한 것만.',
      evidence: [keeper, ...drop].map((m) => `${unitWhere(m.u)} ${shortText(m.u.text)}`), ops,
      equivalents: [...drop.map((m) => ({ from: hostKeyOf(m.u), to: text ? `norm:${normalizeSentence(`${prefix}${text}`)}` : hostKeyOf(keeper.u) })), ...(text ? [{ from: hostKeyOf(keeper.u), to: `norm:${normalizeSentence(`${prefix}${text}`)}` }] : [])],
      marks: drop.map((m) => delMark(m.u)), model: !!text, tokens: drop.reduce((n, m) => n + m.u.tokens, 0),
    }, tid);
  }
  for (const { g, keeper, drop, tid } of ruleMerges) {
    const text = g.source === 'dup' ? mergeOk(tid) : null;
    if (g.source === 'dup' && !text) continue;
    const ops: Op[] = [
      ...(text || drop.length ? [{ op: 'rule' as const, ruleId: keeper.u.ruleId as string, change: 'policy' as const, policy: text ?? (keeper.rule as Rule).policy, mergeFrom: drop.map((m) => m.u.ruleId as string) }] : []),
      ...drop.map((m) => ({ op: 'rule' as const, ruleId: m.u.ruleId as string, change: 'supersede' as const, reason: `duplicate-of ${keeper.u.ruleId} (forgen fix)`, keeper: keeper.u.ruleId })),
    ];
    add({
      kind: 'merge', title: `forgen 룰 ${drop.length + 1}개 → ${keeper.u.ruleId?.slice(0, 8)} 하나로 (${g.source === 'same' ? '같은 문장' : '같은 뜻'})`,
      why: '같은 뜻 forgen 룰을 하나로 합친다. 남길 룰은 강도 → 오래된 순(rule dedupe 와 같은 기준), 근거(증거)는 둘 다 남기고 나머지는 대체(superseded) 처리.',
      evidence: [keeper, ...drop].map((m) => `${unitWhere(m.u)} ${shortText(m.u.text)}`), ops,
      equivalents: drop.map((m) => ({ from: `rule:${m.u.ruleId}`, to: `rule:${keeper.u.ruleId}` })), marks: drop.map((m) => delMark(m.u)), model: !!text, tokens: drop.reduce((n, m) => n + m.u.tokens, 0),
    }, tid);
  }

  // 2. 낡음 → 지우기·끄기
  const staleByUnit = new Map<string, { u: Unit; refs: string[]; kinds: string[] }>();
  for (const s of run.result.checks.stale) {
    const u = byKey.get(unitKey(s));
    if (!u) continue;
    const e = staleByUnit.get(unitKey(s)) ?? { u, refs: [], kinds: [] };
    e.refs.push(s.ref); e.kinds.push(s.kind);
    staleByUnit.set(unitKey(s), e);
  }
  for (const { u, refs, kinds } of staleByUnit.values()) {
    const m = member(u);
    const base = { kind: 'remove' as const, evidence: [`${unitWhere(u)} ${shortText(u.text)}`, `지금 없는 것: ${refs.join(', ')}`], tokens: m.loaded.length ? u.tokens : 0 };
    if (m.rule) {
      if (isImportantRule(m.rule)) { add({ ...base, title: `forgen 룰 ${u.ruleId?.slice(0, 8)} — 가리키는 것이 없음(중요 지침이라 끄지 않음)`, why: '중요 지침(hard·strong·직접 교정)은 끄면 누락이다. 가리키는 경로만 고치세요.', ops: [], blocked: '중요 지침 — 지적만' }, ident(u)); continue; }
      add({ ...base, title: `forgen 룰 ${u.ruleId?.slice(0, 8)} 끄기 — 가리키는 것이 지금 없음`, why: '룰이 가리키는 파일·명령이 지금 없다. 끄고(suppressed) 지움 표시를 남긴다 — 같은 교정이 다시 나오면 "지운 뒤 다시 말함"으로 센다.', ops: [{ op: 'rule', ruleId: u.ruleId as string, change: 'suppress', reason: `stale: ${refs.join(', ')} (forgen fix)` }], marks: [delMark(u)] }, ident(u));
      continue;
    }
    if (u.layer === 'memory-index') {
      const link = linkOf(u.text);
      const topic = link ? path.resolve(path.dirname(u.path), link) : null;
      const topicType = topic ? frontmatterField(readText(topic) ?? '', 'type') : undefined;
      if (kinds.includes('link') && topic && !fs.existsSync(topic) && link && refs.includes(link)) {
        add({ ...base, title: `MEMORY.md 색인 줄 지우기 — 가리키는 주제 파일이 없음`, why: '색인 줄이 없는 주제 파일을 가리킨다. 지우고 지움 표시를 남긴다.', ops: [{ op: 'delete-line', path: u.path, text: u.text }], marks: [delMark(u)] }, ident(u));
      } else add({ ...base, title: 'MEMORY.md 색인 줄 — 본문의 경로가 없음(지적만)', why: `색인 줄은 주제 파일${topicType === 'feedback' ? '(feedback)' : ''}을 가리키므로 지우지 않는다. 경로만 고치세요.`, ops: [], blocked: '주제 파일을 가리키는 색인 줄 — 지적만' }, ident(u));
      continue;
    }
    if (!isMdLayer(u.layer)) continue;
    add({ ...base, title: `지시 줄 지우기 — 가리키는 것이 지금 없음 (${path.basename(u.path)}:${u.line})`, why: '지금 없는 파일·링크·npm 스크립트를 가리키는 줄이다. 지우고 지움 표시를 남긴다.', ops: [{ op: 'delete-line', path: u.path, text: u.text }], marks: [delMark(u)] }, ident(u));
  }

  // 3. 섞임 확정 → forgen 룰 범위 옮기기 · 폴더 전용 룰로 옮기기
  const folderOf = new Map(run.result.folders.map((f) => [f.folder, f]));
  for (const x of mc?.mix ?? []) {
    if (x.verdict !== 'project' || !x.judgedProject) continue;
    const u = byKey.get(unitKey(x));
    if (!u) continue;
    const key = x.judgedProject;
    const ev = [`${unitWhere(u)} ${shortText(u.text)}`, `판정: ${key} 전용 — ${x.reason}`, `신호: ${x.why.join(' · ')}`];
    if (x.ruleId) {
      const r = ctx.rules.get(x.ruleId);
      if (!r || r.strength === 'hard') continue;
      const important = isImportantRule(r);
      add({
        kind: 'scope', title: `forgen 룰 ${x.ruleId.slice(0, 8)} → ${key} 전용`, why: '다른 프로젝트 전용인데 전역인 룰이다(모델 판정). 그 프로젝트 범위로 옮긴다(rule classify-projects --apply 와 같은 경로).',
        evidence: ev, ops: [{ op: 'rule', ruleId: x.ruleId, change: 'scope', projects: [key] }], scopedTo: { key: `rule:${x.ruleId}`, project: key }, model: false,
        ...(important ? { manual: '중요 지침(hard·strong·직접 교정) — 묶음 적용에서 빼고, 보고 나서 forgen fix <id> --apply 로 하나씩만. 다른 폴더에서는 누락으로 센다' } : {}),
        tokens: Math.max(0, ...run.result.folders.filter((f) => f.projectKey !== key && (ctx.loadedIn.get(unitKey(u)) ?? []).includes(f.folder)).map(() => u.tokens)),
      }, ident(u));
      continue;
    }
    if (!isMdLayer(u.layer)) continue;
    const targets = [...new Set(run.result.folders.filter((f) => f.projectKey === key).map((f) => gitRootOf(f.folder, env.home) ?? f.folder))].sort();
    if (!targets.length) { add({ kind: 'move', title: `전역 지시 → ${key} 전용(대상 폴더를 감사하지 않음, 지적만)`, why: '그 프로젝트 폴더를 --folder 로 넣으면 옮길 수 있다.', evidence: ev, ops: [], blocked: '대상 프로젝트 폴더 없음' }, ident(u)); continue; }
    const ops: Op[] = [{ op: 'delete-line', path: u.path, text: u.text }];
    for (const root of targets) {
      const folders = run.result.folders.filter((f) => f.projectKey === key && (gitRootOf(f.folder, env.home) ?? f.folder) === root).map((f) => path.relative(root, f.folder)).filter((r) => r && !r.startsWith('..'));
      const fm = folders.length ? `---\npaths:\n${folders.map((r) => `  - "${r}/**"`).join('\n')}\n---\n` : '';
      ops.push({ op: 'append', path: path.join(root, '.claude', 'rules', `moved-${key.replace(/[^a-z0-9-]/g, '-')}.md`), text: u.text, create: fm });
    }
    add({
      kind: 'move', title: `전역 지시 → ${key} 폴더 전용 룰(.claude/rules)`, why: '모든 프로젝트에 실리는 층에 있지만 한 프로젝트 전용이다(모델 판정). 그 저장소의 .claude/rules/ 로 옮긴다 — 그 폴더 세션에서는 그대로 실린다.',
      evidence: ev, ops, tokens: u.tokens,
    }, ident(u));
  }

  // 4. 긴 룰·지시 → 짧게 다시 쓰기(모델, 다시 쓴 문장을 같은 뜻 판정으로 확인)
  const longs = ctx.units.filter((u) => (u.ruleId ? (ctx.rules.get(u.ruleId)?.policy.length ?? 0) : u.text.length) > LONG_RULE && (u.layer === 'forgen-rule' || isMdLayer(u.layer)) && (ctx.loadedIn.get(unitKey(u))?.length ?? 0) > 0);
  const rw = await fixTexts(longs.map((u) => ({ id: unitKey(u), task: 'rewrite' as const, texts: [u.ruleId ? (ctx.rules.get(u.ruleId) as Rule).policy : u.text] })));
  const rwCheck = await sameMeaning(longs.filter((u) => rw.get(unitKey(u))).map((u) => ({ id: unitKey(u), a: u.ruleId ? (ctx.rules.get(u.ruleId) as Rule).policy : u.text, b: rw.get(unitKey(u))?.text ?? '' })));
  for (const u of longs) {
    const v = rw.get(unitKey(u));
    const orig = u.ruleId ? (ctx.rules.get(u.ruleId) as Rule).policy : u.text;
    if (!v || v.text.length >= orig.length * 0.9 || rwCheck.get(unitKey(u))?.answer !== 'yes') continue;
    const prefix = u.ruleId ? '' : (/^\s*[-*]\s+/.exec(u.text)?.[0] ?? '');
    const newText = `${prefix}${v.text.replace(/^\s*[-*]\s+/, '')}`;
    add({
      kind: 'rewrite', title: `긴 ${u.ruleId ? `forgen 룰 ${u.ruleId.slice(0, 8)}` : `지시 ${path.basename(u.path)}:${u.line}`} 짧게 (${orig.length} → ${newText.length}자)`,
      why: `${LONG_RULE}자 넘는 지시를 뜻을 바꾸지 않고 줄인다. 다시 쓴 문장은 원문과 같은 뜻인지 다시 판정해 통과했다. 원문은 스냅샷에 보관(되돌리기 가능).`,
      evidence: [`원문: ${shortText(orig, 120)}`, `새 문장: ${shortText(newText, 120)}`],
      ops: [u.ruleId ? { op: 'rule', ruleId: u.ruleId, change: 'policy', policy: newText } : { op: 'replace-line', path: u.path, text: u.text, with: newText }],
      equivalents: u.ruleId ? [] : [{ from: `norm:${u.norm}`, to: `norm:${normalizeSentence(newText)}` }], model: true, tokens: Math.max(0, u.tokens - estimateTokens(newText)),
    }, ident(u));
  }

  // 5. MEMORY.md 색인 줄 내리기(긴 줄은 한 구절로, 원문은 주제 파일에) + 잘린 줄은 보관 주제 파일로
  const auditedMem = [...new Set(run.result.folders.map((f) => f.memoryDir).filter((d): d is string => !!d))].sort();
  for (const dir of auditedMem) {
    const m = ctx.memory.get(dir);
    if (!m?.index || m.index.error) continue;
    const idx = m.index;
    const lines = idx.text.split('\n');
    const longLines = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => i < m.loadedLines && l.length > LONG_INDEX && /^\s*[-*]\s+\[/.test(l) && linkOf(l) && fs.existsSync(path.join(dir, linkOf(l) as string)));
    const cut = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => i >= m.loadedLines && l.trim() && !l.trim().startsWith('#'));
    if (!longLines.length && !cut.length) continue;
    const hooks = await fixTexts(longLines.map(({ l }) => ({ id: sha(l).slice(0, 16), task: 'index' as const, texts: [l] })));
    const ops: Op[] = [];
    const evidence: string[] = [];
    let saved = 0;
    let model = false;
    for (const { l } of longLines) {
      const mm = /^(\s*[-*]\s+\[[^\]]*\]\([^)]+\))\s*(?:[—–-]+\s*)?(.*)$/.exec(l);
      if (!mm) continue;
      const desc = mm[2].trim();
      const h = hooks.get(sha(l).slice(0, 16))?.text;
      let hook = h && h.length <= INDEX_HOOK_MAX + 10 ? h.replace(/\s+/g, ' ').trim() : '';
      if (hook) model = true;
      else {
        // 결정적: 첫 구절(쉼표·마침표·괄호 앞)을 60자 안에서 낱말 경계로
        const first = desc.split(/[,.;·(（]|\s[—–-]\s/)[0].trim();
        hook = first.length <= INDEX_HOOK_MAX ? first : `${first.slice(0, INDEX_HOOK_MAX).replace(/\s+\S*$/, '')}…`;
      }
      const next = hook ? `${mm[1]} — ${hook}` : mm[1];
      if (next.length >= l.length) continue;
      const topic = path.join(dir, linkOf(l) as string);
      const topicText = readText(topic) ?? '';
      const kept = normalizeSentence(splitFrontmatter(topicText).body + (frontmatterField(topicText, 'description') ?? '')).includes(normalizeSentence(desc));
      ops.push({ op: 'replace-line', path: idx.path, text: l, with: next });
      if (!kept) ops.push({ op: 'append', path: topic, text: `\n> 색인 원문(forgen fix ${now.toISOString().slice(0, 10)}): ${l.trim()}` });
      saved += estimateTokens(l) - estimateTokens(next);
      evidence.push(`${shortText(l, 60)} → ${shortText(next, 60)}`);
    }
    if (cut.length) {
      const archive = path.join(dir, 'memory-index-archive.md');
      const head = fs.existsSync(archive) ? undefined : `---\nname: memory-index-archive\ndescription: MEMORY.md 가 200줄·25KB 를 넘어 세션 시작에 안 실리던 색인 줄 보관\n${(m.topics.some((t) => /\nmetadata:\s*\n\s+type:/.test(t.text)) ? 'metadata:\n  type: reference' : 'type: reference')}\n---\n`;
      ops.push(...cut.map(({ l }) => ({ op: 'delete-line' as const, path: idx.path, text: l })));
      ops.push({ op: 'append', path: archive, text: cut.map(({ l }) => l).join('\n'), ...(head ? { create: head } : {}) });
      if (!lines.some((l) => l.includes('](memory-index-archive.md)'))) ops.push({ op: 'append', path: idx.path, text: '- [색인 보관](memory-index-archive.md) — 200줄·25KB 를 넘어 안 실리던 색인 줄' });
      evidence.push(`잘려서 안 실리던 색인 줄 ${cut.length}개 → memory-index-archive.md`);
    }
    if (!ops.length) continue;
    add({
      kind: 'index', title: `MEMORY.md 색인 줄 내리기 — ${longLines.length}줄 짧게${cut.length ? ` · 잘린 ${cut.length}줄 보관` : ''} (${m.folder ? shortPath(m.folder) : shortPath(dir)})`,
      why: `${LONG_INDEX}자 넘는 색인 줄은 링크와 한 구절만 남기고, 자세한 설명은 그 주제 파일에 원문 그대로 남긴다(원문 보존 검사). MEMORY.md 는 앞 ${MEMORY_MAX_LINES}줄·${MEMORY_MAX_BYTES / 1024}KB 만 실린다.`,
      evidence, ops, model, tokens: saved,
    }, dir);
  }

  // 6. 기억 추가: 적히지 않은 채 반복된 교정 → 메모 초안(모델)
  const rec = latestRecurrenceRun();
  if (rec && judge?.modelEnabled) {
    const items = rec.result.items.filter((i) => i.branch === 'unwritten-repeat' && !i.becameMemory);
    const parent = new Map<string, string>();
    const find = (x: string): string => { if (!parent.has(x)) parent.set(x, x); let r = x; while (parent.get(r) !== r) r = parent.get(r) as string; parent.set(x, r); return r; };
    const ids = new Set(items.map((i) => i.id));
    for (const i of items) for (const p of i.pairs) if (p.tier === 'earlier' && p.verdict === 'yes' && p.key.startsWith('replay:') && ids.has(p.key.slice(7))) { const [a, b] = [find(i.id), find(p.key.slice(7))]; if (a !== b) parent.set(a < b ? b : a, a < b ? a : b); }
    const grouped = new Map<string, typeof items>();
    for (const i of items) grouped.set(find(i.id), [...(grouped.get(find(i.id)) ?? []), i]);
    const folders = run.result.folders.map((f) => f.folder).sort((a, b) => b.length - a.length);
    const memoReq = [...grouped].map(([gid, its]) => ({ id: gid, task: 'memo' as const, texts: [...new Set(its.map((i) => i.gist))].slice(0, 4) }));
    const memos = await fixTexts(memoReq);
    for (const [gid, its] of grouped) {
      const v = memos.get(gid);
      if (!v?.text) continue;
      const cwd = its[0].cwd ? path.resolve(its[0].cwd) : env.home;
      const folder = folders.find((f) => cwd === f || cwd.startsWith(`${f}${path.sep}`)) ?? folders.find((f) => f === env.home);
      if (!folder) continue;
      const fs0 = folderOf.get(folder);
      const memDir = fs0?.memoryDir ?? path.join(env.claudeDir, 'projects', encodeProjectDir(gitRootOf(folder, env.home) ?? folder), 'memory');
      const name = (v.name ?? its[0].gist).replace(/[\r\n]+/g, ' ').slice(0, 40);
      const slug = `feedback_forgen_${sha(gid).slice(0, 6)}`;
      const file = path.join(memDir, `${slug}.md`);
      const nested = (ctx.memory.get(memDir)?.topics ?? []).some((t) => /\nmetadata:\s*\n\s+type:/.test(t.text));
      const dates = [...new Set(its.map((i) => i.ts.slice(0, 10)))].sort();
      const desc = (v.description ?? v.text).replace(/[\r\n]+/g, ' ').slice(0, 120);
      const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(desc)}\n${nested ? 'metadata:\n  type: feedback' : 'type: feedback'}\n---\n\n${v.text.trim()}\n\n근거: 같은 교정이 적히지 않은 채 다시 나옴 — ${dates.join(', ')} (forgen audit recurrence, forgen fix 초안)\n`;
      add({
        kind: 'add-memory', title: `기억 추가 — ${shortText(name, 40)} (${shortPath(folder)} 메모)`,
        why: '적히지 않은 채 반복된 교정이다. 자동 메모(feedback) 초안을 주제 파일 + MEMORY.md 색인 줄로 쓴다(호스트 형식).',
        evidence: its.map((i) => `${i.ts.slice(0, 10)} ${shortText(i.gist, 80)}`),
        ops: [{ op: 'create', path: file, content }, { op: 'append', path: path.join(memDir, 'MEMORY.md'), text: `- [${name}](${slug}.md) — ${shortText(desc, INDEX_HOOK_MAX)}` }],
        model: true, tokens: -estimateTokens(`- [${name}](${slug}.md) — ${shortText(desc, INDEX_HOOK_MAX)}`),
        addsTo: { folder, tokens: estimateTokens(`- [${name}](${slug}.md) — ${shortText(desc, INDEX_HOOK_MAX)}\n`) },
      }, gid);
    }
  }

  // 7. 플러그인·스킬 끄기 제안(끄기만)
  for (const { identity, ...f } of planPluginOff(env, now)) add(f, identity);

  fixes.sort((a, b) => FIX_KINDS.indexOf(a.kind) - FIX_KINDS.indexOf(b.kind) || (a.id < b.id ? -1 : 1));
  return { fixes, run, model: mc, generatedAt: now.toISOString() };
}

/** 예전 이름 플러그인·같은 이름 중복 플러그인·30일 안 쓴 forgen 스킬. */
function planPluginOff(env: AuditEnv, now: Date): Array<Omit<Fix, 'id' | 'marks' | 'equivalents' | 'model' | 'tokens'> & { identity: string; tokens: number }> {
  const out: Array<Omit<Fix, 'id' | 'marks' | 'equivalents' | 'model' | 'tokens'> & { identity: string; tokens: number }> = [];
  const settings = path.join(env.claudeDir, 'settings.json');
  let enabled: Record<string, unknown> = {};
  try { enabled = (JSON.parse(fs.readFileSync(settings, 'utf-8')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}; } catch { /* 없음 */ }
  const on = Object.keys(enabled).filter((k) => enabled[k] === true).sort();
  const byName = new Map<string, string[]>();
  for (const id of on) byName.set(id.split('@')[0], [...(byName.get(id.split('@')[0]) ?? []), id]);
  for (const [name, ids] of byName) {
    const legacy = LEGACY_NAMES.includes(name);
    const keep = legacy ? null : [...ids].sort((a, b) => Number(!a.endsWith('@claude-plugins-official')) - Number(!b.endsWith('@claude-plugins-official')) || (a < b ? -1 : 1))[0];
    for (const id of ids.filter((x) => x !== keep)) {
      out.push({
        kind: 'plugin-off', identity: `plugin:${id}`, title: `플러그인 끄기 — ${id}${legacy ? ' (예전 이름)' : ` (같은 이름 ${keep} 이 켜져 있음)`}`,
        why: legacy ? 'forgen 의 예전 이름 플러그인이 아직 켜져 있어 스킬 설명이 세션마다 실린다. 끄기만 한다(지우지 않음).' : '같은 플러그인이 다른 마켓에서 두 번 켜져 스킬 설명이 두 번 실린다. 하나를 끈다(지우지 않음).',
        evidence: [`${settings} enabledPlugins["${id}"] = true`], ops: [{ op: 'json-set', path: settings, keys: ['enabledPlugins', id], value: false }], tokens: 0,
      });
    }
  }
  for (const name of LEGACY_NAMES) {
    const dir = path.join(env.claudeDir, 'commands', name);
    if (!fs.existsSync(dir)) continue;
    let tokens = 0;
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) tokens += estimateTokens(`- ${name}:${f.replace(/\.md$/, '')}: ${frontmatterField(fs.readFileSync(path.join(dir, f), 'utf-8'), 'description') ?? ''}`); } catch { /* 읽기 실패 */ }
    out.push({
      kind: 'plugin-off', identity: `commands:${name}`, title: `예전 이름 명령 폴더 끄기 — ${path.join('commands', name)} (스킬 목록 약 ${tokens}토큰)`,
      why: 'forgen 의 예전 이름으로 깔린 명령 폴더가 남아 스킬 목록에 세션마다 실린다. 백업 폴더로 옮겨 끈다(되돌리기 한 줄).', evidence: [dir], ops: [{ op: 'move-away', path: dir }], tokens,
    });
  }
  // 30일 안 쓴 forgen 스킬(사용자 스킬 폴더의 forgen-* — forgen 이 깐 개발 안내 스킬)
  const skillsDir = path.join(env.claudeDir, 'skills');
  let skills: string[] = [];
  try { skills = fs.readdirSync(skillsDir).filter((n) => n.startsWith('forgen-') && fs.existsSync(path.join(skillsDir, n, 'SKILL.md'))).sort(); } catch { /* 없음 */ }
  if (skills.length) {
    const used = skillUsage(env.claudeDir, skills, now);
    if (used) for (const n of skills.filter((s) => !used.get(s))) {
      const t = readText(path.join(skillsDir, n, 'SKILL.md')) ?? '';
      const tokens = estimateTokens(`- ${frontmatterField(t, 'name') ?? n}: ${frontmatterField(t, 'description') ?? ''}`);
      out.push({
        kind: 'plugin-off', identity: `skill:${n}`, title: `안 쓰는 스킬 끄기 — ${n} (30일 호출 0 · 약 ${tokens}토큰)`,
        why: `지난 ${UNUSED_DAYS}일 대화 기록에서 한 번도 부르지 않은 forgen 스킬이다. 백업 폴더로 옮겨 끈다(되돌리기 한 줄). forgen 을 다시 설치하면 돌아온다.`,
        evidence: [path.join(skillsDir, n)], ops: [{ op: 'move-away', path: path.join(skillsDir, n) }], tokens,
      });
    }
  }
  return out;
}

/** 최근 30일 대화 기록(최상위 세션)에서 스킬을 부른 횟수. 기록이 없으면 null(판단 못 함 — 제안 안 함). */
export function skillUsage(claudeDir: string, names: string[], now = new Date()): Map<string, number> | null {
  const root = path.join(claudeDir, 'projects');
  const since = now.getTime() - UNUSED_DAYS * DAY;
  const counts = new Map(names.map((n) => [n, 0]));
  let files = 0;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    let names2: string[] = [];
    try { names2 = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of names2) {
      const p = path.join(root, d, f);
      try { if (fs.statSync(p).mtimeMs < since) continue; } catch { continue; }
      files++;
      const t = readText(p) ?? '';
      for (const n of names) if (t.includes(`"skill":"${n}"`) || t.includes(`"skill": "${n}"`) || t.includes(`<command-name>/${n}<`)) counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  return files ? counts : null;
}

// ── 적용·되돌리기 ──

export const fixDir = () => path.join(FORGEN_HOME, 'audit', 'fix');
export const ledgerPath = () => path.join(fixDir(), 'ledger.jsonl');
export const deletedPath = () => path.join(FORGEN_HOME, 'audit', 'deleted.jsonl');

export interface LedgerEvent { at: string; event: 'proposed' | 'apply' | 'undo' | 'undo-conflict' | 'skip'; id: string; kind: FixKind; backup?: string; equivalents?: Fix['equivalents']; scopedTo?: Fix['scopedTo']; addsTo?: Fix['addsTo']; note?: string }

/** 원자적 쓰기: 같은 폴더 임시 파일 → rename(심링크면 가리키는 대상에). 도중에 죽어도 반쪽 파일이 남지 않는다. */
export function atomicWrite(p: string, data: string | Buffer, mode = 0o644): void {
  let target = p;
  try { target = fs.realpathSync(p); } catch { /* 새 파일 */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.forgen-fix-${process.pid}-${createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 8)}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* 없음 */ } throw e; }
}

function write600(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, body, { mode: 0o600 });
}
export function appendLedger(e: LedgerEvent): void {
  fs.mkdirSync(fixDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(ledgerPath(), `${JSON.stringify(e)}\n`, { mode: 0o600 });
}
export function readLedger(): LedgerEvent[] {
  const t = readText(ledgerPath());
  if (!t) return [];
  return t.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as LedgerEvent]; } catch { return []; } });
}
/** 처음 보는 처방을 "제안됨"으로 남긴다(적용률의 분모). */
export function recordProposed(fixes: Fix[], now = new Date()): void {
  const seen = new Set(readLedger().filter((e) => e.event === 'proposed').map((e) => e.id));
  for (const f of fixes) if (!f.blocked && !seen.has(f.id)) appendLedger({ at: now.toISOString(), event: 'proposed', id: f.id, kind: f.kind });
}

/** 파일·폴더 상태 지문: 파일은 내용 해시, 폴더는 (상대 경로·내용) 해시, 없으면 'absent'. */
export function stateHash(p: string): string {
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { return 'absent'; } // 심링크는 가리키는 대상 기준
  if (st.isFile()) return sha(fs.readFileSync(p).toString('base64'));
  if (!st.isDirectory()) return `other:${st.mode}`;
  const h = createHash('sha256');
  const walk = (d: string, rel: string) => {
    for (const n of fs.readdirSync(d).sort()) {
      const q = path.join(d, n);
      const s = fs.statSync(q);
      h.update(`${rel}/${n}|${s.isDirectory() ? 'd' : 'f'}|`);
      if (s.isDirectory()) walk(q, `${rel}/${n}`); else if (s.isFile()) h.update(fs.readFileSync(q));
    }
  };
  walk(p, '');
  return `dir:${h.digest('hex')}`;
}

interface BackupEntry { path: string; before: string; after: string; existed: boolean; isDir: boolean; slot: string }
interface BackupRecord { schema: 'forgen-fix-backup/1'; id: string; kind: FixKind; at: string; title: string; entries: BackupEntry[]; marks: number }

function copyInto(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true });
}

/** 미리보기: 처방을 적용하면 파일마다 어떻게 바뀌나(파일은 내용, 룰은 JSON). 지금 내용에 대고 푼다. */
export function previewFix(f: Fix, nowIso = new Date().toISOString()): Array<{ path: string; before: string | null; after: string | null; dir?: boolean }> {
  const byPath = new Map<string, Op[]>();
  for (const o of f.ops) byPath.set(opPath(o), [...(byPath.get(opPath(o)) ?? []), o]);
  const out: Array<{ path: string; before: string | null; after: string | null; dir?: boolean }> = [];
  const ruleCache = new Map<string, Rule>();
  for (const [p, ops] of byPath) {
    if (ops[0].op === 'move-away') { out.push({ path: p, before: '(폴더)', after: null, dir: true }); continue; }
    if (ops[0].op === 'rule') {
      let r = loadRule((ops[0] as Extract<Op, { op: 'rule' }>).ruleId);
      if (!r) throw new Error(`룰이 없다: ${p}`);
      const before = `${JSON.stringify(r, null, 2)}\n`;
      for (const o of ops) r = ruleAfter(r, o as Extract<Op, { op: 'rule' }>, f.id, nowIso, ruleCache);
      out.push({ path: p, before, after: `${JSON.stringify(r, null, 2)}\n` });
      continue;
    }
    const before = readText(p);
    out.push({ path: p, before, after: applyTextOps(before, ops) });
  }
  return out;
}

/** 처방 하나 적용: 스냅샷 → 연산 → 지움 표시 → 원장. 대상이 바뀌어 풀리지 않으면 아무것도 쓰지 않고 예외. */
export function applyFix(f: Fix, backupRoot: string, now = new Date()): { backup: string } {
  if (f.blocked) throw new Error(`적용할 수 없는 처방(지적만): ${f.blocked}`);
  const nowIso = now.toISOString();
  const preview = previewFix(f, nowIso); // 먼저 다 풀어 본다 — 하나라도 안 풀리면 여기서 멈춘다
  const dir = path.join(backupRoot, f.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entries: BackupEntry[] = [];
  preview.forEach((pv, i) => {
    const slot = String(i);
    const existed = fs.existsSync(pv.path);
    const isDir = !!pv.dir;
    if (existed) copyInto(pv.path, path.join(dir, 'before', slot));
    entries.push({ path: pv.path, before: stateHash(pv.path), after: '', existed, isDir, slot });
  });
  // 연산 — 중간에 실패하면 이 처방이 쓴 것을 스냅샷으로 되돌리고 예외
  const ruleCache = new Map<string, Rule>();
  try {
  for (const pv of preview) {
    const ops = f.ops.filter((o) => opPath(o) === pv.path);
    const o0 = ops[0];
    if (o0.op === 'move-away') { fs.renameSync(pv.path, path.join(dir, 'moved-away')); continue; }
    if (o0.op === 'rule') {
      const sc = ops.find((o) => o.op === 'rule' && o.change === 'scope') as Extract<Op, { op: 'rule'; change: 'scope' }> | undefined;
      if (sc) {
        // 범위 옮기기는 classify-projects --apply 와 같은 경로(잠금 안에서 다시 읽고 범위가 없을 때만)
        if (!applyRuleProjects(o0.ruleId, sc.projects)) throw new Error(`범위를 넣지 못함(이미 범위가 있거나 hard): ${o0.ruleId}`);
        continue;
      }
      withFileLockSync(rulePath(o0.ruleId), () => {
        const fresh = loadRule(o0.ruleId);
        if (!fresh) throw new Error(`룰이 없다: ${o0.ruleId}`);
        let r = fresh;
        for (const o of ops) r = ruleAfter(r, o as Extract<Op, { op: 'rule' }>, f.id, nowIso, ruleCache);
        saveRule(r);
      });
      continue;
    }
    const after = pv.after;
    if (after === null) fs.rmSync(pv.path, { force: true });
    else {
      let mode = 0o644;
      try { mode = fs.statSync(pv.path).mode & 0o777; } catch { /* 새 파일 */ }
      atomicWrite(pv.path, after, mode);
    }
  }
  } catch (err) {
    for (const e of entries) {
      try {
        const moved = path.join(dir, 'moved-away');
        if (e.isDir) { if (fs.existsSync(moved) && !fs.existsSync(e.path)) fs.renameSync(moved, e.path); continue; }
        if (!e.existed) fs.rmSync(e.path, { force: true });
        else atomicWrite(e.path, fs.readFileSync(path.join(dir, 'before', e.slot)), fs.statSync(path.join(dir, 'before', e.slot)).mode & 0o777);
      } catch { /* 되돌리기 실패는 스냅샷이 남아 있다 */ }
    }
    throw err;
  }
  for (const e of entries) {
    e.after = stateHash(e.path);
    if (fs.existsSync(e.path) && !e.isDir) copyInto(e.path, path.join(dir, 'after', e.slot));
  }
  // 지움 표시 + 지문(§4.3) — 재발 재생이 "지운 뒤 다시 말함"을 읽는다
  if (f.marks.length) {
    fs.mkdirSync(path.dirname(deletedPath()), { recursive: true, mode: 0o700 });
    fs.appendFileSync(deletedPath(), f.marks.map((m) => `${JSON.stringify({ at: nowIso, ...m, fp: fp(m.text), fix: f.id })}\n`).join(''), { mode: 0o600 });
  }
  const rec: BackupRecord = { schema: 'forgen-fix-backup/1', id: f.id, kind: f.kind, at: nowIso, title: f.title, entries, marks: f.marks.length };
  write600(path.join(dir, 'backup.json'), `${JSON.stringify(rec, null, 2)}\n`);
  appendLedger({ at: nowIso, event: 'apply', id: f.id, kind: f.kind, backup: dir, equivalents: f.equivalents, ...(f.scopedTo ? { scopedTo: f.scopedTo } : {}), ...(f.addsTo ? { addsTo: f.addsTo } : {}) });
  return { backup: dir };
}

/**
 * 전역 잠금: 적용·되돌리기는 한 번에 하나만(<FORGEN_HOME>/audit/fix/run.lock). 잠금을 쥔 프로세스가 죽었고 30초 넘었으면 회수,
 * 살아 있으면 기다리지 않고 실패한다(묶음 적용은 몇 분 걸릴 수 있다).
 */
export async function withFixLock<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(fixDir(), { recursive: true, mode: 0o700 });
  const { withFileLock } = await import('../hooks/shared/file-lock.js');
  try {
    return await withFileLock(path.join(fixDir(), 'run'), fn, { timeoutMs: 1500 });
  } catch (e) {
    if (e instanceof Error && /File lock timeout/.test(e.message)) throw new Error('다른 forgen fix 가 적용·되돌리기 중이다(~/.forgen/audit/fix/run.lock) — 끝난 뒤 다시 실행');
    throw e;
  }
}

export function newBackupRoot(now = new Date()): string {
  const base = path.join(FORGEN_HOME, 'backups');
  let d = path.join(base, `fix-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`);
  for (let i = 2; fs.existsSync(d); i++) d = `${d.replace(/-\d+$/, '')}-${i}`;
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** 아직 되돌리지 않은 적용(최근 것 먼저). */
export function appliedFixes(): Array<{ id: string; kind: FixKind; backup: string; at: string }> {
  // 원장 순서(같은 밀리초에 적용한 것도 순서가 있다)의 역순 — 되돌리기는 나중에 적용한 것부터
  const live = new Map<string, { id: string; kind: FixKind; backup: string; at: string; n: number }>();
  readLedger().forEach((e, n) => {
    if (e.event === 'apply' && e.backup) { live.delete(e.id); live.set(e.id, { id: e.id, kind: e.kind, backup: e.backup, at: e.at, n }); }
    if (e.event === 'undo') live.delete(e.id);
  });
  return [...live.values()].sort((a, b) => b.n - a.n).map(({ n: _n, ...x }) => x);
}

export interface UndoConflict { path: string; base: string | null; fixed: string | null; current: string | null }

/** 되돌리기: 그 처방이 건드린 파일만. 그사이 바뀐 파일이 있으면 아무것도 바꾸지 않고 3자(처방 전·처방 뒤·지금)를 돌려준다. */
export function undoFix(id: string, now = new Date()): { restored: number } | { conflicts: UndoConflict[] } {
  const a = appliedFixes().find((x) => x.id === id || x.id.startsWith(id));
  if (!a) throw new Error(`되돌릴 적용 기록이 없다: ${id}`);
  const rec = JSON.parse(fs.readFileSync(path.join(a.backup, 'backup.json'), 'utf-8')) as BackupRecord;
  const conflicts: UndoConflict[] = [];
  for (const e of rec.entries) {
    if (stateHash(e.path) === e.after) continue;
    conflicts.push({ path: e.path, base: e.isDir ? '(폴더)' : readText(path.join(a.backup, 'before', e.slot)), fixed: e.isDir ? null : readText(path.join(a.backup, 'after', e.slot)), current: e.isDir ? '(폴더)' : readText(e.path) });
  }
  if (conflicts.length) {
    appendLedger({ at: now.toISOString(), event: 'undo-conflict', id: rec.id, kind: rec.kind, backup: a.backup, note: conflicts.map((c) => c.path).join(', ') });
    return { conflicts };
  }
  for (const e of rec.entries) {
    if (e.isDir) {
      if (e.existed) fs.renameSync(path.join(a.backup, 'moved-away'), e.path);
      continue;
    }
    if (!e.existed) { fs.rmSync(e.path, { force: true }); continue; }
    const src = path.join(a.backup, 'before', e.slot);
    const mode = fs.statSync(src).mode & 0o777;
    atomicWrite(e.path, fs.readFileSync(src), mode);
    const st = fs.statSync(src);
    fs.utimesSync(e.path, st.atime, st.mtime);
  }
  // 지움 표시 거두기
  const dp = deletedPath();
  const t = readText(dp);
  if (t) {
    const kept = t.split('\n').filter((l) => { if (!l) return false; try { return (JSON.parse(l) as { fix?: string }).fix !== rec.id; } catch { return true; } });
    if (kept.length) atomicWrite(dp, `${kept.join('\n')}\n`, 0o600); else fs.rmSync(dp, { force: true });
  }
  appendLedger({ at: now.toISOString(), event: 'undo', id: rec.id, kind: rec.kind, backup: a.backup });
  return { restored: rec.entries.length };
}

// ── 측정: N3(폴더별, 스킬 설명 제외) · 중요 지침 누락 · 적용률·되돌림률 ──

export interface FolderMeasure { folder: string; projectKey: string | null; tokens: number; skills: number; important: string[]; loaded: string[] }
export interface Measure { at: string; folders: FolderMeasure[] }

/** 감사 회차에서 폴더마다 상시 로드 토큰(§1.1 의 다섯 층 + forgen 주입, 스킬 설명 제외)과 실리는 지시의 신원. */
export function measure(run: AuditRun, now = new Date()): Measure {
  const ctx = run.ctx;
  const typeOf = new Map<string, string | undefined>();
  for (const m of ctx.memory.values()) for (const t of m.topics) typeOf.set(t.path, t.memoryType);
  return {
    at: now.toISOString(),
    folders: run.result.folders.map((f) => {
      const loaded = new Set<string>();
      const important = new Set<string>();
      for (const u of ctx.units) {
        if (!(ctx.loadedIn.get(unitKey(u)) ?? []).includes(f.folder)) continue;
        loaded.add(`norm:${u.norm}`);
        if (u.ruleId) {
          loaded.add(`rule:${u.ruleId}`);
          const r = ctx.rules.get(u.ruleId);
          if (r && isImportantRule(r)) important.add(`rule:${u.ruleId}`);
        }
        const link = u.layer === 'memory-index' ? linkOf(u.text) : null;
        if (link) {
          const tp = path.resolve(path.dirname(u.path), link);
          loaded.add(`topic:${tp}`);
          if (typeOf.get(tp) === 'feedback') important.add(`topic:${tp}`);
        }
      }
      const skills = f.skills?.tokens ?? 0;
      return { folder: f.folder, projectKey: f.projectKey, tokens: f.totalTokens - skills, skills, important: [...important].sort(), loaded: [...loaded].sort() };
    }),
  };
}

export interface LossReport { folder: string; missing: string[] }

/**
 * 누락 검사(§2.3): 처방 전 그 폴더에 실리던 중요 지침이 처방 뒤 같은 뜻으로 어디에도 실리지 않으면 누락.
 * 같은 뜻 = 그대로 실림 · 적용한 처방의 대응(합친 쪽·호스트 사본·다시 쓴 문장, 이어서 따라감) · 범위를 옮긴 룰은 그 프로젝트 폴더에서만 보면 된다.
 */
export function lossCheck(before: Measure, after: Measure, events: LedgerEvent[]): LossReport[] {
  const live = new Map<string, LedgerEvent>();
  for (const e of events) { if (e.event === 'apply') live.set(e.id, e); if (e.event === 'undo') live.delete(e.id); }
  const eq = new Map<string, string[]>();
  for (const e of live.values()) {
    for (const x of e.equivalents ?? []) eq.set(x.from, [...(eq.get(x.from) ?? []), x.to]);
  }
  const out: LossReport[] = [];
  for (const b of before.folders) {
    const a = after.folders.find((x) => x.folder === b.folder);
    const loaded = new Set(a?.loaded ?? []);
    const ok = (k: string, seen = new Set<string>()): boolean => {
      if (loaded.has(k)) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return (eq.get(k) ?? []).some((t) => ok(t, seen));
    };
    // 범위를 옮긴 룰이라도 중요 지침이면 다른 폴더에서 빠진 것을 누락으로 센다(important 는 중요 지침만 담는다)
    const missing = b.important.filter((k) => !ok(k));
    if (missing.length) out.push({ folder: b.folder, missing });
  }
  return out;
}

export function rates(events = readLedger()): { proposed: number; applied: number; undone: number; applyRate: number | null; undoRate: number | null; byKind: Record<string, { proposed: number; applied: number; undone: number }> } {
  const proposed = new Map<string, FixKind>();
  const applied = new Map<string, FixKind>();
  const undone = new Set<string>();
  for (const e of events) {
    if (e.event === 'proposed') proposed.set(e.id, e.kind);
    if (e.event === 'apply') applied.set(e.id, e.kind);
    if (e.event === 'undo') undone.add(e.id);
  }
  const byKind: Record<string, { proposed: number; applied: number; undone: number }> = {};
  const bump = (k: string, f: 'proposed' | 'applied' | 'undone') => { byKind[k] ??= { proposed: 0, applied: 0, undone: 0 }; byKind[k][f]++; };
  for (const k of proposed.values()) bump(k, 'proposed');
  for (const [id, k] of applied) { bump(k, 'applied'); if (undone.has(id)) bump(k, 'undone'); }
  const nApplied = applied.size;
  return { proposed: proposed.size, applied: nApplied, undone: [...undone].filter((id) => applied.has(id)).length, applyRate: proposed.size ? Math.round((nApplied / proposed.size) * 1000) / 1000 : null, undoRate: nApplied ? Math.round(([...undone].filter((id) => applied.has(id)).length / nApplied) * 1000) / 1000 : null, byKind };
}

export const baselinePath = () => path.join(fixDir(), 'baseline.json');
/** 처음 적용하기 전 상태를 남긴다(적용 전후 N3·누락 비교의 "전"). 이미 있으면 그대로. */
export function ensureBaseline(run: AuditRun, now = new Date()): Measure {
  const t = readText(baselinePath());
  if (t) { try { return JSON.parse(t) as Measure; } catch { /* 깨짐 → 다시 */ } }
  const m = measure(run, now);
  write600(baselinePath(), `${JSON.stringify(m, null, 2)}\n`);
  return m;
}

// ── diff ──

/** 줄 단위 diff(LCS) — 기억 파일은 작아서 충분하다. 바뀐 곳 앞뒤 2줄. */
export function unifiedDiff(a: string | null, b: string | null, label: string): string[] {
  const x = a === null ? [] : a.split('\n');
  const y = b === null ? [] : b.split('\n');
  const n = x.length;
  const m = y.length;
  if (n * m > 4_000_000) return [`--- ${label}`, `(파일이 커서 줄 비교를 생략: ${n}줄 → ${m}줄)`];
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const rows: Array<[' ' | '-' | '+', string]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) { if (x[i] === y[j]) { rows.push([' ', x[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) rows.push(['-', x[i++]]); else rows.push(['+', y[j++]]); }
  while (i < n) rows.push(['-', x[i++]]);
  while (j < m) rows.push(['+', y[j++]]);
  const out = [`--- ${a === null ? '(없음)' : label}`, `+++ ${b === null ? '(없음)' : label}`];
  const show = rows.map((r, k) => r[0] !== ' ' || rows.slice(Math.max(0, k - 2), k + 3).some((q) => q[0] !== ' '));
  let gap = false;
  rows.forEach((r, k) => { if (show[k]) { out.push(`${r[0]}${r[1]}`); gap = false; } else if (!gap) { out.push('@@'); gap = true; } });
  return out;
}
