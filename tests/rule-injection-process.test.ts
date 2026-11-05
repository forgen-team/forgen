/**
 * 룰 주입 실물 경로: 빌드된 hook 프로세스를 실행해 모델이 받을 컨텍스트와 차단을 검증한다.
 * 래퍼 없이 실행하는 환경이 기준이다.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIST = path.resolve(__dirname, '..', 'dist', 'hooks');
const SID = '33333333-3333-4333-8333-333333333333';
let root: string;
let home: string;
let deadeye: string;
let other: string;

const env = () => ({
  ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_SYNTHETIC: '1',
  FORGEN_CWD: '', FORGEN_DISABLE_PROJECT_RULES: '1',
});

function hook(name: string, cwd: string, payload: object) {
  const r = spawnSync(process.execPath, [path.join(DIST, name)], {
    input: JSON.stringify({ session_id: SID, cwd, ...payload }), encoding: 'utf-8', cwd, env: { ...env(), FORGEN_CWD: cwd },
  });
  return { status: r.status, stdout: r.stdout, json: JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') };
}

const context = (cwd: string): string => {
  const { json } = hook('session-recovery.js', cwd, { source: 'startup', hook_event_name: 'SessionStart' });
  return json.hookSpecificOutput?.additionalContext ?? '';
};

function writeRule(id: string, policy: string, extra: object = {}) {
  const dir = path.join(home, '.forgen', 'me', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    rule_id: id, category: 'workflow', scope: 'me', trigger: id, policy, strength: 'strong',
    source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: `workflow.${id}`,
    created_at: now, updated_at: now, ...extra,
  }));
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-inject-'));
  home = path.join(root, 'home');
  deadeye = path.join(root, 'basketball-shot-analyzer');
  other = path.join(root, 'other-repo');
  for (const repo of [deadeye, other]) fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(home, '.forgen', 'me'), { recursive: true });
  fs.writeFileSync(path.join(home, '.forgen', 'forge-profile.json'), JSON.stringify({}));
  const stop = (id: string) => ({
    enforce_mode: 'block', // 의미 룰은 기본이 기록만 — 범위 판정을 보려고 차단을 켠다
    enforce_via: [{ mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: { question: `check ${id}` } }, trigger_keywords_regex: '완료했', system_tag: `rule:${id}` }],
  });
  writeRule('global-ko', '전역 룰 답변은 한국어로', stop('global-ko'));
  writeRule('deadeye-ui', '농구 화면 룰 AI 티 금지', { projects: ['basketball-shot-analyzer'], ...stop('deadeye-ui') });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('SessionStart 컨텍스트', () => {
  it('래퍼 없이도 활성 룰과 교정 기록 지시가 들어간다', () => {
    const out = context(deadeye);
    expect(out).toContain('<forgen-rules host="claude">');
    expect(out).toContain('전역 룰 답변은 한국어로');
    expect(out).toContain('correction-record');
  });

  it('다른 프로젝트 룰은 들어가지 않는다', () => {
    expect(context(deadeye)).toContain('농구 화면 룰');
    expect(context(other)).not.toContain('농구 화면 룰');
  });

  it('프로젝트 밖(홈)에서는 프로젝트 태그와 함께 들어간다', () => {
    const out = context(home);
    expect(out).toContain('basketball-shot-analyzer] 농구 화면 룰');
  });

  it('교정이 다음 세션 컨텍스트에 바로 반영된다', () => {
    writeRule('new-one', '방금 한 교정 룰');
    expect(context(other)).toContain('방금 한 교정 룰');
  });

  it('옛 룰 파일을 회수하고 사용자 파일은 남긴다', () => {
    const dir = path.join(other, '.claude', 'rules');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'v1-rules.md'), '# Forgen v1 — Rendered Rules\n- 옛 룰 Fable 고정\n');
    fs.writeFileSync(path.join(dir, 'my-notes.md'), '# 내 메모\n');
    fs.writeFileSync(path.join(dir, 'project-context.md'), '# Forgen notes of mine\n');
    context(other);
    expect(fs.existsSync(path.join(dir, 'project-context.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'v1-rules.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'my-notes.md'))).toBe(true);
    const backups = fs.readdirSync(path.join(home, '.forgen', 'backups', 'reclaimed-rule-files'));
    expect(backups.some((n) => n.endsWith('v1-rules.md'))).toBe(true);
  });
});

describe('컨텍스트 상한 (넘기면 Claude Code 가 통째로 버린다)', () => {
  it('룰이 아주 많아도 9,500자 안이고 strong 룰과 교정 지시가 남는다', () => {
    for (let i = 0; i < 120; i++) writeRule(`bulk-${i}`, `대량 룰 ${i} ${'가'.repeat(120)}`, { strength: 'default' });
    const stateDir = path.join(home, '.forgen', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    // H6: 복구 메시지는 같은 세션(resume/compact)일 때만 주입된다
    fs.writeFileSync(path.join(stateDir, 'ralph-state.json'), JSON.stringify({ active: true, startedAt: new Date().toISOString(), prompt: '복구'.repeat(3000), sessionId: SID }));
    const out = context(other);
    fs.rmSync(path.join(stateDir, 'ralph-state.json'));
    expect(out.length).toBeLessThanOrEqual(9500);
    expect(out).toContain('전역 룰 답변은 한국어로');
    expect(out).toContain('correction-record');
    expect(out).toContain('lower-priority rules omitted');
    expect(out).toContain('복구 메시지 1개 생략');
  });
});

describe('Stop 차단 범위', () => {
  const stop = (cwd: string) => hook('stop-guard.js', cwd, {
    stop_hook_active: false, // D12-C: 주제 게이트 — 룰(농구 화면)과 관련 있는 응답에서만 self_check 가 발동한다
    last_assistant_message: '농구 화면 작업을 완료했습니다', hook_event_name: 'Stop',
  }).stdout;

  it('그 프로젝트 안에서는 프로젝트 룰이 판정 대상이다', () => {
    expect(stop(deadeye)).toContain('deadeye-ui');
  });

  it('다른 프로젝트와 프로젝트 밖에서는 프로젝트 룰로 차단하지 않는다', () => {
    expect(stop(other)).not.toContain('deadeye-ui');
    expect(stop(home)).not.toContain('deadeye-ui');
  });
});
