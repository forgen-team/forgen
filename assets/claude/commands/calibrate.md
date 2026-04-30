---
name: calibrate
description: This skill should be used when the user asks to "calibrate, 캘리브레이트, 프로필 보정, 프로필 조정, 프로필 확인". 축적된 evidence(교정 기록)를 분석하여 4축 프로필 조정을 제안합니다.
argument-hint: "[기간: 7d/30d/90d]"
model: opus
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - mcp__forgen-compound__compound-search
  - mcp__forgen-compound__compound-read
  - mcp__forgen-compound__profile-read
  - mcp__forgen-compound__correction-record
triggers:
  - "calibrate"
  - "캘리브레이트"
  - "프로필 보정"
  - "프로필 조정"
  - "프로필 확인"
  - "프로필 업데이트"
---

<Purpose>
사용자가 Claude의 행동을 교정한 기록(evidence)을 분석하여
4축 프로필(quality_safety / autonomy / judgment_philosophy / communication_style)의
조정 방향을 데이터 기반으로 제안합니다.

이 스킬은 forgen에만 존재하는 고유 기능입니다.
"Claude가 나의 스타일을 얼마나 잘 학습하고 있는가"를 정량적으로 확인하고,
축적된 교정 패턴을 바탕으로 프로필을 보정합니다.

핵심 원칙: 추측이 아닌 증거, 점진적 조정, 반드시 사용자 동의.
</Purpose>

<Compound_Integration>
## Evidence 수집 및 Compound 교차 검증

calibrate는 두 가지 데이터 소스를 사용합니다:

### 1차 소스: Evidence 파일
`~/.forgen/me/behavior/` 디렉토리의 JSON 파일을 읽습니다.
(파일명: UUID.json — correction-record MCP 도구가 작성. 같은 디렉토리의 auto-*.md 는 auto-compound 산출이므로 calibrate 분석 대상 아님.)
각 파일의 구조:
```json
{
  "kind": "fix-now | prefer-from-now | avoid-this",
  "axis_hint": "quality_safety | autonomy | judgment_philosophy | communication_style",
  "description": "사용자가 교정한 내용",
  "timestamp": "ISO-8601"
}
```

### 2차 소스: Compound 교정 패턴
compound-search MCP 도구로 교정 관련 축적 패턴을 검색합니다:
```
compound-search("correction profile")
compound-search("교정 패턴")
```

compound에서 발견된 교정 패턴은 evidence와 교차 검증하여
일관된 방향성이 있는지 확인합니다.

### 데이터 부족 시
evidence 0건 + compound 교정 패턴 0건이면:
"아직 교정 데이터가 부족합니다. 더 사용하면서 교정이 쌓이면 다시 실행하세요."
보고 후 즉시 종료합니다.
</Compound_Integration>

<Steps>
## Phase 1: Evidence 로드 및 검증

```bash
ls ~/.forgen/me/behavior/*.json 2>/dev/null || echo "EMPTY"
cat ~/.forgen/me/behavior/*.json 2>/dev/null || echo "NO_FILES"
```

로드한 JSON 파일마다 다음을 검증합니다:
- `kind` 필드가 유효한 값인지 (fix-now, prefer-from-now, avoid-this)
- `axis_hint` 필드가 4축 중 하나인지
- `timestamp`가 지정된 기간 내인지 (기본 30일)

기간 외의 evidence는 분석에서 제외하되, 총 건수는 참고로 표시합니다.

## Phase 2: 현재 프로필 확인

```bash
cat ~/.forgen/me/forge-profile.json 2>/dev/null || echo "프로필 파일 없음"
```

프로필 파일이 없으면 기본값을 사용합니다:
```json
{
  "quality_safety": "balanced",
  "autonomy": "balanced",
  "judgment_philosophy": "balanced",
  "communication_style": "balanced"
}
```

## Phase 3: Compound 교차 검색

```
compound-search("correction profile")
compound-search("교정 행동 패턴")
```

compound 솔루션에서 교정 관련 패턴이 발견되면,
evidence와 방향이 일치하는지 검증합니다.
일치하면 신뢰도를 높이고, 상충하면 별도 표기합니다.

## Phase 4: 축별 교정 분석 (정량 프로토콜)

각 축에 대해 다음 절차를 수행합니다:

### 4-1. 교정 건수 집계
지정 기간 내 해당 axis_hint의 evidence 건수를 셉니다.

### 4-2. 방향 감지
교정 내용의 키워드와 kind를 분석하여 방향을 판별합니다:

**quality_safety**: 보수형("확인 더 해줘","테스트 먼저") vs 속도형("그냥 해","빨리")
**autonomy**: 자율실행형("왜 물어봐","알아서 해") vs 확인우선형("먼저 물어봐","확인하고")
**judgment_philosophy**: 최소변경형("너무 많이 바꿨어","최소한만") vs 구조적접근형("근본적으로","구조적으로")
**communication_style**: 간결형("너무 길어","짧게","코드만") vs 상세형("더 자세히","왜인지 설명")

