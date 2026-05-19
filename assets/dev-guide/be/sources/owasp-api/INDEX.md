---
title: OWASP API Security Top 10 문서 인덱스
fetched: 예정 (2026-05-18 스캐폴드)
license: CC BY-SA 4.0 (https://owasp.org)
priority: 3 (출처 우선순위)
---

# OWASP API Security Top 10 (2023)

> 가장 위험한 API 보안 취약점 10가지. 2023년판 (2019년 대비 갱신).

## 출처

| URL | 설명 |
|-----|------|
| https://owasp.org/API-Security/editions/2023/en/0x00-header/ | OWASP API Security Top 10 2023 |
| https://github.com/OWASP/API-Security | GitHub 원본 |
| https://owasp.org/www-project-api-security/ | 프로젝트 페이지 |

## 라이선스

Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA 4.0)

## 수집일

예정 (2026-05-18 스캐폴드)

## 참조 우선순위

3 (common.md 출처 우선순위)

## 문서 목록 (수집 예정)

| 파일명 (예정) | 항목 | 제목 |
|--------------|------|------|
| api1-bola.md | API1 | Broken Object Level Authorization |
| api2-broken-auth.md | API2 | Broken Authentication |
| api3-bopla.md | API3 | Broken Object Property Level Authorization |
| api4-unrestricted-consumption.md | API4 | Unrestricted Resource Consumption |
| api5-bfla.md | API5 | Broken Function Level Authorization |
| api6-ssrf.md | API6 | Unrestricted Access to Sensitive Business Flows |
| api7-ssrf.md | API7 | Server Side Request Forgery |
| api8-misconfig.md | API8 | Security Misconfiguration |
| api9-inventory.md | API9 | Improper Inventory Management |
| api10-unsafe-apis.md | API10 | Unsafe Consumption of APIs |

## 핵심 참조 원칙 (principles/common.md 연결)

- 전체 → Security E.4 OWASP API Top 10 매핑 테이블
- API1 (BOLA) → E.2 인증/인가 분리 (소유권 검증)
- API4 (Rate Limit) → E.1 입력 검증 경계
- API7 (SSRF) → E.1 신뢰 경계
