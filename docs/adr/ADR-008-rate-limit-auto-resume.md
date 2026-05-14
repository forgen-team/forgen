# ADR-008: Rate-Limit Auto-Resume — Detection 한계와 Fix-Forward 정책

**Status**: Proposed (2026-05-14)
**Date**: 2026-05-14
**Reversibility**: Type 2 (구현 가역. detector 패턴은 schema 호환되는 한 자유 교체)
**Related ADR**: ADR-001 (mech-ABC 아키텍처)
**Affected**: `src/core/spawn.ts`, `src/hooks/context-guard.ts`, `src/host/host-runtime.ts`, `~/.forgen/state/pending-resume.json` schema

## Context

v0.4.5 까지 forgen 의 `spawnClaudeWithResume` (src/core/spawn.ts:228-274) 은
**context-window token-limit** 만 자동 재기동을 지원했다 — 30s 쿨다운 후 새
세션을 띄워 handoff 파일로 컨텍스트를 이어받는 패턴.

긴 무인 실행 (`forge-loop --goal-only` 새벽 실행, 장시간 forgen-eval N-회 측정)
시 발생하는 또 다른 차단 신호인 **API rate-limit** (Claude 5h window, weekly
window; Codex CLI 의 동등 정책) 은 자동 회복되지 않아:

- 사용자가 자고 있을 때 limit hit → 다음 reset (최대 5h) 까지 모든 진행 중단
- forge-loop 의 stop-guard 가 polite-stop 차단을 시도해도, 실제 LLM 호출이 막힌
  상태라 무의미한 차단 루프
- forgen-eval N=33 류 sequential measurement 가 중간에 5h 공백을 흡수하지 못해
  세션 분할 → 측정 일관성 깨짐

본 ADR 은 0.4.6 의 "Unattended Execution Resilience" 테마 핵심 컴포넌트인
rate-limit detection + 자동 정밀 sleep + 재기동 메커니즘을 박제하고, **detection
신호의 본질적 한계** (Claude/Codex CLI 의 rate-limit 메시지 포맷이 공식 contract
가 아님) 와 그에 대한 fix-forward 정책을 명시한다.

## Decision

### 1. Detection 위치 — context-guard.ts Stop hook 확장

기존 token-limit detection 옆에 rate-limit regex 를 추가한다. spawn 측에서
stderr 직접 파싱이 아닌 hook 레이어에서 처리하는 이유:

- 기존 token-limit 패턴 (`pending-resume.json` marker → spawn 재기동) 과 동일
  schema 재사용 → spawn 측 변경 최소화
- hook 은 이미 Stop 이벤트의 `error` 필드 접근 권한 있음 (Claude Code 가 종료
  사유를 전달)
- Codex 측 stderr 신호도 `host-runtime` 어댑터 + Stop hook 결합으로 처리

```ts
// src/hooks/context-guard.ts
const TOKEN_LIMIT_REGEX = /context.*limit|token.*limit|conversation.*too.*long/i;
const RATE_LIMIT_REGEX  = /rate.?limit|5.?hour.*limit|weekly.*limit|usage.*limit|quota.*exceeded/i;

if (TOKEN_LIMIT_REGEX.test(errorMsg)) {
  writeMarker({ reason: 'token-limit', ... });
} else if (RATE_LIMIT_REGEX.test(errorMsg)) {
  const resetAt = parseResetTime(errorMsg);  // best-effort, null on failure
  writeMarker({ reason: 'rate-limit', resetAt, runtime, ... });
}
```

### 2. Reset 시각 파서 — best-effort + max-cap fallback

다음 5개 패턴을 시도, 실패 시 `resetAt: null`:

| 패턴                        | 예시                              | 파싱 결과 (UTC)      |
|-----------------------------|-----------------------------------|----------------------|
| `Resets at HH:MM(:SS)? TZ`  | `Resets at 14:30 PST`             | 다음 14:30 PST       |
| `Resets in Nh Mm`           | `Resets in 4h 12m`                | now + 4h 12m         |
| `Resets in N seconds`       | `Resets in 18000 seconds`         | now + 18000s         |
| `available again at <ISO>`  | `... at 2026-05-14T18:30:00Z`     | 직접 ISO 파싱        |
| `try again in N min`        | `try again in 240 min`            | now + 240m           |

파싱 unit-test fixture 는 10개 케이스 (5 패턴 × 2 variant) 를 commit 한다.
실제 메시지 샘플이 부재한 상태이므로 (사용자 미접수), 최초 트리거 후 실제 포맷이
어긋나면 fix-forward 한다 (§5 정책 참조).

### 3. Resume 분기 — 정밀 sleep + foreground countdown

`spawnClaudeWithResume` 의 token-limit 분기 옆에 rate-limit 분기:

```ts
if (marker.reason === 'rate-limit') {
  const sleepMs = marker.resetAt
    ? Math.max(0, new Date(marker.resetAt).getTime() - Date.now()) + 60_000  // 60s 버퍼
    : exponentialBackoff(resumeCount);  // 1m → 2h cap, max 6h total
  await foregroundCountdown(sleepMs);   // 30s 갱신, Ctrl+C abort
}
```

- **MAX_RESUMES 분리**: token-limit=3 (현행 유지), rate-limit=10 (한 wait 이
  최대 5h 라 더 관대해도 됨)
