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
  id: 'sonnet' | 'qwen-72b' | 'llama-70b' | 'qwen-14b' | 'llama-8b' | 'claude-cli' | 'codex-cli';
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

/**
 * Judge material char cap. claude-cli judge 는 prompt 를 CLI arg 로 받아 OS exec
 * 한계 (E2BIG, ~256KB POSIX) 에 걸림. codex-cli judge 는 stdin pipe 적용 (commit
 * e42bff6) 후에도 codex 내부 1MB API 한계 존재. driver 가 가끔 50K+ chars 응답을
 * 생성하면 양쪽 judge 가 fail → fallback 2.5 (judge 결과 무효화).
 *
 * 32K chars (~8K tokens) 는 judge 가 응답 품질을 평가하기에 충분 (대부분 응답이
 * 5K 이내, outlier 만 truncated). persona / history 도 같이 cap.
 */
const MAX_JUDGE_RESPONSE_CHARS = 32_000;
const MAX_JUDGE_PERSONA_CHARS = 8_000;
const MAX_JUDGE_HISTORY_CHARS = 8_000;

function capForJudge(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... truncated ${text.length - max} chars to fit judge prompt budget ...]`;
}

/** Builds the prompt template for an axis — same template across judges (fairness). */
export function buildJudgePrompt(input: JudgePromptInput): string {
  const { axis, material } = input;
  const header = `[BLINDED EVALUATION — case=${input.caseId} arm=${input.blindedArmId}]`;
  // outlier-length material 만 truncate — 평가 품질에 영향 거의 없음 (judge 는
  // 보통 응답 시작 ~몇 KB 만 봐도 충분), judge transport fail 회피가 우선.
  const finalResponse = capForJudge(material.finalResponse, MAX_JUDGE_RESPONSE_CHARS);
  const persona = material.persona ? capForJudge(material.persona, MAX_JUDGE_PERSONA_CHARS) : undefined;
  const correctionHistory = material.correctionHistory
    ? capForJudge(material.correctionHistory, MAX_JUDGE_HISTORY_CHARS)
    : undefined;
  switch (axis) {
    case 'gamma':
      return [
        JUDGE_GUARD,
        header,
        '평가 대상: 이 응답이 *직전 사용자 교정 의도*에 부합하는가?',
        '교정 이력:',
        correctionHistory ?? '(없음)',
        '응답:',
        finalResponse,
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
        persona ?? '(없음)',
        '응답:',
        finalResponse,
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
        finalResponse,
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
