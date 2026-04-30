# F4: stop-guard orchestration

```mermaid
flowchart TD
  A[stdin StopHookInput<br/>stop-guard.ts:515] --> B[readLastAssistantMessage<br/>stop-guard.ts:163]
  B --> C{FORGEN_USER_CONFIRMED=1?<br/>stop-guard.ts:528}
  C -->|yes| Z[skip 3 checks]
  C -->|no| D[loadRecentToolNames<br/>stop-guard.ts:533]
  D --> E[F1 checkSelfScoreInflation<br/>stop-guard.ts:534]
  E -->|block| EB[recordViolation+blockStop<br/>stop-guard.ts:535-547]
  E -->|pass| F[F3 checkConclusionVerificationRatio<br/>stop-guard.ts:552]
  F -->|block| FB[recordViolation+blockStop<br/>stop-guard.ts:553-565]
  F -->|pass| G[F2 checkFactVsAgreement<br/>stop-guard.ts:572]
  G -->|alert| GB[recordViolation kind=correction<br/>stop-guard.ts:573-580]
  G -->|pass| H[user-defined rules<br/>stop-guard.ts:584]
```

**중복 wiring 패턴**: 3 check 모두 동일한 5-단계 보일러플레이트
1. `checkXxx({text: lastMessage, ...})`
2. `if (result.block / alert)`
3. `recordViolation({rule_id, session_id, source, kind, message_preview})`
4. `reasonText = '[forgen:stop-guard/...] ${result.reason}\n\n(Override...)'`
5. `console.log(blockStop(reasonText, 'rule:TEST-X — ...'))`

각 체크가 동일한 reason format / override hint / violation record shape를 따로 손코딩.
