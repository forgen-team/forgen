# ADR-011: 백그라운드 compound 방법론 — 시간-기반 backstop (cron sweep)

**Status**: Accepted (2026-07-28)
**Reversibility**: Type 2 (가역 — cron 잡/CLI 추가, 롤백 용이)
**관련**: ADR-002(compound 승급), ADR-010(플랫폼 수렴), [[forgen-autocompound-gap]]

## Context

forgen 의 compound(교정→정책 학습) 추출은 현재 **전부 이벤트-훅 기반**이다:

| 메커니즘 | 트리거 | 방식 |
|---|---|---|
| A. Stop subprocess 러너 | Stop 훅 | transcript→Haiku 추출, debounce 5/30분 |
| B. PreCompact 프롬프트 주입 | PreCompact | 모델에게 behavior 파일 쓰라 지시 |
| C. SessionStart 복구 | 새 세션 시작 | 이전 세션 `pending-compound.json` 마커 소비 |

**문제 (실측, 2026-07-28)**: 이 모델은 **이벤트 기회주의**이고 **시간-기반 backstop 이 없다**.
backstop 개념(pending-compound + SessionStart 복구)은 **세션 경계(재시작)**에만 걸린다.
→ **재시작하지 않는 긴 세션은 backstop 을 영원히 못 탄다.** 증거: 세션 efbcf2ae 가 7/21
barren 실행(0건 추출) 후 **164시간 무동작** — barren backoff(30분)는 진작 지났으나, 컴팩션 경유
+ 후반 Stop 다수 가드-차단으로 clean 트리거(`stop_hook_type==='user'|'end_turn'`)를 안 탐.
그 사이 crown-jewel 작업(cross-session δ 실증)이 compound 스토어에 미포착.

**요구(비기능)**: (R1) 어떤 세션 형태에서도 학습 유실 0(=robustness). (R2) 긴 활성 세션 커버.
(R3) 낮은 구현/유지 복잡도. (R4) 낮은 상시 자원. (R5) 낮은 마이그레이션 비용.

## Alternatives

- **A. 현상 유지 (event-hooks only)**: 훅만. 유실 방지 실패(실증). daemon 불요.
- **B. 최소 패치**: PreCompact 에서 러너도 spawn(프롬프트+러너) + barren backoff 가 활성 세션
  (promptCount 증가분 있음)을 굶기지 않게 예외. 새 인프라 없음. 컴팩션 없는 장세션은 여전히 취약.
- **C. cron 시간-backstop (권고)**: `forgen compound sweep` 을 cron(예: 시간당)으로 돌려,
  최근 N시간 수정됐고 세션별 last-compound 가 stale 한 transcript 를 쓸어담아 러너 실행.
  이벤트 훅(fast path) 유지 + 시간-backstop(guarantee). B의 값싼 수정도 병행.
- **D. 이상형: 상주 daemon/worker (claude-mem 방식)**: 상시 프로세스가 활성 transcript tail.
  최고 견고성이나 생명주기·자원·dedup 부담, forgen 엔 daemon 인프라 부재.

## Trade-off Matrix

| 기준 | 가중치 | A 현상유지 | B 최소패치 | **C cron** | D daemon |
|---|---|---|---|---|---|
| 유실 방지(robustness) | 35% | ★ | ★★★ | ★★★★★ | ★★★★★ |
| 긴 활성세션 커버 | 20% | ★ | ★★★ | ★★★★★ | ★★★★★ |
| 구현/유지 복잡도(낮을수록↑) | 20% | ★★★★★ | ★★★★ | ★★★ | ★ |
| 상시 자원(낮을수록↑) | 15% | ★★★★★ | ★★★★★ | ★★★★ | ★★ |
| 마이그레이션 비용(낮을수록↑) | 10% | ★★★★★ | ★★★★ | ★★★ | ★★ |
| **가중 합계(5점)** | 100% | **2.80** | **3.60** | **4.25** | **3.45** |

**해석**: robustness/긴세션(문제의 본질, 55%)에서 A는 실격. C가 최고(4.25) — 시간-backstop 이
세션 경계 의존을 제거해 갭을 정확히 메우면서 daemon 의 상시 부담을 피한다(cron=OS 관리 백그라운드).

## Decision

**C 채택 + B의 값싼 수정 병행**. "빠른 경로 + 보장된 backstop" 방법론:
1. **Fast path (유지)**: Stop/PreCompact 이벤트 훅 — 학습 직후 값싸게 compound.
2. **Guarantee (신규)**: `forgen compound sweep` — 시간-기반 backstop.
   - 스캔: `~/.forgen/state/` 의 활성 transcript(최근 N=24h 수정) 세션들.
   - 게이트: 세션별 last-compound(`last-auto-compound.json` 를 세션별로 확장) 가 stale(예:
     >2h) 이고 promptCount≥10 이면 러너 실행. 기존 dedup/cooldown 재사용해 이벤트 훅과 이중실행 방지.
   - cron: 사용자 crontab 에 시간당(권장) 또는 `forgen install --compound-cron`. 멱등·fail-open.
3. **B 수정**: (a) barren backoff 가 활성 세션(promptCount 증가분 존재)엔 미적용, (b) PreCompact 에서
   러너 spawn 옵션(프롬프트 주입은 유지).

## Consequences

**긍정**: (a) 어떤 세션 형태에서도 유실 0 — 장세션/컴팩션/차단-Stop 무관. (b) daemon 없이 견고
(cron). (c) 이벤트 훅과 dedup 공유로 이중실행 없음.

**부정/리스크**: (a) cron 설치는 OS별 상이(crontab/launchd/Task Scheduler) — 초기엔 crontab+수동
안내, `forgen doctor` 에 미설치 감지 넛지. (b) transcript 스캔 비용 — N=24h 윈도우 + 세션별
stale 게이트로 제한. (c) Haiku 호출 비용 — cooldown 재사용으로 상한.

## 관련 결정: claude-mem (별도 확인, 2026-07-28)

native Claude 메모리 도입에 따라 재확인: **forgen 은 claude-mem 에 런타임 의존이 없다**
(plugin-detector 공존 감지 + context-budget 축소 + private 마커 interop + 선택적 eval arm 뿐).
→ 대응: (1) 공존-budget 로직을 **native 메모리로 확장**(감지 시 주입 축소), (2) ψ_synergy 추구
종료(이미 defer), (3) eval arm 선택 유지. **포지셔닝**: native/claude-mem=일반 메모리,
forgen=교정→정책 학습 + 증명된 δ(cross-session, [[forgen-cross-session-delta]]). 겹치지 않음.
이는 별도 ADR 없이 이 결정의 부속으로 기록 — compound(=forgen 자체 메모리)가 moat 이므로
claude-mem 의존 강화는 불필요.

## Open Questions

1. cron 주기: 시간당 vs 30분 — 자원 vs 지연 트레이드오프. 초기 시간당, 실측 후 조정.
2. Windows(Task Scheduler)/macOS(launchd) 설치 자동화 — 초기 crontab 만, 나머지 넛지.
