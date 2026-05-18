---
title: API 설계 가이드 문서 인덱스
fetched: 예정 (2026-05-18 스캐폴드)
license: 복합 (항목별 명시)
priority: 6 (출처 우선순위)
---

# API 설계 — Stripe API + GitHub API + Google AIP

> 실전 API 설계 기준. Stripe(결제), GitHub(개발자 API), Google AIP(대규모 API 표준).

## 출처

| URL | 설명 | 라이선스 |
|-----|------|----------|
| https://stripe.com/docs/api | Stripe API Reference | Stripe 저작권 (공개 문서) |
| https://docs.github.com/en/rest | GitHub REST API | CC BY 4.0 |
| https://google.aip.dev/ | Google API Improvement Proposals | Apache-2.0 |
| https://opensource.google/documentation/reference/thirdparty/licenses | Google 오픈소스 라이선스 | — |

## 라이선스

- Stripe 문서: 공개 참조 가능, 재배포 금지
- GitHub 문서: CC BY 4.0
- Google AIP: Apache-2.0

## 수집일

예정 (2026-05-18 스캐폴드)

## 참조 우선순위

6 (common.md 출처 우선순위)

## 문서 목록 (수집 예정)

| 파일명 (예정) | 출처 | 주제 |
|--------------|------|------|
| stripe-pagination.md | Stripe | 커서 기반 페이지네이션 |
| stripe-idempotency.md | Stripe | Idempotency-Key 멱등성 패턴 |
| stripe-errors.md | Stripe | 구조화 에러 응답 (code/type/param) |
| stripe-versioning.md | Stripe | API 버전 관리 (날짜 기반) |
| github-rest-conventions.md | GitHub | RESTful 리소스 명명 규칙 |
| github-pagination.md | GitHub | Link 헤더 기반 페이지네이션 |
| aip-0121-resource-names.md | Google AIP-121 | 리소스 이름 표준 |
| aip-0131-standard-methods.md | Google AIP-131 | 표준 메서드 (List/Get/Create/...) |
| aip-0180-backwards-compat.md | Google AIP-180 | 하위 호환성 정책 |
| aip-0193-errors.md | Google AIP-193 | 에러 모델 표준 |

## 핵심 참조 원칙 (principles/common.md 연결)

- Stripe 에러 → Error Model B.1 구조화 에러
- Stripe 멱등성 → Idempotency D.1 Idempotency-Key
- GitHub 명명 → API 설계 A.2 일관성 (복수형 명사)
- Google AIP-180 → API 설계 A.4 진화가능성 (하위 호환)
- Google AIP-193 → Error Model B.2 4xx/5xx 경계
