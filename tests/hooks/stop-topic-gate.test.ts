/**
 * D12-C: stop-guard 주제 게이트 — 실제 hook 프로세스. 완료 키워드만으로 무관한 self_check 룰이 발동하던 오탐(R4)의 회귀.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { effectiveEnforceMode, enforceability } from '../../src/engine/rule-detectability.js';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'dist', 'hooks', 'stop-guard.js');
const have = fs.existsSync(HOOK);
let root: string; let home: string; let work: string;
const SID = '77777777-7777-4777-8777-777777777777';

const mockupRule = {
  rule_id: 'topic-gate-rule', category: 'quality', scope: 'me',
  trigger: '목업 디자인 UI 문구의 AI틱함',
  policy: '목업 화면의 디자인과 문구가 AI가 만든 티가 나면 안 된다. 설명 문장 가운뎃점 나열 장식 기호를 쓰지 말고 짧은 라벨식 문구를 기준으로 만든다.',
  strength: 'strong', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: 'quality.topic-gate',
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  enforce_via: [{ mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: { question: '직전 응답이 목업 AI틱 규칙을 위반했는지 자가점검하라.' } } }],
};

function stop(message: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: SID, cwd: work, last_assistant_message: message }),
    encoding: 'utf-8', timeout: 20000, cwd: work,
    env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_CWD: work, FORGEN_DISABLE_PROJECT_RULES: '1', FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '', ...extraEnv },
  });
  const lines = r.stdout.split('\n').filter((l) => l.trim());
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]) as { decision?: string; reason?: string };
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-topic-'));
  home = path.join(root, 'home'); work = path.join(root, 'work');
  const dir = path.join(home, '.forgen', 'me', 'rules');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(dir, 'topic-gate-rule.json'), JSON.stringify(mockupRule));
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!have)('stop-guard 주제 게이트 (프로세스)', () => {
  it('무관한 완료 보고(백엔드 리팩터링)는 목업 룰로 막히지 않는다', () => {
    const out = stop('서버 리팩터링을 완료했습니다. 마이그레이션 스크립트와 단위 테스트 12개를 통과시켰고 배포 준비도 끝났습니다.');
    expect(out.decision).toBeUndefined();
  });
  const onTopic = '목업 화면 디자인과 문구 작업을 완료했습니다. 설명 문장과 라벨식 문구를 정리했고 AI가 만든 티가 나는 부분도 손봤습니다.';
  const writeRule = (over: object) => fs.writeFileSync(path.join(home, '.forgen', 'me', 'rules', 'topic-gate-rule.json'), JSON.stringify({ ...mockupRule, ...over }));

  it('관련 있는 완료 보고라도 의미 룰은 기본이 기록만이라 차단하지 않고 기록을 남긴다', () => {
    expect(stop(onTopic).decision).toBeUndefined();
    const log = fs.readFileSync(path.join(home, '.forgen', 'state', 'enforcement', 'violations.jsonl'), 'utf-8');
    expect(log).toContain('topic-gate-rule');
    expect(log).toContain('"kind":"correction"');
  });

  it('rule enforce 로 켠 룰은 관련 있는 완료 보고를 차단한다', () => {
    writeRule({ enforce_mode: 'block' });
    try {
      const out = stop(onTopic);
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('자가점검');
    } finally { writeRule({}); }
  });

  it('hard 룰은 켜지 않아도 차단한다', () => {
    writeRule({ strength: 'hard' });
    try { expect(stop(onTopic).decision).toBe('block'); } finally { writeRule({}); }
  });
});

describe('effectiveEnforceMode (의미 룰 차단 정책)', () => {
  const self = { mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: { question: 'q' } } } as never;
  const evidence = { mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: { evidence_path: 'a.json' } } } as never;
  const artifact = { mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: { path: 'a.json' } } } as never;
  it('의미 룰은 strong 이어도 기본 advise', () => { expect(effectiveEnforceMode({ strength: 'strong' }, self)).toBe('advise'); });
  it('증거 파일로 판정하는 룰과 기계 판정 룰은 기본 block', () => {
    expect(effectiveEnforceMode({ strength: 'default' }, evidence)).toBe('block');
    expect(effectiveEnforceMode({ strength: 'default' }, artifact)).toBe('block');
  });
  it('hard 는 기본 block', () => { expect(effectiveEnforceMode({ strength: 'hard' }, self)).toBe('block'); });
  it('명시 값이 항상 우선', () => {
    expect(effectiveEnforceMode({ strength: 'default', enforce_mode: 'block' }, self)).toBe('block');
    expect(effectiveEnforceMode({ strength: 'default', enforce_mode: 'advise' }, artifact)).toBe('advise');
  });
});

describe('탐지 가능성 분류 (자문 표기)', () => {
  const spec = (verifier?: object, drift_key?: string) => ({ enforce_via: [{ mech: 'B', hook: 'Stop', ...(verifier ? { verifier } : {}), ...(drift_key ? { drift_key } : {}) }] } as never);
  it('self_check_prompt(증거 경로 없음) = 자문', () => { expect(enforceability(spec({ kind: 'self_check_prompt', params: { question: 'q' } }))).toBe('advisory'); });
  it('drift_key 만 있는 spec = 자문', () => { expect(enforceability(spec(undefined, 'x'))).toBe('advisory'); });
  it('enforce_via 없음 = 자문', () => { expect(enforceability({} as never)).toBe('advisory'); });
  it('tool_arg_regex(패턴) = 탐지 가능', () => { expect(enforceability(spec({ kind: 'tool_arg_regex', params: { pattern: 'x' } }))).toBe('detectable'); });
  it('evidence_path 가 있는 self_check_prompt = 탐지 가능', () => { expect(enforceability(spec({ kind: 'self_check_prompt', params: { evidence_path: 'a.json' } }))).toBe('detectable'); });
  it('language_ratio / tool_evidence = 탐지 가능', () => {
    expect(enforceability(spec({ kind: 'language_ratio', params: {} }))).toBe('detectable');
    expect(enforceability(spec({ kind: 'tool_evidence', params: {} }))).toBe('detectable');
  });
});
