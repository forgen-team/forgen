/**
 * D4·D7 (docs/plans/2026-11-17-rule-quality-redesign.md): 같은 문장 방지·정리, 검토 대기 처리.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({ TEST_HOME: `/tmp/forgen-test-dedupe-review-${process.pid}` }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { normalizePolicy } = await import('../src/store/rule-normalize.js');
const { createRule, saveRule, loadRule, loadAllRules, markRulesInjected } = await import('../src/store/rule-store.js');
const { processCorrection } = await import('../src/forge/evidence-processor.js');
const { promoteSessionCandidates } = await import('../src/store/evidence-store.js');
const { planDedupe, applyDedupe } = await import('../src/engine/rule-dedupe.js');
const { flagCauses, keepRules } = await import('../src/engine/rule-review.js');
const { collectSignals } = await import('../src/engine/lifecycle/signals.js');
const { detect: detectT2 } = await import('../src/engine/lifecycle/trigger-t2-violation.js');
const { scanDriftForDemotion } = await import('../src/engine/lifecycle/meta-reclassifier.js');
const { takeReviewNotice } = await import('../src/core/review-notice.js');

const F = path.join(TEST_HOME, '.forgen');
const LDIR = path.join(F, 'state', 'lifecycle');
const SID = '11111111-2222-4333-8444-555555555555';

function rule(id: string, o: Record<string, unknown> = {}) {
  const r = createRule({ category: 'workflow', scope: 'me', trigger: id, policy: `policy text for ${id}`, strength: 'default', source: 'explicit_correction', render_key: `w.${id}` });
  const out = { ...r, rule_id: id, ...o } as typeof r;
  saveRule(out);
  return out;
}
function log(day: string, rows: object[]) {
  fs.mkdirSync(LDIR, { recursive: true });
  fs.appendFileSync(path.join(LDIR, `${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe('normalizePolicy', () => {
  it('공백·끝 문장부호·대소문자만 같게 보고, 숫자·부정어·중간 문장부호는 그대로', () => {
    expect(normalizePolicy('  Run  tests at the END.  ')).toBe(normalizePolicy('run tests at the end'));
    expect(normalizePolicy('테스트는 마지막에 한 번만!')).toBe(normalizePolicy('테스트는  마지막에 한 번만'));
    expect(normalizePolicy('3회 반복')).not.toBe(normalizePolicy('5회 반복'));
    expect(normalizePolicy('배포하지 말 것')).not.toBe(normalizePolicy('배포할 것'));
    expect(normalizePolicy('a, b')).not.toBe(normalizePolicy('a b'));
  });
});

describe('D4 생성 시 같은 문장 방지', () => {
  it('target 만 다른 같은 교정 2건 → 활성 me 룰 1개, 증거 2개', () => {
    processCorrection({ session_id: 's1', kind: 'prefer-from-now', message: '작업 중에는 전체 테스트를 돌리지 않는다', target: 'no tests mid task', axis_hint: 'quality_safety' });
    promoteSessionCandidates('s1');
    processCorrection({ session_id: 's2', kind: 'prefer-from-now', message: '작업 중에는 전체 테스트를 돌리지 않는다.', target: 'heavy checks during work', axis_hint: 'quality_safety' });
    promoteSessionCandidates('s2');
    const me = loadAllRules().filter((r) => r.status === 'active' && r.scope === 'me');
    expect(me).toHaveLength(1);
    expect(me[0].evidence_refs).toHaveLength(2);
  });
});

describe('D4 dedupe', () => {
  it('출처별로 묶고, strength 높은 → 오래된 룰을 남기며, hard 는 대체하지 않는다', () => {
    rule('a', { policy: '같은 문장 룰 본문입니다', created_at: '2026-10-01T00:00:00Z' });
    rule('b', { policy: '같은 문장 룰 본문입니다.', strength: 'strong', created_at: '2026-11-01T00:00:00Z' });
    rule('c', { policy: '같은  문장 룰 본문입니다', created_at: '2026-09-01T00:00:00Z' });
    rule('m', { policy: '같은 문장 룰 본문입니다', source: 'behavior_inference', render_key: 'auto:w.m' });
    rule('h1', { policy: '안전 룰 본문 텍스트입니다', strength: 'hard' });
    rule('h2', { policy: '안전 룰 본문 텍스트입니다', strength: 'hard', created_at: '2026-01-01T00:00:00Z' });
    const plan = planDedupe(loadAllRules());
    expect(plan).toHaveLength(1);
    expect(plan[0].keeper.rule_id).toBe('b');
    expect(plan[0].duplicates.map((d) => d.rule_id).sort()).toEqual(['a', 'c']);
  });
  it('적용: 스냅샷, 대체(superseded_by), 같은 출처 증거 합치기, projects 합집합', () => {
    rule('a', { policy: '같은 문장 룰 본문입니다', evidence_refs: ['e1'], projects: ['alpha'] });
    rule('b', { policy: '같은 문장 룰 본문입니다', evidence_refs: ['e2'], projects: ['beta'], created_at: '2020-01-01T00:00:00Z' });
    const r = applyDedupe();
    expect(r).toMatchObject({ groups: 1, superseded: 1 });
    expect(fs.existsSync(path.join(F, 'backups', r.snapshot!))).toBe(true);
    const keeper = loadRule('b')!;
    expect(keeper.evidence_refs.sort()).toEqual(['e1', 'e2']);
    expect(keeper.projects).toEqual(['alpha', 'beta']);
    const dup = loadRule('a')!;
    expect(dup.status).toBe('superseded');
    expect(dup.lifecycle?.superseded_by).toBe('b');
    expect(applyDedupe().groups).toBe(0);
  });
});

describe('D7 검토 대기', () => {
  it('원인: T1·T2 기록이 T5 보다 우선, 같은 종류면 최신, 기록 없으면 unknown', () => {
    log('2026-11-10', [
      { kind: 't5_conflict_detected', rule_id: 'r1', ts: 3 },
      { kind: 't1_explicit_correction', rule_id: 'r1', ts: 1, evidence: { refs: ['ev1'] } },
      { kind: 't5_conflict_detected', rule_id: 'r2', ts: 1 },
      { kind: 't2_repeated_violation', rule_id: 'r3', ts: 1 },
      { kind: 't3_user_bypass', rule_id: 'r3', ts: 5 },
    ]);
    const c = flagCauses(new Set(['r1', 'r2', 'r3', 'r4']));
    expect(c.get('r1')).toMatchObject({ cause: 'correction', evidenceRef: 'ev1' });
    expect(c.get('r2')?.cause).toBe('conflict');
    expect(c.get('r3')?.cause).toBe('bypass');
    expect(c.get('r4')?.cause).toBe('unknown');
  });

  it('룰을 지목하지 않은 옛 T1 은 legacy(약한 원인)로, T2 가 있으면 T2 가 이긴다', () => {
    const bdir = path.join(F, 'me', 'behavior');
    fs.mkdirSync(bdir, { recursive: true });
    fs.writeFileSync(path.join(bdir, 'evx.json'), JSON.stringify({ evidence_id: 'evx', candidate_rule_refs: ['other'], raw_payload: {} }));
    log('2026-10-01', [
      { kind: 't1_explicit_correction', rule_id: 'L1', ts: 9, evidence: { refs: ['evx'] } },
      { kind: 't1_explicit_correction', rule_id: 'L2', ts: 9, evidence: { refs: ['evx'] } },
      { kind: 't2_repeated_violation', rule_id: 'L2', ts: 1 },
    ]);
    const c = flagCauses(new Set(['L1', 'L2']));
    expect(c.get('L1')?.cause).toBe('legacy');
    expect(c.get('L2')?.cause).toBe('violations');
  });

  it('유지하면 phase active + reviewed_at, 주입 카운트가 올라가도 reviewed_at 은 남는다', () => {
    const r = rule('k1', {});
    saveRule({ ...r, lifecycle: { ...r.lifecycle!, phase: 'flagged' } });
    expect(keepRules(['k1'], '2026-11-17T00:00:00.000Z')).toBe(1);
    markRulesInjected(['k1']);
    const after = loadRule('k1')!;
    expect(after.lifecycle?.phase).toBe('active');
    expect(after.lifecycle?.reviewed_at).toBe('2026-11-17T00:00:00.000Z');
    expect(after.lifecycle?.inject_count).toBe(1);
  });

  it('유지한 뒤에는 검토 이전 차단으로 T2 가 다시 걸지 않고, 이후 차단이 쌓이면 건다', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const r = rule('t2', {});
    const reviewed = { ...r, lifecycle: { ...r.lifecycle!, phase: 'active' as const, inject_count: 2, reviewed_at: '2026-11-15T00:00:00.000Z' } };
    const v = (day: string) => ({ at: `${day}T10:00:00.000Z`, violation_id: day, rule_id: 't2', session_id: SID, source: 'stop-guard', kind: 'block' as const, matched: '', target_kind: 'response' as const, target_hash: 'x' });
    const before = [v('2026-11-10'), v('2026-11-11'), v('2026-11-12'), v('2026-11-13')];
    const s1 = collectSignals(reviewed, { violations: before, now });
    expect(detectT2({ rules: [reviewed], signals: new Map([['t2', s1]]), ts: now })).toHaveLength(0);
    const unreviewed = { ...reviewed, lifecycle: { ...reviewed.lifecycle, reviewed_at: undefined } };
    expect(detectT2({ rules: [unreviewed], signals: new Map([['t2', collectSignals(unreviewed, { violations: before, now })]]), ts: now })).toHaveLength(1);
    const after = [...before, v('2026-11-16'), v('2026-11-16'), v('2026-11-17')];
    expect(detectT2({ rules: [reviewed], signals: new Map([['t2', collectSignals(reviewed, { violations: after, now })]]), ts: now })).toHaveLength(1);
  });

  it('drift 강등도 reviewed_at 이전 기록은 세지 않는다', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const r = { ...rule('d1', {}), enforce_via: [{ mech: 'A', hook: 'Stop' }] } as never as ReturnType<typeof rule>;
    const drift = ['2026-11-14', '2026-11-15', '2026-11-16'].map((d) => ({ at: `${d}T00:00:00.000Z`, kind: 'stuck_loop_force_approve', session_id: SID, rule_id: 'd1', count: 3 }));
    expect(scanDriftForDemotion({ rules: [r], drift, now })).toHaveLength(1);
    const reviewed = { ...r, lifecycle: { ...r.lifecycle!, reviewed_at: '2026-11-15T12:00:00.000Z' } };
    expect(scanDriftForDemotion({ rules: [reviewed], drift, now })).toHaveLength(0);
  });

  it('세션 시작 안내: 3개 이상일 때만, 하루 1회', () => {
    for (const id of ['f1', 'f2']) { const r = rule(id); saveRule({ ...r, lifecycle: { ...r.lifecycle!, phase: 'flagged' } }); }
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(takeReviewNotice(now)).toBeNull();
    const r3 = rule('f3'); saveRule({ ...r3, lifecycle: { ...r3.lifecycle!, phase: 'flagged' } });
    expect(takeReviewNotice(now)).toContain('검토 대기 룰 3개');
    expect(takeReviewNotice(now + 3600_000)).toBeNull();
    expect(takeReviewNotice(now + 86_400_000 + 1)).toContain('3개');
  });

  it('0.8.0: 승인 대기 솔루션 3개 이상이면 같은 안내 한 줄에 합친다(룰이 임계 미만이어도)', () => {
    const dir = path.join(F, 'me', 'solutions');
    fs.mkdirSync(dir, { recursive: true });
    for (const n of ['s1', 's2', 's3']) {
      fs.writeFileSync(path.join(dir, `${n}.md`), `---\nname: "${n}"\nversion: 1\nstatus: "candidate"\nconfidence: 0.5\ntype: "pattern"\nscope: "me"\ntags: ["a"]\nidentifiers: []\nevidence:\n  injected: 0\n  reflected: 0\n  negative: 0\n  sessions: 0\n  reExtracted: 1\ncreated: "2026-11-01"\nupdated: "2026-11-01"\nsupersedes: null\nextractedBy: "auto"\nevidenceSessions: ["a", "b"]\n---\n\n## Context\nc\n\n## Content\nbody\n`);
    }
    const now = Date.parse('2026-11-25T12:00:00Z');
    const msg = takeReviewNotice(now);
    expect(msg).toContain('승인 대기 솔루션 3개');
    expect(msg).not.toContain('검토 대기 룰');
    for (const id of ['g1', 'g2', 'g3']) { const r = rule(id); saveRule({ ...r, lifecycle: { ...r.lifecycle!, phase: 'flagged' } }); }
    const both = takeReviewNotice(now + 86_400_000 + 1);
    expect(both).toContain('검토 대기 룰 3개');
    expect(both).toContain('승인 대기 솔루션 3개');
  });
});
