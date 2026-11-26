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
import { applyRuleProjects, judgeRuleScopes, type ContentVerdict } from '../engine/rule-project-cli.js';
import { isHomeDir } from '../way/io.js';
import { withFileLockSync } from '../hooks/shared/file-lock.js';
import { withStatusChange } from '../store/rule-lifecycle.js';
import { appliesForContext, mergeRuleProjects } from '../store/rule-scope.js';
import { loadRule, rulePath, saveRule } from '../store/rule-store.js';
import type { AppliesWhen, Rule } from '../store/types.js';
import { isImportantRule, normalizeSentence, type Unit } from './checks.js';
import { PAIR_MODEL, type Judge } from './judge.js';
import { latestRecurrenceRun } from './recurrence.js';
import { unitKey, type AuditRun } from './run.js';
import type { ModelChecks } from './model-checks.js';
import { defaultEnv, encodeProjectDir, frontmatterField, gitRootOf, MEMORY_MAX_BYTES, MEMORY_MAX_LINES, splitFrontmatter, type AuditEnv } from './sources.js';
import { estimateTokens } from './tokens.js';
import { representative } from './activity.js';
import { shortPath } from './html.js';

export type FixKind = 'plugin-off' | 'remove' | 'merge' | 'overlap' | 'scope' | 'move' | 'rewrite' | 'index' | 'add-memory' | 'tier2-condition';
/** 묶음 적용 순서: 끄기 → 지우기 → 합치기 → 겹침 → 범위 → 옮기기 → 짧게 → 색인 → 기억 추가(색인에 덧붙이므로) → 두 층 발동 조건(룰만 바꿈). */
export const FIX_KINDS: FixKind[] = ['plugin-off', 'remove', 'merge', 'overlap', 'scope', 'move', 'rewrite', 'index', 'add-memory', 'tier2-condition'];
export const KIND_LABEL: Record<FixKind, string> = {
  'plugin-off': '플러그인·스킬 끄기', remove: '지우기·끄기', merge: '합치기', overlap: '겹치는 교정 한 곳만', scope: 'forgen 룰 범위 옮기기',
  move: '폴더 전용 룰로 옮기기', rewrite: '짧게 다시 쓰기', index: 'MEMORY.md 긴 줄 짧게', 'add-memory': '기억 추가',
  'tier2-condition': '상황 맞춤 조건(그 상황에만 넣기)',
};
/** 발동 조건 초안에서 고를 수 있는 도구 이름(호스트 내장 도구). */
export const CONDITION_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'AskUserQuestion', 'Skill'];

/** 발동 조건 한 줄(목록에서 읽히게). */
export function conditionLine(c: AppliesWhen): string {
  const q = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ');
  return [
    c.folders?.length ? `폴더 ${c.folders.join(', ')}` : '어느 폴더나',
    c.tools?.length ? `도구 ${c.tools.join(', ')}` : '',
    c.commands?.length ? `명령 ${q(c.commands)}` : '',
    c.paths?.length ? `경로 ${c.paths.join(', ')}` : '',
    c.words?.length ? `낱말 ${c.words.join('·')}` : '',
  ].filter(Boolean).join(' · ');
}
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
  | { op: 'rule'; ruleId: string; change: 'applies-when'; appliesWhen: AppliesWhen }
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
  /** 바뀌기 전/후 문장(목록·보기 화면용, 파일 diff 는 상세에만) */
  change?: { before: string; after: string };
  /** tier2-condition: 과거 세션 재생으로 잰 발동률(넓음 ≥ 50% 세션, 좁음 = 0%) */
  estimate?: { sessions: number; turns: number; sessionsN: number; wide: boolean; narrow: boolean };
}

export interface FixPlan { fixes: Fix[]; run: AuditRun; model: ModelChecks | null; generatedAt: string; /** 제안하지 않은 상황 맞춤 조건 수(최근 세션에서 한 번도 걸리지 않음) */ notProposedConditions?: number }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const fp = (s: string) => sha(normalizeSentence(s)).slice(0, 12);
/** 처방 신원은 줄 번호가 아니라 (파일·정규화 문장) — 앞 처방이 줄을 지워 번호가 밀려도 같은 처방이다. */
export const ident = (u: { ruleId?: string; path: string; norm: string }) => u.ruleId ?? `${u.path}|${u.norm}`;
/** 사용자에게 보이는 종류 이름(명령·처방 id 앞머리). 내부 종류 'tier2-condition' 은 화면에서 'condition'. */
export const KIND_CLI: Record<FixKind, string> = {
  'plugin-off': 'plugin-off', remove: 'remove', merge: 'merge', overlap: 'overlap', scope: 'scope', move: 'move', rewrite: 'rewrite', index: 'index', 'add-memory': 'add-memory', 'tier2-condition': 'condition',
};
/** 명령에서 받은 종류 이름 → 내부 종류(예전 이름 tier2-condition 도 받는다). */
export function kindFromCli(k: string): FixKind | null {
  if (k === 'tier2-condition' || k === 'condition') return 'tier2-condition';
  return (FIX_KINDS as string[]).includes(k) ? (k as FixKind) : null;
}
export const fixId = (kind: FixKind, identity: string) => `${KIND_CLI[kind]}-${sha(`${kind}|${identity}`).slice(0, 8)}`;
const readText = (p: string): string | null => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } };
const isMdLayer = (l: string) => ['user', 'user-rules', 'project', 'project-local', 'project-rules', 'agents', 'import'].includes(l);
const STRENGTH_RANK: Record<string, number> = { hard: 0, strong: 1, default: 2, soft: 3 };
export { isImportantRule };

