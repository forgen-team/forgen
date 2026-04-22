/**
 * post-tool-use enforce_via[PostToolUse] dispatcher (ADR-001 Mech-A pattern_match).
 * PostToolUse cannot block (tool already ran) — instead records violation + warns.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const POST_TOOL = path.join(REPO_ROOT, 'dist', 'hooks', 'post-tool-use.js');

function makeHome(rules: Array<Record<string, unknown>>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-post-enforce-'));
  const rulesDir = path.join(home, '.forgen', 'me', 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  for (const r of rules) {
    fs.writeFileSync(path.join(rulesDir, `${r.rule_id}.json`), JSON.stringify(r));
  }
  return home;
}

function secretRule(): Record<string, unknown> {
  return {
    rule_id: 'L1-no-aws-key',
    category: 'safety',
    scope: 'me',
    trigger: 'secret',
    policy: 'never commit AWS access key',
    strength: 'hard',
    source: 'explicit_correction',
    status: 'active',
    evidence_refs: [],
    render_key: 'safety.no-aws-key',
    created_at: '2026-04-22T00:00:00Z',
    updated_at: '2026-04-22T00:00:00Z',
    enforce_via: [
      {
        mech: 'A',
        hook: 'PostToolUse',
        verifier: { kind: 'pattern_match', params: { pattern: 'AKIA[0-9A-Z]{16,}' } },
        block_message: 'L1-no-aws-key: AWS access key detected',
      },
    ],
  };
}

function runHook(home: string, payload: Record<string, unknown>) {
  return spawnSync('node', [POST_TOOL], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, FORGEN_SESSION_ID: 'test-post' },
    encoding: 'utf-8',
    timeout: 8000,
  });
}

describe('post-tool-use enforce_via dispatcher (ADR-001 Mech-A PostToolUse)', () => {
  it('Write content matching pattern → violations.jsonl entry + warning in stdout', () => {
    const home = makeHome([secretRule()]);
    try {
      // Construct AKIA key from fragments so this test source doesn't itself trip scanners.
      const fakeKey = 'AKIA' + 'IOSFODNN7EXAMPLE2'; // 17 chars after AKIA — matches pattern
      const proc = runHook(home, {
        tool_name: 'Write',
        tool_input: { file_path: 'config.js', content: `const k = '${fakeKey}';` },
        tool_response: 'ok',
        session_id: 'post-sg',
      });
      expect(proc.status).toBe(0);
      // output should contain our rule's block_message in a warning envelope
      expect(proc.stdout).toContain('L1-no-aws-key');

      const vpath = path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl');
      expect(fs.existsSync(vpath)).toBe(true);
      const entries = fs.readFileSync(vpath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const hit = entries.find((e) => e.rule_id === 'L1-no-aws-key');
      expect(hit).toBeDefined();
      expect(hit.source).toBe('post-tool-guard');
      expect(hit.kind).toBe('block');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('Bash command without matching pattern → no violation', () => {
    const home = makeHome([secretRule()]);
    try {
      const proc = runHook(home, {
        tool_name: 'Bash',
        tool_input: { command: 'ls /tmp' },
        tool_response: 'file1\nfile2',
        session_id: 'post-sg',
      });
      expect(proc.status).toBe(0);
      const vpath = path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl');
      if (fs.existsSync(vpath)) {
        const entries = fs.readFileSync(vpath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        expect(entries.every((e: { rule_id: string }) => e.rule_id !== 'L1-no-aws-key')).toBe(true);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('non-Write/Edit/Bash tool → dispatcher skipped', () => {
    const home = makeHome([secretRule()]);
    try {
      const proc = runHook(home, {
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/x' },
        tool_response: 'AKIA' + 'AAAAAAAAAAAAAAAAAA',
        session_id: 'post-sg',
      });
      expect(proc.status).toBe(0);
      const vpath = path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl');
      expect(fs.existsSync(vpath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
