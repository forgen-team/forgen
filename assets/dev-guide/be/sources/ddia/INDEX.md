---
title: DDIA (Designing Data-Intensive Applications) 문서 인덱스
fetched: 예정 (2026-05-18 스캐폴드)
license: O'Reilly 저작권 — 공개 발췌 없음. 요약/원칙만 수록
priority: 5 (출처 우선순위)
---

# Designing Data-Intensive Applications — Martin Kleppmann

> 데이터 집약적 애플리케이션 설계. 복제, 파티셔닝, 트랜잭션, 분산 시스템 기초.

## 출처

| URL | 설명 |
|-----|------|
| https://dataintensive.net/ | 공식 사이트 |
| https://www.oreilly.com/library/view/designing-data-intensive/9781491903063/ | O'Reilly |
| https://github.com/ept/ddia-references | 챕터별 참조 논문 |

## 라이선스

O'Reilly 저작권 보호 도서. 직접 텍스트 수록 불가.
이 sources 디렉토리에는 **원칙 요약과 핵심 패턴만** 기록. 원문은 도서 구매 필요.

## 수집일

예정 (2026-05-18 스캐폴드)

## 참조 우선순위

5 (common.md 출처 우선순위)

## 문서 목록 (원칙 요약 예정 — 원문 미포함)

| 파일명 (예정) | 챕터 | 주제 |
|--------------|------|------|
| ch01-foundations.md | 1 | 신뢰성·확장성·유지보수성 정의 |
| ch02-data-models.md | 2 | 관계형 vs 문서 vs 그래프 |
| ch03-storage-retrieval.md | 3 | 인덱스 구조 (B-Tree, LSM) |
| ch04-encoding.md | 4 | 인코딩/스키마 진화 (Avro, Protobuf) |
| ch05-replication.md | 5 | 복제 — 리더/팔로워, 동기/비동기 |
| ch06-partitioning.md | 6 | 파티셔닝 (샤딩) |
| ch07-transactions.md | 7 | 트랜잭션 격리 수준, ACID vs BASE |
| ch08-trouble.md | 8 | 분산 시스템의 문제 (시계, 네트워크) |
| ch09-consistency.md | 9 | 일관성과 합의 (Linearizability, Paxos, Raft) |
| ch10-batch.md | 10 | 배치 처리 (MapReduce) |
| ch11-stream.md | 11 | 스트림 처리 (Kafka, 이벤트 소싱) |
| ch12-future.md | 12 | 데이터 시스템의 미래 |

## 핵심 참조 원칙 (principles/common.md 연결)

- Ch7 (Transactions) → DB G.1 트랜잭션 경계
- Ch4 (Schema Evolution) → DB G.2 Expand/Contract 마이그레이션
- Ch3 (Indexes) → DB G.3 인덱스 의도 주석
- Ch5 (Replication Lag) → 분산 시스템 일관성 주의사항
