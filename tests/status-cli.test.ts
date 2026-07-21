/**
 * status-cli — 통합 상태 명령 라우팅 (Wave 1, feature-audit 2026-07-21).
 * stats/health/dashboard/me/recall/explain/last-block/watch → forgen status 통합.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveView } from '../src/core/status-cli.js';
import { renderHealthLine, computeHealth } from '../src/core/health-cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'dist', 'cli.js');

describe('status view 라우팅 (resolveView)', () => {
  it('명시 플래그를 해당 뷰로 매핑', () => {
    expect(resolveView(['--compound'])).toBe('--compound');
    expect(resolveView(['--profile'])).toBe('--profile');
    expect(resolveView(['--rules'])).toBe('--rules');
    expect(resolveView(['--blocks'])).toBe('--blocks');
    expect(resolveView(['--live'])).toBe('--live');
  });

  it('짧은 alias(-c/-p/-r/-b/-l) 매핑', () => {
    expect(resolveView(['-c'])).toBe('--compound');
    expect(resolveView(['-p'])).toBe('--profile');
    expect(resolveView(['-r'])).toBe('--rules');
    expect(resolveView(['-b'])).toBe('--blocks');
    expect(resolveView(['-l'])).toBe('--live');
  });

  it('플래그 뒤 positional(숫자)이 있어도 뷰 인식 (--blocks 1)', () => {
    expect(resolveView(['--blocks', '1'])).toBe('--blocks');
  });

  it('등호형(--blocks=1)도 뷰 인식', () => {
    expect(resolveView(['--blocks=1'])).toBe('--blocks');
  });

  it('플래그 없으면 null (기본=요약)', () => {
    expect(resolveView([])).toBeNull();
    expect(resolveView(['1'])).toBeNull();
  });
});

describe('renderHealthLine', () => {
  it('한 줄 health 요약에 grade와 점수 포함', () => {
    const line = renderHealthLine(computeHealth());
    expect(line).toContain('forgen health');
    expect(line).toMatch(/[ABCDF]/);
    expect(line).toMatch(/\d+\/100/);
  });
});

describe('명령 통합 회귀 방지 (제거된 명령은 Unknown)', () => {
  const REMOVED = ['stats', 'health', 'dashboard', 'me', 'recall', 'explain', 'last-block', 'watch'];
  for (const cmd of REMOVED) {
    it(`forgen ${cmd} → Unknown command (status로 통합)`, () => {
      const r = spawnSync('node', [CLI, cmd], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env } });
      expect(`${r.stdout}${r.stderr}`).toContain('Unknown command');
    });
  }

  it('forgen status 는 존재한다', () => {
    const r = spawnSync('node', [CLI, 'status'], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env } });
    expect(`${r.stdout}${r.stderr}`).not.toContain('Unknown command');
  });
});

describe('W1-3 dev 네임스페이스', () => {
  const DEV_MOVED = ['parity', 'probe-workflow', 'migrate', 'regress-map'];
  for (const cmd of DEV_MOVED) {
    it(`forgen ${cmd} (top-level) → Unknown command (dev로 이동)`, () => {
      const r = spawnSync('node', [CLI, cmd], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env } });
      expect(`${r.stdout}${r.stderr}`).toContain('Unknown command');
    });
  }
  it('forgen dev (인자 없이) → dev help', () => {
    const r = spawnSync('node', [CLI, 'dev'], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env } });
    expect(`${r.stdout}${r.stderr}`).toContain('developer / maintenance utilities');
  });
});

describe('W1 리뷰 회귀: 배포 문자열이 죽은 명령을 가리키지 않음', () => {
  // 프룬이 남긴 stale ref(주입 룰·차단 메시지·tmux·doctor·mcp) 가 죽은 명령을
  // 가리켜 "Unknown command" 로 사용자를 막다른 곳에 보냈다. 소스 전역에서
  // `forgen <removed>` 배포 문자열을 금지 (자체 cli 파일의 docstring 은 예외).
  const REMOVED = ['explain', 'last-block', 'recall', 'stats', 'health', 'dashboard', 'watch',
    'probe-workflow', 'parity', 'regress-map', 'onboarding'];
  // `forgen me` 는 statusline 마이그레이션 체크(existing==='forgen me')에서 정당하게 등장 → 제외.

  it('src/ 배포 문자열에 `forgen <removed-cmd>` 지시가 없다', async () => {
    const { execSync } = await import('node:child_process');
    const bad: string[] = [];
    for (const cmd of REMOVED) {
      // 각 명령의 *자체* cli 파일(핸들러는 status/dev 로 여전히 호출됨)의 docstring 은 예외.
      const selfFile = `${cmd.replace('-', '')}`; // heuristic; grep 로 파일 경로도 필터
      let out = '';
      try {
        out = execSync(
          `grep -rn "forgen ${cmd}\\b" src/ --include="*.ts" || true`,
          { encoding: 'utf-8', cwd: process.cwd() },
        );
      } catch { /* grep no-match */ }
      for (const line of out.split('\n').filter(Boolean)) {
        // 은퇴 명령의 자체 cli/docstring, 주석(//, *), 마이그레이션 체크는 예외
        const isSelfCli = new RegExp(`src/core/${cmd}-cli\\.ts|src/core/${cmd}\\.ts`).test(line);
        const isComment = /:\s*\d+:\s*(\/\/|\*|\s*\*)/.test(line) || /\/\*|\*\/|^\s*\*/.test(line.split(':').slice(2).join(':'));
        const isRenameMap = /RENAMED|moved:|status-cli\.test/.test(line);
        void selfFile;
        if (!isSelfCli && !isComment && !isRenameMap) bad.push(line.trim());
      }
    }
    expect(bad, `죽은 명령을 가리키는 배포 문자열:\n${bad.join('\n')}`).toEqual([]);
  });
});
