/**
 * T3 integration: post-tool-use detects bypass pattern in Write/Edit/Bash output
 * → recordBypass → bypass.jsonl.
 *
 * Verified via spawnSync on compiled hook with isolated HOME.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const POST_TOOL = path.join(REPO_ROOT, 'dist', 'hooks', 'post-tool-use.js');

function seedRules(home: string, rules: Array<{ id: string; policy: string }>) {
  const dir = path.join(home, '.forgen', 'me', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  for (const r of rules) {
    const rule = {
      rule_id: r.id,
      category: 'quality',
      scope: 'me',
      trigger: 't',
      policy: r.policy,
      strength: 'default',
      source: 'explicit_correction',
      status: 'active',
      evidence_refs: [],
      render_key: `q.${r.id}`,
      created_at: '2026-04-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    };
    fs.writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(rule));
  }
}

function runPostTool(home: string, payload: Record<string, unknown>) {
  return spawnSync('node', [POST_TOOL], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, FORGEN_SESSION_ID: 'test' },
    encoding: 'utf-8',
    timeout: 8000,
  });
}

describe('T3 integration — post-tool-use bypass detection', () => {
  it('Write with .then() under "use async/await not .then()" rule → bypass.jsonl entry', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-t3-home-'));
    try {
      seedRules(home, [{ id: 'r-async', policy: 'use async/await not .then()' }]);
      const proc = runPostTool(home, {
        tool_name: 'Write',
        tool_input: { file_path: 'foo.ts', content: 'fetchUser().then(x => console.log(x))' },
        tool_response: 'ok',
        session_id: 'sess-t3a',
      });
      expect(proc.status).toBe(0);
      const bypassPath = path.join(home, '.forgen', 'state', 'enforcement', 'bypass.jsonl');
      expect(fs.existsSync(bypassPath)).toBe(true);
      const lines = fs.readFileSync(bypassPath, 'utf-8').trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.rule_id).toBe('r-async');
      expect(entry.tool).toBe('Write');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('Bash with rm -rf under "never use rm -rf" rule → bypass entry', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-t3-home-'));
    try {
      seedRules(home, [{ id: 'r-rm', policy: 'never use rm -rf without confirmation' }]);
      const proc = runPostTool(home, {
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/foo' },
        tool_response: '',
        session_id: 'sess-t3b',
      });
      expect(proc.status).toBe(0);
      const bypassPath = path.join(home, '.forgen', 'state', 'enforcement', 'bypass.jsonl');
      expect(fs.existsSync(bypassPath)).toBe(true);
      const entry = JSON.parse(fs.readFileSync(bypassPath, 'utf-8').trim().split('\n')[0]);
      expect(entry.rule_id).toBe('r-rm');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('Write without bypass pattern → no bypass.jsonl', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-t3-home-'));
    try {
      seedRules(home, [{ id: 'r-async', policy: 'use async/await not .then()' }]);
      const proc = runPostTool(home, {
        tool_name: 'Write',
        tool_input: { file_path: 'foo.ts', content: 'const x = await fetch(); console.log(x);' },
        tool_response: 'ok',
        session_id: 'sess-t3c',
      });
      expect(proc.status).toBe(0);
      const bypassPath = path.join(home, '.forgen', 'state', 'enforcement', 'bypass.jsonl');
      expect(fs.existsSync(bypassPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
