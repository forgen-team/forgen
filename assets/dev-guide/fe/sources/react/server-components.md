---
title: Server Components
source: https://react.dev/reference/rsc/server-components
fetched: 2026-05-18
category: rsc
react_version: 19
---

## 개요

Server Components는 번들링 전, 클라이언트 앱/SSR 서버와 분리된 환경에서 렌더링되는 새로운 React 컴포넌트 유형.

**핵심 특징:**
- 빌드 타임 또는 요청마다 서버에서 렌더링
- `useState` 등 인터랙티브 API 사용 불가
- `async/await` 직접 사용 가능
- 브라우저에 전송되지 않음 (번들에 포함 안 됨)
- **`"use server"` 디렉티브 없음** — Server Component는 기본값; `"use client"` / `"use server"`만 존재

---

## 사용 사례 1: 서버 없는 빌드타임 렌더링

무거운 라이브러리를 번들에 포함하지 않고 빌드 시 처리:

❌ 기존 방식 (클라이언트 번들에 35.9K + 206K 추가):
```js
import marked from 'marked';           // 35.9K (11.2K gzipped)
import sanitizeHtml from 'sanitize-html'; // 206K (63.3K gzipped)

function Page({ page }) {
  const [content, setContent] = useState('');
  useEffect(() => {
    fetch(`/api/content/${page}`).then((data) => {
      setContent(data.content);
    });
  }, [page]);
  return <div>{sanitizeHtml(marked(content))}</div>;
}
```

✅ Server Component (번들 크기 0):
```js
import marked from 'marked';           // 번들에 포함되지 않음
import sanitizeHtml from 'sanitize-html'; // 번들에 포함되지 않음

async function Page({ page }) {
  const content = await file.readFile(`${page}.md`);
  return <div>{sanitizeHtml(marked(content))}</div>;
}
```

클라이언트 출력:
```js
<div><!-- html for markdown --></div>
```

---

## 사용 사례 2: 요청마다 서버 데이터 페칭

클라이언트 waterfall 없이 서버에서 직접 DB 쿼리:

❌ 기존 방식 (N+1 waterfall):
```js
function Note({ id }) {
  const [note, setNote] = useState('');
  useEffect(() => {
    fetch(`/api/notes/${id}`).then(data => setNote(data.note));
  }, [id]);

  return (
    <div>
      <Author id={note.authorId} />
      <p>{note}</p>
    </div>
  );
}

function Author({ id }) {
  const [author, setAuthor] = useState('');
  useEffect(() => {
    fetch(`/api/authors/${id}`).then(data => setAuthor(data.author));
  }, [id]);
  return <span>By: {author.name}</span>;
}
```

✅ Server Component (병렬 DB 쿼리):
```js
import db from './database';

async function Note({ id }) {
  const note = await db.notes.get(id);
  return (
    <div>
      <Author id={note.authorId} />
      <p>{note}</p>
    </div>
  );
}

async function Author({ id }) {
  const author = await db.authors.get(id);
  return <span>By: {author.name}</span>;
}
```

클라이언트 출력:
```js
<div>
  <span>By: The React Team</span>
  <p>React 19 is...</p>
</div>
```

---

## 인터랙티비티 추가: Server + Client 조합

`"use client"` 디렉티브로 Client Component와 합성:

```js
// Server Component
import Expandable from './Expandable';

async function Notes() {
  const notes = await db.notes.getAll();
  return (
    <div>
      {notes.map(note => (
        <Expandable key={note.id}>
          <p note={note} />
        </Expandable>
      ))}
    </div>
  );
}
```

```js
// Client Component
"use client"

export default function Expandable({ children }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button onClick={() => setExpanded(!expanded)}>Toggle</button>
      {expanded && children}
    </div>
  );
}
```

---

## Promise를 서버→클라이언트로 전달

```js
// Server Component
import db from './database';

async function Page({ id }) {
  const note = await db.notes.get(id);           // 서버에서 await
  const commentsPromise = db.comments.get(note.id); // 시작만, 클라이언트에서 await

  return (
    <div>
      {note}
      <Suspense fallback={<p>Loading Comments...</p>}>
        <Comments commentsPromise={commentsPromise} />
      </Suspense>
    </div>
  );
}
```

```js
// Client Component
"use client";
import { use } from 'react';

function Comments({ commentsPromise }) {
  const comments = use(commentsPromise); // 서버에서 시작된 Promise 이어서 처리
  return comments.map(comment => <p>{comment}</p>);
}
```

---

## API 안정성 주의

> Server Component 구현을 위한 번들러/프레임워크 API는 semver를 따르지 않으며 React 19.x 마이너 버전 간 breaking change 가능. 특정 React 버전에 pin하거나 Canary 릴리스 사용 권장.
