/**
 * relevance-gate — TF-IDF/BM25/bigram relevance 매칭의 *정준* 게이트 임계(단일 소스).
 *
 * 2026-04-21 gate sweep(100% precision/60% recall 데이터)로 실측 튜닝된 값. 동일한
 * relevance-scorer 표현을 쓰는 소비자들이 이 상수 하나를 공유한다:
 *   - solution 주입 게이트 (solution-injector.MIN_INJECT_RELEVANCE)
 *   - 교정 클러스터링 편입 임계 (correction-clustering.CLUSTER_SIMILARITY_TAU)
 *
 * W3-2 리뷰(SEV-3 #1): 이전엔 각 소비자가 리터럴 0.3 을 복제해 "상속"이 주석뿐이었다.
 * 여기로 단일화해 한쪽만 바뀌는 근거-정직성 드리프트를 코드로 방지한다.
 */
export const RELEVANCE_MATCH_GATE = 0.3;
