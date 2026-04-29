/**
 * Judge contracts — DEV (Triple) + PUBLIC (Dual) tracks.
 * ADR-006 §judges. Blinding은 별도 layer (runners/blinding.ts).
 */

import type { JudgeScore } from '../types.js';

export type JudgeAxis = 'gamma' | 'beta' | 'phi';

export interface JudgePromptInput {
  caseId: string;
  blindedArmId: string; // arm ID는 익명화 후 전달 (편향 회피)
  axis: JudgeAxis;
  /** Material the judge sees — varies by axis. */
  material: {
    persona?: string; // β: persona spec
    correctionHistory?: string; // γ: prior turns
    finalResponse: string; // 모든 axis에서 평가 대상
    blockOrInjectEvent?: { ruleId: string; reason: string }; // φ: 차단/주입 합리성
  };
}

export interface JudgeClient {
  id: 'sonnet' | 'qwen-72b' | 'llama-70b';
  /** Returns a 1-4 likert + rationale. Throws on transport failure. */
  judge(input: JudgePromptInput): Promise<JudgeScore>;
  /** Health check before run start. */
  ping(): Promise<{ ok: boolean; latencyMs: number; modelInfo?: string }>;
}

/** Builds the prompt template for an axis — same template across judges (fairness). */
export function buildJudgePrompt(input: JudgePromptInput): string {
  const { axis, material } = input;
  const header = `[BLINDED EVALUATION — case=${input.caseId} arm=${input.blindedArmId}]`;
  switch (axis) {
    case 'gamma':
      return [
        header,
        '평가 대상: 이 응답이 *직전 사용자 교정 의도*에 부합하는가?',
        '교정 이력:',
        material.correctionHistory ?? '(없음)',
        '응답:',
        material.finalResponse,
        '점수 (1=전혀 부합 안 함, 4=완전 부합), JSON 형태:',
        '{"score": 1-4, "rationale": "<한 문장 근거>"}',
      ].join('\n');
    case 'beta':
      return [
        header,
        '평가 대상: 이 응답이 아래 persona의 사용자에게 적합한가?',
        'Persona spec:',
        material.persona ?? '(없음)',
        '응답:',
        material.finalResponse,
        '점수 (1-4), JSON 형태: {"score": int, "rationale": "<문장>"}',
      ].join('\n');
    case 'phi':
      return [
        header,
        '평가 대상: 시스템이 사용자의 행동을 차단/수정한 것이 합리적이었나?',
        '차단/주입 이벤트:',
        JSON.stringify(material.blockOrInjectEvent ?? {}),
        '응답 (차단 후 결과):',
        material.finalResponse,
        '점수 (1=불합리/false-positive, 4=합리적), JSON 형태: {"score": int, "rationale": "<문장>"}',
      ].join('\n');
  }
}

/** Parse 1-4 + rationale from judge raw output. Robust to JSON noise. */
export function parseJudgeOutput(raw: string): { score: 1 | 2 | 3 | 4; rationale: string } {
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) throw new Error(`Judge output missing JSON: ${raw.slice(0, 100)}`);
  const obj = JSON.parse(jsonMatch[0]);
  const score = Number(obj.score);
  if (![1, 2, 3, 4].includes(score)) {
    throw new Error(`Judge score out of range [1-4]: ${score}`);
  }
  return { score: score as 1 | 2 | 3 | 4, rationale: String(obj.rationale ?? '') };
}
