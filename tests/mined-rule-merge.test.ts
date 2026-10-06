/**
 * ADR-017 D3 — 채굴 룰 병합 (채굴끼리만 · explicit 과는 링크만).
 *
 *  (a) 채굴 3개 유사 → 1개 통합: strength 'default', created_at 최솟값, auto: 유지, advisory-only
 *  (b) 채굴 1 + explicit 1 유사 → 채굴 superseded+clustered_into=explicit, explicit 의
 *      evidence_refs/strength 불변, mined_observations=1
 *  (c) 사전 중복 검사: 같은 개념 evidence 는 새 채굴 룰을 만들지 않는다(채굴 → evidence 추가,
 *      explicit → mined_observations+1)
 *  (d) unmerge 왕복: 채굴 통합 룰 / explicit 링크 타깃 양쪽
 *  (e) 캡(30) 계산에서 superseded 원본 제외
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-mined-merge-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const RULES_DIR = path.join(TEST_HOME, '.forgen', 'me', 'rules');

type RuleJson = Record<string, unknown>;

function writeRule(
  id: string,
  opts: {
    category?: string;
    policy: string;
    source?: 'behavior_inference' | 'explicit_correction';
    createdAt?: string;
    strength?: string;
    evidence?: string[];
    status?: string;
    extra?: RuleJson;
  },
): void {
  const source = opts.source ?? 'behavior_inference';
  const category = opts.category ?? 'workflow';
  const createdAt = opts.createdAt ?? '2026-10-01T00:00:00.000Z';
  const rule: RuleJson = {
    rule_id: id,
    category,
    scope: 'me',
    trigger: `trigger-${id}`,
    policy: opts.policy,
    strength: opts.strength ?? 'default',
    source,
    status: opts.status ?? 'active',
    evidence_refs: opts.evidence ?? [`ev-${id}`],
    render_key: source === 'behavior_inference' ? `auto:${category}.${id}` : `${category}.${id}`,
    created_at: createdAt,
    updated_at: createdAt,
    ...(source === 'behavior_inference' ? { enforce_via: [] } : {}),
    ...(opts.extra ?? {}),
  };
  fs.writeFileSync(path.join(RULES_DIR, `${id}.json`), JSON.stringify(rule, null, 2));
}

function readRule(id: string): RuleJson {
  return JSON.parse(fs.readFileSync(path.join(RULES_DIR, `${id}.json`), 'utf-8'));
}

function allRules(): RuleJson[] {
  return fs
    .readdirSync(RULES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(RULES_DIR, f), 'utf-8')));
}

const FABLE_A = '설계 단계에서는 고차 모델(Fable)을 에이전트로 조기 투입하여 blind spot을 발견하고 구현 전 방향을 재정렬하라';
const FABLE_B = '아키텍처 설계 단계에서는 Fable 같은 상위 모델을 에이전트로 투입하여 blind spot을 조기에 발견하고 구현 전 방향을 재정렬하라';
const FABLE_C = '설계 단계에서는 반드시 Fable(상위 모델)을 미리 투입하여 blind spot을 조기에 발견하고, 구현 전 방향을 재정렬하라';
const PARALLEL_EXPLICIT = '병렬 에이전트 사용 금지 규칙을 폐지함. 앞으로 병렬 에이전트를 스폰해도 되고, 반드시 팀(Team)으로만 진행할 필요 없음.';
const PARALLEL_MINED = '병렬 에이전트 사용 금지 규칙은 이미 폐지됨. 앞으로 병렬 에이전트를 자유롭게 스폰해도 되고, 팀(Team) 방식으로만 진행할 필요 없다.';
const UNRELATED = 'KRX 종목 코드 벌크 다운로드는 EUC-KR 디코딩 필수이며 HTTPS URL 만 사용한다';

describe('ADR-017 D3 — mined rule merge', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(RULES_DIR, { recursive: true });
    vi.resetModules();
    process.env.FORGEN_DISABLE_PROJECT_RULES = '1';
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env.FORGEN_DISABLE_PROJECT_RULES;
  });

  it('(a) 채굴 3개 유사 → 1개 통합: strength default · created_at 최솟값 · auto: 유지 · advisory-only', async () => {
    writeRule('m1', { policy: FABLE_A, createdAt: '2026-10-03T00:00:00.000Z' });
    writeRule('m2', { policy: FABLE_B, createdAt: '2026-09-20T00:00:00.000Z' }); // 가장 오래됨
    writeRule('m3', { policy: FABLE_C, createdAt: '2026-10-05T00:00:00.000Z' });
    writeRule('m4', { policy: UNRELATED }); // 무관 — 그대로 남아야 함

    const { runMinedRuleMerge } = await import('../src/engine/correction-cluster-runner.js');

    // dry-run 은 파일을 건드리지 않는다
    const dry = await runMinedRuleMerge({ apply: false });
    expect(dry.applied).toBeNull();
    expect(dry.plan.totalMined).toBe(4);
    expect(dry.plan.clusters.length).toBe(1);
    expect(dry.plan.clusters[0].memberIds.sort()).toEqual(['m1', 'm2', 'm3']);
    expect(dry.plan.clusters[0].oldestCreatedAt).toBe('2026-09-20T00:00:00.000Z');
    expect(dry.plan.projectedMined).toBe(2); // m4 + 통합 룰
    expect(allRules().length).toBe(4);
    for (const id of ['m1', 'm2', 'm3']) expect(readRule(id).status).toBe('active');

    const { applied } = await runMinedRuleMerge({ apply: true });
    expect(applied?.mergedRuleIds.length).toBe(1);
    expect(applied?.supersededIds.sort()).toEqual(['m1', 'm2', 'm3']);

    const mergedId = applied?.mergedRuleIds[0] as string;
    const merged = readRule(mergedId);
    expect(merged.status).toBe('active');
    expect(merged.source).toBe('behavior_inference');
    expect(merged.strength).toBe('default'); // N=3 이면 explicit 경로는 strong — 채굴은 default 고정
    expect(merged.created_at).toBe('2026-09-20T00:00:00.000Z'); // TTL carry-forward
    expect(String(merged.render_key).startsWith('auto:')).toBe(true);
    expect(String(merged.render_key)).toContain('.cluster.');
    expect(merged.enforce_via).toEqual([]);
    expect((merged.evidence_refs as string[]).sort()).toEqual(['ev-m1', 'ev-m2', 'ev-m3']);

    for (const id of ['m1', 'm2', 'm3']) {
      const r = readRule(id);
      expect(r.status).toBe('superseded');
      expect(r.clustered_into).toBe(mergedId);
    }
    expect(readRule('m4').status).toBe('active');

    // 재실행은 no-op
    const again = await runMinedRuleMerge({ apply: true });
    expect(again.plan.clusters.length).toBe(0);
    expect(again.plan.explicitLinks.length).toBe(0);
    expect(again.plan.totalMined).toBe(2);
  });

  it('(b) 채굴 1 + explicit 1 유사 → 링크만: explicit evidence_refs/strength 불변, mined_observations=1', async () => {
    writeRule('e1', { source: 'explicit_correction', category: 'autonomy', policy: PARALLEL_EXPLICIT, evidence: ['ev-e1'] });
    writeRule('m1', { category: 'workflow', policy: PARALLEL_MINED }); // category 가 달라도 링크

    const { runMinedRuleMerge } = await import('../src/engine/correction-cluster-runner.js');
    const { plan, applied } = await runMinedRuleMerge({ apply: true });

    expect(plan.explicitLinks.length).toBe(1);
    expect(plan.explicitLinks[0]).toMatchObject({ minedRuleId: 'm1', explicitRuleId: 'e1', observations: 1 });
    expect(plan.clusters.length).toBe(0);
    expect(applied?.linked).toBe(1);
    expect(applied?.mergedRuleIds).toEqual([]);

    const m1 = readRule('m1');
    expect(m1.status).toBe('superseded');
    expect(m1.clustered_into).toBe('e1');
    expect(m1.related_to).toEqual(['e1']);

    const e1 = readRule('e1');
    expect(e1.status).toBe('active');
    expect(e1.strength).toBe('default'); // 흡수였다면 N=2 → strong 으로 올라갔을 것
    expect(e1.evidence_refs).toEqual(['ev-e1']); // 합산 금지
    expect(e1.mined_observations).toBe(1);
    expect(e1.related_to).toEqual(['m1']);
  });

  it('(c) 사전 중복 검사: 같은 개념의 채굴 evidence 는 새 룰을 만들지 않는다', async () => {
    writeRule('m1', { policy: FABLE_A, evidence: ['ev-m1'] });
    writeRule('e1', { source: 'explicit_correction', category: 'autonomy', policy: PARALLEL_EXPLICIT, evidence: ['ev-e1'] });

    const { createEvidence, saveEvidence, promoteSessionCandidates } = await import('../src/store/evidence-store.js');

    const mine = (sessionId: string, target: string, summary: string) => {
      const ev = createEvidence({
        type: 'explicit_correction',
        session_id: sessionId,
        source_component: 'test',
        summary,
        confidence: 0.55,
        raw_payload: { kind: 'prefer-from-now', target, axis_hint: 'workflow', auto_mined: true },
      });
      saveEvidence(ev);
      return ev;
    };

    // (c-1) 채굴 룰과 같은 개념 → m1 의 evidence_refs 에 추가, 새 파일 없음, strength default
    const ev1 = mine('s1', 'fable-design-agent-first', FABLE_C);
    expect(promoteSessionCandidates('s1')).toBe(1);
    expect(allRules().length).toBe(2);
    const m1 = readRule('m1');
    expect(m1.evidence_refs).toEqual(['ev-m1', ev1.evidence_id]);
    expect(m1.strength).toBe('default');

    // (c-2) explicit 룰과 같은 개념 → 새 룰 없음, explicit evidence_refs 불변, mined_observations+1
    mine('s2', 'parallel-agents-allowed', PARALLEL_MINED);
    expect(promoteSessionCandidates('s2')).toBe(0); // 승격 아님(링크 카운트만)
    expect(allRules().length).toBe(2);
    const e1 = readRule('e1');
    expect(e1.evidence_refs).toEqual(['ev-e1']);
    expect(e1.strength).toBe('default');
    expect(e1.mined_observations).toBe(1);

    // 같은 evidence 재-sweep 은 no-op (소비 마킹)
    expect(promoteSessionCandidates('s2')).toBe(0);
    expect(readRule('e1').mined_observations).toBe(1);

    // (c-3) 어느 쪽과도 다른 개념 → 기존대로 새 채굴 룰 생성
    mine('s3', 'krx-bulk-download', UNRELATED);
    expect(promoteSessionCandidates('s3')).toBe(1);
    expect(allRules().length).toBe(3);
  });

  it('(d) unmerge 왕복 — 채굴 통합 룰: 원본 복원 + 통합 룰 removed + 재통합 억제', async () => {
    writeRule('m1', { policy: FABLE_A });
    writeRule('m2', { policy: FABLE_B });

    const { runMinedRuleMerge, unmergeCluster } = await import('../src/engine/correction-cluster-runner.js');
    const { applied } = await runMinedRuleMerge({ apply: true });
    const mergedId = applied?.mergedRuleIds[0] as string;
    expect(mergedId).toBeTruthy();

    const res = unmergeCluster(mergedId);
    expect(res.ok).toBe(true);
    expect(res.restored.sort()).toEqual(['m1', 'm2']);
    for (const id of ['m1', 'm2']) {
      const r = readRule(id);
      expect(r.status).toBe('active');
      expect(r.clustered_into).toBeUndefined();
    }
    expect(readRule(mergedId).status).toBe('removed');

    const again = await runMinedRuleMerge({ apply: false });
    expect(again.plan.clusters.length).toBe(0);
    expect(again.plan.totalMined).toBe(2);
  });

  it('(d) unmerge 왕복 — explicit 링크 타깃: 채굴 복원, explicit 은 removed 되지 않고 카운터만 차감, 재링크 억제', async () => {
    writeRule('e1', { source: 'explicit_correction', category: 'autonomy', policy: PARALLEL_EXPLICIT, evidence: ['ev-e1'] });
    writeRule('m1', { policy: PARALLEL_MINED, evidence: ['ev-m1-a', 'ev-m1-b'] });

    const { runMinedRuleMerge, unmergeCluster } = await import('../src/engine/correction-cluster-runner.js');
    await runMinedRuleMerge({ apply: true });
    expect(readRule('e1').mined_observations).toBe(2);
    expect(readRule('m1').status).toBe('superseded');

    const res = unmergeCluster('e1');
    expect(res.ok).toBe(true);
    expect(res.restored).toEqual(['m1']);

    const m1 = readRule('m1');
    expect(m1.status).toBe('active');
    expect(m1.clustered_into).toBeUndefined();
    expect(m1.related_to).toBeUndefined();

    const e1 = readRule('e1');
    expect(e1.status).toBe('active'); // 링크 타깃은 삭제 금지
    expect(e1.strength).toBe('default');
    expect(e1.evidence_refs).toEqual(['ev-e1']);
    expect(e1.mined_observations).toBeUndefined();
    expect(e1.related_to).toBeUndefined();

    // 재링크 안 됨(억제)
    const again = await runMinedRuleMerge({ apply: false });
    expect(again.plan.explicitLinks.length).toBe(0);
    expect(readRule('m1').status).toBe('active');
  });

  it('(e) 캡(30) 계산에서 superseded 원본은 제외된다', async () => {
    // 시계 고정 — 모든 fixture 가 TTL(21일) 미만이 되도록. 은퇴는 오직 캡으로만 일어나야 한다.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T00:00:00.000Z'));
    // active 채굴 29개(모두 서로 무관한 policy 가 아니어도 됨 — retire 는 유사도를 보지 않음)
    for (let i = 0; i < 29; i++) {
      writeRule(`a${i}`, { policy: `${UNRELATED} 변형 ${i}`, createdAt: `2026-10-0${(i % 5) + 1}T00:00:00.000Z` });
    }
    // superseded 원본 5개 — 캡 계산에 포함됐다면 34 > 30 이라 4개가 은퇴됐을 것(created_at 은
    // TTL 초과 날짜로 두어, 포함됐다면 TTL 로도 removed 가 됐을 것임을 함께 증명)
    for (let i = 0; i < 5; i++) {
      writeRule(`s${i}`, {
        policy: `${FABLE_A} ${i}`,
        createdAt: '2026-09-01T00:00:00.000Z',
        status: 'superseded',
        extra: { clustered_into: 'merged-x' },
      });
    }

    const { promoteSessionCandidates } = await import('../src/store/evidence-store.js');
    // 후보 없는 세션이어도 retireStaleAutoMinedRules 는 early-return 앞에서 실행된다
    expect(promoteSessionCandidates('no-such-session')).toBe(0);

    const active = allRules().filter((r) => r.status === 'active' && r.source === 'behavior_inference');
    expect(active.length).toBe(29); // 아무것도 은퇴되지 않음
    for (let i = 0; i < 5; i++) expect(readRule(`s${i}`).status).toBe('superseded');

    // 대조: active 가 31이면 가장 오래된 1개가 은퇴한다(캡 자체는 살아 있음)
    writeRule('a29', { policy: `${UNRELATED} 변형 29`, createdAt: '2026-10-05T00:00:00.000Z' });
    writeRule('a30', { policy: `${UNRELATED} 변형 30`, createdAt: '2026-09-20T00:00:00.000Z' }); // 가장 오래됨(16일, TTL 미만)
    promoteSessionCandidates('no-such-session');
    const activeAfter = allRules().filter((r) => r.status === 'active' && r.source === 'behavior_inference');
    expect(activeAfter.length).toBe(30);
    expect(readRule('a30').status).toBe('removed');
    vi.useRealTimers();
  });

  it('CLI 렌더: "채굴 N → M (병합 K, explicit 링크 L)" 과 클러스터 멤버·대표 policy 출력', async () => {
    writeRule('e1', { source: 'explicit_correction', category: 'autonomy', policy: PARALLEL_EXPLICIT });
    writeRule('m0', { policy: PARALLEL_MINED });
    writeRule('m1', { policy: FABLE_A });
    writeRule('m2', { policy: FABLE_B });

    const { runMinedRuleMerge } = await import('../src/engine/correction-cluster-runner.js');
    const { renderMinedMergePlan } = await import('../src/engine/mined-rule-merge-cli.js');
    const { plan } = await runMinedRuleMerge({ apply: false });
    const out = renderMinedMergePlan(plan);

    expect(out).toContain('채굴 3 → 1 (병합 2, explicit 링크 1)');
    expect(out).toContain('[explicit 링크 1]');
    expect(out).toContain('[클러스터 1] workflow · 멤버 2');
    expect(out).toContain('- m1 ');
    expect(out).toContain('- m2 ');
    expect(out).toContain('대표:');
  });
});
