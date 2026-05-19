---
title: Suspense & Streaming
source: https://react.dev/reference/react/Suspense
fetched: 2026-05-18
category: suspense
react_version: 19
---

## 개요

`<Suspense>`는 자식 컴포넌트가 로딩 완료될 때까지 fallback UI를 표시하는 React 컴포넌트.

```js
<Suspense fallback={<Loading />}>
  <SomeComponent />
</Suspense>
```

---

## Props

| Prop | 설명 |
|------|------|
| `children` | 렌더링할 실제 UI. suspend 시 fallback으로 전환 |
| `fallback` | 로딩 중 대체 UI (스피너, 스켈레톤 등 경량 노드) |

---

## 핵심 Caveats

1. **State 리셋**: 마운트 전 suspend된 렌더의 state는 보존되지 않음 — 컴포넌트 로드 시 처음부터 재시도
2. **Fallback 재표시**: Suspense가 콘텐츠를 표시하다가 다시 suspend되면 fallback 재표시 (단, `startTransition`/`useDeferredValue`로 발생한 업데이트는 예외)
3. **Layout Effects 정리**: 콘텐츠 숨김 시 layout Effect 정리, 다시 표시 시 재실행
4. **Streaming 내장**: Streaming Server Rendering + Selective Hydration 최적화 포함

---

## Suspense를 트리거하는 데이터 소스

- Relay, Next.js 등 Suspense 지원 프레임워크
- `lazy()`로 지연 로딩된 컴포넌트
- `use()`로 읽는 캐시된 Promise

> ⚠️ Effect나 이벤트 핸들러 내부의 데이터 페칭은 감지하지 못함.

---

## 사용 패턴

### 1. 기본 fallback 표시

```js
<Suspense fallback={<Loading />}>
  <Albums />
</Suspense>
```

### 2. 함께 나타나는 콘텐츠 그룹

```js
<Suspense fallback={<Loading />}>
  <Biography />
  <Panel>
    <Albums />
  </Panel>
</Suspense>
```

> 두 컴포넌트가 서로 기다려 함께 나타남.

### 3. 중첩 Suspense로 순차 표시 (Streaming)

```js
<Suspense fallback={<BigSpinner />}>
  <Biography />
  <Suspense fallback={<AlbumsGlimmer />}>
    <Panel>
      <Albums />
    </Panel>
  </Suspense>
</Suspense>
```

**순서:**
1. Biography 로딩 중 → `BigSpinner` 표시
2. Biography 완료 → `AlbumsGlimmer` 표시
3. Albums 완료 → 최종 UI

### 4. 새 콘텐츠 로딩 중 이전 콘텐츠 유지 (`useDeferredValue`)

```js
import { Suspense, useState, useDeferredValue } from 'react';

export default function App() {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const isStale = query !== deferredQuery;

  return (
    <>
      <label>
        Search albums:
        <input value={query} onChange={e => setQuery(e.target.value)} />
      </label>
      <Suspense fallback={<h2>Loading...</h2>}>
        <div style={{ opacity: isStale ? 0.5 : 1 }}>
          <SearchResults query={deferredQuery} />
        </div>
      </Suspense>
    </>
  );
}
```

입력은 즉시 업데이트, 이전 결과는 opacity 0.5로 표시되다가 새 결과 로드 시 전환.

### 5. 표시 중인 콘텐츠가 fallback으로 교체되지 않도록 (`startTransition`)

```js
import { useTransition } from 'react';

function Router() {
  const [page, setPage] = useState('/');
  const [isPending, startTransition] = useTransition();

  function navigate(url) {
    startTransition(() => {
      setPage(url);
    });
  }

  return (
    <Layout isPending={isPending}>
      {content}
    </Layout>
  );
}
```

### 6. 네비게이션 시 Suspense 경계 리셋 (`key`)

```js
<ProfilePage key={queryParams.id} />
```

> `key`가 변경되면 중첩된 모든 Suspense 경계가 리셋됨.

### 7. 클라이언트 전용 콘텐츠

```js
<Suspense fallback={<Loading />}>
  <Chat />
</Suspense>

function Chat() {
  if (typeof window === 'undefined') {
    throw Error('Chat should only render on the client.');
  }
  // ...
}
```

서버 HTML에서는 fallback, 클라이언트에서 컴포넌트로 교체.

---

## 완전한 예시

```js
import { Suspense, useState, useTransition } from 'react';

export default function ArtistPage({ artist }) {
  return (
    <>
      <h1>{artist.name}</h1>
      <Suspense fallback={<LoadingBio />}>
        <Biography artistId={artist.id} />
      </Suspense>
      <Suspense fallback={<LoadingAlbums />}>
        <Albums artistId={artist.id} />
      </Suspense>
    </>
  );
}

function Biography({ artistId }) {
  const bio = use(fetchData(`/${artistId}/bio`));
  return <section><p>{bio}</p></section>;
}

function Albums({ artistId }) {
  const albums = use(fetchData(`/${artistId}/albums`));
  return (
    <ul>
      {albums.map(album => (
        <li key={album.id}>{album.title} ({album.year})</li>
      ))}
    </ul>
  );
}
```

---

## Troubleshooting

**업데이트 시 원치 않는 fallback 방지:**

```js
function handleNextPageClick() {
  startTransition(() => {
    setCurrentPage(currentPage + 1);
  });
}
```

> `startTransition`으로 긴급하지 않은 업데이트 표시 → 충분한 데이터가 로드될 때까지 fallback 표시 지연. 긴급 업데이트는 여전히 즉시 fallback 표시.
