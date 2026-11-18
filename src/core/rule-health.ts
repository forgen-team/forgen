/**
 * forgen status --health — 룰 건강 지표 (docs/plans/2026-11-17-rule-quality-redesign.md D8).
 *
 * 한 집계 함수(computeRuleHealth)를 CLI 화면과 `--json` 이 같이 쓴다. 외부 도구(Handoff 등)가 이 JSON 을 읽으면
 * forgen 화면과 숫자가 항상 같다. 읽기 전용 — 아무 파일도 바꾸지 않는다.
 *
 * 정의 (숫자마다 출처를 고정한다):
 *   교정        me/behavior 의 explicit_correction. source_component 'auto-compound-miner' 는 채굴(추론)로 분리.
 *   차단        violations.jsonl 의 block/deny (signals.isRealBlock)
 *   자문        violations.jsonl 의 kind 'correction' (위반을 막지 않고 기록만 한 경우)
 *   우회        violations.jsonl 의 kind 'bypass_confirmed' (FORGEN_USER_CONFIRMED 명시)
 *   준수 근거   checks.jsonl 의 pass(Stop 에서 실제로 평가해 통과) + acknowledgments(차단 뒤 고쳐서 통과).
 *               accept_count 는 기록 경로가 없어 쓰지 않는다.
 *   승급        lifecycle 의 meta_promote_to_a
 *   룰 범위     개인 룰만(~/.forgen/me/rules + rules-archive). 현재 폴더의 프로젝트 룰은 넣지 않는다 — 실행 위치에 따라
 *               숫자가 달라지면 안 된다. 보관함(rules-archive)도 읽어야 정리(prune)된 룰 때문에 과거 날짜 값이 줄지 않는다.
 *   생성·은퇴   scope:'me' 룰만. scope:'session' 임시 룰은 교정 1건의 사본이라(승급 시 me 룰이 따로 생김) 세면 이중 계산이다.
 *   은퇴        위 룰의 status_history 중 removed·suppressed·superseded 로 바뀐 사건 수(같은 룰이 되살아났다 다시
 *               은퇴하면 두 번). 병합으로 대체된 원본(clustered-into)은 은퇴가 아니라 통합이므로 세지 않는다.
 *   다시 교정됨 lifecycle 의 t1_explicit_correction (이미 있는 룰을 지목한 교정)
 *   날짜        UTC 날짜(lifecycle 로그 파일 이름과 같은 기준)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ME_BEHAVIOR, ME_RULES, ME_RULES_ARCHIVE, STATE_DIR } from './paths.js';
import type { Rule } from '../store/types.js';
import { CURRENT_RULE_SCHEMA_VERSION } from '../store/types.js';
import { isConfirmedBypass, isRealBlock, isSyntheticEntry, readJsonlWindow } from '../engine/lifecycle/signals.js';
import { planT5Unflag } from '../engine/lifecycle/t5-hygiene.js';
import { planDedupe } from '../engine/rule-dedupe.js';

const DAY = 86_400_000;
const ENF = path.join(STATE_DIR, 'enforcement');
const LIFECYCLE = path.join(STATE_DIR, 'lifecycle');
const RETIRED_TO = new Set(['removed', 'suppressed', 'superseded']);

export interface RuleHealthDay {
  day: string;
  corrections: number;
  correctionsUser: number;
  correctionsMined: number;
  rulesCreated: number;
  rulesPromoted: number;
  rulesRetired: number;
  blocks: number;
  advisories: number;
  bypasses: number;
  /** 0.7.1: live = 원천 계산(오늘 포함), closed = 그날 닫힌 뒤 보관, backfill = 처음 기록할 때 과거 원천으로 계산해 보관 */
  source?: 'live' | 'closed' | 'backfill';
}

