/**
 * Invariant: session-recovery never interpolates sessionId into an
 * evaluable string. Lifecycle check runs through the dedicated runner
 * (`dist/hooks/internal/run-lifecycle-check.js`) receiving the id via
 * argv — no `-e`, no template literal, no shell.
 *
 * Audit finding #5 (2026-04-21): a crafted sessionId could previously
 * break out of the `-e` template and execute arbitrary JS under the
 * user's Claude Code privileges.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'hooks', 'session-recovery.ts'),
  'utf-8',
);

describe('session-recovery code-injection defense', () => {
  it('`--input-type=module` + `-e`를 더 이상 spawn하지 않는다', () => {
    expect(src).not.toMatch(/--input-type=module/);
    // `-e` 단독 존재 패턴 — argv[i] === '-e' 형태
    expect(src).not.toMatch(/['"]-e['"]/);
  });

  it('lifecycle runner를 argv로 호출한다 (인라인 코드 인젝션 금지)', () => {
    expect(src).toMatch(/run-lifecycle-check\.js/);
    // spawn('node', [runnerPath, sessionId], ...) 형태 확인
    expect(src).toMatch(/spawnLifecycle\s*\(\s*process\.execPath\s*,\s*\[\s*runnerPath\s*,\s*sessionId\s*\]/);
  });

  it('sessionId를 실행 가능한 위치에 template literal로 interpolate하지 않는다', () => {
    // 주석/문서(`//` 또는 ` * `) 제외한 실제 코드 라인에서 체크.
    const codeOnly = src
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    // 문제 패턴: `...runLifecycleCheck('${sessionId}')` 가 코드로 실행되는 경우
    expect(codeOnly).not.toMatch(/runLifecycleCheck\(['"]?\$\{sessionId\}/);
    // dynamic `import('${path}')` 안에 sessionId 끼워넣는 패턴도 금지
    expect(codeOnly).not.toMatch(/import\([^)]*\$\{sessionId\}/);
  });
});

describe('run-lifecycle-check runner shape', () => {
  const runnerSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'hooks', 'internal', 'run-lifecycle-check.ts'),
    'utf-8',
  );

  it('sessionId를 process.argv[2]에서 읽는다', () => {
    expect(runnerSrc).toMatch(/process\.argv\[2\]/);
  });

  it('argv가 없으면 silent exit 0', () => {
    expect(runnerSrc).toMatch(/process\.exit\(0\)/);
  });

  it('runLifecycleCheck를 직접 import해 호출 (eval/Function 실행 없음)', () => {
    expect(runnerSrc).toMatch(/runLifecycleCheck\(sessionId\)/);
    // 주석/docstring 제외한 실행 라인에서만 eval/new Function 검사
    const codeOnly = runnerSrc
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
    expect(codeOnly).not.toMatch(/\bnew Function\s*\(/);
    expect(codeOnly).not.toMatch(/\beval\s*\(/);
  });

  it('빌드 후 dist에 실제 파일이 존재한다', () => {
    const distPath = path.join(__dirname, '..', 'dist', 'hooks', 'internal', 'run-lifecycle-check.js');
    expect(fs.existsSync(distPath)).toBe(true);
  });
});
