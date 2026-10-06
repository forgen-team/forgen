/**
 * ADR-017 §6-8 — 4축 score 산출 (v0.1.0~0.5.9 동안 0.5 고정이던 결함의 회귀 테스트).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-profile-score-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const {
  projectFacets, computeAxisScore, recomputeProfileScores, axisDirection, AXIS_POLES, NEUTRAL_ANCHOR,
} = await import('../src/store/profile-score.js');
const {
  createProfile, loadProfile, saveProfile, bumpAxisConfidence, recomputeIfNeverReclassified,
} = await import('../src/store/profile-store.js');
const { ME_DIR } = await import('../src/core/paths.js');

describe('projectFacets — 선분 투영', () => {
  const { low, high } = AXIS_POLES.quality_safety;
  it('low centroid → 0, high centroid → 1, 중점 → 0.5', () => {
    expect(projectFacets(low, low, high)).toBeCloseTo(0, 9);
    expect(projectFacets(high, low, high)).toBeCloseTo(1, 9);
    const mid = Object.fromEntries(Object.keys(low).map(k => [k, (low[k] + high[k]) / 2]));
    expect(projectFacets(mid, low, high)).toBeCloseTo(0.5, 9);
  });
  it('선분 밖으로 벗어나면 0~1 로 clamp', () => {
    const beyond = Object.fromEntries(Object.keys(low).map(k => [k, high[k] + (high[k] - low[k])]));
    expect(projectFacets(beyond, low, high)).toBe(1);
  });
  it('알 수 없는 facet 은 무시, 숫자 아닌 값은 low 로 간주', () => {
    expect(projectFacets({ ...low, bogus: 99 }, low, high)).toBeCloseTo(0, 9);
    expect(projectFacets({ verification_depth: 'x' as unknown as number }, low, high)).toBeCloseTo(0, 9);
  });
  it('퇴화 선분(low==high)은 중립 anchor', () => {
    expect(projectFacets(low, low, low)).toBe(NEUTRAL_ANCHOR);
  });
});

describe('computeAxisScore — confidence 가중', () => {
  const { high } = AXIS_POLES.autonomy;
  it('confidence 0 이면 facet 과 무관하게 0.5', () => {
    expect(computeAxisScore('autonomy', high, 0)).toBe(0.5);
  });
  it('confidence 1 이면 facet 위치 그대로', () => {
    expect(computeAxisScore('autonomy', high, 1)).toBeCloseTo(1, 9);
  });
  it('confidence 0.6, facet 위치 1 → 0.6×1 + 0.4×0.5 = 0.8', () => {
    expect(computeAxisScore('autonomy', high, 0.6)).toBeCloseTo(0.8, 9);
  });
});

describe('recomputeProfileScores', () => {
  it('팩 centroid 그대로인 새 프로필은 confidence 0.45 → 0.5 근처가 아니라 팩 방향으로 이동하고 reclass 시각을 기록', () => {
    const p = createProfile('u', '보수형', '확인 우선형', '가드레일 우선', 'onboarding');
    expect(p.axes.quality_safety.score).toBe(0.5);
    expect(p.metadata.last_reclassification_at).toBeNull();
    const r = recomputeProfileScores(p, new Date('2026-10-06T00:00:00Z'));
    expect(r.changed).toBe(true);
    // 보수형 = low 극 → t=0 → 0.45×0 + 0.55×0.5 = 0.275
    expect(p.axes.quality_safety.score).toBeCloseTo(0.275, 3);
    expect(p.axes.autonomy.score).toBeCloseTo(0.275, 3);
    // 균형형 기본 → 선분 중앙 근처(투영 t≈0.53) → 0.45×0.53 + 0.55×0.5 ≈ 0.51
    expect(p.axes.judgment_philosophy.score).toBeGreaterThan(0.45);
    expect(p.axes.judgment_philosophy.score).toBeLessThan(0.55);
    expect(p.metadata.last_reclassification_at).toBe('2026-10-06T00:00:00.000Z');
  });
  it('변동 없으면 changed=false 이고 reclass 시각을 건드리지 않음', () => {
    const p = createProfile('u', '균형형', '균형형', '가드레일 우선', 'onboarding');
    recomputeProfileScores(p);
    const ts = p.metadata.last_reclassification_at;
    const r2 = recomputeProfileScores(p, new Date('2030-01-01T00:00:00Z'));
    expect(r2.changed).toBe(false);
    expect(p.metadata.last_reclassification_at).toBe(ts);
  });
});

describe('axisDirection', () => {
  it('0.4 미만 low, 0.6 초과 high, 사이는 mid', () => {
    expect(axisDirection(0.2)).toBe('low');
    expect(axisDirection(0.8)).toBe('high');
    expect(axisDirection(0.5)).toBe('mid');
  });
  it('극성 회귀: 모든 축의 low 팩 centroid 는 score<0.5, high 팩 centroid 는 >0.5 (confidence 0.9)', () => {
    for (const axis of Object.keys(AXIS_POLES) as Array<keyof typeof AXIS_POLES>) {
      expect(computeAxisScore(axis, AXIS_POLES[axis].low, 0.9)).toBeLessThan(0.5);
      expect(computeAxisScore(axis, AXIS_POLES[axis].high, 0.9)).toBeGreaterThan(0.5);
    }
  });
});

describe('profile-store 통합 — 저장 경로가 score 를 실제로 움직임 (격리 HOME)', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(ME_DIR, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('bumpAxisConfidence 가 score 를 0.5 에서 벗어나게 하고 reclass 를 기록', () => {
    saveProfile(createProfile('u', '보수형', '확인 우선형', '가드레일 우선', 'onboarding'));
    expect(loadProfile()!.axes.autonomy.score).toBe(0.5);
    expect(bumpAxisConfidence('autonomy', 0.1)).toBe(true);
    const after = loadProfile()!;
    expect(after.axes.autonomy.confidence).toBeCloseTo(0.55, 9);
    // low 극(t=0): 0.55×0 + 0.45×0.5 = 0.225
    expect(after.axes.autonomy.score).toBeCloseTo(0.225, 3);
    expect(after.metadata.last_reclassification_at).not.toBeNull();
  });

  it('recomputeIfNeverReclassified 는 null 인 프로필만 1회 계산하고 이후 no-op', () => {
    saveProfile(createProfile('u', '속도형', '자율 실행형', '가드레일 우선', 'onboarding'));
    const r1 = recomputeIfNeverReclassified();
    expect(r1?.changed).toBe(true);
    // high 극(t=1): 0.45×1 + 0.55×0.5 = 0.725
    expect(loadProfile()!.axes.quality_safety.score).toBeCloseTo(0.725, 3);
    expect(recomputeIfNeverReclassified()).toBeNull();
  });

  it('프로필 없음 → null', () => {
    expect(recomputeIfNeverReclassified()).toBeNull();
  });

  it('계산 결과가 저장값과 같아도(changed=false) 스탬프를 찍어 매 세션 재저장하지 않는다 (critic SEV-2)', () => {
    const p = createProfile('u', '균형형', '균형형', '가드레일 우선', 'onboarding');
    for (const a of Object.values(p.axes)) a.confidence = 0; // c=0 → score 0.5 그대로
    saveProfile(p);
    const r = recomputeIfNeverReclassified();
    expect(r?.changed).toBe(false);
    expect(loadProfile()!.metadata.last_reclassification_at).not.toBeNull();
    expect(recomputeIfNeverReclassified()).toBeNull();
  });

  it('last_reclassification_at 키가 아예 없는 구버전 파일도 1회 계산 대상', () => {
    const p = createProfile('u', '보수형', '확인 우선형', '가드레일 우선', 'onboarding');
    delete (p.metadata as Partial<typeof p.metadata>).last_reclassification_at;
    saveProfile(p);
    expect(recomputeIfNeverReclassified()?.changed).toBe(true);
  });
});