/** Q3: 처방이 직접 써도 되는 파일인가. 안 되면 그 까닭. */
export function writeBlock(p: string, env: AuditEnv): string | null {
  if (env.managedPaths.includes(p)) return '회사가 관리하는 정책 파일이라 forgen 이 고치지 않음';
  const rel = path.relative(path.join(env.claudeDir, 'projects'), p);
  if (!rel.startsWith('..') && rel.split(path.sep)[1] === 'memory') return null;
  if (p.startsWith(`${ME_RULES}${path.sep}`)) return null;
  if (/[\\/]\.claude[\\/]rules[\\/].+\.md$/.test(p)) return null;
  const base = path.basename(p);
  if (base === 'CLAUDE.md' || base === 'CLAUDE.local.md' || base === 'AGENTS.md') {
    return gitRootOf(path.dirname(p), env.home) ? null : 'git 밖 지침 파일이라 고치지 않음(되돌릴 기록이 없음 — git 안 CLAUDE.md·AGENTS.md 만 고친다). 직접 고치세요';
  }
  return 'forgen 이 고치지 않는 파일 — 직접 고치세요';
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
    // 승인 표시를 붙여야 자격 게이트를 대신한다(tier2.approvedCondition). 되돌리기는 룰 파일 스냅샷으로 — 조건이 빠지면 1층으로.
    case 'applies-when': return { ...r, applies_when: { ...o.appliesWhen, approved: { at: nowIso, fix: fixIdStr } } };
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
/** 화면용 인용: 목록 표지를 떼고 앞부분만. */
const q = (t: string, n = 40) => `"${shortText(t.replace(/^\s*[-*]\s+/, ''), n)}"`;
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
  const unitWhere = (u: Unit) => (u.ruleId ? 'forgen 룰' : `${shortPath(u.path)}:${u.line}`);
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
          kind: 'overlap', title: `forgen 룰 ${q(r.u.text)} → 세션 시작에 넣지 않음(룰은 남김). 같은 교정이 ${unitWhere(host.u)} 에 이미 실리기 때문 — 안 하면 같은 교정이 세션마다 두 번 실린다`,
          why: '같은 교정이 forgen 룰과 Claude 기억(CLAUDE.md·메모) 양쪽에 있다. Claude 기억 쪽을 남기고 forgen 은 세션 시작에 넣는 것만 뺀다. 룰 자체는 남아 차단·기록에는 계속 쓰인다.',
          change: { before: `두 곳에 실림: forgen 룰 · ${unitWhere(host.u)}`, after: `${unitWhere(host.u)} 한 곳에만 실림` },
          evidence: [`룰: ${shortText(r.u.text)}`, `Claude 기억: ${unitWhere(host.u)} ${shortText(host.u.text)}`, g.source === 'same' ? '같은 문장' : '같은 뜻(모델 판정)'],
          ops: [{ op: 'rule', ruleId: r.u.ruleId as string, change: 'host-copy', host: { path: host.u.path, line: host.u.line } }],
          equivalents: [{ from: `rule:${r.u.ruleId}`, to: hostKeyOf(host.u) }], tokens: r.u.tokens,
        }, `${ident(r.u)}|${ident(host.u)}`);
      } else if (topics.length && !loadedHosts.length) {
        add({
          kind: 'overlap', title: `forgen 룰 ${q(r.u.text)} 과 같은 교정이 메모 파일(${path.basename(topics[0].u.path)})에도 있음 — 그대로 둠`,
          why: '같은 교정이 메모 파일에도 있지만, 메모 파일 본문은 세션 시작에 실리지 않는다. forgen 룰을 빼면 그 교정이 어디에도 실리지 않으므로 고치지 않는다.',
          evidence: [`룰: ${shortText(r.u.text)}`, `메모 파일: ${shortPath(topics[0].u.path)}`], ops: [], blocked: '메모 파일은 세션 시작에 안 실려, 빼면 그 교정이 사라짐',
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
      kind: 'merge', title: g.source === 'same'
        ? `같은 문장 ${q(keeper.u.text)} 이 ${drop.length + 1}곳에 있음 → ${unitWhere(keeper.u)} 하나만 남기고 지움 — 안 하면 같은 줄이 세션마다 ${drop.length + 1}번 실린다`
        : `같은 뜻 지시 ${drop.length + 1}개 → ${unitWhere(keeper.u)} 한 문장으로 합침 — 안 하면 같은 뜻이 세션마다 ${drop.length + 1}번 실린다`,
      why: g.source === 'same' ? '글자만 조금 다른 같은 문장이 여러 파일에 있다. 그 줄이 실리던 폴더에 모두 실리는 한 곳만 남긴다.' : '같은 뜻 지시를 한 문장으로 합친다(모델이 쓴 문장). 합친 문장이 원문마다 같은 뜻인지 다른 모델로 다시 확인해 통과한 것만 냈다.',
      change: { before: [keeper, ...drop].map((m) => `${unitWhere(m.u)} ${q(m.u.text, 50)}`).join(' · '), after: `${unitWhere(keeper.u)} ${text ? q(text, 80) : q(keeper.u.text, 50)}` },
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
      kind: 'merge', title: `같은 뜻 forgen 룰 ${drop.length + 1}개 → ${q(keeper.u.text)} 하나로 합침 — 안 하면 같은 뜻이 세션마다 ${drop.length + 1}번 실린다`,
      why: '같은 뜻 forgen 룰을 하나로 합친다. 남기는 룰은 더 강하게 지킬 것 → 더 오래된 것 순으로 고르고, 근거 교정은 모두 남긴다. 나머지 룰은 "합쳐짐"으로 바뀐다(지우지 않음).',
      change: { before: [keeper, ...drop].map((m) => q(m.u.text, 50)).join(' · '), after: q(text ?? (keeper.rule as Rule).policy, 80) },
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
      if (isImportantRule(m.rule)) { add({ ...base, title: `forgen 룰 ${q(u.text)} 이 지금 없는 ${refs.join(', ')} 를 가리킴 — 직접 교정한 중요 지침이라 끄지 않음, 경로만 고치세요`, why: '직접 교정했거나 반드시 지킬 룰은 끄면 그 교정이 사라진다. 가리키는 경로만 직접 고치세요.', ops: [], blocked: '중요 지침이라 끄지 않음' }, ident(u)); continue; }
      add({ ...base, title: `forgen 룰 ${q(u.text)} → 끔. 가리키는 ${refs.join(', ')} 가 지금 없기 때문 — 안 하면 AI 가 없는 것을 찾거나 고치려 든다`, change: { before: `켜짐: ${q(u.text, 80)}`, after: '꺼짐(룰 파일은 남음, 되돌리기 가능)' }, why: '룰이 가리키는 파일·명령이 지금 없다. 끄고, 같은 교정을 나중에 다시 하면 "지운 기억을 다시 말함"으로 셀 수 있게 지운 기록을 남긴다.', ops: [{ op: 'rule', ruleId: u.ruleId as string, change: 'suppress', reason: `stale: ${refs.join(', ')} (forgen fix)` }], marks: [delMark(u)] }, ident(u));
      continue;
    }
    if (u.layer === 'memory-index') {
      const link = linkOf(u.text);
      const topic = link ? path.resolve(path.dirname(u.path), link) : null;
      const topicType = topic ? frontmatterField(readText(topic) ?? '', 'type') : undefined;
      if (kinds.includes('link') && topic && !fs.existsSync(topic) && link && refs.includes(link)) {
        add({ ...base, title: `MEMORY.md 의 ${q(u.text)} → 지움. 가리키는 메모 파일이 없기 때문 — 안 하면 없는 메모를 가리키는 줄이 세션마다 실린다`, change: { before: q(u.text, 80), after: '(지움)' }, why: 'MEMORY.md 줄이 없는 메모 파일을 가리킨다. 지우고 지운 기록을 남긴다.', ops: [{ op: 'delete-line', path: u.path, text: u.text }], marks: [delMark(u)] }, ident(u));
      } else add({ ...base, title: `MEMORY.md 의 ${q(u.text)} 에 적힌 ${refs.join(', ')} 가 지금 없음 — 메모 파일을 가리키는 줄이라 지우지 않음, 경로만 고치세요`, why: `이 줄은 메모 파일${topicType === 'feedback' ? '(교정 메모)' : ''}을 가리키므로 지우지 않는다. 줄 안의 경로만 직접 고치세요.`, ops: [], blocked: '메모 파일을 가리키는 줄이라 지우지 않음' }, ident(u));
      continue;
    }
    if (!isMdLayer(u.layer)) continue;
    add({ ...base, title: `${unitWhere(u)} 의 ${q(u.text)} → 지움. 가리키는 ${refs.join(', ')} 가 지금 없기 때문 — 안 하면 AI 가 없는 것을 찾거나 고치려 든다`, change: { before: q(u.text, 80), after: '(지움)' }, why: '지금 없는 파일·링크·npm 스크립트를 가리키는 줄이다. 지우고 지운 기록을 남긴다.', ops: [{ op: 'delete-line', path: u.path, text: u.text }], marks: [delMark(u)] }, ident(u));
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
        kind: 'scope', title: `forgen 룰 ${q(u.text)} → ${key} 폴더에서만 넣음. 내용이 ${key} 전용이기 때문 — 안 하면 다른 프로젝트 세션에도 실려 엉뚱하게 따르려 든다`,
        change: { before: '모든 폴더에 실림', after: `${key} 폴더에서만 실림` },
        why: `모든 프로젝트에 실리는 룰인데 내용은 ${key} 전용이다(모델 판정: ${x.reason || '이유 없음'}). 그 프로젝트에서만 실리게 바꾼다(forgen rule classify-projects --apply 와 같은 방식).`,
        evidence: ev, ops: [{ op: 'rule', ruleId: x.ruleId, change: 'scope', projects: [key] }], scopedTo: { key: `rule:${x.ruleId}`, project: key }, model: false,
        ...(important ? { manual: '직접 교정한 중요 지침이라 한꺼번에 적용하지 않음 — 보고 나서 forgen fix <id> --apply 로 하나씩' } : {}),
        tokens: Math.max(0, ...run.result.folders.filter((f) => f.projectKey !== key && (ctx.loadedIn.get(unitKey(u)) ?? []).includes(f.folder)).map(() => u.tokens)),
      }, ident(u));
      continue;
    }
    if (!isMdLayer(u.layer)) continue;
    const targets = [...new Set(run.result.folders.filter((f) => f.projectKey === key).map((f) => gitRootOf(f.folder, env.home) ?? f.folder))].sort();
    if (!targets.length) { add({ kind: 'move', title: `${unitWhere(u)} 의 ${q(u.text)} 는 ${key} 전용인데 모든 프로젝트에 실림 — ${key} 폴더를 찾지 못해 옮기지 않음`, why: '그 프로젝트 폴더를 --folder 로 넣고 다시 보면 옮길 수 있다.', evidence: ev, ops: [], blocked: `${key} 폴더를 찾지 못함` }, ident(u)); continue; }
    const ops: Op[] = [{ op: 'delete-line', path: u.path, text: u.text }];
    for (const root of targets) {
      const folders = run.result.folders.filter((f) => f.projectKey === key && (gitRootOf(f.folder, env.home) ?? f.folder) === root).map((f) => path.relative(root, f.folder)).filter((r) => r && !r.startsWith('..'));
      const fm = folders.length ? `---\npaths:\n${folders.map((r) => `  - "${r}/**"`).join('\n')}\n---\n` : '';
      ops.push({ op: 'append', path: path.join(root, '.claude', 'rules', `moved-${key.replace(/[^a-z0-9-]/g, '-')}.md`), text: u.text, create: fm });
    }
    add({
      kind: 'move', title: `${unitWhere(u)} 의 ${q(u.text)} → ${key} 저장소의 .claude/rules/ 로 옮김. ${key} 전용이기 때문 — 안 하면 다른 프로젝트 세션에도 실린다`,
      change: { before: `${unitWhere(u)} (모든 프로젝트)`, after: targets.map((t) => shortPath(path.join(t, '.claude', 'rules', `moved-${key.replace(/[^a-z0-9-]/g, '-')}.md`))).join(' · ') },
      why: `모든 프로젝트에 실리는 파일에 있지만 ${key} 전용이다(모델 판정). 그 저장소의 .claude/rules/ 로 옮기면 그 폴더 세션에서는 그대로 실린다.`,
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
      kind: 'rewrite', title: `긴 ${u.ruleId ? 'forgen 룰' : `지시(${unitWhere(u)})`} ${q(orig)} → ${orig.length}자에서 ${newText.length}자로 줄임, 뜻은 같은지 다시 확인함 — 안 하면 세션마다 약 ${Math.max(0, u.tokens - estimateTokens(newText))}토큰을 더 쓴다`,
      change: { before: shortText(orig, 160), after: shortText(newText, 160) },
      why: `${LONG_RULE}자 넘는 지시를 뜻을 바꾸지 않고 줄인다(모델이 쓴 문장). 원문과 같은 뜻인지 다른 모델로 다시 확인해 통과했다. 원문은 백업에 남아 되돌릴 수 있다.`,
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
    let firstPair: [string, string] | null = null;
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
      if (!kept) ops.push({ op: 'append', path: topic, text: `\n> MEMORY.md 원문(forgen fix ${now.toISOString().slice(0, 10)}): ${l.trim()}` });
      saved += estimateTokens(l) - estimateTokens(next);
      if (!firstPair) firstPair = [l.trim(), next.trim()];
      evidence.push(`${shortText(l, 60)} → ${shortText(next, 60)}`);
    }
    if (cut.length) {
      const archive = path.join(dir, 'memory-index-archive.md');
      const head = fs.existsSync(archive) ? undefined : `---\nname: memory-index-archive\ndescription: MEMORY.md 가 200줄·25KB 를 넘어 세션 시작에 안 실리던 색인 줄 보관\n${(m.topics.some((t) => /\nmetadata:\s*\n\s+type:/.test(t.text)) ? 'metadata:\n  type: reference' : 'type: reference')}\n---\n`;
      ops.push(...cut.map(({ l }) => ({ op: 'delete-line' as const, path: idx.path, text: l })));
      ops.push({ op: 'append', path: archive, text: cut.map(({ l }) => l).join('\n'), ...(head ? { create: head } : {}) });
      if (!lines.some((l) => l.includes('](memory-index-archive.md)'))) ops.push({ op: 'append', path: idx.path, text: '- [색인 보관](memory-index-archive.md) — 200줄·25KB 를 넘어 안 실리던 색인 줄' });
      evidence.push(`잘려서 안 실리던 줄 ${cut.length}개 → memory-index-archive.md`);
    }
    if (!ops.length) continue;
    add({
      kind: 'index', title: `${m.folder ? shortPath(m.folder) : shortPath(dir)} 의 MEMORY.md 긴 줄 ${longLines.length}개 → 링크와 한 구절만 남김(설명 원문은 그 메모 파일에 보관)${cut.length ? ` · 잘려서 안 실리던 ${cut.length}줄은 보관 파일로` : ''} — 안 하면 MEMORY.md 가 ${MEMORY_MAX_LINES}줄·${MEMORY_MAX_BYTES / 1024}KB 상한에 빨리 닿아 뒤쪽 메모가 안 실린다`,
      ...(firstPair ? { change: { before: shortText(firstPair[0], 120), after: shortText(firstPair[1], 120) } } : {}),
      why: `${LONG_INDEX}자 넘는 MEMORY.md 줄은 링크와 한 구절만 남기고, 자세한 설명은 그 메모 파일에 원문 그대로 남긴다. MEMORY.md 는 앞 ${MEMORY_MAX_LINES}줄·${MEMORY_MAX_BYTES / 1024}KB 만 세션 시작에 실린다.`,
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
    // 0.9.1 #8: 어디서나 통하는 일하는 방식(general)이면 홈 메모 폴더에, 그 프로젝트 전용이면 그 폴더 메모에 쓴다.
    // 판정은 forgen rule classify-projects 의 내용 판정기(judgeRuleScopes)를 그대로 쓰고, 같은 글은 다시 묻지 않게 저장한다.
    const homeFolder = [...folders].sort((a, b) => a.length - b.length).find((f) => (f === env.home || isHomeDir(f)) && folderOf.get(f)?.memoryDir)
      ?? folders.find((f) => f === env.home || isHomeDir(f));
    const folderFor = (its: typeof items) => { const cwd = its[0].cwd ? path.resolve(its[0].cwd) : env.home; return folders.find((f) => cwd === f || cwd.startsWith(`${f}${path.sep}`)) ?? homeFolder; };
    const scopes = await memoScopes([...grouped].flatMap(([gid, its]) => {
      const v = memos.get(gid); const f = folderFor(its);
      if (!v?.text || !f) return [];
      const key = folderOf.get(f)?.projectKey ?? path.basename(f);
      return [{ id: gid, text: v.text as string, project: key }];
    }));
    for (const [gid, its] of grouped) {
      const v = memos.get(gid);
      if (!v?.text) continue;
      const own = folderFor(its);
      const scope = scopes.get(gid);
      const folder = scope?.scope === 'general' && homeFolder ? homeFolder : own;
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
      const whereWhy = scope?.scope === 'general' && homeFolder && folder === homeFolder
        ? '어디서 일하든 통하는 일하는 방식이라 홈 메모에'
        : scope?.scope === 'project' ? `${folderOf.get(folder)?.projectKey ?? path.basename(folder)} 에서만 뜻이 있어 그 폴더 메모에` : '교정을 한 폴더의 메모에';
      add({
        kind: 'add-memory', title: `되풀이한 교정 ${q(name)} → 새 메모로 적음(${whereWhy}). 어디에도 안 적혀 ${dates.join(', ')}에 다시 말했기 때문 — 안 하면 다음에도 다시 말해야 한다`,
        change: { before: '(메모 없음)', after: `${shortPath(path.join(memDir, `${slug}.md`))} ${q(v.text, 80)}` },
        why: `어디에도 적히지 않은 채 되풀이한 교정이다. Claude 자동 메모 형식(메모 파일 + MEMORY.md 한 줄)으로 초안을 쓴다. 어느 폴더 메모에 쓸지: ${scope ? `${scope.scope === 'general' ? '어디서나 통함' : '프로젝트 전용'} — ${scope.reason || '이유 없음'}` : '판정 못 함 — 교정한 폴더'}.`,
        evidence: its.map((i) => `${i.ts.slice(0, 10)} ${shortText(i.gist, 80)}`),
        ops: [{ op: 'create', path: file, content }, { op: 'append', path: path.join(memDir, 'MEMORY.md'), text: `- [${name}](${slug}.md) — ${shortText(desc, INDEX_HOOK_MAX)}` }],
        model: true, tokens: -estimateTokens(`- [${name}](${slug}.md) — ${shortText(desc, INDEX_HOOK_MAX)}`),
        addsTo: { folder, tokens: estimateTokens(`- [${name}](${slug}.md) — ${shortText(desc, INDEX_HOOK_MAX)}\n`) },
      }, gid);
    }
  }

  // 8. 두 층 발동 조건 초안(오너 결정 2026-11-26): 자격 게이트를 못 넘은 룰 중 근거 상황이 없는 것.
  //    1층 정의(hard·strong·30일 안 직접 교정·재발)에 드는 룰은 대상이 아니다. 게이트 임계(K·발동 비율)는 건드리지 않는다 —
  //    승인된 조건이 "사람이 검증한 발동 조건"으로 게이트를 대신한다.
  const conds = await planConditions(run, judge, env, now);
  // 0.9.1 #7: 최근 세션에서 한 번도 걸리지 않을 조건(발동 추정 0%)은 제안하지 않고 수만 센다.
  const notProposedConditions = conds.filter((f) => f.estimate?.narrow).length;
  for (const f of conds.filter((x) => !x.estimate?.narrow)) add(f, `cond:${f.ops[0] && f.ops[0].op === 'rule' ? f.ops[0].ruleId : f.title}`);

  // 7. 플러그인·스킬 끄기 제안(끄기만)
  for (const { identity, ...f } of planPluginOff(env, now)) add(f, identity);

  fixes.sort((a, b) => FIX_KINDS.indexOf(a.kind) - FIX_KINDS.indexOf(b.kind) || (a.id < b.id ? -1 : 1));
  return { fixes, run, model: mc, generatedAt: now.toISOString(), ...(notProposedConditions ? { notProposedConditions } : {}) };
}

/** 기억 추가 초안의 전역/프로젝트 판정(judgeRuleScopes 재사용) — 같은 (글, 프로젝트)는 저장한 판정을 쓴다. 판정기를 못 쓰면 빈 맵. */
async function memoScopes(items: Array<{ id: string; text: string; project: string }>): Promise<Map<string, ContentVerdict>> {
  const out = new Map<string, ContentVerdict>();
  if (!items.length) return out;
  const file = path.join(FORGEN_HOME, 'audit', 'cache', 'memo-scope.json');
  let cache: Record<string, ContentVerdict> = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, ContentVerdict>; } catch { /* 없음 */ }
  const keyOf = (x: { text: string; project: string }) => sha(`memo-scope/1\0${x.project}\0${x.text}`);
  const ask = items.filter((x) => !cache[keyOf(x)]);
  if (ask.length) {
    let got: Map<string, ContentVerdict> | null = null;
    try { got = await judgeRuleScopes(ask.map((x) => ({ rule: { rule_id: x.id, policy: x.text } as Rule, projects: [x.project], sessions: 0 }))); } catch { got = null; }
    for (const x of ask) { const v = got?.get(x.id); if (v) cache[keyOf(x)] = v; }
    try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(cache), { mode: 0o600 }); } catch { /* 저장 실패는 다음에 다시 묻는다 */ }
  }
  for (const x of items) { const v = cache[keyOf(x)]; if (v) out.set(x.id, v); }
  return out;
}

