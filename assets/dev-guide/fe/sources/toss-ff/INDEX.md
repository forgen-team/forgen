---
title: Toss Frontend Fundamentals — 챕터 인덱스
fetched: 2026-05-18
source: https://github.com/toss/frontend-fundamentals + https://frontend-fundamentals.com/code-quality/
---

# Toss Frontend Fundamentals — 챕터 인덱스

수집 일자: 2026-05-18  
출처: https://github.com/toss/frontend-fundamentals / https://frontend-fundamentals.com/code-quality/

## 개요

| 파일 | 원칙 | 한 줄 요약 |
|------|------|-----------|
| overview-4-principles.md | 전체 | 4대 원칙(가독성·예측성·응집도·결합도) 정의 및 트레이드오프 |

## 가독성 (Readability)

| 파일 | 한 줄 요약 | 핵심 안티패턴 |
|------|-----------|--------------|
| readability-submit-button.md | 같이 실행되지 않는 코드 분리하기 | 권한별 분기가 교차된 단일 컴포넌트 → 권한별 컴포넌트 분리 |
| readability-login-start-page.md | 구현 상세 추상화하기 | 로그인 체크 로직 노출 → AuthGuard HOC/Wrapper로 추상화 |
| readability-use-page-state.md | 로직 종류에 따라 합쳐진 함수 쪼개기 | 페이지 전체 쿼리파람 관리 훅 → 파라미터별 독립 훅 |
| readability-condition-name.md | 복잡한 조건에 이름 붙이기 | 중첩 filter/some 익명 → `isSameCategory`, `isPriceInRange` 변수 추출 |
| readability-magic-number.md | 매직 넘버에 이름 붙이기 | `delay(300)` → `const ANIMATION_DELAY_MS = 300` |
| readability-user-policy.md | 시점 이동 줄이기 | POLICY_SET → getPolicyByRole → policy 3단계 참조 → 인라인 객체로 단순화 |
| readability-ternary-operator.md | 삼항 연산자 단순하게 하기 | 중첩 삼항 → IIFE + early return if문 |
| readability-comparison-order.md | 왼쪽에서 오른쪽으로 읽히게 하기 | `a >= b && a <= c` → `b <= a && a <= c` (수학 부등식 순서) |

## 예측 가능성 (Predictability)

| 파일 | 한 줄 요약 | 핵심 안티패턴 |
|------|-----------|--------------|
| predictability-http.md | 이름 겹치지 않게 관리하기 | 라이브러리와 동일한 `http` 이름 → `httpService.getWithAuth`로 구분 |
| predictability-use-user.md | 같은 종류의 함수는 반환 타입 통일하기 | useUser는 Query 객체, useServerTime은 data만 반환 → 둘 다 Query 객체로 통일 |
| predictability-hidden-logic.md | 숨은 로직 드러내기 | fetchBalance 안에 logging 숨김 → fetch는 fetch만, logging은 호출 측으로 분리 |

## 응집도 (Cohesion)

| 파일 | 한 줄 요약 | 핵심 안티패턴 |
|------|-----------|--------------|
| cohesion-code-directory.md | 함께 수정되는 파일을 같은 디렉토리에 두기 | 모듈 종류별 flat 구조 → 도메인별 계층 구조 |
| cohesion-magic-number.md | 매직 넘버 없애기 (응집도 관점) | `delay(300)` 애니메이션 변경 시 둘 중 하나만 수정 위험 → 상수로 결합 |
| cohesion-form-fields.md | 폼의 응집도 생각하기 | 필드 단위 응집(react-hook-form validate) vs 폼 전체 응집(zod schema) 선택 기준 |

## 결합도 (Coupling)

| 파일 | 한 줄 요약 | 핵심 안티패턴 |
|------|-----------|--------------|
| coupling-use-page-state.md | 책임을 하나씩 관리하기 | 모든 쿼리파람 통합 훅 → 수정 영향범위 과대 → 파라미터별 분리 |
| coupling-use-bottom-sheet.md | 중복 코드 허용하기 | 유사해 보이는 바텀시트 로직 공통화 → 페이지별 분기 과잉 → 중복 허용 권장 |
| coupling-item-edit-modal.md | Props Drilling 지우기 | 3단계 prop 전달 → Composition 패턴(`children`) 또는 Context API |

## 총계

- 총 파일 수: 15개 (INDEX.md 제외)
- 원칙별: 가독성 8, 예측가능성 3, 응집도 3, 결합도 3
