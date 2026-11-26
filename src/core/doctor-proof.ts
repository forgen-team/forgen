/**
 * forgen doctor — 작동 증명(0.9.1 #15).
 * 무해한 시험 입력을 실제 훅 스크립트(dist/hooks/*.js)에 통과시켜 "작동함 / 몇 ms" 를 보인다.
 * 격리 홈(임시 HOME·FORGEN_HOME)에서만 돌고 끝나면 지운다 — 내 실제 ~/.claude·~/.forgen 은 읽지도 쓰지도 않는다.
 *   1. 교정 기록 보강: correction-record 도구 호출에 세션 id·폴더를 붙여 보내는가(PreToolUse)
 *   2. 차단 룰: 시험 룰에 걸리는 명령을 막는가(PreToolUse)
 *   3. 세션 시작 넣기: 시험 룰이 세션 시작 블록에 실리는가(SessionStart)
 *   4. 상황 맞춤 룰: 조건 명령일 때만 한 번 들어오는가(SessionStart → PreToolUse)
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Proof { name: string; ok: boolean; ms: number; detail: string }

const NOW = '2026-01-01T00:00:00.000Z';
const rule = (id: string, policy: string, extra: Record<string, unknown> = {}) => ({
  rule_id: id, category: 'workflow', scope: 'me', trigger: 'forgen doctor 시험', policy, strength: 'default', source: 'onboarding', status: 'active',
  evidence_refs: [], render_key: `doctor.${id}`, created_at: NOW, updated_at: NOW, ...extra,
});

function runHook(pkgRoot: string, hook: string, input: unknown, env: NodeJS.ProcessEnv): { out: string; ms: number; error?: string } {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(pkgRoot, 'dist', 'hooks', `${hook}.js`)], { input: JSON.stringify(input), env, encoding: 'utf-8', timeout: 20_000 });
  return { out: r.stdout ?? '', ms: Date.now() - t, ...(r.error ? { error: r.error.message } : r.status ? { error: `exit ${r.status}: ${(r.stderr ?? '').slice(0, 200)}` } : {}) };
}
const parse = (s: string): Record<string, unknown> => { try { return JSON.parse(s.trim().split('\n').filter(Boolean).pop() ?? '{}') as Record<string, unknown>; } catch { return {}; } };
const ctxOf = (j: Record<string, unknown>) => String((j.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? '');

export function runProofs(pkgRoot: string, opts: { tmpBase?: string } = {}): Proof[] {
  // tmpBase: 격리 홈을 만들 상위 폴더(테스트가 자기 폴더만 확인하도록). 기본은 OS 임시 폴더.
  const root = fs.mkdtempSync(path.join(opts.tmpBase ?? os.tmpdir(), 'forgen-doctor-proof-'));
  try {
    const home = path.join(root, 'home');
    const fh = path.join(home, '.forgen');
    const work = path.join(root, 'work');
    fs.mkdirSync(path.join(fh, 'me', 'rules'), { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const W = (r: { rule_id: string }) => fs.writeFileSync(path.join(fh, 'me', 'rules', `${r.rule_id}.json`), JSON.stringify(r, null, 2));
    const STATIC = 'forgen 진단 시험 룰: 답변 끝에 확인한 것을 한 줄로 적는다';
    const TIER2 = 'forgen 진단 상황 룰: zzdoctorprobe 명령을 쓸 때는 미리 점검한다';
    W(rule('00000000-0000-4000-8000-0000d0c70001', STATIC));
    W(rule('00000000-0000-4000-8000-0000d0c70002', '시험 차단: zzblockprobe 명령은 쓰지 않는다', {
      enforce_via: [{ mech: 'A', hook: 'PreToolUse', verifier: { kind: 'tool_arg_regex', params: { pattern: 'zzblockprobe', requires_flag: true } }, block_message: 'forgen 진단 시험 차단' }],
    }));
    W(rule('00000000-0000-4000-8000-0000d0c70003', TIER2, { applies_when: { commands: ['zzdoctorprobe'], approved: { at: NOW, fix: 'doctor' } } }));
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, FORGEN_HOME: fh, FORGEN_CWD: work, FORGEN_DOCTOR_PROOF: '1', FORGEN_NO_BLOCK_JUDGE: '1' };
    const sid = 'forgen-doctor-proof';
    const out: Proof[] = [];

    const start = runHook(pkgRoot, 'session-recovery', { session_id: sid, cwd: work, source: 'startup', hook_event_name: 'SessionStart' }, env);
    const block = ctxOf(parse(start.out));
    out.push({ name: '세션 시작에 룰 넣기', ok: block.includes(STATIC) && !block.includes(TIER2), ms: start.ms, detail: start.error ?? (block.includes(STATIC) ? '시험 룰이 세션 시작 블록에 실림(상황 맞춤 룰은 목록 줄로만)' : '시험 룰이 블록에 없음') });

    const rec = runHook(pkgRoot, 'pre-tool-use', { session_id: sid, cwd: work, tool_name: 'mcp__forgen-compound__correction-record', tool_input: { kind: 'avoid-this', message: '시험' }, hook_event_name: 'PreToolUse' }, env);
    const upd = (parse(rec.out).hookSpecificOutput as { updatedInput?: { session_id?: string } } | undefined)?.updatedInput;
    out.push({ name: '교정 기록 보강', ok: upd?.session_id === sid, ms: rec.ms, detail: rec.error ?? (upd?.session_id === sid ? '교정 기록에 세션·폴더를 붙여 보냄' : '보강되지 않음') });

    const blk = runHook(pkgRoot, 'pre-tool-use', { session_id: sid, cwd: work, tool_name: 'Bash', tool_input: { command: 'echo zzblockprobe' }, hook_event_name: 'PreToolUse' }, env);
    const bj = parse(blk.out);
    const denied = bj.continue === false || JSON.stringify(bj).includes('"deny"') || JSON.stringify(bj).includes('"block"');
    out.push({ name: '차단 룰', ok: denied, ms: blk.ms, detail: blk.error ?? (denied ? '시험 룰에 걸리는 명령을 막음' : '막지 않음') });

    const quiet = runHook(pkgRoot, 'pre-tool-use', { session_id: sid, cwd: work, tool_name: 'Bash', tool_input: { command: 'ls' }, hook_event_name: 'PreToolUse' }, env);
    const hit = runHook(pkgRoot, 'pre-tool-use', { session_id: sid, cwd: work, tool_name: 'Bash', tool_input: { command: 'zzdoctorprobe --check' }, hook_event_name: 'PreToolUse' }, env);
    const okT2 = !ctxOf(parse(quiet.out)).includes(TIER2) && ctxOf(parse(hit.out)).includes(TIER2);
    out.push({ name: '상황 맞춤 룰', ok: okT2, ms: hit.ms, detail: hit.error ?? (okT2 ? '조건 명령일 때만 들어옴(다른 명령에는 안 들어옴)' : '조건이 맞아도 안 들어왔거나 아무 때나 들어옴') });
    return out;
  } finally {
    // 훅이 띄운 백그라운드 쓰기와 겹쳐도 정리가 실패하지 않게 잠깐씩 다시 시도한다(실측: ENOTEMPTY).
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
