/** 룰 보존 불변식: 사유 없는 비활성화 거부, 세션별 정리, 복구, 스냅샷. 실제 파일 시스템으로 검증한다. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({ TEST_HOME: `${process.env.TMPDIR ?? '/tmp'}/forgen-rule-preserve-${process.pid}` }));
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => TEST_HOME }));

const { createRule, saveRule, loadRule, updateRuleStatus, cleanupStaleSessionRules, pruneRemovedRules, RuleTransitionError } =
  await import('../src/store/rule-store.js');
const { withStatusChange } = await import('../src/store/rule-lifecycle.js');
const { reviveRule, createSnapshot, restoreSnapshot } = await import('../src/engine/rule-recovery-cli.js');

const make = (over: Partial<ReturnType<typeof createRule>> = {}) => ({
  ...createRule({ category: 'workflow', scope: 'me', trigger: 't', policy: '답변은 한국어로', strength: 'strong', source: 'explicit_correction', render_key: 'workflow.lang' }),
  ...over,
});

beforeEach(() => fs.mkdirSync(path.join(TEST_HOME, '.forgen', 'me', 'rules'), { recursive: true }));
afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe('사유 없는 비활성화 거부', () => {
  it('활성 룰을 사유 없이 저장하면 거부하고 파일은 그대로', () => {
    const r = make();
    saveRule(r);
    expect(() => saveRule({ ...r, status: 'removed' })).toThrow(RuleTransitionError);
    expect(loadRule(r.rule_id)?.status).toBe('active');
  });

  it('이전 전이의 사유를 재사용할 수 없다', () => {
    const r = make();
    saveRule(r);
    saveRule(withStatusChange(r, 'suppressed', 'first', 'test'));
    const again = loadRule(r.rule_id);
    if (!again) throw new Error('missing');
    saveRule(withStatusChange(again, 'active', 'back', 'test'));
    const active = loadRule(r.rule_id);
    if (!active) throw new Error('missing');
    expect(() => saveRule({ ...active, status: 'removed' })).toThrow(RuleTransitionError);
  });

  it('오래된 룰 객체로 정당한 전이를 해도 오탐하지 않는다', () => {
    const r = make();
    saveRule(r);
    const stale = loadRule(r.rule_id);
    if (!stale) throw new Error('missing');
    updateRuleStatus(r.rule_id, 'suppressed', 'first', 'test');
    updateRuleStatus(r.rule_id, 'active', 'back', 'test');
    expect(() => saveRule(withStatusChange(stale, 'removed', 'second', 'test'))).not.toThrow();
  });

  it('사유가 있으면 저장되고 기록이 남는다', () => {
    const r = make();
    saveRule(r);
    expect(updateRuleStatus(r.rule_id, 'removed', 'auto-mined-ttl', 'test')).toBe(true);
    expect(loadRule(r.rule_id)?.status_history?.at(-1)).toMatchObject({ from: 'active', to: 'removed', reason: 'auto-mined-ttl' });
  });
});

describe('세션 임시 룰 정리', () => {
  it('실행 중일 수 있는 다른 세션의 룰은 유예 시간 동안 유지하고, 지나면 사유와 함께 정리', () => {
    const own = make({ scope: 'session', session_id: 'me' });
    const other = make({ scope: 'session', session_id: 'other' });
    const legacy = make({ scope: 'session' });
    saveRule(own); saveRule(other); saveRule(legacy);
    expect(cleanupStaleSessionRules('me')).toBe(1);
    expect(loadRule(own.rule_id)?.status).toBe('active');
    expect(loadRule(other.rule_id)?.status).toBe('active');
    expect(loadRule(legacy.rule_id)?.status_history?.at(-1)?.reason).toBe('session-ended');
    expect(cleanupStaleSessionRules('me', Date.now() + 13 * 3600_000)).toBe(1);
    expect(loadRule(other.rule_id)?.status).toBe('suppressed');
  });
});

describe('복구', () => {
  it('세션 suppressed 룰을 영구 룰로 되살린다', () => {
    const r = make({ scope: 'session', session_id: 'old' });
    saveRule(r);
    cleanupStaleSessionRules('new', Date.now() + 13 * 3600_000);
    const revived = reviveRule(r.rule_id.slice(0, 8), 'user: revive');
    expect(revived).toMatchObject({ status: 'active', scope: 'me', strength: 'strong' });
    expect(loadRule(r.rule_id)?.status).toBe('active');
  });

  it('보관소로 간 룰도 되살리고 보관본은 지운다', () => {
    const r = make({ source: 'behavior_inference' });
    saveRule(r);
    updateRuleStatus(r.rule_id, 'removed', 'auto-mined-ttl', 'test');
    expect(pruneRemovedRules({ retentionMs: -1, apply: true }).deleted).toEqual([r.rule_id]);
    expect(loadRule(r.rule_id)).toBeNull();
    reviveRule(r.rule_id, 'user: revive');
    expect(loadRule(r.rule_id)).toMatchObject({ status: 'active', source: 'explicit_correction' });
    expect(fs.existsSync(path.join(TEST_HOME, '.forgen', 'me', 'rules-archive', `${r.rule_id}.json`))).toBe(false);
  });

  it('없는 룰과 모호한 접두어는 에러', () => {
    expect(() => reviveRule('nope', 'x')).toThrow(/no rule/);
  });

  it('되살릴 때 게이트를 지우지 않는다 (낡은 게이트는 평가 때 건너뛴다)', () => {
    const base = createRule({ category: 'workflow', scope: 'me', trigger: 't', policy: '프로덕션 환경을 먼저 확인', strength: 'default', source: 'explicit_correction', render_key: 'w.gate' });
    saveRule({ ...base, rule_id: 'stale-gate', status: 'suppressed', enforce_via: [{ mech: 'A', hook: 'Stop', verifier: { kind: 'artifact_check', params: { path: '.forgen/state/e2e-result.json' } } }] } as never);
    expect(reviveRule('stale-gate', 'x').enforce_via).toHaveLength(1);
    saveRule(make({ rule_id: 'aa-1' })); saveRule(make({ rule_id: 'aa-2' }));
    expect(() => reviveRule('aa', 'x')).toThrow(/ambiguous/);
  });
});

describe('스냅샷', () => {
  it('되돌리면 이후 변경이 사라지고, 직전 상태도 스냅샷으로 남는다', () => {
    const r = make();
    saveRule(r);
    const snap = createSnapshot('test');
    updateRuleStatus(r.rule_id, 'removed', 'x', 'test');
    const later = make({ rule_id: 'later' });
    saveRule(later);
    const { safety } = restoreSnapshot(snap);
    expect(loadRule(r.rule_id)?.status).toBe('active');
    expect(loadRule('later')).toBeNull();
    expect(fs.existsSync(path.join(TEST_HOME, '.forgen', 'backups', safety, 'rules', 'later.json'))).toBe(true);
  });

  it('스냅샷에 없는 폴더는 지우지 않는다', () => {
    const snap = createSnapshot('test');
    const dir = path.join(TEST_HOME, '.forgen', 'backups', snap);
    fs.rmSync(path.join(dir, 'behavior'), { recursive: true, force: true });
    const behavior = path.join(TEST_HOME, '.forgen', 'me', 'behavior');
    fs.mkdirSync(behavior, { recursive: true });
    fs.writeFileSync(path.join(behavior, 'keep.json'), '{}');
    restoreSnapshot(snap);
    expect(fs.existsSync(path.join(behavior, 'keep.json'))).toBe(true);
  });

  it('경로 탈출 이름 거부', () => {
    expect(() => restoreSnapshot('../../etc')).toThrow(/invalid/);
  });
});
