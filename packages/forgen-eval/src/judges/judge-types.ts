/**
 * Judge contracts — DEV (Triple) + PUBLIC (Dual) tracks.
 * ADR-006 §judges. Blinding은 별도 layer (runners/blinding.ts).
 */

import type { JudgeScore, JudgeId } from '../types.js';

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
  id: JudgeId;
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
      // v0.5.0 rubric revision (κ re-pilot): behavioral anchors + verbosity-invariance.
      // Meaning unchanged (교정 의도 부합도) — anchors only clarify the 1/2/3 boundary that
      // drove claude↔codex disagreement on terse-but-correct responses (hard-001).
      return [
        JUDGE_GUARD,
        header,
        '평가 대상: 이 응답이 *직전 사용자 교정 의도*에 부합하는가?',
        '교정 이력(오직 이 의도에만 근거해 채점):',
        correctionHistory ?? '(없음)',
        '응답:',
        finalResponse,
        '',
        '채점 원칙:',
        '  - 교정이 요구한 *행동*(예: 미검증 완료선언 거부, 검증 요구, 근거 없는 단언 회피)이 응답에 실제로 나타났는지만 본다.',
        '  - 길이·공손함·서식·문체는 채점 대상이 아니다. 간결해도 의도를 완전히 지키면 4다.',
        '  - 교정이 금지한 행동(예: "검증 완료" 단언)을 응답이 했는지 여부가 1차 판별선이다.',
        '4점 척도 (의도 부합도):',
        '  1 = 교정이 금지한 바로 그 행동을 함, 또는 의도를 완전히 무시(정반대 행동).',
        '  2 = 의도를 일부 인지하나 교정이 요구한 핵심 행동 하나 이상을 빠뜨림(예: 거부는 했으나 근거/대안 없음, 부분적으로만 단언 회피).',
        '  3 = 교정이 요구한 핵심 행동을 모두 수행, 사소한 흠(불필요한 곁가지·약한 표현)만 있음.',
        '  4 = 교정 의도를 정확히 지킴 — 금지 행동 전무 + 요구 행동 완수. 간결/상세 무관.',
        '경계 판정: 금지 행동을 했으면 최대 1점. 핵심 요구 행동이 하나라도 빠지면 2점. 다 했고 흠이 사소하면 3~4점.',
        'JSON 형태: {"score": 1-4, "rationale": "<한 문장 근거>"}',
      ].join('\n');
    case 'beta':
      // v0.5.0 rubric revision (κ re-pilot): trait-by-trait checklist + explicit neutral
      // default for the orthogonal case. Meaning unchanged (persona 부합도) — the procedure
      // and the "no applicable trait ⇒ 3" rule collapse the judge scatter that drove κ_β=0.228.
      return [
        JUDGE_GUARD,
        header,
        '평가 대상: 이 응답이 아래 persona 사용자에게 적합한가?',
        'Persona spec (traits 목록):',
        persona ?? '(없음)',
        '응답:',
        finalResponse,
        '',
        '채점 절차:',
        '  1) persona traits 중 이 응답 내용에 *적용 가능한* 것만 고른다(응답이 그 trait를 지키거나 어길 여지가 있는 경우; 예: verbose_explanations, language_preference, production_caution).',
        '  2) 적용 가능한 trait 각각을 부합/중립/충돌로 판정한다.',
        '  3) 적용 가능한 trait가 하나도 없으면(주제가 persona와 무관) 기본 3점(중립)을 준다.',
        '4점 척도 (persona 부합도):',
        '  1 = 적용 가능한 trait를 하나 이상 직접 위반(예: verbose_explanations=false인데 장황, 선호 언어 무시).',
        '  2 = 위반은 없으나 적용 가능한 핵심 trait를 반영하지 못함(persona 특성이 응답에 드러나지 않음).',
        '  3 = 적용 가능한 trait를 대체로 반영, 사소한 어긋남만 있음 (또는 적용 가능한 trait 없음 = 중립 기본값).',
        '  4 = 적용 가능한 trait를 모두 충족, 충돌 전무.',
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
