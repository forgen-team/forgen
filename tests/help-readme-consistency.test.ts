/**
 * help ↔ README 일치 (D8). 없는 명령을 안내하거나, 있는 명령이 help 에서 빠지면 실패한다.
 * 명령 목록은 src/cli.ts 의 레지스트리에서 읽고, help 는 실제 CLI 출력으로 확인한다.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const cliSrc = fs.readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf-8');

// 레지스트리 배열 구간만 읽는다 (그 밖의 `name:` 문자열과 섞이지 않게)
const regSrc = cliSrc.slice(cliSrc.indexOf('const commands: Command[] = ['), cliSrc.indexOf('// `forgen rule <subcommand>`'));
const registry = new Set<string>(); // help 에 보여야 하는 정식 이름
const callable = new Set<string>(); // README 가 써도 되는 이름 (별칭 포함)
for (const m of regSrc.matchAll(/^ {4}name: '([\w-]+)'/gm)) { registry.add(m[1]); callable.add(m[1]); }
for (const m of regSrc.matchAll(/^ {4}aliases: \[([^\]]*)\]/gm)) for (const a of m[1].matchAll(/'([\w-]+)'/g)) callable.add(a[1]);
// main() 이 레지스트리 밖에서 직접 처리하는 브릿지
for (const m of cliSrc.matchAll(/args\[0\] === '(opencode-[\w-]+)'/g)) { registry.add(m[1]); callable.add(m[1]); }
callable.add('help');

const help = (() => {
  const r = spawnSync('node', [CLI, 'help'], { encoding: 'utf-8', timeout: 30_000 });
  return r.stdout;
})();

describe('help 는 등록된 모든 명령을 보여 준다', () => {
  it('레지스트리를 읽었다', () => {
    expect(registry.size).toBeGreaterThan(20);
    expect(registry.has('doctor')).toBe(true);
  });
  for (const name of registry) {
    it(`help 에 forgen ${name}`, () => {
      expect(help).toMatch(new RegExp(`forgen ${name}(?![\\w-])`));
    });
  }
});

describe('README 4개 언어가 안내하는 명령은 실제로 존재한다', () => {
  for (const file of ['README.md', 'README.ko.md', 'README.ja.md', 'README.zh.md']) {
    it(file, () => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      const used = new Set<string>();
      let inFence = false;
      const take = (cmd: string) => {
        // 환경변수 접두(FOO=bar forgen …)와 $ 프롬프트를 제거하고 forgen 으로 시작하는 줄만 본다.
        const m = cmd.trim().replace(/^\$\s*/, '').replace(/^(?:[A-Z_]+=\S+\s+)+/, '').match(/^forgen ([a-z][\w-]*)/);
        if (m) used.add(m[1]);
      };
      for (const line of text.split('\n')) {
        if (line.trim().startsWith('```')) { inFence = !inFence; continue; }
        if (inFence) take(line);
        else for (const seg of line.matchAll(/`([^`]+)`/g)) take(seg[1]);
      }
      const unknown = [...used].filter((c) => !callable.has(c));
      expect(unknown, `README 에 있으나 CLI 에 없는 명령: ${unknown.join(', ')}`).toEqual([]);
    });
  }
});
