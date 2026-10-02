/**
 * ADR-015/016 — host 한정 훅 (`hosts` 필드) + Codex 전용 핸들러 필드
 *
 * Codex 의 trust 해시는 *핸들러 단위* 다 (ADR-016): 새 이벤트 추가는 기존 훅의 신뢰를 깨지 않고,
 * 필드를 바꾼 핸들러만 재승인이 필요하다. 그래서 0.5.6 에서 SessionEnd 를 Codex 에도 등록하고,
 * Codex 가 무시하는 PostToolUseFailure 를 Codex 산출물에서 뺐다 (총 22 유지).
 */
import { describe, expect, it } from 'vitest';
import { generateHooksJson } from '../src/hooks/hooks-generator.js';
import { HOOK_REGISTRY } from '../src/hooks/hook-registry.js';

function commands(runtime: 'claude' | 'codex'): string[] {
  const json = generateHooksJson({ pluginRoot: '/X/dist', runtime, releaseMode: true });
  return Object.values(json.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
}

describe('hooks-generator hosts filter (ADR-015/016)', () => {
  it('session-end 는 claude + codex 에 등록된다 (opencode 는 subprocess 훅이 없어 제외)', () => {
    const entry = HOOK_REGISTRY.find((h) => h.name === 'session-end');
    expect(entry).toBeDefined();
    expect(entry?.event).toBe('SessionEnd');
    expect(entry?.hosts).toEqual(['claude', 'codex']);
    // Codex 는 SessionEnd 타임아웃을 1~3s 로 clamp 한다 — registry 값이 그 안이어야 해시가 예측 가능.
    expect(entry?.timeout).toBeLessThanOrEqual(3);
  });

  it('SessionEnd 는 양쪽 산출물에 있고, PostToolUseFailure 는 claude 에만 있다', () => {
    const claude = generateHooksJson({ pluginRoot: '/X/dist', runtime: 'claude', releaseMode: true });
    const codex = generateHooksJson({ pluginRoot: '/X/dist', runtime: 'codex', releaseMode: true });
    expect(Object.keys(claude.hooks)).toContain('SessionEnd');
    expect(Object.keys(codex.hooks)).toContain('SessionEnd');
    expect(Object.keys(claude.hooks)).toContain('PostToolUseFailure');
    expect(Object.keys(codex.hooks)).not.toContain('PostToolUseFailure'); // Codex 가 조용히 무시하는 죽은 엔트리
  });

  it('codex 훅 수는 host 한정 훅을 제외한 registry 크기와 같다 (22)', () => {
    const codexCount = commands('codex').length;
    const expected = HOOK_REGISTRY.filter((h) => !h.hosts || h.hosts.includes('codex')).length;
    expect(codexCount).toBe(expected);
    expect(codexCount).toBe(22);
    expect(commands('claude').length).toBe(HOOK_REGISTRY.length);
  });

  it('additionalContextLimit 은 codex 의 session-recovery 핸들러에만 붙는다 (ADR-016 D2)', () => {
    const codex = generateHooksJson({ pluginRoot: '/X/dist', runtime: 'codex', releaseMode: true });
    const claude = generateHooksJson({ pluginRoot: '/X/dist', runtime: 'claude', releaseMode: true });
    const withLimit = Object.entries(codex.hooks).flatMap(([ev, groups]) =>
      groups.flatMap((g) => g.hooks.filter((h) => h.additionalContextLimit !== undefined).map((h) => `${ev}:${h.command}`)));
    expect(withLimit).toHaveLength(1);
    expect(withLimit[0]).toContain('SessionStart:');
    expect(withLimit[0]).toContain('session-recovery.js');
    expect(codex.hooks.SessionStart[0].hooks[0].additionalContextLimit).toBe(0);
    // Claude Code 는 이 필드를 모른다 — 넣지 않는다.
    expect(JSON.stringify(claude)).not.toContain('additionalContextLimit');
    // Codex 는 hooks.json top-level 에 description/hooks 외 키가 있으면 파일 전체를 거부한다.
    expect(Object.keys(codex).sort()).toEqual(['description', 'hooks']);
  });
});

describe('nested-run guard (ADR-015 C-G1)', () => {
  it('FORGEN_NESTED_RUN=1 이면 보호 훅 포함 모든 훅이 비활성', async () => {
    const prev = process.env.FORGEN_NESTED_RUN;
    try {
      process.env.FORGEN_NESTED_RUN = '1';
      const { isHookEnabled } = await import('../src/hooks/hook-config.js');
      expect(isHookEnabled('session-recovery')).toBe(false);
      expect(isHookEnabled('stop-guard')).toBe(false);
      delete process.env.FORGEN_NESTED_RUN;
      expect(isHookEnabled('session-recovery')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FORGEN_NESTED_RUN; else process.env.FORGEN_NESTED_RUN = prev;
    }
  });

  it('withNestedRunClaudeArgs 는 --no-session-persistence 를 한 번만 붙인다', async () => {
    const { withNestedRunClaudeArgs } = await import('../src/host/exec-host.js');
    const a = withNestedRunClaudeArgs(['-p', 'x']);
    expect(a).toEqual(['-p', 'x', '--no-session-persistence']);
    expect(withNestedRunClaudeArgs(a)).toEqual(a);
  });
});
