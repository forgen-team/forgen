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
 * 순수 판정 — text 안에 아직 참조 안 된 솔루션의 name / 고유 식별자 / 희귀 태그
 * 조합이 등장하면 수집.
 *
 * v0.4.1 초기: name (slug kebab-case) literal 만 매칭 → Claude 가 content 만 인용
 *   하고 slug 를 안 쓰면 측정 불가.
 * v0.4.1 확장 (2026-04-24): identifier (함수/파일명 literal, >=4자) 또는 **복합
 *   태그 2개 동시 등장** 도 weak reference 로 인정. false-positive 완화 위해:
 *     - identifier 는 길이 ≥4
 *     - tag 는 **복합 슬러그 (`-` 또는 `_` 포함)** 만 허용 + length ≥6
 *       → "tdd", "test", "workflow" 같은 일반 태그 단독 매칭은 제외
 *     - tag 매칭은 최소 2개 교차
 */
export function detectRecallReferences(
  text: string,
  injected: readonly InjectedSolutionEntry[],
): RecallReferenceDetection {
  if (!text || injected.length === 0) return { newlyReferenced: [] };

  const newlyReferenced: string[] = [];
  for (const sol of injected) {
    if (sol._referenced) continue;
    if (!sol.name || sol.name.length < 4) continue;

    let matched = false;

    // 1순위: slug name 정확 매칭 (precision 최고)
    if (text.includes(sol.name)) {
      matched = true;
    }

    // 2순위: 고유 identifier (함수/파일명 literal) 매칭
    if (!matched && sol.identifiers) {
      for (const id of sol.identifiers) {
        if (typeof id === 'string' && id.length >= 4 && text.includes(id)) {
          matched = true;
          break;
        }
      }
    }

    // 3순위: 복합-슬러그 태그 2개 이상 동시 등장 (일반 단어 단독은 제외)
    if (!matched && sol.tags) {
      const specificTags = sol.tags.filter(
        (t) => typeof t === 'string' && t.length >= 6 && (t.includes('-') || t.includes('_')),
      );
      const hits = specificTags.filter((t) => text.includes(t));
      if (hits.length >= 2) matched = true;
    }

    if (matched) newlyReferenced.push(sol.name);
  }
  return { newlyReferenced };
}
