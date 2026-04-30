# F2: fact-vs-agreement

```mermaid
flowchart TD
  A[lastMessage<br/>stop-guard.ts:516] --> B[checkFactVsAgreement<br/>fact-vs-agreement.ts:98]
  B --> C[findMatches FACT_ASSERTION_PATTERNS<br/>fact-vs-agreement.ts:102]
  B --> D[findMatches AGREEMENT_SOFTENERS<br/>fact-vs-agreement.ts:103]
  B --> E[recentTools.filter MEASUREMENT_TOOL_CATEGORIES<br/>fact-vs-agreement.ts:105]
  C --> F{factAssertions > 0?<br/>fact-vs-agreement.ts:107}
  E --> G{measurementCount < min?<br/>fact-vs-agreement.ts:108}
  F -->|yes| H{alert?<br/>fact-vs-agreement.ts:110}
  G -->|yes| H
  H -->|both| I[alert=true + reason<br/>stop-guard.ts:572 records 'correction']
  H -->|either no| J[alert=false]
```

**Regex source**: `FACT_ASSERTION_PATTERNS` 32-43, `AGREEMENT_SOFTENERS` 46-52.

**측정 도구 세트**: `MEASUREMENT_TOOL_CATEGORIES = Set(['Bash', 'NotebookEdit'])` (line 26-29) — **F1과 정확히 동일한 Set**, 변수명만 다름.

**External deps**: `stop-guard.ts:572` 호출. design intent는 alert-only 인데 현재 wiring은 `kind:'correction'`로 violations.jsonl 기록만.
