/**
 * Stop hook auto-compound trigger — debounced + shared dedup with SessionStart path.
 *
 * "forgen 통하지 않은 claude 직접 사용" 경로에서도 세션 종료 시점에 rule 승급이
 * 보장되는지 검증. context-guard.ts Stop handler 가 auto-compound-runner 를
 * detached spawn 하는지 확인.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const CONTEXT_GUARD = path.join(REPO_ROOT, 'dist', 'hooks', 'context-guard.js');

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-acs-trigger-'));
}

function seedContextState(home: string, sessionId: string, promptCount: number): void {
  const statePath = path.join(home, '.forgen', 'state', 'context-guard.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ sessionId, promptCount, totalChars: 0, lastWarningAt: 0, lastAutoCompactAt: 0 }));
}

function seedTranscript(home: string, sessionId: string, userMsgCount: number): string {
  const tdir = path.join(home, '.claude', 'projects', '-proj');
  fs.mkdirSync(tdir, { recursive: true });
  const tpath = path.join(tdir, `${sessionId}.jsonl`);
  const lines: string[] = [];
  // auto-compound-runner 의 summary.length >= 200 gate 를 통과하려면 메시지가 충분히 길어야 함.
  const longText = 'this is a sufficiently long test message content that should easily exceed the 200 character summary threshold imposed by auto-compound-runner to avoid early exit and allow us to observe the marker write side-effect in integration tests.'; // >200 chars
  for (let i = 0; i < userMsgCount; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `msg ${i}: ${longText}` } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i}: ${longText}` }] } }));
  }
  fs.writeFileSync(tpath, lines.join('\n') + '\n');
  return tpath;
}

function runContextGuardStop(home: string, payload: Record<string, unknown>): ReturnType<typeof spawnSync> {
  return spawnSync('node', [CONTEXT_GUARD], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
    timeout: 8000,
  });
}

describe('context-guard Stop → auto-compound spawn', () => {
  it('promptCount ≥ 10 + stop_hook_type=user → spawns runner (verified via FORGEN_AUTO_COMPOUND_RUNNER_PATH double)', () => {
    const home = makeHome();
    try {
      const sid = 'sess-stop-1';
      seedContextState(home, sid, 12);
      const tpath = seedTranscript(home, sid, 12);

      // Test double: 실행되면 marker 를 기록하는 경량 runner.
      const fakeRunnerPath = path.join(home, 'fake-runner.js');
      fs.writeFileSync(fakeRunnerPath, `
        const fs = require('node:fs');
        const path = require('node:path');
        const [,, cwd, transcriptPath, sessionId] = process.argv;
        const markerDir = path.join(cwd, '.forgen', 'state');
        fs.mkdirSync(markerDir, { recursive: true });
        fs.writeFileSync(
          path.join(markerDir, 'fake-runner-invoked.json'),
          JSON.stringify({ cwd, transcriptPath, sessionId, at: new Date().toISOString() })
        );
      `);

      const proc = spawnSync('node', [CONTEXT_GUARD], {
        input: JSON.stringify({ session_id: sid, stop_hook_type: 'user', transcript_path: tpath }),
        env: {
          ...process.env, HOME: home,
          FORGEN_CWD: home,
          FORGEN_AUTO_COMPOUND_RUNNER_PATH: fakeRunnerPath,
        },
        encoding: 'utf-8', timeout: 8000,
      });
      expect(proc.status).toBe(0);
      expect(proc.stdout).toMatch(/프롬프트를 처리했습니다|prompts?\s+ended/);

      // detached child 가 marker 를 쓸 때까지 잠시 대기
      const markerPath = path.join(home, '.forgen', 'state', 'fake-runner-invoked.json');
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !fs.existsSync(markerPath)) {
        const t = Date.now();
        while (Date.now() - t < 50) { /* spin */ }
      }
      expect(fs.existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      expect(marker.sessionId).toBe(sid);
      expect(marker.transcriptPath).toBe(tpath);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 15000);

  it('promptCount ≥ 20 + stop_hook_type=user → pending-compound marker + session-end 메시지', () => {
    const home = makeHome();
    try {
      const sid = 'sess-stop-big';
      seedContextState(home, sid, 25);
      const tpath = seedTranscript(home, sid, 25);

      const proc = runContextGuardStop(home, {
        session_id: sid, stop_hook_type: 'user', transcript_path: tpath,
      });
      expect(proc.status).toBe(0);
      expect(proc.stdout).toMatch(/Session with 25 prompts ended|auto-trigger/);
      const markerPath = path.join(home, '.forgen', 'state', 'pending-compound.json');
      expect(fs.existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
      expect(marker.promptCount).toBe(25);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('promptCount < 10 → no spawn (marker 없음)', () => {
    const home = makeHome();
    try {
      const sid = 'sess-small';
      seedContextState(home, sid, 5);
      const tpath = seedTranscript(home, sid, 5);
      const proc = runContextGuardStop(home, { session_id: sid, stop_hook_type: 'user', transcript_path: tpath });
      expect(proc.status).toBe(0);
      const markerPath = path.join(home, '.forgen', 'state', 'last-auto-compound.json');
      // 1초 기다려 spawn 안 일어남 확인
      const now = Date.now();
      while (Date.now() - now < 1000) { /* spin */ }
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('cooldown 내 같은 sessionId → skip (dedup with session-recovery)', () => {
    const home = makeHome();
    try {
      const sid = 'sess-cool';
      seedContextState(home, sid, 15);
      const tpath = seedTranscript(home, sid, 15);
      // seed marker: 같은 sessionId + 방금 완료
      const markerPath = path.join(home, '.forgen', 'state', 'last-auto-compound.json');
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({ sessionId: sid, completedAt: new Date().toISOString() }));
      const beforeSize = fs.statSync(markerPath).size;

      const proc = runContextGuardStop(home, { session_id: sid, stop_hook_type: 'user', transcript_path: tpath });
      expect(proc.status).toBe(0);

      // Marker 변경 없음 (cooldown skip)
      const now = Date.now();
      while (Date.now() - now < 1000) { /* spin */ }
      // spawn skipped → marker mtime/size 변화 없어야 함
      const afterSize = fs.statSync(markerPath).size;
      expect(afterSize).toBe(beforeSize);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('transcript_path 없으면 → skip', () => {
    const home = makeHome();
    try {
      const sid = 'sess-no-trans';
      seedContextState(home, sid, 15);
      const proc = runContextGuardStop(home, { session_id: sid, stop_hook_type: 'user' });
      expect(proc.status).toBe(0);
      const markerPath = path.join(home, '.forgen', 'state', 'last-auto-compound.json');
      const now = Date.now();
      while (Date.now() - now < 1000) { /* spin */ }
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