export interface RuleHealth {
  schema: 'forgen-rule-health/v1';
  generatedAt: string;
  windowDays: number;
  rules: {
    active: { total: number; explicit: number; mined: number; onboarding: number; other: number };
    flagged: { total: number; conflictOnly: number; other: number };
    /** 0.7.0: 주입 전 추론 룰 후보 수 */
    candidates: number;
    neverInjected: number;
    unscopedLearned: number;
    duplicateGroups: Array<{ policy: string; ruleIds: string[] }>;
  };
  flow: {
    correctionsUser: number;
    correctionsMined: number;
    rulesCreatedExplicit: number;
    rulesCreatedMined: number;
    /** 0.7.0: 기간 안 후보 → 활성 전환 수 */
    candidatesConfirmed: number;
    injections: number;
    checksPass: number;
    checksViolation: number;
    acknowledgments: number;
    blocks: number;
    advisories: number;
    bypasses: number;
    promotions: number;
    retired: number;
  };
  top: {
    blocking: Array<{ ruleId: string; policy: string | null; blocks: number }>;
    /** 0.7.2: 창 안 차단이 있는 모든 룰(많은 순). blocking 은 상위 8개 + 정책 문구. */
    blockingAll: Array<{ ruleId: string; blocks: number }>;
    recorrected: Array<{ ruleId: string; policy: string | null; count: number }>;
  };
  days: RuleHealthDay[];
}

const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

function readRuleDir(dir: string): Rule[] {
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out: Rule[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Rule;
      // rule-store 와 같은 기준 — 상위 버전 스키마 룰은 읽지 않는다(다운그레이드 시 잘못 셈 방지).
      if (r?.schema_version != null && r.schema_version > CURRENT_RULE_SCHEMA_VERSION) continue;
      if (r && typeof r.rule_id === 'string' && typeof r.policy === 'string' && typeof r.created_at === 'string') out.push(r);
    } catch { /* 깨진 파일은 건너뜀 */ }
  }
  return out;
}

/** 개인 룰(현재 + 보관함). 같은 rule_id 가 둘 다 있으면 현재 쪽. */
export function loadPersonalRules(): { current: Rule[]; all: Rule[] } {
  const current = readRuleDir(ME_RULES);
  const ids = new Set(current.map((r) => r.rule_id));
  return { current, all: [...current, ...readRuleDir(ME_RULES_ARCHIVE).filter((r) => !ids.has(r.rule_id))] };
}

function readEvidenceTimes(): { user: number[]; mined: number[] } {
  const out = { user: [] as number[], mined: [] as number[] };
  let files: string[] = [];
  try { files = fs.readdirSync(ME_BEHAVIOR).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(ME_BEHAVIOR, f), 'utf-8')) as { type?: string; source_component?: string; timestamp?: string };
      if (e.type !== 'explicit_correction') continue;
      const t = Date.parse(e.timestamp ?? '');
      if (!Number.isFinite(t)) continue;
      (e.source_component === 'auto-compound-miner' ? out.mined : out.user).push(t);
    } catch { /* 깨진 evidence 는 건너뜀 */ }
  }
  return out;
}

function readLifecycleEvents(days: number, now: number): Array<{ kind?: string; rule_id?: string; ts?: number }> {
  let files: string[] = [];
  try { files = fs.readdirSync(LIFECYCLE).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl(\.\d+)?$/.test(f)); } catch { return []; }
  const cutoff = utcDay(now - (days - 1) * DAY);
  const out: Array<{ kind?: string; rule_id?: string; ts?: number }> = [];
  for (const f of files) {
    if (f.slice(0, 10) < cutoff) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(LIFECYCLE, f), 'utf-8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line || !(line.includes('meta_promote_to_a') || line.includes('t1_explicit_correction'))) continue; // T5 대량 기록은 건너뛴다
      try {
        const e = JSON.parse(line) as { kind?: string; rule_id?: string; ts?: number };
        out.push({ ...e, ts: typeof e.ts === 'number' ? e.ts : Date.parse(`${f.slice(0, 10)}T00:00:00Z`) });
      } catch { /* skip */ }
    }
  }
  return out;
}

/** 룰이 활성이 된 시각. 후보로 태어나 아직 활성이 된 적 없으면 null. */
function activeSince(r: Rule): number | null {
  const born = r.status_history?.[0]?.from ?? r.status;
  if (born !== 'candidate') return Date.parse(r.created_at);
  const up = (r.status_history ?? []).find((h) => h.from === 'candidate' && h.to === 'active');
  return up ? Date.parse(up.at) : null;
}

