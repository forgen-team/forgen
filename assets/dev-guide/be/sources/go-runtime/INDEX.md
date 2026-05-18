---
title: Go 런타임 성능/진단 문서 인덱스
fetched: 예정 (2026-05-18 스캐폴드)
license: BSD-3-Clause (Go 공식) + 각 출처별
priority: 6 (출처 우선순위)
---

# Go 런타임 — 공식 문서 + Effective Go + 성능 가이드

> Go 스케줄러, 메모리 모델, GC, pprof 진단, goroutine 패턴.

## 출처

| URL | 설명 | 라이선스 |
|-----|------|----------|
| https://go.dev/doc/effective_go | Effective Go | BSD-3-Clause |
| https://go.dev/ref/spec | Go Language Specification | BSD-3-Clause |
| https://go.dev/doc/diagnostics | Diagnostics 가이드 | BSD-3-Clause |
| https://go.dev/blog/pprof | pprof 프로파일링 | BSD-3-Clause |
| https://go.dev/doc/gc-guide | GC 가이드 | BSD-3-Clause |
| https://go.dev/blog/concurrency-timeouts | Timeouts/Cancellation | BSD-3-Clause |
| https://github.com/dgryski/go-perfbook | Go 성능 최적화 북 | — |
| https://pkg.go.dev/golang.org/x/sync/errgroup | errgroup | BSD-3-Clause |
| https://go.dev/blog/race-detector | Race Detector | BSD-3-Clause |
| https://golangci-lint.run/ | golangci-lint | GPL-3.0 |

## 라이선스

BSD-3-Clause (Go 공식 문서)

## 수집일

예정 (2026-05-18 스캐폴드)

## 참조 우선순위

6 (common.md 출처 우선순위)

## 문서 목록 (수집 예정)

| 파일명 (예정) | 출처 | 주제 |
|--------------|------|------|
| effective-go.md | Effective Go | Go 관용 표현, 에러, 인터페이스 |
| scheduler.md | Go 공식 | GMP 스케줄러 동작 원리 |
| gc-guide.md | Go 공식 | GC 파라미터 (GOGC, GOMEMLIMIT) |
| pprof.md | Go 공식 | CPU / 메모리 / goroutine 프로파일 |
| race-detector.md | Go 공식 | -race 플래그, 레이스 컨디션 탐지 |
| memory-model.md | Go 공식 | Happens-before, sync 보장 |
| goroutine-patterns.md | 참조 | goroutine 생명주기 패턴 |
| context-patterns.md | 참조 | context.Context 전파 패턴 |
| errgroup.md | golang.org/x | errgroup 사용법 |
| golangci-lint-config.md | golangci-lint | .golangci.yml 권장 설정 |
| go-perf-book-summary.md | go-perfbook | 핵심 최적화 패턴 요약 |

## 핵심 참조 원칙 (principles/go.md 연결)

- Effective Go 에러 패턴 → G1 에러는 값
- context 패턴 → G2 context 전파
- goroutine 패턴 → G3 goroutine 생명주기
- pprof → be-perf Go 진단 절차
- gc-guide → be-perf GC pause 카테고리
- golangci-lint → G7 정적 분석
