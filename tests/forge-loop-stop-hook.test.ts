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

    it('blockCount가 30 이상이면 safety limit으로 active를 false로 변경', async () => {
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: new Date().toISOString(),
        blockCount: 30,
        stories: [{ id: 'US-001', title: 't', passes: false }],
      }));
      const { checkForgeLoopActive } = await load();
      expect(checkForgeLoopActive()).toBeNull();
      const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(after.active).toBe(false);
    });

    it('2시간+ stale 상태이면 자동으로 active를 false로 변경', async () => {
      const staleTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(stateFile, JSON.stringify({
        active: true,
        startedAt: staleTime,
        stories: [{ id: 'US-001', title: 't', passes: false }],
      }));
      const { checkForgeLoopActive } = await load();
      expect(checkForgeLoopActive()).toBeNull();
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
  });
});