/** 차단 기록 → 날짜(UTC)별 룰별 수. */
export function blocksByDay(blocks: Array<Record<string, unknown>>, since: number): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const v of blocks) {
    const t = Date.parse(String(v.at ?? ''));
    const id = String(v.rule_id ?? '');
    if (!Number.isFinite(t) || t < since || !id) continue;
    const d = utcDay(t);
    const m = out.get(d) ?? new Map<string, number>();
    m.set(id, (m.get(id) ?? 0) + 1);
    out.set(d, m);
  }
  return out;
}

/** 날짜별 룰별 수를 합쳐 많은 순 목록으로. */
export function sortedCounts(byDay: Map<string, Map<string, number>>): Array<{ ruleId: string; blocks: number }> {
  const total = new Map<string, number>();
  for (const m of byDay.values()) for (const [id, n] of m) total.set(id, (total.get(id) ?? 0) + n);
  return [...total.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([ruleId, blocks]) => ({ ruleId, blocks }));
}

/** 창 안 실제 차단 기록(원천). metrics-history 가 날짜별 룰별 차단 수를 보관할 때 쓴다. */
export function readRealBlocks(days: number, now: number): Array<Record<string, unknown>> {
  const since = now - days * DAY;
  return readJsonlWindow<Record<string, unknown>>(path.join(ENF, 'violations.jsonl'), days, now)
    .filter((v) => Date.parse(String(v.at ?? '')) >= since)
    .filter(isRealBlock);
}