- **Hard cap 6h**: 파싱 실패 시 무한 대기 방지. 6h 초과 시 abort + handoff 저장.
- **Foreground only (0.4.6)**: detached daemon mode 는 0.4.7 로 분리 (검증 표면
  큼 — 좀비 프로세스, log rotation, kill safety).

### 4. Codex CLI parity — host-runtime 어댑터 분기만

`src/host/host-runtime.ts` 의 runtime 별 어댑터에 `detectRateLimit(stderr):
{hit, resetAt?}` 추가. wait 로직은 공유, runtime 별로 detection 패턴만 분리.
Codex 측 rate-limit 메시지 샘플도 부재 — 일반 패턴으로 시작 후 fix-forward.

### 5. Fix-Forward 정책 (핵심)

**rate-limit 메시지 포맷은 Claude Code / Codex CLI 의 공식 contract 가 아니다.**
양사 release note 에 schema 가 박제되지 않은 상태이므로 detector regex 와 reset
parser 는 본질적으로 best-effort 다. 본 ADR 은 다음을 박제한다:

1. **첫 트리거 시 로그 수집 의무** — detector 가 매칭 실패한 stderr 텍스트는
   `~/.forgen/state/rate-limit-misses.jsonl` 에 raw 저장 (PII 없는 system 메시지
   범위만). 5건 누적 시 사용자 경고 출력.
2. **Hotfix 우선**: 패턴 어긋남이 발견되면 patch release (0.4.6.x) 로 detector
   regex/parser 만 교체. 본 ADR schema 변경 없이 처리 가능.
3. **Silent 차단 금지**: detector 가 실패해도 spawn 은 정상 exit. 사용자가 수동
   재기동 가능한 fail-open 동작 유지 (현행 token-limit 과 동일 정책).
4. **측정 트랙 (forgen-eval) 영향**: rate-limit 자동 wait 이 forgen-eval driver
   에 적용되면 sequential measurement 의 wall-clock 이 늘어남 — 이는 의도된
   동작. 보고서에 wait 시간 별도 박제 필드 추가 (`waitedForRateLimitMs`).

## Consequences

### Positive

- 무인 실행 (forge-loop overnight, eval N=33+ sequential) 이 5h limit 을
  서바이브
- pending-resume.json schema 단일화로 token-limit + rate-limit 동일 경로 처리
- forgen-eval 측정의 wall-clock 일관성 향상 (수동 재기동 분산 제거)

### Negative / Risk

- detector 패턴이 실제 메시지와 어긋나면 첫 실제 트리거에서 회복 실패. fix-
  forward 정책으로 mitigate 하지만 첫 사용자 경험 차질 가능.
- foreground sleep 이 터미널 점유 — 노트북 닫고 자려면 0.4.7 daemon mode 필요.
- max-cap 6h 가 weekly limit (최대 7일) 을 커버하지 못함. weekly limit 은 별도
  abort + 명시 메시지 (사용자 개입 필요).

### Neutral

- Claude vs Codex 메시지 포맷 차이는 host-runtime 어댑터에 격리. 한 쪽 변경이
  다른 쪽에 누수되지 않음.

## Alternatives Considered

1. **stderr 직접 파싱 (spawn 측)** — 기각. 기존 hook 기반 marker 패턴과 두 경로
   가 공존하면 dedup 복잡. hook 단일 진입점으로 통일.
2. **Anthropic API 의 retry-after header 활용** — 기각. forgen 은 CLI wrapper
   레벨이라 HTTP layer 접근 없음. Claude Code / Codex 가 header 를 stderr 에
   투명하게 노출하는지 불확실.
3. **Multi-runtime failover (claude limit → codex 자동 전환)** — 기각.
   forgen-eval 의 측정 트랙 (driver = 단일 runtime 가정) 과 충돌. 사용자 명시
   요청 시 별도 ADR 로 검토.
4. **Detached daemon resume** — 0.4.7 로 분리. 0.4.6 스코프 통제.

## Verification

v1-rules.md 준수: Docker e2e (`tests/e2e/docker/run-test.sh`) 통과 필수.

- **Unit**: detector regex/parser fixture 10개 케이스 (5 패턴 × 2 variant)
- **Integration**: `pending-resume.json` 수동 주입 → spawnClaudeWithResume 의
  resume loop 가 정밀 sleep + 재기동 수행. mock claude-cli 로 검증.
- **E2E**: 짧은 `resetAt` (now + 10s) marker 로 시나리오 작성. Docker 컨테이너
  안에서 mock CLI 가 1차 호출에 rate-limit-like stderr 출력 → forgen 이 10s
  countdown → 재호출 성공. ~/.forgen/state/e2e-result.json 갱신.
- **회귀 가드**: detector 가 매칭한 raw 메시지를 `e2e-result.json` 에 함께
  박제하여 후속 패턴 변경 시 어떤 입력이 통과했는지 추적 가능.

## Migration Notes

- `pending-resume.json` schema 확장 (`reason`, `resetAt`, `runtime` 필드 추가).
  기존 `token-limit` 만 있는 marker 는 그대로 호환 (기본 reason='token-limit').
- 사용자 환경의 stale marker (수일 전) 가 있으면 0.4.6 첫 부팅 시 mtime
  검사하여 24h+ 오래된 marker 는 자동 삭제 (silent).
