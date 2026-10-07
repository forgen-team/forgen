/**
 * statusline stdin — Claude Code 가 실제로 쓰는 spawn 경로 재현 (2026-10-07 실사용 관측 회귀).
 *
 * Claude Code(Node)는 `stdio: 'pipe'` 로 statusline 을 띄우고, Linux 에서 그 stdin 은 UNIX socketpair 다.
 * `fs.readFileSync('/dev/stdin')` 은 소켓에서 ENXIO 로 실패하므로 이전 구현은 페이로드를 늘 `{}` 로 읽었다.
 * 셸 파이프(`echo … | forgen statusline`)로만 검증하면 통과해 버려서 이 테스트는 **Node spawn 으로** 검증한다.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLI = path.resolve(import.meta.dirname, '..', 'dist', 'cli.js');
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function runStatusline(payload: object, home: string, opts: { late?: boolean; noEnd?: boolean } = {}): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, 'statusline'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen') },
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.on('close', (code) => resolve({ out: strip(out), code }));
    const write = () => { c.stdin.write(JSON.stringify(payload)); if (!opts.noEnd) c.stdin.end(); };
    if (opts.late) setTimeout(write, 150); else write();
    if (opts.noEnd) setTimeout(() => { try { c.stdin.end(); } catch { /* ignore */ } }, 2500);
  });
}

describe.skipIf(!fs.existsSync(CLI))('forgen statusline — Node spawn(socketpair stdin)', () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const payload = {
    session_id: 'sock-A', model: { id: 'claude-fable-5-1', display_name: 'Fable' },
    workspace: { current_dir: '/' },
    context_window: { used_percentage: 42, context_window_size: 1_000_000 },
    rate_limits: { five_hour: { used_percentage: 63, resets_at: reset } },
    cost: { total_cost_usd: 1.23 },
  };

  it('socketpair stdin 으로 넘긴 페이로드를 읽어 모델·ctx·한도를 렌더하고 세션 캐시·샘플을 남긴다', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-sl-sock-'));
    const { out, code } = await runStatusline(payload, home);
    expect(code).toBe(0);
    expect(out.split('\n')[0]).toContain('Fable');
    expect(out).toContain('ctx 42%/1M');
    expect(out).toContain('5h 63%');
    expect(fs.existsSync(path.join(home, '.forgen', 'state', 'statusline-cache-sock-A.txt'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.forgen', 'state', 'current-model-sock-A.json'))).toBe(true);
    expect(fs.readFileSync(path.join(home, '.forgen', 'state', 'rate-limit-samples.jsonl'), 'utf-8')).toContain('"five_hour"');
  });

  it('페이로드가 150ms 늦게 와도 읽는다', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-sl-sock-'));
    const { out } = await runStatusline(payload, home, { late: true });
    expect(out).toContain('ctx 42%/1M');
  });

  it('부모가 stdin 을 닫지 않아도(EOF 없음) 멈추지 않고 idle 후 렌더한다', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-sl-sock-'));
    const t0 = Date.now();
    const { out } = await runStatusline(payload, home, { noEnd: true });
    expect(out).toContain('ctx 42%/1M');
    expect(Date.now() - t0).toBeLessThan(2400); // 2.5s 강제 종료 전에 끝남
  });

  it('페이로드 없음(즉시 EOF) → 빈 페이로드로 모델/경로만 렌더, 실패 없음', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-sl-sock-'));
    const { out, code } = await runStatusline({}, home);
    expect(code).toBe(0);
    expect(out.split('\n')[0]).toContain('Claude');
    expect(out).not.toContain('ctx');
  });
});
