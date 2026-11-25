/**
 * Forgen v1 — Session Bootstrap
 *
 * v1 설계의 세션 시작 흐름을 구현.
 * Authoritative: docs/plans/2026-04-03-forgen-lifecycle-design.md §6
 *               docs/plans/2026-04-03-forgen-component-interface-design.md §4
 *
 * 흐름:
 * 1. Legacy 감지 → cutover 필요 시 backup + fresh onboarding
 * 2. Profile 로드 (없으면 onboarding 필요)
 * 3. Runtime capability 감지
 * 4. Preset Manager가 SessionEffectiveState 합성
 * 5. Rule Renderer가 자연어 규칙 세트 생성
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { promoteSessionCandidates } from '../store/evidence-store.js';
import * as crypto from 'node:crypto';
import { FORGEN_HOME, ME_DIR, ME_RULES, ME_BEHAVIOR, V1_RECOMMENDATIONS_DIR, V1_SESSIONS_DIR, STATE_DIR, V1_RAW_LOGS_DIR, ME_SOLUTIONS, SESSIONS_DIR } from './paths.js';
import { checkLegacyProfile, runLegacyCutover } from './legacy-detector.js';
import { detectRuntimeCapability } from './runtime-detector.js';
import { backupCorruptProfile, loadProfile, profileExists, recomputeIfNeverReclassified } from '../store/profile-store.js';
import { loadContextRules, cleanupStaleSessionRules, markRulesInjected } from '../store/rule-store.js';
import { projectKeyFor } from '../store/rule-scope.js';
import { projectRuleIndex } from './project-switch.js';
import { composeSession } from '../preset/preset-manager.js';
import { renderRulesDetailed, DEFAULT_CONTEXT  } from '../renderer/rule-renderer.js';
import { recordRenderReport } from '../renderer/render-report.js';
import { saveSessionState, loadRecentSessions } from '../store/session-state-store.js';
import { loadEvidenceBySession } from '../store/evidence-store.js';
import { computeSessionSignals, detectMismatch, type MismatchSignal, type MismatchResult } from '../forge/mismatch-detector.js';
import { createRecommendation, saveRecommendation } from '../store/recommendation-store.js';
import type { SessionEffectiveState, Profile } from '../store/types.js';

// ── Directory Initialization ──

// v0.4.8 (A3): SESSIONS_DIR (~/.forgen/sessions/) 도 v1 bootstrap 보장 대상.
// 이전엔 V1_DIRS 에 누락되어 있어, prepareHarness step 11 (startSessionLog)
// 에 도달 못 하는 코드 경로 (예: forgen install 직접 실행) 에선 디렉토리가
// 끝까지 생성되지 않았음. legacy session log 와 v1 effective state 는
// 서로 다른 저장소 책임이라 두 dir 모두 명시 보장.
//   - SESSIONS_DIR     = ~/.forgen/sessions/        ← legacy session log (transcript-like)
//   - V1_SESSIONS_DIR  = ~/.forgen/state/sessions/  ← v1 effective state per session
const V1_DIRS = [FORGEN_HOME, ME_DIR, ME_RULES, ME_BEHAVIOR, V1_RECOMMENDATIONS_DIR, STATE_DIR, V1_SESSIONS_DIR, V1_RAW_LOGS_DIR, ME_SOLUTIONS, SESSIONS_DIR];

export function ensureV1Directories(): void {
  for (const dir of V1_DIRS) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Bootstrap Result ──

export interface V1BootstrapResult {
  needsOnboarding: boolean;
  legacyBackupPath: string | null;
  /**
   * profile.json 이 존재했지만 parse/shape 오류로 사용 불가하여 v0.4.8
   * 의 auto-repair 가 timestamp 백업으로 치워둔 경로. legacyBackupPath
   * 와 의미가 다름 (legacy = model_version 구 버전 cutover, corrupt =
   * 깨진 파일 격리).
   */
  corruptProfileBackupPath: string | null;
  session: SessionEffectiveState | null;
  renderedRules: string | null;
  /** 0.8.0 M2: 이번 렌더에 실제로 들어간 룰 ID. 전역 render-report 는 동시 세션이 덮어쓰므로 이 값을 쓴다. */
  includedRuleIds?: string[];
  profile: Profile | null;
  mismatch: MismatchResult | null;
}

