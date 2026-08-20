/**
 * Invariant: handleCompound 의 manual-add 는 서브커맨드 dispatch 를 탈취당하지 않는다.
 *
 * 자기증거: 서브커맨드 dispatch 가 args.includes('remove'|'clean-stale'|...) 로 전체 인자를
 * 스캔했기 때문에, `--solution "제목" "내용"` 의 위치인자(title/content)에 그런 토큰이
 * 섞이면 삭제·정리 분기를 탈취할 수 있었다. auto-compound 러너가 untrusted 모델 출력을
 * `forgen compound --solution TITLE CONTENT` 로 넘기던 경로에서 실증된 arg-confusion.
 * defense-in-depth 리팩터(manual-add 를 dispatch 앞으로 hoist)가 이를 원천 차단한다.
 * 본 테스트는 그 회귀를 막는다.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-compound-arg-confusion',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

describe('Invariant: manual-add 는 서브커맨드 dispatch 를 탈취당하지 않는다', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(TEST_HOME, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function runWithSpies(args: string[]) {
    const removeSolution = vi.fn();
    const cleanStaleSolutions = vi.fn();
    const retagSolutions = vi.fn();
    vi.doMock('../src/engine/compound-cli.js', () => ({
      removeSolution,
      cleanStaleSolutions,
      retagSolutions,
      listSolutions: vi.fn(),
      inspectSolution: vi.fn(),
      rollbackSolutions: vi.fn(),
    }));
    const { handleCompound } = await import('../src/engine/compound-loop.js');
    vi.spyOn(process, 'cwd').mockReturnValue(TEST_HOME);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleCompound(args);
    return { removeSolution, cleanStaleSolutions, retagSolutions };
  }

  it('--solution 의 title 이 "--remove" 여도 removeSolution 을 호출하지 않는다', async () => {
    const { removeSolution } = await runWithSpies(['--solution', '--remove', 'victim-solution']);
    expect(removeSolution).not.toHaveBeenCalled();
  });

  it('--solution 의 content 가 "clean-stale" 여도 cleanStaleSolutions 을 호출하지 않는다', async () => {
    const { cleanStaleSolutions } = await runWithSpies(['--solution', 'my-title', 'clean-stale']);
    expect(cleanStaleSolutions).not.toHaveBeenCalled();
  });

  it('--rule 의 위치인자에 "retag" 가 있어도 retagSolutions 을 호출하지 않는다', async () => {
    const { retagSolutions } = await runWithSpies(['--rule', 'my-rule', 'retag']);
    expect(retagSolutions).not.toHaveBeenCalled();
  });

  it('type flag 가 없으면 서브커맨드 dispatch 는 그대로 동작한다 (동작 보존)', async () => {
    // 회귀 방지: hoist 가 legit 서브커맨드까지 삼키지 않는지 확인.
    const { removeSolution } = await runWithSpies(['remove', 'some-solution']);
    expect(removeSolution).toHaveBeenCalledWith('some-solution');
  });
});
