/**
 * compound-rule-upsert — 결함 1 회귀 테스트 (ADR-013 채굴 룰 재생성 결함).
 *
 * RCA: promoteSessionCandidates 가 render_key 를 "현재 active 여부"로만 dedup 하고,
 * 승급에 쓰인 evidence 를 소비 마킹하지 않아 TTL/cap 로 rule 이 은퇴되면 같은(또는 반복된)
 * evidence 가 매번 새 rule_id 로 재생성됐다 (실측: 6,701개 rule 파일 중 6,525개가
 * status:'removed' 로 방치). 이 테스트는 그 3가지 축을 개별 검증한다:
 *   (A) render_key upsert — status 무관 기존 rule 조회 → 재활성화, rule_id/created_at 보존.
 *   (B) evidence consumed — 같은 evidence 재처리는 no-op, 새 evidence(진짜 반복 교정)는
 *       correction-clustering.ts 의 Laplace confidence 로 strength 를 끌어올린다.
 *   (C) 동일 render_key 로 수렴하는 반복 호출이 중복 rule 파일을 만들지 않는다.
 *   (D) pruneRemovedRules — retention 기간 지난 removed 파일만 실제 삭제(기본 dry-run).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── FORGEN_HOME 격리 — src import 전에 반드시 설정 (paths.ts 가 모듈 로드 시점에 읽음) ──
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-rule-upsert-test-'));
process.env.FORGEN_HOME = TMP_HOME;
process.env.FORGEN_DISABLE_PROJECT_RULES = '1';

const { createEvidence, saveEvidence, promoteSessionCandidates } = await import('../src/store/evidence-store.js');
const { loadRule, loadAllRules, updateRuleStatus, findRuleByRenderKey, pruneRemovedRules } =
  await import('../src/store/rule-store.js');
const { laplaceConfidence, strengthForConfidence } = await import('../src/engine/correction-clustering.js');

const ME_RULES = path.join(TMP_HOME, 'me', 'rules');

/** explicit_correction evidence 를 만들어 저장하고, 승급 후보로 잡히도록 payload 를 채운다. */
function correction(sessionId: string, opts: {
  target: string;
  kind?: 'prefer-from-now' | 'avoid-this';
  autoMined?: boolean;
}) {
  const ev = createEvidence({
    type: 'explicit_correction',
    session_id: sessionId,
    source_component: 'test',
    summary: `테스트 교정: ${opts.target} 에 대한 재사용 가능한 정책 문구`,
    confidence: opts.autoMined ? 0.55 : 0.8,
    raw_payload: {
      kind: opts.kind ?? 'prefer-from-now',
      target: opts.target,
      axis_hint: null,
      auto_mined: opts.autoMined === true,
    },
  });
  saveEvidence(ev);
  return ev;
}

function ruleFilesCount(): number {
  if (!fs.existsSync(ME_RULES)) return 0;
  return fs.readdirSync(ME_RULES).filter((f) => f.endsWith('.json')).length;
}

beforeEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  fs.mkdirSync(TMP_HOME, { recursive: true });
});

