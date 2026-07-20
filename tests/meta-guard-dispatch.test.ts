import { describe, it, expect } from 'vitest';
import { runMetaGuards } from '../src/checks/_shared/meta-guard-dispatch.js';

/**
 * ADR-009 §2a: stop-guard 인라인 디스패처를 추출한 runMetaGuards 의 동작 박제.
 * 평가 순서·첫 block 단락·dangerous raw 입력·correction-only(TEST-1) 를 검증.
 */
describe('runMetaGuards (ADR-009 §2a)', () => {
  it('benign message with no signals → no results', () => {
    const r = runMetaGuards({ lastMessage: '파일 구조를 확인했습니다. 다음 단계를 제안합니다.', recentTools: ['Bash', 'Read'] });
    expect(r).toEqual([]);
  });

  it('dangerous rm -rf → first result is the dangerous guard (block) and short-circuits', () => {
    const r = runMetaGuards({ lastMessage: 'You can run `rm -rf node_modules` to clean.', recentTools: [] });
    expect(r.length).toBe(1);
    expect(r[0].shortId).toBe('dangerous-response-pattern');
    expect(r[0].kind).toBe('block');
  });

  it('dangerous guard uses RAW message (fires even inside code fence)', () => {
    const fenced = '```sh\nrm -rf /tmp/x\n```';
    const r = runMetaGuards({ lastMessage: fenced, recentTools: [] });
    expect(r.some(x => x.shortId === 'dangerous-response-pattern')).toBe(true);
  });

  it('self-score claim with zero measurement tools → TEST-2 block', () => {
    const r = runMetaGuards({ lastMessage: '이번 작업 신뢰도 90% 로 평가됩니다.', recentTools: [] });
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0].shortId).toBe('self-score-inflation');
    expect(r[0].kind).toBe('block');
  });

  it('same self-score text WITH measurement tools → no TEST-2 block', () => {
    const withTools = runMetaGuards({ lastMessage: '이번 작업 신뢰도 90% 로 평가됩니다.', recentTools: ['Bash', 'Bash', 'Read'] });
    expect(withTools.some(x => x.shortId === 'self-score-inflation')).toBe(false);
  });

  it('conclusion flood with no verification → TEST-3 block', () => {
    const r = runMetaGuards({ lastMessage: '통과했습니다. 완료됐습니다. pass. done. confirmed.', recentTools: [] });
    expect(r.some(x => x.shortId === 'conclusion-ratio' && x.kind === 'block')).toBe(true);
  });

  it('stops at first block — later guards not evaluated (dangerous wins over others)', () => {
    // dangerous + score + conclusion 모두 트리거할 만한 텍스트라도 첫 block(dangerous)만 반환.
    const r = runMetaGuards({
      lastMessage: 'run `rm -rf x`. 신뢰도 90%. 통과. 완료. pass. done. confirmed.',
      recentTools: [],
    });
    expect(r.length).toBe(1);
    expect(r[0].shortId).toBe('dangerous-response-pattern');
  });

  it('every result carries shortId/ruleSlug/kind/reason', () => {
    const r = runMetaGuards({ lastMessage: 'You can run `rm -rf node_modules`.', recentTools: [] });
    for (const x of r) {
      expect(typeof x.shortId).toBe('string');
      expect(typeof x.ruleSlug).toBe('string');
      expect(['block', 'correction']).toContain(x.kind);
      expect(typeof x.reason).toBe('string');
    }
  });
});

// ── W4-3 (ADR-010): per-model 완료-가드 모드 ──

describe('completionGuardMode=advise (W4-3)', () => {
  it('TEST-2 block 이 correction 으로 강등된다', () => {
    const r = runMetaGuards({
      lastMessage: '이번 작업 신뢰도 90% 로 평가됩니다.',
      recentTools: [],
      completionGuardMode: 'advise',
    });
    const test2 = r.find(x => x.shortId === 'self-score-inflation');
    expect(test2).toBeDefined();
    expect(test2?.kind).toBe('correction'); // 기록만 — 세션 차단 없음
  });

  it('DANGEROUS 는 advise 모드에서도 block 유지 (모델 무관 안전장치)', () => {
    const r = runMetaGuards({
      lastMessage: '정리를 위해 rm -rf ~/ 를 실행하세요.',
      recentTools: [],
      completionGuardMode: 'advise',
    });
    expect(r[0].shortId).toBe('dangerous-response-pattern');
    expect(r[0].kind).toBe('block');
  });

  it('기본(모드 미지정)은 현행 block 동작 그대로', () => {
    const r = runMetaGuards({ lastMessage: '이번 작업 신뢰도 90% 로 평가됩니다.', recentTools: [] });
    expect(r[0].kind).toBe('block');
  });
});

describe('advise 모드 기록 카디널리티 (리뷰 SEV-1)', () => {
  it('강등돼도 원래-block 지점에서 중단 — 턴당 기록 수가 block 모드와 동일', () => {
    // TEST-2(self-score)와 TEST-3(conclusion flood)를 동시에 트리거하는 텍스트
    const msg = '이번 작업 신뢰도 90% 로 평가됩니다. 통과했습니다. 완료됐습니다. pass. done. confirmed.';
    const blockMode = runMetaGuards({ lastMessage: msg, recentTools: [] });
    const adviseMode = runMetaGuards({ lastMessage: msg, recentTools: [], completionGuardMode: 'advise' });
    // block 모드: TEST-2 에서 중단 → 1건. advise 모드도 동일 지점에서 중단해야 한다
    // (계속 돌면 violations_30d 가 2-3배로 불어 lifecycle T2 트리거 조기 발화 — SEV-1)
    expect(blockMode).toHaveLength(1);
    expect(adviseMode).toHaveLength(1);
    expect(adviseMode[0].shortId).toBe(blockMode[0].shortId);
    expect(adviseMode[0].kind).toBe('correction');
  });
});
