/**
 * 솔루션의 프로젝트 범위 (D5). 룰의 rule-scope 와 같은 규칙:
 *  - 프로젝트 안: 전역(projects 없음) + 그 프로젝트 솔루션만. 다른 프로젝트 것은 제외하고, 같은 프로젝트 것은 가중치를 더한다.
 *  - 프로젝트 밖: 어떤 작업인지 모르니 제외하지 않고 가중치만 낮춘다.
 */
export const PROJECT_MATCH_WEIGHT = 1.15;
export const PROJECT_OUTSIDE_WEIGHT = 0.85;

/** 이 솔루션이 주어진 프로젝트 컨텍스트에서 후보가 될 수 있는가. */
export function solutionInScope(projects: readonly string[] | undefined, projectKey: string | null): boolean {
  if (!projects?.length || projectKey === null) return true;
  return projects.includes(projectKey);
}

/** relevance 에 곱할 가중치. 전역 솔루션은 1. */
export function solutionProjectWeight(projects: readonly string[] | undefined, projectKey: string | null): number {
  if (!projects?.length) return 1;
  return projectKey === null ? PROJECT_OUTSIDE_WEIGHT : PROJECT_MATCH_WEIGHT;
}
