import { describe, it, expect, beforeEach } from 'vitest';
import { parseJudgeOutput, resetJudgeParseTelemetry, judgeParseTelemetry } from '../src/judges/judge-types.js';

describe('parseJudgeOutput 견고화 (R2 measurement integrity)', () => {
  beforeEach(() => resetJudgeParseTelemetry());

  it('정상 JSON — fallback 없음', () => {
    expect(parseJudgeOutput('{"score": 4, "rationale": "ok"}')).toEqual({ score: 4, rationale: 'ok' });
    expect(judgeParseTelemetry()).toEqual({ fallback: 0, total: 1 });
  });

  it('rationale 에 중괄호 포함 — greedy 최외곽 파싱 (clean, no fallback)', () => {
    const out = '{"score": 3, "rationale": "use {foo} pattern and rollback"}';
    expect(parseJudgeOutput(out).score).toBe(3);
    expect(judgeParseTelemetry().fallback).toBe(0);
  });

  it('앞뒤 prose/펜스 섞임 — 여전히 score 추출', () => {
    const out = 'Here is my evaluation:\n```json\n{"score": 2, "rationale": "weak"}\n```\nDone.';
    expect(parseJudgeOutput(out).score).toBe(2);
  });

  it('잘린 출력(닫는 중괄호 없음) — regex 로 score 복구 + fallback 카운트', () => {
    const truncated = '{"score": 4, "rationale": "응답이 롤백 계획을 먼저 요구하고(rollback_plans_required), NOT NULL 컬럼 추가를 nullable→bac';
    expect(parseJudgeOutput(truncated).score).toBe(4);
    expect(judgeParseTelemetry()).toEqual({ fallback: 1, total: 1 });
  });

  it('SEV-2: prose 앵커 vs 말미 verdict — 마지막 매칭(verdict)을 취함', () => {
    // 앞쪽 rubric prose "score: 2 anchor" 가 아니라 잘린 JSON 의 verdict 4 를 취해야.
    const out = 'the score: 2 anchor means partial credit... {"score": 4, "rationa';
    expect(parseJudgeOutput(out).score).toBe(4);
  });

  it('SEV-2: rubric 템플릿 에코 {"score": 1-4} → 1 로 오인 금지 → throw', () => {
    // `1-4` 는 판정이 아니라 범위 표기 — lookahead 로 거부. (예전 버그: 1 로 강제)
    expect(() => parseJudgeOutput('{"score": 1-4, "rationale": "<한 문장 근거>"}')).toThrow(/unparseable/);
  });

  it('소수 점수 3.5 → 거부(throw), 1로 오인 안 함', () => {
    expect(() => parseJudgeOutput('{"score": 3.5}')).toThrow(/unparseable/);
  });

  it('score 뒤에 rationale, rationale 에 중괄호 — clean 파싱', () => {
    const out = '{"rationale": "prefer {early return}", "score": 1}';
    expect(parseJudgeOutput(out).score).toBe(1);
  });

  it('score 정말 없음 → throw', () => {
    expect(() => parseJudgeOutput('no score here at all')).toThrow(/unparseable/);
  });

  it('범위 밖 숫자만 → throw', () => {
    expect(() => parseJudgeOutput('{"score": 9}')).toThrow(/unparseable/);
  });
});