describe('promoteSessionCandidates — render_key upsert (A)', () => {
  it('은퇴된(removed) render_key 재채굴 시 SAME rule_id 재사용, created_at 보존, 새 파일 없음', () => {
    const ev1 = correction('sess-A1', { target: 'always-write-tests-first', autoMined: true });
    expect(promoteSessionCandidates('sess-A1')).toBe(1);

    const rule1 = findRuleByRenderKey('auto:workflow.always-write-tests-first', 'behavior_inference');
    expect(rule1).not.toBeNull();
    const originalId = rule1!.rule_id;
    const originalCreatedAt = rule1!.created_at;

    // TTL/cap 은퇴 시뮬레이션 (retireStaleAutoMinedRules 가 하는 것과 동일한 status 전이)
    updateRuleStatus(originalId, 'removed');
    const filesBeforeReMine = ruleFilesCount();

    // 같은 개념이 다른 세션(=새 evidence_id)에서 재차 채굴됨
    const ev2 = correction('sess-A2', { target: 'always-write-tests-first', autoMined: true });
    expect(promoteSessionCandidates('sess-A2')).toBe(1);

    expect(ruleFilesCount()).toBe(filesBeforeReMine); // 새 rule 파일 생성 없음 — 재활성화만

    const reactivated = loadRule(originalId);
    expect(reactivated).not.toBeNull();
    expect(reactivated!.rule_id).toBe(originalId);
    expect(reactivated!.created_at).toBe(originalCreatedAt); // TTL carry-forward (리셋 금지)
    expect(reactivated!.status).toBe('active');
    expect(reactivated!.evidence_refs).toEqual(expect.arrayContaining([ev1.evidence_id, ev2.evidence_id]));
  });

  it('active 상태에서도(은퇴 없이) 다른 세션의 반복 교정은 새 rule 을 만들지 않고 병합된다', () => {
    correction('sess-B1', { target: 'no-mock-in-prod-code' });
    expect(promoteSessionCandidates('sess-B1')).toBe(1);
    const filesAfterFirst = ruleFilesCount();

    correction('sess-B2', { target: 'no-mock-in-prod-code' });
    expect(promoteSessionCandidates('sess-B2')).toBe(1);

    expect(ruleFilesCount()).toBe(filesAfterFirst);
    const rule = findRuleByRenderKey('workflow.no-mock-in-prod-code', 'explicit_correction')!;
    expect(rule.evidence_refs).toHaveLength(2);
  });

  it('레거시 중복 데이터(같은 render_key 여러 rule 파일)는 active 우선, 그다음 최신 updated_at 을 고른다', () => {
    // upsert 도입 이전에 만들어졌을 법한 데이터를 직접 시뮬레이션 — createRule()로 만들면
    // rule_id 가 겹치지 않으므로 파일 2개가 안전하게 공존한다.
    fs.mkdirSync(ME_RULES, { recursive: true });
    const stale = {
      rule_id: 'legacy-stale', category: 'workflow', scope: 'me', trigger: 't',
      policy: 'p', strength: 'default', source: 'explicit_correction', status: 'removed',
      evidence_refs: [], render_key: 'workflow.legacy-dup',
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    };
    const fresherRemoved = {
      ...stale, rule_id: 'legacy-fresher-removed',
      updated_at: '2026-02-01T00:00:00.000Z',
    };
    const activeOne = {
      ...stale, rule_id: 'legacy-active', status: 'active',
      updated_at: '2026-01-15T00:00:00.000Z',
    };
    for (const r of [stale, fresherRemoved, activeOne]) {
      fs.writeFileSync(path.join(ME_RULES, `${r.rule_id}.json`), JSON.stringify(r, null, 2));
    }

    // active 상태가 하나라도 있으면 updated_at 과 무관하게 그것을 우선한다.
    const found = findRuleByRenderKey('workflow.legacy-dup', 'explicit_correction', 'me');
    expect(found?.rule_id).toBe('legacy-active');

    // active 후보가 아예 없으면 updated_at 최신순 tie-break 로 넘어간다.
    const removedOnlyStale = { ...stale, rule_id: 'removed-only-a', render_key: 'workflow.legacy-dup-2', updated_at: '2026-01-01T00:00:00.000Z' };
    const removedOnlyFresh = { ...stale, rule_id: 'removed-only-b', render_key: 'workflow.legacy-dup-2', updated_at: '2026-03-01T00:00:00.000Z' };
    for (const r of [removedOnlyStale, removedOnlyFresh]) {
      fs.writeFileSync(path.join(ME_RULES, `${r.rule_id}.json`), JSON.stringify(r, null, 2));
    }
    const tieBroken = findRuleByRenderKey('workflow.legacy-dup-2', 'explicit_correction', 'me');
    expect(tieBroken?.rule_id).toBe('removed-only-b');
  });
});

describe('promoteSessionCandidates — evidence consumed (B)', () => {
  it('같은 evidence 를 같은 세션에서 재처리해도 evidence_refs 중복/재승급 없음 (sweep replay 억제)', () => {
    correction('sess-C1', { target: 'confirm-before-rm-rf' });
    expect(promoteSessionCandidates('sess-C1')).toBe(1);

    // 재-sweep 시뮬레이션: 같은 세션에 대해 promoteSessionCandidates 재호출.
    // loadPromotionCandidates() 는 evidence 를 영구 반환하므로 실제로 발생 가능한 경로.
    expect(promoteSessionCandidates('sess-C1')).toBe(0);

    const rule = findRuleByRenderKey('workflow.confirm-before-rm-rf', 'explicit_correction')!;
    expect(rule.evidence_refs).toHaveLength(1);
  });

  it('진짜 반복 교정(새 evidence)은 Laplace confidence 로 strength 를 끌어올린다', () => {
    correction('sess-D1', { target: 'ask-before-destructive-git', kind: 'prefer-from-now' });
    promoteSessionCandidates('sess-D1');
    const afterFirst = findRuleByRenderKey('workflow.ask-before-destructive-git', 'explicit_correction')!;
    expect(afterFirst.strength).toBe('default'); // N=1 → laplace=(1+1)/(1+2)=0.5(창건) < 0.75

    correction('sess-D2', { target: 'ask-before-destructive-git', kind: 'prefer-from-now' });
    promoteSessionCandidates('sess-D2');
    const afterSecond = findRuleByRenderKey('workflow.ask-before-destructive-git', 'explicit_correction')!;
    expect(afterSecond.rule_id).toBe(afterFirst.rule_id);
    expect(afterSecond.evidence_refs).toHaveLength(2);
    expect(strengthForConfidence(laplaceConfidence(2))).toBe('strong'); // (2+1)/(2+2)=0.75
    expect(afterSecond.strength).toBe('strong');
  });

  it('auto_mined 은 반복 확인돼도 strong 으로 승급하지 않는다 (ADR-013 advisory-only 불변식)', () => {
    for (let i = 0; i < 4; i++) {
      correction(`sess-E${i}`, { target: 'stop-guessing-verify-first', autoMined: true });
      promoteSessionCandidates(`sess-E${i}`);
    }
    const rule = findRuleByRenderKey('auto:workflow.stop-guessing-verify-first', 'behavior_inference')!;
    expect(rule.evidence_refs.length).toBeGreaterThanOrEqual(4);
    expect(rule.strength).toBe('default');
    expect(rule.enforce_via).toEqual([]); // Mech-A/B 차단 절대 획득 안 함
  });
});

