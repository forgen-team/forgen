# Architecture Decision Records

forgen 의 중요한 아키텍처 결정을 기록합니다. 각 ADR 은 컨텍스트, 대안, 가중 트레이드오프 매트릭스, 결정, 결과를 포함합니다.

## 인덱스

| ID | 제목 | 상태 | 날짜 | Reversibility |
|----|------|------|------|---------------|
| [ADR-001](./ADR-001-mech-abc-enforcement-architecture.md) | Mech-A/B/C 3축 강제 메커니즘 아키텍처 | Proposed | 2026-04-22 | Type 1 |
| [ADR-002](./ADR-002-rule-lifecycle-engine.md) | Rule Lifecycle Engine (T1~T5 + Meta) | Proposed | 2026-04-22 | Type 1 |
| [ADR-003](./ADR-003-release-self-gate.md) | 릴리즈 Self-Gate | Proposed | 2026-04-22 | Type 2 |

## 상태 정의
- **Proposed**: 제안됨, 승인 대기
- **Accepted**: 채택, 구현 중/완료
- **Deprecated**: 폐기, 새 접근 없음
- **Superseded by ADR-{M}**: 다른 ADR 이 대체

## 의존 관계

```
Interview (Round 10)
      │
      ▼
  ADR-001 (Mech-A/B/C 스키마, enforce_via)
      │
      ├──▶ ADR-002 (lifecycle, Meta 재분류가 enforce_via 변경)
      │        │
      └────────┴──▶ ADR-003 (self-gate, 위 두 ADR 소비)
```

## 규칙
- 신규 ADR 번호는 순차 증가 (ADR-004, 005, ...)
- Superseded ADR 도 삭제하지 않음 — 역사 보존
- 모든 ADR 은 최소 2개 실질 대안(최소형 + 이상형 포함) 비교
- 가중 트레이드오프 매트릭스 가중치 합계 100%
- Type 1 (비가역) 결정에는 Reversal condition 필수
