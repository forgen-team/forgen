#!/usr/bin/env node
/**
 * Forgen — Stop Guard (Mech-B prototype, spike/mech-b-a1)
 *
 * Stop hook: 어시스턴트 직전 응답에서 "완료 선언" 패턴을 감지하고, 연결된
 * Mech-A(artifact_check) / Mech-B(self_check_prompt) 규칙을 평가하여
 * 위반 시 blockStop 으로 세션을 재개시킨다.
 *
 * Prototype scope (spike only — NOT v0.4.0 final):
 *   - 규칙은 tests/spike/mech-b-inject/scenarios.json 에서 로드
 *     (FORGEN_SPIKE_RULES env 로 override 가능)
 *   - 어시스턴트 메시지는 transcript_path 에서 마지막 assistant 턴을 뽑거나
 *     FORGEN_SPIKE_LAST_MESSAGE env 로 주입 가능 (runner/단위테스트용)
 *   - artifact_check 는 `~/.forgen/state/<relative>` 경로를 기준으로 평가
 *
 * 설계 제약 (ADR-001, Day-1 verification):
 *   - self_check_prompt 질문은 **reason** 에 전체를 담는다 (모델 도달).
 *   - systemMessage 는 rule tag 한 줄만 (UI 표시 보조).
 *   - 외부 LLM API 호출 없음 (β1 유지).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readStdinJSON } from './shared/read-stdin.js';
import { approve, approveWithWarning, blockStop, failOpenWithTracking } from './shared/hook-response.js';
import { takeLastExtractionNotice } from '../core/extraction-notice.js';
import { checkConclusionVerificationRatio } from '../checks/conclusion-verification-ratio.js';
import { checkSelfScoreInflation } from '../checks/self-score-deflation.js';
import { checkFactVsAgreement } from '../checks/fact-vs-agreement.js';
import { STATE_DIR } from '../core/paths.js';
import { sanitizeId } from './shared/sanitize-id.js';
import { detectRecallReferences, type InjectedSolutionEntry } from '../core/recall-reference-detector.js';
import { appendImplicitFeedback } from '../store/implicit-feedback-store.js';
import { atomicWriteJSON } from './shared/atomic-write.js';
import { recordHookTiming } from './shared/hook-timing.js';
import { isHookEnabled } from './hook-config.js';
import { loadActiveRules } from '../store/rule-store.js';
import type { Rule, EnforceSpec } from '../store/types.js';
import { recordViolation, rotateIfBig } from '../engine/lifecycle/signals.js';
import { compileSafeRegex, safeRegexTest } from './shared/safe-regex.js';

const HOOK_NAME = 'stop-guard';

// R6-F2: shared single source of truth.
import { DEFAULT_STOP_TRIGGER_RE, DEFAULT_STOP_EXCLUDE_RE } from './shared/stop-triggers.js';

/**
 * Stuck-loop guard 임계치.
 * Day-3 smoke 에서 block reason 문구가 Claude 응답에 재매칭되어 6회 연속 block 된
 * regression 관찰됨. 이 상한을 넘으면 force approve + drift 이벤트를 남겨
 * ADR-002 Meta 트리거(규칙 자동 강등)로 연결한다.
 */
const STUCK_LOOP_THRESHOLD = 3;
const BLOCK_COUNT_DIR = path.join(STATE_DIR, 'enforcement', 'block-count');
const DRIFT_LOG = path.join(STATE_DIR, 'enforcement', 'drift.jsonl');
const ACK_LOG = path.join(STATE_DIR, 'enforcement', 'acknowledgments.jsonl');

interface VerifierSpec {
  kind: 'self_check_prompt' | 'artifact_check' | 'tool_arg_regex';
  params: Record<string, string | number | boolean>;
}

interface SpikeRule {
  id: string;
  mech: 'A' | 'B' | 'C';
  hook: 'Stop' | 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit';
  trigger: {
    response_keywords_regex?: string;
    context_exclude_regex?: string;
  };
  verifier: VerifierSpec;
  block_message?: string;
  system_tag?: string;
}

