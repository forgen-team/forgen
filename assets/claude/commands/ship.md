---
name: ship
description: This skill should be used when the user asks to "ship, 배포, 릴리스, release". 비대화형 자동 릴리스 파이프라인 — 테스트, 리뷰, 버전, CHANGELOG, PR을 원커맨드로.
argument-hint: "[patch|minor|major]"
model: inherit
disable-model-invocation: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Agent
  - Edit
  - Write
triggers:
  - "ship"
  - "배포"
  - "릴리스"
  - "release"
  - "릴리즈"
  - "배포해줘"
---

<Purpose>
"사용자가 /ship이라고 했으면 실행하라."

테스트 -> 리뷰 -> 버전 범프 -> CHANGELOG -> 커밋 -> PR 생성까지의 릴리스 파이프라인을 완전 자동화합니다.
사용자에게 묻지 않습니다. 중단 사유가 아닌 한 끝까지 진행합니다.

### 중단 사유 (이것만 멈춘다)
- main/master 브랜치에서 직접 실행 (abort)
- 해결 불가능한 머지 충돌
- 테스트 실패
- CRITICAL 리뷰 발견
- MAJOR 버전 범프 결정 (사용자 확인 필요)

이 외의 모든 상황은 자동 판단하여 진행합니다.
</Purpose>

<Compound_Integration>
## Compound-In: 이전 릴리스 이슈 로드

Step 1.5에서 실행합니다.

```
compound-search("ship release 이슈 배포 실패")
```

이전 릴리스에서 발생한 문제 패턴을 확인합니다.
결과가 있으면 해당 체크포인트를 강화합니다.

## Compound-Out: 릴리스 이슈 기록

Step 10에서 실행합니다.
릴리스 중 발생한 이슈가 있었으면 compound troubleshoot로 기록을 제안합니다.
</Compound_Integration>

<Steps>
## Step 0: 플랫폼 감지 + 베이스 브랜치 감지

```bash
# 플랫폼 감지
if command -v gh &>/dev/null && gh repo view &>/dev/null; then
  PLATFORM="github"
elif command -v glab &>/dev/null; then
  PLATFORM="gitlab"
else
  PLATFORM="unknown"
fi

# 베이스 브랜치 감지
BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if [ -z "$BASE" ]; then
  BASE=$(git branch -r | grep -E 'origin/(main|master)' | head -1 | sed 's@.*origin/@@' | tr -d ' ')
fi
```

## Step 1: Pre-flight 체크

```bash
BRANCH=$(git branch --show-current)

# main/master -> ABORT
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "ABORT: main/master 브랜치에서 직접 릴리스할 수 없습니다."
  exit 1
fi

git status --porcelain
git diff --stat
git diff --staged --stat
```

- main/master -> ABORT (새 브랜치 제안하지 않음. 그냥 중단.)
- 미커밋 변경 -> 자동 커밋 ("chore: stage uncommitted changes before release")

## Step 1.5: Compound-In

```
compound-search("ship release 배포 이슈")
```

이전 문제 패턴이 있으면 체크포인트 강화. 없으면 조용히 진행.

## Step 2: 베이스 브랜치 머지

```bash
git fetch origin $BASE
git merge origin/$BASE --no-edit
```

- 충돌 -> ABORT ("머지 충돌 발생. 수동 해결 후 다시 /ship하세요.")

## Step 3: 테스트 실행

```bash
# 자동 감지: package.json -> vitest/jest -> pytest -> cargo test -> go test
if [ -f package.json ]; then
  if grep -q '"test"' package.json; then npm test
  elif command -v vitest &>/dev/null; then npx vitest run
  fi
elif [ -f pytest.ini ] || [ -f pyproject.toml ]; then pytest
elif [ -f Cargo.toml ]; then cargo test
elif [ -f go.mod ]; then go test ./...
fi
```

- 전체 통과 -> Step 3.5
- 1개라도 실패 -> ABORT

## Step 3.5: 테스트 커버리지 감사 (선택)

```bash
npx vitest run --coverage 2>/dev/null || true
```

커버리지는 정보 제공용. 미달로 중단하지 않음.

## Step 4: Pre-landing 리뷰

ch-code-reviewer 에이전트(READ-ONLY) 위임.

```bash
git diff $BASE...HEAD
```

- CRITICAL -> ABORT
- AUTO-FIX (데드 코드, 미사용 import, stale 주석) -> 직접 수정 + 커밋
- 판단 필요 -> 사용자에게 질문
- APPROVED -> Step 5

## Step 5: 버전 범프

### 인수가 있으면: 인수 그대로 사용
### 없으면 자동 판단:
- < 50줄 -> PATCH (자동)
- 50줄+ 기능 없음 -> PATCH (자동)
- 기능 신호 (feat/, 새 라우트) -> MINOR (확인)
- Breaking change -> MAJOR (확인)

