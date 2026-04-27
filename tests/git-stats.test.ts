import { describe, it, expect } from 'vitest';
import { parseGitLog, formatFixRatio, computeFixFeatRatio } from '../src/core/git-stats.js';

describe('parseGitLog', () => {
  it('feat / fix 만 카운트, chore/docs 무시', () => {
    const log = `
abc1234 feat: add foo
def5678 fix: bug A
9876543 chore: bump deps
1111111 docs: readme
2222222 feat(api): new endpoint
3333333 fix(core): null pointer
`;
    const r = parseGitLog(log, 30);
    expect(r.fixCount).toBe(2);
    expect(r.featCount).toBe(2);
    expect(r.ratio).toBe(0.5);
    expect(r.available).toBe(true);
  });

  it('fix(test): / fix(docs): 는 비율에서 제외', () => {
    const log = `
aaaaaaa feat(api): big change
bbbbbbb fix(test): typo in test
ccccccc fix(docs): readme typo
ddddddd fix(core): logic bug
`;
    const r = parseGitLog(log, 30);
    expect(r.fixCount).toBe(1); // fix(core) 만 카운트
    expect(r.featCount).toBe(1);
    expect(r.ratio).toBe(0.5);
  });

  it('현재 forgen 측정값 시뮬레이션 — 36% 비율', () => {
    // 현재 측정값: fix 16, feat 18 → 16/34 = 47%. (test/docs 제외 후 다소 차이)
    const lines: string[] = [];
    for (let i = 0; i < 11; i++) lines.push(`${i.toString(16).padStart(7, '0')} fix(v0.4.1): something`);
    for (let i = 0; i < 18; i++) lines.push(`${(i + 100).toString(16).padStart(7, '0')} feat(v0.4.1): something`);
    const r = parseGitLog(lines.join('\n'), 30, 0.30);
    expect(r.fixCount).toBe(11);
    expect(r.featCount).toBe(18);
    expect(r.ratio).toBeCloseTo(11 / 29, 2);
    expect(r.exceedsThreshold).toBe(true); // 38% > 30%
  });

  it('빈 log → ratio 0, exceeds=false', () => {
    const r = parseGitLog('', 30);
    expect(r.fixCount).toBe(0);
    expect(r.featCount).toBe(0);
    expect(r.ratio).toBe(0);
    expect(r.exceedsThreshold).toBe(false);
  });

  it('threshold 동일 (boundary) 는 exceeds=false', () => {
    const hashes = ['1234567', '2345678', '3456789', 'abcdef0', 'abcdef1', 'abcdef2', 'abcdef3', 'abcdef4', 'abcdef5', 'abcdef6'];
    const types = ['fix', 'fix', 'fix', 'feat', 'feat', 'feat', 'feat', 'feat', 'feat', 'feat'];
    const log = hashes.map((h, i) => `${h} ${types[i]}: ${i}`).join('\n');
    const r = parseGitLog(log, 30, 0.30);
    expect(r.ratio).toBe(0.30);
    expect(r.exceedsThreshold).toBe(false); // > 0.30 만 trigger
  });
});

describe('formatFixRatio', () => {
  it('정상 비율 — over 라벨 없음', () => {
    const r = parseGitLog('aaaaaaa fix: a\nbbbbbbb feat: b\nccccccc feat: c\nddddddd feat: d', 30);
    expect(formatFixRatio(r)).toContain('25%');
    expect(formatFixRatio(r)).not.toContain('⚠');
  });

  it('초과 비율 — ⚠ over 라벨 포함', () => {
    const r = parseGitLog('aaaaaaa fix: a\nbbbbbbb fix: b\nccccccc fix: c\nddddddd feat: d', 30);
    expect(formatFixRatio(r)).toContain('⚠ over 30%');
  });

  it('git unavailable — n/a 표시', () => {
    expect(formatFixRatio({
      windowSize: 30, fixCount: 0, featCount: 0, ratio: 0,
      threshold: 0.30, exceedsThreshold: false, available: false,
    })).toContain('n/a');
  });
});

describe('computeFixFeatRatio (실 git)', () => {
  it('현재 forgen repo 에서 실행 가능', () => {
    const r = computeFixFeatRatio(process.cwd(), 30);
    expect(r.available).toBe(true);
    expect(r.fixCount + r.featCount).toBeGreaterThan(0);
    expect(r.ratio).toBeGreaterThanOrEqual(0);
    expect(r.ratio).toBeLessThanOrEqual(1);
  });
});
