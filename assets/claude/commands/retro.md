---
name: retro
description: This skill should be used when the user asks to "retro, 회고, retrospective, 돌아보기". Git 메트릭 + compound 건강도 + 학습 추세를 교차 분석하는 회고 리포트.
argument-hint: "[7d|14d|30d] [compare]"
model: inherit
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
triggers:
  - "retro"
  - "회고"
  - "retrospective"
  - "돌아보기"
  - "주간 회고"
  - "월간 회고"
  - "주간회고"
  - "월간회고"
---

<Purpose>
git log + compound 통계 + 교정 기록을 교차 분석하여 최근 기간의 개발 패턴을 파악합니다.
"잘 하고 있는가"가 아니라 "어디서 반복 마찰이 생기는가"를 발견하는 것이 목적입니다.
데이터 없이 추측하지 않습니다. 모든 분석은 실제 수집된 데이터에 근거합니다.
</Purpose>

<Compound_Integration>
## Compound 데이터 활용

retro는 compound stats를 핵심 데이터 소스로 사용합니다.

분석 신호:
- 활용률 낮음 -> 축적은 되지만 재사용 안 됨 (검색 키워드 품질 문제)
- stale 많음 -> 정리 필요 (`/learn prune` 추천)
- experiment 비율 높음 -> 검증 없이 축적만 됨
- mature 비율 높음 -> 건강한 지식 베이스
</Compound_Integration>

<Steps>
## Phase 1: 데이터 수집

기간 기본값: 7d
`$ARGUMENTS`에서 파싱 (7d, 14d, 30d, compare).

### 1-1: Git 활동 데이터

```bash
# 커밋 이력
git log --since="{period}" --oneline --stat --format="%h|%an|%ai|%s"

# 기여자별 커밋
git shortlog --since="{period}" -sn

# 핫스팟 (파일별 변경 빈도)
git log --since="{period}" --name-only --pretty=format: | sort | uniq -c | sort -rn | head -10

# 변경 줄 수
git log --since="{period}" --stat --format="" | tail -1
```

### 1-2: Compound 데이터

```
compound-stats
compound-list
```

### 1-3: 교정 기록

```bash
ls -la ~/.forgen/me/behavior/ 2>/dev/null || echo "교정 데이터 없음"
find ~/.forgen/me/behavior/ -name "*.json" -mtime -{period_days} 2>/dev/null | wc -l
```

## Phase 2: 코드 활동 분석

- 커밋 수 (일 평균 포함)
- +추가 / -삭제 비율
- 핫스팟 Top 5 (3회+ 수정 -> 불안정 영역)

## Phase 3: 세션 패턴 분석

```
세션 분리: 45분+ 간격 = 새 세션
```

- 세션 수, 평균 길이
- 시간대 분포 (정보 제공용, 판단은 사용자에게)

## Phase 4: Compound 건강도 분석

```
총 솔루션, 상태별/유형별 비율, 활용률, stale 후보
```

건강도 판정:
- HEALTHY: mature 20%+, stale < 5, 활용률 30%+
- ATTENTION: experiment 40%+, 또는 stale 5-10
- NEEDS CARE: stale 10+, 또는 활용률 10% 미만

## Phase 5: 학습 추세 분석

- 교정 감소 -> 학습 중 (좋은 신호)
- 교정 증가 -> 드리프트 발생
- 동일 축 반복 -> `/calibrate` 권장
- 데이터 없음 -> "교정 데이터 없음" 표시

## Phase 6: 추천 생성 (반드시 3개)

데이터 근거 규칙:
- 핫스팟 존재 -> `/code-review {파일}`
- stale 5개+ -> `/learn prune`
- 동일 교정 3회+ -> `/calibrate`
- experiment 40%+ -> compound 품질 개선
- 활용률 10% 미만 -> compound 검색 개선
- 커밋 급감 -> 블로커 확인
</Steps>

<Compare_Mode>
## Compare 모드

`/retro compare` 또는 `/retro 14d compare`

```bash
# 현재 기간
git log --since="{period}" --oneline --stat
# 이전 기간
git log --since="{period*2}" --until="{period}" --oneline --stat
```

```
COMPARE / 기간 비교
════════════════════
                 Previous {N}d    This {N}d    Delta
Commits:              {N}            {N}       {+/-N}%
LOC:                +{N}           +{N}        {+/-N}%
Files:                {N}            {N}       {+/-N}%
Hotspot:         {file}({N})    {file}({N})    {NEW/SAME/GONE}
Sessions:             {N}            {N}       {+/-N}%
Compound hits:        {N}            {N}       {+/-N}%
Corrections:          {N}            {N}       {+/-N}% {arrow}
```

Delta 해석:
- 커밋 증가 + 교정 감소 -> 생산성 + 학습 (최고)
- 커밋 감소 + 핫스팟 동일 -> 같은 파일에서 막힘 (구조적 문제)
- Compound hits 증가 -> 복리 효과 발현
</Compare_Mode>

<Failure_Modes>
**데이터 없이 추측**: git log + compound stats 수집 후 분석. 느낌 기반 회고 금지.
**긍정만 보고**: 핫스팟, stale, 개선점 반드시 포함. 칭찬 보고서는 가치 없음.
**추천 없는 보고서**: 반드시 3개 next action. "계속 잘 하세요"는 추천이 아님.
**기간 무시**: `--since` 파라미터 정확 적용.
**세션 패턴 판단**: 데이터만 보여주고 판단은 사용자에게.
</Failure_Modes>

<Output>
```
RETRO / 회고
════════════
기간: {start} ~ {end}

CODE ACTIVITY
─────────────
커밋: {N}개 (일 평균 {N}개) | +{N} / -{N} | 파일: {N}개
세션: {N}개 (평균 {N}분)

핫스팟:
  1. {file} ({N}회 수정) <- 구조 리뷰 권장
  2. {file} ({N}회 수정)
  3. {file} ({N}회 수정)
  4. {file} ({N}회 수정)
  5. {file} ({N}회 수정)

COMPOUND HEALTH [{HEALTHY/ATTENTION/NEEDS CARE}]
───────────────
총: {N}개 | mature: {N} | verified: {N} | candidate: {N} | experiment: {N}
활용률: {N}% (지난주 대비 {+/-N}%)
Stale 후보: {N}개
신규: +{N}개 | 승격: +{N}개 | 은퇴: -{N}개

LEARNING TREND
──────────────
교정: {N} -> {N} ({down/up/flat} {arrow})
드리프트: {N}회

RECOMMENDATIONS
───────────────
1. {action} -- {data-backed reason}
2. {action} -- {data-backed reason}
3. {action} -- {data-backed reason}
```
</Output>

<Policy>
- 데이터 수집 없이 회고 시작하지 않음.
- 기간 없으면 7d 기본.
- 추천은 수집된 데이터에만 근거. 추측 금지.
- 추천 반드시 3개.
- compare 모드: 두 기간 delta 시각화.
- 핫스팟 Top 5.
- compound 건강도 3단계 판정.
</Policy>

<Arguments>
- `7d`: 최근 7일 회고 (기본값)
- `14d`: 최근 14일 회고
- `30d`: 최근 30일 회고
- `compare`: 현재 기간 vs 이전 동일 기간 비교
- `14d compare`: 14일 회고 + 기간 비교
</Arguments>

$ARGUMENTS