### 4-3. 방향 점수 계산
```
방향 점수 = (해당 방향 교정 건수) - (반대 방향 교정 건수)
kind 보정: fix-now은 1.5배, prefer-from-now과 avoid-this는 1.0배
```

### 4-4. 임계값 판정
- 같은 방향 교정 3건 이상 AND 방향 점수 >= 2 --> 변경 제안
- 같은 방향 교정 1~2건 --> "데이터 부족, 유지" (관찰 중 표기)
- 교정 0건 --> "현재 설정 유지"

## Phase 5: 조정 제안 구성 (최대 2축 제한)

변경 제안 대상이 3개 이상이면 방향 점수 상위 2개만 제안합니다.
한 번에 한 단계만 이동합니다 (balanced→conservative, 두 단계 점프 금지).

## Phase 6: 사용자 확인 및 적용

선택지: Y(전체 적용) / n(취소) / 커스텀(축별 개별 선택)
동의 시에만 forge-profile.json을 업데이트하고, 변경 이력을 calibration-log로 저장합니다.
</Steps>

<Failure_Modes>
## 피해야 할 실패 패턴

- evidence 없이 추측: 교정 데이터 0건이면 분석하지 않는다. "느낌상" 조정을 절대 제안하지 않는다.
- 단일 교정으로 변경 제안: 같은 방향 3건 이상일 때만 제안한다. 1건은 과적합이다.
- 모든 축 동시 변경: 한 번에 최대 2개 축만 조정 제안한다.
- 두 단계 이상 점프: balanced에서 strict로 한 번에 뛰지 않는다.
- 확인 없이 프로필 변경: 반드시 사용자 동의 후 수정한다. 자동 적용은 절대 없다.
- 방향 상충 무시: 같은 축에서 양방향 교정이 혼재되면 변경하지 않고 명확화를 요청한다.
- compound 데이터 맹신: evidence와 교차 검증 후에만 신뢰도 보조로 사용한다.
</Failure_Modes>

<Output>
```
PROFILE CALIBRATION / 프로필 보정
═════════════════════════════════
기간: 최근 30일 | 세션: {N}개 | 교정: {N}개

현재 프로필:
  quality_safety:      {value} ({facet_detail})
  autonomy:            {value} ({facet_detail})
  judgment_philosophy: {value} ({facet_detail})
  communication_style: {value} ({facet_detail})

교정 분석:
  quality_safety:
    교정 {N}건: "{example1}", "{example2}"
    방향: {direction} (점수: +{score})
    → {new_value}(으)로 변경 제안? [Y/n]

  autonomy:
    교정 0건 → 현재 설정 유지

  judgment_philosophy:
    교정 1건 → 충분하지 않음 (3건 이상 필요). 유지 (관찰 중)

  communication_style:
    교정 4건: "너무 길어", "간결하게", "코드만", "설명 줄여"
    방향: 간결형 (점수: +4)
    → 간결형으로 변경 제안? [Y/n]

Compound 교차 검증:
  quality_safety: compound에서 "테스트 우선" 패턴 2건 발견 → evidence와 일치
  communication_style: compound에서 "간결 선호" 패턴 1건 발견 → evidence와 일치

변경 요약: 2개 축 조정 제안 (quality_safety, communication_style)
적용하시겠습니까? [Y/n/커스텀]
```
</Output>

<Policy>
- 교정 데이터 0건이면 "데이터 부족" 보고 후 즉시 종료합니다.
- 같은 방향 교정 3건 이상, 방향 점수 2 이상일 때만 변경을 제안합니다.
- 한 번에 최대 2개 축만 조정을 제안합니다.
- 한 번에 한 단계만 이동합니다 (두 단계 점프 금지).
- forge-profile.json 수정은 반드시 사용자 동의 후 진행합니다.
- 방향이 혼재된 축은 변경하지 않고 사용자에게 명확화를 요청합니다.
- compound 데이터는 evidence와 교차 검증 후에만 신뢰도 보조로 사용합니다.
</Policy>

<Arguments>
## 사용법
`/forgen:calibrate [기간]`

### 기간 옵션
- 인수 없음: 최근 30일 (기본값)
- `7d`: 최근 7일
- `30d`: 최근 30일
- `90d`: 최근 90일
- `all`: 전체 기간

### 예시
- `/forgen:calibrate` -- 최근 30일 기본 분석
- `/forgen:calibrate 7d` -- 최근 1주일 집중 분석
- `/forgen:calibrate 90d` -- 분기별 종합 보정
</Arguments>

$ARGUMENTS
