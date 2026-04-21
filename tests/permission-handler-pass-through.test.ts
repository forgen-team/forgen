/**
 * Invariant: permission-handler's responses are all pass-through — they
 * never set `permissionDecision: 'allow'`, so Claude's default
 * confirmation flow remains the source of truth. Log labels reflect the
 * actual effect (pass-through with or without warning), not misleading
 * approval language.
 *
 * Audit clarification #4 (2026-04-21): the brief over-claimed that the
 * hook auto-approves Bash/Write/Edit in autopilot — this test locks in
 * the nuanced real behavior.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyTool, SAFE_TOOLS, ALWAYS_CONFIRM_TOOLS } from '../src/hooks/permission-handler.js';
import { approve, approveWithWarning } from '../src/hooks/shared/hook-response.js';

describe('permission-handler response shape', () => {
  it('approve()는 permissionDecision을 설정하지 않는다 (pass-through)', () => {
    const r = JSON.parse(approve());
    expect(r.continue).toBe(true);
    expect(r.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it('approveWithWarning()도 permissionDecision 없음 (UI-only systemMessage)', () => {
    const r = JSON.parse(approveWithWarning('warn'));
    expect(r.continue).toBe(true);
    expect(r.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(r.systemMessage).toBe('warn');
  });
});

describe('classifyTool labels reflect pass-through reality', () => {
  it('SAFE_TOOLS → safe-pass-through', () => {
    for (const tool of SAFE_TOOLS) {
      expect(classifyTool(tool, false)).toBe('safe-pass-through');
      expect(classifyTool(tool, true)).toBe('safe-pass-through');
    }
  });

  it('non-autopilot + non-safe → pass-through', () => {
    expect(classifyTool('Bash', false)).toBe('pass-through');
    expect(classifyTool('Write', false)).toBe('pass-through');
    expect(classifyTool('Edit', false)).toBe('pass-through');
  });

  it('autopilot + ALWAYS_CONFIRM_TOOLS → autopilot-warn-pass-through', () => {
    for (const tool of ALWAYS_CONFIRM_TOOLS) {
      expect(classifyTool(tool, true)).toBe('autopilot-warn-pass-through');
    }
  });

  it('autopilot + 기타 → autopilot-pass-through', () => {
    expect(classifyTool('CustomTool', true)).toBe('autopilot-pass-through');
  });

  it('라벨이 모두 pass-through 계열이어야 한다 (approve 오해 금지)', () => {
    const labels: string[] = [];
    labels.push(classifyTool('Read', true));
    labels.push(classifyTool('Bash', true));
    labels.push(classifyTool('CustomTool', true));
    labels.push(classifyTool('Bash', false));
    for (const label of labels) {
      expect(label).toMatch(/pass-through$/);
    }
  });
});

describe('permission-handler source invariants', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'hooks', 'permission-handler.ts'),
    'utf-8',
  );
  const codeOnly = src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('과거 오해 라벨(`auto-approve-safe`, `autopilot-approve`)이 활성 코드에 남아있지 않다', () => {
    expect(codeOnly).not.toMatch(/['"]auto-approve-safe['"]/);
    expect(codeOnly).not.toMatch(/['"]autopilot-approve['"]/);
    expect(codeOnly).not.toMatch(/['"]autopilot-confirm['"]/);
  });
});
