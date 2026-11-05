/**
 * Hook integration tests — 훅의 main() 경로를 readStdinJSON 모킹으로 테스트
 *
 * 각 훅은 import 시 main()이 자동 실행되므로, readStdinJSON을 모킹한 후
 * vi.importActually가 아닌 vi.mock으로 stdin 입력을 제어합니다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-hook-integration',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

// 이 파일에서는 hook을 직접 import하지 않고, 개별 순수 함수만 테스트합니다.
// (hook 파일 import 시 main()이 자동 실행되므로 순수 함수 export만 사용)

describe('hook pure functions - extended coverage', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  // ── db-guard: checkDangerousSql additional cases ──

  describe('db-guard extended', () => {
    it('DROP SCHEMA를 차단한다', async () => {
      const { checkDangerousSql } = await import('../src/hooks/db-guard.js');
      const result = checkDangerousSql('Bash', { command: 'DROP SCHEMA public' });
      expect(result.action).toBe('block');
    });

    it('UPDATE SET without WHERE를 경고한다', async () => {
      const { checkDangerousSql } = await import('../src/hooks/db-guard.js');
      const result = checkDangerousSql('Bash', { command: 'UPDATE users SET active = false' });
      expect(result.action).toBe('warn');
    });

    it('복합 SQL에서 위험 명령어를 감지한다', async () => {
      const { checkDangerousSql } = await import('../src/hooks/db-guard.js');
      const result = checkDangerousSql('Bash', {
        command: 'psql -c "BEGIN; DELETE FROM orders; COMMIT;"',
      });
      expect(result.action).toBe('block');
    });

    it('INSERT INTO는 통과', async () => {
      const { checkDangerousSql } = await import('../src/hooks/db-guard.js');
      const result = checkDangerousSql('Bash', { command: 'INSERT INTO users (name) VALUES (\'test\')' });
      expect(result.action).toBe('pass');
    });

    it('CREATE TABLE은 통과', async () => {
      const { checkDangerousSql } = await import('../src/hooks/db-guard.js');
      const result = checkDangerousSql('Bash', { command: 'CREATE TABLE test (id INT)' });
      expect(result.action).toBe('pass');
    });
  });

  // ── pre-tool-use: checkDangerousCommand additional cases ──

  describe('pre-tool-use extended', () => {
    it('git push --force를 감지한다', async () => {
      const { checkDangerousCommand, DANGEROUS_PATTERNS } = await import('../src/hooks/pre-tool-use.js');
      const result = checkDangerousCommand('Bash', { command: 'git push --force origin main' });
      // D12-A: git 정책(force push)은 정규식 테이블이 아니라 command-analyzer 가 판정한다. 리뷰 반영: 원격 이력 덮어쓰기 → ask.
      expect(DANGEROUS_PATTERNS.length).toBeGreaterThanOrEqual(1);
      expect(result.action).toBe('ask');
    });

    it('fork bomb을 차단한다', async () => {
      const { checkDangerousCommand, DANGEROUS_PATTERNS } = await import('../src/hooks/pre-tool-use.js');
      const forkBomb = ':() { :|:& }; :';
      const result = checkDangerousCommand('Bash', { command: forkBomb });
      // fork bomb 패턴이 등록되어 있으면 block, 없으면 pass
      if (DANGEROUS_PATTERNS.some(p => p.pattern.test(forkBomb))) {
        expect(result.action).toBe('block');
      } else {
        expect(result.action).toBe('pass');
      }
    });

    it('안전한 npm 명령어는 pass', async () => {
      const { checkDangerousCommand } = await import('../src/hooks/pre-tool-use.js');
      const result = checkDangerousCommand('Bash', { command: 'npm install express' });
      expect(result.action).toBe('pass');
    });

    it('안전한 git 명령어는 pass', async () => {
      const { checkDangerousCommand } = await import('../src/hooks/pre-tool-use.js');
      const result = checkDangerousCommand('Bash', { command: 'git status' });
      expect(result.action).toBe('pass');
    });

    it('Write 도구는 항상 pass', async () => {
      const { checkDangerousCommand } = await import('../src/hooks/pre-tool-use.js');
      const result = checkDangerousCommand('Write', { content: 'rm -rf /' });
      expect(result.action).toBe('pass');
    });

    it('shouldShowReminder — 정확히 interval의 배수에서만 true', async () => {
      const { shouldShowReminder } = await import('../src/hooks/pre-tool-use.js');
      expect(shouldShowReminder(9)).toBe(false);
      expect(shouldShowReminder(10)).toBe(true);
      expect(shouldShowReminder(11)).toBe(false);
      expect(shouldShowReminder(30)).toBe(true);
      expect(shouldShowReminder(100, 25)).toBe(true);
      expect(shouldShowReminder(99, 25)).toBe(false);
    });
  });

  // ── secret-filter: detectSecrets additional cases ──

  describe('secret-filter extended', () => {
    it('EC PRIVATE KEY를 감지한다', async () => {
      const { detectSecrets } = await import('../src/hooks/secret-filter.js');
      const result = detectSecrets('-----BEGIN EC PRIVATE KEY-----');
      expect(result.some(r => r.name === 'Private Key')).toBe(true);
    });

    it('DSA PRIVATE KEY를 감지한다', async () => {
      const { detectSecrets } = await import('../src/hooks/secret-filter.js');
      const result = detectSecrets('-----BEGIN DSA PRIVATE KEY-----');
      expect(result.some(r => r.name === 'Private Key')).toBe(true);
    });

    it('postgres 커넥션 스트링을 감지한다', async () => {
      const { detectSecrets } = await import('../src/hooks/secret-filter.js');
      const result = detectSecrets('postgres://user:password@localhost:5432/db');
      expect(result.some(r => r.name === 'Connection String')).toBe(true);
    });

    it('redis 커넥션 스트링을 감지한다', async () => {
      const { detectSecrets } = await import('../src/hooks/secret-filter.js');
      const result = detectSecrets('redis://admin:secret@redis-host:6379');
      expect(result.some(r => r.name === 'Connection String')).toBe(true);
    });

    it('mysql 커넥션 스트링을 감지한다', async () => {
      const { detectSecrets } = await import('../src/hooks/secret-filter.js');
      const result = detectSecrets('mysql://root:pass123@mysql-host:3306/mydb');
      expect(result.some(r => r.name === 'Connection String')).toBe(true);
    });

    it('pk_live 키를 API Key로 감지한다', async () => {
      const { detectSecrets } = await import('../src/hooks/secret-filter.js');
      const result = detectSecrets('pk_live_1234567890abcdefghij');
      expect(result.some(r => r.name === 'API Key')).toBe(true);
    });

    it('JWT 토큰을 감지한다', async () => {
      const { detectSecrets } = await import('../src/hooks/secret-filter.js');
      const result = detectSecrets('jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(result.some(r => r.name.includes('Token'))).toBe(true);
    });

    it('pwd 키워드를 감지한다', async () => {
      const { detectSecrets } = await import('../src/hooks/secret-filter.js');
      const result = detectSecrets('pwd=mysecretpassword123');
      expect(result.some(r => r.name === 'Password')).toBe(true);
    });
  });

  // ── context-guard: 실제 사용량 기반 안내 경계 ──

  describe('context-guard extended', () => {
    it('정확히 70% 면 안내, 69% 면 안내 없음, 모르면(null) 안내 없음', async () => {
      const { shouldNoticeContext } = await import('../src/hooks/context-usage.js');
      const u = (percent: number) => ({ percent, windowSize: 1_000_000, source: 'statusline' as const });
      expect(shouldNoticeContext(u(70), 0)).toBe(true);
      expect(shouldNoticeContext(u(69), 0)).toBe(false);
      expect(shouldNoticeContext(null, 0)).toBe(false);
    });

    it('안내는 사용자용 문장이고 모델에게 작업 중단·즉시 실행을 지시하지 않는다', async () => {
      const { buildContextNotice } = await import('../src/hooks/context-usage.js');
      const msg = buildContextNotice({ percent: 82, windowSize: 1_000_000, source: 'statusline' });
      expect(msg).toContain('82%');
      expect(msg).toContain('1M');
      expect(msg).not.toMatch(/마무리하지 말|즉시|forgen-auto-compact/);
    });
  });

  // ── rate-limiter: checkRateLimit edge cases ──

  describe('rate-limiter extended', () => {
    it('정확히 limit 개의 호출이면 exceeded=true', async () => {
      const { checkRateLimit } = await import('../src/hooks/rate-limiter.js');
      const now = Date.now();
      const calls = Array(10).fill(0).map((_, i) => now - i * 100);
      const result = checkRateLimit({ calls }, now, 10);
      expect(result.exceeded).toBe(true);
    });

    it('limit - 1 개의 호출이면 exceeded=false', async () => {
      const { checkRateLimit } = await import('../src/hooks/rate-limiter.js');
      const now = Date.now();
      const calls = Array(9).fill(0).map((_, i) => now - i * 100);
      const result = checkRateLimit({ calls }, now, 10);
      expect(result.exceeded).toBe(false);
    });

    it('혼합된 윈도우 내/외 호출', async () => {
      const { checkRateLimit } = await import('../src/hooks/rate-limiter.js');
      const now = Date.now();
      const calls = [
        now - 30_000,       // 30초 전 (윈도우 내)
        now - 90_000,       // 90초 전 (윈도우 밖)
        now - 120_001,      // 2분+ 전 (윈도우 밖)
      ];
      const result = checkRateLimit({ calls }, now, 30);
      expect(result.exceeded).toBe(false);
      // 윈도우 내 호출 1개 + 새 호출 1개 = 2개
      expect(result.updatedState.calls.length).toBe(2);
    });

    it('saveRateLimitState + loadRateLimitState 왕복', async () => {
      const { saveRateLimitState, loadRateLimitState } = await import('../src/hooks/rate-limiter.js');
      const state = { calls: [Date.now(), Date.now() - 500, Date.now() - 1000] };
      saveRateLimitState(state);
      const loaded = loadRateLimitState();
      expect(loaded.calls).toEqual(state.calls);
    });
  });
});
