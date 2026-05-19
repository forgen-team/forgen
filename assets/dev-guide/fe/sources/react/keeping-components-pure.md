---
title: Keeping Components Pure (컴포넌트 순수성 유지)
source: https://react.dev/learn/keeping-components-pure
fetched: 2026-05-18
category: patterns
react_version: 19
---

## 개요

React는 모든 컴포넌트가 순수 함수라고 가정. 같은 입력에 항상 같은 JSX를 반환해야 함.

**순수 컴포넌트의 두 원칙:**
1. **자기 일에만 집중** — 호출 전 존재하던 객체/변수를 변경하지 않음
2. **같은 입력 → 같은 출력** — 항상 동일한 결과 반환

---

## 순수 컴포넌트 예시

```js
function Recipe({ drinkers }) {
  return (
    <ol>
      <li>Boil {drinkers} cups of water.</li>
      <li>Add {drinkers} spoons of tea and {0.5 * drinkers} spoons of spice.</li>
      <li>Add {0.5 * drinkers} cups of milk to boil and sugar to taste.</li>
    </ol>
  );
}
```

`drinkers={2}`이면 항상 "2 cups of water" JSX 반환.

---

## 불순 컴포넌트 (Side Effect During Render)

❌ 외부 변수 변경 — 예측 불가:
```js
let guest = 0;

function Cup() {
  guest = guest + 1; // 🚩 외부 변수 변경
  return <h2>Tea cup for guest #{guest}</h2>;
}
```

같은 컴포넌트를 여러 번 호출하면 다른 결과 → 버그.

✅ props로 데이터 전달:
```js
function Cup({ guest }) {
  return <h2>Tea cup for guest #{guest}</h2>;
}

export default function TeaSet() {
  return (
    <>
      <Cup guest={1} />
      <Cup guest={2} />
      <Cup guest={3} />
    </>
  );
}
```

---

## Local Mutation은 안전

렌더링 중 **직접 생성한** 변수의 변경은 안전 ("local mutation"):

```js
export default function TeaGathering() {
  const cups = []; // 이 렌더에서 생성
  for (let i = 1; i <= 12; i++) {
    cups.push(<Cup key={i} guest={i} />); // ✅ local mutation, 순수성 유지
  }
  return cups;
}
```

외부 코드가 이 변수를 알 수 없으므로 순수성 유지.

---

## Side Effect가 허용되는 위치

**1. 이벤트 핸들러 (권장):**
```js
function Button() {
  const handleClick = () => {
    updateDatabase(); // ✅ 이벤트 핸들러 내부
  };
  return <button onClick={handleClick}>Click me</button>;
}
```

**2. useEffect (최후 수단):**
```js
useEffect(() => {
  document.title = "Updated"; // ✅ 렌더링 후 실행
}, []);
```

렌더 함수 자체에서는 side effect 금지.

---

## React StrictMode

개발 모드에서 컴포넌트 함수를 **두 번** 호출하여 불순 컴포넌트 감지:
- 순수 함수: 두 번 호출해도 같은 결과
- 불순 함수: 버그가 드러남

---

## 순수성이 가능하게 하는 것

- **서버 사이드 렌더링**: 같은 입력 → 같은 결과 보장
- **성능 최적화**: 입력이 변경되지 않으면 캐시된 결과 재사용
- **렌더 인터럽트 안전**: 데이터 변경 시 새 렌더 재시작 가능

---

## 핵심 규칙 요약

| 규칙 | 설명 |
|------|------|
| 외부 변수 변경 금지 | 렌더 전 존재하던 변수 수정 불가 |
| props/state/context는 읽기 전용 | 직접 수정 불가 |
| local mutation은 허용 | 렌더 중 새로 생성한 변수만 |
| side effect 위치 | 이벤트 핸들러 또는 `useEffect` |
| 독립적 렌더 | 컴포넌트는 렌더 중 다른 컴포넌트와 협력하지 않음 |
