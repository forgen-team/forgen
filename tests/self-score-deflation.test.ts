/**
 * TEST-2: 자가 점수 인플레이션 가드.
 *
 * v0.4.0 self-interview RC2: 자가 평가 점수 (신뢰도 90%, 8/10, 0.7→0.9) 가 턴마다
 * 올라가지만 npm test / curl / Read 등 측정 도구 호출 0건. Claude 가 자기-아부
 * (sycophancy) 로 숫자를 부풀리는 패턴. Stop hook 레벨 block 으로 차단.
 */
import { describe, it, expect } from 'vitest';
import { checkSelfScoreInflation } from '../src/checks/self-score-deflation.js';

describe('checkSelfScoreInflation — TEST-2', () => {
  it('no score signal → block=false', () => {
    const r = checkSelfScoreInflation({
      text: '이번 턴에서는 파일을 읽고 계획을 세웠습니다.',
      recentTools: [],
    });
    expect(r.block).toBe(false);
  });

  it('score signal + zero measurement → block', () => {
    const r = checkSelfScoreInflation({
      text: '이번 작업 신뢰도 90% 로 평가됩니다.',
      recentTools: ['Agent', 'TaskCreate'],
    });
    expect(r.block).toBe(true);
    expect(r.scoreSignals.length).toBeGreaterThan(0);
    expect(r.reason).toContain('측정 도구 호출 0회');
  });

  it('positive delta notation detected (0.7 → 0.9)', () => {
    const r = checkSelfScoreInflation({
      text: '품질이 0.7 → 0.9 로 개선됐습니다.',
      recentTools: [],
    });
    expect(r.block).toBe(true);
    expect(r.deltas).toEqual(expect.arrayContaining([{ from: 0.7, to: 0.9 }]));
  });

  it('negative/no-change delta alone does not trigger', () => {
    const r = checkSelfScoreInflation({
      text: '점수는 0.9 → 0.9 로 유지.',
      recentTools: [],
    });
    expect(r.deltas).toHaveLength(0);
  });

  it('8/10 fraction score flagged', () => {
    const r = checkSelfScoreInflation({
      text: '현재 작업 완성도 8/10.',
      recentTools: [],
    });
    expect(r.block).toBe(true);
  });

  it('score signal + measurement tools → block=false', () => {
    const r = checkSelfScoreInflation({
      text: '신뢰도 85%. 테스트 통과 확인함.',
      recentTools: ['Bash', 'Read', 'Bash'],
    });
    expect(r.block).toBe(false);
    expect(r.measurementCount).toBe(2); // v0.4.1: Read 는 측정 아님, Bash 2개만 count
  });

  it('Agent-only tools are not measurements (regression)', () => {
    const r = checkSelfScoreInflation({
      text: '완성도 90%.',
      recentTools: ['Agent', 'Agent', 'TaskCreate', 'TaskUpdate'],
    });
    expect(r.block).toBe(true);
    expect(r.measurementCount).toBe(0);
  });

  it('v0.4.1 coverage fix: Read/Edit/Write/Grep/Glob alone 은 수치 점수 근거 안 됨 → block', () => {
    // buyer-day1 R4 실 관찰: Claude 가 자가평가 전 Read 한 번 하면 이전 구현에서는
    // measurement=1 되어 block 회피. 이건 실 실행이 아니라 읽기만이라 수치 주장
    // 뒷받침 불가. v0.4.1 부터 Bash / NotebookEdit 만 측정.
    const r = checkSelfScoreInflation({
      text: '신뢰도 95/100, 완벽도 72/100.',
      recentTools: ['Read', 'Read', 'Edit', 'Write', 'Grep', 'Glob'],
    });
    expect(r.block).toBe(true);
    expect(r.measurementCount).toBe(0);
  });

  it('v0.4.1 coverage fix: Bash 실행만 true measurement', () => {
    const r = checkSelfScoreInflation({
      text: '신뢰도 95/100.',
      recentTools: ['Read', 'Bash', 'Edit'],
    });
    expect(r.block).toBe(false);
    expect(r.measurementCount).toBe(1);
  });

  it('star rating flagged', () => {
    const r = checkSelfScoreInflation({
      text: '오늘 작업 ⭐⭐⭐⭐⭐ 입니다.',
      recentTools: [],
    });
    expect(r.block).toBe(true);
  });

  it('reason includes specific delta sample and guidance', () => {
    const r = checkSelfScoreInflation({
      text: 'confidence 0.5 → 0.9, quality 70 → 95.',
      recentTools: [],
    });
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/(0\.5→0\.9|70→95)/);
    expect(r.reason).toMatch(/테스트|빌드|curl/);
  });

  it('minMeasurements threshold applied', () => {
    const r = checkSelfScoreInflation({
      text: '신뢰도 88%.',
      recentTools: ['Bash'],
      minMeasurements: 3,
    });
    expect(r.block).toBe(true); // 1 < 3
  });
});
