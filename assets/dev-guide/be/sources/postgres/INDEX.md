---
title: PostgreSQL 성능 및 인덱스 문서 인덱스
fetched: 예정 (2026-05-18 스캐폴드)
license: PostgreSQL License + CC BY-NC 4.0 (Use The Index, Luke)
priority: 6 (출처 우선순위)
---

# PostgreSQL — Use The Index, Luke + 공식 성능 가이드

> 인덱스 설계, 실행 계획, 슬로우 쿼리 최적화.

## 출처

| URL | 설명 | 라이선스 |
|-----|------|----------|
| https://use-the-index-luke.com/ | Use The Index, Luke — Markus Winand | CC BY-NC 4.0 |
| https://www.postgresql.org/docs/current/performance-tips.html | PostgreSQL 공식 성능 가이드 | PostgreSQL License |
| https://www.postgresql.org/docs/current/indexes.html | 인덱스 유형 | PostgreSQL License |
| https://www.postgresql.org/docs/current/using-explain.html | EXPLAIN 사용법 | PostgreSQL License |
| https://www.postgresql.org/docs/current/transaction-iso.html | 트랜잭션 격리 수준 | PostgreSQL License |

## 라이선스

- PostgreSQL 공식 문서: PostgreSQL License (자유 사용)
- Use The Index, Luke: CC BY-NC 4.0 (비상업적 이용)

## 수집일

예정 (2026-05-18 스캐폴드)

## 참조 우선순위

6 (common.md 출처 우선순위)

## 문서 목록 (수집 예정)

| 파일명 (예정) | 출처 | 주제 |
|--------------|------|------|
| index-basics.md | UTIL | B-Tree 인덱스 동작 원리 |
| composite-index.md | UTIL | 복합 인덱스 설계 (컬럼 순서) |
| covering-index.md | UTIL | Index-Only Scan (covering index) |
| index-on-expressions.md | UTIL | 함수/표현식 인덱스 |
| partial-index.md | UTIL | 부분 인덱스 (WHERE 조건 포함) |
| explain-analyze.md | PG 공식 | EXPLAIN ANALYZE 읽는 법 |
| slow-query.md | PG 공식 | pg_stat_statements + 슬로우 쿼리 |
| vacuum-autovacuum.md | PG 공식 | VACUUM / Autovacuum 설정 |
| transaction-isolation.md | PG 공식 | 격리 수준 (RC/RR/Serializable) |
| locking.md | PG 공식 | Row-level locking, deadlock |

## 핵심 참조 원칙 (principles/common.md 연결)

- Index design → DB G.3 인덱스 의도 주석
- EXPLAIN ANALYZE → be-perf N+1 진단
- Transaction isolation → DB G.1 트랜잭션 경계
- Locking → be-perf lock contention 카테고리