/** 두 층 발동 조건 초안 — 룰마다 처방 하나. 모델(Haiku)이 없으면 결정적 후보(룰 낱말·프로젝트)만. */
async function planConditions(run: AuditRun, judge: Judge | null, env: AuditEnv, now: Date): Promise<Array<Omit<Fix, 'id' | 'marks' | 'equivalents'> & { marks?: DeletedMark[]; equivalents?: Fix['equivalents'] }>> {
  const { loadTier2Index, tierOf, words, isSafetyRule } = await import('../core/tier2.js');
  let idx = loadTier2Index();
  if (!idx) {
    // 재생을 아직 안 돌렸으면 메모리에서만 돌린다(아무것도 쓰지 않음) — 근거 상황이 있는지 알아야 대상을 고른다.
    try { idx = (await (await import('./tier2-replay.js')).runTier2Replay({ claudeDir: env.claudeDir, now })).index; } catch { return []; }
  }
  const ctx = run.ctx;
  // 안전 룰(isSafetyRule)은 tierOf 가 이미 1층('safety')으로 두지만, 후보에서도 명시적으로 뺀다.
  const cands = [...ctx.rules.values()].filter((r) => r.scope === 'me' && !r.host_copy && !r.applies_when?.approved && !isSafetyRule(r)
    && idx?.rules[r.rule_id]?.reason === 'no-context' && tierOf(r, idx, now.getTime()).reason === 'not-qualified').sort((a, b) => (a.rule_id < b.rule_id ? -1 : 1));
  if (!cands.length) return [];
  const foldersOf = (r: Rule): string[] => {
    const here = run.result.folders.filter((f) => (ctx.loadedIn.get(`${r.rule_id}:0`) ?? []).includes(f.folder)).map((f) => f.projectKey ?? shortPath(f.folder));
    return [...new Set([...(r.projects ?? []), ...here])].sort();
  };
  const detWords = (r: Rule) => [...words(`${r.trigger ?? ''} ${r.policy}`)].filter((w) => w.length >= 3 || /[가-힣]/.test(w)).slice(0, 4);
  const { conditionRate, loadConditionCorpus } = await import('./tier2-replay.js');
  let corpus: Awaited<ReturnType<typeof loadConditionCorpus>> = { sessions: [], turns: 0 };
  try { corpus = await loadConditionCorpus(env.claudeDir, { now }); } catch { /* 대화 기록 없음 = 추정 없음 */ }
  const drafts = judge?.modelEnabled
    ? await judge.conditions(cands.map((r) => ({ id: r.rule_id, policy: r.policy, trigger: r.trigger ?? '', folders: foldersOf(r), tools: CONDITION_TOOLS })))
    : new Map();
  const out: Array<Omit<Fix, 'id' | 'marks' | 'equivalents'>> = [];
  for (const r of cands) {
    const d = drafts.get(r.rule_id) ?? null;
    const known = new Set(foldersOf(r).map((f) => f.toLowerCase()));
    const cond: AppliesWhen = d
      ? {
        ...(d.folders.filter((f: string) => known.has(f)).length ? { folders: d.folders.filter((f: string) => known.has(f)) } : r.projects?.length ? { folders: [...r.projects] } : {}),
        ...(d.tools.filter((t: string) => CONDITION_TOOLS.includes(t)).length ? { tools: d.tools.filter((t: string) => CONDITION_TOOLS.includes(t)) } : {}),
        ...(d.commands.length ? { commands: d.commands } : {}),
        ...(d.paths.length ? { paths: d.paths } : {}),
        ...((d.words.length ? d.words : detWords(r)).length ? { words: d.words.length ? d.words : detWords(r) } : {}),
      }
      : { ...(r.projects?.length ? { folders: [...r.projects] } : {}), ...(detWords(r).length ? { words: detWords(r) } : {}) };
    if (!cond.tools?.length && !cond.commands?.length && !cond.paths?.length && !cond.words?.length) continue;
    // 발동률 추정(과거 세션 재생, 결정적): 넓으면(세션 50%+) 사실상 1층이라 절감이 없고, 0% 면 영영 안 실릴 위험.
    // 넓은 조건은 2차 초안으로 좁혀 본다 — 혼자서 세션 30%+ 에 걸리는 요소(명령·경로·낱말·도구만)를 뺀다. 그래도 넓으면 경고만.
    let est = corpus.sessions.length ? conditionRate(cond, corpus) : null;
    let narrowed: string[] = [];
    if (est && est.sessions >= WIDE_SESSIONS) {
      const n = narrowCondition(cond, (x) => conditionRate(x, corpus).sessions);
      if (n) { const e2 = conditionRate(n.cond, corpus); if (e2.sessions < WIDE_SESSIONS && e2.sessions > 0) { Object.assign(cond, { commands: undefined, paths: undefined, words: undefined, tools: undefined }, n.cond); est = e2; narrowed = n.dropped; } }
    }
    for (const k of ['commands', 'paths', 'words', 'tools'] as const) if (!cond[k]?.length) delete cond[k];
    const wide = !!est && est.sessions >= WIDE_SESSIONS;
    const narrow = !!est && est.sessions === 0;
    const pctS = est ? `${Math.round(est.sessions * 100)}%` : '';
    const estTag = est ? ` (최근 세션 ${pctS}에서 걸렸을 조건${wide ? ' ⚠거의 늘 걸림' : narrow ? ' ⚠한 번도 안 걸림' : ''}${narrowed.length ? ', 너무 넓은 낱말은 뺌' : ''})` : ' (대화 기록이 없어 얼마나 걸릴지 모름)';
    const unit = ctx.units.find((u) => u.ruleId === r.rule_id);
    const loadedHere = (ctx.loadedIn.get(`${r.rule_id}:0`) ?? []).length;
    out.push({
      kind: 'tier2-condition',
      title: `forgen 룰 ${q(r.policy, 34)} → 세션 시작엔 목록 한 줄로만 두고 아래 조건일 때만 넣음${estTag} — 안 하면 이 룰이 세션마다 실린다`,
      change: { before: '세션마다 실림', after: `조건이 맞을 때만 실림 (${conditionLine(cond)})` },
      ...(wide ? { manual: `최근 세션 ${pctS}에서 걸려 거의 늘 들어온다(줄어드는 것이 거의 없음) — 한꺼번에 적용하지 않음, 보고 나서 forgen fix <id> --apply 로만` } : {}),
      ...(narrow ? { manual: `최근 세션 ${est?.sessionsN}개에서 한 번도 안 걸림(필요할 때 안 들어올 위험) — 한꺼번에 적용하지 않음` } : {}),
      ...(est ? { estimate: { sessions: Math.round(est.sessions * 1000) / 1000, turns: Math.round(est.turns * 1000) / 1000, sessionsN: est.sessionsN, wide, narrow } } : {}),
      why: '이 룰은 특정 상황(위 조건)에서만 필요해 보인다. 조건을 승인하면 세션 시작에는 목록 한 줄로만 보이고, 요청·도구 사용이 조건에 맞을 때 한 번 들어온다. 필요한 순간에 안 들어와 같은 교정을 다시 하게 되면 자동으로 세션마다 실리는 룰로 돌아온다. 되돌리기(--undo)로 조건을 지우면 바로 예전처럼 세션마다 실린다.',
      evidence: [
        `룰: ${shortText(r.policy, 140)}`,
        `룰 낱말: ${detWords(r).join('·') || '없음'} · 프로젝트 ${r.projects?.join(', ') || '없음(모든 폴더)'}`,
        d ? `조건 초안(모델): ${d.reason || '이유 없음'}` : '모델 꺼짐 — 룰 낱말로만 만든 조건',
        ...(narrowed.length ? [`너무 넓게 걸려 뺀 것: ${narrowed.join(', ')}`] : []),
        est ? `얼마나 걸릴지: 최근 세션 ${est.sessionsN}개 중 ${pctS} · 내 요청 ${est.turnsN}개 중 ${Math.round(est.turns * 1000) / 10}% (실제 세션과 같은 방식으로 대화 기록에 대 봄)` : '얼마나 걸릴지: 대화 기록 없음',
      ],
      ops: [{ op: 'rule', ruleId: r.rule_id, change: 'applies-when', appliesWhen: { ...cond, ...(est ? { estimate: { sessions: Math.round(est.sessions * 1000) / 1000, turns: Math.round(est.turns * 1000) / 1000, at: now.toISOString() } } : {}) } }],
      model: !!d, tokens: loadedHere && unit ? unit.tokens : 0,
    });
  }
  return out;
}

