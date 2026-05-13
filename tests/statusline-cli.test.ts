/**
 * forgen statusline — 출력 형식 검증
 *
 * handleStatusline()이 stdin JSON을 받고 예상 형식으로 출력하는지 확인.
 * stdin 의존 부분은 직접 테스트 불가 → 내부 헬퍼를 모킹하지 않고,
 * 출력 라인 구조(빈 줄 없음, 최소 2줄)만 확인.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

const TEST_HOME = `/tmp/forgen-statusline-test-${process.pid}`;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

// stdin이 TTY로 처리되도록 mock (파이프 없음 → 빈 payload fallback)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      // /dev/stdin 읽기 → 빈 문자열 (TTY fallback 시뮬)
      if (p === '/dev/stdin') return '';
      // settings.json 읽기 → 빈 JSON 객체
      if (typeof p === 'string' && p.endsWith('settings.json')) return '{}';
      // CLAUDE.md find는 execSync에서 처리
      return (actual.readFileSync as (...args: unknown[]) => unknown)(p, ...rest);
    },
    existsSync: (p: unknown) => {
      if (typeof p === 'string' && p.endsWith('settings.json')) return true;
      return (actual.existsSync as (p: unknown) => boolean)(p);
    },
  };
});

// execSync: git 명령 + find 명령 대체
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: (cmd: string) => {
      if (cmd.includes('git rev-parse')) return Buffer.from('main');
      if (cmd.includes('git status --porcelain')) return Buffer.from('');
      if (cmd.includes('find')) return Buffer.from('./CLAUDE.md');
      return Buffer.from('');
    },
  };
});

// loadActiveRules mock
vi.mock('../src/store/rule-store.js', () => ({
  loadActiveRules: () => Array.from({ length: 8 }, (_, i) => ({ rule_id: `r${i}`, status: 'active' })),
}));

const { handleStatusline } = await import('../src/core/statusline-cli.js');

describe('handleStatusline', () => {
  let output: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    output = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    };
    // TTY fallback 보장
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    console.log = originalLog;
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('최소 2줄 출력 (Line1 + Line3)', async () => {
    await handleStatusline();
    expect(output.length).toBeGreaterThanOrEqual(2);
  });

  it('Line1에 모델명 포함 (fallback: Claude)', async () => {
    await handleStatusline();
    expect(output[0]).toContain('Claude');
  });

  it('Line3에 CLAUDE.md, rules, MCPs, hooks 포함', async () => {
    await handleStatusline();
    const line3 = output[1];
    expect(line3).toContain('CLAUDE.md');
    expect(line3).toContain('rules');
    expect(line3).toContain('MCPs');
    expect(line3).toContain('hooks');
  });

  it('Line3에 rules 카운트 8 반영', async () => {
    await handleStatusline();
    expect(output[1]).toContain('8 rules');
  });
});