// ── Main Bootstrap ──

/**
 * 프로필이 없어도(온보딩 전, 손상) 쌓아 둔 룰은 주입한다. 프로필은 4축 표시용이고 룰 본문과 무관하다.
 * 프로필이 없다고 교정이 전부 무시되면 환경에 따라 규칙이 사라지는 셈이다.
 */
/** 0.8.0 S5: 프로젝트 밖에서 시작한 세션이면 프로젝트별 룰 수 색인을 덧붙인다(본문은 그 프로젝트로 들어갈 때). */
function withProjectIndex(text: string, cwd?: string): string {
  try {
    if (projectKeyFor(cwd ?? process.env.FORGEN_CWD ?? process.cwd()) !== null) return text;
    const index = projectRuleIndex();
    return index ? `${text}\n\n${index}` : text;
  } catch { return text; }
}

let lastIncluded: string[] = [];
function renderWithoutProfile(cwd?: string): string | null {
  lastIncluded = [];
  try {
    const rules = loadContextRules(cwd);
    if (rules.length === 0) {
      // 전역 룰이 없어도 프로젝트 룰이 있으면 색인은 보여 준다(그 프로젝트로 들어가면 들어온다는 안내).
      const idx = projectKeyFor(cwd ?? process.env.FORGEN_CWD ?? process.cwd()) === null ? projectRuleIndex() : null;
      // 렌더 보고도 "들어간 룰 없음"으로 남긴다 — 이전 세션의 보고가 남아 옛 룰 파일 정리·누락 표시가 어긋나지 않게.
      try { recordRenderReport({ text: idx ?? '', included: [], omitted: [] } as unknown as Parameters<typeof recordRenderReport>[0]); } catch { /* fail-open */ }
      return idx;
    }
    const state = { warnings: [] } as unknown as SessionEffectiveState;
    const result = renderRulesDetailed(rules, state, null as unknown as Profile, DEFAULT_CONTEXT);
    lastIncluded = result.included.map((r) => r.rule_id);
    recordRenderReport(result);
    return withProjectIndex(result.text, cwd);
  } catch {
    return null;
  }
}

/**
 * 세션 시작 룰 블록을 **아무것도 쓰지 않고** 다시 만든다(감사 `forgen audit` 용).
 * bootstrapV1Session 은 trackInjection:false 여도 디렉터리 생성·후보 승급·세션 상태·렌더 보고·raw log 를 쓴다.
 * 여기서는 그 렌더 경로(룰 고르기 → 합성 → renderRulesDetailed → 프로젝트 색인)만 따른다.
 * 차이: 세션 임시 룰 정리(cleanupStaleSessionRules)를 하지 않으므로 지난 세션의 임시 룰이 남아 있으면 같이 센다.
 * 차이 2: 세션 후보 승급(promoteSessionCandidates)을 하지 않으므로, 승급 대기 후보가 있으면 실제 다음 세션보다
 *   룰이 적게 셀 수 있다(감사는 "지금 저장된 그대로"를 본다).
 */
export function renderSessionStartReadOnly(cwd: string, opts: { asOf?: string } = {}): { text: string; includedRuleIds: string[] } {
  // 프로젝트 로컬 룰(<cwd>/.forgen/rules)은 FORGEN_CWD 기준으로 읽힌다 — 이 폴더로 잠시 맞춘다.
  const prev = process.env.FORGEN_CWD;
  process.env.FORGEN_CWD = cwd;
  try { return renderReadOnly(cwd, opts.asOf); } finally { if (prev === undefined) delete process.env.FORGEN_CWD; else process.env.FORGEN_CWD = prev; }
}

/**
 * asOf(ISO): 그 시각까지 만들어진 룰만으로 렌더한다 — 세션별 렌더 기록이 없는 과거 세션의 "재생 렌더" 추정(감사 recurrence).
 * 다른 세션의 임시 룰(scope 'session')은 뺀다. 한계: 지금 활성인 룰만 보므로 그 뒤 보관·삭제된 룰과 그 사이 바뀐 강도·범위는 되살리지 못한다.
 */
