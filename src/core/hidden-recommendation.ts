/**
 * 추천 숨김 표본 (0.9.0, 오너 결정: 되돌릴 수 있는 질문 5번에 1번은 추천 없이 묻는다).
 *
 * 목적: 결정 원장의 "추천 그대로 고른 비율"이 닻 효과(추천이라 써 있어서 고름)인지, 정말 판단이 맞은 것인지
 * 가르려면 추천을 숨긴 질문에서도 같은 답이 나오는지 봐야 한다(계획 2026-11-25-v1.0 §11, N6 ⓑ).
 *
 * 동작(Claude Code 2.1.332 대화형 세션에서 확인): AskUserQuestion PreToolUse 에서 `updatedInput` 으로
 * 추천 표시를 떼고 순서를 섞고 머리말을 HIDDEN_HEADER 로 바꾼다. **permissionDecision 을 주지 않는다** —
 * 'allow' 를 주면 질문 화면을 건너뛰고 답 없이 닫힌다(실측).
 * 원래 추천은 대화 기록의 tool_use 입력(모델이 쓴 원본)에 남고, 실제로 보인 질문은 toolUseResult 에 남는다.
 * 결정 원장은 둘을 맞대어 기록한다(decision-ledger.ts).
 *
 * 고르는 규칙(결정적): hash(tool_use_id + 질문 순서) mod 5 == 0, 단일 선택, 추천 표시가 정확히 1개,
 * 되돌리기 어려운 낱말(배포·푸시·삭제 등)이 질문·선택지·설명에 없음. FORGEN_HIDDEN_SAMPLE=0 이면 끄고,
 * =always 면 조건을 만족하는 모든 질문을 고른다(검증용).
 */
import { createHash } from 'node:crypto';

export const HIDDEN_HEADER = '숨김표본';
export const HIDDEN_RATE = 5;
const REC_MARK = /\s*\((추천|recommended)\)\s*/gi;
const REC_TEST = /\((추천|recommended)\)/i;
/** 되돌리기 어려운 결정 — 이런 질문에서는 추천을 숨기지 않는다. */
const IRREVERSIBLE = /배포|푸시|머지|병합|삭제|지우|결제|발송|전송|공개|출시|릴리스|태그|publish|deploy|push|merge|delete|remove|drop|pay|send|release|tag\b|force|reset|rm\s/i;

interface Option { label: string; description?: string; [k: string]: unknown }
interface Question { question: string; header?: string; options?: Option[]; multiSelect?: boolean; [k: string]: unknown }

function h(s: string): number {
  return createHash('sha256').update(s).digest().readUInt32BE(0);
}

export function isSampled(toolUseId: string, index: number): boolean {
  return h(`${toolUseId}#${index}`) % HIDDEN_RATE === 0;
}

export function eligible(q: Question): boolean {
  if (q.multiSelect) return false;
  const opts = Array.isArray(q.options) ? q.options : [];
  if (opts.length < 2) return false;
  if (opts.filter((o) => typeof o?.label === 'string' && REC_TEST.test(o.label)).length !== 1) return false;
  const text = [q.question, q.header ?? '', ...opts.flatMap((o) => [o.label, o.description ?? ''])].join('\n');
  return !IRREVERSIBLE.test(text);
}

/** 순서를 결정적으로 섞는다(원래 순서와 같으면 한 칸 돌린다 — 추천이 늘 첫째인 버릇을 지운다). */
function shuffle<T>(arr: T[], seed: string): T[] {
  const keyed = arr.map((v, i) => ({ v, k: h(`${seed}:${i}`) })).sort((a, b) => a.k - b.k).map((x) => x.v);
  if (keyed.every((v, i) => v === arr[i]) && arr.length > 1) keyed.push(keyed.shift() as T);
  return keyed;
}

export interface HideResult { input: Record<string, unknown>; hidden: number[] }

/**
 * 뽑힌 질문의 추천을 숨긴 입력을 돌려준다. 바꿀 것이 없으면 null.
 * tool_use_id 가 없으면 고르지 않는다(결정성의 근거가 없다).
 */
export function hideRecommendations(toolInput: unknown, toolUseId: string | undefined, env: NodeJS.ProcessEnv = process.env): HideResult | null {
  if (!toolUseId || env.FORGEN_HIDDEN_SAMPLE === '0') return null;
  const qs = (toolInput as { questions?: unknown })?.questions;
  if (!Array.isArray(qs)) return null;
  const hidden: number[] = [];
  const next = qs.map((raw, i) => {
    const q = raw as Question;
    if (!q || typeof q.question !== 'string' || !eligible(q) || (env.FORGEN_HIDDEN_SAMPLE !== 'always' && !isSampled(toolUseId, i))) return raw;
    hidden.push(i);
    const options = shuffle((q.options as Option[]).map((o) => ({ ...o, label: o.label.replace(REC_MARK, ' ').trim() })), `${toolUseId}#${i}`);
    return { ...q, header: HIDDEN_HEADER, options };
  });
  if (hidden.length === 0) return null;
  return { input: { ...(toolInput as Record<string, unknown>), questions: next }, hidden };
}

/** 원래 라벨에서 추천 표시를 뗀 이름(원장이 숨긴 추천과 답을 비교할 때). */
export function stripRecommendation(label: string): string {
  return label.replace(REC_MARK, ' ').trim();
}
