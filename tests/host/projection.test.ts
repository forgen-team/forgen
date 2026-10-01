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
    expect(out).toEqual({ continue: true, decision: 'block', reason: 'tests not run', systemMessage: '[forgen:stop-guard]' });
    // Codex 0.153.4 Stop 출력 스키마는 hookSpecificOutput 을 허용하지 않는다 (additionalProperties:false)
    expect(out.hookSpecificOutput).toBeUndefined();
  });

  it('Stop block 인데 reason 이 비면 systemMessage → 고정 문구로 보강 (Codex 가 reason 없는 block 거부)', () => {
    const a = projectCodexToClaude({ decision: 'block', reason: '', systemMessage: 'ui tag' }, { hookEventName: 'Stop' });
    expect(a.reason).toBe('ui tag');
    const b = projectCodexToClaude({ decision: 'block' }, { hookEventName: 'Stop' });
    expect(typeof b.reason).toBe('string');
    expect((b.reason as string).length).toBeGreaterThan(0);
  });

  it('approved boolean (legacy codex shape, PreToolUse) → permissionDecision 로 번역', () => {
    const denied = projectCodexToClaude({ approved: false }, { hookEventName: 'PreToolUse' });
    expect(denied.continue).toBe(true); // PreToolUse 는 continue:false 미지원
    expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');

    const approved = projectCodexToClaude({ approved: true }, { hookEventName: 'PreToolUse' });
    expect(approved.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('알 수 없는 형식 → fail-open (continue: true)', () => {
    expect(projectCodexToClaude(null, {})).toEqual({ continue: true });
    expect(projectCodexToClaude(42, {})).toEqual({ continue: true });
    expect(projectCodexToClaude('block', {})).toEqual({ continue: true });
    // 이벤트명을 모르면 pass-through + continue 기본값 (실 stdin 은 항상 hook_event_name 을 준다)
    expect(projectCodexToClaude({ random: 'thing' }, {})).toEqual({ random: 'thing', continue: true });
  });

  it('continue:false 는 그대로 보존 (Codex: 처리 중단) — 더 이상 deny 로 변조하지 않음', () => {
    const out = projectCodexToClaude({ continue: false, stopReason: 'halt' }, { hookEventName: 'Stop' });
    expect(out.continue).toBe(false);
    expect(out.stopReason).toBe('halt');
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it('hookSpecificOutput 은 절대 새로 만들지 않고, 있으면 hookEventName 을 입력 이벤트로 고정한다', () => {
    const empty = projectCodexToClaude({}, { hookEventName: 'SessionStart' });
    expect(empty).toEqual({ continue: true });

    const withCtx = projectCodexToClaude(
      { hookSpecificOutput: { hookEventName: 'WrongName', additionalContext: 'x', bogus: 1 } },
      { hook_event_name: 'SessionStart' } as never,
    );
    expect(withCtx.hookSpecificOutput).toEqual({ hookEventName: 'SessionStart', additionalContext: 'x' });

    // Stop/PreCompact 는 hookSpecificOutput 자체 불허 → 통째로 제거
    const onStop = projectCodexToClaude({ continue: true, hookSpecificOutput: { hookEventName: 'Stop' } }, { hookEventName: 'Stop' });
    expect(onStop).toEqual({ continue: true });
    const onCompact = projectCodexToClaude({ continue: true, systemMessage: 's', hookSpecificOutput: { additionalContext: 'c' } }, { hookEventName: 'PreCompact' });
    expect(onCompact).toEqual({ continue: true, systemMessage: 's' });
  });

  it('PostToolUse: PreToolUse 형 deny 를 Codex PostToolUse block 형으로 번역', () => {
    const out = projectCodexToClaude(
      { continue: false, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'secret leaked' } },
      { hookEventName: 'PostToolUse' },
    );
    expect(out.decision).toBe('block');
    expect(out.reason).toBe('secret leaked');
    expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PostToolUse' });
  });

  it('이벤트명을 모르면 pass-through (키를 깎지 않는다)', () => {
    const raw = { continue: true, decision: 'block', reason: 'r', hookSpecificOutput: { hookEventName: 'Mystery' }, extra: 1 };
    expect(projectCodexToClaude(raw, {})).toEqual(raw);
    // 입력에 이벤트명이 없어도 출력의 hookEventName 이 아는 이벤트면 그 정책을 쓴다
    const stopHinted = { continue: true, decision: 'block', reason: 'r', hookSpecificOutput: { hookEventName: 'Stop' } };
    expect(projectCodexToClaude(stopHinted, {})).toEqual({ continue: true, decision: 'block', reason: 'r' });
  });
});

describe('projectClaudeToClaude — identity', () => {
  it('Claude 형 Stop block 은 decision/reason 이 보존되고 (Codex 스키마상) hookSpecificOutput 만 제거된다', () => {
    const input = { continue: true, decision: 'block', reason: 'r', hookSpecificOutput: { hookEventName: 'Stop' } };
    expect(projectClaudeToClaude(input, { hookEventName: 'Stop' })).toEqual({ continue: true, decision: 'block', reason: 'r' });
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
