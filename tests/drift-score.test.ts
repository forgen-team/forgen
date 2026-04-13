import { describe, it, expect } from 'vitest';
import { updateEwma, createDriftState, evaluateDrift } from '../src/core/drift-score.js';

describe('drift-score', () => {
  describe('updateEwma', () => {
    it('alpha=1 이면 이전 값 무시, sample만 반환', () => {
      expect(updateEwma(0.5, 1.0, 1.0)).toBe(1.0);
    });

    it('alpha=0 이면 sample 무시, 이전 값만 반환', () => {
      expect(updateEwma(0.5, 1.0, 0.0)).toBe(0.5);
    });

    it('alpha=0.35 일반 케이스', () => {
      const result = updateEwma(0.0, 1.0, 0.35);
      expect(result).toBeCloseTo(0.35, 5);
    });
  });

  describe('evaluateDrift', () => {
    it('초기 상태에서 일반 edit은 normal', () => {
      const state = createDriftState('test');
      const result = evaluateDrift(state, true, false);
      expect(result.level).toBe('normal');
      expect(result.message).toBeNull();
      expect(state.totalEdits).toBe(1);
    });

    it('15회 edit 후 warning 발생', () => {
      const state = createDriftState('test');
      let sawWarning = false;
      for (let i = 0; i < 15; i++) {
        const r = evaluateDrift(state, true, false);
        if (r.level === 'warning') sawWarning = true;
      }
      expect(sawWarning).toBe(true);
      expect(state.totalEdits).toBe(15);
    });

    it('30회 edit 후 critical 발생', () => {
      const state = createDriftState('test');
      // 15회까지 warning 쿨다운 세팅
      for (let i = 0; i < 15; i++) evaluateDrift(state, true, false);
      state.lastWarningAt = 0; // 쿨다운 리셋
      state.lastCriticalAt = 0;
      // 15회 더
      let lastResult;
      for (let i = 0; i < 15; i++) {
        lastResult = evaluateDrift(state, true, false);
      }
      expect(lastResult!.level).toBe('critical');
      expect(state.totalEdits).toBe(30);
    });

    it('2회 revert면 critical', () => {
      const state = createDriftState('test');
      evaluateDrift(state, true, true); // 1 revert
      const result = evaluateDrift(state, true, true); // 2 reverts
      expect(result.level).toBe('critical');
      expect(state.totalReverts).toBe(2);
    });

    it('50회 edit면 hardcap', () => {
      const state = createDriftState('test');
      state.totalEdits = 49;
      state.lastWarningAt = Date.now(); // 쿨다운 활성화
      state.lastCriticalAt = Date.now();
      const result = evaluateDrift(state, true, false);
      expect(result.level).toBe('hardcap');
      expect(result.score).toBe(100);
      expect(state.hardCapReached).toBe(true);
    });

    it('쿨다운 기간 내에는 경고 억제', () => {
      const state = createDriftState('test');
      for (let i = 0; i < 15; i++) evaluateDrift(state, true, false);
      // 바로 다음 호출 — 쿨다운 내이므로 normal
      const result = evaluateDrift(state, true, false);
      expect(result.level).toBe('normal');
    });

    it('커스텀 임계치 지원', () => {
      const state = createDriftState('test');
      for (let i = 0; i < 5; i++) evaluateDrift(state, true, false, { warningEdits: 5 });
      // warningEdits=5이므로 5회에 warning
      expect(state.totalEdits).toBe(5);
    });

    it('edit 아닌 호출에서는 카운터 증가 안 함', () => {
      const state = createDriftState('test');
      evaluateDrift(state, false, false);
      expect(state.totalEdits).toBe(0);
      expect(state.totalReverts).toBe(0);
    });
  });
});
