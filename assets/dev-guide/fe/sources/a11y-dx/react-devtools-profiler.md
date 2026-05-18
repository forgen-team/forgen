---
title: React DevTools Profiler 렌더 진단 가이드
source: https://react.dev/learn/react-developer-tools
fetched: 2026-05-18
category: react-profiler
---

# React DevTools Profiler

## 설치

### 브라우저 확장 (권장)
- Chrome: [Chrome Web Store](https://chrome.google.com/webstore/detail/react-developer-tools/fmkadmapgofadopljbjfkapdkoienihi)
- Firefox: [Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/react-devtools/)
- Edge: [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/react-developer-tools/gpphkfbcpidddadnkolkpfckpihlkkil)

### Safari / 기타
```bash
npm install -g react-devtools
react-devtools
```
`<head>`에 추가:
```html
<script src="http://localhost:8097"></script>
```

DevTools 열면 **Components** 탭과 **Profiler** 탭이 생긴다.

---

## Profiler 탭 기본 사용

### 녹화
1. Profiler 탭 → **Record** 버튼(원형) 클릭
2. 문제 동작 수행 (버튼 클릭, 입력, 페이지 이동 등)
3. **Stop** 클릭

### React의 두 단계 이해
- **Render phase**: `render()` 호출, 이전 결과와 diff 계산
- **Commit phase**: 실제 DOM에 변경 반영, lifecycle 호출

---

## Flame Chart 읽는 법

- **가로 길이**: 렌더에 걸린 시간 (길수록 느림)
- **색상**
  - 노란색(황색): 상대적으로 느린 렌더
  - 파란색: 상대적으로 빠른 렌더
  - 회색: 이 commit에서 렌더되지 않음 (재사용됨)
- 컴포넌트 클릭 → 우측 패널에서 해당 commit의 props/state 확인
- **commit bar** (상단 막대): 각 commit의 상대적 소요 시간. 높을수록 느린 commit

---

## Ranked Chart

- 단일 commit에서 렌더 시간 기준으로 컴포넌트를 내림차순 정렬
- 맨 위 = 가장 느린 컴포넌트 (자식 포함 합산)
- 병목 컴포넌트를 빠르게 특정할 때 유용

---

## "Why did this render?" 기능

Profiler 설정(⚙️) → **"Record why each component rendered while profiling"** 활성화

녹화 후 컴포넌트 클릭 → **"Why did this render?"** 섹션에 원인 표시:
- `Props changed` + 변경된 prop 이름
- `State changed` + 변경된 state 이름
- `Context changed`
- `Hooks changed`
- `Parent component rendered`

**흔한 불필요 렌더 원인:**
```js
// Bad: 매 렌더마다 새 객체 생성
<MyComp style={{ color: 'red' }} />

// Fix: 객체를 외부로 분리 or useMemo
const style = { color: 'red' };
<MyComp style={style} />
```

---

## Highlight Updates 기능

Components 탭 → 설정(⚙️) → **"Highlight updates when components render"** 활성화

페이지 위에서 컴포넌트가 렌더될 때 파란→노란→빨간 테두리로 강조:
- 파란색: 렌더 횟수 적음
- 빨간색: 렌더 횟수 많음 (최적화 필요)

스크롤하거나 마우스를 움직이기만 해도 렌더되는 컴포넌트를 시각적으로 파악 가능

---

## 불필요 렌더 최적화 체크리스트

| 원인 | 해결 |
|------|------|
| 부모 렌더 시 자식 전체 재렌더 | `React.memo()` 로 자식 메모이제이션 |
| 매 렌더마다 새 함수/객체 props | `useCallback`, `useMemo` 사용 |
| Context 값 변경 시 모든 소비자 재렌더 | Context 분리 또는 `useMemo`로 값 안정화 |
| State 위치가 너무 높음 | State를 사용하는 컴포넌트 가까이 내리기 |
| List에 key 없거나 index 사용 | 고유 ID를 key로 사용 |

---

## 프로덕션 환경 프로파일링

기본적으로 프로파일러는 개발 빌드에서만 동작.
프로덕션에서 사용하려면:
```bash
# webpack alias 설정
react-dom/profiling  대신 react-dom 사용 (package.json alias)
```
또는 번들러에서 `react-dom/profiling`으로 alias 처리.

---

## Component 탭 활용 팁

- 컴포넌트 선택 → props/state 실시간 편집 (빠른 검증)
- `$r` : 선택된 컴포넌트 인스턴스를 콘솔에서 참조 가능
- 검색창에서 컴포넌트 이름으로 필터링
- Suspense boundary 시각적으로 확인 가능
