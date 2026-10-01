/**
 * ProjectToClaudeEvent — Multi-Host Core Design §5.2/§10 우선순위 2 단위 테스트
 *
 * spec §18.2 의 source-level fact 7 종 + 사영 후 Claude 어댑터가 그대로 수용 가능한지 검증.
 * 본 테스트는 `codex-adapter.ts` binary 가 호출하는 *순수 함수*를 직접 검증한다.
 */

import { describe, expect, it } from 'vitest';
import {
  getProjection,
  projectClaudeToClaude,
  projectCodexToClaude,
} from '../../src/host/projection.js';

describe('projectCodexToClaude — Codex hook 출력 → Claude HookEventOutput', () => {
  it('SessionStart additionalContext 사영 (spec §18.2 fact 1)', () => {
    const raw = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '<forge-loop-state>...</forge-loop-state>',
      },
    };
    const out = projectCodexToClaude(raw, { hookEventName: 'SessionStart' });
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput?.additionalContext).toContain('forge-loop-state');
  });

  it('UserPromptSubmit decision="block" + reason + additionalContext 보존 (fact 2, ADR-015 G1)', () => {
    const raw = {
      decision: 'block',
      reason: 'self-completion suspect',
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '<retract-claim/>',
      },
    };
    const out = projectCodexToClaude(raw, { hookEventName: 'UserPromptSubmit' });
    expect(out.continue).toBe(true); // continue:false 는 Codex 에선 "처리 중단" — block 과 혼동 금지
    expect(out.decision).toBe('block');
    expect(out.reason).toBe('self-completion suspect');
    expect(out.hookSpecificOutput?.additionalContext).toContain('retract-claim');
  });

  it('PreToolUse hookSpecificOutput.permissionDecision=deny + reason (fact 3)', () => {
    const raw = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'rm -rf / matched',
      },
    };
    const out = projectCodexToClaude(raw, { hookEventName: 'PreToolUse' });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBe('rm -rf / matched');
  });

  it('PreToolUse deny: forgen deny() 의 continue:false 는 제거 (Codex "unsupported continue:false")', () => {
    const raw = {
      continue: false,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
    };
    const out = projectCodexToClaude(raw, { hookEventName: 'PreToolUse' });
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('PreToolUse 이중 decision: top-level 과 hookSpecificOutput 둘 다 보존 (Codex 가 후자를 우선)', () => {
    const raw = {
      decision: 'block',
      reason: 'legacy',
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    };
    const out = projectCodexToClaude(raw, { hookEventName: 'PreToolUse' });
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(out.decision).toBe('block');
  });

  it('Stop decision=block + reason 이 top-level 로 그대로 Codex 에 도달 (fact 5, ADR-015 G1 결함 수정)', () => {
    // forgen blockStop() 의 실제 출력 형태
    const raw = { continue: true, decision: 'block', reason: 'tests not run', systemMessage: '[forgen:stop-guard]' };
    const out = projectCodexToClaude(raw, { hookEventName: 'Stop' });
    expect(out).toMatchObject({ continue: true, decision: 'block', reason: 'tests not run', systemMessage: '[forgen:stop-guard]' });
    expect(out.hookSpecificOutput?.hookEventName).toBe('Stop');
    // 구 사영의 유실 형태가 아니어야 한다
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it('Stop block 인데 reason 이 비면 systemMessage → 고정 문구로 보강 (Codex 가 reason 없는 block 거부)', () => {
    const a = projectCodexToClaude({ decision: 'block', reason: '', systemMessage: 'ui tag' }, { hookEventName: 'Stop' });
    expect(a.reason).toBe('ui tag');
    const b = projectCodexToClaude({ decision: 'block' }, { hookEventName: 'Stop' });
    expect(typeof b.reason).toBe('string');
    expect((b.reason as string).length).toBeGreaterThan(0);
  });

  it('approved boolean (legacy codex shape) → permissionDecision 보존', () => {
    const denied = projectCodexToClaude({ approved: false }, {});
    expect(denied.continue).toBe(false);
    expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');

    const approved = projectCodexToClaude({ approved: true, decision: 'allow' }, {});
    expect(approved.continue).toBe(true);
    expect(approved.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('알 수 없는 형식 → fail-open (continue: true)', () => {
    expect(projectCodexToClaude(null, {})).toEqual({ continue: true });
    expect(projectCodexToClaude(42, {})).toEqual({ continue: true });
    expect(projectCodexToClaude('block', {})).toEqual({ continue: true });
    expect(projectCodexToClaude({ random: 'thing' }, {})).toEqual({ continue: true });
  });

  it('continue:false 는 그대로 보존 (Codex: 처리 중단) — 더 이상 deny 로 변조하지 않음', () => {
    const out = projectCodexToClaude({ continue: false, stopReason: 'halt' }, { hookEventName: 'Stop' });
    expect(out.continue).toBe(false);
    expect(out.stopReason).toBe('halt');
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it('hookEventName 우선순위: hookSpecificOutput → input.hookEventName → input.event', () => {
    const fromOutput = projectCodexToClaude(
      { hookSpecificOutput: { hookEventName: 'PreToolUse' } },
      { hookEventName: 'Stop' },
    );
    expect(fromOutput.hookSpecificOutput?.hookEventName).toBe('PreToolUse');

    const fromInput = projectCodexToClaude({}, { hookEventName: 'SessionStart' });
    expect(fromInput.hookSpecificOutput?.hookEventName).toBe('SessionStart');

    const fromEventField = projectCodexToClaude({}, { event: 'Stop' });
    expect(fromEventField.hookSpecificOutput?.hookEventName).toBe('Stop');
  });
});

describe('projectClaudeToClaude — identity', () => {
  it('Claude 형 객체는 그대로 통과', () => {
    const input = { continue: true, decision: 'block', reason: 'r', hookSpecificOutput: { hookEventName: 'Stop' } };
    expect(projectClaudeToClaude(input, {})).toEqual(input);
  });

  it('비객체 입력 → fail-open', () => {
    expect(projectClaudeToClaude(null, {})).toEqual({ continue: true });
    expect(projectClaudeToClaude('foo', {})).toEqual({ continue: true });
  });
});

describe('getProjection — host 별 디스패치', () => {
  it('claude 와 codex 모두 등록되어 있다', () => {
    expect(typeof getProjection('claude')).toBe('function');
    expect(typeof getProjection('codex')).toBe('function');
  });

  it('미등록 host 는 throw', () => {
    expect(() => getProjection('gemini' as never)).toThrow(/No ProjectToClaudeEvent/);
  });
});
