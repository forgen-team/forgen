/**
 * 0.7.0 D5 (docs/plans/2026-11-17-rule-quality-redesign.md): 채굴(추론) 룰 후보 단계·마지막 근거 기준 수명·범위.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-mined-candidates-'));
process.env.FORGEN_HOME = TMP_HOME;
process.env.FORGEN_DISABLE_PROJECT_RULES = '1';

const { createEvidence, saveEvidence, promoteSessionCandidates } = await import('../src/store/evidence-store.js');
const { createRule, saveRule, loadAllRules, loadActiveRules, loadRule } = await import('../src/store/rule-store.js');
const { withStatusChange } = await import('../src/store/rule-lifecycle.js');
const { demoteWeakMinedRules, planMinedDemotion } = await import('../src/engine/rule-candidates.js');
const { computeRuleHealth } = await import('../src/core/rule-health.js');

const DAY = 86_400_000;
const POLICY_A = '작업 중간에는 전체 테스트 스위트를 돌리지 말고 마지막에 한 번만 돌린다';
const POLICY_B = '응답 마지막에 바뀐 파일 목록을 짧게 정리해서 보여 준다';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  fs.rmSync(path.join(TMP_HOME, 'me'), { recursive: true, force: true });
  fs.rmSync(path.join(TMP_HOME, 'backups'), { recursive: true, force: true });
});

function mine(sid: string, summary: string, target: string, extra: Record<string, unknown> = {}, ageDays = 0) {
  const e = createEvidence({
    type: 'explicit_correction', session_id: sid, source_component: 'auto-compound-miner', summary, confidence: 0.55,
    raw_payload: { kind: 'prefer-from-now', target, axis_hint: 'workflow', auto_mined: true, ...extra },
  });
  const ev = ageDays ? { ...e, timestamp: new Date(Date.now() - ageDays * DAY).toISOString() } : e;
  saveEvidence(ev);
  return ev;
}
const mined = () => loadAllRules().filter((r) => r.source === 'behavior_inference');

describe('후보 → 활성', () => {
  it('새 채굴 룰은 후보(주입 안 됨), 같은 세션 재관측은 후보 유지, 다른 세션에서 잡히면 활성', () => {
    mine(S1, POLICY_A, 'no-mid-tests');
    promoteSessionCandidates(S1);
    expect(mined().map((r) => r.status)).toEqual(['candidate']);
    expect(loadActiveRules()).toHaveLength(0);

    mine(S1, POLICY_A, 'tests-at-end');
    promoteSessionCandidates(S1);
    expect(mined()).toHaveLength(1);
    expect(mined()[0].status).toBe('candidate');
    expect(mined()[0].evidence_refs).toHaveLength(2);

    mine(S2, POLICY_A, 'heavy-checks-late');
    promoteSessionCandidates(S2);
    const r = mined()[0];
    expect(mined()).toHaveLength(1);
    expect(r.status).toBe('active');
    expect(r.status_history?.at(-1)).toMatchObject({ from: 'candidate', to: 'active', reason: 'candidate-confirmed' });
  });

  it('render_key 로 찾은 후보도 다른 세션 근거가 생기면 활성', () => {
    mine(S1, POLICY_A, 'same-target');
    promoteSessionCandidates(S1);
    mine(S2, POLICY_B, 'same-target'); // 다른 문장 → 사전 중복 검사 불일치, render_key 일치
    promoteSessionCandidates(S2);
    expect(mined()).toHaveLength(1);
    expect(mined()[0].status).toBe('active');
  });

  it('사용자가 끈 채굴 룰은 다시 잡혀도 되살리지 않는다', () => {
    mine(S1, POLICY_A, 'off-target');
    promoteSessionCandidates(S1);
    const r = mined()[0];
    saveRule({ ...r, status: 'suppressed' });
    mine(S2, POLICY_B, 'off-target');
    promoteSessionCandidates(S2);
    expect(loadRule(r.rule_id)!.status).toBe('suppressed');
    expect(promoteSessionCandidates(S2)).toBe(0);
  });

  it('끈 채굴 룰과 같은 개념이 다른 target 으로 다시 뽑혀도 새 후보를 만들지 않는다', () => {
    mine(S1, POLICY_A, 'first-target');
    promoteSessionCandidates(S1);
    const r = mined()[0];
    saveRule({ ...r, status: 'suppressed' });
    mine(S2, POLICY_A, 'another-target');
    promoteSessionCandidates(S2);
    expect(mined()).toHaveLength(1);
    expect(loadRule(r.rule_id)!.status).toBe('suppressed');
  });

  it('explicit 룰과 같은 개념이면 룰을 만들지 않고 관측 카운트도 올리지 않는다', () => {
    const e = createRule({ category: 'workflow', scope: 'me', trigger: 'x', policy: POLICY_A, strength: 'default', source: 'explicit_correction', render_key: 'workflow.x' });
    saveRule(e);
    mine(S1, POLICY_A, 'y');
    promoteSessionCandidates(S1);
    expect(mined()).toHaveLength(0);
    expect(loadRule(e.rule_id)!.mined_observations).toBeUndefined();
  });
});

describe('범위 (Haiku generality)', () => {
  it('general → 전역, project → 그 프로젝트, 다른 프로젝트 재관측 → 합집합, 정보 없음 → 유지, general → 전역', () => {
    mine(S1, POLICY_A, 't1', { generality: 'project', projects: ['alpha'] });
    promoteSessionCandidates(S1);
    expect(mined()[0].projects).toEqual(['alpha']);
    mine(S2, POLICY_A, 't2', { generality: 'project', projects: ['beta'] });
    promoteSessionCandidates(S2);
    expect(mined()[0].projects).toEqual(['alpha', 'beta']);
    mine('s3', POLICY_A, 't3', { generality: 'project' });
    promoteSessionCandidates('s3');
    expect(mined()[0].projects).toEqual(['alpha', 'beta']);
    mine('s4', POLICY_A, 't4', { generality: 'general', scope_hint: 'general' });
    promoteSessionCandidates('s4');
    expect(mined()[0].projects).toBeUndefined();

    mine(S1, POLICY_B, 't5', { generality: 'general', scope_hint: 'general' });
    promoteSessionCandidates(S1);
    expect(mined().find((r) => r.policy === POLICY_B)!.projects).toBeUndefined();
  });
});

describe('수명·상한: 마지막 근거 기준', () => {
  it('오래전에 만든 활성 룰도 최근 근거가 있으면 남고, 후보는 마지막 근거 21일 뒤 정리된다', () => {
    const oldEv = mine(S1, POLICY_A, 'a', {}, 30);
    const newEv = mine(S2, POLICY_A, 'a', {}, 1);
    const r = createRule({ category: 'workflow', scope: 'me', trigger: 'a', policy: POLICY_A, strength: 'default', source: 'behavior_inference', render_key: 'auto:workflow.a', evidence_refs: [oldEv.evidence_id, newEv.evidence_id] });
    saveRule({ ...r, created_at: new Date(Date.now() - 40 * DAY).toISOString() });
    const cEv = mine(S1, POLICY_B, 'b', {}, 22);
    const c = createRule({ category: 'workflow', scope: 'me', trigger: 'b', policy: POLICY_B, strength: 'default', source: 'behavior_inference', render_key: 'auto:workflow.b', evidence_refs: [cEv.evidence_id] });
    saveRule({ ...c, status: 'candidate' });
    // 두 증거 모두 소비 표시 → 승급 루프는 아무것도 안 하고 은퇴 검사만 돈다
    for (const e of [oldEv, newEv, cEv]) saveEvidence({ ...e, candidate_rule_refs: ['x'] });
    promoteSessionCandidates('none');
    expect(loadRule(r.rule_id)!.status).toBe('active');
    expect(loadRule(c.rule_id)!.status).toBe('removed');
    expect(loadRule(c.rule_id)!.status_history?.at(-1)?.reason).toBe('candidate-expired');
  });
});

describe('0.7.0 마이그레이션', () => {
  it('근거 세션 1곳뿐인 활성 채굴 룰만 후보로, 스냅샷 생성, 2곳 이상·explicit 은 그대로', () => {
    const e1 = mine(S1, POLICY_A, 'a');
    const e2 = mine(S2, POLICY_A, 'a');
    const e3 = mine(S1, POLICY_B, 'b');
    const strong = createRule({ category: 'workflow', scope: 'me', trigger: 'a', policy: POLICY_A, strength: 'default', source: 'behavior_inference', render_key: 'auto:workflow.a', evidence_refs: [e1.evidence_id, e2.evidence_id] });
    const weak = createRule({ category: 'workflow', scope: 'me', trigger: 'b', policy: POLICY_B, strength: 'default', source: 'behavior_inference', render_key: 'auto:workflow.b', evidence_refs: [e3.evidence_id] });
    const exp = createRule({ category: 'workflow', scope: 'me', trigger: 'c', policy: 'explicit policy text long enough', strength: 'default', source: 'explicit_correction', render_key: 'workflow.c', evidence_refs: [e3.evidence_id] });
    for (const r of [strong, weak, exp]) saveRule(r);
    expect(planMinedDemotion().map((r) => r.rule_id)).toEqual([weak.rule_id]);
    const res = demoteWeakMinedRules();
    expect(res.count).toBe(1);
    expect(fs.existsSync(path.join(TMP_HOME, 'backups', res.snapshot!))).toBe(true);
    expect(loadRule(weak.rule_id)!.status).toBe('candidate');
    expect(loadRule(strong.rule_id)!.status).toBe('active');
    expect(loadRule(exp.rule_id)!.status).toBe('active');
    expect(demoteWeakMinedRules().count).toBe(0);
  });
});

describe('--health 의 후보 집계', () => {
  it('후보로 태어난 룰은 활성이 된 날 생성으로, 후보 만료는 은퇴로 세지 않는다', () => {
    const now = Date.now();
    const mk = (id: string) => ({ ...createRule({ category: 'workflow', scope: 'me', trigger: id, policy: `policy text ${id} long`, strength: 'default', source: 'behavior_inference', render_key: `auto:w.${id}` }), rule_id: id });
    saveRule({ ...mk('cand'), status: 'candidate' });
    const conf = { ...mk('conf'), status: 'candidate' as const };
    saveRule(withStatusChange(conf, 'active', 'candidate-confirmed', 't'));
    const exp = { ...mk('exp'), status: 'candidate' as const };
    saveRule(withStatusChange(exp, 'removed', 'candidate-expired', 't'));
    saveRule(mk('born-active'));
    const h = computeRuleHealth({ days: 3, now });
    expect(h.rules.candidates).toBe(1);
    expect(h.flow.rulesCreatedMined).toBe(2); // conf(확정일) + born-active
    expect(h.flow.candidatesConfirmed).toBe(1);
    expect(h.flow.retired).toBe(0);
  });
});
