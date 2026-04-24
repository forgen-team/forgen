/**
 * Forgen v0.4.1 — Recall Reference Detector (H4 완결)
 *
 * US-06 에서 `recommendation_surfaced` (주입 = Claude 컨텍스트에 보여졌다) 는
 * emit 경로가 있지만, `recall_referenced` (Claude 가 실제로 참조/인용했다) 는
 * enum 만 정의되고 emit 경로가 없었다. 이 결함 때문에 "채널은 뚫렸지만 활용은
 * 측정 불가" 상태. 이 모듈이 그 측정 경로를 닫는다.
 *
 * 알고리즘:
 *   1. Stop hook 에서 lastAssistantMessage 를 읽는다.
 *   2. 현재 세션의 injection-cache 에서 최근 주입된 솔루션 목록을 가져온다.
 *   3. 각 솔루션의 **name** 이 메시지 텍스트에 등장하면 참조한 것으로 간주.
 *      (tag 매칭은 false-positive 과다 — "협업" 같은 흔한 단어로 오매칭.)
 *   4. 중복 emit 방지: injection-cache 엔트리에 `_referenced: true` 플래그 세팅.
 *
 * 순수 함수 설계 — Stop hook 이 inject-cache 를 읽고 쓰는 I/O 는 호출지에서.
 */

export interface InjectedSolutionEntry {
  name: string;
  identifiers?: string[];
  tags?: string[];
  status?: string;
  injectedAt?: string;
  _referenced?: boolean;
}

export interface RecallReferenceDetection {
  /** 이번 턴에 처음 참조가 감지된 솔루션 이름 목록. */
  newlyReferenced: string[];
}

/**
 * 순수 판정 — text 안에 아직 참조 안 된 솔루션의 name 이 literal 로 등장하면 수집.
 * name 은 slug 형식 (kebab-case) 이라 일반 텍스트에서 우연히 매칭될 확률 낮음
 * (예: "retro-v040-collab-gap" 은 흔하지 않은 토큰).
 */
export function detectRecallReferences(
  text: string,
  injected: readonly InjectedSolutionEntry[],
): RecallReferenceDetection {
  if (!text || injected.length === 0) return { newlyReferenced: [] };

  const newlyReferenced: string[] = [];
  for (const sol of injected) {
    if (sol._referenced) continue;
    if (!sol.name || sol.name.length < 4) continue; // 너무 짧은 이름은 제외 (오매칭 방지)
    // slug 그대로 매칭 — 복합 단어라 일반 텍스트에서 우연 매칭 거의 없음.
    if (text.includes(sol.name)) {
      newlyReferenced.push(sol.name);
    }
  }
  return { newlyReferenced };
}
