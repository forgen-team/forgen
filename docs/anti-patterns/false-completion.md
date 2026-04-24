# Anti-Pattern: False Completion

**RC2 — 자가 평가 인플레이션.** 어시스턴트가 "완료 / ready / ambiguity 0.15 / 100% pass" 같은 메타 점수를 측정 없이 매긴다. 이 점수가 사용자에게 그대로 전달되고, 사용자는 그것을 사실로 받는다. 나중에 측정하면 점수가 0.05~0.20 떨어진다. 이 차이가 누적되어 "됐다고 했는데 갭이 있는 느낌" 의 정체.

## 정의

| 위험 발화 | 원인 메커니즘 | 안전 대응 |
|----------|--------------|----------|
| "구현 완료했습니다" | e2e 결과 jsonl 미확인 | `~/.forgen/state/e2e-result.json` 1시간 내 timestamp 확인 후 발화 |
| "테스트 모두 통과" | 부분 실행 또는 mock-only | `npm test` 전체 + Docker e2e 실행 후 발화 |
| "ambiguity 0.15 → ready" | 점수 자가 채점, 측정 없음 | 측정 도구 호출 후에만 점수 갱신 |
| "전체 회귀 PASS" | 일부 카테고리만 본 경우 | exit code + 카운트 둘 다 인용 |
| "지금 동작합니다" | 단발 실행, 일관성 미확인 | 10회 반복 실행 (forgen 패턴: workflow_repeated_runtime_validation) |

## 자기 사례 (실데이터)

**Case-1: R-B1 11회 연속 block (2026-04-22 06:08~06:15)**

- 7분 동안 "구현 완료했습니다" 발화 11회 시도
- 모두 stop-guard 가 block (rule R-B1)
- 사용자에게 도달한 최종 발화는 검증 후 통과한 1건
- 그러나 그 사이 7분 지연이 사용자 경험에 "또 막혔네 / 시간 걸리네" 인상으로 남음
- 데이터 위치: `~/.forgen/state/enforcement/violations.jsonl`

**Case-2: "v0.5.0 정체성 재정의" 답변 e2e 미검증 block (2026-04-23 05:22)**

- 큰 결론(전체 마일스톤 재정렬) 발화 시도
- 검증 범위: 0건 (e2e jsonl 미확인)
- L1-e2e-before-done 가 block

**Case-3: 이번 인터뷰 ambiguity 자가 채점**

- R1~R4: 0.65 → 0.43 → 0.35 → 0.25 → 0.15 (자가 채점, 측정 0회)
- R5 (실측 후): 0.084 로 보정
- 인플레이션 = 0.07 (한 라운드당 평균 0.014)

## 회피 절차

```
"완료/ready/통과/안정적" 류 발화 직전:
  1. 측정 가능한 주장인가? → YES면 직전 N분 내 도구 호출 확인
       └─ Bash(test/build/grep), Read(증거 파일) 중 1건 이상 필수
  2. 메타 점수 변동인가? → 측정 도구 호출 동반 필수
  3. 큰 결론(전체/마일스톤/정체성)인가? → 검증 범위도 비례 확장
  4. 단발 동작 확인인가? → 10회 반복 실행으로 일관성 확인 (forgen 룰)
```

## 적용 가드

- **기존 (v0.4.0):**
  - `L1-e2e-before-done` (stop-guard) — "완료" 발화 + e2e 결과 1시간 외 → block
  - `R-B1` (stop-guard) — "구현 완료했습니다" 패턴 → block
- **신규 (v0.4.1 TEST-2):**
  - 메타 점수(ambiguity/clarity/confidence) 변동 + 직전 N분 측정 호출 0건 → block
  - "전체 회귀 PASS" 발화 + exit code 인용 0건 → block

## 관련

- compound: `retro-v040-collab-gap` (RC2 + 자기증거 E1, E2)
- compound: `interview-forgen-v041-trust-completion` (TEST-2)
- 자매 anti-pattern: `sycophancy-without-measurement.md` (RC1)
- forgen 메모리: `feedback_docker_e2e_mandatory.md`, `feedback_mock_free_runtime_check.md`, `workflow_repeated_runtime_validation.md`