```bash
npm version {patch|minor|major} --no-git-tag-version
```

## Step 6: CHANGELOG 생성

커밋을 주제별 그룹핑 -> CHANGELOG.md 상단에 추가.

## Step 6.5: Smoke 증거 생성 (forgen 레포 한정)

forgen 레포 자체를 ship 할 때는 릴리스 커밋 전에 smoke 증거를 생성한다
(ADR-010 W0-2 — CI self-gate 가 릴리스 커밋에서 smoke-report 를 요구).

```bash
# forgen 레포에서만. vitest 는 Step 3 에서 이미 돌았지만 게이트 증거는
# smoke.cjs 산출물만 인정 — 전체 실행 (실제 프로세스 산출물 원칙).
if [ -f scripts/smoke.cjs ]; then
  node scripts/smoke.cjs || ABORT
fi
```

- 실패 -> ABORT ("smoke 증거 생성 실패 — 게이트 통과 불가")

## Step 7: 릴리스 커밋

```bash
git add package.json package-lock.json CHANGELOG.md
# forgen 레포: smoke 증거 포함
[ -f .forgen-release/smoke-report.json ] && git add .forgen-release/smoke-report.json
git commit -m "release: v{version}"
```

## Step 8: Push

```bash
git push -u origin $(git branch --show-current)
```

force push 절대 안 함.

## Step 9: PR 생성

```bash
gh pr create --title "release: v{version}" --body "..."
```

## Step 10: Compound-Out

이슈가 있었으면 compound troubleshoot로 기록 제안.
</Steps>

<Review_Readiness_Dashboard>
```
+============================================+
|         REVIEW READINESS                    |
+============================================+
| Check              | Status    | Required  |
|--------------------|-----------|-----------|
| Tests              | {N} PASS  | YES       |
| Code Review        | {result}  | YES       |
| Build              | {result}  | YES       |
| Coverage           | {N}%      | no        |
| Base Merge         | CLEAN     | YES       |
+============================================+
| VERDICT: {READY TO SHIP / BLOCKED}         |
+============================================+
```
</Review_Readiness_Dashboard>

<Verification_Gate>
## 검증의 철칙 (IRON LAW)

```
"아마 될 거야"        -> 실행해라.
"확신이 있다"         -> 확신은 증거가 아니다.
"아까 테스트했는데"    -> 코드가 바뀌었다. 다시 테스트해라.
"사소한 변경이라"      -> 사소한 변경이 프로덕션을 깨뜨린다.
"이건 리뷰 안 해도"   -> 모든 diff는 리뷰한다.
```

실행 결과가 곧 증거입니다. 실행하지 않은 검증은 존재하지 않습니다.
</Verification_Gate>

<Failure_Modes>
**테스트 실패 상태에서 진행**: 0 failures만 통과.
**main 브랜치에서 직접 실행**: ABORT. 새 브랜치 제안도 안 함.
**머지 충돌 자동 해결**: 충돌은 사용자가 수동 해결.
**CRITICAL 리뷰 이슈 무시**: CRITICAL 1개라도 있으면 ABORT.
**force push**: 어떤 상황에서도 사용하지 않음.
**불필요한 질문**: /ship은 비대화형. 중단 사유만 보고.
</Failure_Modes>

<Output>
## 성공 시

```
SHIP COMPLETE / 배포 완료
=========================
Version: {old} -> {new} ({type})
Tests:   {N} passed, 0 failed
Review:  APPROVED ({N} auto-fixed)
PR:      #{number}
URL:     {url}
```

## 실패 시

```
SHIP ABORTED / 배포 중단
=========================
Step:    {실패한 Step}
Reason:  {중단 사유}
Action:  {다음 행동}
```
</Output>

<Policy>
- 테스트 통과는 필수. 예외 없음.
- CRITICAL 리뷰 이슈 -> 사용자 동의 없이 진행하지 않음.
- main 브랜치 직접 릴리스 = ABORT.
- 중단 사유가 아닌 한 묻지 않고 끝까지 진행.
- 실행 결과 = 증거. 추측 != 검증.
- force push 금지.
- AUTO-FIX는 데드 코드/미사용 import/stale 주석에만 적용.
</Policy>

<Arguments>
- `patch`: 버그 수정 릴리스 (0.0.X)
- `minor`: 하위 호환 새 기능 릴리스 (0.X.0)
- `major`: 하위 비호환 변경 릴리스 (X.0.0)
- 생략 시: 변경 내용 자동 분석하여 결정 (major만 사용자 확인)
</Arguments>

$ARGUMENTS
