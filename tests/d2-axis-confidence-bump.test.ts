/**
 * Invariant: D2 — explicit_correction → axis confidence 직접 경로 (2026-04-27)
 *
 * 자기증거: autonomy explicit_correction 6건이 axes confidence 0.45 정중앙 유지.
 * 본 fix 는 explicit_correction 의 axis_hint 가 즉시 confidence bump 를 트리거.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_FORGEN_HOME = path.join(os.tmpdir(), `forgen-d2-test-${process.pid}`);

beforeEach(() => {
  fs.rmSync(TEST_FORGEN_HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_FORGEN_HOME, 'me'), { recursive: true });
  // 초기 profile (4축 conf 0.45)
  const initialProfile = {
    user_id: 'default',
    model_version: '2.0',
    axes: {
      quality_safety: { score: 0.5, facets: { verification_depth: 0.5, stop_threshold: 0.5, change_conservatism: 0.5 }, confidence: 0.45 },
      autonomy: { score: 0.5, facets: { confirmation_independence: 0.5, assumption_tolerance: 0.5, scope_expansion_tolerance: 0.5, approval_threshold: 0.5 }, confidence: 0.45 },
      judgment_philosophy: { score: 0.5, facets: { minimal_change_bias: 0.5, abstraction_bias: 0.5, evidence_first_bias: 0.5 }, confidence: 0.45 },
      communication_style: { score: 0.5, facets: { verbosity: 0.5, structure: 0.5, teaching_bias: 0.5 }, confidence: 0.45 },
    },
    base_packs: {
      quality_pack: '보수형',
      autonomy_pack: '확인 우선형',
      judgment_pack: '구조적접근형',
      communication_pack: '상세형',
    },
    trust_preferences: { desired_policy: '가드레일 우선' },
    metadata: { created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  };
  fs.writeFileSync(
    path.join(TEST_FORGEN_HOME, 'me', 'forge-profile.json'),
    JSON.stringify(initialProfile, null, 2),
  );
  process.env.FORGEN_HOME = TEST_FORGEN_HOME;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(TEST_FORGEN_HOME, { recursive: true, force: true });
  delete process.env.FORGEN_HOME;
});

describe('D2: bumpAxisConfidence 직접 경로', () => {
  it('autonomy 6번 호출 (avoid-this 가정 +0.04 × 6) → confidence 0.45 → 0.69', async () => {
    const { bumpAxisConfidence, loadProfile } = await import('../src/store/profile-store.js');
    for (let i = 0; i < 6; i++) bumpAxisConfidence('autonomy', 0.04);
    const p = loadProfile();
    expect(p?.axes.autonomy.confidence).toBeCloseTo(0.69, 2);
  });

  it('quality_safety 7번 호출 (+0.02 × 7) → 0.45 → 0.59', async () => {
    const { bumpAxisConfidence, loadProfile } = await import('../src/store/profile-store.js');
    for (let i = 0; i < 7; i++) bumpAxisConfidence('quality_safety', 0.02);
    const p = loadProfile();
    expect(p?.axes.quality_safety.confidence).toBeCloseTo(0.59, 2);
  });

  it('clamp 1.0 — 50번 호출해도 1.0 초과 안 함', async () => {
    const { bumpAxisConfidence, loadProfile } = await import('../src/store/profile-store.js');
    for (let i = 0; i < 50; i++) bumpAxisConfidence('autonomy', 0.05);
    const p = loadProfile();
    expect(p?.axes.autonomy.confidence).toBe(1.0);
  });

  it('facet 값은 변경 안 함 (회귀 안전)', async () => {
    const { bumpAxisConfidence, loadProfile } = await import('../src/store/profile-store.js');
    bumpAxisConfidence('autonomy', 0.04);
    const p = loadProfile();
    // facets 모두 초기값 0.5 유지
    expect(p?.axes.autonomy.facets.confirmation_independence).toBe(0.5);
    expect(p?.axes.autonomy.facets.assumption_tolerance).toBe(0.5);
    expect(p?.axes.autonomy.facets.scope_expansion_tolerance).toBe(0.5);
    expect(p?.axes.autonomy.facets.approval_threshold).toBe(0.5);
  });

  it('profile 없으면 false 반환 (fail-open)', async () => {
    fs.unlinkSync(path.join(TEST_FORGEN_HOME, 'me', 'forge-profile.json'));
    const { bumpAxisConfidence } = await import('../src/store/profile-store.js');
    expect(bumpAxisConfidence('autonomy', 0.05)).toBe(false);
  });
});

describe('D2: processCorrection 통합 — explicit_correction 이 confidence bump 트리거', () => {
  it('axis_hint=autonomy + kind=avoid-this → autonomy.confidence +0.04', async () => {
    const { processCorrection } = await import('../src/forge/evidence-processor.js');
    const { loadProfile } = await import('../src/store/profile-store.js');

    processCorrection({
      session_id: 'test-d2-1',
      message: '사소한 변경은 묻지 말고 진행',
      axis_hint: 'autonomy',
      kind: 'avoid-this',
      target: 'over-confirmation',
    });

    const p = loadProfile();
    expect(p?.axes.autonomy.confidence).toBeCloseTo(0.49, 2);
  });

  it('axis_hint=null → 변경 없음', async () => {
    const { processCorrection } = await import('../src/forge/evidence-processor.js');
    const { loadProfile } = await import('../src/store/profile-store.js');

    processCorrection({
      session_id: 'test-d2-2',
      message: '일반 메시지',
      axis_hint: null,
      kind: 'fix-now',
      target: 'something',
    });

    const p = loadProfile();
    // 모든 축 0.45 그대로
    expect(p?.axes.autonomy.confidence).toBe(0.45);
    expect(p?.axes.quality_safety.confidence).toBe(0.45);
  });
});
