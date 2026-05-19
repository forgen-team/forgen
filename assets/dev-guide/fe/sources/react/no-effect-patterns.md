---
title: You Might Not Need an Effect (Effect 회피 패턴)
source: https://react.dev/learn/you-might-not-need-an-effect
fetched: 2026-05-18
category: patterns
react_version: 19
---

## 개요

Effect는 React 패러다임의 **탈출구** — 외부 시스템과 동기화할 때만 사용. 많은 경우 더 간단한 대안이 있음.

**Effect가 필요 없는 두 가지 주요 케이스:**
1. 렌더링을 위한 데이터 변환
2. 사용자 이벤트 처리

---

## 패턴별 가이드

### 1. 렌더링용 데이터 변환 → 렌더 중 계산

❌ 피할 것:
```js
function Form() {
  const [firstName, setFirstName] = useState('Taylor');
  const [lastName, setLastName] = useState('Swift');
  const [fullName, setFullName] = useState('');

  useEffect(() => {
    setFullName(firstName + ' ' + lastName);
  }, [firstName, lastName]);
}
```

✅ 렌더 중 직접 계산:
```js
function Form() {
  const [firstName, setFirstName] = useState('Taylor');
  const [lastName, setLastName] = useState('Swift');
  const fullName = firstName + ' ' + lastName; // Effect 불필요
}
```

---

### 2. 비용이 큰 계산 → useMemo

```js
function TodoList({ todos, filter }) {
  const visibleTodos = useMemo(
    () => getFilteredTodos(todos, filter),
    [todos, filter]
  );
}
```

---

### 3. prop 변경 시 state 리셋 → key 사용

```js
export default function ProfilePage({ userId }) {
  return (
    <Profile
      userId={userId}
      key={userId} // userId가 변경되면 컴포넌트 전체 리셋
    />
  );
}
```

---

### 4. prop 기반 state 조정 → 렌더 중 계산

```js
function List({ items }) {
  const [selectedId, setSelectedId] = useState(null);
  // Effect 없이 렌더 중 계산
  const selection = items.find(item => item.id === selectedId) ?? null;
}
```

---

### 5. 이벤트 핸들러 간 로직 공유 → 함수 추출

❌ 피할 것:
```js
useEffect(() => {
  if (product.isInCart) {
    showNotification(`Added ${product.name} to cart!`);
  }
}, [product]);
```

✅ 이벤트 핸들러에서 직접 처리:
```js
function ProductPage({ product, addToCart }) {
  function buyProduct() {
    addToCart(product);
    showNotification(`Added ${product.name} to cart!`);
  }

  function handleBuyClick() {
    buyProduct();
  }

  function handleCheckoutClick() {
    buyProduct();
    navigateTo('/checkout');
  }
}
```

---

### 6. state 업데이트 체인 → 이벤트 핸들러에서 한 번에

❌ Effect 체인 (N번 리렌더):
```js
useEffect(() => {
  if (card.gold) setGoldCardCount(c => c + 1);
}, [card]);

useEffect(() => {
  if (goldCardCount > 3) setRound(r => r + 1);
}, [goldCardCount]);
```

✅ 이벤트 핸들러에서 한 번에:
```js
function handlePlaceCard(nextCard) {
  setCard(nextCard);
  if (nextCard.gold) {
    if (goldCardCount < 3) {
      setGoldCardCount(goldCardCount + 1);
    } else {
      setGoldCardCount(0);
      setRound(round + 1);
    }
  }
}
```

---

### 7. 부모에게 변경 알리기 → 같은 이벤트에서 처리

```js
function Toggle({ onChange }) {
  const [isOn, setIsOn] = useState(false);

  function updateToggle(nextIsOn) {
    setIsOn(nextIsOn);
    onChange(nextIsOn); // Effect 아닌 이벤트 핸들러에서 호출
  }
}
```

---

## Effect가 실제로 필요한 경우

- **외부 시스템 동기화** (jQuery 위젯, 브라우저 API)
- **데이터 페칭** (race condition 처리를 위한 cleanup 필요)
- **외부 스토어 구독** → `useSyncExternalStore` 사용

---

## 요약 표

| 패턴 | ❌ Effect 사용 | ✅ 대안 |
|------|--------------|---------|
| 데이터 변환 | state + Effect | 렌더 중 계산 |
| 비싼 계산 | state + Effect | `useMemo` |
| prop 변경 시 리셋 | Effect에서 `setState` | `key` prop |
| 사용자 이벤트 처리 | Effect | 이벤트 핸들러 |
| 부모에게 변경 알림 | Effect | 이벤트 핸들러 |
| 외부 동기화 | (적절한 경우) | Effect 또는 `useSyncExternalStore` |

**황금 규칙:** 컴포넌트가 _표시_되어서 실행해야 하면 Effect, 특정 _인터랙션_ 때문이면 이벤트 핸들러.