interface ScenariosFile {
  rules: SpikeRule[];
}

interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
  /**
   * Claude Code 공식 Stop hook 이 직접 제공 (A1 spike Day-3 확인).
   * 이 값이 있으면 transcript_path 파싱 생략.
   */
  last_assistant_message?: string;
}

/**
 * Spike scenarios.json 로더 — FORGEN_SPIKE_RULES 명시 시에만 로드.
 * H1 (2026-04-22): 이전에는 process.cwd()/tests/spike/... 를 기본 폴백했으나,
 * 사용자가 forgen 저장소 안에서 작업 중이면 테스트 픽스처가 프로덕션 hook 으로
 * 활성되는 부작용이 있었음. 이제 env 명시 opt-in.
 */
function loadSpikeRules(): SpikeRule[] {
  const rulesPath = process.env.FORGEN_SPIKE_RULES;
  if (!rulesPath) return [];
  try {
    const raw = fs.readFileSync(rulesPath, 'utf-8');
    const parsed = JSON.parse(raw) as ScenariosFile;
    return (parsed.rules ?? []).filter((r) => r.hook === 'Stop');
  } catch {
    return [];
  }
}

/**
 * 프로덕션 rule-store 로더.
 * ~/.forgen/me/rules 의 Rule 중 `enforce_via` 에 `hook: 'Stop'` 이 있는 것만
 * SpikeRule 내부 shape 로 변환해 반환한다.
 *
 * 변환 규칙:
 *   - `trigger_keywords_regex` 미지정 → DEFAULT_STOP_TRIGGER_RE (shared)
 *   - `trigger_exclude_regex` 미지정 → DEFAULT_STOP_EXCLUDE_RE (shared)
 *   - verifier.kind 는 `self_check_prompt` 또는 `artifact_check` 지원
 *   - 그 외 verifier 는 skip (PreToolUse 전용 tool_arg_regex 등)
 */
export function rulesFromStore(rules: Rule[]): SpikeRule[] {
  const out: SpikeRule[] = [];
  for (const rule of rules) {
    const specs = rule.enforce_via ?? [];
    for (let i = 0; i < specs.length; i++) {
      const spec: EnforceSpec = specs[i];
      if (spec.hook !== 'Stop') continue;
      if (!spec.verifier) continue;
      if (spec.verifier.kind !== 'self_check_prompt' && spec.verifier.kind !== 'artifact_check') continue;

      out.push({
        id: rule.rule_id,
        mech: spec.mech,
        hook: 'Stop',
        trigger: {
          response_keywords_regex: spec.trigger_keywords_regex ?? DEFAULT_STOP_TRIGGER_RE,
          context_exclude_regex: spec.trigger_exclude_regex ?? DEFAULT_STOP_EXCLUDE_RE,
        },
        verifier: {
          kind: spec.verifier.kind,
          params: spec.verifier.params,
        },
        block_message: spec.block_message,
        system_tag: spec.system_tag,
      });
    }
  }
  return out;
}

/** 전체 로더 — rule-store 우선, 비어 있으면 spike fallback. */
function loadStopRules(): SpikeRule[] {
  try {
    const storeRules = rulesFromStore(loadActiveRules());
    if (storeRules.length > 0) return storeRules;
  } catch {
    // fail-open: rule-store 로드 실패는 spike fallback 으로 자동 전이
  }
  return loadSpikeRules();
}

