# forgen 기능 로드맵 초안 (Track A+B 종합) — 2026-07-21

> 입력: `forgen-internal-audit-2026-07-21.md`(A: 정리) + `competitor-adoption-2026-07-21.md`(B: 채택).
> 목적: "중요한 기능만 남기고, 어떻게 살을 붙일지" 초안. **사용자와 설계 확정 전 논의용.**

## 핵심 통찰 — 정리와 채택이 만나는 지점

두 분석이 우연히 같은 곳을 가리킨다:
- A의 최대 정리 대상 = **상태-표시 명령 10개 난립**(stats/health/dashboard/me/retro/
  recall/explain/watch/inspect/last-block, ~1800줄).
- B의 채택 후보 #3 = **HUD/status line으로 invisible 가치 가시화**(회상·교정·ROI 카운터).

→ **이 둘은 한 작업이다.** 10개 상태 명령을 `forgen status` 하나로 통합하면서, 그
통합 데이터를 **statusline HUD**로 상시 노출하면 "정리"와 "새 기능"을 동시에 달성.
forgen의 최대 약점("가치가 안 보임")을 정리 작업이 곧바로 해소.

마찬가지로:
- A의 "full 주입이 4000자 budget 압박" ↔ B #2 "3층 토큰효율 회상" — 같은 문제/해법.
- A의 "compound export/import(최근 추가)" ↔ B #1 "패턴단위 신뢰도 공유" — 이미 착지한
  기반 위에 신뢰도 스코어만 얹으면 됨.

## 제안 구조 — 3개 웨이브

### Wave 1 — 정리 + 가시화 (기반 다지기, prune-heavy)
목표: 표면 축소로 "중요 기능만" + invisible 가치 가시화. 신규 리스크 낮음.

| 항목 | A/B | 무엇 | 난이도 |
|---|---|---|---|
| **W1-1 status 통합** | A§2.1 + B#3 | 상태 10명령 → `forgen status [--compound\|--profile\|--blocks\|--live]` 단일 진입, 기존은 alias/deprecate | M |
| **W1-2 statusline HUD** | B#3 | 통합 데이터를 상태줄에 실측 카운터로(주입 N·교정 N·ROI강등 N·차단 N). 전부 비조작 | S~M |
| **W1-3 dev 네임스페이스** | A§2.2 | probe-workflow/parity/migrate/backfill/regress-map 등 → `forgen dev <>` 또는 help 숨김 | S |
| **W1-4 개인화 진입 명확화** | A§2.3 | forge 단일관문(onboarding=첫실행, calibrate=점검모드), deep-interview=요구분석 전용 | S |

### Wave 2 — 회상·개인화 강화 (채택, 정합도 높은 것부터)
목표: forgen이 *이미 실측 중인 데이터*를 재활용해 조작 없이 강화.

| 항목 | B# | 무엇 | 난이도 | 가드 |
|---|---|---|---|---|
| **W2-1 패턴단위 신뢰도 공유** | #1 | compound export/import에 패턴별 신뢰도 동반(이미 있는 export를 단위화) | S~M | 신뢰도=실측, human-confirm import(이미 probation 있음) |
| **W2-2 3층 토큰효율 회상** | #2 | full 주입 → 압축인덱스 먼저 + full은 acted 후보만. ROI 루프 시너지 | M | context-diet 정합 |
| **W2-3 TTL 프루닝+감쇠** | #5 | 시간기반 신뢰도 감쇠 + pending TTL(오래된 룰 위생) | S | ROI(surfaced≫acted)와 축 분리 |
| **W2-4 프로젝트 스코핑+주입상한** | #6 | 룰 project/global 태그 + 세션 주입 상한(budget 안정) | S | 4000자 budget 대체·보강 |
| **W2-5 `<private>` 캡처 제외** | #8 | 민감내용 교정/솔루션 캡처 제외 태그 | S | $0-로컬·프라이버시 정합 |

### Wave 3 — 선택적 확장 (논의 필요, 리스크/범위 큼)
| 항목 | B# | 무엇 | 판단 포인트 |
|---|---|---|---|
| **W3-1 완료가드 재포지셔닝** | #4 | Stop훅을 "차단"→"audit 통과까지 goal 재주입". forge-loop와 결합 | 정직: 강제완료 아니라 audit-gated여야. OMC/OMO 텃밭과 중복 주의 |
| **W3-2 교정 클러스터링→승급 제안** | #7 | 반복 교정을 명명 룰로 클러스터, human-confirm 승급 | 클러스터링 알고리즘 설계 필요(ECC 내부 미공개). 신뢰도 조작 금지 |
| **W3-3 멀티하네스 P1(OpenCode)** | 갭#13 | 기존 HostBinding P0 위에 OpenCode 어댑터 | 별도 대형 트랙(이미 플랜 존재), δ 측정 가능 유일 신규 타깃 |

## Anti-adopt (초안에서 제외 확정)
- neural 벤치 마케팅 / 헤비 오케스트레이션 / 페르소나 스프롤 (B§D). wedge 희석.

## 논의가 필요한 결정 포인트 (사용자)
1. **정리 강도**: 상태 10명령을 통합하되 기존 명령을 (a)즉시 제거 (b)deprecate alias 유지
   (c)그대로 두고 status만 추가 — 어디까지?
2. **Wave 순서**: W1(정리+가시화) 먼저가 안전. 아니면 W2-1(팀 공유, 셀링 직결)을 앞당길지?
3. **에이전트 14개**: forgen 고유만 남기고 감축 vs 유지? (사용자 에이전트 세트와 중복)
4. **완료가드(W3-1)**: 약해지는 자산을 재포지셔닝으로 살릴지 vs 결정적 가드만 남기고 접을지?
5. **범위**: 이번 사이클은 Wave 1만? W1+W2? W3까지?

## 권고 (초안)
- **Wave 1부터** — 정리가 곧 가시화라 순효과 즉시, 리스크 최소. 특히 W1-1+W1-2(status
  통합→HUD)는 A·B가 합류하는 최고 ROI 지점.
- 그다음 **W2-1(팀 공유)** — 이미 있는 export 위에 신뢰도만, 셀링 직결, 조작위험 0.
- W3는 별도 논의(완료가드 철학·멀티하네스 대형트랙).
