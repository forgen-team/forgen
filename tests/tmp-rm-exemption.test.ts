/**
 * ADR-017 §6-2 — Claude 임시 폴더 삭제는 확인 없이 허용 (같은 명령 내 변수 한 단계 치환, cwd 해석).
 * critic D1 SEV-1 반영: `..`/brace/glob/symlink/재대입 우회 차단, 예외는 매칭 토큰이 rm 일 때만.
 * 단위 + dist pre-tool-use 실제 spawn.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isTempOnlyRm, isSuspiciousRm } from '../src/hooks/shared/command-parser.js';

const SP = '/tmp/claude-1001/-home-ubuntu/sess/scratchpad';
const RM = ['r', 'm', ' -rf'].join(''); // 소스 리터럴이 훅의 위험패턴에 잡히지 않도록 조립

describe('isTempOnlyRm — Claude 임시 루트(/tmp/claude-*) 한정, 보수적', () => {
  it('scratchpad 하위 리터럴 → true, /tmp 일반 경로·루트 자체 → false (critic: /tmp/* 는 너무 넓다)', () => {
    expect(isTempOnlyRm(`${RM} ${SP}/rc2`)).toBe(true);
    expect(isTempOnlyRm(`${RM} /tmp/forgen-test-target`)).toBe(false);
    expect(isTempOnlyRm(`${RM} /tmp/claude-1001`)).toBe(false);
    expect(isTempOnlyRm(`${RM} /tmp`)).toBe(false);
  });
  it('rm 이전 대입만 한 단계 치환 ($S, "$T", $S/sub, ${S}); 재대입 순서 무시 안 함', () => {
    expect(isTempOnlyRm(`S=${SP}/rc3; ${RM} $S; mkdir -p $S`)).toBe(true);
    expect(isTempOnlyRm(`T=${SP}/prebuild && ${RM} "$T" && mkdir "$T"`)).toBe(true);
    expect(isTempOnlyRm(`S=${SP}; ${RM} $S/v1dbg`)).toBe(true);
    expect(isTempOnlyRm(`S="${SP}"; ${RM} \${S}/a`)).toBe(true);
    expect(isTempOnlyRm(`${RM} $S; S=${SP}/x`)).toBe(false); // 대입이 rm 뒤 → 미해석
    expect(isTempOnlyRm(`S=${SP}/x; S=/home/ubuntu/y; ${RM} $S`)).toBe(false);
    expect(isTempOnlyRm(`S=${SP}/x; T=$S/../../home; ${RM} $T`)).toBe(false);
  });
  it('경로 조작·확장 메타문자 → false: .. / brace / glob / 백틱 / $() / ~', () => {
    expect(isTempOnlyRm(`${RM} /tmp/claude-1001/../home/ubuntu/workspace`)).toBe(false);
    expect(isTempOnlyRm(`${RM} /tmp/claude-1001/{a,../../home/ubuntu}`)).toBe(false);
    expect(isTempOnlyRm(`${RM} /tmp/claude-1001/*`)).toBe(false);
    expect(isTempOnlyRm(`${RM} ${SP}/x$(echo /)`)).toBe(false);
    expect(isTempOnlyRm(`${RM} ~/x`)).toBe(false);
    expect(isTempOnlyRm(`${RM} ${SP}/x /home/ubuntu/y`)).toBe(false);
    expect(isTempOnlyRm(`${RM} -- /home/ubuntu/x`)).toBe(false);
    expect(isTempOnlyRm('rm --recursive --force /home/ubuntu/x')).toBe(false);
  });
  it('symlink 탈출: 실존 경로의 realpath 가 임시 루트 밖이면 false', () => {
    const root = fs.mkdtempSync('/tmp/claude-1001-symtest-');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-outside-'));
    const link = path.join(root, 'link');
    fs.symlinkSync(outside, link);
    try {
      expect(isTempOnlyRm(`${RM} ${link}/sub`)).toBe(false);
      expect(isTempOnlyRm(`${RM} ${link}`)).toBe(false);
      const real = path.join(root, 'real');
      fs.mkdirSync(real);
      expect(isTempOnlyRm(`${RM} ${real}`)).toBe(true);
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
  it('상대 경로는 stdin cwd / 같은 명령의 cd 로 해석 (오너 주 사례: cd 한 뒤 rm -rf .)', () => {
    expect(isTempOnlyRm(`${RM} rc2`, SP)).toBe(true);
    expect(isTempOnlyRm(`cd ${SP}/x && ${RM} .`)).toBe(true);
    expect(isTempOnlyRm(`${RM} rc2`)).toBe(false); // cwd 모름
    expect(isTempOnlyRm(`${RM} rc2`, '/home/ubuntu/proj')).toBe(false);
    expect(isTempOnlyRm(`cd ${SP} && cd /home/ubuntu && ${RM} x`)).toBe(false);
  });
  it('재귀 플래그 없는 rm·rm 없음·빈 문자열 → false; -fr / -r -f 인식', () => {
    expect(isTempOnlyRm(`rm ${SP}/f`)).toBe(false);
    expect(isTempOnlyRm(`rm -fr ${SP}/x/y`)).toBe(true);
    expect(isTempOnlyRm(`rm -r -f ${SP}/x/y`)).toBe(true);
    expect(isTempOnlyRm('ls /tmp/x')).toBe(false);
    expect(isTempOnlyRm('')).toBe(false);
  });
});

describe('isSuspiciousRm — 빌트인 /tmp 예외 우회 모양', () => {
  it('/tmp 아래 .. / brace / glob 재귀 삭제 → true', () => {
    expect(isSuspiciousRm(`${RM} /tmp/../home/ubuntu/workspace`)).toBe(true);
    expect(isSuspiciousRm(`${RM} /tmp/{a,../../home/ubuntu}`)).toBe(true);
    expect(isSuspiciousRm(`${RM} /tmp/*`)).toBe(true);
    expect(isSuspiciousRm(`${RM} /tmp/link/*`)).toBe(true);
  });
  it('정상 임시 경로·비재귀·비/tmp → false', () => {
    expect(isSuspiciousRm(`${RM} ${SP}`)).toBe(false);
    expect(isSuspiciousRm('rm /tmp/*.log')).toBe(false);
    expect(isSuspiciousRm(`${RM} /home/ubuntu/x/*`)).toBe(false);
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
  function run(home: string, command: string, cwd?: string) {
    const r = spawnSync(process.execPath, [DIST], {
      input: JSON.stringify({ session_id: 'sess-tmprm', tool_name: 'Bash', tool_input: { command }, ...(cwd ? { cwd } : {}) }),
      encoding: 'utf-8', timeout: 10000,
      env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_NO_BLOCK_JUDGE: '1' },
    });
    return JSON.parse(r.stdout) as { continue: boolean; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  }
  it.skipIf(!exists)('scratchpad 변수 경로 삭제는 통과, 홈 삭제는 deny + 영수증 기록, traversal 은 빌트인이 차단', () => {
    const home = seed();
    const ok = run(home, `S=${SP}/rc2; ${RM} $S; mkdir -p $S`);
    expect(ok.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(run(home, `${RM} rc9`, SP).hookSpecificOutput?.permissionDecision).not.toBe('deny'); // 상대 경로 + stdin cwd
    expect(run(home, `${RM} /tmp/claude-1001/../home/ubuntu/x`).hookSpecificOutput?.permissionDecision).toBe('deny');
    const deny = run(home, `${RM} /home/ubuntu/.cache/probe`);
    expect(deny.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(deny.hookSpecificOutput?.permissionDecisionReason).toContain('forgen block ');
    const all = fs.readFileSync(path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(all).toHaveLength(2); // 임시 폴더 건은 기록조차 안 함; traversal 건은 룰 deny(영수증 포함), 홈 건 deny
    const v = all.filter((e) => String(e.message_preview).includes('.cache/probe'));
    expect(v).toHaveLength(1);
    expect(v[0].kind).toBe('deny');
    expect(v[0].violation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(v[0].matched).toContain('rm -rf');
    expect(v[0].target_kind).toBe('command');
    expect(v[0].target_hash).toMatch(/^[0-9a-f]{16}$/);
    const receipt = fs.readFileSync(path.join(home, '.forgen', 'state', 'enforcement', 'receipts', `${v[0].violation_id}.txt`), 'utf-8');
    expect(receipt).toBe(`${RM} /home/ubuntu/.cache/probe`);
  });
  it.skipIf(!exists)('advise 강등 룰은 차단 대신 경고 + kind:correction', () => {
    const home = seed();
    const p = path.join(home, '.forgen', 'me', 'rules', 'L1.json');
    fs.writeFileSync(p, JSON.stringify({ ...JSON.parse(fs.readFileSync(p, 'utf-8')), strength: 'default', enforce_mode: 'advise' }));
    // 빌트인 위험패턴(/·~ 접두)에 걸리지 않는 상대 경로 — L1 룰(rm\s+-rf)만 매칭 → advise 경로
    const r = run(home, `${RM} build-cache`);
    expect(r.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(JSON.stringify(r)).toContain('(advise)');
    const v = fs.readFileSync(path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(v[0].kind).toBe('correction');
    // ship-review MAJOR: advise 룰이 매칭돼도 나머지 검사(빌트인 위험 명령)는 계속된다
    const builtin = run(home, `${RM} /home/ubuntu/.cache/probe && ${RM} /`);
    expect(builtin.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
  it.skipIf(!exists)('예외는 매칭 토큰이 rm 일 때만 — 패턴에 "rm" 이 포함된 무관 룰(terraform)은 꺼지지 않는다 (critic SEV-1)', () => {
    const home = seed();
    fs.writeFileSync(path.join(home, '.forgen', 'me', 'rules', 'TF.json'), JSON.stringify({
      rule_id: 'tf-destroy', category: 'quality', scope: 'me', trigger: 'tf', policy: 'terraform destroy 금지', strength: 'strong', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: 'q.tf', created_at: '2026-04-22T00:00:00Z', updated_at: '2026-04-22T00:00:00Z',
      enforce_via: [{ mech: 'A', hook: 'PreToolUse', verifier: { kind: 'tool_arg_regex', params: { pattern: 'terraform\\s+destroy', requires_flag: 'user_confirmed', match_target: 'masked' } }, block_message: 'no destroy' }],
    }));
    const r = run(home, `terraform destroy -auto-approve && ${RM} ${SP}/plan-cache`);
    expect(r.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(r.hookSpecificOutput?.permissionDecisionReason).toContain('no destroy');
  });
  it.skipIf(!exists)('heredoc/따옴표 안의 traversal 예시 문자열은 실행 명령이 아니므로 빌트인이 막지 않는다', () => {
    const home = seed();
    const r = run(home, `cat > /tmp/claude-1001/x/notes.md <<'EOF'\nexample: ${RM} /tmp/../home\nEOF`);
    expect(r.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });
});