/** Stop hook input 에서 마지막 assistant 턴 텍스트를 반환. 실패 시 null. */
function readLastAssistantMessage(input?: StopHookInput | null): string | null {
  // Test/runner 주입 경로 (최우선)
  const injected = process.env.FORGEN_SPIKE_LAST_MESSAGE;
  if (injected) return injected;

  // Claude Code 공식 필드 — Stop hook 이 직접 제공 (A1 spike Day-3 확인)
  if (input && typeof input.last_assistant_message === 'string' && input.last_assistant_message) {
    return input.last_assistant_message;
  }

  const transcriptPath = input?.transcript_path;
  if (!transcriptPath) return null;
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n');
    // 최신부터 역순으로 assistant 턴 탐색 (JSONL 형식)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { role?: string; content?: unknown };
        if (entry.role !== 'assistant') continue;
        if (typeof entry.content === 'string') return entry.content;
        if (Array.isArray(entry.content)) {
          const parts = entry.content
            .map((p: unknown) => {
              if (typeof p === 'string') return p;
              if (p && typeof p === 'object' && 'text' in p) return String((p as { text: unknown }).text);
              return '';
            })
            .filter(Boolean);
          if (parts.length) return parts.join('\n');
        }
      } catch {
        // skip malformed line
      }
    }
    return null;
  } catch {
    return null;
  }
}

function messageTriggersRule(message: string, rule: SpikeRule): boolean {
  const t = rule.trigger;
  if (!t.response_keywords_regex) return false;
  const includeRes = compileSafeRegex(t.response_keywords_regex, 'i');
  if (!includeRes.regex) return false;
  if (!safeRegexTest(includeRes.regex, message)) return false;
  if (t.context_exclude_regex) {
    const excludeRes = compileSafeRegex(t.context_exclude_regex, 'i');
    if (excludeRes.regex && safeRegexTest(excludeRes.regex, message)) return false;
  }
  return true;
}

function evaluateVerifier(rule: SpikeRule): { violated: boolean; reason: string } {
  const v = rule.verifier;
  if (v.kind === 'self_check_prompt') {
    const q = String(v.params.question ?? rule.block_message ?? '자가점검 필요');
    // self_check_prompt 는 증거가 없으면(artifact path 미지정/미존재) 위반 간주.
    const evidencePath = v.params.evidence_path;
    if (typeof evidencePath === 'string') {
      const maxAge = Number(v.params.max_age_s ?? 0);
      const ok = artifactFresh(String(evidencePath), maxAge);
      if (ok) return { violated: false, reason: '' };
    }
    return { violated: true, reason: q };
  }
  if (v.kind === 'artifact_check') {
    const p = String(v.params.path ?? '');
    const maxAge = Number(v.params.max_age_s ?? 0);
    return artifactFresh(p, maxAge)
      ? { violated: false, reason: '' }
      : { violated: true, reason: rule.block_message ?? `증거 파일(${p})이 최근 ${maxAge}s 내 갱신되지 않음` };
  }
  // tool_arg_regex 는 PreToolUse 전용 → Stop 에서는 no-op
  return { violated: false, reason: '' };
}

/**
 * artifact 경로 해석 + 최근 갱신 확인.
 *
 * H9 (2026-04-22): rule JSON 의 verifier.params.path 를 임의 절대 경로로 지정해
 * /etc/shadow 존재/mtime 을 탐지하는 path-traversal reconnaissance 를 막기 위해
 * 허용 루트 (`~/.forgen/state/` 와 project `.forgen/state/`) 안으로 containment.
 * 루트 밖 경로는 존재 여부와 무관하게 false 반환.
 */
