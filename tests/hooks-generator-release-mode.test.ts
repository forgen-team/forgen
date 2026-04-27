/**
 * Invariant: hooks-generator releaseMode (W4)
 *
 * 자기증거: 본 forge-loop 1차 세션이 사용자 HOME 의 omc 감지로 19/21 active
 * 산출물을 받아 HOME=/tmp/clean-home 으로 우회. 이는 임시방편 — 진짜 fix 는
 * generateHooksJson({ releaseMode: true }) 옵션. 본 invariant 는 그 옵션이
 * 환경 독립 결정론을 보장하는지 검증.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateHooksJson } from '../src/hooks/hooks-generator.js';
import { HOOK_REGISTRY } from '../src/hooks/hook-registry.js';

describe('Invariant: hooks-generator releaseMode (W4)', () => {
  it('releaseMode=true 시 모든 hook active (HOOK_REGISTRY.length 와 동일)', () => {
    const json = generateHooksJson({ releaseMode: true });
    const totalActive = Object.values(json.hooks).reduce(
      (sum, matchers) => sum + matchers.reduce((s, m) => s + m.hooks.length, 0),
      0,
    );
    expect(totalActive).toBe(HOOK_REGISTRY.length);
    expect(json.description).toContain(`${HOOK_REGISTRY.length}/${HOOK_REGISTRY.length} active`);
  });

  it('releaseMode=true 는 plugin 감지 결과와 무관 (mock 으로 plugin 있어도 영향 없음)', async () => {
    // plugin-detector mock — 실 환경 plugin 있어도 releaseMode 가 무시
    vi.resetModules();
    vi.doMock('../src/core/plugin-detector.js', () => ({
      detectInstalledPlugins: () => [
        { name: 'fake-plugin', overlappingSkills: [], overlappingHooks: ['intent-classifier', 'keyword-detector'], detectedBy: 'signature' },
      ],
      getHookConflicts: () => new Set(['intent-classifier', 'keyword-detector']),
    }));

    const { generateHooksJson: genWithMock } = await import('../src/hooks/hooks-generator.js');
    const json = genWithMock({ releaseMode: true });
    const totalActive = Object.values(json.hooks).reduce(
      (sum, matchers) => sum + matchers.reduce((s, m) => s + m.hooks.length, 0),
      0,
    );
    expect(totalActive, 'releaseMode 시 plugin 감지 영향 없음').toBe(HOOK_REGISTRY.length);

    vi.doUnmock('../src/core/plugin-detector.js');
    vi.resetModules();
  });

  it('releaseMode 미지정 (default false) 은 기존 동작 유지', () => {
    const json = generateHooksJson();
    // 환경에 따라 active 수 다를 수 있음 — N/M 형식만 검증
    expect(json.description).toMatch(/Forgen harness hooks \(auto-generated, \d+\/\d+ active\)/);
  });

  it('releaseMode=true 시 hook-config 비활성도 무시', async () => {
    vi.resetModules();
    vi.doMock('../src/hooks/hook-config.js', () => ({
      isHookEnabled: () => false, // 모든 hook 강제 disable
    }));
    const { generateHooksJson: genWithMock } = await import('../src/hooks/hooks-generator.js');
    const json = genWithMock({ releaseMode: true });
    const totalActive = Object.values(json.hooks).reduce(
      (sum, matchers) => sum + matchers.reduce((s, m) => s + m.hooks.length, 0),
      0,
    );
    expect(totalActive, 'releaseMode 시 hook-config 무시').toBe(HOOK_REGISTRY.length);
    vi.doUnmock('../src/hooks/hook-config.js');
    vi.resetModules();
  });
});
