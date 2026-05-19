---
name: fe-review-vue
description: Vue 3/Nuxt 3 PR/diff를 사내 원칙 기반으로 리뷰. `[SEVERITY] file:line — 이슈` 형식. 4원칙 + Web Vitals + WCAG 2.2 + Composition API/반응성 함정 체크.
---

# fe-review (Vue)

> **호출 시점**: PR 링크, diff, 변경 파일 목록.
> **선행 로딩**: `principles/common.md` + `principles/vue.md`.

## 0. 출력 형식

```
[SEVERITY] path/to/file.vue:42 — <한 줄 이슈>
  근거: principles/<doc>.md <섹션>
  픽스: <코드 또는 한 줄 처방>
```

`HIGH` / `MED` / `LOW`.

리뷰 시작 시:
```
## 리뷰 요약
- 변경 범위: <files / +N -M>
- HIGH N, MED N, LOW N
- 머지 가능 여부: [차단 / 권장 수정 후 / 가능]
```

## 1. 체크 순서

### Phase 1 — 명세 정합성

- 명세 동봉됐는가? 없으면 다음 출처 후보를 *명시적으로 요청* 후 일시 중지:
  1. PR/MR 본문의 "Why / Spec" 섹션
  2. 연결된 이슈 (Linear/Jira/GitHub Issue)
  3. Notion/Confluence 명세 페이지
  4. 디자인 명세 (Figma 코멘트 / 디자인 토큰)
  5. 위에도 없으면 *구두 합의 내용을 텍스트로 적어달라고* 요청
  → 명세 없는 리뷰는 "취향 코멘트". 받기 전에는 Phase 2 진행 금지.
- 옵셔널 항목이 검증 로직에서 필수 취급된 곳 없는가? (표시/검증 불일치 패턴)
  → 점검 절차: 명세에서 "옵셔널" grep → 해당 필드 → 템플릿 `:disabled` / `v-if="isRequired"` ↔ 스크립트 검증 분기가 **같은 진실을 보는가**.
- README/주석의 자랑 vs 실제 코드 결함?

### Phase 2 — Vue 안티패턴 (`principles/vue.md` V6)

- [ ] `v-if` + `v-for` 동시 사용 — [HIGH] 픽스: computed 필터 후 v-for
- [ ] `v-for` key 누락 / index key — [HIGH] 픽스: 안정 id
- [ ] `reactive` 비구조화 — [HIGH] 픽스: `toRefs` 또는 `ref`
- [ ] props 비구조화 (Vue 3.4 이하) — [HIGH] 픽스: `computed(() => props.x)`
- [ ] Options API 신규 코드 — [MED] 픽스: `<script setup>` 마이그레이션
- [ ] Nuxt `onMounted` 안 페치 — [HIGH] 픽스: `useFetch`/`useAsyncData`
- [ ] `defineProps()` runtime 형식 (TS 프로젝트) — [LOW] 픽스: `defineProps<{...}>()`
- [ ] `<style>` (scoped 없이) — [MED] 픽스: `<style scoped>` 또는 CSS Module
- [ ] 전역 watch 남발 (computed로 가능한데도) — [MED]
- [ ] Pinia state 외부 직접 변경 — [HIGH] 픽스: action 통한 변경
- [ ] `useAsyncData` key 누락 또는 비고유 — [HIGH] 픽스: unique key 명시
- [ ] `useFetch` watcher prop 안 쓰고 수동 refetch — [MED] 픽스: `watch` 옵션 사용

### Phase 3 — Vue 스타일 가이드 Priority A (`principles/vue.md` V1.1)

- [ ] 컴포넌트 이름 단일 단어 (`Todo`) — [HIGH] 픽스: 다중 단어 (`TodoItem`)
- [ ] prop 타입 미명세 — [MED] 픽스: TS 타입 형식
- [ ] 컴포넌트 데이터 객체 직접 (Options API) — [HIGH] 픽스: 함수 반환

### Phase 4 — 코드 품질 4원칙 (`principles/common.md` A)