function artifactFresh(relOrAbs: string, maxAgeS: number): boolean {
  const homeBase = STATE_DIR;
  const projectBase = path.resolve(process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd(), '.forgen', 'state');
  const allowedRoots = [homeBase, projectBase];

  let p = relOrAbs;
  if (relOrAbs.startsWith('.forgen/state/')) {
    p = path.join(os.homedir(), relOrAbs);
  } else if (!path.isAbsolute(relOrAbs)) {
    p = path.join(homeBase, relOrAbs);
  }

  const resolved = path.resolve(p);
  const inside = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!inside) return false; // containment violation → 존재 확인 자체를 거부

  // R4-B4: symlink 탈출 방어 — path.resolve 만으로는 symlink 를 해소하지 않으므로
  // ~/.forgen/state/probe → /etc/shadow 심볼릭 링크로 bounded 영역 밖 파일의 존재/mtime 을
  // 탐지하는 reconnaissance 가 가능했다. realpathSync 로 실경로 해소 후 재검사.
  // allowed root 자체도 realpath 화 (macOS /tmp → /private/tmp 같은 플랫폼 symlink 대응).
  let realPath: string;
  let realRoots: string[];
  try {
    realPath = fs.realpathSync(resolved);
    realRoots = allowedRoots.map((r) => {
      try { return fs.realpathSync(r); } catch { return r; }
    });
  } catch {
    return false; // 존재 안 함 → not fresh
  }
  const realInside = realRoots.some((root) => realPath === root || realPath.startsWith(root + path.sep));
  if (!realInside) return false; // symlink 가 루트 밖을 가리킴 → reject

  try {
    const st = fs.lstatSync(realPath);
    if (maxAgeS <= 0) return true;
    const ageMs = Date.now() - st.mtimeMs;
    return ageMs <= maxAgeS * 1000;
  } catch {
    return false;
  }
}

/** Pure core — 단위 테스트용. stdin/IO 없음. */
export function evaluateStop(
  lastAssistantMessage: string,
  rules: SpikeRule[]
): { action: 'approve'; hit: null } | { action: 'block'; hit: SpikeRule; reason: string } {
  for (const rule of rules) {
    if (rule.hook !== 'Stop') continue;
    if (!messageTriggersRule(lastAssistantMessage, rule)) continue;
    const result = evaluateVerifier(rule);
    if (result.violated) {
      return { action: 'block', hit: rule, reason: result.reason };
    }
  }
  return { action: 'approve', hit: null };
}

interface BlockCounterState {
  sessionId: string;
  ruleId: string;
  count: number;
  firstBlockAt: string;
  lastBlockAt: string;
}

function blockCounterPath(sessionId: string, ruleId: string): string {
  // 파일명 안전화 — 경로 인젝션 방지
  const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const safeRule = String(ruleId).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40);
  return path.join(BLOCK_COUNT_DIR, `${safeSession}__${safeRule}.json`);
}

/**
 * 같은 (session, rule) 조합의 연속 block 카운트. approve 가 일어나면 0 으로 초기화.
 * export for tests. 부수효과: 디렉토리 생성 + 파일 쓰기.
 */
export function incrementBlockCount(sessionId: string, ruleId: string): number {
  try {
    fs.mkdirSync(BLOCK_COUNT_DIR, { recursive: true });
    const p = blockCounterPath(sessionId, ruleId);
    let state: BlockCounterState;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      state = JSON.parse(raw) as BlockCounterState;
      if (state.sessionId !== sessionId || state.ruleId !== ruleId) {
        state = { sessionId, ruleId, count: 0, firstBlockAt: new Date().toISOString(), lastBlockAt: new Date().toISOString() };
      }
    } catch {
      state = { sessionId, ruleId, count: 0, firstBlockAt: new Date().toISOString(), lastBlockAt: new Date().toISOString() };
    }
    state.count += 1;
    state.lastBlockAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(state));
    return state.count;
  } catch {
    return 1; // fail-open: 카운트 실패는 block 자체를 막지 않음
  }
}

export function resetBlockCount(sessionId: string, ruleId: string): void {
  try {
    const p = blockCounterPath(sessionId, ruleId);
    fs.unlinkSync(p);
  } catch {
    // already gone
  }
}

/**
 * R9-PA2: approve 시점에 같은 session 의 pending block 을 찾아 ack 이벤트로 기록.
 * Mech-B 의 핵심 가치(block → retract → pass)가 실제 작동했음을 관측 가능하게 한다.
 * Best-effort: 실패해도 approve 자체는 영향받지 않는다.
 *
 * 기록 후 block-count 파일은 cleanup — 같은 session 의 같은 rule 이 다시 block 되면
 * 새로운 카운트로 시작 (block-count 의미 보존).
 */
