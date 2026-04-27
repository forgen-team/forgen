# D2 — Autonomy axis facets 정체 (rule 승급 의존)

## Metadata
- 발견: v0.4.2 forge-loop, US-D1'' AC5 결과
- Trigger: behavior 627건 측정 시 autonomy explicit_correction 6건이 facet 0.50 정중앙
- 상태: 알려진 갭, 별도 fix 필요

## 자기증거
```
explicit_correction 분포 (16건)
  quality_safety: 7  → score 0.65 (이동)
  autonomy:      6  → score 0.50 (정중앙, 6건이 영향 없음)
  judgment:      3  → score 0.50
  communication: 0  → score 0.50
```

## Root cause

`src/forge/evidence-processor.ts:30-44` — explicit_correction 이 들어오면:
1. evidence 저장 (axis_refs 포함) ✅
2. T1 lifecycle trigger 로 candidate_rule 생성 시도 ✅
3. **profile.json axes.facets / score 직접 갱신 코드 없음** ❌

quality_safety 가 0.65 로 이동한 이유는 explicit_correction 직접 반영이 아니라:
- `src/forge/mismatch-detector.ts:86~89` 가 "strong quality rule 신규 생성" 시 signal +1
- mismatch signal 누적 후 별도 reclassification 경로에서 facet 조정

→ **승급된 hard rule 이 있어야만** 그 카테고리의 facet 이 움직임. autonomy 6건은 rule 로 승급되지 않아 (또는 rule 카테고리 매칭 실패) score 정체.

## 영향

자동 추출(D1'' fix 후)이 quality/autonomy 신호를 axis_refs 에 정상 기록해도, **rule 승급 파이프라인이 그 신호를 받아 facet 을 움직이지 않으면** profile axes 점수 변동은 여전히 평탄.

D1'' 는 입력 단(behavior_observation 의 axis_refs 분류)만 fix. **출력 단(profile facets writer)의 직접 경로 부재**가 D2.

## 후속 작업 (별도 PR 권장)

1. `evidence-processor.ts` 에서 explicit_correction 직접 facet delta 적용 (rule 승급 의존 제거)
   - axis_hint='autonomy' + kind='avoid-this' → autonomy.confirmation_independence -= 0.05 같은 직접 매핑
   - rule 승급 후 추가 변동은 별도 layer (이중 누적 방지 cap 필요)
2. mismatch-detector 의 signal → facet writer 명시적 단일 경로 (현재는 reclassification 에 묻혀 있음)
3. behavior_observation 에 대해서도 동일 직접 경로 — 자동 학습이 rule 승급 없이도 facet 미세조정 가능

## 검증 가설 (별도 fix 후)

- explicit_correction(axis_hint='autonomy') 6건 누적 → autonomy.score 0.50 → ≥ 0.55 로 이동 측정 가능
- behavior_observation(axis_refs=['autonomy']) 10건 누적 → autonomy.facets 의 한 facet ≥ 0.05 변동

## 본 forge-loop 에서 닫지 않는 이유

US-D1'' 의 AC1~AC4 는 입력 단 fix 로 닫힘. AC5 는 "수면 위로" 만 요구 — 별도 fix 또는 이슈화 — 이 문서가 그 박제.
