/**
 * Tests for stop-guard (Mech-B prototype, spike/mech-b-a1).
 *
 * evaluateStop 는 pure — stdin/IO 없이 메시지와 rules 로 판정.
 * stdin e2e 는 별도로 spawn 으로 실행.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Sandbox homedir — stuck-loop guard writes to ~/.forgen/state/enforcement/.
// Never pollute the contributor's real state dir during tests.
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-stop-guard-${process.pid}`,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const {
  evaluateStop,
  incrementBlockCount,
  resetBlockCount,
  logDriftEvent,
  getStuckLoopThreshold,
  rulesFromStore,
} = await import('../src/hooks/stop-guard.js');
type StoreRule = import('../src/store/types.js').Rule;

type SpikeRule = Parameters<typeof evaluateStop>[1][number];

const R_B1: SpikeRule = {
  id: 'R-B1',
  mech: 'B',
  hook: 'Stop',
  trigger: {
    response_keywords_regex: '(완료했|완성됐|완성되|완성했|done\\.|ready\\.|shipped\\.|LGTM|finished\\.)',
    context_exclude_regex: '(취소|철회|없음|없습니다|않았|하지\\s*않|아닙니다|not\\s*yet|no\\s*longer|retract|withdraw|아직\\s*(안|아)|stuck-loop|force\\s*approve|block\\s*hook|meta|자가철회|자기인용|spike|PR 없|ADR|변경\\s*없|아직\\s*구현)',
  },
  verifier: {
    kind: 'self_check_prompt',
    params: {
      question: 'Docker e2e 증거 없음. e2e 를 먼저 실행하고 재응답하라.',
      evidence_path: 'e2e-result.json',
      max_age_s: 3600,
    },
  },
  system_tag: 'rule:R-B1 — e2e-before-done',
};

const R_B2: SpikeRule = {
  id: 'R-B2',
  mech: 'B',
  hook: 'Stop',
  trigger: {
    response_keywords_regex: '(mock|stub|fake)',
    context_exclude_regex: '(테스트|test|vi\\.mock|jest\\.mock|spec\\.)',
  },
  verifier: {
    kind: 'self_check_prompt',
    params: {
      question: 'mock 으로 검증 완료 주장 감지. 실행 기반 재검증으로 전환하라.',
    },
  },
  system_tag: 'rule:R-B2 — no-mock-as-proof',
};

describe('evaluateStop (pure core)', () => {
  it('S2: e2e 증거 없이 완료 선언 → block', () => {
    const r = evaluateStop('tests 통과, 기능 구현 완료했습니다.', [R_B1]);
    expect(r.action).toBe('block');
    if (r.action === 'block') {
      expect(r.hit.id).toBe('R-B1');
      expect(r.reason).toContain('e2e');
    }
  });

  it('S4: shipped 키워드 → block', () => {
    const r = evaluateStop('shipped.', [R_B1]);
    expect(r.action).toBe('block');
  });

  it('S9: 한글 "완성되었습니다" → block', () => {
    const r = evaluateStop('기능 구현이 완성되었습니다.', [R_B1]);
    expect(r.action).toBe('block');
  });

  it('S5: mock db 검증 완료 → block (R-B2)', () => {
    const r = evaluateStop('mock db 붙여서 핸들러 검증 완료. 저장 경로도 확인했습니다.', [R_B2]);
    expect(r.action).toBe('block');
    if (r.action === 'block') {
      expect(r.hit.id).toBe('R-B2');
    }
  });

  it('S6: 테스트 맥락의 vi.mock → approve (context_exclude)', () => {
    const r = evaluateStop('테스트에서 vi.mock 쓴 건 맞지만 dry-run 으로 동작 검증했습니다.', [R_B2]);
    expect(r.action).toBe('approve');
  });

  it('완료 선언 키워드가 없으면 → approve', () => {
    const r = evaluateStop('작업 진행 중입니다. 추가로 살펴볼게요.', [R_B1, R_B2]);
    expect(r.action).toBe('approve');
  });

  describe('retraction FP (Day-3 발견 3) — context_exclude 로 차단되어야 함', () => {
    const cases = [
      '완료 선언을 취소합니다. 증거 파일이 존재하지 않습니다.',
      '완료 선언을 하지 않았습니다. 철회 상태 유지.',
      '완료 선언 없음. 증거 파일 없음.',
      '완료 선언을 한 적이 없으며, 철회 상태를 유지합니다.',
      '동일 상태. 사용자 입력 필요.',
      '상태 변화 없음.',
      'Not yet done — still waiting on evidence.',
      '아직 구현 완료되지 않았습니다.',
    ];
    for (const msg of cases) {
      it(`retraction/meta message → approve: "${msg.slice(0, 40)}..."`, () => {
        const r = evaluateStop(msg, [R_B1]);
        expect(r.action).toBe('approve');
      });
    }
  });

  describe('true completion declarations → block', () => {
    const cases = [
      '구현 완료했습니다.',
      '기능 구현이 완성되었습니다.',
      '배포 shipped.',
      'Tests passed. done.',
      'LGTM',
    ];
    for (const msg of cases) {
      it(`true completion → block: "${msg}"`, () => {
        const r = evaluateStop(msg, [R_B1]);
        expect(r.action).toBe('block');
      });
    }
  });

  it('S3: e2e 증거 파일이 fresh 면 → approve', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-sg-'));
    const evidence = path.join(tmpDir, 'e2e-result.json');
    fs.writeFileSync(evidence, '{}');
    const rule: SpikeRule = {
      ...R_B1,
      verifier: {
        kind: 'self_check_prompt',
        params: {
          question: 'Docker e2e 증거 없음.',
          evidence_path: evidence,
          max_age_s: 3600,
        },
      },
    };
    try {
      const r = evaluateStop('완료했습니다.', [rule]);
      expect(r.action).toBe('approve');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('첫 번째로 매칭되는 Mech-B 규칙만 block 반환 (순차)', () => {
    const r = evaluateStop('완료했습니다. mock 으로 확인 끝.', [R_B1, R_B2]);
    expect(r.action).toBe('block');
    if (r.action === 'block') {
      expect(r.hit.id).toBe('R-B1');
    }
  });
});

describe('stuck-loop guard (block_count ceiling)', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });
  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('incrementBlockCount persists across calls (same session + rule)', () => {
    expect(incrementBlockCount('sess-1', 'R-B1')).toBe(1);
    expect(incrementBlockCount('sess-1', 'R-B1')).toBe(2);
    expect(incrementBlockCount('sess-1', 'R-B1')).toBe(3);
  });

  it('different rule → independent counter', () => {
    incrementBlockCount('sess-1', 'R-B1');
    expect(incrementBlockCount('sess-1', 'R-B2')).toBe(1);
  });

  it('different session → independent counter', () => {
    incrementBlockCount('sess-1', 'R-B1');
    expect(incrementBlockCount('sess-2', 'R-B1')).toBe(1);
  });

  it('resetBlockCount wipes the counter', () => {
    incrementBlockCount('sess-1', 'R-B1');
    incrementBlockCount('sess-1', 'R-B1');
    resetBlockCount('sess-1', 'R-B1');
    expect(incrementBlockCount('sess-1', 'R-B1')).toBe(1);
  });

  it('sanitizes session_id for filename safety (path traversal)', () => {
    // session id with path separators must not escape BLOCK_COUNT_DIR
    expect(() => incrementBlockCount('../../../etc/passwd', 'R-B1')).not.toThrow();
    // ensure the counter file landed inside TEST_HOME
    const traversalTarget = '/etc/passwd';
    expect(fs.existsSync(traversalTarget + '.json')).toBe(false);
  });

  it('logDriftEvent appends a JSONL line under TEST_HOME', () => {
    logDriftEvent({ kind: 'stuck_loop_force_approve', session_id: 's', rule_id: 'R-B1', count: 4 });
    const logPath = path.join(TEST_HOME, '.forgen', 'state', 'enforcement', 'drift.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);
    const line = fs.readFileSync(logPath, 'utf-8').trim();
    const obj = JSON.parse(line);
    expect(obj.kind).toBe('stuck_loop_force_approve');
    expect(obj.count).toBe(4);
  });

  it('getStuckLoopThreshold default is 3, env override works', () => {
    const original = process.env.FORGEN_STUCK_LOOP_THRESHOLD;
    try {
      delete process.env.FORGEN_STUCK_LOOP_THRESHOLD;
      expect(getStuckLoopThreshold()).toBe(3);
      process.env.FORGEN_STUCK_LOOP_THRESHOLD = '5';
      expect(getStuckLoopThreshold()).toBe(5);
      process.env.FORGEN_STUCK_LOOP_THRESHOLD = '-1';
      expect(getStuckLoopThreshold()).toBe(3); // invalid → fallback
    } finally {
      if (original === undefined) delete process.env.FORGEN_STUCK_LOOP_THRESHOLD;
      else process.env.FORGEN_STUCK_LOOP_THRESHOLD = original;
    }
  });
});

describe('rulesFromStore (Rule.enforce_via → internal SpikeRule shape)', () => {
  function baseRule(overrides: Partial<StoreRule> = {}): StoreRule {
    return {
      rule_id: 'abcdef01',
      category: 'quality',
      scope: 'me',
      trigger: 'completion-evidence',
      policy: 'e2e before done',
      strength: 'strong',
      source: 'explicit_correction',
      status: 'active',
      evidence_refs: [],
      render_key: 'quality_safety.completion-evidence',
      created_at: '2026-04-22T00:00:00Z',
      updated_at: '2026-04-22T00:00:00Z',
      ...overrides,
    };
  }

  it('converts Mech-A Stop + artifact_check into SpikeRule', () => {
    const r = baseRule({
      enforce_via: [{
        mech: 'A',
        hook: 'Stop',
        verifier: { kind: 'artifact_check', params: { path: '.forgen/state/e2e-result.json', max_age_s: 3600 } },
        block_message: 'e2e required',
        trigger_keywords_regex: '(완료했)',
        trigger_exclude_regex: '(취소)',
        system_tag: 'rule:abcdef01 — e2e-before-done',
      }],
    });
    const out = rulesFromStore([r]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('abcdef01');
    expect(out[0].mech).toBe('A');
    expect(out[0].trigger.response_keywords_regex).toBe('(완료했)');
    expect(out[0].trigger.context_exclude_regex).toBe('(취소)');
    expect(out[0].verifier.kind).toBe('artifact_check');
    expect(out[0].system_tag).toContain('abcdef01');
  });

  it('uses shared default trigger regex when unspecified', () => {
    const r = baseRule({
      enforce_via: [{
        mech: 'B',
        hook: 'Stop',
        verifier: { kind: 'self_check_prompt', params: { question: 'q' } },
      }],
    });
    const out = rulesFromStore([r]);
    expect(out).toHaveLength(1);
    // default trigger includes '완료했'
    expect(new RegExp(out[0].trigger.response_keywords_regex).test('구현 완료했습니다.')).toBe(true);
    // default exclude excludes '취소'
    expect(new RegExp(out[0].trigger.context_exclude_regex!).test('완료 선언을 취소합니다.')).toBe(true);
  });

  it('filters non-Stop enforce_via entries', () => {
    const r = baseRule({
      enforce_via: [
        { mech: 'A', hook: 'PreToolUse', verifier: { kind: 'tool_arg_regex', params: { pattern: 'rm' } } },
        { mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: { path: 'x' } } },
      ],
    });
    const out = rulesFromStore([r]);
    expect(out).toHaveLength(1);
    expect(out[0].verifier.kind).toBe('artifact_check');
  });

  it('skips rules with no enforce_via', () => {
    const r = baseRule({ enforce_via: undefined });
    expect(rulesFromStore([r])).toHaveLength(0);
  });

  it('skips verifier kinds not supported by Stop hook', () => {
    const r = baseRule({
      enforce_via: [
        { mech: 'A', hook: 'Stop', verifier: { kind: 'tool_arg_regex' as 'artifact_check', params: {} } },
      ],
    });
    expect(rulesFromStore([r])).toHaveLength(0);
  });

  it('handles rule with multiple Stop enforce_via entries (flattens to multiple SpikeRules)', () => {
    const r = baseRule({
      enforce_via: [
        { mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: { path: 'a.json' } } },
        { mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: { question: 'q' } } },
      ],
    });
    const out = rulesFromStore([r]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.mech).sort()).toEqual(['A', 'B']);
    // both share the same rule_id as id (caller can dedupe if needed)
    expect(out.every((s) => s.id === 'abcdef01')).toBe(true);
  });
});

describe('stop-guard stdin e2e (fake Stop hook JSON → stdout)', () => {
  it('완료 선언 + 증거 없음 → stdout 에 decision:block + reason 포함', () => {
    const scriptPath = path.resolve(__dirname, '..', 'dist', 'hooks', 'stop-guard.js');
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`stop-guard.js not built at ${scriptPath} — run npm run build first`);
    }

    const rulesPath = path.resolve(__dirname, 'spike', 'mech-b-inject', 'scenarios.json');
    expect(fs.existsSync(rulesPath)).toBe(true);

    const proc = spawnSync('node', [scriptPath], {
      input: JSON.stringify({ session_id: 'test', stop_hook_active: true }),
      env: {
        ...process.env,
        FORGEN_SPIKE_RULES: rulesPath,
        FORGEN_SPIKE_LAST_MESSAGE: '구현 완료했습니다.',
      },
      encoding: 'utf-8',
      timeout: 8000,
    });

    expect(proc.status).toBe(0);
    const lines = proc.stdout.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];
    const out = JSON.parse(lastLine);
    expect(out.decision).toBe('block');
    expect(out.continue).toBe(true);
    expect(out.reason).toMatch(/e2e/i);
    expect(out.systemMessage).toMatch(/R-B1/);
  });

  it('일반 진행 메시지 → approve (continue: true, decision 없음)', () => {
    const scriptPath = path.resolve(__dirname, '..', 'dist', 'hooks', 'stop-guard.js');
    const rulesPath = path.resolve(__dirname, 'spike', 'mech-b-inject', 'scenarios.json');
    const proc = spawnSync('node', [scriptPath], {
      input: JSON.stringify({ session_id: 'test', stop_hook_active: true }),
      env: {
        ...process.env,
        FORGEN_SPIKE_RULES: rulesPath,
        FORGEN_SPIKE_LAST_MESSAGE: '작업 진행 중입니다.',
      },
      encoding: 'utf-8',
      timeout: 8000,
    });

    expect(proc.status).toBe(0);
    const lines = proc.stdout.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];
    const out = JSON.parse(lastLine);
    expect(out.continue).toBe(true);
    expect(out.decision).toBeUndefined();
  });
});