export function acknowledgeSessionBlocks(sessionId: string): number {
  if (!sessionId || sessionId === 'unknown') return 0;
  let acked = 0;
  try {
    if (!fs.existsSync(BLOCK_COUNT_DIR)) return 0;
    const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const prefix = `${safeSession}__`;
    const now = new Date().toISOString();
    for (const file of fs.readdirSync(BLOCK_COUNT_DIR)) {
      if (!file.startsWith(prefix) || !file.endsWith('.json')) continue;
      const full = path.join(BLOCK_COUNT_DIR, file);
      let state: BlockCounterState | null = null;
      try {
        state = JSON.parse(fs.readFileSync(full, 'utf-8')) as BlockCounterState;
      } catch {
        // partial-write / malformed — 다음 scan 에서 다시 시도. 삭제하지 않음.
        continue;
      }
      if (!state || state.sessionId !== sessionId) {
        // session prefix 매칭 됐는데 내부 sessionId 가 다름 → 안전하게 cleanup.
        try { fs.unlinkSync(full); } catch { /* ignore */ }
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(ACK_LOG), { recursive: true });
        rotateIfBig(ACK_LOG);
        fs.appendFileSync(ACK_LOG, JSON.stringify({
          at: now,
          session_id: state.sessionId,
          rule_id: state.ruleId,
          block_count: state.count,
          first_block_at: state.firstBlockAt,
          last_block_at: state.lastBlockAt,
        }) + '\n');
        acked += 1;
      } catch { /* append failure: still try cleanup */ }
      try { fs.unlinkSync(full); } catch { /* ignore */ }
    }
  } catch {
    // fail-open — telemetry must never block approve
  }
  return acked;
}