(React fe-review 와 동일. 가독성 > 예측성 > 응집도 > 결합도 순.)

- [ ] 다목적 composable (`usePageState`) — [HIGH] 책임별 분리
- [ ] 매직 넘버 — [LOW]
- [ ] 시점 이동 3단계+ — [MED]
- [ ] 중첩 삼항 — [LOW]
- [ ] 같은 종류 composable 반환 타입 불일치 — [MED]
- [ ] 숨은 로직 — [MED]
- [ ] Props 3단 드릴링 — [HIGH] 픽스: `provide`/`inject` 또는 slot composition
- [ ] 잘못된 공통화 — [HIGH] 중복 허용

### Phase 5 — Web Vitals (`principles/common.md` B)

- [ ] LCP 이미지 `<NuxtImg>` priority 누락 또는 `<img>` 직접 — [HIGH]
- [ ] 이미지 width/height 미명세 → CLS — [HIGH]
- [ ] 동기 무거운 watch — [MED] 픽스: `watchEffect` + `throttle/debounce`
- [ ] `key` 변경으로 컴포넌트 강제 리마운트 — [MED] (의도적이 아니면)
- [ ] SSR/CSR 불일치 (Nuxt) — [HIGH] 픽스: `useFetch`/`useAsyncData`로 양쪽 동일 데이터

### Phase 6 — 접근성 (WCAG 2.2)

(React fe-review Phase 5 와 동일 항목.)

- [ ] `<div @click>` 버튼 — [HIGH] `<button>` 사용
- [ ] **사내/외부 wrapper 컴포넌트에 `@click`** (`<Card @click>`, `<BaseIcon @click>`, `<ListRow @click>`) — [MED→HIGH] 내부가 `<div>` 면 키보드 접근 불가. 1회 확인:
  1. 컴포넌트 정의 `.vue` 파일 → 템플릿 루트 엘리먼트
  2. `<button>` 또는 `role="button"` + `tabindex="0"` + `@keydown.enter`/`.space` 있으면 OK
  3. 아니면 사내 a11y 프리미티브로 감싸거나 `<button>` 사용
- [ ] 폼 `<label :for>` 누락 — [HIGH]
- [ ] 인터랙티브 < 24×24 — [MED]
- [ ] `:focus-visible` 누락 — [HIGH]
- [ ] 이미지 alt — [HIGH]
- [ ] 모달 focus trap — [HIGH]
- [ ] sticky header 포커스 가림 — [MED]

### Phase 7 — 보안/안티패턴

- [ ] `v-html` + 외부 입력 — [HIGH] sanitize 필요
- [ ] `.env`/credential 커밋 — [HIGH]
- [ ] 빈 catch — [HIGH]
- [ ] eslint-disable 무근거 — [MED]
- [ ] 50줄 초과 함수 / 5+ 중첩 — [MED]

## 2. 출력 예시

```
## 리뷰 요약
- 변경 범위: pages/order/*.vue 6 files +210 -38
- HIGH 4, MED 3, LOW 1
- 머지 가능 여부: 차단

[HIGH] pages/order/[id].vue:24 — onMounted 안에서 페치 → SSR/CSR 불일치
  근거: principles/vue.md V5.2
  픽스:
    const { data } = await useAsyncData(`order-${route.params.id}`,
      () => $fetch(`/api/orders/${route.params.id}`))

[HIGH] components/OptionList.vue:45 — v-if와 v-for 동시 사용
  근거: principles/vue.md V1.1
  픽스: computed로 필터 후 v-for

[HIGH] stores/order.ts:30 — 외부에서 store.state 직접 변경
  근거: principles/vue.md V6
  픽스: action 추가 후 호출
```

## 3. 관련 문서

- [`principles/common.md`](../../principles/common.md), [`principles/vue.md`](../../principles/vue.md)
- [`fe-build/SKILL.md`](../fe-build/SKILL.md), [`fe-perf/SKILL.md`](../fe-perf/SKILL.md)
