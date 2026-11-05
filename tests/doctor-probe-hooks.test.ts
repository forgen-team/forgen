/**
 * FORGEN_DOCTOR_PROBE=1 — doctor 가 hook 을 실행해 볼 때 hook 쪽 부작용 경로(세션 상태 기록, auto-compound 스폰,
 * lifecycle 스폰)를 실제로 건너뛰는지, 같은 조건에서 플래그만 빼면 실제로 일어나는지(대조)를 프로세스로 확인한다.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SESSION_RECOVERY = path.join(ROOT, 'dist', 'hooks', 'session-recovery.js');
const CONTEXT_GUARD = path.join(ROOT, 'dist', 'hooks', 'context-guard.js');

const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(p: string, ms: number): boolean {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fs.existsSync(p)) return true; sleepMs(50); }
  return fs.existsSync(p);
}

function mkHome(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-probe-hooks-')); }
function envFor(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_CWD: home, ...extra };
  for (const k of ['FORGEN_NESTED_RUN', 'FORGEN_DOCTOR_PROBE', 'FORGEN_SESSION_ID']) if (!(k in extra)) delete env[k];
  return env;
}
function transcript(home: string, sid: string, n: number): string {
  const dir = path.join(home, '.claude', 'projects', home.replace(/\//g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sid}.jsonl`);
  const text = 'a sufficiently long test message content to pass the summary threshold of the auto compound runner, repeated enough times to exceed two hundred characters in total.';
  fs.writeFileSync(p, Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `m${i} ${text}` } })).join('\n') + '\n');
  return p;
}

describe('FORGEN_DOCTOR_PROBE=1 — 부작용 경로 차단', () => {
  it('Stop hook: auto-compound 러너를 스폰하지 않는다 (플래그 없으면 스폰)', () => {
    for (const probe of [true, false]) {
      const home = mkHome();
      try {
        const sid = `sess-${probe ? 'probe' : 'ctl'}`;
        fs.mkdirSync(path.join(home, '.forgen', 'state'), { recursive: true });
        fs.writeFileSync(path.join(home, '.forgen', 'state', 'context-guard.json'), JSON.stringify({ sessionId: sid, promptCount: 12, totalChars: 0, lastWarningAt: 0, lastAutoCompactAt: 0 }));
        const tpath = transcript(home, sid, 12);
        const fake = path.join(home, 'fake-runner.js');
        fs.writeFileSync(fake, `require('node:fs').writeFileSync(${JSON.stringify(path.join(home, 'spawned.marker'))}, 'x');\n`);
        const r = spawnSync('node', [CONTEXT_GUARD], {
          input: JSON.stringify({ session_id: sid, stop_hook_type: 'user', transcript_path: tpath }),
          env: envFor(home, { FORGEN_AUTO_COMPOUND_RUNNER_PATH: fake, FORGEN_TEST: '1', ...(probe ? { FORGEN_DOCTOR_PROBE: '1' } : {}) }),
          encoding: 'utf-8', timeout: 10_000,
        });
        expect(r.status).toBe(0);
        const spawned = waitFor(path.join(home, 'spawned.marker'), probe ? 1500 : 6000);
        expect(spawned, probe ? '프로브인데 스폰됨' : '대조군인데 스폰 안 됨').toBe(!probe);
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    }
  }, 30_000);

  it('SessionStart hook: 세션 상태 기록·이전 세션 auto-compound·lifecycle 스폰을 하지 않는다 (플래그 없으면 한다)', () => {
    for (const probe of [true, false]) {
      const home = mkHome();
      try {
        const cwd = path.join(home, 'work');
        fs.mkdirSync(cwd, { recursive: true });
        fs.mkdirSync(path.join(home, '.forgen', 'state'), { recursive: true });
        // 이전 세션 transcript (user 10건 이상) → 플래그가 없으면 auto-compound 러너 스폰
        const dir = path.join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
        fs.mkdirSync(dir, { recursive: true });
        const text = 'a sufficiently long test message content to pass the summary threshold of the auto compound runner, repeated enough times to exceed two hundred characters in total.';
        fs.writeFileSync(path.join(dir, 'prev-session.jsonl'), Array.from({ length: 12 }, (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `m${i} ${text}` } })).join('\n') + '\n');
        const r = spawnSync('node', [SESSION_RECOVERY], {
          input: JSON.stringify({ session_id: 'cur-session', cwd }),
          env: envFor(home, { FORGEN_CWD: cwd, ...(probe ? { FORGEN_DOCTOR_PROBE: '1' } : {}) }),
          cwd, encoding: 'utf-8', timeout: 20_000,
        });
        expect(r.status, r.stderr).toBe(0);
        expect(() => JSON.parse(r.stdout.trim()), r.stdout).not.toThrow(); // 프로브여도 hook 출력은 유효 JSON 1개
        const stateSessions = path.join(home, '.forgen', 'state', 'sessions');
        const wrote = fs.existsSync(stateSessions); // bootstrapV1Session 이 돌았다는 표식 (세션 상태 폴더 생성)
        const lifecycleMarker = path.join(home, '.forgen', 'state', 'last-lifecycle.json');
        const compoundEvents = path.join(home, '.forgen', 'state', 'extraction-events.jsonl'); // 러너는 일찍 끝나도 이벤트를 남긴다
        const ran = waitFor(compoundEvents, probe ? 2000 : 8000);
        if (probe) {
          expect(wrote, '세션 상태가 기록됨').toBe(false);
          expect(fs.existsSync(lifecycleMarker), 'lifecycle 스폰 표식').toBe(false);
          expect(ran, 'auto-compound 러너가 스폰됨').toBe(false);
        } else {
          expect(wrote, '대조군: 세션 상태 기록').toBe(true);
          expect(fs.existsSync(lifecycleMarker), '대조군: lifecycle').toBe(true);
          expect(ran, '대조군: auto-compound 스폰').toBe(true);
        }
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    }
  }, 60_000);
});
