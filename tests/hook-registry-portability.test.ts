/**
 * Hook Registry Portability — Node 20.0+ 호환 회귀 가드
 *
 * 배경: 0.4.4 (2026-05-08) 이전 버전은 `import ... with { type: 'json' }` import
 *       attribute 를 사용해 Node 20.0-20.9 에서 모든 훅이 SyntaxError 로 깨졌다.
 *       (npm i -g 후 hook-registry 의존 체인 = 거의 모든 훅).
 *
 * 본 테스트는 빌드 산출물(dist/)에 import attributes 가 재유입되는 것을 막는
 * 정적 검증과, registry 가 정상 로드되어 기대 항목이 존재하는지 동적 검증을
 * 함께 수행한다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_REGISTRY } from '../src/hooks/hook-registry.js';

const DIST_HOOKS = join(__dirname, '..', 'dist', 'hooks');

describe('hook-registry portability', () => {
  it('HOOK_REGISTRY 가 비어있지 않고 필수 훅을 포함한다', () => {
    expect(Array.isArray(HOOK_REGISTRY)).toBe(true);
    expect(HOOK_REGISTRY.length).toBeGreaterThanOrEqual(15);
    const names = new Set(HOOK_REGISTRY.map((h) => h.name));
    for (const required of ['post-tool-use', 'pre-tool-use', 'session-recovery', 'stop-guard']) {
      expect(names.has(required)).toBe(true);
    }
  });

  it('빌드 산출물에 import attributes (`with { type: ... }`) 가 없어야 한다', () => {
    // Node 20.0-20.9 호환: import attributes 는 20.10+ 에서만 파싱된다.
    let hookRegistryJs: string;
    try {
      hookRegistryJs = readFileSync(join(DIST_HOOKS, 'hook-registry.js'), 'utf-8');
    } catch {
      // dist 미빌드 환경에서는 skip (CI 빌드 후 단계에서만 의미있음)
      return;
    }
    // 매치는 실제 import 구문만 — 주석/문자열 안의 'with' 표기는 제외
    const importLines = hookRegistryJs
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l) && !/^\s*\/[/*]/.test(l));
    for (const line of importLines) {
      expect(line).not.toMatch(/with\s*\{\s*type\s*:/);
      expect(line).not.toMatch(/assert\s*\{\s*type\s*:/);
    }
  });
});
