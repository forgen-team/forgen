/**
 * H2: auto-compound 추출 결과를 Stop hook 에서 1회 surface.
 *
 * v0.4.0 regression: recall/extraction 이 8,000+ 번 일어났는데 사용자는 0건을
 *   봤다. noticeShown 플래그로 한 세션당 1회만 surface, 30분 신선도 컷오프로
 *   이전 세션의 stale 알림 흘러넘침 방지.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-notice-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { takeLastExtractionNotice } = await import('../src/core/extraction-notice.js');

describe('extraction-notice — H2 Stop hook 추출 알림', () => {
  const statePath = path.join(TEST_HOME, '.forgen', 'state', 'last-auto-compound.json');

  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('returns null when no state file', async () => {

    expect(takeLastExtractionNotice()).toBeNull();
  });

  it('returns null when noticeShown=true', async () => {
    fs.writeFileSync(statePath, JSON.stringify({
      sessionId: 'S1', completedAt: new Date().toISOString(),
      extractedSolutions: 3, promotedRules: 1, noticeShown: true,
    }));

    expect(takeLastExtractionNotice()).toBeNull();
  });

  it('returns null when completedAt is older than 30min (stale)', async () => {
    const stale = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    fs.writeFileSync(statePath, JSON.stringify({
      sessionId: 'S1', completedAt: stale, extractedSolutions: 2, noticeShown: false,
    }));

    expect(takeLastExtractionNotice()).toBeNull();
  });

  it('surfaces extraction count and marks noticeShown=true', async () => {
    fs.writeFileSync(statePath, JSON.stringify({
      sessionId: 'S1', completedAt: new Date().toISOString(),
      extractedSolutions: 3, promotedRules: 2, noticeShown: false,
    }));

    const notice = takeLastExtractionNotice();
    expect(notice).toContain('3개 패턴 추출');
    expect(notice).toContain('2개 규칙 승격');
    // 두 번째 호출은 null (once only)
    expect(takeLastExtractionNotice()).toBeNull();
    // disk 에도 noticeShown=true 로 기록됐어야 함
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(persisted.noticeShown).toBe(true);
  });

  it('returns null when both counts are zero, but still marks noticeShown', async () => {
    fs.writeFileSync(statePath, JSON.stringify({
      sessionId: 'S1', completedAt: new Date().toISOString(),
      extractedSolutions: 0, promotedRules: 0, noticeShown: false,
    }));

    expect(takeLastExtractionNotice()).toBeNull();
    // 재호출시에도 null (이미 소비됨)
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(persisted.noticeShown).toBe(true);
  });

  it('handles only-extracted case (no rule promotion)', async () => {
    fs.writeFileSync(statePath, JSON.stringify({
      sessionId: 'S1', completedAt: new Date().toISOString(),
      extractedSolutions: 1, promotedRules: 0, noticeShown: false,
    }));

    const notice = takeLastExtractionNotice();
    expect(notice).toContain('1개 패턴 추출');
    expect(notice).not.toContain('규칙 승격');
  });
});