/** 넓음: 과거 세션의 이 비율 이상에서 발동하면 사실상 1층이다. 2차 초안은 혼자서 NARROW_DROP 이상에 걸리는 요소를 뺀다. */
export const WIDE_SESSIONS = 0.5;
const NARROW_DROP = 0.3;

/** 2차 초안(결정적): 조건 요소마다 혼자서의 발동률을 재서 넓은 요소를 뺀다. 남는 것이 없으면 null. */
function narrowCondition(c: AppliesWhen, rateOf: (x: AppliesWhen) => number): { cond: AppliesWhen; dropped: string[] } | null {
  const base = c.folders?.length ? { folders: c.folders } : {};
  const dropped: string[] = [];
  const keep = (k: 'commands' | 'paths', label: string) => (c[k] ?? []).filter((v) => {
    const r = rateOf({ ...base, ...(c.tools?.length ? { tools: c.tools } : {}), [k]: [v] });
    if (r >= NARROW_DROP) { dropped.push(`${label} "${v}"(${Math.round(r * 100)}%)`); return false; }
    return true;
  });
  const commands = keep('commands', '명령');
  const paths = keep('paths', '경로');
  const words = (c.words ?? []).filter((w) => { const r = rateOf({ ...base, words: [w] }); if (r >= NARROW_DROP) { dropped.push(`낱말 "${w}"(${Math.round(r * 100)}%)`); return false; } return true; });
  // 도구만 남는 조건(명령·경로가 다 빠짐)은 도구 이름만으로 발동해 넓다 — 도구 조건도 뺀다.
  const tools = commands.length || paths.length ? c.tools : undefined;
  if (c.tools?.length && !tools) dropped.push(`도구 ${c.tools.join(', ')}(명령·경로 없이는 넓음)`);
  const out: AppliesWhen = { ...base, ...(tools?.length ? { tools } : {}), ...(commands.length ? { commands } : {}), ...(paths.length ? { paths } : {}), ...(words.length ? { words } : {}) };
  if (!dropped.length || (!out.commands?.length && !out.paths?.length && !out.words?.length)) return null;
  return { cond: out, dropped };
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
        kind: 'plugin-off', identity: `plugin:${id}`, title: `플러그인 ${id} → 끔(지우지 않음). ${legacy ? 'forgen 의 예전 이름이기 때문' : `같은 플러그인 ${keep} 이 이미 켜져 있기 때문`} — 안 하면 스킬 설명이 세션마다 ${legacy ? '' : '두 번 '}실린다`,
        change: { before: `${id} 켜짐`, after: `${id} 꺼짐` },
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
      kind: 'plugin-off', identity: `commands:${name}`, title: `예전 이름 명령 폴더 ${path.join('commands', name)} → 백업 폴더로 옮겨 끔. forgen 의 예전 이름이기 때문 — 안 하면 스킬 목록에 세션마다 약 ${tokens}토큰이 실린다`,
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
        kind: 'plugin-off', identity: `skill:${n}`, title: `스킬 ${n} → 백업 폴더로 옮겨 끔. 지난 ${UNUSED_DAYS}일 한 번도 안 불렀기 때문 — 안 하면 설명이 세션마다 약 ${tokens}토큰 실린다`,
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

export interface LedgerEvent { at: string; event: 'proposed' | 'apply' | 'undo' | 'undo-conflict' | 'skip' | 'exclude' | 'include'; id: string; kind: FixKind; backup?: string; equivalents?: Fix['equivalents']; scopedTo?: Fix['scopedTo']; addsTo?: Fix['addsTo']; note?: string }

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
/** 오너가 묶음 적용에서 뺀 처방(forgen fix <id> --skip). --unskip 으로 다시 넣는다. 마지막 기록이 이긴다. */
export function excludedFixes(events = readLedger()): Set<string> {
  const out = new Set<string>();
  for (const e of events) { if (e.event === 'exclude') out.add(e.id); if (e.event === 'include') out.delete(e.id); }
  return out;
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
  if (f.blocked) throw new Error(`적용할 수 없는 처방(알리기만): ${f.blocked}`);
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

/** sessionRules: 세션 시작 본문에 실린 forgen 룰 ID(2층 제외) — N3 같은 집합 비교(오너 결정 2026-11-26). 옛 기준값에는 없다. */
/** legacyTokens: 같은 폴더를 0.9.0 이전 형식(압축 전·두 층 없음)으로 실었을 때의 토큰 — N3 의 "전"은 이 값(없는 옛 기준값은 tokens). */
export interface FolderMeasure { folder: string; projectKey: string | null; tokens: number; skills: number; important: string[]; loaded: string[]; sessionRules?: string[]; legacyTokens?: number }
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
      // Q11(오너 결정 2026-11-26): 2층 룰은 자격 게이트를 지났고 색인 줄에 보이므로 누락이 아니다(실린 것으로 본다).
      // 2층 미발동(재생)은 따로 센다 — 그 룰은 그다음부터 1층으로 올라가 여기서는 다시 실린다.
      for (const [id, folders] of ctx.tier2In ?? []) {
        if (!folders.includes(f.folder)) continue;
        loaded.add(`rule:${id}`);
      }
      const sessionRules = [...loaded].filter((k) => k.startsWith('rule:') && !(ctx.tier2In?.get(k.slice(5)) ?? []).includes(f.folder)).map((k) => k.slice(5)).sort();
      const skills = f.skills?.tokens ?? 0;
      const forgenNow = f.byLayer['forgen-render'] ?? 0;
      const legacyTokens = f.forgenLegacyTokens ? f.totalTokens - skills - forgenNow + f.forgenLegacyTokens : undefined;
      return { folder: f.folder, projectKey: f.projectKey, tokens: f.totalTokens - skills, skills, important: [...important].sort(), loaded: [...loaded].sort(), sessionRules, ...(legacyTokens ? { legacyTokens } : {}) };
    }),
  };
}

