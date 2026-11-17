/**
 * D8 (docs/plans/2026-11-17-rule-quality-redesign.md): forgen status --health 집계.
 * 숫자마다 출처가 고정돼 있는지 픽스처 ~/.forgen 으로 검증한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({ TEST_HOME: `/tmp/forgen-test-health-${process.pid}` }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { computeRuleHealth, renderRuleHealth } = await import('../src/core/rule-health.js');

const F = path.join(TEST_HOME, '.forgen');
const NOW = Date.parse('2026-11-17T12:00:00Z');
const SID = '11111111-2222-4333-8444-555555555555'; // 실세션은 UUID — 그 외는 합성(테스트 유래)으로 제외된다
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function writeRule(id: string, o: Record<string, unknown>) {
  const dir = path.join(F, 'me', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    rule_id: id, category: 'workflow', scope: 'me', trigger: id, policy: `policy ${id} long enough text`, strength: 'default',
    source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: `w.${id}`, created_at: iso(30), updated_at: iso(30), ...o,
  }));
}
function writeEvidence(id: string, daysAgo: number, mined: boolean) {
  const dir = path.join(F, 'me', 'behavior');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ evidence_id: id, type: 'explicit_correction', source_component: mined ? 'auto-compound-miner' : 'Hooks', timestamp: iso(daysAgo), summary: 's' }));
}
function jsonl(rel: string, rows: object[]) {
  const p = path.join(F, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe('computeRuleHealth', () => {
  it('룰 상태: 출처별 활성, 검토 대기 원인 분리, 같은 문장, 주입 0, 범위 없음', () => {
    writeRule('e1', { lifecycle: { phase: 'flagged', conflict_refs: ['x'], inject_count: 5 } });
    writeRule('e2', { lifecycle: { phase: 'flagged', conflict_refs: [], inject_count: 0 }, projects: ['alpha'] });
    writeRule('m1', { source: 'behavior_inference', policy: '같은 문장 룰입니다 정말로', lifecycle: { phase: 'active', inject_count: 2 } });
    writeRule('m2', { source: 'behavior_inference', policy: '같은  문장 룰입니다 정말로!', lifecycle: { phase: 'active', inject_count: 0 } });
    writeRule('o1', { source: 'onboarding' });
    writeRule('gone', { status: 'removed' });
    jsonl('state/lifecycle/2026-11-10.jsonl', [{ kind: 't5_conflict_detected', rule_id: 'e1', evidence: { refs: ['e1', 'x'] } }, { kind: 't2_repeated_violation', rule_id: 'e2' }]);
    const h = computeRuleHealth({ now: NOW });
    expect(h.rules.active).toEqual({ total: 5, explicit: 2, mined: 2, onboarding: 1, other: 0 });
    expect(h.rules.flagged).toEqual({ total: 2, conflictOnly: 1, other: 1 });
    expect(h.rules.duplicateGroups.map((g) => g.ruleIds.sort())).toEqual([['m1', 'm2']]);
    expect(h.rules.neverInjected).toBe(3); // e2, m2, o1
    expect(h.rules.unscopedLearned).toBe(3); // e1, m1, m2 (e2 는 범위 있음, o1 은 학습 룰 아님)
    expect(h.flow.injections).toBe(7);
  });

  it('흐름·일별: 교정 직접/추론, 생성, 은퇴, 승급, 차단, 자문, 우회 — 창 밖은 제외', () => {
    writeEvidence('u1', 1, false);
    writeEvidence('u2', 20, false); // 창(14일) 밖
    writeEvidence('n1', 1, true);
    writeEvidence('n2', 0, true);
    writeRule('new1', { created_at: iso(1) });
    writeRule('new2', { source: 'behavior_inference', created_at: iso(0), status: 'removed', status_history: [{ at: iso(0), from: 'active', to: 'removed', reason: 'cap', by: 'x' }] });
    jsonl('state/enforcement/violations.jsonl', [
      { at: iso(1), rule_id: 'new1', session_id: SID, kind: 'block' },
      { at: iso(1), rule_id: 'new1', session_id: SID, kind: 'deny' },
      { at: iso(0), rule_id: 'new1', session_id: SID, kind: 'correction' },
      { at: iso(0), rule_id: 'new1', session_id: SID, kind: 'bypass_confirmed' },
      { at: iso(0), rule_id: 'new1', session_id: 'default', kind: 'block' }, // 합성(테스트 유래) — 제외
    ]);
    jsonl('state/enforcement/checks.jsonl', [{ at: iso(0), session_id: SID, rule_id: 'new1', result: 'pass' }, { at: iso(0), session_id: SID, rule_id: 'new1', result: 'violation' }]);
    jsonl('state/enforcement/acknowledgments.jsonl', [{ at: iso(0), rule_id: 'new1', block_count: 2 }]);
    jsonl(`state/lifecycle/${iso(1).slice(0, 10)}.jsonl`, [{ kind: 'meta_promote_to_a', rule_id: 'new1', ts: NOW - 86_400_000 }, { kind: 't1_explicit_correction', rule_id: 'new1', ts: NOW - 86_400_000 }]);

    const h = computeRuleHealth({ now: NOW });
    expect(h.flow).toMatchObject({ correctionsUser: 1, correctionsMined: 2, rulesCreatedExplicit: 1, rulesCreatedMined: 1, blocks: 2, advisories: 1, bypasses: 1, checksPass: 1, checksViolation: 1, acknowledgments: 1, promotions: 1, retired: 1 });
    expect(h.days).toHaveLength(14);
    const today = h.days.at(-1)!;
    const yday = h.days.at(-2)!;
    expect(today).toMatchObject({ day: '2026-11-17', correctionsMined: 1, rulesCreated: 1, rulesRetired: 1, advisories: 1, bypasses: 1, blocks: 0 });
    expect(yday).toMatchObject({ day: '2026-11-16', correctionsUser: 1, correctionsMined: 1, corrections: 2, rulesCreated: 1, blocks: 2, rulesPromoted: 1 });
    expect(h.top.blocking[0]).toMatchObject({ ruleId: 'new1', blocks: 2 });
    expect(h.top.recorrected[0]).toMatchObject({ ruleId: 'new1', count: 1 });
  });

  it('데이터가 없어도 깨지지 않고 0 으로 나온다, 화면 렌더도 된다', () => {
    const h = computeRuleHealth({ now: NOW, days: 7 });
    expect(h.schema).toBe('forgen-rule-health/v1');
    expect(h.rules.active.total).toBe(0);
    expect(h.days).toHaveLength(7);
    const text = renderRuleHealth(h).join('\n');
    expect(text).toContain('최근 7일');
    expect(text).toContain('검토 대기   0개');
  });

  it('세션 임시 룰은 생성·은퇴에 세지 않는다 (교정 1건 이중 계산 방지)', () => {
    writeRule('me1', { created_at: iso(1) });
    writeRule('sess1', { scope: 'session', created_at: iso(1), status: 'superseded', status_history: [{ at: iso(1), from: 'active', to: 'superseded', reason: 'promoted-to-me', by: 'promotion' }] });
    writeRule('sess2', { scope: 'session', created_at: iso(2), status: 'suppressed', status_history: [{ at: iso(1), from: 'active', to: 'suppressed', reason: 'session-ended', by: 'session-cleanup' }] });
    const h = computeRuleHealth({ now: NOW });
    expect(h.flow.rulesCreatedExplicit).toBe(1);
    expect(h.flow.retired).toBe(0);
    expect(h.days.reduce((n, d) => n + d.rulesCreated, 0)).toBe(1);
    expect(h.days.reduce((n, d) => n + d.rulesRetired, 0)).toBe(0);
  });

  it('보관함(rules-archive)으로 옮겨진 룰도 과거 생성·은퇴에 그대로 남는다 (값이 소급해 줄지 않음)', () => {
    writeRule('m1', { source: 'behavior_inference', created_at: iso(10), status: 'removed', status_history: [{ at: iso(5), from: 'active', to: 'removed', reason: 'auto-mined-cap', by: 'x' }] });
    const before = computeRuleHealth({ now: NOW });
    const arch = path.join(F, 'me', 'rules-archive');
    fs.mkdirSync(arch, { recursive: true });
    fs.renameSync(path.join(F, 'me', 'rules', 'm1.json'), path.join(arch, 'm1.json'));
    const after = computeRuleHealth({ now: NOW });
    expect(after.days).toEqual(before.days);
    expect(after.flow.rulesCreatedMined).toBe(1);
    expect(after.flow.retired).toBe(1);
    expect(after.rules.active.total).toBe(0);
  });

  it('병합으로 대체된 원본(clustered-into)은 은퇴로 세지 않는다', () => {
    writeRule('o1', { status: 'superseded', status_history: [{ at: iso(1), from: 'active', to: 'superseded', reason: 'clustered-into abc', by: 'cluster' }] });
    expect(computeRuleHealth({ now: NOW }).flow.retired).toBe(0);
  });

  it('현재 폴더의 프로젝트 룰은 세지 않는다 (실행 위치에 따라 숫자가 바뀌지 않게)', () => {
    writeRule('me1', { created_at: iso(1) });
    const proj = path.join(TEST_HOME, 'proj');
    fs.mkdirSync(path.join(proj, '.forgen', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.forgen', 'rules', 'p1.json'), JSON.stringify({ rule_id: 'p1', category: 'workflow', scope: 'me', trigger: 'p', policy: 'project rule text here', strength: 'default', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: 'w.p1', created_at: iso(1), updated_at: iso(1) }));
    const cwd = process.cwd();
    process.chdir(proj);
    try {
      const h = computeRuleHealth({ now: NOW });
      expect(h.rules.active.total).toBe(1);
      expect(h.flow.rulesCreatedExplicit).toBe(1);
    } finally { process.chdir(cwd); }
  });
});
