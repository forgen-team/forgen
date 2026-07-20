/**
 * tests/roi-demotion.test.ts — ADR-010 W3-1 (F2) Injection ROI 루프.
 *
 * 판정은 순수 함수(evaluateRoiDemotions)라 fixture 만으로 결정적 검증.
 * 저장소는 주입 가능한 home 으로 실제 fs 검증 (mock 없음).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateRoiDemotions, applyRoiDemotions, isRoiQuarantined,
  loadRoiDemotions, saveRoiDemotions, DEFAULT_ROI_THRESHOLDS,
  type RoiDemotions,
} from '../src/engine/roi-demotion.js';
import type { HitRateRow } from '../src/core/observability-store.js';

function row(id: string, surfaced90: number, acted90: number): HitRateRow {
  return {
    solutionId: id,
    matched_30d: 0, surfaced_30d: 0, acted_30d: 0,
    matched_90d: 0, surfaced_90d: surfaced90, acted_90d: acted90,
    matched_180d: 0, surfaced_180d: surfaced90, acted_180d: acted90,
    last_event_ts: Date.now(),
  };
}

const NOW = () => '2026-07-16T00:00:00.000Z';
const DAY_LATER = () => '2026-07-17T00:00:00.000Z';
const TWO_DAYS = () => '2026-07-18T00:00:00.000Z';

describe('evaluateRoiDemotions (순수 판정)', () => {
  it('surfaced>=3 && rate<0.1 → 신규 강등 (windowCount=1)', () => {
    const next = evaluateRoiDemotions([row('sol-a', 5, 0)], {}, DEFAULT_ROI_THRESHOLDS, NOW);
    expect(next['sol-a']).toMatchObject({ reason: 'low-roi', windowCount: 1, surfaced: 5, actedOn: 0 });
    expect(isRoiQuarantined(next['sol-a'])).toBe(false);
  });

  it('surfaced<3 은 유예 — 신규/저노출 솔루션 보호', () => {
    const next = evaluateRoiDemotions([row('sol-new', 2, 0)], {}, DEFAULT_ROI_THRESHOLDS, NOW);
    expect(next['sol-new']).toBeUndefined();
  });

  it('rate>=0.1 은 강등하지 않음 (경계: 1/10 = 0.1)', () => {
    const next = evaluateRoiDemotions([row('sol-ok', 10, 1)], {}, DEFAULT_ROI_THRESHOLDS, NOW);
    expect(next['sol-ok']).toBeUndefined();
  });

  it('24h+ 간격 2회 연속 저 ROI → windowCount=2 → 격리', () => {
    const first = evaluateRoiDemotions([row('sol-a', 5, 0)], {}, DEFAULT_ROI_THRESHOLDS, NOW);
    const second = evaluateRoiDemotions([row('sol-a', 8, 0)], first, DEFAULT_ROI_THRESHOLDS, DAY_LATER);
    expect(second['sol-a'].windowCount).toBe(2);
    expect(isRoiQuarantined(second['sol-a'])).toBe(true);
    // demotedAt 은 최초 강등 시점 유지
    expect(second['sol-a'].demotedAt).toBe(first['sol-a'].demotedAt);
  });

  it('리뷰 SEV-2: 같은 날 재평가는 windowCount 를 올리지 않는다 (격리 조기 발동 방지)', () => {
    const first = evaluateRoiDemotions([row('sol-a', 5, 0)], {}, DEFAULT_ROI_THRESHOLDS, NOW);
    // 같은 날 두 번째 세션 — 90d 스냅샷은 사실상 동일, 새 정보 없음
    const sameDay = evaluateRoiDemotions([row('sol-a', 5, 0)], first, DEFAULT_ROI_THRESHOLDS, NOW);
    expect(sameDay['sol-a'].windowCount).toBe(1);
    expect(isRoiQuarantined(sameDay['sol-a'])).toBe(false);
  });

  it('진동 사이클: 강등 → acted 해제 → 재강등은 windowCount=1 부터 (격리 이력 리셋)', () => {
    const demoted = evaluateRoiDemotions([row('sol-a', 5, 0)], {}, DEFAULT_ROI_THRESHOLDS, NOW);
    // 사용자가 씀 → 해제
    const released = evaluateRoiDemotions([row('sol-a', 10, 1)], demoted, DEFAULT_ROI_THRESHOLDS, DAY_LATER);
    expect(released['sol-a']).toBeUndefined();
    // 이후 다시 저 ROI — 이력이 리셋됐으므로 1부터
    const reDemoted = evaluateRoiDemotions([row('sol-a', 30, 1)], released, DEFAULT_ROI_THRESHOLDS, TWO_DAYS);
    expect(reDemoted['sol-a'].windowCount).toBe(1);
  });

  it('리뷰 SEV-3: acted age-out 으로 stored actedOn > 현재 acted 여도 1사이클 내 자가치유', () => {
    // 저장 시점 actedOn=2 인데 rolling window 에서 acted 이벤트가 빠져 1로 감소
    const stale: RoiDemotions = {
      'sol-a': { solutionId: 'sol-a', reason: 'low-roi', demotedAt: NOW(), windowCount: 1, lastEvaluatedAt: NOW(), surfaced: 30, actedOn: 2 },
    };
    // acted(1) > actedOn(2) 아님 → 해제 안 됨, 재강등으로 actedOn=1 로 갱신됨
    const next = evaluateRoiDemotions([row('sol-a', 30, 1)], stale, DEFAULT_ROI_THRESHOLDS, DAY_LATER);
    expect(next['sol-a'].actedOn).toBe(1);
    // 이제 새 acted 1건만 생겨도 (2 > 1) 해제된다
    const healed = evaluateRoiDemotions([row('sol-a', 31, 2)], next, DEFAULT_ROI_THRESHOLDS, TWO_DAYS);
    expect(healed['sol-a']).toBeUndefined();
  });

  it('acted_on 신규 발생 → 즉시 해제 (강등/격리 무관)', () => {
    const demoted: RoiDemotions = {
      'sol-a': { solutionId: 'sol-a', reason: 'low-roi', demotedAt: NOW(), windowCount: 2, lastEvaluatedAt: NOW(), surfaced: 8, actedOn: 0 },
    };
    // 사용자가 실제로 씀: acted 0 → 1 (rate 여전히 <0.1 이어도 해제)
    const next = evaluateRoiDemotions([row('sol-a', 20, 1)], demoted, DEFAULT_ROI_THRESHOLDS, NOW);
    expect(next['sol-a']).toBeUndefined();
  });

  it('rate 회복 → 해제', () => {
    const demoted = evaluateRoiDemotions([row('sol-a', 5, 0)], {}, DEFAULT_ROI_THRESHOLDS, NOW);
    const next = evaluateRoiDemotions([row('sol-a', 5, 3)], demoted, DEFAULT_ROI_THRESHOLDS, NOW);
    expect(next['sol-a']).toBeUndefined();
  });

  it('기존 강등 엔트리는 노출이 임계 밑으로 줄어도 유지 (회복은 acted 로만)', () => {
    const demoted = evaluateRoiDemotions([row('sol-a', 5, 0)], {}, DEFAULT_ROI_THRESHOLDS, NOW);
    const next = evaluateRoiDemotions([row('sol-a', 1, 0)], demoted, DEFAULT_ROI_THRESHOLDS, DAY_LATER);
    expect(next['sol-a']).toBeDefined();
    expect(next['sol-a'].windowCount).toBe(1); // 유지이지 누적 아님
  });

  it('이벤트가 age-out 된 엔트리(rows 부재)는 소멸', () => {
    const demoted: RoiDemotions = {
      'sol-gone': { solutionId: 'sol-gone', reason: 'low-roi', demotedAt: NOW(), windowCount: 1, lastEvaluatedAt: NOW(), surfaced: 5, actedOn: 0 },
    };
    const next = evaluateRoiDemotions([], demoted, DEFAULT_ROI_THRESHOLDS, NOW);
    expect(Object.keys(next)).toHaveLength(0);
  });
});

describe('applyRoiDemotions (matchSolutions 후처리)', () => {
  const demotions: RoiDemotions = {
    demoted: { solutionId: 'demoted', reason: 'low-roi', demotedAt: NOW(), windowCount: 1, lastEvaluatedAt: NOW(), surfaced: 5, actedOn: 0 },
    isolated: { solutionId: 'isolated', reason: 'low-roi', demotedAt: NOW(), windowCount: 2, lastEvaluatedAt: NOW(), surfaced: 9, actedOn: 0 },
  };

  it('강등 ×0.5 + 재정렬, 격리는 제외, 나머지 무변화', () => {
    const matches = [
      { name: 'demoted', relevance: 0.9 },
      { name: 'isolated', relevance: 0.8 },
      { name: 'healthy', relevance: 0.6 },
    ];
    const out = applyRoiDemotions(matches, demotions);

    expect(out.map(m => m.name)).toEqual(['healthy', 'demoted']); // isolated 제외
    expect(out.find(m => m.name === 'demoted')?.relevance).toBeCloseTo(0.45);
    expect(out.find(m => m.name === 'healthy')?.relevance).toBe(0.6);
    // 재정렬: 0.6 > 0.45
    expect(out[0].name).toBe('healthy');
  });

  it('빈 demotions → 원본 그대로 (fail-open 경로)', () => {
    const matches = [{ name: 'a', relevance: 0.5 }];
    expect(applyRoiDemotions(matches, {})).toBe(matches);
  });
});

describe('저장소 roundtrip (실제 fs)', () => {
  let HOME: string;
  beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-roi-')); });
  afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

  it('save → load roundtrip; 부재/파손 시 빈 객체', () => {
    expect(loadRoiDemotions(HOME)).toEqual({});

    const demotions: RoiDemotions = {
      'sol-a': { solutionId: 'sol-a', reason: 'low-roi', demotedAt: NOW(), windowCount: 1, lastEvaluatedAt: NOW(), surfaced: 5, actedOn: 0 },
    };
    saveRoiDemotions(demotions, HOME);
    expect(loadRoiDemotions(HOME)).toEqual(demotions);

    // 파손 파일 → 빈 객체 (fail-open)
    fs.writeFileSync(path.join(HOME, '.forgen', 'state', 'roi-demotions.json'), '{broken');
    expect(loadRoiDemotions(HOME)).toEqual({});
  });

  it('save 는 원자적 tmp+rename — .tmp 잔여물 없이 유효 JSON 만 남긴다 (리뷰 SEV-3)', () => {
    const demotions: RoiDemotions = {
      'sol-b': { solutionId: 'sol-b', reason: 'low-roi', demotedAt: NOW(), windowCount: 2, lastEvaluatedAt: NOW(), surfaced: 9, actedOn: 0 },
    };
    saveRoiDemotions(demotions, HOME);
    saveRoiDemotions(demotions, HOME); // 덮어쓰기 경로도 rename 이 성공해야 한다

    const stateDir = path.join(HOME, '.forgen', 'state');
    const leftovers = fs.readdirSync(stateDir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    // 최종 파일은 곧바로 파싱 가능한 완전한 JSON
    expect(JSON.parse(fs.readFileSync(path.join(stateDir, 'roi-demotions.json'), 'utf-8'))).toEqual(demotions);
  });
});
