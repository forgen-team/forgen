/**
 * Behavior Classifier — D1'' (2026-04-27)
 *
 * LLM 이 추출한 사용자 패턴을 5개 kind 로 분류하고 4축 axis_refs 로 매핑한다.
 *
 * 결함 history:
 *   v0.4.1 까지: kind 3분기(workflow/thinking/preference) → axis 2축
 *     (judgment_philosophy / communication_style) 만 자동 추출 가능.
 *     quality_safety / autonomy 축은 explicit_correction 16건 (Hooks 경로) 으로만
 *     자라고, 자동 학습 600+ 건은 이 두 축에 0% 기여 — 측정 자기증거.
 *
 *   v0.4.2: 5분기 [품질안전] / [자율성] 추가 → 4축 모두 cover.
 *     LLM prompt (auto-compound-runner) 에도 같은 라벨 가이드를 명시하여
 *     형식 강제. 새 라벨이 안 나오면 기존 5분기로 fallback (호환).
 */

export type BehaviorKind = 'safety' | 'autonomy' | 'workflow' | 'thinking' | 'preference';

const AXIS_REFS_BY_KIND: Readonly<Record<BehaviorKind, readonly string[]>> = {
  safety: ['quality_safety'],
  autonomy: ['autonomy'],
  workflow: ['judgment_philosophy'],
  thinking: ['judgment_philosophy'],
  preference: ['communication_style'],
};

/**
 * LLM 출력 텍스트(`[카테고리] 설명` 형식)를 5개 kind 로 분류.
 *
 * 라벨 우선순위 (위에서 아래):
 *   1. [품질안전] → safety
 *   2. [자율성] → autonomy
 *   3. [워크플로우] OR "순서"/"→" 토큰 → workflow
 *   4. [의사결정] → thinking
 *   5. 그 외 → preference (default)
 */
export function classifyBehaviorKind(text: string): BehaviorKind {
  if (text.includes('[품질안전]')) return 'safety';
  if (text.includes('[자율성]')) return 'autonomy';
  if (text.includes('[워크플로우]') || text.includes('순서') || text.includes('→')) return 'workflow';
  if (text.includes('[의사결정]')) return 'thinking';
  return 'preference';
}

export function mapKindToAxisRefs(kind: BehaviorKind): string[] {
  return [...AXIS_REFS_BY_KIND[kind]];
}
