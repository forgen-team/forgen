/**
 * TEST-1: 사실 vs 합의 가드.
 *
 * Claude 가 "통과했다 / 동작한다" 같은 사실 주장을 내놓을 때 해당 턴/세션에
 * 측정 도구 호출 (Bash test, Read, curl 등) 이 없으면 alert. v0.4.0 RC1 의
 * self-assessment 인플레이션 regression 을 사전에 차단.
 */
import { describe, it, expect } from 'vitest';
import { checkFactVsAgreement } from '../src/checks/fact-vs-agreement.js';

describe('checkFactVsAgreement — TEST-1', () => {
  it('no fact assertion → alert=false', () => {
    const r = checkFactVsAgreement({
      text: '파일을 읽고 계획을 세우고 있습니다. 질문이 있으시면 알려주세요.',
      recentTools: [],
    });
    expect(r.alert).toBe(false);
  });

  it('fact assertion + measurement tool → alert=false', () => {
    const r = checkFactVsAgreement({
      text: '전체 테스트가 통과했습니다. 빌드도 pass.',
      recentTools: ['Bash', 'Bash', 'Read'],
    });
    expect(r.alert).toBe(false);
    // v0.4.1: Read 는 측정 아님, Bash 2회만 count
    expect(r.measurementCount).toBe(2);
  });

  it('v0.4.1 coverage fix: Read/Edit/Write/Grep/Glob alone 은 사실 주장 근거 안 됨 → alert', () => {
    const r = checkFactVsAgreement({
      text: '검증됐습니다. 테스트 통과했습니다.',
      recentTools: ['Read', 'Read', 'Edit', 'Write', 'Grep', 'Glob'],
    });
    expect(r.alert).toBe(true);
    expect(r.measurementCount).toBe(0);
  });

  it('fact assertion + zero measurement → alert=true', () => {
    const r = checkFactVsAgreement({
      text: '검증 완료되었습니다. 모든 테스트가 pass.',
      recentTools: [],
    });
    expect(r.alert).toBe(true);
    expect(r.factAssertions.length).toBeGreaterThan(0);
    expect(r.reason).toMatch(/측정 도구 호출 0회/);
  });

  it('agreement softener included in reason when also alerting', () => {
    const r = checkFactVsAgreement({
      text: '이제 동작합니다. probably 다음 통합도 pass 할 겁니다.',
      recentTools: [],
    });
    expect(r.alert).toBe(true);
    expect(r.agreementSofteners.length).toBeGreaterThan(0);
    expect(r.reason).toContain('합의성 표현');
  });

  it('non-measurement tools (Agent) do NOT count as measurement', () => {
    const r = checkFactVsAgreement({
      text: '검증 완료. 통과했습니다.',
      recentTools: ['Agent', 'TaskCreate'],
    });
    expect(r.alert).toBe(true);
    expect(r.measurementCount).toBe(0);
  });

  it('minMeasurements threshold respected', () => {
    const r1 = checkFactVsAgreement({
      text: '통과했습니다.',
      recentTools: ['Bash'],
      minMeasurements: 2,
    });
    expect(r1.alert).toBe(true); // 1 < 2

    const r2 = checkFactVsAgreement({
      text: '통과했습니다.',
      recentTools: ['Bash', 'Bash'], // v0.4.1: Read 는 측정 아님, Bash 2개로 충족
      minMeasurements: 2,
    });
    expect(r2.alert).toBe(false); // 2 >= 2
  });

  it('english + korean mixed fact assertions both detected', () => {
    const r = checkFactVsAgreement({
      text: 'All tests passed. 검증 완료.',
      recentTools: [],
    });
    expect(r.alert).toBe(true);
    expect(r.factAssertions.length).toBeGreaterThanOrEqual(2);
  });

  it('empty text never alerts', () => {
    const r = checkFactVsAgreement({ text: '', recentTools: [] });
    expect(r.alert).toBe(false);
  });
});
