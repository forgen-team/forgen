/**
 * [Codex Parity] doctor 섹션 출력 검증
 *
 * 검증:
 *   - parity-result.json 없음 → 미실행 안내
 *   - passed=true, 1일 경과 (fresh) → green 메시지
 *   - passed=true, 8일 경과 (stale) → stale 경고
 *   - passed=false → FAILED 메시지
 *   - passed=null (dry-run) → dry-run only 안내
 *
 * FORGEN_HOME 은 paths 모듈 로드 시점에 캡처되므로, 각 test 는 vi.resetModules() +
 * 동적 import 로 격리한다 (host-tagged-evidence.test.ts 패턴).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalForgenHome: string | undefined;
let isolatedHome: string;

beforeEach(() => {
  originalForgenHome = process.env.FORGEN_HOME;
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-codex-parity-'));
  process.env.FORGEN_HOME = isolatedHome;
  // state 디렉토리 생성
  fs.mkdirSync(path.join(isolatedHome, 'state'), { recursive: true });
});

afterEach(() => {
  if (originalForgenHome === undefined) delete process.env.FORGEN_HOME;
  else process.env.FORGEN_HOME = originalForgenHome;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** doctor 모듈을 격리 재로드하여 stdout을 캡처한다 */
async function runDoctorCaptured(): Promise<string> {
  vi.resetModules();
  const lines: string[] = [];
  const origLog = console.log;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  const { runDoctor } = (await import('../../src/core/doctor.js')) as typeof import('../../src/core/doctor.js');
  await runDoctor();
  console.log = origLog;
  return lines.join('\n');
}

/** parity-result.json 을 격리 홈에 작성 */
function writeParityResult(data: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(isolatedHome, 'state', 'parity-result.json'),
    JSON.stringify(data),
  );
}

describe('[Codex Parity] doctor 섹션', () => {
  it('parity-result.json 없음 → 미실행 안내', async () => {
    const output = await runDoctorCaptured();
    expect(output).toContain('[Codex Parity]');
    expect(output).toContain('Codex parity 미실행');
    expect(output).toContain('run-parity.sh');
  });

  it('passed=true, 1일 경과 (fresh) → green 메시지', async () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeParityResult({ passed: true, at: oneDayAgo, version: '0.4.2' });
    const output = await runDoctorCaptured();
    expect(output).toContain('[Codex Parity]');
    expect(output).toContain('✓ Codex parity green');
    expect(output).toContain('version 0.4.2');
    expect(output).not.toContain('stale');
  });

  it('passed=true, 8일 경과 (stale) → stale 경고', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeParityResult({ passed: true, at: eightDaysAgo, version: '0.4.1' });
    const output = await runDoctorCaptured();
    expect(output).toContain('[Codex Parity]');
    expect(output).toContain('△ Codex parity green but stale');
    expect(output).toContain('재실행 권장');
  });

  it('passed=false → FAILED 메시지 (detail 포함)', async () => {
    const now = new Date().toISOString();
    writeParityResult({ passed: false, at: now, result: 'hook mismatch on codex' });
    const output = await runDoctorCaptured();
    expect(output).toContain('[Codex Parity]');
    expect(output).toContain('✗ Codex parity FAILED');
    expect(output).toContain('hook mismatch on codex');
  });

  it('passed=null (dry-run) → dry-run only 안내', async () => {
    const now = new Date().toISOString();
    writeParityResult({ passed: null, at: now });
    const output = await runDoctorCaptured();
    expect(output).toContain('[Codex Parity]');
    expect(output).toContain('dry-run only');
    expect(output).toContain('실 실행 필요');
  });
});
