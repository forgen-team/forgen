/**
 * OpenCode 런타임 로드 검증 (W3-3 P1) — 실제 opencode 바이너리가 forgen plugin + MCP 를
 * 로드하는지 실측. 네트워크/시간 의존이라 기본 비활성: `FORGEN_OPENCODE_E2E=1` + opencode
 * 바이너리가 있을 때만 실행(CI 는 skip). 격리 XDG_CONFIG_HOME 으로 사용자 실 config 미접촉.
 *
 * verificationLevel='docs' → 이 테스트가 plugin-load + MCP 를 runtime 확인(guard 발화 end-to-end
 * 는 model API 필요라 여기서도 미검증 — 로드/MCP 만).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distCli = path.join(repoRoot, 'dist', 'cli.js');

function opencodeAvailable(): boolean {
  try {
    execFileSync('opencode', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const ENABLED = process.env.FORGEN_OPENCODE_E2E === '1' && opencodeAvailable();

describe.skipIf(!ENABLED)('opencode 런타임 로드 (실 opencode 바이너리)', () => {
  const xdg = path.join(os.tmpdir(), `forgen-oc-e2e-${process.pid}`);
  let logs = '';

  beforeAll(() => {
    if (!fs.existsSync(distCli)) execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'ignore' });
    fs.mkdirSync(path.join(xdg, 'opencode'), { recursive: true });
    // 격리 config 에 forgen 배포
    execFileSync('node', [distCli, 'install', 'opencode'], {
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
      // opencodeConfigDir 는 XDG 기반이라 XDG_CONFIG_HOME 로 격리
      stdio: 'ignore',
    });
    // opencode 를 headless 로 돌려 plugin/MCP 로드 로그 캡처 (model 은 실패해도 로드는 먼저)
    const res = spawnSync('opencode', ['run', 'hi', '--print-logs', '--log-level', 'DEBUG'], {
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
      cwd: xdg,
      encoding: 'utf-8',
      timeout: 45000,
    });
    logs = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  }, 60000);

  it('opencode 가 forgen plugin 을 로드한다', () => {
    expect(logs).toMatch(/plugins\/forgen\.ts.*loading plugin/);
  });

  it('opencode 가 forgen-compound MCP 를 등록·로드한다', () => {
    expect(logs).toMatch(/forgen-compound/);
  });
});
