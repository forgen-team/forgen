/**
 * ADR-015 — host 한정 훅 (`hosts` 필드) + SessionEnd (Claude 전용)
 *
 * 불변식: Codex 용 hooks.json 은 0.5.2 와 바이트 동일해야 한다 (훅 신뢰 유지). 따라서
 * Claude 에만 추가된 session-end 는 codex 산출물에 나타나면 안 된다.
 */
import { describe, expect, it } from 'vitest';
import { generateHooksJson } from '../src/hooks/hooks-generator.js';
import { HOOK_REGISTRY } from '../src/hooks/hook-registry.js';

function commands(runtime: 'claude' | 'codex'): string[] {
  const json = generateHooksJson({ pluginRoot: '/X/dist', runtime, releaseMode: true });
  return Object.values(json.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
}

describe('hooks-generator hosts filter (ADR-015)', () => {
  it('session-end 는 registry 에 hosts:["claude"] 로 등록되어 있다', () => {
    const entry = HOOK_REGISTRY.find((h) => h.name === 'session-end');
    expect(entry).toBeDefined();
    expect(entry?.event).toBe('SessionEnd');
    expect(entry?.hosts).toEqual(['claude']);
    expect(entry?.timeout).toBeLessThanOrEqual(5); // per-hook timeout 이 SessionEnd 예산을 올린다 (docs)
  });

  it('claude 산출물에는 SessionEnd 가 있고, codex 산출물에는 없다', () => {
    const claude = generateHooksJson({ pluginRoot: '/X/dist', runtime: 'claude', releaseMode: true });
    const codex = generateHooksJson({ pluginRoot: '/X/dist', runtime: 'codex', releaseMode: true });
    expect(Object.keys(claude.hooks)).toContain('SessionEnd');
    expect(Object.keys(codex.hooks)).not.toContain('SessionEnd');
  });

  it('codex 훅 수는 host 한정 훅을 제외한 registry 크기와 같다 (0.5.2 기준 22 유지)', () => {
    const codexCount = commands('codex').length;
    const expected = HOOK_REGISTRY.filter((h) => !h.hosts || h.hosts.includes('codex')).length;
    expect(codexCount).toBe(expected);
    expect(codexCount).toBe(22);
    expect(commands('claude').length).toBe(HOOK_REGISTRY.length);
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
