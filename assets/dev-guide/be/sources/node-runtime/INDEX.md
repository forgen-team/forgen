---
title: Node.js 런타임 성능/진단 문서 인덱스
fetched: 예정 (2026-05-18 스캐폴드)
license: MIT (Node.js docs: https://github.com/nodejs/node/blob/main/LICENSE)
priority: 6 (출처 우선순위)
---

# Node.js 런타임 — 공식 문서 + Fastify + NestJS

> Event Loop, 메모리, 스트림, 성능 진단, 프레임워크 패턴.

## 출처

| URL | 설명 | 라이선스 |
|-----|------|----------|
| https://nodejs.org/en/docs/guides/event-loop-timers-and-nexttick | Event Loop 가이드 | MIT |
| https://nodejs.org/en/docs/guides/dont-block-the-event-loop | Event Loop 차단 방지 | MIT |
| https://nodejs.org/api/stream.html | Streams API | MIT |
| https://nodejs.org/api/worker_threads.html | Worker Threads | MIT |
| https://clinic.js.org/ | Clinic.js 진단 도구 | MIT |
| https://www.fastify.io/docs/latest/ | Fastify 공식 문서 | MIT |
| https://docs.nestjs.com/ | NestJS 공식 문서 | MIT |
| https://pino.js.org/ | Pino 로거 | MIT |
| https://github.com/nicolo-ribaudo/tc39-proposal-async-context | Async Context 제안 | — |

## 라이선스

MIT (Node.js, Fastify, Pino) / MIT (NestJS)

## 수집일

예정 (2026-05-18 스캐폴드)

## 참조 우선순위

6 (common.md 출처 우선순위)

## 문서 목록 (수집 예정)

| 파일명 (예정) | 출처 | 주제 |
|--------------|------|------|
| event-loop.md | Node.js | Event Loop 상세 (phases, timers) |
| dont-block.md | Node.js | Event Loop 차단 패턴과 해결 |
| streams.md | Node.js | Readable/Writable/Transform + backpressure |
| worker-threads.md | Node.js | CPU 병렬화 (worker_threads) |
| diagnostic-report.md | Node.js | 진단 리포트 생성 |
| clinic-setup.md | Clinic.js | Doctor / Flame / Heap profiler |
| fastify-lifecycle.md | Fastify | Request 생명주기 (hooks) |
| fastify-schema-validation.md | Fastify | JSON Schema 기반 입력 검증 |
| nestjs-modules.md | NestJS | 모듈/DI 패턴 |
| nestjs-interceptors.md | NestJS | 인터셉터 (로깅, 캐싱, 변환) |
| pino-setup.md | Pino | 구조화 로그 설정 (redact, transport) |

## 핵심 참조 원칙 (principles/node.md 연결)

- Event Loop 가이드 → N3 Event Loop 차단 금지
- Worker Threads → N3.2 CPU Heavy 격리
- Streams → N4 Backpressure
- Clinic.js → be-perf 진단 절차
- Pino → N8 구조화 로그
