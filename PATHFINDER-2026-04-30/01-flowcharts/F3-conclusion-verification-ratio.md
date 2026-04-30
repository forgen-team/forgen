# F3: conclusion-verification-ratio

```mermaid
flowchart TD
  A[lastMessage<br/>stop-guard.ts:516] --> B[checkConclusionVerificationRatio<br/>conclusion-verification-ratio.ts:79]
  B --> C[countMatches CONCLUSION_PATTERNS<br/>conclusion-verification-ratio.ts:83]
  B --> D[countMatches VERIFICATION_PATTERNS<br/>conclusion-verification-ratio.ts:84]
  C --> E[total = c + v<br/>conclusion-verification-ratio.ts:85]
  D --> E
  E --> F{total < minTotal?<br/>conclusion-verification-ratio.ts:92}
  F -->|sparse| J[pass]
  F -->|enough| G[ratio = c / v<br/>conclusion-verification-ratio.ts:87]
  G --> H{ratio > threshold?<br/>conclusion-verification-ratio.ts:107}
  H -->|yes| I[block + reason<br/>stop-guard.ts:553]
  H -->|no| J
```

**Regex source**: `CONCLUSION_PATTERNS` 19-30, `VERIFICATION_PATTERNS` 33-46.

**측정 도구 세트 미사용** — 텍스트 내부 카운트만 사용. recentTools 무관.

**External deps**: `stop-guard.ts:552` 호출.
