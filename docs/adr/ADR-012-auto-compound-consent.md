# ADR-012: auto-compound 동의 모델 — 티어드 (결정론 default-on + Haiku opt-in)

**Status**: Accepted (2026-07-28)
**Reversibility**: Type 2 (가역 — 기본값/게이트 플래그, 롤백 용이)
**관련**: ADR-011(백그라운드 compound), [[forgen-cross-session-delta]]

## Context

forgen 설치 시 `context-guard` Stop 훅이 매 세션(promptCount≥10, 5/30분 쿨다운)
`auto-compound-runner` 를 spawn 한다. 러너는 (1) transcript **요약(~8000자, 메시지당 500자)**
을 **Haiku 로 전송**해 솔루션·행동패턴·학습을 추출(3콜)하고, (2) 세션 후보를 룰로 승급
(`promoteSessionCandidates`, **결정론·egress 0**)한다.

**문제**: (1) Haiku 추출이 **default-ON, 설치-시점 명시 동의 없음, granular opt-out 없음**
(context-guard 전체를 꺼야 함). 사용자 대화 요약이 그들도 모르게 주기적으로 API 로 나간다.
방금(ADR-011) cron 을 opt-in 으로 둔 것과 **불일치**.

**실측 재프레이밍 (감→사실)**:
- 전체 transcript 아님 → redaction(secret/`<private>`)된 ~8000자 요약.
- **동일 신뢰경계** — 대화가 이미 가는 Anthropic 으로 (새 제3자 유출 아님).
- 비용 ~$0.002/run (구독 쿼터엔 소량).
- **핵심 갭 = 프라이버시가 아니라 투명성/동의 + granular 제어 부재.**

**결정적 사실**: 우리가 **증명한 δ**([[forgen-cross-session-delta]], Sonnet5 0.71 / Opus4.8 0.50)
는 **결정론 경로**(교정→룰 승급 → notepad 재주입)에서 나온다 — **Haiku 불필요**. Haiku 추출은
그 위의 **미입증 보강**이다. → 둘을 분리하면 가치를 지키며 동의 문제를 없앤다.

## Alternatives + Trade-off Matrix

| 기준 | 가중 | A 현상유지 | B 고지+opt-out | C 전면 opt-in | **D 티어드** |
|---|---|---|---|---|---|
| 투명성/동의 | 25% | ★ | ★★★★ | ★★★★★ | ★★★★★ |
| 핵심가치(δ) 보존 | 25% | ★★★★★ | ★★★★★ | ★★ | ★★★★★ |
| 프라이버시 | 20% | ★★ | ★★★ | ★★★★★ | ★★★★ |
| 비용/쿼터 | 15% | ★★★ | ★★★ | ★★★★★ | ★★★★ |
| 구현 복잡도 | 15% | ★★★★★ | ★★★★ | ★★★★ | ★★★ |
| **가중합(5)** | 100% | **3.10** | **3.90** | **4.10** | **4.35** |

- **C(전면 opt-in)**: 투명성 최고지만 median 사용자 미활성 → 결정론 δ 까지 죽어 **가치 붕괴**(★★).
- **D(티어드)**: 유일하게 **가치 만점 + 투명성 만점** 동시. 채택.

## Decision — D (티어드)

1. **default-ON (egress 0)**: 결정론 교정→룰 승급 + notepad 주입 = 입증된 δ 경로. 항상 실행.
2. **Haiku 추출 = opt-in + 설치 고지**: transcript 요약 → Haiku 행동패턴 추론. 명시 동의 시에만.
   - 러너가 `isHaikuCompoundEnabled()` 확인 → false 면 3× Haiku 호출 skip, `promoteSessionCandidates`
     는 그대로 실행.
3. **granular 제어** (`compound-consent.ts`), 우선순위:
   `FORGEN_NO_AUTO_COMPOUND=1`(강제 off) > `FORGEN_AUTO_COMPOUND=1`(강제 on) >
   config `~/.forgen/config.json.autoCompoundHaiku` > **default false(opt-in)**.
   CLI: `forgen compound consent on|off|status`.
4. **고지**: install 시 명시 disclosure + 동의 프롬프트(비대화형은 off + 안내). `forgen doctor` 에 상태.

## Consequences

**긍정**: (a) 입증된 δ 가치는 기본으로 유지, (b) API egress 만 명시 동의·opt-out, (c) cron opt-in
과 일관, (d) forgen "정직/투명" 포지셔닝 강화 — "우리는 당신 몰래 보내지 않는다".

**부정/리스크**: (a) 기존 사용자의 Haiku 추출이 opt-in 전환으로 기본 중단 — pre-release 라 수용,
릴리스 노트 명기. (b) Haiku off 여도 러너는 결정론 승급 위해 spawn(경미 오버헤드). (c) 행동패턴
보강을 안 켜는 사용자는 그 부가가치 미획득 — 명시적 선택이므로 수용.

## Open Questions

1. install 동의 UX: 3-choice(끄기/켜기/나중에) vs 기본 off + 안내만. 초기엔 후자(단순), 필요시 확장.
2. 향후 로컬 추출(on-device 소형 모델)로 Haiku egress 자체를 없앨지 — v0.6+ 검토.
