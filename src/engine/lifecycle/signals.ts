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
import * as crypto from 'node:crypto';
import { redactSecrets } from '../../hooks/secret-filter.js'; // ESM main guard 있음 — import 부작용 없음
import type { RuleSignals, ViolationEntry, BypassEntry, VerdictEntry, CheckEntry } from './types.js';
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

const RECEIPTS_DIR = path.join(ENFORCEMENT_DIR, 'receipts');
const VERDICTS_PATH = path.join(ENFORCEMENT_DIR, 'verdicts.jsonl');
const CHECKS_PATH = path.join(ENFORCEMENT_DIR, 'checks.jsonl');
export const RECEIPT_TTL_MS = 24 * 3600 * 1000;
export const MATCHED_MAX = 160;

export interface RecordViolationOptions {
  /** 영수증 전문(명령/응답/파일 본문). secret-filter 로 마스킹 후 receipts/<id>.txt 에 24h 보관. */
  receipt_text?: string;
}

function sha16(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** receipts/ 의 TTL 지난 파일 정리 — 기록 시마다 best-effort(최대 200개 확인). */
function pruneReceipts(now: number): void {
  try {
    if (!fs.existsSync(RECEIPTS_DIR)) return;
    const names = fs.readdirSync(RECEIPTS_DIR).slice(0, 200);
    for (const n of names) {
      const p = path.join(RECEIPTS_DIR, n);
      try { if (now - fs.statSync(p).mtimeMs > RECEIPT_TTL_MS) fs.unlinkSync(p); } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

/**
 * 위반/차단 기록. ADR-017 D1: violation_id 를 발급해 반환하고, receipt_text 가 있으면 secret
 * 마스킹 후 전문을 24h TTL 영수증으로 남긴다(로그엔 hash 만). 실패해도 예외 없이 '' 반환.
 */
export function recordViolation(entry: Omit<ViolationEntry, 'at'>, opts: RecordViolationOptions = {}): string {
  try {
    fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
    rotateIfBig(VIOLATIONS_PATH);
    const violation_id = entry.violation_id ?? crypto.randomUUID();
    const full: ViolationEntry = { at: new Date().toISOString(), violation_id, ...entry };
    // 로그에 남는 프래그먼트/미리보기도 secret 마스킹 — 영수증만 가리고 로그에 키가 남으면 의미 없다.
    if (typeof full.matched === 'string') full.matched = redactSecrets(full.matched).redacted;
    if (typeof full.message_preview === 'string') full.message_preview = redactSecrets(full.message_preview).redacted;
    if (typeof full.matched === 'string' && full.matched.length > MATCHED_MAX) full.matched = `${full.matched.slice(0, MATCHED_MAX - 1)}…`;
    if (opts.receipt_text) {
      full.target_hash = sha16(opts.receipt_text);
      try {
        fs.mkdirSync(RECEIPTS_DIR, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(RECEIPTS_DIR, `${violation_id}.txt`), redactSecrets(opts.receipt_text).redacted, { mode: 0o600 });
        pruneReceipts(Date.now());
      } catch { /* 영수증 실패는 기록 자체를 막지 않는다 */ }
    }
    fs.appendFileSync(VIOLATIONS_PATH, `${JSON.stringify(full)}\n`);
    return violation_id;
  } catch (e) {
    // best-effort, 실패 시 debug 로그 (silent swallow 방지)
    if (process.env.FORGEN_DEBUG_SIGNALS === '1') {
      console.error(`[forgen:signals] recordViolation failed: ${(e as Error).message}`);
    }
    return '';
  }
}

export function readReceipt(violationId: string): string | null {
  if (!/^[A-Za-z0-9-]+$/.test(violationId)) return null;
  try { return fs.readFileSync(path.join(RECEIPTS_DIR, `${violationId}.txt`), 'utf-8'); } catch { return null; }
}

/** 판정 기록(append-only). 같은 violation_id 에 여러 줄이면 마지막이 유효하되 user > auto. */
export function setVerdict(entry: Omit<VerdictEntry, 'at'>): void {
  try {
    fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
    rotateIfBig(VERDICTS_PATH);
    fs.appendFileSync(VERDICTS_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* best-effort */ }
}

export function readVerdicts(): VerdictEntry[] {
  return readJsonlSafe<VerdictEntry>(VERDICTS_PATH);
}

/** violation_id → 유효 판정 (user 가 있으면 user, 없으면 마지막 auto). */
export function effectiveVerdicts(verdicts: VerdictEntry[] = readVerdicts()): Map<string, VerdictEntry> {
  const m = new Map<string, VerdictEntry>();
  for (const v of verdicts) {
    const cur = m.get(v.violation_id);
    if (cur?.by !== 'user' || v.by === 'user') m.set(v.violation_id, v);
  }
  return m;
}

export interface RulePrecision {
  rule_id: string;
  correct: number;
  false_positive: number;
  unjudged: number;
  /** correct/(correct+false_positive); 판정 0건이면 null. */
  precision: number | null;
}

/** 룰별 precision (실 차단만, 최근 N일). unsure 는 미판정으로 센다. */
export function precisionByRule(violations: ViolationEntry[], verdicts: VerdictEntry[], days: number, now: number = Date.now()): Map<string, RulePrecision> {
  const cutoff = now - days * 24 * 3600 * 1000;
  const eff = effectiveVerdicts(verdicts);
  const out = new Map<string, RulePrecision>();
  for (const v of violations) {
    if (!isRealBlock(v)) continue;
    const t = Date.parse(v.at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const r = out.get(v.rule_id) ?? { rule_id: v.rule_id, correct: 0, false_positive: 0, unjudged: 0, precision: null };
    const verdict = v.violation_id ? eff.get(v.violation_id)?.verdict : undefined;
    if (verdict === 'correct') r.correct++;
    else if (verdict === 'false_positive') r.false_positive++;
    else r.unjudged++;
    out.set(v.rule_id, r);
  }
  for (const r of out.values()) {
    const judged = r.correct + r.false_positive;
    r.precision = judged > 0 ? r.correct / judged : null;
  }
  return out;
}

/** D2: Stop 평가 결과 기록(통과 포함). violations.jsonl 과 분리. 7일 TTL 은 state-gc 가 담당. */
export const CHECKS_TTL_MS = 7 * 24 * 3600 * 1000;

export function recordCheck(entry: Omit<CheckEntry, 'at'>): void {
  try {
    fs.mkdirSync(ENFORCEMENT_DIR, { recursive: true });
    rotateIfBig(CHECKS_PATH);
    fs.appendFileSync(CHECKS_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    // 7일 TTL — 통과 기록은 턴마다 쌓이므로 1/50 확률로 압축(rotateIfBig 10MB 에 닿지 않게).
    if (Math.random() < 0.02) pruneChecks();
  } catch { /* best-effort */ }
}

export function pruneChecks(now: number = Date.now()): void {
  try {
    const keep = readJsonlSafe<CheckEntry>(CHECKS_PATH).filter((c) => now - Date.parse(c.at) < CHECKS_TTL_MS);
    fs.writeFileSync(CHECKS_PATH, keep.map((c) => JSON.stringify(c)).join('\n') + (keep.length ? '\n' : ''));
  } catch { /* best-effort */ }
}

export function readChecks(): CheckEntry[] {
  return readJsonlSafe<CheckEntry>(CHECKS_PATH);
}

/** 정규식 매칭 프래그먼트 추출 — 영수증 `matched` 필드용. */
export function matchedFragment(re: RegExp, text: string): string {
  try {
    const m = re.exec(text);
    if (!m) return '';
    const start = Math.max(0, m.index - 30);
    return text.slice(start, m.index + m[0].length + 30).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** @deprecated ADR-017: 유지만 — 호출지 없음. */
function _legacyRecordViolationShape(entry: Omit<ViolationEntry, 'at'>): ViolationEntry {
  return { at: new Date().toISOString(), ...entry };
}
void _legacyRecordViolationShape;

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