function renderReadOnly(cwd: string, asOf?: string): { text: string; includedRuleIds: string[] } {
  const rules = asOf ? loadContextRules(cwd).filter((r) => r.scope !== 'session' && (!r.created_at || r.created_at <= asOf)) : loadContextRules(cwd);
  const profile = profileExists() ? loadProfile() : null;
  if (!profile) {
    if (rules.length === 0) {
      const idx = projectKeyFor(cwd) === null ? projectRuleIndex() : null;
      return { text: idx ?? '', includedRuleIds: [] };
    }
    const state = { warnings: [] } as unknown as SessionEffectiveState;
    const result = renderRulesDetailed(rules, state, null as unknown as Profile, DEFAULT_CONTEXT);
    return { text: withProjectIndex(result.text, cwd), includedRuleIds: result.included.map((r) => r.rule_id) };
  }
  const session = composeSession({ session_id: 'audit-read-only', profile, personalRules: rules, sessionOverlays: [], runtime: detectRuntimeCapability() });
  const rendered = renderRulesDetailed([...rules], session, profile, DEFAULT_CONTEXT);
  return { text: withProjectIndex(rendered.text, cwd), includedRuleIds: rendered.included.map((r) => r.rule_id) };
}

export function bootstrapV1Session(cwd?: string, opts: { trackInjection?: boolean } = {}): V1BootstrapResult {
  // 0. 디렉토리 준비
  ensureV1Directories();

  // 1. Legacy 감지
  const legacyCheck = checkLegacyProfile();
  let legacyBackupPath: string | null = null;
  if (legacyCheck.isLegacy) {
    legacyBackupPath = runLegacyCutover();
  }

  // 세션 종료 추출이 못 돈 환경에서도 교정을 잃지 않게 먼저 승급한다. 프로필이 없어도 룰은 주입되므로 프로필 확인보다 앞선다.
  try {
    promoteSessionCandidates(crypto.randomUUID());
  } catch {
    // 승급 실패는 세션 시작을 막지 않음. 표시가 남아 있어 다음 기회에 다시 시도한다.
  }

  // 2. Profile 로드
  if (!profileExists()) {
    return {
      needsOnboarding: true,
      legacyBackupPath,
      corruptProfileBackupPath: null,
      session: null,
      renderedRules: renderWithoutProfile(cwd),
      includedRuleIds: lastIncluded,
      profile: null,
      mismatch: null,
    };
  }

  // ADR-017 §6-8: score 산출 로직이 없던 버전의 프로필(last_reclassification_at=null)은
  // 세션 시작 시 1회 재계산. 이미 계산된 프로필은 no-op. fail-open.
  try { recomputeIfNeverReclassified(); } catch { /* fail-open */ }

  const profile = loadProfile();
  if (!profile) {
    // v0.4.8 — corrupt/invalid profile auto-repair.
    // profileExists()=true && loadProfile()=null 은 parse 실패 또는 v1
    // shape 위반. 그대로 두면 다음 실행에서도 같은 분기로 빠지므로
    // backup 후 새 onboarding 흐름을 강제.
    const corruptProfileBackupPath = backupCorruptProfile();
    return {
      needsOnboarding: true,
      legacyBackupPath,
      corruptProfileBackupPath,
      session: null,
      renderedRules: renderWithoutProfile(cwd),
      includedRuleIds: lastIncluded,
      profile: null,
      mismatch: null,
    };
  }

  // 3. Runtime capability 감지
  const runtime = detectRuntimeCapability();

  // 4. Rules 로드 + Session 합성
  const sessionId = crypto.randomUUID();

  // 이전 세션의 scope:'session' 임시 규칙 정리.
  try {
    cleanupStaleSessionRules(sessionId);
  } catch {
    // 정리 실패는 세션 시작을 막지 않음
  }

  const personalRules = loadContextRules(cwd);

  const session = composeSession({
    session_id: sessionId,
    profile,
    personalRules,
    sessionOverlays: [],
    runtime,
  });

  // 5. Session state 저장
  saveSessionState(session);

  // 6. Rule 렌더링
  const allRules = [...personalRules];
  const rendered = renderRulesDetailed(allRules, session, profile, DEFAULT_CONTEXT);
  const renderedRules = withProjectIndex(rendered.text, cwd);

  // 6b. Inject tracking (ADR-002 Meta signal) — rendered rules count as injected.
  // Fail-open: tracking failure must not block bootstrap.
  try {
    const injected = rendered.included.map((r) => r.rule_id);
    if (injected.length > 0 && opts.trackInjection !== false) markRulesInjected(injected);
    recordRenderReport(rendered);
  } catch { /* ignore */ }

  // 7. Mismatch 감지 (최근 3세션 rolling)
  let mismatchResult: MismatchResult | null = null;
  try {
    const recentSessions = loadRecentSessions(3);
    if (recentSessions.length >= 2) {
      const allSignals: MismatchSignal[] = [];
      for (const prevSession of recentSessions) {
        const sessionEvidence = loadEvidenceBySession(prevSession.session_id);
        const corrections = sessionEvidence.filter(e => e.type === 'explicit_correction');
        const summaries = sessionEvidence.filter(e => e.type === 'session_summary');
        const strongRules = personalRules.filter(
          r => r.strength === 'strong' && r.evidence_refs.some(ref =>
            sessionEvidence.some(e => e.evidence_id === ref),
          ),
        );
        const signals = computeSessionSignals(
          prevSession.session_id,
          corrections,
          summaries,
          strongRules,
          profile.base_packs.quality_pack,
          profile.base_packs.autonomy_pack,
        );
        allSignals.push(...signals);
      }

      if (allSignals.length > 0) {
        mismatchResult = detectMismatch(allSignals);

        // mismatch 감지 시 재추천 생성
        if (mismatchResult.quality_mismatch || mismatchResult.autonomy_mismatch) {
          session.warnings.push(
            `Pack mismatch 감지: quality=${mismatchResult.quality_score}, autonomy=${mismatchResult.autonomy_score}. forgen forge --reset soft 로 재설정하거나 forgen forge --onboarding 으로 재추천을 받으세요.`,
          );

          const rec = createRecommendation({
            source: 'mismatch_recommendation',
            quality_pack: mismatchResult.quality_mismatch
              ? (profile.base_packs.quality_pack === '보수형' ? '속도형' : '보수형')
              : profile.base_packs.quality_pack,
            autonomy_pack: mismatchResult.autonomy_mismatch
              ? (profile.base_packs.autonomy_pack === '확인 우선형' ? '자율 실행형' : '확인 우선형')
              : profile.base_packs.autonomy_pack,
            suggested_trust_policy: profile.trust_preferences.desired_policy,
            confidence: 0.6,
            reason_summary: `Rolling 3세션 mismatch: quality=${mismatchResult.quality_score}, autonomy=${mismatchResult.autonomy_score}`,
          });
          saveRecommendation(rec);
        }
      }
    }
  } catch {
    // mismatch 감지 실패는 세션 시작을 막지 않음
  }

  // 8. Raw Log 기록 + TTL sweep (7일)
  try {
    // 세션 시작 로그
    const rawLogPath = path.join(V1_RAW_LOGS_DIR, `${sessionId}.jsonl`);
    fs.appendFileSync(rawLogPath, `${JSON.stringify({
      event: 'session-started',
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      quality_pack: profile.base_packs.quality_pack,
      autonomy_pack: profile.base_packs.autonomy_pack,
      judgment_pack: profile.base_packs.judgment_pack,
      communication_pack: profile.base_packs.communication_pack,
      effective_trust: session.effective_trust_policy,
    })}\n`);

    // TTL sweep: 7일 이상 된 raw log 파일 삭제
    const TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const file of fs.readdirSync(V1_RAW_LOGS_DIR)) {
      const filePath = path.join(V1_RAW_LOGS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > TTL_MS) {
          fs.unlinkSync(filePath);
        }
      } catch { /* skip */ }
    }
  } catch {
    // raw log 실패는 세션 시작을 막지 않음
  }

  return {
    needsOnboarding: false,
    legacyBackupPath,
    corruptProfileBackupPath: null,
    session,
    renderedRules,
    includedRuleIds: rendered.included.map((r) => r.rule_id),
    profile,
    mismatch: mismatchResult,
  };
}
