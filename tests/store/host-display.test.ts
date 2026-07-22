/**
 * Host display — doctor [Multi-Host] + dashboard Multi-Host Evidence 출력 형식 검증
 *
 * 검증:
 *   - collectMultiHostData() 가 summarizeAllByHost() 결과를 그대로 반영
 *   - renderDashboard() 출력에 "Multi-Host Evidence" 섹션이 포함됨
 *   - doctor [Multi-Host] 섹션이 evidence 없을 때 / 있을 때 올바른 형식 출력
 *   - skew 80%+ 시 경고 메시지 포함
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-host-display',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

// doctor 테스트용 child_process mock (외부 CLI 호출 방지)
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (cmd: string) => {
      if (cmd === 'which' || cmd === 'where') return '';
      throw new Error('not found');
    },
  };
});

import { collectMultiHostData, renderDashboard } from '../../src/core/dashboard.js';
import { runDoctor } from '../../src/core/doctor.js';

const BEHAVIOR_DIR = path.join(TEST_HOME, '.forgen', 'me', 'behavior');
const STATE_DIR = path.join(TEST_HOME, '.forgen', 'state');

function writeEvidence(id: string, host: 'claude' | 'codex' | undefined): void {
  fs.mkdirSync(BEHAVIOR_DIR, { recursive: true });
  const evidence = {
    evidence_id: id,
    type: 'behavior_observation',
    session_id: `sess-${id}`,
    timestamp: '2026-04-01T00:00:00Z',
    source_component: 'test',
    summary: 'test evidence for host display',
    axis_refs: [],
    candidate_rule_refs: [],
    confidence: 0.5,
    raw_payload: {},
    ...(host !== undefined ? { host } : {}),
  };
  fs.writeFileSync(path.join(BEHAVIOR_DIR, `${id}.json`), JSON.stringify(evidence));
}

describe('collectMultiHostData', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('evidence 없으면 { claude:0, codex:0, opencode:0, total:0 } 반환', () => {
    const data = collectMultiHostData();
    expect(data).toEqual({ claude: 0, codex: 0, opencode: 0, total: 0 });
  });

  it('claude 3개 + codex 2개 → 합산 정확', () => {
    writeEvidence('e1', 'claude');
    writeEvidence('e2', 'claude');
    writeEvidence('e3', 'claude');
    writeEvidence('e4', 'codex');
    writeEvidence('e5', 'codex');

    const data = collectMultiHostData();
    expect(data.claude).toBe(3);
    expect(data.codex).toBe(2);
    expect(data.total).toBe(5);
  });

  it('host 미지정 evidence 는 claude 로 backfill', () => {
    writeEvidence('legacy', undefined);

    const data = collectMultiHostData();
    expect(data.claude).toBe(1);
    expect(data.codex).toBe(0);
    expect(data.total).toBe(1);
  });

  it('summarizeAllByHost() 결과와 동일한 값 반환', async () => {
    writeEvidence('c1', 'claude');
    writeEvidence('c2', 'claude');
    writeEvidence('x1', 'codex');

    // 모듈을 다시 로드하지 않고 동일 환경에서 비교
    const { summarizeAllByHost } = await import('../../src/store/host-mismatch.js');
    const direct = summarizeAllByHost();
    const fromCollect = collectMultiHostData();

    expect(fromCollect.claude).toBe(direct.claude);
    expect(fromCollect.codex).toBe(direct.codex);
    expect(fromCollect.total).toBe(direct.total);
  });
});

describe('renderDashboard — Multi-Host Evidence 섹션', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('대시보드 출력에 "Multi-Host Evidence" 헤더 포함', () => {
    const output = renderDashboard();
    expect(output).toContain('Multi-Host Evidence');
  });

  it('evidence 없으면 "No evidence recorded yet." 출력', () => {
    const output = renderDashboard();
    expect(output).toContain('No evidence recorded yet.');
  });

  it('claude:N codex:M total:N+M 형식 출력', () => {
    writeEvidence('d1', 'claude');
    writeEvidence('d2', 'claude');
    writeEvidence('d3', 'codex');

    const output = renderDashboard();
    expect(output).toMatch(/claude:\d+.*codex:\d+.*total:\d+/);
  });

  it('skew 80%+ 시 경고 문자열 포함', () => {
    // claude 5개, codex 0개 → 100% claude
    for (let i = 0; i < 5; i++) {
      writeEvidence(`skew-c${i}`, 'claude');
    }

    const output = renderDashboard();
    // 경고 메시지 (ANSI 코드 포함 가능하므로 키워드만 확인)
    expect(output).toContain('집중');
  });
});

describe('doctor [Multi-Host] 섹션', () => {
  let capturedLines: string[];

  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
    capturedLines = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      capturedLines.push(args.join(' '));
    });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('[Multi-Host] 섹션이 출력에 포함됨', async () => {
    await runDoctor();
    const output = capturedLines.join('\n');
    expect(output).toContain('[Multi-Host]');
  });

  it('evidence 없으면 "No evidence recorded yet." 출력', async () => {
    await runDoctor();
    const output = capturedLines.join('\n');
    expect(output).toContain('No evidence recorded yet.');
  });

  it('evidence 있으면 "Registered hosts: claude, codex" + 비율 출력', async () => {
    writeEvidence('dr1', 'claude');
    writeEvidence('dr2', 'claude');
    writeEvidence('dr3', 'codex');

    await runDoctor();
    const output = capturedLines.join('\n');
    expect(output).toContain('Registered hosts: claude, codex');
    expect(output).toMatch(/Evidence by host:.*claude:\d+.*codex:\d+.*total:\d+/);
  });

  it('skew 80%+ (5개 이상) 시 ⚠ 경고 출력', async () => {
    for (let i = 0; i < 5; i++) {
      writeEvidence(`warn-c${i}`, 'claude');
    }

    await runDoctor();
    const output = capturedLines.join('\n');
    expect(output).toContain('⚠');
    expect(output).toContain('집중');
  });

  it('표본 적으면 (< 5) skew 경고 없음', async () => {
    writeEvidence('small1', 'claude');
    writeEvidence('small2', 'claude');

    await runDoctor();
    // ⚠ 경고가 [Multi-Host] 섹션에만 없어야 함 (State Hygiene 등 다른 ⚠ 는 무관)
    const multiHostIdx = capturedLines.findIndex(l => l.includes('[Multi-Host]'));
    const afterMultiHost = capturedLines.slice(multiHostIdx, multiHostIdx + 5).join('\n');
    expect(afterMultiHost).not.toContain('집중');
  });
});
