import { describe, it, expect } from 'vitest';
import { checkDangerousSql, DANGEROUS_SQL_PATTERNS } from '../src/hooks/db-guard.js';

describe('db-guard - extended', () => {
  describe('DANGEROUS_SQL_PATTERNS', () => {
    it('패턴 목록이 비어있지 않다', () => {
      expect(DANGEROUS_SQL_PATTERNS.length).toBeGreaterThan(0);
    });

    it('모든 패턴에 description과 severity가 있다', () => {
      for (const p of DANGEROUS_SQL_PATTERNS) {
        expect(p.description).toBeTruthy();
        expect(['block', 'warn']).toContain(p.severity);
      }
    });
  });

  describe('checkDangerousSql', () => {
    it('Bash가 아닌 도구는 pass', () => {
      expect(checkDangerousSql('Read', { command: 'DROP TABLE users' })).toEqual({ action: 'pass' });
    });

    it('DROP TABLE을 차단한다', () => {
      const result = checkDangerousSql('Bash', { command: 'psql -c "DROP TABLE users"' });
      expect(result.action).toBe('block');
      expect(result.description).toContain('DROP');
    });

    it('DROP DATABASE를 차단한다', () => {
      const result = checkDangerousSql('Bash', { command: 'DROP DATABASE production' });
      expect(result.action).toBe('block');
    });

    it('TRUNCATE TABLE을 차단한다', () => {
      const result = checkDangerousSql('Bash', { command: 'TRUNCATE TABLE logs' });
      expect(result.action).toBe('block');
    });

    it('DELETE FROM을 차단한다 (WHERE 절 없이)', () => {
      const result = checkDangerousSql('Bash', { command: 'DELETE FROM users' });
      expect(result.action).toBe('block');
    });

    it('DELETE FROM WHERE는 통과', () => {
      const result = checkDangerousSql('Bash', { command: 'DELETE FROM users WHERE id = 1' });
      expect(result.action).toBe('pass');
    });

    it('UPDATE SET WHERE는 통과', () => {
      const result = checkDangerousSql('Bash', { command: 'UPDATE users SET name = "test" WHERE id = 1' });
      expect(result.action).toBe('pass');
    });

    it('ALTER TABLE DROP COLUMN은 경고', () => {
      const result = checkDangerousSql('Bash', { command: 'ALTER TABLE users DROP COLUMN email' });
      expect(result.action).toBe('warn');
    });

    it('안전한 SELECT 쿼리는 통과', () => {
      const result = checkDangerousSql('Bash', { command: 'SELECT * FROM users WHERE active = true' });
      expect(result.action).toBe('pass');
    });

    it('SQL 주석 안의 키워드는 무시한다', () => {
      const result = checkDangerousSql('Bash', { command: '-- DROP TABLE users\nSELECT 1' });
      expect(result.action).toBe('pass');
    });

    it('블록 주석 안의 키워드는 무시한다', () => {
      const result = checkDangerousSql('Bash', { command: '/* DROP TABLE users */ SELECT 1' });
      expect(result.action).toBe('pass');
    });

    it('문자열 입력도 처리한다', () => {
      const result = checkDangerousSql('Bash', 'DROP TABLE test');
      expect(result.action).toBe('block');
    });

    it('빈 command는 통과', () => {
      const result = checkDangerousSql('Bash', { command: '' });
      expect(result.action).toBe('pass');
    });

    describe('v0.4.1 TEST-6 quote-aware (DB CLI allowlist)', () => {
      it('git commit 메시지의 quote 안 DROP TABLE 은 pass (false-positive 방지)', () => {
        const cmd = 'git commit -m "feat: handle DROP TABLE edge case in migration"';
        expect(checkDangerousSql('Bash', { command: cmd }).action).toBe('pass');
      });

      it('echo "DROP DATABASE" 같은 단순 echo 는 pass', () => {
        expect(checkDangerousSql('Bash', { command: 'echo "DROP DATABASE prod"' }).action).toBe('pass');
      });

      it('psql -c "DROP TABLE" 은 여전히 block (True-Positive 유지)', () => {
        expect(checkDangerousSql('Bash', { command: 'psql -c "DROP TABLE users"' }).action).toBe('block');
      });

      it('echo "DROP..." | psql 파이프 실행도 block (psql 실 실행 토큰)', () => {
        // 파일 경로 `drop.sql` 자체에는 SQL 키워드가 없으므로 db-guard 가 볼 수 없다.
        // command 문자열 안에 SQL 키워드가 있고 동시에 psql 이 실행 경로에 있을 때가 대상.
        expect(checkDangerousSql('Bash', { command: 'echo "DROP TABLE accounts" | psql -d prod' }).action).toBe('block');
      });

      it('mysql -e "DROP TABLE" 도 block', () => {
        expect(checkDangerousSql('Bash', { command: 'mysql -e "DROP TABLE accounts"' }).action).toBe('block');
      });

      it('quote 안에 psql 있지만 실행 토큰 아닌 경우 pass', () => {
        const cmd = 'echo "to run psql -c DROP TABLE manually"';
        expect(checkDangerousSql('Bash', { command: cmd }).action).toBe('pass');
      });

      it('raw DROP TABLE (quote 없음) 은 block 유지', () => {
        expect(checkDangerousSql('Bash', { command: 'DROP TABLE my_table' }).action).toBe('block');
      });
    });
  });
});
