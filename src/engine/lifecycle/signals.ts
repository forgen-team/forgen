/**
 * Signal collector — 각 rule 에 대해 트리거들이 필요로 하는 집계 수치를 계산.
 *
 * 입력 소스 (on-disk):
 *   - ~/.forgen/state/enforcement/drift.jsonl         (stuck-loop 이벤트)
 *   - ~/.forgen/state/enforcement/violations.jsonl    (rule 위반 기록)
 *   - ~/.forgen/state/enforcement/bypass.jsonl        (T3: 사용자 우회 기록)
 *
 * 모든 IO 는 이 파일에 한정. 트리거들은 pure — collectSignals() 결과를 받아 detect().
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Rule } from '../../store/types.js';
import type { RuleSignals, ViolationEntry, BypassEntry } from './types.js';
import { STATE_DIR as FORGEN_STATE_DIR } from '../../core/paths.js';

const ENFORCEMENT_DIR = path.join(FORGEN_STATE_DIR, 'enforcement');
const VIOLATIONS_PATH = path.join(ENFORCEMENT_DIR, 'violations.jsonl');
const BYPASS_PATH = path.join(ENFORCEMENT_DIR, 'bypass.jsonl');

const ROLLING_N = 20;
const VIOLATION_WINDOW_DAYS = 30;
const BYPASS_WINDOW_DAYS = 7;
/** H8: jsonl rotation threshold — append 시점마다 체크. */
const ROTATION_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Best-effort size-based rotation. When `p` exceeds 10MB, renames to
 * `<p>.<timestamp>` so the next write starts fresh. Missing file or rename
 * failures are swallowed — the caller's append will still succeed or fail
 * on its own merits. Exported so enforcement-path jsonl writers outside
 * this file (drift.jsonl, acknowledgments.jsonl) reuse the same policy.
 */
export function rotateIfBig(p: string): void {
  try {
    const st = fs.statSync(p);
    if (st.size > ROTATION_THRESHOLD_BYTES) {
      fs.renameSync(p, `${p}.${Date.now()}`);
    }
  } catch { /* missing → no rotate */ }
}

export function readJsonlSafe<T>(p: string): T[] {
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as T; } catch { return null; }
      })
      .filter((e): e is T => e !== null);
  } catch {
    return [];
  }
}

/**
 * ADR-017 §2 원칙 2: 훅이 session_id 없이 호출되면 'default'/'unknown' 폴백이 기록된다.
 * 실세션(Claude·Codex 모두 session_id 전달)에서는 나오지 않으며, 실측상 전부 테스트가
 * dist 훅을 spawn 한 흔적이었다(7d 차단 108건 중 78건). 모든 집계에서 제외한다.
 */
export const SYNTHETIC_SESSION_IDS: ReadonlySet<string> = new Set(['default', 'unknown', '']);

export function isSyntheticSession(sessionId: unknown): boolean {
  return typeof sessionId !== 'string' || SYNTHETIC_SESSION_IDS.has(sessionId);
}

/** 사용자 관점의 "차단": block/deny (+legacy undefined). correction/bypass_confirmed 는 아님. */
export function isBlockKind(kind: unknown): boolean {
  return kind === 'block' || kind === 'deny' || kind === undefined;
}

/** 실세션에서 일어난 실제 차단만. stats/explain/lifecycle 이 공유하는 단일 기준. */
export function isRealBlock(e: { kind?: unknown; session_id?: unknown }): boolean {
  return isBlockKind(e.kind) && !isSyntheticSession(e.session_id);
}

export function isConfirmedBypass(e: { kind?: unknown; session_id?: unknown }): boolean {
  return e.kind === 'bypass_confirmed' && !isSyntheticSession(e.session_id);
}

export function recordViolation(entry: Omit<ViolationEntry, 'at'>): void {
  try {
    fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
    rotateIfBig(VIOLATIONS_PATH);
    const full: ViolationEntry = { at: new Date().toISOString(), ...entry };
    fs.appendFileSync(VIOLATIONS_PATH, `${JSON.stringify(full)}\n`);
  } catch (e) {
    // best-effort, 실패 시 debug 로그 (silent swallow 방지)
    if (process.env.FORGEN_DEBUG_SIGNALS === '1') {
      console.error(`[forgen:signals] recordViolation failed: ${(e as Error).message}`);
    }
  }
}

