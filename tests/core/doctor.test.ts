/**
 * Doctor — ADR-010 W2-1 경계 재정의 회귀 고정.
 *
 * 이전: [Harness Maturity]/Quick Wins 섹션 테스트 (Feature 1-D).
 * W2-1 에서 해당 섹션은 제거됨 — "CLAUDE.md 추가하세요" 류 일반 셋업 조언은
 * native /doctor 의 영역. 이 파일은 이제 그 *부재*와 경계 선언, --verbose
 * 강등을 고정한다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-doctor',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

// Mock execFileSync to avoid external tool calls
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (cmd: string, _args?: string[], _opts?: object) => {
      // Simulate 'which' always finding tools
      if (cmd === 'which' || cmd === 'where') return '';
      // For git remote, simulate no remote
      throw new Error('git remote not found');
    },
  };
});

import { runDoctor } from '../../src/core/doctor.js';

const ME_DIR = path.join(TEST_HOME, '.forgen', 'me');
const STATE_DIR = path.join(TEST_HOME, '.forgen', 'state');

async function captureDoctor(opts: Parameters<typeof runDoctor>[0] = {}): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
  await runDoctor(opts);
  return lines.join('\n');
}

describe('doctor W2-1 boundary (ADR-010)', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(ME_DIR, { recursive: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('declares the native /doctor boundary in the header', async () => {
    const output = await captureDoctor();
    expect(output).toContain('native /doctor');
    expect(output).toContain('forgen 자체 기계');
  });

  it('removed sections stay removed: no Harness Maturity / Quick Wins', async () => {
    const output = await captureDoctor();
    expect(output).not.toContain('[Harness Maturity]');
    expect(output).not.toContain('Quick Wins');
    // forgen 고유 진단은 유지된다
    expect(output).toContain('[State Hygiene]');
    expect(output).toContain('[Codex Parity]');
  });

  it('hook timing table is verbose-only (collection stays, display demoted)', async () => {
    const normal = await captureDoctor();
    expect(normal).not.toContain('[Hook Timing]');

    vi.restoreAllMocks();
    const verbose = await captureDoctor({ verbose: true });
    expect(verbose).toContain('[Hook Timing]');
  });

  it('effort section is silent unless forge-loop is active (nudge-only)', async () => {
    const output = await captureDoctor();
    expect(output).not.toContain('[Effort');
  });

  it('runs without error on empty home (graceful)', async () => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    await expect(runDoctor()).resolves.not.toThrow();
  });
});
