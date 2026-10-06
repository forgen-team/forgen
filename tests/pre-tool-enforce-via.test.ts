/**
 * pre-tool-use enforce_via[PreToolUse] dispatcher — integration.
 * Spawns compiled hook via spawnSync (isolated HOME).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const PRE_TOOL = path.join(REPO_ROOT, 'dist', 'hooks', 'pre-tool-use.js');

function makeHome(rules: Array<Record<string, unknown>>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-pre-enforce-'));
  const rulesDir = path.join(home, '.forgen', 'me', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  for (const r of rules) {
    fs.writeFileSync(path.join(rulesDir, `${r.rule_id}.json`), JSON.stringify(r));
  }
  return home;
}

function ruleWithPreToolUse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Pattern assembled from fragments so THIS test file source doesn't trip
  // forgen's outer guard when Claude's Bash tool reads it.
  const fragment = ['r', 'm', '\\s', '+-', 'rf'].join('');
  return {
    rule_id: 'L1-pre-test',
    category: 'safety',
    scope: 'me',
    trigger: 'destructive',
    policy: 'test fixture rule',
    strength: 'hard',
    source: 'explicit_correction',
    status: 'active',
    evidence_refs: [],
    render_key: 'safety.pre-test',
    created_at: '2026-04-22T00:00:00Z',
    updated_at: '2026-04-22T00:00:00Z',
    enforce_via: [
      {
        mech: 'A',
        hook: 'PreToolUse',
        verifier: { kind: 'tool_arg_regex', params: { pattern: fragment, requires_flag: 'user_confirmed' } },
        block_message: 'L1-pre-test blocked',
      },
    ],
    ...overrides,
  };
}

function runHook(home: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
  return spawnSync('node', [PRE_TOOL], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, FORGEN_SESSION_ID: 'test-pre', ...env },
    encoding: 'utf-8',
    timeout: 8000,
  });
}

describe('pre-tool-use enforce_via dispatcher (ADR-001 Mech-A PreToolUse)', () => {
  it('matching command without confirmation → deny with rule block_message', () => {
    const home = makeHome([ruleWithPreToolUse()]);
    try {
      // Construct target command matching our r + m + -rf pattern via fragment join
      // ADR-017 §6-2: /tmp 하위는 이제 '임시 폴더 예외' 로 통과하므로 비임시 경로로 검증.
      const target = ['r', 'm', ' -', 'rf'].join('') + ' /srv/forgen-test-target';
      const proc = runHook(home, {
        tool_name: 'Bash',
        tool_input: { command: target },
        session_id: 'pre-sg',
      });
      expect(proc.status).toBe(0);
      const lines = proc.stdout.trim().split('\n').filter(Boolean);
      const out = JSON.parse(lines[lines.length - 1]);
      expect(out.continue).toBe(false);
      expect(out.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('L1-pre-test');

      const vpath = path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl');
      expect(fs.existsSync(vpath)).toBe(true);
      const entry = JSON.parse(fs.readFileSync(vpath, 'utf-8').trim().split('\n')[0]);
      expect(entry.rule_id).toBe('L1-pre-test');
      expect(entry.kind).toBe('deny');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('FORGEN_USER_CONFIRMED=1 → our rule deny passes, audit 엔트리(kind:bypass_confirmed)만 기록 (ADR-017 D1)', () => {
    const home = makeHome([ruleWithPreToolUse()]);
    try {
      const target = ['r', 'm', ' -', 'rf'].join('') + ' /tmp/forgen-test-target';
      const proc = runHook(home, {
        tool_name: 'Bash',
        tool_input: { command: target },
        session_id: 'pre-sg',
      }, { FORGEN_USER_CONFIRMED: '1' });
      expect(proc.status).toBe(0);

      // H3 audit → ADR-017: 우회 audit 로그는 kind='bypass_confirmed' (메타가드 advise 'correction' 과 분리, T3 입력).
      const vpath = path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl');
      if (fs.existsSync(vpath)) {
        const entries = fs.readFileSync(vpath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        for (const e of entries) {
          if (e.rule_id === 'L1-pre-test') {
            // L1-pre-test 관련 엔트리가 있다면 반드시 audit (correction) 만 허용, deny 는 금지.
            expect(e.kind).toBe('bypass_confirmed');
            expect(e.message_preview).toMatch(/FORGEN_USER_CONFIRMED=1 bypass/);
          }
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('non-matching command → our rule does not fire (no L1-pre-test violation)', () => {
    const home = makeHome([ruleWithPreToolUse()]);
    try {
      const proc = runHook(home, {
        tool_name: 'Bash',
        tool_input: { command: 'ls /tmp' },
        session_id: 'pre-sg',
      });
      expect(proc.status).toBe(0);
      const vpath = path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl');
      if (fs.existsSync(vpath)) {
        const entries = fs.readFileSync(vpath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        for (const e of entries) {
          expect(e.rule_id).not.toBe('L1-pre-test');
        }
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('non-Bash tool → our rule does not fire', () => {
    const home = makeHome([ruleWithPreToolUse()]);
    try {
      const proc = runHook(home, {
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/x' },
        session_id: 'pre-sg',
      });
      expect(proc.status).toBe(0);
      const vpath = path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl');
      if (fs.existsSync(vpath)) {
        const entries = fs.readFileSync(vpath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        expect(entries.every((e: { rule_id: string }) => e.rule_id !== 'L1-pre-test')).toBe(true);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