export function recordBypass(entry: Omit<BypassEntry, 'at'>): void {
  try {
    fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
    rotateIfBig(BYPASS_PATH);
    const full: BypassEntry = { at: new Date().toISOString(), ...entry };
    fs.appendFileSync(BYPASS_PATH, `${JSON.stringify(full)}\n`);
  } catch (e) {
    if (process.env.FORGEN_DEBUG_SIGNALS === '1') {
      console.error(`[forgen:signals] recordBypass failed: ${(e as Error).message}`);
    }
  }
}

export interface SignalInputs {
  violations?: ViolationEntry[];
  bypass?: BypassEntry[];
  now?: number;
}

export function collectSignals(rule: Rule, inputs: SignalInputs = {}): RuleSignals {
  const now = inputs.now ?? Date.now();
  const allViolations = inputs.violations ?? readJsonlSafe<ViolationEntry>(VIOLATIONS_PATH);
  // ADR-017 D1/D2: T2 는 실제 차단만 센다 — 이전엔 kind 필터가 없어 메타가드 advise(correction)
  // 와 테스트 유래(default 세션) 기록이 위반으로 집계돼 flag 를 조기 발화시켰다.
  const violations = allViolations.filter(isRealBlock);
  // T3 입력은 bypass.jsonl(자연어 휴리스틱 — 실측 100% 오탐, ADR-017 §1.1)이 아니라
  // 사용자 명시 우회(kind:'bypass_confirmed')다. `inputs.bypass` 는 하위 호환으로 남기되 읽지 않는다.
  const bypass: BypassEntry[] = allViolations
    .filter(isConfirmedBypass)
    .map((v) => ({ at: v.at, rule_id: v.rule_id, session_id: v.session_id, tool: v.source, pattern_preview: v.message_preview ?? '' }));

  // exact match only — M fix: startsWith 으로 prefix 교차 오염되던 부분 제거.
  const matchesRule = (ruleId: string): boolean => ruleId === rule.rule_id;

  const vCutoff30 = now - VIOLATION_WINDOW_DAYS * 24 * 3600 * 1000;
  const recent30 = violations.filter((v) => {
    if (!matchesRule(v.rule_id)) return false;
    const t = Date.parse(v.at);
    return Number.isFinite(t) && t >= vCutoff30;
  });

  const bCutoff = now - BYPASS_WINDOW_DAYS * 24 * 3600 * 1000;
  const recentBypass = bypass.filter((b) => {
    if (!matchesRule(b.rule_id)) return false;
    const t = Date.parse(b.at);
    return Number.isFinite(t) && t >= bCutoff;
  });

  // Rolling N: take last N entries (violations + injections aggregate).
  // Inject 추적 인프라가 완비되기 전까지는 violations.jsonl 길이 * proxy 사용.
  // lifecycle.inject_count 필드가 채워지기 시작하면 그 값을 우선.
  const injectsRolling = rule.lifecycle?.inject_count ?? 0;
  const lastN = violations
    .filter((v) => matchesRule(v.rule_id))
    .slice(-ROLLING_N);
  const violationsRolling = lastN.length;

  const lastInjectTs = rule.lifecycle?.last_inject_at
    ? Date.parse(rule.lifecycle.last_inject_at)
    : null;
  const lastInjectDays = lastInjectTs
    ? Math.floor((now - lastInjectTs) / (24 * 3600 * 1000))
    : Math.floor((now - Date.parse(rule.updated_at)) / (24 * 3600 * 1000));

  const lastUpdatedDays = Math.floor((now - Date.parse(rule.updated_at)) / (24 * 3600 * 1000));

  const injectCount = rule.lifecycle?.inject_count ?? 0;
  const violationRate30 = injectCount > 0
    ? recent30.length / injectCount
    : (recent30.length >= 1 ? 1 : 0); // no inject tracking → treat each violation as high rate

  return {
    violations_30d: recent30.length,
    violation_rate_30d: violationRate30,
    bypass_7d: recentBypass.length,
    last_inject_days_ago: lastInjectDays,
    injects_rolling_n: injectsRolling,
    violations_rolling_n: violationsRolling,
    last_updated_days_ago: lastUpdatedDays,
  };
}

export function collectAllSignals(rules: Rule[], inputs: SignalInputs = {}): Map<string, RuleSignals> {
  const map = new Map<string, RuleSignals>();
  for (const r of rules) {
    map.set(r.rule_id, collectSignals(r, inputs));
  }
  return map;
}
