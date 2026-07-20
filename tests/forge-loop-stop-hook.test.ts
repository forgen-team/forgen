import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * forge-loop Stop 훅 단위 테스트.
 *
 * checkForgeLoopActive는 ~/.forgen/state/forge-loop.json을 직접 읽으므로
 * 임시 FORGEN_HOME을 주입하여 격리된 상태에서 테스트한다.
 */

let tmpHome: string;
let stateFile: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-loop-test-'));
  const stateDir = path.join(tmpHome, '.forgen', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  stateFile = path.join(stateDir, 'forge-loop.json');

  // HOME을 임시 디렉토리로 리디렉트해서 STATE_DIR이 그곳을 가리키게 한다.
  vi.stubEnv('HOME', tmpHome);
  // paths 모듈 캐시 초기화 필요 (const 평가 시점 고정)
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function load(): Promise<typeof import('../src/hooks/context-guard.js')> {
  return await import('../src/hooks/context-guard.js');
}

describe('forge-loop Stop hook', () => {
  describe('checkForgeLoopActive', () => {
    it('상태 파일이 없으면 null 반환 (차단 없음)', async () => {
      const { checkForgeLoopActive } = await load();
      expect(checkForgeLoopActive()).toBeNull();
    });

    it('active=false면 null 반환', async () => {
      fs.writeFileSync(stateFile, JSON.stringify({
        active: false,
        startedAt: new Date().toISOString(),
        stories: [{ id: 'US-001', title: 't', passes: false }],
      }));
      const { checkForgeLoopActive } = await load();
      expect(checkForgeLoopActive()).toBeNull();
    });

    it('모든 스토리 완료 시 active를 false로 변경하고 null 반환', async () => {
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: new Date().toISOString(),
        stories: [
          { id: 'US-001', title: 't1', passes: true },
          { id: 'US-002', title: 't2', passes: true },
        ],
      }));
      const { checkForgeLoopActive } = await load();
      expect(checkForgeLoopActive()).toBeNull();
      const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(after.active).toBe(false);
    });

    it('미완료 스토리가 있으면 block 결정을 반환', async () => {
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: new Date().toISOString(),
        stories: [
          { id: 'US-001', title: '사용자 인증 구현', passes: false },
          { id: 'US-002', title: '결제 API', passes: false },
        ],
      }));
      const { checkForgeLoopActive } = await load();
      const result = checkForgeLoopActive();
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result as string);
      expect(parsed.continue).toBe(true);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toContain('미완료');
      expect(parsed.reason).toContain('US-001');
      expect(parsed.reason).toContain('사용자 인증 구현');
    });

    it('차단마다 blockCount를 증가시킨다', async () => {
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: new Date().toISOString(),
        stories: [{ id: 'US-001', title: 't', passes: false }],
      }));
      const { checkForgeLoopActive } = await load();
      checkForgeLoopActive();
      checkForgeLoopActive();
      checkForgeLoopActive();
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(state.blockCount).toBe(3);
    });

    it('blockCount가 30 이상이면 safety limit으로 active를 false로 변경하고 1회성 안내를 반환', async () => {
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: new Date().toISOString(),
        blockCount: 30,
        stories: [{ id: 'US-001', title: 't', passes: false }],
      }));
      const { checkForgeLoopActive } = await load();
      const result = checkForgeLoopActive();
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result as string);
      expect(parsed.continue).toBe(true);
      expect(parsed.decision).toBeUndefined(); // block이 아니라 안내(approve+systemMessage)
      expect(parsed.systemMessage).toContain('안전 상한');
      const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(after.active).toBe(false);
    });

    it('3시간 경과는 24시간 TTL 이내이므로 계속 차단한다 (과거 2시간 TTL은 정상 세션까지 해제시켰음)', async () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: threeHoursAgo,
        stories: [{ id: 'US-001', title: 't', passes: false }],
      }));
      const { checkForgeLoopActive } = await load();
      const result = checkForgeLoopActive();
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result as string);
      expect(parsed.decision).toBe('block');
      const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(after.active).toBe(true);
    });

    it('24시간+ stale 상태이면 자동으로 active를 false로 변경하고 1회성 안내를 반환', async () => {
      const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: staleTime,
        stories: [{ id: 'US-001', title: 't', passes: false }],
      }));
      const { checkForgeLoopActive } = await load();
      const result = checkForgeLoopActive();
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result as string);
      expect(parsed.continue).toBe(true);
      expect(parsed.decision).toBeUndefined();
      expect(parsed.systemMessage).toContain('자동 해제');
      const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(after.active).toBe(false);
    });

    it('awaitingConfirmation이 true면 차단하지 않음 (사용자 개입 허용)', async () => {
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: new Date().toISOString(),
        awaitingConfirmation: true,
        stories: [{ id: 'US-001', title: 't', passes: false }],
      }));
      const { checkForgeLoopActive } = await load();
      expect(checkForgeLoopActive()).toBeNull();
    });

    it('손상된 JSON 파일은 fail-open으로 null 반환 (차단 없음)', async () => {
      fs.writeFileSync(stateFile, '{ invalid json');
      const { checkForgeLoopActive } = await load();
      expect(checkForgeLoopActive()).toBeNull();
    });

    it('미완료 스토리 메시지에 iteration 카운트를 포함', async () => {
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: new Date().toISOString(),
        blockCount: 5,
        stories: [{ id: 'US-001', title: 't', passes: false }],
      }));
      const { checkForgeLoopActive } = await load();
      const result = checkForgeLoopActive();
      const parsed = JSON.parse(result as string);
      // 호출 후 blockCount가 6으로 증가했으므로 메시지에 6/30 표시
      expect(parsed.reason).toContain('6/30');
    });

    it('acceptanceCriteria가 있으면 차단 메시지에 AC1으로 노출', async () => {
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: new Date().toISOString(),
        stories: [{
          id: 'US-002',
          title: '결제 API',
          passes: false,
          acceptanceCriteria: ['POST /api/pay가 201을 반환한다', '멱등키 지원'],
        }],
      }));
      const { checkForgeLoopActive } = await load();
      const parsed = JSON.parse(checkForgeLoopActive() as string);
      expect(parsed.reason).toContain('AC1: POST /api/pay가 201을 반환한다');
      expect(parsed.reason).not.toContain('멱등키 지원'); // 첫 항목만 노출
    });

    it('acceptanceCriteria가 없어도 정상 동작 (선택 필드)', async () => {
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: new Date().toISOString(),
        stories: [{ id: 'US-001', title: 't', passes: false }],
      }));
      const { checkForgeLoopActive } = await load();
      const parsed = JSON.parse(checkForgeLoopActive() as string);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).not.toContain('AC1:');
    });

    describe('세션 바인딩', () => {
      it('소유 세션 없는 최초 차단 시 호출한 세션에 자동 귀속', async () => {
        fs.writeFileSync(stateFile, JSON.stringify({
          active: true,
          startedAt: new Date().toISOString(),
          stories: [{ id: 'US-001', title: 't', passes: false }],
        }));
        const { checkForgeLoopActive } = await load();
        checkForgeLoopActive('session-A');
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        expect(state.sessionId).toBe('session-A');
      });

      it('귀속된 세션의 Stop은 계속 차단된다', async () => {
        fs.writeFileSync(stateFile, JSON.stringify({
          active: true,
          startedAt: new Date().toISOString(),
          sessionId: 'session-A',
          stories: [{ id: 'US-001', title: 't', passes: false }],
        }));
        const { checkForgeLoopActive } = await load();
        const result = checkForgeLoopActive('session-A');
        expect(result).not.toBeNull();
        const parsed = JSON.parse(result as string);
        expect(parsed.decision).toBe('block');
      });

      it('귀속되지 않은(다른) 세션의 Stop은 차단하지 않고 상태도 건드리지 않는다', async () => {
        const before = {
          active: true,
          startedAt: new Date().toISOString(),
          sessionId: 'session-A',
          blockCount: 5,
          stories: [{ id: 'US-001', title: 't', passes: false }],
        };
        fs.writeFileSync(stateFile, JSON.stringify(before));
        const { checkForgeLoopActive } = await load();
        expect(checkForgeLoopActive('session-B')).toBeNull();
        const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        // 크래시된 session-A의 잔여 상태가 무관한 session-B를 영구 차단하지 않음.
        expect(after.blockCount).toBe(5); // 변경 없음
        expect(after.active).toBe(true); // 여전히 session-A 소유로 살아있음
      });

      it('세션 ID 없이 호출(레거시)하면 기존처럼 전역으로 평가', async () => {
        fs.writeFileSync(stateFile, JSON.stringify({
          active: true,
          startedAt: new Date().toISOString(),
          stories: [{ id: 'US-001', title: 't', passes: false }],
        }));
        const { checkForgeLoopActive } = await load();
        const result = checkForgeLoopActive();
        expect(result).not.toBeNull();
        const parsed = JSON.parse(result as string);
        expect(parsed.decision).toBe('block');
      });
    });

    describe('FORGEN_USER_CONFIRMED 우회', () => {
      afterEach(() => {
        delete process.env.FORGEN_USER_CONFIRMED;
      });

      it('FORGEN_USER_CONFIRMED=1이면 이번 턴은 통과하되 루프 상태는 유지', async () => {
        fs.writeFileSync(stateFile, JSON.stringify({
          active: true,
          startedAt: new Date().toISOString(),
          blockCount: 2,
          stories: [{ id: 'US-001', title: 't', passes: false }],
        }));
        process.env.FORGEN_USER_CONFIRMED = '1';
        const { checkForgeLoopActive } = await load();
        expect(checkForgeLoopActive('session-A')).toBeNull();
        const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        expect(after.active).toBe(true); // 다음 Stop에서 다시 차단 가능
        expect(after.blockCount).toBe(2); // 카운트도 증가하지 않음
      });
    });
  });
});
