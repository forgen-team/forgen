import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-frozen-'));
process.env.FORGEN_HOME = TMP;
const { recordFrozenUse, frozenUsageSince, FROZEN_USAGE_PATH } = await import('../src/core/frozen-features.js');

describe('동결 기능 사용 기록 (0.8.3)', () => {
  beforeEach(() => { try { fs.unlinkSync(FROZEN_USAGE_PATH); } catch { /* 없음 */ } });
  it('기능 이름과 시각만 남기고 기간 안 횟수를 센다', () => {
    recordFrozenUse('inspect'); recordFrozenUse('inspect'); recordFrozenUse('meta-learning');
    fs.appendFileSync(FROZEN_USAGE_PATH, '{broken\n' + JSON.stringify({ at: '2020-01-01T00:00:00Z', feature: 'inspect' }) + '\n');
    expect(frozenUsageSince(Date.now() - 86400_000)).toEqual([{ feature: 'inspect', count: 2 }, { feature: 'meta-learning', count: 1 }]);
    const keys = Object.keys(JSON.parse(fs.readFileSync(FROZEN_USAGE_PATH, 'utf-8').split('\n')[0]));
    expect(keys.sort()).toEqual(['at', 'feature']);
  });
  it('파일이 커지면 90일 지난 줄만 버린다', () => {
    const old = JSON.stringify({ at: '2020-01-01T00:00:00Z', feature: 'inspect' }) + '\n';
    fs.mkdirSync(path.dirname(FROZEN_USAGE_PATH), { recursive: true });
    fs.writeFileSync(FROZEN_USAGE_PATH, old.repeat(Math.ceil(300 * 1024 / old.length)));
    recordFrozenUse('compound-save');
    const lines = fs.readFileSync(FROZEN_USAGE_PATH, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('compound-save');
  });
  it('기록 파일이 없으면 빈 목록', () => {
    expect(frozenUsageSince(0)).toEqual([]);
  });
});

const DIST = path.resolve('dist');
describe.skipIf(!fs.existsSync(path.join(DIST, 'cli.js')))('실제 CLI — 동결 명령은 안내하고 기록한다', () => {
  it('forgen inspect / rule unflag / status 줄', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-frozen-cli-'));
    const env = { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen') };
    const r1 = spawnSync(process.execPath, [path.join(DIST, 'cli.js'), 'inspect', 'profile'], { env, encoding: 'utf-8', timeout: 60000 });
    expect(r1.stderr).toContain('0.9 에서 제거 예정');
    spawnSync(process.execPath, [path.join(DIST, 'cli.js'), 'rule', 'unflag'], { env, encoding: 'utf-8', timeout: 60000 });
    const log = fs.readFileSync(path.join(home, '.forgen', 'state', 'metrics', 'frozen-usage.jsonl'), 'utf-8');
    expect(log).toContain('"inspect"');
    expect(log).toContain('"rule-recovery"');
    const st = spawnSync(process.execPath, [path.join(DIST, 'cli.js'), 'status'], { env, encoding: 'utf-8', timeout: 60000 });
    expect(st.stdout).toMatch(/동결 기능 \(30일\)\s+(inspect|rule-recovery) 1/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
