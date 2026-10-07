/**
 * forgen statusline install — settings.json statusLine 자동 등록 정책 (2026-10-07).
 * 격리 settings 파일 경로 주입. 프로덕션 ~/.claude 미접촉.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installStatusline, isForgenStatusline, forgenStatuslineCommand } from '../src/core/statusline-install.js';

function tmpSettings(content?: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-sl-install-'));
  const p = path.join(dir, 'settings.json');
  if (content) fs.writeFileSync(p, JSON.stringify(content, null, 2));
  return p;
}
const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;

describe('isForgenStatusline', () => {
  it('없음/forgen …/절대경로 dist/cli.js statusline → forgen 소유, 그 외 커스텀', () => {
    expect(isForgenStatusline(undefined)).toBe(true);
    expect(isForgenStatusline('forgen statusline')).toBe(true);
    expect(isForgenStatusline('forgen me')).toBe(true);
    expect(isForgenStatusline('"/usr/bin/node" "/x/node_modules/@wooojin/forgen/dist/cli.js" statusline')).toBe(true);
    expect(isForgenStatusline('bash -c \'"/Users/u/.bun/bin/bun" "$(ls -td ~/.claude/plugins/cache/claude-hud/*/ | head -1)src/index.ts"\'')).toBe(false);
  });
  it('명령은 현재 node·cli.js 절대 경로 — PATH/nvm 무관', () => {
    const c = forgenStatuslineCommand();
    expect(c).toContain(process.execPath);
    expect(c).toMatch(/[\\/]cli\.js" statusline$/); // src 에서 돌면 src/cli.js, dist 에서는 dist/cli.js
  });
});

describe('installStatusline', () => {
  it('settings.json 없음 → 생성 + 등록 (installed)', () => {
    const p = tmpSettings();
    const r = installStatusline({ settingsPath: p });
    expect(r.status).toBe('installed');
    expect((read(p).statusLine as { command: string }).command).toBe(forgenStatuslineCommand());
  });
  it('forgen 소유(PATH 의존 "forgen statusline") → 절대 경로로 갱신 (updated), 백업 파일 생성', () => {
    const p = tmpSettings({ statusLine: { type: 'command', command: 'forgen statusline' }, other: 1 });
    const r = installStatusline({ settingsPath: p });
    expect(r.status).toBe('updated');
    expect(read(p).other).toBe(1);
    expect(fs.existsSync(`${p}.bak`)).toBe(true);
    expect(installStatusline({ settingsPath: p }).status).toBe('unchanged');
  });
  it('커스텀(claude-hud) → 기본은 건드리지 않고 안내 (skipped_custom); --force 면 backup 키에 보관 후 교체', () => {
    const hud = 'bash -c \'"/Users/u/.bun/bin/bun" "x/src/index.ts"\'';
    const p = tmpSettings({ statusLine: { type: 'command', command: hud } });
    const r = installStatusline({ settingsPath: p });
    expect(r.status).toBe('skipped_custom');
    expect(r.message).toContain('--force');
    expect((read(p).statusLine as { command: string }).command).toBe(hud);
    const f = installStatusline({ settingsPath: p, force: true });
    expect(f.status).toBe('updated');
    expect(f.backedUp).toBe(true);
    const s = read(p);
    expect((s.statusLine as { command: string }).command).toBe(forgenStatuslineCommand());
    expect(s.statusLine_backup).toBe(hud);
  });
  it('settings.json 이 깨져 있으면 건드리지 않고 error', () => {
    const p = tmpSettings();
    fs.writeFileSync(p, '{ not json');
    const r = installStatusline({ settingsPath: p });
    expect(r.status).toBe('error');
    expect(fs.readFileSync(p, 'utf-8')).toBe('{ not json');
  });
});
