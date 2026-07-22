import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-cluster-runner',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const RULES_DIR = path.join(TEST_HOME, '.forgen', 'me', 'rules');

function writeRule(id: string, category: string, policy: string, extra: Record<string, unknown> = {}): void {
  const now = new Date('2026-07-22T00:00:00Z').toISOString();
  const rule = {
    rule_id: id,
    category,
    scope: 'me',
    trigger: `trigger-${id}`,
    policy,
    strength: 'default',
    source: 'explicit_correction',
    status: 'active',
    evidence_refs: [`ev-${id}`],
    render_key: `${category}.${id}`,
    created_at: now,
    updated_at: now,
    ...extra,
  };
  fs.writeFileSync(path.join(RULES_DIR, `${id}.json`), JSON.stringify(rule, null, 2));
}

function readRule(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(RULES_DIR, `${id}.json`), 'utf-8'));
}

describe('correction-cluster-runner (W3-2 integration)', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(RULES_DIR, { recursive: true });
    vi.resetModules();
    process.env.FORGEN_DISABLE_PROJECT_RULES = '1';
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env.FORGEN_DISABLE_PROJECT_RULES;
  });

  it('merges a same-principle cluster: creates strong rule, supersedes originals with link', async () => {
    writeRule('a', 'quality', '완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인');
    writeRule('b', 'quality', '완료 선언 전 실제 검증 필수 라우트 존재만으로 완성 판단 금지');
    writeRule('c', 'quality', '실제 동작 검증 후에만 완료 선언 프로덕션 확인 필수');

    const { runCorrectionClustering } = await import('../src/engine/correction-cluster-runner.js');
    const merges = await runCorrectionClustering();

    expect(merges.length).toBe(1);
    expect(merges[0].memberIds.sort()).toEqual(['a', 'b', 'c']);
    expect(merges[0].strength).toBe('strong');
    expect(merges[0].confidence).toBeCloseTo(0.8, 2);

    // originals superseded + linked
    for (const id of ['a', 'b', 'c']) {
      const r = readRule(id);
      expect(r.status).toBe('superseded');
      expect(r.clustered_into).toBe(merges[0].mergedRuleId);
    }
    // merged rule exists, active, strong, evidence union
    const merged = readRule(merges[0].mergedRuleId);
    expect(merged.status).toBe('active');
    expect(merged.strength).toBe('strong');
    expect((merged.evidence_refs as string[]).sort()).toEqual(['ev-a', 'ev-b', 'ev-c']);
  });

  it('does not merge hard (safety) rules', async () => {
    writeRule('h1', 'safety', 'rm -rf 사용자 확인 없이 실행 금지 위험 명령 차단', { strength: 'hard' });
    writeRule('h2', 'safety', 'rm -rf 사용자 확인 없이 실행 금지 위험 명령 차단', { strength: 'hard' });
    const { runCorrectionClustering } = await import('../src/engine/correction-cluster-runner.js');
    expect((await runCorrectionClustering()).length).toBe(0);
    expect(readRule('h1').status).toBe('active');
  });

  it('unmerge restores originals to active, removes merged rule, suppresses re-merge', async () => {
    writeRule('a', 'quality', '완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인');
    writeRule('b', 'quality', '완료 선언 전 실제 검증 필수 라우트 존재만으로 완성 판단 금지');

    const { runCorrectionClustering, unmergeCluster } = await import('../src/engine/correction-cluster-runner.js');
    const merges = await runCorrectionClustering();
    expect(merges.length).toBe(1);
    const mergedId = merges[0].mergedRuleId;

    const res = unmergeCluster(mergedId);
    expect(res.ok).toBe(true);
    expect(res.restored.sort()).toEqual(['a', 'b']);

    // originals active again, link cleared
    for (const id of ['a', 'b']) {
      const r = readRule(id);
      expect(r.status).toBe('active');
      expect(r.clustered_into).toBeUndefined();
    }
    // merged rule removed
    expect(readRule(mergedId).status).toBe('removed');

    // re-running does NOT re-merge (suppressed)
    const merges2 = await runCorrectionClustering();
    expect(merges2.length).toBe(0);
  });

  it('SEV-3 #2: absorbs into existing merged rule instead of chaining (no M1→M2)', async () => {
    writeRule('a', 'quality', '완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인');
    writeRule('b', 'quality', '완료 선언 전 실제 검증 필수 라우트 존재만으로 완성 판단 금지');

    const { runCorrectionClustering } = await import('../src/engine/correction-cluster-runner.js');
    const first = await runCorrectionClustering();
    expect(first.length).toBe(1);
    const mergedId = first[0].mergedRuleId;

    // a new similar correction arrives in a later session
    writeRule('c', 'quality', '실제 동작 검증 후에만 완료 선언 프로덕션 확인 필수');
    const second = await runCorrectionClustering();

    // absorbed into the SAME merged rule — no new merged rule (no chain)
    expect(second.length).toBe(1);
    expect(second[0].mergedRuleId).toBe(mergedId);
    expect(second[0].memberIds).toEqual(['c']); // only the new member superseded this round

    // merged rule now covers all 3 evidence, still active, confidence reflects 3 observations
    const merged = readRule(mergedId);
    expect(merged.status).toBe('active');
    expect((merged.evidence_refs as string[]).sort()).toEqual(['ev-a', 'ev-b', 'ev-c']);
    expect(readRule('c').clustered_into).toBe(mergedId);

    // no orphan second merged rule: exactly one .cluster. rule exists
    const clusterRules = fs.readdirSync(RULES_DIR)
      .map((f) => JSON.parse(fs.readFileSync(path.join(RULES_DIR, f), 'utf-8')))
      .filter((r) => String(r.render_key).includes('.cluster.') && r.status === 'active');
    expect(clusterRules.length).toBe(1);
  });

  it('no-op when fewer than 2 candidates', async () => {
    writeRule('only', 'quality', '완료 선언 전 실제 검증 프로덕션 확인 필수');
    const { runCorrectionClustering } = await import('../src/engine/correction-cluster-runner.js');
    expect((await runCorrectionClustering()).length).toBe(0);
  });

  it('ignores non-correction sources (only explicit_correction clustered)', async () => {
    writeRule('a', 'quality', '완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인', { source: 'behavior_inference' });
    writeRule('b', 'quality', '완료 선언 전 실제 검증 필수 라우트 존재만으로 완성 판단 금지', { source: 'behavior_inference' });
    const { runCorrectionClustering } = await import('../src/engine/correction-cluster-runner.js');
    expect((await runCorrectionClustering()).length).toBe(0);
  });
});
