/**
 * TEST-5 / RC5: implicit-feedback category 필수화 + 마이그레이션.
 *
 * Regression: 2026-04-23 — implicit-feedback.jsonl 의 drift_critical/drift_warning/
 *   revert_detected/repeated_edit/agent_* 가 `type` 문자열만 가지고 category enum 없이
 *   섞여 저장되어 집계 시 문자열 매칭에 의존. 새 엔트리는 drift/revert 계열에 대해
 *   category 필드를 schema 강제하고, 레거시 로그 라인은 read/migrate 시 type→category
 *   백필로 보정.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-impl-fb-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const {
  appendImplicitFeedback,
  loadImplicitFeedback,
  migrateImplicitFeedbackLog,
  inferCategoryFromType,
} = await import('../src/store/implicit-feedback-store.js');

describe('implicit-feedback-store — TEST-5 category 스키마', () => {
  const logPath = path.join(TEST_HOME, '.forgen', 'state', 'implicit-feedback.jsonl');

  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('accepts drift_critical with explicit category=drift', async () => {

    const ok = appendImplicitFeedback({
      type: 'drift_critical',
      category: 'drift',
      at: new Date().toISOString(),
      sessionId: 'S1',
    });
    expect(ok).toBe(true);
    expect(fs.existsSync(logPath)).toBe(true);
    const raw = fs.readFileSync(logPath, 'utf-8').trim();
    const entry = JSON.parse(raw);
    expect(entry.category).toBe('drift');
  });

  it('auto-infers category=drift when type=drift_critical and category omitted', async () => {

    const ok = appendImplicitFeedback({
      type: 'drift_critical',
      at: new Date().toISOString(),
      sessionId: 'S1',
    });
    expect(ok).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
    expect(entry.category).toBe('drift');
  });

  it('rejects drift_critical with wrong category', async () => {

    const ok = appendImplicitFeedback({
      type: 'drift_critical',
      category: 'edit',
      at: new Date().toISOString(),
      sessionId: 'S1',
    });
    expect(ok).toBe(false);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('rejects revert_detected with wrong category', async () => {

    const ok = appendImplicitFeedback({
      type: 'revert_detected',
      category: 'drift',
      at: new Date().toISOString(),
      sessionId: 'S1',
    });
    expect(ok).toBe(false);
  });

  it('rejects entry with unknown type and no category', async () => {

    const ok = appendImplicitFeedback({
      type: 'mystery_signal',
      at: new Date().toISOString(),
      sessionId: 'S1',
    });
    expect(ok).toBe(false);
  });

  it('rejects entry missing required at/type', async () => {

    // @ts-expect-error missing at field on purpose
    expect(appendImplicitFeedback({ type: 'repeated_edit', sessionId: 'S1' })).toBe(false);
    // @ts-expect-error missing type field on purpose
    expect(appendImplicitFeedback({ at: new Date().toISOString(), sessionId: 'S1' })).toBe(false);
  });

  it('H4: accepts recommendation_surfaced with category=positive', async () => {

    const ok = appendImplicitFeedback({
      type: 'recommendation_surfaced',
      category: 'positive',
      solution: 'fake-solution',
      match_score: 0.42,
      at: new Date().toISOString(),
      sessionId: 'S1',
    });
    expect(ok).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
    expect(entry.category).toBe('positive');
    expect(entry.type).toBe('recommendation_surfaced');
  });

  it('H4: infers category=positive for recommendation_surfaced/recall_referenced', async () => {

    expect(inferCategoryFromType('recommendation_surfaced')).toBe('positive');
    expect(inferCategoryFromType('recall_referenced')).toBe('positive');
  });

  it('H4: rejects recommendation_surfaced with non-positive category', async () => {

    const ok = appendImplicitFeedback({
      type: 'recommendation_surfaced',
      category: 'agent',
      at: new Date().toISOString(),
      sessionId: 'S1',
    });
    expect(ok).toBe(false);
  });

  it('infers category=agent for agent_* types', async () => {

    const ok = appendImplicitFeedback({
      type: 'agent_unable',
      at: new Date().toISOString(),
      sessionId: 'S1',
    });
    expect(ok).toBe(true);
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf-8').trim());
    expect(entry.category).toBe('agent');
  });

  it('loadImplicitFeedback backfills category for legacy lines without touching disk', async () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const legacy = [
      { type: 'drift_critical', at: '2026-04-20T00:00:00Z', sessionId: 'S1', score: 80 },
      { type: 'revert_detected', at: '2026-04-20T00:01:00Z', sessionId: 'S1' },
      { type: 'repeated_edit', at: '2026-04-20T00:02:00Z', sessionId: 'S1', editCount: 6 },
      { type: 'nonsense_noise', at: '2026-04-20T00:03:00Z', sessionId: 'S1' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(logPath, legacy);


    const entries = loadImplicitFeedback('S1');
    expect(entries).toHaveLength(3); // nonsense dropped
    const byType = Object.fromEntries(entries.map((e) => [e.type, e.category]));
    expect(byType['drift_critical']).toBe('drift');
    expect(byType['revert_detected']).toBe('revert');
    expect(byType['repeated_edit']).toBe('edit');

    // 디스크 원본은 건드리지 않음 (lazy backfill)
    const onDisk = fs.readFileSync(logPath, 'utf-8');
    expect(onDisk).toBe(legacy);
  });

  it('migrateImplicitFeedbackLog rewrites file with backfilled categories', async () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const legacy = [
      { type: 'drift_critical', at: '2026-04-20T00:00:00Z', sessionId: 'S1', score: 80 },
      { type: 'agent_timeout', at: '2026-04-20T00:01:00Z', sessionId: 'S1' },
      { type: 'revert_detected', at: '2026-04-20T00:02:00Z', sessionId: 'S1', category: 'revert' },
      { type: 'nonsense_noise', at: '2026-04-20T00:03:00Z', sessionId: 'S1' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(logPath, legacy);


    const result = migrateImplicitFeedbackLog();
    expect(result.migrated).toBe(2); // drift_critical + agent_timeout
    expect(result.dropped).toBe(1); // nonsense_noise

    const after = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(after).toHaveLength(3);
    expect(after.find((e) => e.type === 'drift_critical').category).toBe('drift');
    expect(after.find((e) => e.type === 'agent_timeout').category).toBe('agent');
    expect(after.find((e) => e.type === 'revert_detected').category).toBe('revert');
  });
});
