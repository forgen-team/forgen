import { describe, it, expect } from 'vitest';
import { applyTrustPolicyPermissions, stripForgenManagedRules } from '../src/core/settings-injector.js';
import type { V1BootstrapResult } from '../src/core/v1-bootstrap.js';

function v1(trust: string): V1BootstrapResult {
  return { session: { effective_trust_policy: trust } } as unknown as V1BootstrapResult;
}

describe('settings-injector — JSON deny/ask 에 주석 마커 미주입 (버그 2026-08-04)', () => {
  it('가드레일 우선: deny 에 실제 룰만, "# forgen-managed" 주석 문자열 미포함', () => {
    const settings: Record<string, unknown> = {};
    applyTrustPolicyPermissions(settings, v1('가드레일 우선'));
    const deny = (settings.permissions as { deny: string[] }).deny;
    // JSON 배열엔 주석이 데이터로 들어가면 안 됨 (Claude Code 가 malformed deny 룰로 경고).
    expect(deny).not.toContain('# forgen-managed');
    expect(deny).toContain('Bash(rm -rf *)');
    expect(deny).toContain('Bash(git push --force*)');
    expect(deny).toContain('Bash(git reset --hard*)');
  });

  it('승인 완화: ask 에도 주석 마커 미포함', () => {
    const settings: Record<string, unknown> = {};
    applyTrustPolicyPermissions(settings, v1('승인 완화'));
    const ask = (settings.permissions as { ask: string[] }).ask;
    expect(ask).not.toContain('# forgen-managed');
    expect(ask).toContain('Bash(rm -rf *)');
  });

  it('self-heal: 기존에 오염된 "# forgen-managed" 는 재주입 시 제거된다', () => {
    // 이전 버그로 오염된 사용자 settings 를 시뮬레이션.
    const settings: Record<string, unknown> = {
      permissions: { deny: ['# forgen-managed', 'Bash(rm -rf *)', 'Bash(user-own-rule)'] },
    };
    applyTrustPolicyPermissions(settings, v1('가드레일 우선'));
    const deny = (settings.permissions as { deny: string[] }).deny;
    expect(deny).not.toContain('# forgen-managed'); // 오염 제거됨
    expect(deny).toContain('Bash(user-own-rule)'); // 사용자 룰은 보존
    // 마커가 중복 누적되지 않음
    expect(deny.filter((r) => r === '# forgen-managed')).toHaveLength(0);
  });

  it('stripForgenManagedRules: 마커+forgen룰 제거, 사용자룰 보존', () => {
    const cleaned = stripForgenManagedRules(['# forgen-managed', 'Bash(rm -rf *)', 'Bash(keep-me)']);
    expect(cleaned).toEqual(['Bash(keep-me)']);
  });
});
