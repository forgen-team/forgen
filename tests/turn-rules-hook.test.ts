/**
 * ADR-017 D2 — 실제 컴파일된 훅/CLI 를 서브프로세스로 실행 (mock 아님), 격리 FORGEN_HOME.
 *
 *   1. solution-injector(UserPromptSubmit) 가 state/turn-rules-<session>.json 을 쓴다 — 프롬프트 원문 없이.
 *   2. 프롬프트 주입에는 아무것도 보태지 않는다(stdout JSON 1줄, 룰 언급 없음).
 *   3. session_id 가 없으면 파일을 만들지 않는다.
 *   4. `forgen status --turn` 이 관련 룰과 원 교정(사용자 발화)을 출력한다.
 *
 * 사전 조건: `npm run build` (dist/hooks/solution-injector.js, dist/cli.js).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const HOOK = path.join(REPO_ROOT, 'dist', 'hooks', 'solution-injector.js');
const CLI = path.join(REPO_ROOT, 'dist', 'cli.js');

let home: string;
let forgenHome: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env, HOME: home, FORGEN_HOME: forgenHome, FORGEN_CWD: home,
    FORGEN_DISABLE_PROJECT_RULES: '1', ...extra,
  };
}

function writeJSON(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

function runHook(payload: Record<string, unknown>) {
  return spawnSync('node', [HOOK], { input: JSON.stringify(payload), env: env(), encoding: 'utf-8', timeout: 20_000, cwd: home });
}

const KO_POLICY = '오너에게 보내는 답변은 항상 한국어로. 영어로 답하지 말 것';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-turn-rules-'));
  forgenHome = path.join(home, '.forgen');
  writeJSON(path.join(forgenHome, 'me', 'rules', 'ko-lang.json'), {
    rule_id: 'ko-lang', category: 'workflow', scope: 'me', trigger: '사용자 응답 언어', policy: KO_POLICY,
    strength: 'strong', source: 'explicit_correction', status: 'active', evidence_refs: ['ev-ko'],
    render_key: 'w.ko', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z',
  });
  writeJSON(path.join(forgenHome, 'me', 'rules', 'parallel.json'), {
    rule_id: 'parallel', category: 'autonomy', scope: 'me', trigger: '에이전트 병렬화 제약',
    policy: '병렬 에이전트 사용을 자유롭게 진행해도 된다', strength: 'default', source: 'behavior_inference',
    status: 'active', evidence_refs: [], render_key: 'a.par', created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z',
  });
  writeJSON(path.join(forgenHome, 'me', 'behavior', 'ev-ko.json'), {
    evidence_id: 'ev-ko', type: 'explicit_correction', session_id: 's', timestamp: '2026-09-29T05:08:14.752Z',
    source_component: 'correction-record', summary: KO_POLICY, axis_refs: ['communication_style'],
    candidate_rule_refs: [], confidence: 0.8, raw_payload: { kind: 'prefer-from-now', user_quote: '한국어로 답해, 영어 쓰지마' },
  });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('solution-injector → turn-rules 파일', () => {
  it('관련 룰을 세션 파일에 기록하고, 프롬프트 원문은 남기지 않으며, stdout 주입에는 아무것도 보태지 않는다', () => {
    const prompt = '한국어로 답해줘 이거 리뷰해줘 (비밀: hunter2)';
    const proc = runHook({ hook_event_name: 'UserPromptSubmit', prompt, session_id: 'sess-1', cwd: home });
    expect(proc.status).toBe(0);
    const lines = proc.stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('한국어');
    expect(JSON.stringify(out)).not.toContain('turn-rules');

    const p = path.join(forgenHome, 'state', 'turn-rules-sess-1.json');
    expect(fs.existsSync(p)).toBe(true);
    const raw = fs.readFileSync(p, 'utf-8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('리뷰해줘');
    const data = JSON.parse(raw) as { session_id: string; prompt_hash: string; at: string; rules: Array<{ rule_id: string; score: number; matchedTerms: string[] }> };
    expect(data.session_id).toBe('sess-1');
    expect(data.prompt_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(Date.parse(data.at)).toBeGreaterThan(0);
    expect(data.rules).toEqual([{ rule_id: 'ko-lang', score: 1, matchedTerms: ['한국어'] }]);
  });

  it('관련 룰이 없는 프롬프트도 파일은 쓴다(rules: []) — statusline 이 "관련 룰 0" 을 정직하게 보여주도록', () => {
    runHook({ hook_event_name: 'UserPromptSubmit', prompt: 'fgx --codex 로 켜지나', session_id: 'sess-2', cwd: home });
    const data = JSON.parse(fs.readFileSync(path.join(forgenHome, 'state', 'turn-rules-sess-2.json'), 'utf-8'));
    expect(data.rules).toEqual([]);
  });

  it('같은 세션의 다음 턴은 덮어쓴다 (세션당 최신 턴 하나)', () => {
    runHook({ hook_event_name: 'UserPromptSubmit', prompt: '한국어로 답해', session_id: 'sess-3', cwd: home });
    runHook({ hook_event_name: 'UserPromptSubmit', prompt: '병렬 에이전트 써', session_id: 'sess-3', cwd: home });
    const data = JSON.parse(fs.readFileSync(path.join(forgenHome, 'state', 'turn-rules-sess-3.json'), 'utf-8'));
    expect(data.rules.map((r: { rule_id: string }) => r.rule_id)).toEqual(['parallel']);
  });

  it('session_id 없으면 파일을 만들지 않는다', () => {
    const proc = runHook({ hook_event_name: 'UserPromptSubmit', prompt: '한국어로 답해', cwd: home });
    expect(proc.status).toBe(0);
    const stateDir = path.join(forgenHome, 'state');
    const files = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter((f) => f.startsWith('turn-rules-')) : [];
    expect(files).toEqual([]);
  });
});

describe('forgen status --turn', () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('FORGEN_SESSION_ID 세션의 관련 룰 + 원 교정(사용자 발화)을 출력', () => {
    runHook({ hook_event_name: 'UserPromptSubmit', prompt: '한국어로 답해줘', session_id: 'sess-t', cwd: home });
    const r = spawnSync('node', [CLI, 'status', '--turn'], { env: env({ FORGEN_SESSION_ID: 'sess-t' }), encoding: 'utf-8', timeout: 30_000, cwd: home });
    const out = strip(r.stdout);
    expect(out).toContain('이번 턴 관련 룰 1');
    expect(out).toContain(`[workflow/strong] ${KO_POLICY} (1.0) — 출처: 2026-09-29 당신의 말 (prefer-from-now): "한국어로 답해, 영어 쓰지마"`);
    expect(out).toContain('매칭: 한국어');
  });

  it('turn-rules 파일이 전혀 없으면 "이번 턴 관련 룰 없음"', () => {
    const r = spawnSync('node', [CLI, 'status', '-t'], { env: env(), encoding: 'utf-8', timeout: 30_000, cwd: home });
    expect(strip(r.stdout).trim()).toBe('이번 턴 관련 룰 없음');
  });
});
