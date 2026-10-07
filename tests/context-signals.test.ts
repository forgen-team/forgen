import { describe, it, expect } from 'vitest';
import { contextTokensFromPaths, projectNameFromCwd } from '../src/engine/context-signals.js';
import { rankCandidates } from '../src/engine/ranking-pipeline.js';

describe('contextTokensFromPaths', () => {
  const cwd = '/home/ubuntu/workspace/forgen';

  it('프로젝트명 + 파일명/디렉터리 토큰을 만들고 확장자·범용 이름은 제외한다', () => {
    const toks = contextTokensFromPaths(cwd, [`${cwd}/src/engine/rule-renderer.ts`]);
    expect(toks).toEqual(expect.arrayContaining(['forgen', 'engine', 'rule', 'renderer', 'rule-renderer']));
    for (const generic of ['src', 'ts']) expect(toks).not.toContain(generic);
  });

  it('작업 디렉터리가 .claude/worktrees 아래면 리포 이름을 쓴다', () => {
    expect(projectNameFromCwd(`${cwd}/.claude/worktrees/agent-abc`)).toBe('forgen');
  });

  it('cwd 밖 절대경로는 홈 경로 조각을 섞지 않는다', () => {
    const toks = contextTokensFromPaths(cwd, ['/home/ubuntu/.claude/settings.json']);
    expect(toks).toContain('settings');
    expect(toks).not.toContain('ubuntu');
    expect(toks).not.toContain('home');
  });

  it('최근 파일이 없으면 프로젝트명만', () => {
    expect(contextTokensFromPaths(cwd, [])).toEqual(['forgen']);
  });
});

describe('rankCandidates — 맥락 토큰', () => {
  const sols = [
    { name: 'renderer-budget', tags: ['rule', 'renderer', 'context', 'budget'], confidence: 0.5 },
    { name: 'other', tags: ['redis', 'cache'], confidence: 0.5 },
  ];

  it('프롬프트 매칭이 있으면 relevance 가 오르고 contextMatchedTags 로 분리 기록된다', () => {
    const base = rankCandidates(['renderer', 'budget'], 'renderer budget', sols);
    const withCtx = rankCandidates(['renderer', 'budget'], 'renderer budget', sols, undefined, ['context', 'rule']);
    expect(withCtx[0].relevance).toBeGreaterThan(base[0].relevance);
    expect([...withCtx[0].contextMatchedTags].sort()).toEqual(['context', 'rule']);
    expect(withCtx[0].matchedTags).toEqual(base[0].matchedTags);
  });

  it('맥락 토큰만으로는 후보가 되지 않는다', () => {
    const ranked = rankCandidates(['quantum'], 'quantum', sols, undefined, ['renderer', 'budget', 'context']);
    expect(ranked).toEqual([]);
  });

  it('맥락 가산에는 상한이 있다', () => {
    const base = rankCandidates(['renderer', 'budget'], 'renderer budget', sols)[0].relevance;
    const withCtx = rankCandidates(['renderer', 'budget'], 'renderer budget', sols, undefined, ['context', 'rule', 'extra'])[0].relevance;
    expect(withCtx - base).toBeLessThanOrEqual(0.2 + 1e-9);
  });
});
