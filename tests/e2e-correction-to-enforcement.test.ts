/**
 * E2E: 사용자 교정(MCP correction-record 경로) → rule 자동 생성 + enforce_via 자동 주입
 * → 다음 hook invocation 에서 stop-guard 가 실제로 block 발화.
 *
 * 이 테스트는 vi.mock + spawnSync 를 섞어 "프로세스 경계를 넘는" 실제 파이프라인을 검증한다.
 * - createRule/saveRule 은 이 프로세스에서 실행 (vi.mock homedir = TEST_HOME).
 * - stop-guard 는 spawnSync 로 별도 node 프로세스에서 실행 (HOME=TEST_HOME 로 env 주입).
 * - 두 프로세스가 같은 디렉토리(.forgen/me/rules) 를 공유하는지 확인.
 *
 * 이것이 "됐다는데 안됨" 을 스스로 차단하는 자기모순 0 검증의 근원.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-e2e-correction-${process.pid}`,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { processCorrection } = await import('../src/forge/evidence-processor.js');
const { loadAllRules } = await import('../src/store/rule-store.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const STOP_GUARD = path.join(REPO_ROOT, 'dist', 'hooks', 'stop-guard.js');

function runStopGuard(message: string): { stdout: string; exit: number | null } {
  // HOME=TEST_HOME 로 자식 프로세스가 mock 된 homedir 가 아닌 실제 경로로 같은 sandbox 를 사용.
  // FORGEN_SPIKE_RULES 는 비어있는 파일로 가리켜 spike fallback 을 비활성 — 순수 rule-store 경로만 테스트.
  const emptySpike = path.join(TEST_HOME, '__no_spike__.json');
  fs.mkdirSync(TEST_HOME, { recursive: true });
  if (!fs.existsSync(emptySpike)) fs.writeFileSync(emptySpike, '{"rules":[]}');
  const proc = spawnSync('node', [STOP_GUARD], {
    input: JSON.stringify({
      session_id: 'e2e-sess',
      hook_event_name: 'Stop',
      stop_hook_active: true,
      last_assistant_message: message,
    }),
    env: { ...process.env, HOME: TEST_HOME, FORGEN_SESSION_ID: 'e2e-sess', FORGEN_SPIKE_RULES: emptySpike },
    encoding: 'utf-8',
    timeout: 10000,
  });
  return { stdout: proc.stdout, exit: proc.status };
}

describe('E2E: correction → rule with enforce_via → live enforcement', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('avoid-this 완료선언 교정 → rule 자동생성 + Mech-A Stop enforce_via → 다음 Stop hook 에서 block 발화', () => {
    // 1) 사용자 교정 (MCP correction-record 가 처음 이 함수 호출)
    // 명시적 증거 경로 포함 — 분류기가 이 경로를 추출해 artifact_check 로 강제한다.
    // (경로 미명시 교정은 Mech-B self_check 로 분류됨 — enforce-classifier.test.ts 커버)
    const result = processCorrection({
      session_id: 'e2e-sess',
      kind: 'avoid-this',
      message: 'Docker e2e 통과 증거 ~/.forgen/state/e2e-result.json 없이 완료했다 선언하지 마라',
      target: 'completion-before-e2e',
      axis_hint: 'quality_safety',
    });
    expect(result.temporary_rule).not.toBeNull();
    expect(result.temporary_rule?.strength).toBe('strong');

    // 1a) auto-classify 검증 — rule 이 enforce_via 를 자동 보유
    const rules = loadAllRules();
    const newRule = rules.find((r) => r.trigger === 'completion-before-e2e');
    expect(newRule).toBeDefined();
    expect(newRule?.enforce_via).toBeDefined();
    expect(newRule?.enforce_via?.length).toBeGreaterThan(0);

    // completion keyword 가 있으므로 Mech-A Stop + artifact_check 분류 기대
    const stopSpec = newRule?.enforce_via?.find((s) => s.hook === 'Stop' && s.mech === 'A');
    expect(stopSpec).toBeDefined();
    expect(stopSpec?.verifier?.kind).toBe('artifact_check');

    // 2) 다음 턴 Claude 가 "구현 완료했습니다" 응답 — stop-guard 가 이 rule 로 block 발화
    const { stdout, exit } = runStopGuard('구현 완료했습니다.');
    expect(exit).toBe(0);
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
    const out = JSON.parse(lastLine!);
    expect(out.decision).toBe('block');
    expect(out.reason).toBeDefined();
    expect(out.reason.length).toBeGreaterThan(10);

    // 3) retraction 응답 → approve (exclude regex)
    const { stdout: s2 } = runStopGuard('완료 선언을 취소합니다. 증거가 없습니다.');
    const lastLine2 = s2.trim().split('\n').filter(Boolean).pop();
    const out2 = JSON.parse(lastLine2!);
    expect(out2.decision).toBeUndefined();
    expect(out2.continue).toBe(true);

    // 4) evidence fresh 상태에서 완료 선언 → approve
    const statePath = path.join(TEST_HOME, '.forgen', 'state', 'e2e-result.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ passed: true, ts: Date.now() }));
    const { stdout: s3 } = runStopGuard('구현 완료했습니다.');
    const lastLine3 = s3.trim().split('\n').filter(Boolean).pop();
    const out3 = JSON.parse(lastLine3!);
    expect(out3.decision).toBeUndefined();
    expect(out3.continue).toBe(true);
  });

  it('prefer-from-now 교정 (mock 지양) → enforce_via 자동 분류 → next turn mock 맥락 응답에 block', () => {
    // 교정: "실제 실행으로 검증해라, mock 으로 완료 선언하지 마라"
    processCorrection({
      session_id: 'e2e-sess-mock',
      kind: 'avoid-this',
      message: 'mock 으로 검증 완료 주장 금지, 실제 실행 기반 증거만 유효',
      target: 'mock-as-proof',
      axis_hint: 'quality_safety',
    });

    const newRule = loadAllRules().find((r) => r.trigger === 'mock-as-proof');
    expect(newRule?.enforce_via?.length).toBeGreaterThan(0);

    // classify 결과 mock keyword 감지 → trigger regex 가 mock 매칭 (Mech-A completion mock 분기)
    const stopSpec = newRule?.enforce_via?.find((s) => s.hook === 'Stop');
    expect(stopSpec).toBeDefined();

    // 실제 mock-as-proof 응답에 발화하는지 smoke
    const { stdout } = runStopGuard('mock db 붙여서 핸들러 검증 완료.');
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
    const out = JSON.parse(lastLine!);
    // mock 키워드가 있고 테스트 맥락 exclude 미매칭 → block 기대
    expect(out.decision).toBe('block');
  });

  it('교정이 없으면 rule 도 enforce_via 도 생성되지 않음 (control)', () => {
    // 교정 안 함 — 완료선언 응답은 그냥 approve 되어야 함
    const { stdout } = runStopGuard('구현 완료했습니다.');
    const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
    const out = JSON.parse(lastLine!);
    // 사용자 rule 이 없으므로 어떤 rule 도 발화 안 함
    expect(out.continue).toBe(true);
    expect(out.decision).toBeUndefined();
  });

  it('T3 bypass detection: rule 에 반대되는 패턴을 Write/Edit 에 넣으면 bypass.jsonl 기록', () => {
    // 1) 교정: ".then 쓰지 마라"
    processCorrection({
      session_id: 'e2e-sess-then',
      kind: 'avoid-this',
      message: 'use async/await not .then()',
      target: 'then-avoidance',
      axis_hint: 'quality_safety',
    });

    // rule 저장 확인
    const rules = loadAllRules();
    const rule = rules.find((r) => r.trigger === 'then-avoidance');
    expect(rule).toBeDefined();

    // 2) post-tool-use spawn: Write 에 ".then(x => ...)" 포함
    const POST_TOOL = path.join(REPO_ROOT, 'dist', 'hooks', 'post-tool-use.js');
    const proc = spawnSync('node', [POST_TOOL], {
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: 'foo.ts', content: 'fetchUser().then(x => console.log(x))' },
        tool_response: 'ok',
        session_id: 'e2e-sess-then',
      }),
      env: { ...process.env, HOME: TEST_HOME, FORGEN_SESSION_ID: 'e2e-sess-then' },
      encoding: 'utf-8',
      timeout: 10000,
    });
    expect(proc.status).toBe(0);

    // 3) bypass.jsonl 에 기록 확인
    const bypassPath = path.join(TEST_HOME, '.forgen', 'state', 'enforcement', 'bypass.jsonl');
    expect(fs.existsSync(bypassPath)).toBe(true);
    const entries = fs.readFileSync(bypassPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const hit = entries.find((e) => e.rule_id === rule!.rule_id);
    expect(hit).toBeDefined();
    expect(hit.tool).toBe('Write');
  });
});
