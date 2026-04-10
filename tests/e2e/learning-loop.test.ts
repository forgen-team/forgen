/**
 * Forgen E2E — Cross-Session Learning Loop (TDD Red Phase)
 *
 * 학습 루프의 5개 깨진 지점을 검증하는 TDD Red 테스트.
 * 이 테스트는 현재 코드베이스에서 **의도적으로 실패**한다.
 * 각 시나리오는 "아직 구현되지 않은 동작"을 어서션으로 표현한다.
 *
 * Scenarios:
 *   0A. prefer-from-now 교정 → scope:'me' 영구 규칙 승격 (승격 로직 없음 → RED)
 *   0B. 3세션 prefer-from-now → quality_mismatch 감지 (direction:'same' 점수 0 → RED)
 *   0C. fix-now session 규칙 → 새 세션 시작 시 정리 (정리 로직 없음 → RED)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── TEST_HOME isolation ──
// vi.hoisted()는 vi.mock factory 내부에서 사용하는 변수를 test body에서도
// 사용할 수 있게 한다. vi.mock은 vitest가 자동으로 파일 최상단으로 호이스트하므로,
// 정적 import보다 먼저 실행되어 paths.ts의 os.homedir() 캡처 시점에 영향을 준다.
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-learning-loop-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

// ── Source imports (paths.ts는 이 시점에 TEST_HOME을 HOME으로 인식) ──
import { processCorrection } from '../../src/forge/evidence-processor.js';
import { loadEvidenceBySession, promoteSessionCandidates } from '../../src/store/evidence-store.js';
import { loadActiveRules, cleanupStaleSessionRules } from '../../src/store/rule-store.js';
import { computeSessionSignals, detectMismatch } from '../../src/forge/mismatch-detector.js';
import { createProfile, saveProfile } from '../../src/store/profile-store.js';

// ── Path constants (TEST_HOME 기준) ──
const FORGEN_ME = path.join(TEST_HOME, '.forgen', 'me');
const EVIDENCE_DIR = path.join(FORGEN_ME, 'behavior');
const RULES_DIR = path.join(FORGEN_ME, 'rules');

// ── Lifecycle ──

beforeEach(() => {
  // 테스트마다 완전히 새로운 격리 환경 보장
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(RULES_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════
// Scenario 0A: prefer-from-now → 영구 규칙 승격
// ════════════════════════════════════════════════════════

describe('Scenario 0A: prefer-from-now 교정 → 영구 규칙 승격', () => {
  /**
   * RED 조건:
   * - processCorrection(prefer-from-now)은 evidence만 생성하고 rule은 생성하지 않는다.
   * - promotion_candidate: true가 반환되지만 실제 scope:'me' 규칙 승격은 없다.
   * - loadActiveRules()에서 scope:'me' 규칙을 찾으면 length 0 → 어서션 실패.
   */
  it('prefer-from-now 교정 후 scope:me 영구 규칙이 loadActiveRules()에 존재해야 한다', () => {
    const sessionId = 'session-0a-promo';

    // 1. prefer-from-now 교정 실행
    const result = processCorrection({
      session_id: sessionId,
      kind: 'prefer-from-now',
      message: '위험 명령 실행 전 항상 확인 요청',
      target: 'destructive-ops',
      axis_hint: 'quality_safety',
    });

    // 2. processCorrection 자체 반환값 검증 (이 부분은 현재 코드에서 통과)
    expect(result.promotion_candidate).toBe(true);
    expect(result.temporary_rule).toBeNull(); // prefer-from-now는 임시 규칙 생성 안 함

    // 3. Evidence가 생성됐는지 확인 (통과)
    const evidenceList = loadEvidenceBySession(sessionId);
    expect(evidenceList).toHaveLength(1);
    expect(evidenceList[0].raw_payload['kind']).toBe('prefer-from-now');

    // 4. 승격 실행 (auto-compound-runner가 세션 종료 시 호출하는 것을 시뮬레이션)
    const promoted = promoteSessionCandidates(sessionId);
    expect(promoted).toBe(1);

    // 5. 승격된 scope:'me' 영구 규칙이 존재해야 한다
    const activeRules = loadActiveRules();
    const meRules = activeRules.filter(r => r.scope === 'me');
    expect(meRules).toHaveLength(1);
  });

  it('승격된 me 규칙은 원본 교정의 axis_hint에 맞는 category를 가져야 한다', () => {
    const sessionId = 'session-0a-category';

    processCorrection({
      session_id: sessionId,
      kind: 'prefer-from-now',
      message: '테스트 커버리지 83% 이상 유지',
      target: 'test-coverage',
      axis_hint: 'quality_safety',
    });

    // 승격 실행
    promoteSessionCandidates(sessionId);

    // 승격된 규칙의 category가 'quality'여야 한다
    const activeRules = loadActiveRules();
    const promotedRule = activeRules.find(r => r.scope === 'me' && r.category === 'quality');
    expect(promotedRule).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════
// Scenario 0B: 3세션 Mismatch 감지
// ════════════════════════════════════════════════════════

describe('Scenario 0B: 3세션 prefer-from-now → quality_mismatch 감지', () => {
  /**
   * RED 조건:
   * - processCorrection(prefer-from-now)은 raw_payload.direction = 'same'을 기록
   * - computeSessionSignals()는 direction === 'opposite'인 correction만 +2 점수 부여
   * - direction === 'same'은 0점 → 3세션 누적 점수도 0 → quality_mismatch: false
   * - expect(quality_mismatch).toBe(true) → 실패
   */
  it('3세션에 걸친 quality_safety prefer-from-now 교정은 quality_mismatch를 true로 만들어야 한다', () => {
    const profile = createProfile(
      'test-user-0b',
      '보수형',
      '확인 우선형',
      '가드레일 우선',
      'onboarding',
    );
    saveProfile(profile);

    const allSignals: ReturnType<typeof computeSessionSignals> = [];

    // 3개 세션에 걸쳐 prefer-from-now quality_safety 교정 누적 (세션당 2회 = 총 6점)
    for (let i = 0; i < 3; i++) {
      const sessionId = `session-0b-${i}`;

      processCorrection({
        session_id: sessionId,
        kind: 'prefer-from-now',
        message: `품질 검증 강화 요청 ${i + 1}-a`,
        target: `code-quality-${i}-a`,
        axis_hint: 'quality_safety',
      });
      processCorrection({
        session_id: sessionId,
        kind: 'prefer-from-now',
        message: `품질 검증 강화 요청 ${i + 1}-b`,
        target: `code-quality-${i}-b`,
        axis_hint: 'quality_safety',
      });

      const corrections = loadEvidenceBySession(sessionId);
      const signals = computeSessionSignals(
        sessionId,
        corrections,
        [],    // summaries 없음
        [],    // newStrongRules 없음
        '보수형',
        '확인 우선형',
      );
      allSignals.push(...signals);
    }

    const result = detectMismatch(allSignals);

    // 3세션 × 2교정 × 1점 = 6점 ≥ threshold(4) → quality_mismatch: true
    expect(result.quality_mismatch).toBe(true);
  });

  it('prefer-from-now 교정의 누적 quality_score는 3세션(세션당 2회) 후 4 이상이어야 한다', () => {
    const allSignals: ReturnType<typeof computeSessionSignals> = [];

    for (let i = 0; i < 3; i++) {
      const sessionId = `session-0b-score-${i}`;

      processCorrection({
        session_id: sessionId,
        kind: 'prefer-from-now',
        message: `검증 강도 교정 ${i + 1}-a`,
        target: `verification-${i}-a`,
        axis_hint: 'quality_safety',
      });
      processCorrection({
        session_id: sessionId,
        kind: 'prefer-from-now',
        message: `검증 강도 교정 ${i + 1}-b`,
        target: `verification-${i}-b`,
        axis_hint: 'quality_safety',
      });

      const corrections = loadEvidenceBySession(sessionId);
      const signals = computeSessionSignals(
        sessionId,
        corrections,
        [],
        [],
        '보수형',
        '확인 우선형',
      );
      allSignals.push(...signals);
    }

    const result = detectMismatch(allSignals);

    // 3세션 × 2교정 × 1점 = 6점 ≥ threshold(4)
    expect(result.quality_score).toBeGreaterThanOrEqual(4);
  });
});

// ════════════════════════════════════════════════════════
// Scenario 0C: Session 규칙 정리
// ════════════════════════════════════════════════════════

describe('Scenario 0C: fix-now session 규칙 → 새 세션 시작 시 정리', () => {
  /**
   * RED 조건:
   * - processCorrection(fix-now)는 scope:'session' 임시 규칙을 생성한다.
   * - 새 세션이 시작될 때 이전 세션의 scope:'session' 규칙은 정리되어야 한다.
   * - 정리 함수(cleanupStaleSessionRules 등)가 없으므로 구형 session 규칙이 잔존.
   * - expect(staleSessionRules).toHaveLength(0) → 실패
   */
  it('이전 세션의 fix-now session 규칙은 새 세션에서 loadActiveRules()에 나타나지 않아야 한다', () => {
    const oldSessionId = 'session-0c-old';

    // 1. 이전 세션에서 fix-now 교정 → scope:'session' 임시 규칙 생성
    const result = processCorrection({
      session_id: oldSessionId,
      kind: 'fix-now',
      message: '이번 세션에서만 간결하게 출력',
      target: 'verbose-output',
      axis_hint: 'communication_style',
    });

    // 2. 임시 규칙 생성 확인 (통과)
    expect(result.temporary_rule).not.toBeNull();
    expect(result.temporary_rule!.scope).toBe('session');

    // 3. loadActiveRules()에 임시 규칙이 존재함을 확인 (통과)
    const rulesAfterOldSession = loadActiveRules();
    const sessionRulesAfterOld = rulesAfterOldSession.filter(r => r.scope === 'session');
    expect(sessionRulesAfterOld).toHaveLength(1);

    // 4. 새 세션 시작 — 이전 세션의 scope:'session' 규칙 정리
    cleanupStaleSessionRules('session-0c-new');

    // 5. 새 세션 관점에서 active rules를 조회 — scope:'session' 규칙이 없어야 한다
    const staleSessionRules = loadActiveRules().filter(r => r.scope === 'session');
    expect(staleSessionRules).toHaveLength(0);
  });

  it('fix-now 규칙 생성 후 scope:me 영구 규칙 수는 변하지 않아야 한다', () => {
    // scope:'me' 규칙이 실수로 생성되지 않는지 확인 (fix-now는 session만)
    processCorrection({
      session_id: 'session-0c-check',
      kind: 'fix-now',
      message: '단기 조정',
      target: 'short-term',
      axis_hint: 'autonomy',
    });

    const activeRules = loadActiveRules();
    const meRules = activeRules.filter(r => r.scope === 'me');

    // fix-now는 me 규칙을 생성하면 안 된다 (통과 — 현재 코드 올바름)
    expect(meRules).toHaveLength(0);

    // session 규칙은 1개 생성 (통과)
    const sessionRules = activeRules.filter(r => r.scope === 'session');
    expect(sessionRules).toHaveLength(1);
  });
});
