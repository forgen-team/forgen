/**
 * postinstall 자동 마이그레이션 — 이전 형식 forgen 훅 명령만 shim 으로, 순서·사용자 훅 보존 (2026-10-07).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateCodexHooksToShim, codexHookShimPath } from '../../src/host/codex-hook-shim.js';

const ROOT = '/home/u/.nvm/versions/node/v22.22.0/lib/node_modules/@wooojin/forgen';
const legacy = (n: string, arg = '') => `node "${ROOT}/dist/host/codex-adapter.js" "${ROOT}/dist/hooks/${n}.js"${arg}`;

function setup(hooks: object): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-shim-mig-'));
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ hooks }, null, 2));
  return home;
}

describe('migrateCodexHooksToShim', () => {
  it('forgen 훅만 shim 으로 바꾸고 사용자 훅·그룹 순서·인자는 그대로, shim 작성 + 백업', () => {
    const home = setup({
      Stop: [
        { matcher: '*', hooks: [{ type: 'command', command: 'echo user', timeout: 1 }] },
        { matcher: '*', hooks: [{ type: 'command', command: legacy('stop-guard'), timeout: 5 }] },
      ],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: legacy('subagent-tracker', ' stop'), timeout: 3 }] }],
    });
    const r = migrateCodexHooksToShim(home, '/new/pkg', '/new/node');
    expect(r).toEqual({ status: 'migrated', rewritten: 2 });
    const f = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf-8'));
    const shim = codexHookShimPath(home);
    expect(f.hooks.Stop[0].hooks[0].command).toBe('echo user');
    expect(f.hooks.Stop[1].hooks[0].command).toBe(`"${shim}" "hooks/stop-guard.js"`);
    expect(f.hooks.Stop[1].hooks[0].timeout).toBe(5);
    expect(f.hooks.PreToolUse[0].hooks[0].command).toBe(`"${shim}" "hooks/subagent-tracker.js" stop`);
    expect(fs.readFileSync(shim, 'utf-8')).toContain("FORGEN_PKG='/new/pkg'");
    expect(fs.existsSync(path.join(home, 'hooks.json.bak-pre-shim'))).toBe(true);
  });

  it('이미 shim 이거나 forgen 훅이 없으면 no-op (파일 불변)', () => {
    const home = setup({ Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user' }] }] });
    const before = fs.readFileSync(path.join(home, 'hooks.json'), 'utf-8');
    expect(migrateCodexHooksToShim(home, '/p', '/n').status).toBe('none');
    expect(fs.readFileSync(path.join(home, 'hooks.json'), 'utf-8')).toBe(before);
    expect(fs.existsSync(codexHookShimPath(home))).toBe(false);
  });

  it('다른 프로젝트의 dist/host/codex-adapter.js 라도 hooks/ 형태가 아니면 건드리지 않음', () => {
    const other = 'node "/x/dist/host/codex-adapter.js" "/x/dist/scripts/run.js"';
    const home = setup({ Stop: [{ matcher: '*', hooks: [{ type: 'command', command: other }] }] });
    expect(migrateCodexHooksToShim(home, '/p', '/n').status).toBe('none');
  });

  it('hooks.json 없음 / 깨짐 → 쓰지 않음', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-shim-mig-'));
    expect(migrateCodexHooksToShim(empty, '/p', '/n').status).toBe('no-hooks-file');
    fs.writeFileSync(path.join(empty, 'hooks.json'), '{ broken');
    expect(migrateCodexHooksToShim(empty, '/p', '/n').status).toBe('error');
    expect(fs.readFileSync(path.join(empty, 'hooks.json'), 'utf-8')).toBe('{ broken');
  });
});
