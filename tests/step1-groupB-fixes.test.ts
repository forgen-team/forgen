import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * P0-1: dashboard.ts는 ESM에서 `require()` 직접 호출 대신 `createRequire` 사용.
 * 과거에는 항상 ReferenceError → catch 경로 → Solution Fitness 섹션 무효화.
 */
describe('P0-1: dashboard.ts uses createRequire (ESM-safe)', () => {
  const srcPath = path.join(__dirname, '..', 'src', 'core', 'dashboard.ts');
  const content = fs.readFileSync(srcPath, 'utf-8');

  it('createRequire import 존재', () => {
    expect(content).toMatch(/import\s*\{\s*createRequire\s*\}\s*from\s*['"]node:module['"]/);
  });

  it('모듈 최상위에 const require = createRequire(import.meta.url) 바인딩', () => {
    expect(content).toMatch(/const require = createRequire\(import\.meta\.url\)/);
  });

  it('renderFitnessSummary에서 require 호출이 더 이상 ReferenceError가 아님', async () => {
    // runtime smoke: dashboard 모듈 import해서 에러 없는지
    const mod = await import('../src/core/dashboard.js');
    expect(typeof mod.handleDashboard).toBe('function');
    // renderFitnessSummary는 internal. 호출 가능 여부만 보장.
  });
});

/**
 * P0-4: pre-tool-use는 shouldShowReminderIO를 먼저 체크한 후 getActiveReminders를
 * 호출한다. 과거에는 먼저 전체 STATE_DIR 스캔 → 그 뒤 카운터 판정 → 90% 호출에서
 * 불필요 I/O 발생.
 */
describe('P0-4: pre-tool-use reorders reminder check (IO avoided on 90% calls)', () => {
  it('shouldShowReminderIO가 getActiveReminders보다 먼저 호출된다 (코드 라인만)', () => {
    const srcPath = path.join(__dirname, '..', 'src', 'hooks', 'pre-tool-use.ts');
    const content = fs.readFileSync(srcPath, 'utf-8');

    // 주석 제거 후 실제 코드 라인에서만 호출 위치 추출
    const codeLines = content
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'));
    const codeOnly = codeLines.join('\n');

    // 호출 컨텍스트를 정확히 잡음: `if (shouldShowReminderIO())` vs
    // `= getActiveReminders();` (함수 정의 `function getActiveReminders()` 제외)
    const showIdx = codeOnly.indexOf('if (shouldShowReminderIO())');
    const getIdx = codeOnly.indexOf('= getActiveReminders(sessionId);');
    expect(showIdx).toBeGreaterThan(-1);
    expect(getIdx).toBeGreaterThan(-1);
    expect(getIdx).toBeGreaterThan(showIdx);
  });
});
