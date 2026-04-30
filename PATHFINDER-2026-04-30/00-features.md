# Feature Inventory

스코프: stop-guard 텍스트 분석 체크 3종 + wiring 1 + 보조 hotspot 2.

| # | Feature | Entry Point | Core Files | Purpose |
|---|---|---|---|---|
| F1 | self-score-inflation | `checkSelfScoreInflation` | `src/checks/self-score-deflation.ts` | 숫자 점수 상승 + 측정 0회 → block |
| F2 | fact-vs-agreement | `checkFactVsAgreement` | `src/checks/fact-vs-agreement.ts` | 사실-주장 키워드 + 측정 0회 → alert |
| F3 | conclusion-verification-ratio | `checkConclusionVerificationRatio` | `src/checks/conclusion-verification-ratio.ts` | 결론/검증 텍스트 비율 > 3 → block |
| F4 | stop-guard orchestration | `runStopGuard` | `src/hooks/stop-guard.ts:510+` | 3 체크 순차 호출 + violations 기록 |
| F5 | auto-compound-runner | `auto-compound-runner.ts` (617 LOC) | `src/core/auto-compound-runner.ts` | 솔루션 추출 + behavior merge (검토 보조) |
| F6 | cli dispatcher | `cli.ts` (567 LOC) | `src/cli.ts` | command routing (검토 보조) |

핵심 분석 대상: F1, F2, F3, F4. F5/F6는 핫스팟 중복 점검만.
