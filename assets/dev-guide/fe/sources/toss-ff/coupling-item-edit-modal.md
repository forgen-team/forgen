---
title: Props Drilling 지우기
source: https://frontend-fundamentals.com/code-quality/code/examples/item-edit-modal.html
fetched: 2026-05-18
principle: coupling
---

# Props Drilling 지우기

Props Drilling은 부모 컴포넌트와 자식 컴포넌트 사이에 결합도가 생겼다는 것을 나타내는 명확한 표시예요.
만약에 Drilling되는 `name` prop의 이름이 `firstName`으로 변경되면, 해당 prop을 참조하는 모든 컴포넌트를 수정해야 해요.

## 📝 코드 예시

다음 코드는 사용자가 `item`을 선택할 때 사용하는 `<ItemEditModal />` 컴포넌트예요.

```tsx
function ItemEditModal({ open, items, recommendedItems, onConfirm, onClose }) {
  const [keyword, setKeyword] = useState("");

  return (
    <Modal open={open} onClose={onClose}>
      <ItemEditBody
        items={items}
        keyword={keyword}
        onKeywordChange={setKeyword}
        recommendedItems={recommendedItems}
        onConfirm={onConfirm}
        onClose={onClose}
      />
    </Modal>
  );
}

function ItemEditBody({
  keyword, onKeywordChange, items, recommendedItems, onConfirm, onClose
}) {
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <Input value={keyword} onChange={(e) => onKeywordChange(e.target.value)} />
        <Button onClick={onClose}>닫기</Button>
      </div>
      <ItemEditList
        keyword={keyword}
        items={items}
        recommendedItems={recommendedItems}
        onConfirm={onConfirm}
      />
    </>
  );
}
```

## 👃 코드 냄새 맡아보기

### 결합도

이 컴포넌트는 부모인 `ItemEditModal`과 자식인 `ItemEditBody`, `ItemEditList` 등이 동일한 값인 `recommendedItems`, `onConfirm`, `keyword` 등을 prop으로 공유하고 있어요.

Props Drilling이 발생하면, prop을 불필요하게 참조하는 컴포넌트의 숫자가 많아져요.
그런데 prop이 변경되면 prop을 참조하는 모든 컴포넌트가 수정되어야 해요.

## ✏️ 개선해보기

### A. 조합(Composition) 패턴 활용

```tsx
function ItemEditModal({ open, items, recommendedItems, onConfirm, onClose }) {
  const [keyword, setKeyword] = useState("");

  return (
    <Modal open={open} onClose={onClose}>
      <ItemEditBody
        keyword={keyword}
        onKeywordChange={setKeyword}
        onClose={onClose}
      >
        <ItemEditList
          keyword={keyword}
          items={items}
          recommendedItems={recommendedItems}
          onConfirm={onConfirm}
        />
      </ItemEditBody>
    </Modal>
  );
}

function ItemEditBody({ children, keyword, onKeywordChange, onClose }) {
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <Input value={keyword} onChange={(e) => onKeywordChange(e.target.value)} />
        <Button onClick={onClose}>닫기</Button>
      </div>
      {children}
    </>
  );
}
```

### B. ContextAPI 활용

```tsx
function ItemEditModal({ open, onConfirm, onClose }) {
  const [keyword, setKeyword] = useState("");

  return (
    <Modal open={open} onClose={onClose}>
      <ItemEditBody keyword={keyword} onKeywordChange={setKeyword} onClose={onClose}>
        <ItemEditList keyword={keyword} onConfirm={onConfirm} />
      </ItemEditBody>
    </Modal>
  );
}

function ItemEditList({ keyword, onConfirm }) {
  const { items, recommendedItems } = useItemEditModalContext();
  // ...
}
```

ContextAPI를 사용하면 매우 쉽게 Props Drilling을 해결할 수 있지만, Props Drilling이 되는 모든 값을 ContextAPI로 관리해야 하는 것은 아니에요. `children` prop을 이용해서 컴포넌트를 전달해 depth를 줄이는 것을 먼저 고려하세요.
