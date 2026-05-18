---
title: 12-Factor App 문서 인덱스
fetched: 예정 (2026-05-18 스캐폴드)
license: CC BY 4.0 (https://12factor.net)
priority: 1 (출처 우선순위 최상위)
---

# 12-Factor App

> 클라우드 네이티브 애플리케이션을 위한 12가지 방법론.
> 이식성, 운영 안정성, 스케일 아웃 설계의 기준.

## 출처

| URL | 설명 |
|-----|------|
| https://12factor.net/ko/ | 한국어 공식 번역 |
| https://12factor.net/ | 영문 원본 |

## 라이선스

Creative Commons Attribution 4.0 (CC BY 4.0)

## 수집일

예정 (2026-05-18 스캐폴드)

## 참조 우선순위

1 (common.md 출처 우선순위 최상위)

## 문서 목록 (수집 예정)

| 파일명 (예정) | Factor | 제목 |
|--------------|--------|------|
| 01-codebase.md | I | Codebase — 하나의 코드베이스, 다수 배포 |
| 02-dependencies.md | II | Dependencies — 의존성 명시 및 격리 |
| 03-config.md | III | Config — 환경변수에 설정 저장 |
| 04-backing-services.md | IV | Backing Services — 부착된 리소스로 취급 |
| 05-build-release-run.md | V | Build/Release/Run — 엄격한 단계 분리 |
| 06-processes.md | VI | Processes — 무상태(stateless) 프로세스 |
| 07-port-binding.md | VII | Port Binding — 포트 바인딩으로 서비스 노출 |
| 08-concurrency.md | VIII | Concurrency — 프로세스 모델로 스케일 아웃 |
| 09-disposability.md | IX | Disposability — 빠른 시작 + 우아한 종료 |
| 10-dev-prod-parity.md | X | Dev/Prod Parity — 개발/스테이징/프로덕션 일관성 |
| 11-logs.md | XI | Logs — 이벤트 스트림으로 취급 (stdout) |
| 12-admin-processes.md | XII | Admin Processes — 일회성 프로세스 실행 |

## 핵심 참조 원칙 (principles/common.md 연결)

- Factor III (Config) → Security E.3 비밀 관리 (env 기반)
- Factor IX (Disposability) → Node N2 graceful shutdown
- Factor XI (Logs) → Observability C.1 구조화 로그 (stdout 출력)
