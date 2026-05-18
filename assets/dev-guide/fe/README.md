# fe-guide — 사내 프론트엔드 스킬 (Claude + Codex)

> AI 코딩 에이전트가 사내 합의된 FE 원칙대로 *구현 / 리뷰 / 성능 진단* 하게 만드는 스킬 번들.
> 단일 소스 (이 폴더), 양쪽 어댑터 (Claude SKILL.md / Codex AGENTS.md).

## 1. 무엇이 들어있는가

```
fe-guide/
├─ sources/          # 원본 코퍼스 (수집일 2026-05-18)
│  ├─ toss-ff/         Toss Frontend Fundamentals 4원칙 19파일
│  ├─ react/           React 19 + Compiler + RSC 11파일
│  ├─ vue/             Vue 3 + Pinia + Nuxt 9파일
│  ├─ perf/            web.dev (Core Web Vitals 2024 INP) + Next.js 16 캐싱 11파일
│  └─ a11y-dx/         WCAG 2.2 + Chrome/React DevTools 5파일
├─ principles/       # 합의 원칙 (코퍼스 위에서 사내 의사결정)
│  ├─ common.md        프레임워크 중립 (4원칙 + Vitals + WCAG)
│  ├─ react.md         React/Next 특화
│  └─ vue.md           Vue/Nuxt 특화
├─ skills/           # 실제 호출되는 스킬
│  ├─ react/{fe-build,fe-review,fe-perf}/SKILL.md
│  └─ vue/{fe-build,fe-review,fe-perf}/SKILL.md
├─ adapters/
│  ├─ build-agents-md.sh   SKILL.md → Codex AGENTS.md 변환
│  └─ refresh.sh           코퍼스 재수집 워크플로우 (수동)
└─ README.md
```

3개 스킬 × 2개 스택 = **6개 스킬**:

| 스킬 | 호출 시점 | 무엇을 해주는가 |
|------|-----------|----------------|
| **fe-build** | "이 명세대로 구현해줘" | 명세→체크리스트→테스트 매핑 강제, 원칙대로 코드 작성 |
| **fe-review** | "이 PR 리뷰해줘" | `[SEVERITY] file:line — 이슈` 형식 리뷰 |
| **fe-perf** | "느려졌어 / 메모리 누는 것 같아" | DevTools 절차 + 흔한 패턴별 픽스 |

## 2. Claude Code 사용법

### 2.1 전역 설치 (모든 프로젝트에서 사용)

```bash
# 1. fe-guide 를 원하는 위치에 clone (또는 이미 받아둔 경로)
export FE_GUIDE_ROOT=~/work/fe-guide   # 본인 환경에 맞게

# 2. ~/.claude/skills 에 심볼릭 링크
cd ~/.claude/skills
ln -s "$FE_GUIDE_ROOT/skills/react/fe-build"  fe-build-react
ln -s "$FE_GUIDE_ROOT/skills/react/fe-review" fe-review-react
ln -s "$FE_GUIDE_ROOT/skills/react/fe-perf"   fe-perf-react
ln -s "$FE_GUIDE_ROOT/skills/vue/fe-build"    fe-build-vue
ln -s "$FE_GUIDE_ROOT/skills/vue/fe-review"   fe-review-vue
ln -s "$FE_GUIDE_ROOT/skills/vue/fe-perf"     fe-perf-vue
```

이후 Claude Code 에서:
```
/fe-build-react  # 또는 자연어로 "fe-build-react 스킬로 이 명세 구현해줘"
```

### 2.2 프로젝트별 설치 (저장소에 묶어 배포)

```bash
cd <your-repo>
mkdir -p .claude/skills
ln -s "$FE_GUIDE_ROOT/skills/react/fe-build" .claude/skills/fe-build
# 또는 git submodule / sparse-checkout 으로 fe-guide 자체를 묶음
```

`.claude/skills/` 의 SKILL.md 는 Claude Code 가 자동 인식.

## 3. Codex CLI 사용법

Codex 는 프로젝트 루트의 `AGENTS.md` (또는 `~/.codex/AGENTS.md` 전역) 를 읽음.

### 3.1 AGENTS.md 생성

```bash
export FE_GUIDE_ROOT=~/work/fe-guide
export FE_GUIDE_SOURCE="사내 공유 fe-guide v2026-05-18 (배포: <본인 이름>)"  # AGENTS.md 출처 표기용 (선택)

cd <your-repo>
"$FE_GUIDE_ROOT/adapters/build-agents-md.sh" react fe-build > AGENTS.md

# 또는 여러 스킬 합치기:
{
  "$FE_GUIDE_ROOT/adapters/build-agents-md.sh" react fe-build
  echo
  "$FE_GUIDE_ROOT/adapters/build-agents-md.sh" react fe-review
  echo
  "$FE_GUIDE_ROOT/adapters/build-agents-md.sh" react fe-perf
} > AGENTS.md
```

