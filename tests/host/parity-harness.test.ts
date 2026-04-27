/**
 * BehavioralParityScenario harness — Multi-Host Core Design §10 우선순위 4 단위 테스트
 *
 * P4 골격 검증: corpus 의 모든 시나리오가 사영 후 Claude ≡ Codex 의미 동치임을 보장한다.
 * 이 invariant 가 깨지면 사영(projection) 또는 corpus 의 입력 가정에 회귀가 발생한 것.
 */

import { describe, expect, it } from 'vitest';
import { SCENARIO_CORPUS, runScenario } from '../../src/host/parity-harness.js';

describe('BehavioralParityScenario corpus — 사영 후 Claude ≡ Codex', () => {
  it('corpus 가 비어있지 않다', () => {
    expect(SCENARIO_CORPUS.length).toBeGreaterThan(0);
  });

  it.each(SCENARIO_CORPUS)('$id ($intent): $description', (scenario) => {
    const result = runScenario(scenario);
    if (!result.passed) {
      // 디버깅 가독성용 — 실패 시 어떤 키가 어떻게 다른지 명시.
      const summary = result.diffs
        .map((d) => `  ${d.key}: claude=${JSON.stringify(d.claude)}  codex=${JSON.stringify(d.codex)}`)
        .join('\n');
      throw new Error(`Parity 깨짐: ${scenario.id}\n${summary}`);
    }
    expect(result.passed).toBe(true);
    expect(result.diffs).toEqual([]);
  });
});