describe('promoteSessionCandidates — 반복 호출이 중복 rule 을 만들지 않음 (C, race 시뮬레이션)', () => {
  it('동일 render_key 로 향하는 3개 세션을 연속 호출해도 rule 파일은 1개만 존재', () => {
    for (let i = 0; i < 3; i++) {
      correction(`sess-F${i}`, { target: 'always-ask-before-force-push', autoMined: true });
      promoteSessionCandidates(`sess-F${i}`);
    }
    const matching = loadAllRules().filter((r) => r.render_key === 'auto:workflow.always-ask-before-force-push');
    expect(matching).toHaveLength(1);
    expect(matching[0].evidence_refs).toHaveLength(3);
  });
});

describe('pruneRemovedRules (D)', () => {
  function writeRuleFile(id: string, status: 'active' | 'removed', updatedAtIso: string) {
    fs.mkdirSync(ME_RULES, { recursive: true });
    const rule = {
      rule_id: id,
      category: 'workflow',
      scope: 'me',
      trigger: id,
      policy: `policy for ${id}`,
      strength: 'default',
      source: 'behavior_inference',
      status,
      evidence_refs: [],
      render_key: `auto:workflow.${id}`,
      created_at: updatedAtIso,
      updated_at: updatedAtIso,
    };
    fs.writeFileSync(path.join(ME_RULES, `${id}.json`), JSON.stringify(rule, null, 2));
  }

  it('dry-run: retention 지난 removed 파일도 삭제하지 않고 candidates 로만 보고', () => {
    const old = new Date(Date.now() - 10 * 24 * 3600_000).toISOString(); // 10일 전
    const recent = new Date(Date.now() - 1 * 24 * 3600_000).toISOString(); // 1일 전
    writeRuleFile('old-removed', 'removed', old);
    writeRuleFile('recent-removed', 'removed', recent);
    writeRuleFile('old-active', 'active', old);

    const r = pruneRemovedRules({ retentionMs: 7 * 24 * 3600_000 });
    expect(r.candidates).toEqual(['old-removed']);
    expect(r.deleted).toEqual([]);
    expect(fs.existsSync(path.join(ME_RULES, 'old-removed.json'))).toBe(true);
  });

  it('apply: retention 지난 removed 파일만 실제 unlink', () => {
    const old = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 1 * 24 * 3600_000).toISOString();
    writeRuleFile('old-removed', 'removed', old);
    writeRuleFile('recent-removed', 'removed', recent);
    writeRuleFile('old-active', 'active', old);

    const r = pruneRemovedRules({ retentionMs: 7 * 24 * 3600_000, apply: true });
    expect(r.deleted).toEqual(['old-removed']);
    expect(fs.existsSync(path.join(ME_RULES, 'old-removed.json'))).toBe(false);
    expect(fs.existsSync(path.join(ME_RULES, 'recent-removed.json'))).toBe(true);
    expect(fs.existsSync(path.join(ME_RULES, 'old-active.json'))).toBe(true);
  });

  it('removed 파일이 없으면 candidates/deleted 모두 빈 배열', () => {
    const r = pruneRemovedRules({ apply: true });
    expect(r.candidates).toEqual([]);
    expect(r.deleted).toEqual([]);
  });

  it('.json 이 아닌 파일(예: lock 파일)은 무시한다', () => {
    fs.mkdirSync(ME_RULES, { recursive: true });
    fs.writeFileSync(path.join(ME_RULES, '.rule-store-mutate.lock'), '{}');
    const old = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
    writeRuleFile('old-removed', 'removed', old);

    const r = pruneRemovedRules({ retentionMs: 7 * 24 * 3600_000, apply: true });
    expect(r.candidates).toEqual(['old-removed']);
    expect(fs.existsSync(path.join(ME_RULES, '.rule-store-mutate.lock'))).toBe(true);
  });
});
