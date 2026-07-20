/**
 * forge-loop Stop 훅 — 실제 컴파일된 dist hook 을 서브프로세스로 실행하는 e2e.
 *
 * tests/forge-loop-stop-hook.test.ts 는 checkForgeLoopActive()를 직접 import 해
 * 순수 로직을 검증한다. 본 파일은 hook-single-line-output.test.ts 와 동일한
 * 패턴으로 실제 `node dist/hooks/context-guard.js` 프로세스에 Stop 이벤트 stdin
 * 을 주입해, 소유 세션 차단(block) + 전체 완료 해제(release) 경로가 실제
 * 프로세스 경계를 통과해도 동작함을 검증한다.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK_FILE = path.join(REPO_ROOT, 'dist', 'hooks', 'context-guard.js');

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-forge-loop-e2e-'));
}

function stateFilePath(home: string): string {
  return path.join(home, '.forgen', 'state', 'forge-loop.json');
}

function writeState(home: string, state: unknown): void {
  const p = stateFilePath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state));
}

function runStop(home: string, sessionId: string) {
  return spawnSync('node', [HOOK_FILE], {
    input: JSON.stringify({
      hook_event_name: 'Stop',
      stop_hook_type: 'end_turn',
      session_id: sessionId,
      transcript_path: path.join(home, 'no-such-transcript.jsonl'),
      cwd: REPO_ROOT,
    }),
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
    timeout: 10000,
  });
}

describe('forge-loop Stop hook — real spawned process', () => {
  it('block path: 소유 세션의 Stop을 실제 프로세스 경계에서 차단한다', () => {
    const home = makeHome();
    try {
      writeState(home, {
        active: true,
        startedAt: new Date().toISOString(),
        sessionId: 'owner-session',
        stories: [{ id: 'US-001', title: '결제 API 구현', passes: false, acceptanceCriteria: ['POST /pay가 201을 반환한다'] }],
      });
      const proc = runStop(home, 'owner-session');
      const lines = proc.stdout.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.continue).toBe(true);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toContain('US-001');
      expect(parsed.reason).toContain('AC1: POST /pay가 201을 반환한다');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('non-owning session path: 다른 세션의 Stop은 차단되지 않는다', () => {
    const home = makeHome();
    try {
      writeState(home, {
        active: true,
        startedAt: new Date().toISOString(),
        sessionId: 'owner-session',
        stories: [{ id: 'US-001', title: 't', passes: false }],
      });
      const proc = runStop(home, 'other-session');
      const lines = proc.stdout.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.decision).toBeUndefined();
      // 소유 세션의 루프 상태는 다른 세션의 Stop으로 손상되지 않는다.
      const after = JSON.parse(fs.readFileSync(stateFilePath(home), 'utf-8'));
      expect(after.active).toBe(true);
      expect(after.sessionId).toBe('owner-session');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('release path: 모든 스토리 완료 시 이후 Stop은 더 이상 차단하지 않는다', () => {
    const home = makeHome();
    try {
      writeState(home, {
        active: true,
        startedAt: new Date().toISOString(),
        sessionId: 'owner-session',
        stories: [{ id: 'US-001', title: 't', passes: true }],
      });
      const proc = runStop(home, 'owner-session');
      const lines = proc.stdout.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.decision).toBeUndefined();
      const after = JSON.parse(fs.readFileSync(stateFilePath(home), 'utf-8'));
      expect(after.active).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('FORGEN_USER_CONFIRMED=1 우회: 이번 턴은 통과하되 루프 상태는 유지', () => {
    const home = makeHome();
    try {
      writeState(home, {
        active: true,
        startedAt: new Date().toISOString(),
        sessionId: 'owner-session',
        blockCount: 4,
        stories: [{ id: 'US-001', title: 't', passes: false }],
      });
      const proc = spawnSync('node', [HOOK_FILE], {
        input: JSON.stringify({
          hook_event_name: 'Stop',
          stop_hook_type: 'end_turn',
          session_id: 'owner-session',
          transcript_path: path.join(home, 'no-such-transcript.jsonl'),
          cwd: REPO_ROOT,
        }),
        env: { ...process.env, HOME: home, FORGEN_USER_CONFIRMED: '1' },
        encoding: 'utf-8',
        timeout: 10000,
      });
      const lines = proc.stdout.trim().split('\n').filter(Boolean);
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.decision).toBeUndefined();
      const after = JSON.parse(fs.readFileSync(stateFilePath(home), 'utf-8'));
      expect(after.active).toBe(true); // 다음 Stop에서 다시 평가 가능
      expect(after.blockCount).toBe(4); // 카운트 불변
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