생성된 `AGENTS.md` 는 Codex 가 매 세션 자동 로딩. principles/sources 는 같은 폴더에서 직접 참조 가능 (저장소 안에 fe-guide 포함하거나 심볼릭 링크).

### 3.2 sources/principles 도 같이 배포

`AGENTS.md` 가 `principles/common.md`, `sources/toss-ff/*` 를 참조하므로:

- **Option A** — `fe-guide/` 자체를 저장소에 git submodule 로 포함
- **Option B** — 빌드 시 `cp -R fe-guide/{principles,sources} <repo>/.fe-guide/` (배포물)
- **Option C** — 사내 npm 패키지로 배포 후 `node_modules/@company/fe-guide`

권장: **A (submodule)** — 버전 명시적, AI가 직접 참조 가능.

## 4. 사용 시나리오 예시

### 4.1 fe-build

```
사용자: 첨부한 요구사항 명세대로 주문 상세 페이지 구현해줘.
       /fe-build-react

AI: ## 체크리스트
    - [ ] R-01: "옵션은 그리드/셀렉트 두 종류이며, 셀렉트는 옵셔널이다"
    - [ ] R-02: "..."
    ...
    빠진 항목이 있으면 알려주세요. 없으면 매핑표 → TDD 들어갑니다.
```

### 4.2 fe-review

```
사용자: PR #123 리뷰. 요구사항 명세는 attached.
       /fe-review-react

AI: ## 리뷰 요약
    - 변경: 8 files +312 -45
    - HIGH 3, MED 5, LOW 2 / 머지 차단

    [HIGH] src/pages/order/OrderForm.tsx:88 — select 옵션 옵셔널인데 검증에서 차단
    ...
```

### 4.3 fe-perf

```
사용자: 주문 페이지에서 옵션 선택할 때 INP가 480ms 나와. 잡아줘.
       /fe-perf-react

AI: ## INP 진단
    - 분류: CPU/렌더 병목
    - 측정 절차: web-vitals/attribution 로 inputDelay/processing/presentation 분해...
    - 가설: 핸들러 안 동기 필터링
    - 검증 후 픽스: startTransition + useDeferredValue
```

## 5. 유지보수

### 5.1 코퍼스 갱신

외부 사이트 (react.dev, web.dev 등) 가 자주 바뀌므로 **월 1회 수동 갱신** 권장:

```bash
./adapters/refresh.sh --check   # 마지막 수집 날짜 확인
./adapters/refresh.sh           # 재수집 절차 안내
```

재수집은 Claude/Codex 에이전트에게 위임이 가장 안정:

```
sources/<dir>/INDEX.md 의 출처들을 최신화해서 같은 형식으로 재저장해줘
```

### 5.2 principles 수정 시

`principles/*.md` 는 사내 합의 문서. 수정 시:
1. 출처 (sources/ 또는 외부 URL) 명시
2. 변경 이력 PR 로 남김
3. 영향받는 SKILL.md 의 참조 위치 확인

### 5.3 새 스킬 추가

`skills/<stack>/<name>/SKILL.md` 한 파일 추가 + `adapters/build-agents-md.sh` 그대로 사용.

## 6. 출처 우선순위 (충돌 시)

코퍼스 간 충돌 발생 시 `principles/common.md` 에 명시된 순서 적용:

1. Toss FF (코드 품질 4원칙)
2. web.dev (성능 임계값)
3. WCAG 2.2 (접근성)
4. React.dev / Vue.js / Nuxt (프레임워크 공식)
5. Vercel / Meta engineering (벤더 권장)

사용자 영향 우선순위: **a11y > perf > 가독성**.

## 7. 라이선스 / 출처 주의

- Toss FF: Apache-2.0 (frontend-fundamentals)
- React.dev / web.dev: CC BY 4.0
- Vue.js / Nuxt: MIT
- 사내 배포 시 각 코퍼스 원본 출처 보존 (sources/<dir>/INDEX.md 에 명시됨)

## 8. 관련 문서

- fe-build/fe-review 의 "명세→체크리스트→테스트 매핑" 강제는 다수의 실패 사례에서 도출된 패턴 — 표시(UI 분기)와 검증(로직 분기) 불일치 회피가 핵심.
