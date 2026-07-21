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
