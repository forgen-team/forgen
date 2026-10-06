/**
 * T3 integration (ADR-017 D1, 2026-10-06 재정의)
 *
 * 이전: post-tool-use 가 rule.policy 자연어에서 뽑은 단어가 도구 출력에 보이면 bypass.jsonl 기록.
 *       실측 1,114건 전부 오탐("먼저","Team","Fable")이라 폐기.
 * 지금: (1) post-tool-use 는 bypass.jsonl 을 더 이상 쓰지 않는다.
 *       (2) 사용자 명시 우회(FORGEN_USER_CONFIRMED=1)만 violations.jsonl 에 kind:'bypass_confirmed' 로
 *           기록되고, collectSignals 의 bypass_7d 는 그것만 센다.
 *
 * Verified via spawnSync on compiled hooks with isolated HOME.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const POST_TOOL = path.join(REPO_ROOT, 'dist', 'hooks', 'post-tool-use.js');
const PRE_TOOL = path.join(REPO_ROOT, 'dist', 'hooks', 'pre-tool-use.js');

function seedRule(home: string, r: { id: string; policy: string; enforce_via?: unknown[] }) {
  const dir = path.join(home, '.forgen', 'me', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  const rule = {
    rule_id: r.id, category: 'quality', scope: 'me', trigger: 't', policy: r.policy,
    strength: 'default', source: 'explicit_correction', status: 'active', evidence_refs: [],
    render_key: `q.${r.id}`, created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
    enforce_via: r.enforce_via ?? [],
  };
  fs.writeFileSync(path.join(dir, `${r.id}.json`), JSON.stringify(rule));
}

function runHook(hook: string, home: string, payload: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  return spawnSync('node', [hook], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, FORGEN_SESSION_ID: 'test', ...extraEnv },
    encoding: 'utf-8',
    timeout: 8000,
  });
}

const enforcementPath = (home: string, f: string) => path.join(home, '.forgen', 'state', 'enforcement', f);
const readJsonl = (p: string) => fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

describe('T3 — 자연어 휴리스틱 bypass 기록 폐기', () => {
  it('rule policy 의 단어가 Write 본문에 있어도 bypass.jsonl 을 쓰지 않는다 (이전 오탐 경로)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-t3-home-'));
    try {
      seedRule(home, { id: 'r-async', policy: 'use async/await not .then()' });
      const proc = runHook(POST_TOOL, home, {
        tool_name: 'Write',
        tool_input: { file_path: 'foo.ts', content: 'fetchUser().then(x => console.log(x))' },
        tool_response: 'ok',
        session_id: 'sess-t3a',
      });
      expect(proc.status).toBe(0);
      expect(fs.existsSync(enforcementPath(home, 'bypass.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('Bash 출력에 policy 단어("Team")가 있어도 bypass.jsonl 을 쓰지 않는다', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-t3-home-'));
    try {
      seedRule(home, { id: 'r-team', policy: '병렬 에이전트 사용 금지 규칙을 폐지함. 반드시 팀(Team)으로만 진행할 필요 없음.' });
      const proc = runHook(POST_TOOL, home, {
        tool_name: 'Bash', tool_input: { command: 'echo Team' }, tool_response: 'Team\n', session_id: 'sess-t3b',
      });
      expect(proc.status).toBe(0);
      expect(fs.existsSync(enforcementPath(home, 'bypass.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('T3 — 사용자 명시 우회만 bypass_confirmed 로 기록되고 T3 입력이 된다', () => {
  const l1 = {
    id: 'r-rm', policy: '사용자 confirm 없는 rm -rf 실행 금지',
    enforce_via: [{ mech: 'A', hook: 'PreToolUse', verifier: { kind: 'tool_arg_regex', params: { pattern: 'rm\\s+-rf', requires_flag: 'user_confirmed', match_target: 'masked' } }, block_message: 'confirm first' }],
  };

  it('FORGEN_USER_CONFIRMED 없이 → deny 기록(kind:deny), bypass_confirmed 없음', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-t3-home-'));
    try {
      seedRule(home, l1);
      const proc = runHook(PRE_TOOL, home, { tool_name: 'Bash', tool_input: { command: 'rm -rf /srv/data' }, session_id: 'sess-t3c' });
      expect(proc.status).toBe(0);
      const v = readJsonl(enforcementPath(home, 'violations.jsonl'));
      expect(v.some((e) => e.rule_id === 'r-rm' && e.kind === 'deny')).toBe(true);
      expect(v.some((e) => e.kind === 'bypass_confirmed')).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('FORGEN_USER_CONFIRMED=1 → kind:bypass_confirmed 로 감사 기록, collectSignals.bypass_7d 에 반영', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-t3-home-'));
    try {
      seedRule(home, l1);
      const proc = runHook(PRE_TOOL, home, { tool_name: 'Bash', tool_input: { command: 'rm -rf /srv/data' }, session_id: 'sess-t3d' }, { FORGEN_USER_CONFIRMED: '1' });
      expect(proc.status).toBe(0);
      const v = readJsonl(enforcementPath(home, 'violations.jsonl'));
      const hit = v.find((e) => e.rule_id === 'r-rm' && e.kind === 'bypass_confirmed');
      expect(hit).toBeDefined();
      expect(hit.message_preview).toContain('FORGEN_USER_CONFIRMED=1 bypass');

      // 순수 집계: 같은 entries 를 collectSignals 에 넣으면 bypass_7d=1, violations_30d=0 (우회는 위반이 아님)
      const { collectSignals } = await import('../src/engine/lifecycle/signals.js');
      const rule = JSON.parse(fs.readFileSync(path.join(home, '.forgen', 'me', 'rules', 'r-rm.json'), 'utf-8'));
      const s = collectSignals(rule, { violations: v, now: Date.now() });
      expect(s.bypass_7d).toBe(1);
      expect(s.violations_30d).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
