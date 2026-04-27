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

  it('UserPromptSubmit decision="block" + additionalContext (fact 2)', () => {
    const raw = {
      decision: 'block',
      reason: 'self-completion suspect',
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: '<retract-claim/>',
      },
    };
    const out = projectCodexToClaude(raw, { hookEventName: 'UserPromptSubmit' });
    expect(out.continue).toBe(false);
    expect(out.hookSpecificOutput?.permissionDecision).toBe('block');
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

  it('PreToolUse 이중 decision: top-level 보다 hookSpecificOutput.permissionDecision 우선 (spec §18.6)', () => {
    const raw = {
      decision: 'block', // top-level legacy
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny', // modern, 우선
      },
    };
    const out = projectCodexToClaude(raw, { hookEventName: 'PreToolUse' });
    // permissionDecision 은 hookSpecificOutput 의 값 유지
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('Stop decision=block + reason 자동 continuation (fact 5)', () => {
    const raw = { decision: 'block', reason: 'tests not run' };
    const out = projectCodexToClaude(raw, { hookEventName: 'Stop' });
    expect(out.continue).toBe(false);
    expect(out.hookSpecificOutput?.permissionDecision).toBe('block');
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
    expect(projectCodexToClaude({ random: 'thing' }, {})).toEqual({ continue: true });
  });

  it('continue: false 이고 permissionDecision 미설정이면 deny 로 보강', () => {
    const out = projectCodexToClaude({ continue: false }, { hookEventName: 'PreToolUse' });
    expect(out.continue).toBe(false);
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
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
    const input = {
      continue: false,
      hookSpecificOutput: { hookEventName: 'Stop', permissionDecision: 'block' },
    };
    expect(projectClaudeToClaude(input, {})).toEqual({
      continue: false,
      hookSpecificOutput: { hookEventName: 'Stop', permissionDecision: 'block' },
    });
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
