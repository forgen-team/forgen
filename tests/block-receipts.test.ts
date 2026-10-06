/**
 * ADR-017 D1 — 영수증·판정·precision 프리미티브 + 자동 판정(Haiku) 로직. 격리 HOME, 모델 호출은 주입(exec deps).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({ TEST_HOME: `/tmp/forgen-test-receipts-${process.pid}` }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const sig = await import('../src/engine/lifecycle/signals.js');
const judge = await import('../src/engine/block-judge.js');
const { createRule, saveRule, loadRule, loadAllRules } = await import('../src/store/rule-store.js');
const { STATE_DIR, ME_DIR } = await import('../src/core/paths.js');
const ENF = () => path.join(STATE_DIR, 'enforcement');

describe('recordViolation 영수증', () => {
  beforeEach(() => { fs.rmSync(TEST_HOME, { recursive: true, force: true }); fs.mkdirSync(ME_DIR, { recursive: true }); });
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('violation_id 발급, matched 160자 제한, 전문은 secret 마스킹 후 receipts/ 에, 로그엔 hash 만', () => {
    const id = sig.recordViolation(
      { rule_id: 'r1', session_id: 's1', source: 'pre-tool-guard', kind: 'deny', matched: 'x'.repeat(300), target_kind: 'command' },
      // self-gate(secrets-leak) 가 소스의 리터럴을 잡지 않도록 런타임에 조립 (AWS 공식 예시 키).
      { receipt_text: `export AWS_SECRET_ACCESS_KEY=${['AKIA', 'IOSFODNN7EXAMPLE1234'].join('')} && rm -rf /srv` },
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const v = sig.readJsonlSafe<Record<string, unknown>>(path.join(ENF(), 'violations.jsonl'))[0];
    expect(v.violation_id).toBe(id);
    expect((v.matched as string).length).toBe(160);
    expect(v.target_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(v)).not.toContain('AKIA');
    const receipt = sig.readReceipt(id)!;
    expect(receipt).not.toContain(['AKIA', 'IOSFODNN7EXAMPLE1234'].join(''));
    expect(receipt).toContain('rm -rf /srv');
  });
  it('TTL 지난 영수증은 다음 기록 때 정리', () => {
    const old = sig.recordViolation({ rule_id: 'r1', session_id: 's1', source: 'stop-guard', kind: 'block' }, { receipt_text: 'old' });
    const p = path.join(ENF(), 'receipts', `${old}.txt`);
    const past = (Date.now() - sig.RECEIPT_TTL_MS - 60_000) / 1000;
    fs.utimesSync(p, past, past);
    sig.recordViolation({ rule_id: 'r1', session_id: 's1', source: 'stop-guard', kind: 'block' }, { receipt_text: 'new' });
    expect(fs.existsSync(p)).toBe(false);
  });
  it('readReceipt 는 경로 인젝션 id 거부', () => {
    expect(sig.readReceipt('../../etc/passwd')).toBeNull();
  });
});

describe('판정·precision', () => {
  beforeEach(() => { fs.rmSync(TEST_HOME, { recursive: true, force: true }); fs.mkdirSync(ME_DIR, { recursive: true }); });
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('user 판정이 auto 를 덮어쓰고, precision 은 실 차단·7d·판정 기준', () => {
    const ids = [1, 2, 3, 4].map(() => sig.recordViolation({ rule_id: 'r1', session_id: 's1', source: 'stop-guard', kind: 'block' }));
    sig.recordViolation({ rule_id: 'r1', session_id: 'default', source: 'stop-guard', kind: 'block' }); // 합성 → 제외
    sig.recordViolation({ rule_id: 'r1', session_id: 's1', source: 'stop-guard', kind: 'correction' }); // advise → 제외
    sig.setVerdict({ violation_id: ids[0], rule_id: 'r1', verdict: 'false_positive', by: 'auto' });
    sig.setVerdict({ violation_id: ids[0], rule_id: 'r1', verdict: 'correct', by: 'user' });
    sig.setVerdict({ violation_id: ids[0], rule_id: 'r1', verdict: 'false_positive', by: 'auto' }); // 나중 auto 도 user 못 덮음
    sig.setVerdict({ violation_id: ids[1], rule_id: 'r1', verdict: 'false_positive', by: 'auto' });
    sig.setVerdict({ violation_id: ids[2], rule_id: 'r1', verdict: 'unsure', by: 'auto' });
    const eff = sig.effectiveVerdicts();
    expect(eff.get(ids[0])?.verdict).toBe('correct');
    const p = sig.precisionByRule(sig.readJsonlSafe(path.join(ENF(), 'violations.jsonl')), sig.readVerdicts(), 7).get('r1')!;
    expect(p).toEqual({ rule_id: 'r1', correct: 1, false_positive: 1, unjudged: 2, precision: 0.5 });
  });
  it('checks.jsonl 은 violations 와 분리', () => {
    sig.recordCheck({ session_id: 's1', rule_id: 'r1', result: 'pass' });
    expect(sig.readChecks()).toHaveLength(1);
    expect(fs.existsSync(path.join(ENF(), 'violations.jsonl'))).toBe(false);
  });
});

describe('block-judge', () => {
  beforeEach(() => { fs.rmSync(TEST_HOME, { recursive: true, force: true }); fs.mkdirSync(ME_DIR, { recursive: true }); });
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('parseJudgeOutput: JSON 한 줄 추출, 이상값은 unsure', () => {
    expect(judge.parseJudgeOutput('결과: {"verdict":"false_positive","reason":"설명문"}')).toEqual({ verdict: 'false_positive', reason: '설명문' });
    expect(judge.parseJudgeOutput('{"verdict":"maybe"}').verdict).toBe('unsure');
    expect(judge.parseJudgeOutput('garbage').verdict).toBe('unsure');
  });
  it('buildJudgePrompt 에 룰·출처·매칭·발췌가 들어가고 JSON 지시로 끝난다', () => {
    const p = judge.buildJudgePrompt({ violation: { at: '', rule_id: 'r1', session_id: 's', source: 'stop-guard', kind: 'block', matched: 'rm -rf' }, rulePolicy: 'P', originLine: 'O', receipt: 'x'.repeat(5000) + 'rm -rf' + 'y'.repeat(100) });
    expect(p).toContain('## 룰\nP');
    expect(p).toContain('O');
    expect(p).toContain('rm -rf');
    expect(p.length).toBeLessThan(3500);
    expect(p.trim().endsWith('"reason":"<한국어 한 문장>"}')).toBe(true);
  });
  it('judgeViolation: consent 없으면 null, 있으면 exec 결과를 auto 판정으로 기록; 실패는 unsure', async () => {
    saveRule(createRule({ category: 'workflow', scope: 'me', trigger: 't', policy: 'P', strength: 'default', source: 'explicit_correction', evidence_refs: [] }));
    const rid = loadAllRules()[0].rule_id;
    const id = sig.recordViolation({ rule_id: rid, session_id: 's1', source: 'stop-guard', kind: 'block', matched: 'm' }, { receipt_text: 'body' });
    expect(await judge.judgeViolation(id, { consent: () => false })).toBeNull();
    let seen = '';
    expect(await judge.judgeViolation(id, { consent: () => true, exec: async (p) => { seen = p; return '{"verdict":"false_positive","reason":"평문 설명"}'; } })).toBe('false_positive');
    expect(seen).toContain('## 룰\nP');
    expect(sig.effectiveVerdicts().get(id)).toMatchObject({ verdict: 'false_positive', by: 'auto', reason: '평문 설명' });
    const id2 = sig.recordViolation({ rule_id: rid, session_id: 's1', source: 'stop-guard', kind: 'block' });
    expect(await judge.judgeViolation(id2, { consent: () => true, exec: async () => { throw new Error('timeout'); } })).toBe('unsure');
  });
  it('캡: 일 30건·세션 10건 초과 시 판정 안 함', () => {
    const now = Date.now();
    const vio = Array.from({ length: 12 }, (_, i) => ({ at: new Date(now).toISOString(), rule_id: 'r', session_id: 's1', source: 'stop-guard' as const, kind: 'block' as const, violation_id: `v${i}` }));
    const auto10 = vio.slice(0, 10).map((v) => ({ at: new Date(now).toISOString(), violation_id: v.violation_id, rule_id: 'r', verdict: 'correct' as const, by: 'auto' as const }));
    expect(judge.withinJudgeCaps('s1', now, auto10, vio)).toBe(false);
    expect(judge.withinJudgeCaps('s2', now, auto10, vio)).toBe(true);
    const day30 = Array.from({ length: 30 }, (_, i) => ({ at: new Date(now).toISOString(), violation_id: `o${i}`, rule_id: 'r', verdict: 'correct' as const, by: 'auto' as const }));
    expect(judge.withinJudgeCaps('s2', now, day30, vio)).toBe(false);
  });
  it('maybeDemote: 판정 ≥5 & precision <0.5 → advise, 하드 룰은 절대 아님', () => {
    saveRule(createRule({ category: 'workflow', scope: 'me', trigger: 't', policy: 'P', strength: 'default', source: 'explicit_correction', evidence_refs: [] }));
    saveRule(createRule({ category: 'quality', scope: 'me', trigger: 'h', policy: 'H', strength: 'hard', source: 'explicit_correction', evidence_refs: [] }));
    const [soft, hard] = loadAllRules().sort((a, b) => a.strength.localeCompare(b.strength)); // default < hard
    for (const r of [soft, hard]) {
      for (let i = 0; i < 6; i++) {
        const id = sig.recordViolation({ rule_id: r.rule_id, session_id: 's1', source: 'stop-guard', kind: 'block' });
        sig.setVerdict({ violation_id: id, rule_id: r.rule_id, verdict: i < 5 ? 'false_positive' : 'correct', by: 'auto' });
      }
    }
    expect(judge.maybeDemote(soft.rule_id)).toBe(true);
    expect(loadRule(soft.rule_id)?.enforce_mode).toBe('advise');
    expect(judge.maybeDemote(hard.rule_id)).toBe(false);
    expect(loadRule(hard.rule_id)?.enforce_mode).toBeUndefined();
    expect(judge.maybeDemote(soft.rule_id)).toBe(false); // 이미 advise → no-op
  });
});
