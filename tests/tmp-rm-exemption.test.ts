/**
 * ADR-017 §6-2 — Claude 임시 폴더 삭제는 확인 없이 허용 (같은 명령 내 변수 한 단계 치환).
 * 단위 + dist pre-tool-use 실제 spawn.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isTempOnlyRm } from '../src/hooks/shared/command-parser.js';

describe('isTempOnlyRm', () => {
  it('리터럴 /tmp 하위·scratchpad → true', () => {
    expect(isTempOnlyRm('rm -rf /tmp/claude-1001/x/scratchpad/rc2')).toBe(true);
    expect(isTempOnlyRm('rm -rf /var/folders/ab/cd')).toBe(true);
  });
  it('같은 명령의 변수 대입 한 단계 치환 ($S, "$T", $S/sub, ${S})', () => {
    expect(isTempOnlyRm('S=/tmp/claude-1001/scratchpad/rc3; rm -rf $S; mkdir -p $S')).toBe(true);
    expect(isTempOnlyRm('T=/tmp/claude-x/prebuild && rm -rf "$T" && mkdir "$T"')).toBe(true);
    expect(isTempOnlyRm('S=/tmp/claude-1001/scratchpad; rm -rf $S/v1dbg; mkdir -p $S/v1dbg')).toBe(true);
    expect(isTempOnlyRm('S="/tmp/claude-1001/s"; rm -rf ${S}/a')).toBe(true);
  });
  it('홈·프로젝트·루트 대상 → false (보수적)', () => {
    expect(isTempOnlyRm('rm -rf /home/ubuntu/.cache/onemotion-probe')).toBe(false);
    expect(isTempOnlyRm('rm -rf /')).toBe(false);
    expect(isTempOnlyRm('rm -rf ~/proj')).toBe(false);
    expect(isTempOnlyRm('S=/home/ubuntu/x; rm -rf $S')).toBe(false);
  });
  it('섞이면 false, 미해석 변수 false, /tmp 자체 false, rm 없음 false', () => {
    expect(isTempOnlyRm('rm -rf /tmp/a /srv/b')).toBe(false);
    expect(isTempOnlyRm('rm -rf $UNKNOWN')).toBe(false);
    expect(isTempOnlyRm('rm -rf /tmp')).toBe(false);
    expect(isTempOnlyRm('rm -rf /tmp/')).toBe(false);
    expect(isTempOnlyRm('ls /tmp/x')).toBe(false);
    expect(isTempOnlyRm('')).toBe(false);
  });
  it('다른 플래그 조합(-fr, -r -f)도 인식', () => {
    expect(isTempOnlyRm('rm -fr /tmp/x/y')).toBe(true);
    expect(isTempOnlyRm('rm -r -f /tmp/x/y')).toBe(true);
  });
});

describe('dist pre-tool-use — L1 rm -rf 룰 (격리 HOME)', () => {
  const DIST = path.resolve(import.meta.dirname, '..', 'dist', 'hooks', 'pre-tool-use.js');
  const exists = fs.existsSync(DIST);
  function seed(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-tmprm-'));
    const dir = path.join(home, '.forgen', 'me', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'L1.json'), JSON.stringify({
      rule_id: 'L1-no-rm-rf-unconfirmed', category: 'quality', scope: 'me', trigger: 'rm', policy: '사용자 confirm 없는 rm -rf 실행 금지',
      strength: 'hard', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: 'q.l1', created_at: '2026-04-22T00:00:00Z', updated_at: '2026-04-22T00:00:00Z',
      enforce_via: [{ mech: 'A', hook: 'PreToolUse', verifier: { kind: 'tool_arg_regex', params: { pattern: 'rm\\s+-rf', requires_flag: 'user_confirmed', match_target: 'masked' } }, block_message: 'confirm first' }],
    }));
    return home;
  }
  function run(home: string, command: string) {
    const r = spawnSync(process.execPath, [DIST], {
      input: JSON.stringify({ session_id: 'sess-tmprm', tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf-8', timeout: 10000,
      env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_NO_BLOCK_JUDGE: '1' },
    });
    return JSON.parse(r.stdout) as { continue: boolean; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  }
  it.skipIf(!exists)('scratchpad 변수 경로 삭제는 통과, 홈 삭제는 deny + 영수증 기록', () => {
    const home = seed();
    const ok = run(home, 'S=/tmp/claude-1001/-home-ubuntu/sess/scratchpad/rc2; rm -rf $S; mkdir -p $S');
    expect(ok.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    const deny = run(home, 'rm -rf /home/ubuntu/.cache/probe');
    expect(deny.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(deny.hookSpecificOutput?.permissionDecisionReason).toContain('forgen block ');
    const v = fs.readFileSync(path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(v).toHaveLength(1); // 임시 폴더 건은 기록조차 안 함
    expect(v[0].kind).toBe('deny');
    expect(v[0].violation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(v[0].matched).toContain('rm -rf');
    expect(v[0].target_kind).toBe('command');
    expect(v[0].target_hash).toMatch(/^[0-9a-f]{16}$/);
    const receipt = fs.readFileSync(path.join(home, '.forgen', 'state', 'enforcement', 'receipts', `${v[0].violation_id}.txt`), 'utf-8');
    expect(receipt).toBe('rm -rf /home/ubuntu/.cache/probe');
  });
  it.skipIf(!exists)('advise 강등 룰은 차단 대신 경고 + kind:correction', () => {
    const home = seed();
    const p = path.join(home, '.forgen', 'me', 'rules', 'L1.json');
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf-8')), strength: 'default', enforce_mode: 'advise' }));
    const r = run(home, 'rm -rf /home/ubuntu/.cache/probe');
    expect(r.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    const v = fs.readFileSync(path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(v[0].kind).toBe('correction');
  });
});
