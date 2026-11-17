/**
 * D1 (docs/plans/2026-11-17-rule-quality-redesign.md): T5 기록만 + 재기록 방지 + T5 탓 flagged 정리.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({ TEST_HOME: `/tmp/forgen-test-t5h-${process.pid}` }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { createRule, saveRule, loadRule, loadAllRules } = await import('../src/store/rule-store.js');
const { detect } = await import('../src/engine/lifecycle/trigger-t5-conflict.js');
const { foldEvents } = await import('../src/engine/lifecycle/orchestrator.js');
const { filterNewT5Events, recentT5PairKeys, planT5Unflag, applyT5Unflag, lifecycleDir } = await import('../src/engine/lifecycle/t5-hygiene.js');

const LDIR = path.join(TEST_HOME, '.forgen', 'state', 'lifecycle');

function rule(policy: string, key: string, phase: 'active' | 'flagged' = 'active', conflict: string[] = []) {
  const r = createRule({ category: 'quality', scope: 'me', trigger: key, policy, strength: 'default', source: 'explicit_correction', render_key: `q.${key}` });
  const out = { ...r, lifecycle: { ...r.lifecycle!, phase, conflict_refs: conflict } };
  saveRule(out);
  return out;
}
function log(day: string, events: object[]) {
  fs.mkdirSync(LDIR, { recursive: true });
  fs.appendFileSync(path.join(LDIR, `${day}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe('T5 는 기록만 한다', () => {
  it('suggested_action 은 observe 이고, 접어도 phase·conflict_refs 가 바뀌지 않는다', () => {
    const a = rule('use vi.mock for external calls', 'mock');
    const b = rule('do not use vi.mock for external calls', 'nomock');
    const events = detect({ rules: [a, b] });
    expect(events.length).toBe(2);
    expect(events.every((e) => e.suggested_action === 'observe')).toBe(true);
    const folded = foldEvents([a, b], events, Date.now());
    for (const r of folded.values()) {
      expect(r.lifecycle?.phase).toBe('active');
      expect(r.lifecycle?.conflict_refs).toEqual([]);
    }
  });
});

describe('재기록 방지', () => {
  it('최근 7일 안에 기록된 쌍은 빼고, 그보다 오래된 기록은 무시한다', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    log('2026-11-15', [{ kind: 't5_conflict_detected', rule_id: 'a', evidence: { refs: ['b', 'a'] } }]);
    log('2026-11-01', [{ kind: 't5_conflict_detected', rule_id: 'c', evidence: { refs: ['c', 'd'] } }]);
    const recent = recentT5PairKeys(now);
    expect([...recent]).toEqual(['a|b']);
    const ev = (id: string, refs: string[]) => ({ kind: 't5_conflict_detected' as const, rule_id: id, evidence: { source: 'x', refs }, suggested_action: 'observe' as const, ts: now });
    const kept = filterNewT5Events([ev('a', ['a', 'b']), ev('c', ['c', 'd']), ev('c', ['c', 'd']), ev('d', ['c', 'd'])], recent);
    expect(kept.map((e) => e.rule_id)).toEqual(['c', 'd']);
  });
  it('T5 외 이벤트는 그대로 둔다', () => {
    const t2 = { kind: 't2_repeated_violation' as const, rule_id: 'a', suggested_action: 'flag' as const, ts: 0 };
    expect(filterNewT5Events([t2], new Set())).toEqual([t2]);
  });
});

describe('T5 탓 flagged 정리', () => {
  it('conflict_refs 가 있고 T1·T2·T3 기록이 없는 flagged 만 대상', () => {
    const onlyT5 = rule('rule one about deploy steps', 'one', 'flagged', ['x']);
    const byT1 = rule('rule two about review steps', 'two', 'flagged', ['y']);
    const byT2 = rule('rule three about tests', 'three', 'flagged', []);
    const fine = rule('rule four about naming', 'four', 'active', ['z']);
    log('2026-11-10', [
      { kind: 't5_conflict_detected', rule_id: onlyT5.rule_id, evidence: { refs: [onlyT5.rule_id, 'x'] } },
      { kind: 't1_explicit_correction', rule_id: byT1.rule_id },
      { kind: 't2_repeated_violation', rule_id: byT2.rule_id },
    ]);
    expect(planT5Unflag(loadAllRules()).map((r) => r.rule_id)).toEqual([onlyT5.rule_id]);
    expect(fine.lifecycle?.phase).toBe('active');
  });
  it('lifecycle 로그를 읽을 수 없으면 아무것도 되돌리지 않는다 (보수적)', () => {
    rule('rule one about deploy steps', 'one', 'flagged', ['x']);
    expect(fs.existsSync(lifecycleDir())).toBe(false);
    expect(planT5Unflag(loadAllRules())).toEqual([]);
  });
  it('적용하면 스냅샷을 만들고 phase 만 active 로, conflict_refs 는 남긴다', () => {
    const r = rule('rule one about deploy steps', 'one', 'flagged', ['x']);
    log('2026-11-10', [{ kind: 't5_conflict_detected', rule_id: r.rule_id, evidence: { refs: [r.rule_id, 'x'] } }]);
    const res = applyT5Unflag();
    expect(res.count).toBe(1);
    expect(res.snapshot).toBeTruthy();
    const after = loadRule(r.rule_id);
    expect(after?.lifecycle?.phase).toBe('active');
    expect(after?.lifecycle?.conflict_refs).toEqual(['x']);
    expect(fs.existsSync(path.join(TEST_HOME, '.forgen', 'backups', res.snapshot!))).toBe(true);
    // 두 번째 적용은 대상이 없다
    expect(applyT5Unflag().count).toBe(0);
  });
});
