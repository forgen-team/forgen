/**
 * TEST-4 / RC4: behavior_observation 빈필드 거부.
 *
 * Regression: 2026-04-23 — ~/.forgen/me/behavior/*.json 다수에 summary="" 가
 * 누적되어 학습 데이터가 분석 불가능. saveEvidence 가 type='behavior_observation'
 * 이고 summary 가 20자 미만이면 저장 거부.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/hooks/shared/atomic-write.js', () => ({
  atomicWriteJSON: vi.fn(),
  safeReadJSON: vi.fn().mockReturnValue(null),
}));

function makeEvidence(type: string, summary: string) {
  return {
    evidence_id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    session_id: 'test-session',
    timestamp: new Date().toISOString(),
    source_component: 'test',
    summary,
    axis_refs: [],
    candidate_rule_refs: [],
    confidence: 0.6,
    raw_payload: {},
  };
}

describe('saveEvidence — behavior_observation guard (TEST-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects empty summary for behavior_observation', async () => {
    const { atomicWriteJSON } = await import('../src/hooks/shared/atomic-write.js');
    const { saveEvidence } = await import('../src/store/evidence-store.js');
    saveEvidence(makeEvidence('behavior_observation', '') as never);
    expect(atomicWriteJSON).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only summary', async () => {
    const { atomicWriteJSON } = await import('../src/hooks/shared/atomic-write.js');
    const { saveEvidence } = await import('../src/store/evidence-store.js');
    saveEvidence(makeEvidence('behavior_observation', '   \n\t  ') as never);
    expect(atomicWriteJSON).not.toHaveBeenCalled();
  });

  it('rejects summary shorter than 20 chars', async () => {
    const { atomicWriteJSON } = await import('../src/hooks/shared/atomic-write.js');
    const { saveEvidence } = await import('../src/store/evidence-store.js');
    saveEvidence(makeEvidence('behavior_observation', 'too short') as never);
    expect(atomicWriteJSON).not.toHaveBeenCalled();
  });

  it('accepts summary >= 20 chars', async () => {
    const { atomicWriteJSON } = await import('../src/hooks/shared/atomic-write.js');
    const { saveEvidence } = await import('../src/store/evidence-store.js');
    const valid = makeEvidence(
      'behavior_observation',
      '사용자가 측정 전에 합의를 사실로 변환하는 패턴 관찰됨',
    );
    saveEvidence(valid as never);
    expect(atomicWriteJSON).toHaveBeenCalledTimes(1);
  });

  it('does NOT reject other evidence types with short summary (backward compat)', async () => {
    const { atomicWriteJSON } = await import('../src/hooks/shared/atomic-write.js');
    const { saveEvidence } = await import('../src/store/evidence-store.js');
    saveEvidence(makeEvidence('explicit_correction', 'short') as never);
    saveEvidence(makeEvidence('session_summary', '') as never);
    expect(atomicWriteJSON).toHaveBeenCalledTimes(2);
  });
});
