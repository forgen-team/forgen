# F1: self-score-inflation

```mermaid
flowchart TD
  A[lastMessage<br/>stop-guard.ts:516] --> B[checkSelfScoreInflation<br/>self-score-deflation.ts:101]
  B --> C[findScoreSignals<br/>self-score-deflation.ts:84]
  B --> D[extractDeltas<br/>self-score-deflation.ts:73]
  B --> E[recentTools.filter MEASUREMENT_TOOLS<br/>self-score-deflation.ts:108]
  C --> F{scoreSignals or deltas?<br/>self-score-deflation.ts:113}
  E --> G{measurementCount < min?<br/>self-score-deflation.ts:110}
  F -->|yes| H{block?<br/>self-score-deflation.ts:114}
  G -->|yes| H
  H -->|both| I[block + reason<br/>stop-guard.ts:535]
  H -->|either no| J[pass]
```

**Regex source**: `SELF_SCORE_PATTERNS` lines 47-55. Last pattern `\b\d+\s*\/\s*(10|100)\b` — **컨텍스트 미검사**.

**측정 도구 세트**: `MEASUREMENT_TOOLS = Set(['Bash', 'NotebookEdit'])` (line 32-34).

**External deps**: `stop-guard.ts:534` 호출, `loadRecentToolNames` 입력.
