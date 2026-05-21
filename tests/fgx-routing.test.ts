/**
 * v0.4.10: fgx 서브커맨드 라우팅 회귀 가드.
 *
 * fgx 가 forgen 서브커맨드(status/init/maintenance 등) 를 받으면 cli.js 로 라우팅하고,
 * 그 외 인자는 Claude launcher 로 보낸다. 검증은 함수 단위 + 빌드 dist 의 spawn 동작.
 *
 * 헬퍼 함수 `findFirstSubcommand` 는 fgx.ts 가 export 하지 않으므로 같은 규칙을 테스트에서
 * 재구성한다. (인벤토리 sync 가 본 테스트의 메인 가치 — fgx.ts 의 set 가 바뀌면 fail.)
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const FGX_BIN = path.join(PKG_ROOT, 'dist', 'fgx.js');

// fgx.ts:21-28 의 인벤토리와 일치해야 함 — sync 가 무너지면 즉시 fail.
const EXPECTED_SUBCOMMANDS = new Set([
  'forge', 'compound', 'skill', 'dashboard', 'learn', 'me', 'statusline',
  'config', 'mcp', 'init', 'install', 'status', 'maintenance', 'parity',
  'notepad', 'inspect', 'onboarding', 'doctor', 'uninstall', 'rule',
  'classify-enforce', 'rule-meta-scan', 'lifecycle-scan',
  'stats', 'last-block', 'recall', 'migrate', 'suppress-rule', 'activate-rule',
  'regress-map',
  'help', '--help', '-h', '--version', '-V',
]);

describe('fgx 서브커맨드 인벤토리 sync', () => {
  it('fgx.ts 의 FORGEN_SUBCOMMANDS Set 가 기대값과 일치', () => {
    const src = fs.readFileSync(path.join(PKG_ROOT, 'src', 'fgx.ts'), 'utf-8');
    // FORGEN_SUBCOMMANDS Set 블록 추출
    const match = src.match(/const FORGEN_SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\);/);
    expect(match, 'FORGEN_SUBCOMMANDS 선언이 fgx.ts 에 없음').toBeTruthy();
    const block = match![1];
    const names = Array.from(block.matchAll(/'([^']+)'/g)).map((m) => m[1]);
    const declared = new Set(names);
    expect(declared).toEqual(EXPECTED_SUBCOMMANDS);
  });

  it('fgx.ts 의 forgen 서브커맨드 집합이 cli.ts commands 의 name 들을 모두 포함', () => {
    const cliSrc = fs.readFileSync(path.join(PKG_ROOT, 'src', 'cli.ts'), 'utf-8');
    const nameMatches = Array.from(cliSrc.matchAll(/name:\s*'([a-z-]+)',/g)).map((m) => m[1]);
    expect(nameMatches.length).toBeGreaterThan(10);
    for (const name of nameMatches) {
      expect(EXPECTED_SUBCOMMANDS.has(name), `cli.ts 의 '${name}' 가 fgx 라우팅 대상이 아님`).toBe(true);
    }
  });
});

describe('fgx 라우팅 실 실행 (dist 빌드 필요)', () => {
  const distExists = fs.existsSync(FGX_BIN);

  it.skipIf(!distExists)('fgx --version → cli.ts main 으로 라우팅 + 버전 출력', () => {
    const r = spawnSync('node', [FGX_BIN, '--version'], { encoding: 'utf-8', timeout: 10000 });
    expect(r.status).toBe(0);
    // package.json 의 version (예: '0.4.10') 출력 — Claude launcher 의 banner 가 아님
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.stdout).not.toContain('Starting Claude');
  });

  it.skipIf(!distExists)('fgx help → cli.ts 의 printHelp 라우팅 (Claude spawn X)', () => {
    const r = spawnSync('node', [FGX_BIN, 'help'], { encoding: 'utf-8', timeout: 10000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('forgen');
    expect(r.stdout).not.toContain('Starting Claude');
  });

  // 'random-prompt-text' 같은 비-서브커맨드는 라우팅 X — Claude launcher 로 가야 함.
  // 단 실제 spawn 은 무거우니 routing 분기만 확인 (warning banner 출력 여부).
  it.skipIf(!distExists)('비-서브커맨드 인자 → Claude launcher 진입 (warning banner 표시)', () => {
    // SIGTERM 으로 빠르게 종료시켜 warning 만 캡처
    const r = spawnSync('node', [FGX_BIN, 'random-prompt-text'], {
      encoding: 'utf-8',
      timeout: 3000,
      // stdio 'pipe' 로 warning 캡처
    });
    // 종료 코드는 무관 (Claude 가 없거나 spawn 실패해도 OK), warning 출력 확인
    expect(r.stderr + r.stdout).toContain('fgx: ALL permission checks are disabled');
  });
});