export function logDriftEvent(event: {
  kind: string;
  session_id: string;
  rule_id: string;
  count: number;
  reason_preview?: string;
  message_preview?: string;
}): void {
  try {
    fs.mkdirSync(path.dirname(DRIFT_LOG), { recursive: true });
    rotateIfBig(DRIFT_LOG);
    fs.appendFileSync(DRIFT_LOG, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  } catch {
    // best-effort
  }
}

export function getStuckLoopThreshold(): number {
  const env = Number(process.env.FORGEN_STUCK_LOOP_THRESHOLD);
  if (Number.isFinite(env) && env > 0) return env;
  return STUCK_LOOP_THRESHOLD;
}

/**
 * H4 완결 (2026-04-24): recall_referenced emit 경로.
 * Stop hook 에서 Claude 의 직전 응답 텍스트와 이 세션의 injection-cache 를 대조해,
 * 주입된 솔루션 이름이 응답에 등장하면 `recall_referenced` 이벤트 기록. 동일
 * 솔루션 중복 emit 방지용으로 injection-cache 의 해당 엔트리에 `_referenced: true`
 * 플래그 세팅 후 atomic 재기록. fail-open — 어떤 단계든 throw 시 스킵.
 */
function emitRecallReferencesFailOpen(sessionId: string, lastMessage: string): void {
  try {
    const cachePath = path.join(STATE_DIR, `injection-cache-${sanitizeId(sessionId)}.json`);
    if (!fs.existsSync(cachePath)) return;
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const cache = JSON.parse(raw) as { solutions?: InjectedSolutionEntry[]; updatedAt?: string };
    const sols = Array.isArray(cache.solutions) ? cache.solutions : [];
    if (sols.length === 0) return;

    const { newlyReferenced } = detectRecallReferences(lastMessage, sols);
    if (newlyReferenced.length === 0) return;

    const now = new Date().toISOString();
    for (const name of newlyReferenced) {
      appendImplicitFeedback({
        type: 'recall_referenced',
        category: 'positive',
        solution: name,
        at: now,
        sessionId,
      });
    }

    // 중복 emit 방지 — cache 에 플래그 저장 후 재기록
    const refSet = new Set(newlyReferenced);
    const updated = {
      ...cache,
      solutions: sols.map((s) => (refSet.has(s.name) ? { ...s, _referenced: true } : s)),
      updatedAt: now,
    };
    atomicWriteJSON(cachePath, updated, { mode: 0o600, dirMode: 0o700 });
  } catch {
    /* fail-open */
  }
}

/**
 * TEST-2 support: post-tool-use 가 저장한 modified-files-{sessionId}.json 에서
 * recentToolNames 윈도우를 로드. 파일이 없거나 깨져도 빈 배열로 fail-open.
 */
function loadRecentToolNames(sessionId: string): string[] {
  try {
    const p = path.join(STATE_DIR, `modified-files-${sanitizeId(sessionId)}.json`);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf-8');
    const data = JSON.parse(raw) as { recentToolNames?: unknown };
    if (Array.isArray(data.recentToolNames)) {
      return data.recentToolNames.filter((n): n is string => typeof n === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * H2: Stop hook approve 시 이전 세션의 auto-compound 추출 결과를 1회만 surface.
 * takeLastExtractionNotice 가 null 이면 일반 approve, 아니면 systemMessage 포함.
 */
function approveWithOptionalExtractionNotice(): string {
  const notice = takeLastExtractionNotice();
  if (notice) return approveWithWarning(notice);
  return approve();
}

export async function main(): Promise<void> {
  const started = Date.now();
  try {
    if (!isHookEnabled(HOOK_NAME)) {
      console.log(approveWithOptionalExtractionNotice());
      return;
    }

    const input = await readStdinJSON<StopHookInput>();
    const lastMessage = readLastAssistantMessage(input);
    if (!lastMessage) {
      console.log(approveWithOptionalExtractionNotice());
      return;
    }

    // H4 완결: 응답 텍스트와 injection-cache 대조해 recall_referenced emit.
    // block/approve 어느 경로이든 동일하게 기록 (참조는 응답 내용이 결정).
    const sessionIdForRef = input?.session_id ?? 'unknown';
    emitRecallReferencesFailOpen(sessionIdForRef, lastMessage);

    // TEST-2/3: rule-free meta guards — FORGEN_USER_CONFIRMED=1 우회 공통.
    if (process.env.FORGEN_USER_CONFIRMED !== '1') {
      const sessionId = input?.session_id ?? 'unknown';

      // TEST-2 (자가 점수 인플레이션): 숫자 점수 상승 선언 + 측정 도구 0회 → block.
      // TEST-3 보다 강한 신호라 먼저 평가.
      const recentTools = loadRecentToolNames(sessionId);
      const score = checkSelfScoreInflation({ text: lastMessage, recentTools });
      if (score.block) {
        recordViolation({
          rule_id: 'builtin:self-score-inflation',
          session_id: sessionId,
          source: 'stop-guard',
          kind: 'block',
          message_preview: lastMessage.slice(0, 120),
        });
        const reasonText = `[forgen:stop-guard/self-score-inflation] ${score.reason}

(Override this turn: set FORGEN_USER_CONFIRMED=1 (audited).)`;
        console.log(blockStop(reasonText, 'rule:TEST-2 — self-score inflation'));
        return;
      }

      // TEST-3: 결론/검증 비율 — Claude 가 실제 측정 도구는 돌렸지만 서술이
      // 결론-편향이면 여전히 block.
      const ratio = checkConclusionVerificationRatio({ text: lastMessage });
      if (ratio.block) {
        recordViolation({
          rule_id: 'builtin:conclusion-verification-ratio',
          session_id: sessionId,
          source: 'stop-guard',
          kind: 'block',
          message_preview: lastMessage.slice(0, 120),
        });
        const reasonText = `[forgen:stop-guard/conclusion-ratio] ${ratio.reason}

(Override this turn: set FORGEN_USER_CONFIRMED=1 (audited).)`;
        console.log(blockStop(reasonText, 'rule:TEST-3 — conclusion/verification ratio'));
        return;
      }

      // TEST-1: 사실 vs 합의 — fact assertion 키워드가 있으나 측정 도구 호출 0건.
      // 원 design intent (per fact-vs-agreement.ts): alert level only — block 은 TEST-2/3.
      // 여기서는 measurement 신호를 violations.jsonl 에 'alert' kind 로 기록만 (block 안 함).
      // wiring gap 발견 (forgen-eval introspect) → 측정 가능하게 wired up.
      const fva = checkFactVsAgreement({ text: lastMessage, recentTools, minMeasurements: 1 });
      if (fva.alert) {
        recordViolation({
          rule_id: 'builtin:fact-vs-agreement',
          session_id: sessionId,
          source: 'stop-guard',
          kind: 'correction', // alert-level signal (not block) per fact-vs-agreement.ts design
          message_preview: lastMessage.slice(0, 120),
        });
      }
    }

    const rules = loadStopRules();
    if (rules.length === 0) {
      console.log(approveWithOptionalExtractionNotice());
      return;
    }

    const result = evaluateStop(lastMessage, rules);
    const sessionId = input?.session_id ?? 'unknown';

    if (result.action === 'approve') {
      // R9-PA2: 같은 session 에 pending block 이 있었다면 retract→pass 루프가
      // 실제 작동한 것 — acknowledgment 이벤트로 기록. block-count 는 cleanup.
      acknowledgeSessionBlocks(sessionId);
      console.log(approveWithOptionalExtractionNotice());
      return;
    }

    const { hit, reason } = result;

    // R7-U1: FORGEN_USER_CONFIRMED=1 으로 사용자가 명시적 우회 → audit 기록 후 approve.
    // pre-tool-use 와 동일한 탈출 경로 일관성 확보.
    if (process.env.FORGEN_USER_CONFIRMED === '1') {
      recordViolation({
        rule_id: hit.id, session_id: sessionId, source: 'stop-guard',
        kind: 'correction',
        message_preview: `[FORGEN_USER_CONFIRMED=1 bypass] ${lastMessage.slice(0, 100)}`,
      });
      console.log(approveWithOptionalExtractionNotice());
      return;
    }

    // T2 signal: block 은 rule 위반 증거 — violations.jsonl 에 기록.
    // (stuck-loop force approve 는 아래에서 처리되므로 실제 block 시에만 기록)
    recordViolation({
      rule_id: hit.id,
      session_id: sessionId,
      source: 'stop-guard',
      kind: 'block',
      message_preview: lastMessage.slice(0, 120),
    });

    // G8 + R4-UX1 + R7-U1/U2: 브랜드 prefix + 사람-읽기 동사 기반 override 힌트.
    // pre-tool-use 와 일관된 FORGEN_USER_CONFIRMED=1 탈출구 + 영구 비활성화 CLI 노출.
    const reasonWithHint = `[forgen:stop-guard/${hit.id.slice(0, 8)}] ${reason}

(Override this turn: set FORGEN_USER_CONFIRMED=1 (audited). Disable rule permanently: \`forgen suppress-rule ${hit.id}\`. See recent blocks: \`forgen last-block\`.)`;

    const count = incrementBlockCount(sessionId, hit.id);
    const threshold = getStuckLoopThreshold();
    if (count > threshold) {
      // Stuck-loop: force approve 하고 drift 기록. Claude 가 block reason 문구에
      // 말려들어가는 경우를 끊는다. ADR-002 Meta 트리거 (rule 자동 강등) 에 연결.
      logDriftEvent({
        kind: 'stuck_loop_force_approve',
        session_id: sessionId,
        rule_id: hit.id,
        count,
        reason_preview: reason.slice(0, 120),
        message_preview: lastMessage.slice(0, 120),
      });
      resetBlockCount(sessionId, hit.id);
      console.log(approveWithOptionalExtractionNotice());
      return;
    }
    console.log(blockStop(reasonWithHint, hit.system_tag));
  } catch (e) {
    console.log(failOpenWithTracking(HOOK_NAME, e));
  } finally {
    recordHookTiming(HOOK_NAME, Date.now() - started, 'Stop');
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void main();
}
