# Solution Evolution — Phase 4 설계

> Status: **보류 (2026-11-25, 0.8.3)**. 미구현. 문제는 후보 생성이 아니라 선별·회수다(계획 2026-11-25 §3.4). `ch-solution-evolver` 에이전트도 같이 보류.
> 원래 상태: Design (2026-04-16).
> Precedes: Phase 1 (outcome tracking + fitness), delivered in same week.

## 개요

Stanford IRIS Lab의 **meta-harness** (2026년 4월 공개, `stanford-iris-lab/meta-harness`)는 "모델은 고정, 주변 하네스만 자동 최적화" 원칙으로 Propose → Validate → Benchmark → Select 루프를 돌린다. forgen의 Phase 1은 이 루프의 **Select** 축(fitness 측정)만 우선 구현했다. Phase 4는 나머지 축 — 솔루션 후보를 **자동 생성**하고 **진화시키는** 메커니즘을 제공한다.

## forgen과 meta-harness의 본질적 차이

| 축 | meta-harness | Phase 4 forgen |
|---|---|---|
| 후보 평가 비용 | LLM 호출 수백 번 (비싸다) | 사용자 행동 (무료, Phase 1) |
| 후보 실행 방식 | 모든 후보 동시 오프라인 벤치 | 실제 작업에 섞어서 온라인 평가 |
| 평가 기준 | 태스크별 정량 metric (accuracy, pass@N) | fitness (accept/correct/error 비율) |
| 후보 생성자 | Claude Code 프로세스 (격리) | 현재 세션의 Claude (인라인) |
| 실패 허용 범위 | 결과만 영향 | 사용자 작업 방해 금지 — 매우 엄격 |

## 3-Phase 진화 루프

```
(A) 발굴(Discovery)    : 기존 솔루션의 약점을 찾는다
(B) 변이(Mutation)     : 약점 기반 후보를 자동 생성
(C) 선택(Selection)    : 사용자 작업에 섞어 fitness 경쟁
```

### (A) Discovery — 약점 탐지

fitness 데이터에서 다음 신호를 찾는다:

1. **Under-served tags**: correction evidence에 자주 등장하지만 매칭되는 champion 솔루션이 없는 태그 세트
2. **Conflict clusters**: 같은 tag에 fitness가 엇갈리는 솔루션들 (한쪽은 champion, 한쪽은 underperform)
3. **Dead corners**: injected 0인 솔루션이 보유한 고유 태그 (매칭 알고리즘이 닿지 않는 영역)
4. **Volatile solutions**: fitness가 시간에 따라 크게 흔들리는 솔루션 (stable champion은 보존, volatile은 개선 대상)

산출물: `~/.forgen/state/weakness-report-{ts}.json`

### (B) Mutation — 후보 생성

meta-harness의 `propose_claude()`에 해당.

- **트리거**: 수동(`forgen learn evolve`) 또는 주간 scheduler
- **생성자**: Claude agent (`ch-solution-evolver` 신규 agent)
- **입력**: weakness report + 기존 champion 솔루션 5개 (참고 맥락)
- **출력 제약**:
  - 같은 이름 금지 (collision 방지)
  - `source: "evolved"`, `extractedBy: "auto"` 필수
  - 본문 길이 ≤ 1200 chars (cost 축 Pareto)
  - 기존 champion과 tag overlap ≥ 30% AND ≤ 80% (완전 중복/완전 무관 둘 다 거부)
- **검증**: `diagnoseFrontmatter` 통과 + 격리 디렉토리(`~/.forgen/lab/candidates/`)에 먼저 기록
- **Pareto dimension 3개** (meta-harness 차용):
  - fitness 잠재력 (예측치)
  - 길이 (짧을수록 좋음)
  - novelty (기존 champion과의 tag 거리)

### (C) Selection — 온라인 경쟁

meta-harness의 `run_benchmark()`을 **온라인으로** 대체.

1. 후보를 `~/.forgen/me/solutions/`로 승격하되 `status: "candidate"` 마킹
2. 매칭 시 confidence에 **탐색 보너스** 적용 (초기 5회 injection 보호)
   - 이유: cold start에서 한 번도 안 매칭되면 fitness도 측정 불가
3. 5회 injection 누적되면 보너스 제거, fitness 자연 경쟁
4. 10회 누적 시 state 자동 판정:
   - `champion` → promote (정식 솔루션)
   - `active` → keep as candidate
   - `underperform` → quarantine + evolver에 feedback

## 안전장치

1. **auto-delete 절대 금지** (Phase 1과 동일 원칙). 후보도 quarantine까지만.
2. **Rate limit**: 주당 최대 3개 후보 생성. 수십 개 쌓여서 실제 솔루션을 묻는 사고 방지.
3. **Opt-out**: `FORGEN_DISABLE_EVOLUTION=1` 환경변수
4. **User review gate**: 첫 구현에서는 `forgen learn evolve --apply`로 수동 approval 필수. `--auto` 는 향후 옵션으로.
5. **Rollback**: `forgen learn evolve --rollback <timestamp>` 으로 한 주 분량 후보 일괄 제거

## 구현 로드맵 (예상)

| Phase | 기간 | 산출물 |
|---|---|---|
| 4.1 | 3일 | weakness-report 생성기 (Discovery) |
| 4.2 | 1주 | solution-evolver agent + propose pipeline |
| 4.3 | 3일 | candidate 탐색 보너스 + 자동 state 전이 |
| 4.4 | 2일 | `forgen learn evolve` CLI + rollback |
| 4.5 | 3일 | 통합 테스트 + 실제 5~10개 후보 생성으로 dogfooding |

총 ≈ 2주 (실제 사용 데이터 축적 대기 시간 제외).

## 사전 조건 (Phase 1에서 확보)

- [x] fitness 공식 및 state 분류 (`solution-fitness.ts`)
- [x] outcome 이벤트 스트림 (`solution-outcomes.ts`)
- [x] 스키마 검증 및 quarantine (`solution-quarantine.ts`)
- [x] 자동 복구 마이그레이션 (`solution-fixup.ts`)
- [x] `forgen learn` CLI 진입점
- [ ] **데이터 축적** — fitness 분포를 안정적으로 관찰하기 위해 최소 2주 실사용 필요

## Open Questions

| # | 질문 | 현 가설 |
|---|---|---|
| Q1 | cold start 탐색 보너스 크기 | confidence += 0.3 for first 5 injections |
| Q2 | novelty 측정은 tag Jaccard distance로 충분? | bigram similarity 조합 고려 |
| Q3 | weakness report 재계산 주기 | 주 1회 (solutions.jsonl mtime 기반 invalidate) |
| Q4 | evolver agent가 생성한 후보의 promotion 승인 주체 | 초기: 사용자 수동 → 중기: fitness ≥ 2.0 자동 |
| Q5 | 기존 champion은 진화에서 제외? | Yes — 안정적 기반은 건드리지 않는다 |

## 참고

- Stanford meta-harness paper: "Meta-Harness: End-to-End Optimization of Model Harnesses" (2026-04)
- `reference_examples/text_classification/meta_harness.py` — Propose-Benchmark 루프 구조
- `reference_examples/text_classification/.claude/skills/meta-harness/SKILL.md` — 3 mandatory candidates per iteration, novelty gate, prototyping discipline
