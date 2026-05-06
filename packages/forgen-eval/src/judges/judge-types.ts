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
  id: 'sonnet' | 'qwen-72b' | 'llama-70b' | 'claude-cli' | 'codex-cli';
  /** Returns a 1-4 likert + rationale. Throws on transport failure. */
  judge(input: JudgePromptInput): Promise<JudgeScore>;
  /** Health check before run start. */
  ping(): Promise<{ ok: boolean; latencyMs: number; modelInfo?: string }>;
}

/** Minimal guard for CLI judges. Empirically: verbose anti-tool prefixes (mentioning
 *  Read/Bash/Grep/Glob) confuse codex CLI into "tool review mode" and hang the call.
 *  Single-line guard works reliably across both claude-cli and codex-cli.
 */
const JUDGE_GUARD = 'Reply with ONLY a JSON object — no prose, no tools, no file access.\n';

/** Builds the prompt template for an axis — same template across judges (fairness). */
export function buildJudgePrompt(input: JudgePromptInput): string {
  const { axis, material } = input;
  const header = `[BLINDED EVALUATION — case=${input.caseId} arm=${input.blindedArmId}]`;
  switch (axis) {
    case 'gamma':
      return [
        JUDGE_GUARD,
        header,
        '평가 대상: 이 응답이 *직전 사용자 교정 의도*에 부합하는가?',
        '교정 이력:',
        material.correctionHistory ?? '(없음)',
        '응답:',
        material.finalResponse,
        '4점 척도 (의도 부합도):',
        '  1 = 교정 의도 완전 무시 또는 정반대 행동',
        '  2 = 의도 인지 흔적 있으나 핵심 요구 누락',
        '  3 = 의도 대체로 반영, 사소한 결함',
        '  4 = 의도와 완전히 부합',
        'JSON 형태: {"score": 1-4, "rationale": "<한 문장 근거>"}',
      ].join('\n');
    case 'beta':
      return [
        JUDGE_GUARD,
        header,
        '평가 대상: 이 응답이 아래 persona의 사용자에게 적합한가?',
        'Persona spec:',
        material.persona ?? '(없음)',
        '응답:',
        material.finalResponse,
        '4점 척도 (persona 부합도):',
        '  1 = persona traits/도메인과 명백히 충돌',
        '  2 = 일부 고려하나 핵심 traits 무시',
        '  3 = 대체로 적합, 사소한 어긋남',
        '  4 = persona traits 완전 부합',
        'JSON 형태: {"score": 1-4, "rationale": "<한 문장 근거>"}',
      ].join('\n');
    case 'phi':
      return [
        JUDGE_GUARD,
        header,
        '평가 대상: 시스템이 사용자의 행동을 차단/수정한 것이 합리적이었나?',
        '차단/주입 이벤트:',
        JSON.stringify(material.blockOrInjectEvent ?? {}),
        '응답 (차단 후 결과):',
        material.finalResponse,
        '4점 척도 (차단 합리성):',
        '  1 = 명백히 false-positive (정상 동작을 부당 차단)',
        '  2 = 차단 명분 약함 (과도하거나 빗나감)',
        '  3 = 차단 대체로 합리적, 소소한 의문점',
        '  4 = 명백히 합리적 차단 (실제 위험/규칙 위반)',
        'JSON 형태: {"score": 1-4, "rationale": "<한 문장 근거>"}',
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
