---
title: React Compiler (자동 메모이제이션)
source: https://react.dev/learn/react-compiler
fetched: 2026-05-18
category: compiler
react_version: 19
---

## 개요

React Compiler는 `useMemo`, `useCallback`, `React.memo`를 수동으로 작성할 필요 없이 자동으로 메모이제이션을 처리하는 빌드타임 최적화 도구.

**핵심 기능:**
- 컴포넌트와 계산값 자동 메모이제이션
- 수동 `useMemo` / `useCallback` 대체
- 설정 없이 기본적으로 React 앱 최적화
- React 19 권장, React 17/18도 지원

---

## 설치

```bash
npm install -D babel-plugin-react-compiler@latest
# 또는
yarn add -D babel-plugin-react-compiler@latest
# 또는
pnpm install -D babel-plugin-react-compiler@latest
```

---

## 빌드 도구별 설정

### Babel

```js
// babel.config.js
module.exports = {
  plugins: [
    'babel-plugin-react-compiler', // 반드시 첫 번째로!
    // ... 다른 플러그인
  ],
};
```

> **중요**: React Compiler는 Babel 플러그인 파이프라인에서 **첫 번째**로 실행되어야 함.

### Vite (v6.0.0+)

```bash
npm install -D @rolldown/plugin-babel
```

```js
// vite.config.js
import { defineConfig } from 'vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';

export default defineConfig({
  plugins: [
    react(),
    babel({
      presets: [reactCompilerPreset()],
    }),
  ],
});
```

Vite 구버전 (6.0.0 미만):
```js
// vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ['babel-plugin-react-compiler'],
      },
    }),
  ],
});
```

### React Router (Vite)

```bash
npm install vite-plugin-babel
```

```js
// vite.config.js
import { defineConfig } from "vite";
import babel from "vite-plugin-babel";
import { reactRouter } from "@react-router/dev/vite";

const ReactCompilerConfig = { /* ... */ };

export default defineConfig({
  plugins: [
    reactRouter(),
    babel({
      filter: /\.[jt]sx?$/,
      babelConfig: {
        presets: ["@babel/preset-typescript"], // TypeScript 사용 시
        plugins: [
          ["babel-plugin-react-compiler", ReactCompilerConfig],
        ],
      },
    }),
  ],
});
```

### Next.js
[Next.js 공식 문서](https://nextjs.org/docs/app/api-reference/next-config-js/reactCompiler) 참조.

---

## ESLint 플러그인

```bash
npm install -D eslint-plugin-react-hooks@latest
```

`recommended-latest` 프리셋에 컴파일러 규칙 포함:
- Rules of React 위반 식별
- 최적화 불가 컴포넌트 표시
- 수정 방법 에러 메시지 제공

---

## 적용 확인

### React DevTools
1. React Developer Tools 브라우저 확장 설치
2. 개발 모드로 앱 실행
3. React DevTools 열기
4. 컴포넌트 이름 옆 ✨ 이모지 확인 → "Memo ✨" 뱃지

### 빌드 출력 확인

컴파일된 코드에 자동 메모이제이션 로직 포함:
```js
import { c as _c } from "react/compiler-runtime";

export default function MyApp() {
  const $ = _c(1);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = <div>Hello World</div>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  return t0;
}
```

---

## 특정 컴포넌트 최적화 제외

```js
function ProblematicComponent() {
  "use no memo"; // 이 컴포넌트만 컴파일러 건너뜀
  // ...
}
```

---

## 요약: 이전 vs 이후

| 이전 (수동) | 이후 (컴파일러) |
|------------|----------------|
| `const memoVal = useMemo(() => compute(a, b), [a, b])` | 자동 처리 |
| `const cb = useCallback(() => fn(x), [x])` | 자동 처리 |
| `export default React.memo(MyComponent)` | 자동 처리 |