/**
 * N3 같은 집합 비교(오너 결정 2026-11-26): "처방 전에 실리던 룰·기억 집합을 그대로 실을 때의 토큰"끼리 비교한다.
 * 처방·두 층 뒤 예산 빈자리를 채워 새로 실리게 된(처방 전에는 예산에서 빠지던) forgen 룰은 N3 에서 빼고 "되살린 룰"로 따로 센다.
 * 이전 정의(지금 실리는 전부)는 빠지던 룰이 다시 실리는 개선을 손해로 셌다. 이전 정의 값(tokens)도 같이 낸다.
 * 되살린 룰 토큰은 그 룰 한 줄의 압축 형식 토큰(+줄머리 1)으로 센다. 옛 기준값(sessionRules 없음)은 loaded 의 rule: 로 대신한다.
 */
export interface SameSet { folder: string; tokens: number; sameSet: number; revived: string[]; revivedImportant: string[]; revivedTokens: number }
export function sameSetN3(before: Measure, after: Measure, run: AuditRun): SameSet[] {
  const tok = new Map(run.ctx.units.filter((u) => u.ruleId).map((u) => [u.ruleId as string, u.tokens + 1]));
  return after.folders.map((a) => {
    const b = before.folders.find((x) => x.folder === a.folder);
    const had = new Set(b?.sessionRules ?? (b?.loaded ?? []).filter((k) => k.startsWith('rule:')).map((k) => k.slice(5)));
    const revived = b ? (a.sessionRules ?? []).filter((id) => !had.has(id)) : [];
    const revivedTokens = revived.reduce((n, id) => n + (tok.get(id) ?? 0), 0);
    const revivedImportant = revived.filter((id) => { const r = run.ctx.rules.get(id); return !!r && isImportantRule(r); });
    return { folder: a.folder, tokens: a.tokens, sameSet: a.tokens - revivedTokens, revived, revivedImportant, revivedTokens };
  });
}

