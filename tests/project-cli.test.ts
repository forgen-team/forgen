import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-project-cli-')));
process.env.FORGEN_HOME = path.join(TMP, '.forgen');
fs.mkdirSync(process.env.FORGEN_HOME, { recursive: true });

const { handleProject } = await import('../src/core/project-cli.js');
const { readProjectRegistry, PROJECT_REGISTRY_PATH } = await import('../src/store/project-registry.js');

const a = path.join(TMP, 'a'); const b = path.join(TMP, 'b');
fs.mkdirSync(a); fs.mkdirSync(b);
const quiet = <T>(f: () => T): T => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return f(); } finally { console.log = l; console.error = e; } };

describe('forgen project add --alias', () => {
  beforeEach(() => { try { fs.unlinkSync(PROJECT_REGISTRY_PATH); } catch { /* 없음 */ } process.exitCode = 0; });

  it('여러 번 준 --alias 를 모두 받고, 값을 폴더로 오인하지 않는다', () => {
    quiet(() => handleProject(['add', 'p', a, '--alias', 'old-a', '--alias', 'old-b']));
    const e = readProjectRegistry().projects.p;
    expect(e.aliases).toEqual(['old-a', 'old-b']);
    expect(e.paths).toEqual([a]);
    expect(process.exitCode).toBe(0);
  });
  it('쉼표·= 형식도 받는다', () => {
    quiet(() => handleProject(['add', 'p', a, b, '--alias=x1,x2', '--alias', 'x3']));
    const e = readProjectRegistry().projects.p;
    expect(e.aliases).toEqual(['x1', 'x2', 'x3']);
    expect(e.paths).toEqual([a, b]);
  });
  it('값 없는 --alias·모르는 옵션은 오류로 멈춘다(아무것도 쓰지 않음)', () => {
    quiet(() => handleProject(['add', 'p', a, '--alias']));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    quiet(() => handleProject(['add', 'p', a, '--alias', '--x']));
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    quiet(() => handleProject(['add', 'p', a, '--path', b]));
    expect(process.exitCode).toBe(1);
    expect(fs.existsSync(PROJECT_REGISTRY_PATH)).toBe(false);
    process.exitCode = 0;
  });
});