export function computeRuleHealth(opts: { days?: number; now?: number; onBlocks?: (blocks: Array<Record<string, unknown>>) => void } = {}): RuleHealth {
  const days = opts.days ?? 14;
  const now = opts.now ?? Date.now();
  const since = now - days * DAY;
  const { current: rules, all: history } = loadPersonalRules();
  const active = rules.filter((r) => r.status === 'active');
  const byId = new Map(history.map((r) => [r.rule_id, r]));
  const policyOf = (id: string): string | null => byId.get(id)?.policy.replace(/\s+/g, ' ').slice(0, 100) ?? null;

  // ── 룰 상태 ──
  const flagged = active.filter((r) => r.lifecycle?.phase === 'flagged');
  const conflictOnly = new Set(planT5Unflag(rules).map((r) => r.rule_id));
  // 같은 문장: `forgen rule dedupe` 와 같은 기준(planDedupe — 활성 scope:'me', 출처별). 세션 임시 룰 쌍은
  // 12시간 유예 뒤 저절로 정리되므로 세지 않는다.
  const duplicateGroups = planDedupe(rules).map((g) => ({ policy: policyOf(g.keeper.rule_id) ?? '', ruleIds: [g.keeper.rule_id, ...g.duplicates.map((d) => d.rule_id)] }));

  // ── 신호 ──
  const ev = readEvidenceTimes();
  const violations = readJsonlWindow<Record<string, unknown>>(path.join(ENF, 'violations.jsonl'), days, now)
    .filter((v) => Date.parse(String(v.at ?? '')) >= since);
  const blocks = violations.filter(isRealBlock);
  opts.onBlocks?.(blocks); // metrics-history 가 같은 원천으로 날짜별 룰별 차단 수를 만든다(두 번 읽지 않게)
  const advisories = violations.filter((v) => v.kind === 'correction' && !isSyntheticEntry(v));
  const bypasses = violations.filter(isConfirmedBypass);
  const checks = readJsonlWindow<Record<string, unknown>>(path.join(ENF, 'checks.jsonl'), days, now)
    .filter((c) => Date.parse(String(c.at ?? '')) >= since && !isSyntheticEntry(c));
  const acks = readJsonlWindow<Record<string, unknown>>(path.join(ENF, 'acknowledgments.jsonl'), days, now)
    .filter((a) => Date.parse(String(a.at ?? a.last_block_at ?? '')) >= since);
  const lifecycle = readLifecycleEvents(days, now).filter((e) => (e.ts ?? 0) >= since);
  const promotions = lifecycle.filter((e) => e.kind === 'meta_promote_to_a');
  const t1 = lifecycle.filter((e) => e.kind === 't1_explicit_correction');

  // 세션 임시 룰은 생성·은퇴에서 뺀다 — avoid-this 교정 1건이 session 룰 + 승급 me 룰로 두 번 세지고,
  // 승급 직후 session 룰의 superseded(D3)·12시간 뒤 suppressed 가 '은퇴'로 세지던 문제(2026-11-17 Handoff 연동 때 발견).
  const durable = history.filter((r) => r.scope !== 'session');
  // 0.7.0 D5: 후보로 태어난 추론 룰은 만든 날이 아니라 활성이 된 날 '생성'으로 센다. 후보에서 바로 정리(만료)된 룰은
  // 활성이었던 적이 없으므로 은퇴로 세지 않는다.
  const created = durable
    .map((r) => ({ r, at: activeSince(r) }))
    .filter((x): x is { r: Rule; at: number } => x.at !== null && x.at >= since);
  const retirements: number[] = [];
  const confirmations: number[] = [];
  for (const r of durable) {
    for (const h of r.status_history ?? []) {
      const t = Date.parse(h.at);
      if (t < since) continue;
      if (h.from === 'candidate' && h.to === 'active') confirmations.push(t);
      if (h.from !== 'candidate' && RETIRED_TO.has(h.to) && !String(h.reason ?? '').startsWith('clustered-into')) retirements.push(t);
    }
  }

  // ── 일별 ──
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(utcDay(now - i * DAY));
  const dayIdx = new Map(dayKeys.map((d, i) => [d, i]));
  const table: RuleHealthDay[] = dayKeys.map((day) => ({ day, corrections: 0, correctionsUser: 0, correctionsMined: 0, rulesCreated: 0, rulesPromoted: 0, rulesRetired: 0, blocks: 0, advisories: 0, bypasses: 0 }));
  const bump = (t: number, key: keyof Omit<RuleHealthDay, 'day' | 'source'>) => {
    const i = dayIdx.get(utcDay(t));
    if (i !== undefined) table[i][key] += 1;
  };
  for (const t of ev.user) if (t >= since) { bump(t, 'correctionsUser'); bump(t, 'corrections'); }
  for (const t of ev.mined) if (t >= since) { bump(t, 'correctionsMined'); bump(t, 'corrections'); }
  for (const c of created) bump(c.at, 'rulesCreated');
  for (const e of promotions) bump(e.ts ?? 0, 'rulesPromoted');
  for (const t of retirements) bump(t, 'rulesRetired');
  for (const v of blocks) bump(Date.parse(String(v.at)), 'blocks');
  for (const v of advisories) bump(Date.parse(String(v.at)), 'advisories');
  for (const v of bypasses) bump(Date.parse(String(v.at)), 'bypasses');

  // ── 상위 ──
  const countBy = (items: Array<{ rule_id?: unknown }>) => {
    const m = new Map<string, number>();
    for (const it of items) { const id = String(it.rule_id ?? ''); if (id) m.set(id, (m.get(id) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  };

  return {
    schema: 'forgen-rule-health/v1',
    generatedAt: new Date(now).toISOString(),
    windowDays: days,
    rules: {
      active: {
        total: active.length,
        explicit: active.filter((r) => r.source === 'explicit_correction').length,
        mined: active.filter((r) => r.source === 'behavior_inference').length,
        onboarding: active.filter((r) => r.source === 'onboarding').length,
        other: active.filter((r) => !['explicit_correction', 'behavior_inference', 'onboarding'].includes(r.source)).length,
      },
      flagged: { total: flagged.length, conflictOnly: flagged.filter((r) => conflictOnly.has(r.rule_id)).length, other: flagged.filter((r) => !conflictOnly.has(r.rule_id)).length },
      candidates: rules.filter((r) => r.status === 'candidate').length,
      neverInjected: active.filter((r) => (r.lifecycle?.inject_count ?? 0) === 0).length,
      unscopedLearned: active.filter((r) => (r.source === 'explicit_correction' || r.source === 'behavior_inference') && !r.projects?.length).length,
      duplicateGroups,
    },
    flow: {
      correctionsUser: ev.user.filter((t) => t >= since).length,
      correctionsMined: ev.mined.filter((t) => t >= since).length,
      rulesCreatedExplicit: created.filter((c) => c.r.source === 'explicit_correction').length,
      rulesCreatedMined: created.filter((c) => c.r.source === 'behavior_inference').length,
      candidatesConfirmed: confirmations.length,
      injections: active.reduce((n, r) => n + (r.lifecycle?.inject_count ?? 0), 0),
      checksPass: checks.filter((c) => c.result === 'pass').length,
      checksViolation: checks.filter((c) => c.result === 'violation').length,
      acknowledgments: acks.length,
      blocks: blocks.length,
      advisories: advisories.length,
      bypasses: bypasses.length,
      promotions: promotions.length,
      retired: retirements.length,
    },
    top: {
      blocking: countBy(blocks).map(([ruleId, n]) => ({ ruleId, policy: policyOf(ruleId), blocks: n })),
      blockingAll: sortedCounts(blocksByDay(blocks, since)),
      recorrected: countBy(t1).map(([ruleId, n]) => ({ ruleId, policy: policyOf(ruleId), count: n })),
    },
    days: table,
  };
}

export function renderRuleHealth(h: RuleHealth): string[] {
  const f = h.flow;
  const a = h.rules.active;
  const L: string[] = [];
  L.push('', `  forgen 룰 건강 — 최근 ${h.windowDays}일`, '');
  L.push('  흐름');
  L.push(`    교정        직접 ${f.correctionsUser} · 추론 ${f.correctionsMined}`);
  L.push(`    룰 생성     직접 ${f.rulesCreatedExplicit} · 추론 ${f.rulesCreatedMined}   은퇴 ${f.retired}   승급 ${f.promotions}`);
  L.push(`    활성 룰     ${a.total}개 (직접 ${a.explicit} · 추론 ${a.mined} · 기본 ${a.onboarding}${a.other ? ` · 기타 ${a.other}` : ''})   주입 누적 ${f.injections}회`);
  L.push(`    평가        통과 ${f.checksPass} · 위반 ${f.checksViolation}   차단 ${f.blocks} · 고쳐서 통과 ${f.acknowledgments} · 자문 ${f.advisories} · 우회 ${f.bypasses}`);
  L.push('    ※ 자문 룰은 위반을 탐지할 수 없어 "위반 0"이 준수를 뜻하지 않습니다. 준수 근거는 통과·고쳐서 통과뿐입니다.');
  L.push('', '  대기열');
  const fl = h.rules.flagged;
  L.push(`    검토 대기   ${fl.total}개${fl.total ? ` (오탐 판정 ${fl.conflictOnly} → forgen rule unflag · 교정·반복 차단·우회 ${fl.other} → forgen rule review)` : ''}`);
  L.push(`    같은 문장   ${h.rules.duplicateGroups.length}묶음${h.rules.duplicateGroups.length ? ` (${h.rules.duplicateGroups.reduce((n, g) => n + g.ruleIds.length, 0)}개 룰) → forgen rule dedupe` : ''}`);
  L.push(`    추론 후보   ${h.rules.candidates}개 (주입 전 — 다른 세션에서 한 번 더 잡히면 활성, 기간 안 활성 전환 ${f.candidatesConfirmed}) → forgen rule candidates`);
  L.push(`    주입 0회    ${h.rules.neverInjected}개   범위 없는 학습 룰 ${h.rules.unscopedLearned}개${h.rules.unscopedLearned ? ' → forgen rule classify-projects --from-sessions' : ''}`);
  if (h.top.blocking.length) {
    L.push('', '  많이 막은 룰');
    for (const t of h.top.blocking.slice(0, 5)) L.push(`    ${String(t.blocks).padStart(4)}회  ${t.policy ?? t.ruleId}`);
  }
  if (h.top.recorrected.length) {
    L.push('', '  다시 교정된 룰 (이미 있는 룰을 지목한 교정)');
    for (const t of h.top.recorrected.slice(0, 5)) L.push(`    ${String(t.count).padStart(4)}회  ${t.policy ?? t.ruleId}`);
  }
  L.push('', '  일별 (UTC)   교정(직접/추론)  생성  은퇴  승급  차단  자문  우회');
  for (const d of h.days) {
    L.push(`    ${d.day}   ${String(d.correctionsUser).padStart(3)}/${String(d.correctionsMined).padEnd(4)}       ${String(d.rulesCreated).padStart(3)}   ${String(d.rulesRetired).padStart(3)}   ${String(d.rulesPromoted).padStart(3)}   ${String(d.blocks).padStart(3)}   ${String(d.advisories).padStart(3)}   ${String(d.bypasses).padStart(3)}`);
  }
  L.push('', '  JSON: forgen status --health --json', '');
  return L;
}