/** 감사 결과에 붙일 N3(같은 집합) 요약 — 처방 기준값이 없으면 null(아무것도 쓰지 않는다). */
export function n3Summary(run: AuditRun): NonNullable<import('./run.js').AuditResult['summary']['n3']> | null {
  const t = readText(baselinePath());
  if (!t) return null;
  let before: Measure;
  try { before = JSON.parse(t) as Measure; } catch { return null; }
  const after = measure(run);
  const ss = sameSetN3(before, after, run);
  const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
  const med = (xs: number[]) => { if (!xs.length) return 0; const s2 = [...xs].sort((a, b) => a - b); const m = s2.length >> 1; return s2.length % 2 ? s2[m] : Math.round(((s2[m - 1] + s2[m]) / 2) * 10) / 10; };
  const folders = before.folders.map((b) => {
    const x = ss.find((y) => y.folder === b.folder);
    const allNow = x?.tokens ?? 0;
    const sameSet = x?.sameSet ?? 0;
    const base = b.legacyTokens ?? b.tokens;
    const formatPct = b.legacyTokens !== undefined ? pct(b.tokens, base) : 0;
    return { folder: b.folder, before: base, sameSet, allNow, pct: pct(sameSet, base), allNowPct: pct(allNow, base), formatPct, fixPct: Math.round((pct(sameSet, base) - formatPct) * 10) / 10, revived: x?.revived.length ?? 0, revivedImportant: x?.revivedImportant.length ?? 0 };
  });
  // 0.9.1 #2: 대표 숫자 = 최근 30일 세션 3개 이상 폴더만, 세션 수로 가중한 평균
  const sess = new Map(run.result.folders.map((f) => [f.folder, f.sessions30d ?? 0]));
  const rp = (v: (f: (typeof folders)[number]) => number) => representative(folders.map((f) => ({ value: v(f), sessions: sess.get(f.folder) ?? 0 })));
  const repPct = rp((f) => f.pct);
  return {
    rep: { pct: repPct?.value ?? 0, formatPct: rp((f) => f.formatPct)?.value ?? 0, fixPct: rp((f) => f.fixPct)?.value ?? 0, allNowPct: rp((f) => f.allNowPct)?.value ?? 0, weighted: repPct?.weighted ?? false, folders: repPct?.folders ?? 0 },
    baselineAt: before.at, medianPct: med(folders.map((f) => f.pct)), allNowMedianPct: med(folders.map((f) => f.allNowPct)),
    formatMedianPct: med(folders.map((f) => f.formatPct)), fixMedianPct: med(folders.map((f) => f.fixPct)),
    revived: new Set(ss.flatMap((x) => x.revived)).size, revivedImportant: new Set(ss.flatMap((x) => x.revivedImportant)).size, folders,
  };
}

/**
 * 0.9.1 #1 중요 지침 누락(절대값): 그 폴더에 해당하는 중요 지침(직접 교정·hard·strong forgen 룰) 중 세션 시작에 안 실린 것.
 * 실림 = 본문에 들어감 또는 상황 맞춤 목록 줄에 보임. 같은 교정이 Claude 기억에 실려 forgen 이 넣지 않기로 한 룰(host_copy)은 실린 것으로 본다.
 */
export interface MissingImportant { folder: string; rules: Array<{ id: string; policy: string }> }
export function importantMissing(run: AuditRun): MissingImportant[] {
  const ctx = run.ctx;
  const out: MissingImportant[] = [];
  for (const f of run.result.folders) {
    const rules: MissingImportant['rules'] = [];
    for (const r of ctx.rules.values()) {
      if (r.host_copy || !isImportantRule(r) || !appliesForContext(r, f.projectKey)) continue;
      const here = (ctx.loadedIn.get(`${r.rule_id}:0`) ?? []).includes(f.folder) || (ctx.tier2In?.get(r.rule_id) ?? []).includes(f.folder);
      if (!here) rules.push({ id: r.rule_id, policy: r.policy });
    }
    out.push({ folder: f.folder, rules });
  }
  return out;
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
