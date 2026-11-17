/**
 * T5 integration: appendRule detects conflicts with existing rules and records a lifecycle event.
 * 2026-11 D1: T5 는 기록만 — conflict_refs 는 룰 파일에 쓰지 않는다(판정이 오탐 위주).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-t5-${process.pid}`,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { createRule, saveRule, appendRule, loadRule } = await import('../src/store/rule-store.js');

describe('T5 integration (appendRule)', () => {
  beforeEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('two conflicting rules → conflicts_with 로 알리되 룰 파일의 conflict_refs·phase 는 그대로', async () => {
    const a = createRule({
      category: 'quality', scope: 'me',
      trigger: 'async-pref',
      policy: 'use async/await for database calls',
      strength: 'default', source: 'explicit_correction',
      render_key: 'q.async-pref',
    });
    saveRule(a);

    const b = createRule({
      category: 'quality', scope: 'me',
      trigger: 'sync-pref',
      policy: 'do not use async/await for database calls',
      strength: 'strong', source: 'explicit_correction',
      render_key: 'q.sync-pref',
    });
    const result = await appendRule(b);
    expect(result.saved).toBe(true);
    expect(result.conflicts_with).toContain(a.rule_id);

    const aAfter = loadRule(a.rule_id);
    const bAfter = loadRule(b.rule_id);
    expect(aAfter?.lifecycle?.conflict_refs).toEqual([]);
    expect(bAfter?.lifecycle?.conflict_refs).toEqual([]);
    expect(aAfter?.lifecycle?.phase).toBe('active');
    expect(bAfter?.lifecycle?.phase).toBe('active');
  });

  it('non-conflicting rules → no conflicts recorded', async () => {
    const a = createRule({
      category: 'quality', scope: 'me',
      trigger: 'async',
      policy: 'use async/await',
      strength: 'default', source: 'explicit_correction',
      render_key: 'q.async',
    });
    saveRule(a);

    const b = createRule({
      category: 'workflow', scope: 'me',
      trigger: 'early-return',
      policy: 'prefer early-return over nested if',
      strength: 'default', source: 'explicit_correction',
      render_key: 'w.early-return',
    });
    const result = await appendRule(b);
    expect(result.conflicts_with).toHaveLength(0);

    const aAfter = loadRule(a.rule_id);
    // v0.4.1: saveRule lifecycle 자동 초기화 → phase='active' 기본값.
    expect(aAfter?.lifecycle?.phase).toBe('active');
    expect(aAfter?.lifecycle?.conflict_refs).toEqual([]);
  });

  it('lifecycle event written to daily jsonl', async () => {
    const a = createRule({
      category: 'quality', scope: 'me',
      trigger: 'mock-usage',
      policy: 'use vi.mock for external calls',
      strength: 'default', source: 'explicit_correction',
      render_key: 'q.mock-usage',
    });
    saveRule(a);
    const b = createRule({
      category: 'quality', scope: 'me',
      trigger: 'no-mock',
      policy: 'do not use vi.mock for external calls',
      strength: 'strong', source: 'explicit_correction',
      render_key: 'q.no-mock',
    });
    await appendRule(b);

    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(TEST_HOME, '.forgen', 'state', 'lifecycle', `${today}.jsonl`);
    expect(fs.existsSync(logPath)).toBe(true);
    const content = fs.readFileSync(logPath, 'utf-8').trim();
    expect(content).toContain('t5_conflict_detected');
  });

  it('같은 쌍은 7일 안에 다시 기록하지 않는다', async () => {
    const a = createRule({ category: 'quality', scope: 'me', trigger: 'mock-usage', policy: 'use vi.mock for external calls', strength: 'default', source: 'explicit_correction', render_key: 'q.mock-usage' });
    saveRule(a);
    const b = createRule({ category: 'quality', scope: 'me', trigger: 'no-mock', policy: 'do not use vi.mock for external calls', strength: 'strong', source: 'explicit_correction', render_key: 'q.no-mock' });
    await appendRule(b);
    await appendRule(b);
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(TEST_HOME, '.forgen', 'state', 'lifecycle', `${today}.jsonl`);
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter((l) => l.includes('t5_conflict_detected'));
    expect(lines).toHaveLength(2); // 쌍 하나 × 양쪽 룰 1건씩, 두 번째 호출은 기록 없음
  });
});
