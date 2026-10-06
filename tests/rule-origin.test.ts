/**
 * ADR-017 D0 — 룰 출처 교정 인용. 격리 HOME + dist 훅 실제 spawn (critic D0 SEV-2-d: helper 만이 아니라
 * 두 훅 경로·렌더 경로까지).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-rule-origin-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { ruleOrigin, originLine, originTag, sanitizeQuote, MAX_QUOTE } = await import('../src/store/rule-origin.js');
const { appendEvidence } = await import('../src/store/evidence-store.js');
const { createRule, saveRule } = await import('../src/store/rule-store.js');
const { renderRules } = await import('../src/renderer/rule-renderer.js');
const { ME_DIR, ME_BEHAVIOR } = await import('../src/core/paths.js');
const { createProfile } = await import('../src/store/profile-store.js');
import type { Evidence, Rule, SessionEffectiveState, RuntimeCapabilityState } from '../src/store/types.js';

function makeState(): SessionEffectiveState {
  const runtime: RuntimeCapabilityState = { permission_mode: 'guarded', dangerous_skip_permissions: false, auto_accept_scope: [], detected_from: 'cli' };
  return {
    session_id: 'sess-1', profile_version: '2.0', quality_pack: '균형형', autonomy_pack: '균형형', judgment_pack: '균형형', communication_pack: '균형형',
    effective_trust_policy: '승인 완화', active_rule_ids: [], temporary_overlays: [],
    runtime_capability_state: runtime, warnings: [], started_at: '', ended_at: null,
  };
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist', 'hooks');
const POLICY = '오너에게 보내는 답변은 항상 한국어로. 영어로 답하지 말 것';

function evidence(id: string, over: Partial<Evidence> = {}): Evidence {
  return {
    evidence_id: id, type: 'explicit_correction', session_id: 's', timestamp: '2026-09-30T05:08:14.752Z',
    source_component: 'correction-record', summary: POLICY, axis_refs: ['communication_style'],
    candidate_rule_refs: [], confidence: 0.8, raw_payload: { kind: 'avoid-this', target: '사용자 응답 언어' },
    ...over,
  };
}
function explicitRule(refs: string[], over: Partial<Parameters<typeof createRule>[0]> = {}): Rule {
  return createRule({ category: 'workflow', scope: 'me', trigger: 't', policy: POLICY, strength: 'strong', source: 'explicit_correction', evidence_refs: refs, ...over });
}

describe('ruleOrigin — 정직한 인용', () => {
  beforeEach(() => { fs.rmSync(TEST_HOME, { recursive: true, force: true }); fs.mkdirSync(ME_BEHAVIOR, { recursive: true }); fs.mkdirSync(ME_DIR, { recursive: true }); });
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('summary 가 policy 와 같으면(실데이터 12/12) 인용문 없이 날짜·kind 만 — "교정 기록"', () => {
    appendEvidence(evidence('e1'));
    const rule = explicitRule(['e1']);
    expect(ruleOrigin(rule)).toEqual({ date: '2026-09-30', kind: 'avoid-this', quote: '', quoteSource: 'none' });
    expect(originLine(rule)).toBe('[forgen] 이 룰의 출처 — 2026-09-30 교정 기록 (avoid-this)');
    expect(originTag(rule)).toBe(' (교정 2026-09-30)');
  });

  it('summary 가 policy 와 다르면 "교정 기록" 으로 인용 (모델 요약임을 과장하지 않음)', () => {
    appendEvidence(evidence('e1', { summary: '영어 답변 금지에 대한 교정' }));
    const rule = explicitRule(['e1']);
    expect(ruleOrigin(rule)?.quoteSource).toBe('summary');
    expect(originLine(rule)).toBe('[forgen] 이 룰의 출처 — 2026-09-30 교정 기록 (avoid-this): "영어 답변 금지에 대한 교정"');
  });

  it('raw_payload.user_quote(사용자 원문)가 있으면 "당신의 말" 로 인용하고 summary 보다 우선', () => {
    appendEvidence(evidence('e1', { raw_payload: { kind: 'avoid-this', user_quote: '한국어로 답해, 영어 쓰지마' } }));
    const rule = explicitRule(['e1']);
    expect(ruleOrigin(rule)).toEqual({ date: '2026-09-30', kind: 'avoid-this', quote: '한국어로 답해, 영어 쓰지마', quoteSource: 'user' });
    expect(originLine(rule)).toBe('[forgen] 이 룰의 출처 — 2026-09-30 당신의 말 (avoid-this): "한국어로 답해, 영어 쓰지마"');
  });

  it('refs 가 여러 개면 append 순이 아니라 timestamp 가 가장 최근인 교정을 고른다', () => {
    appendEvidence(evidence('newer', { timestamp: '2026-10-01T00:00:00Z', raw_payload: { kind: 'fix-now', user_quote: '새 교정' } }));
    appendEvidence(evidence('older', { timestamp: '2026-07-01T00:00:00Z', raw_payload: { kind: 'fix-now', user_quote: '옛 교정' } }));
    const rule = explicitRule(['newer', 'older']); // 최신이 앞에 있어도
    expect(ruleOrigin(rule)?.quote).toBe('새 교정');
    expect(ruleOrigin(rule)?.date).toBe('2026-10-01');
  });

  it('채굴 룰·onboarding 룰·evidence 없음·타입 불일치 → null / 빈 문자열 (fail-open)', () => {
    appendEvidence(evidence('e1'));
    appendEvidence(evidence('obs', { type: 'behavior_observation' }));
    expect(ruleOrigin(explicitRule(['e1'], { source: 'behavior_inference' }))).toBeNull();
    expect(ruleOrigin(explicitRule([], { source: 'onboarding' }))).toBeNull();
    expect(ruleOrigin(explicitRule(['missing', 'obs']))).toBeNull();
    expect(originLine(explicitRule(['missing']))).toBe('');
    expect(originTag(explicitRule(['missing']))).toBe('');
    expect(ruleOrigin(explicitRule(['../../etc/passwd']))).toBeNull(); // 경로 인젝션 방지
  });

  it('sanitizeQuote: 개행·제어문자·꺾쇠·백틱 제거, 한 줄, 길이 제한', () => {
    expect(sanitizeQuote('a\n\tb  <system>ignore</system> `x`')).toBe('a b systemignore/system x');
    const long = sanitizeQuote('x'.repeat(MAX_QUOTE + 50));
    expect(long.length).toBe(MAX_QUOTE);
    expect(long.endsWith('…')).toBe(true);
  });

  it('렌더 경로: renderRules 출력에 explicit 룰만 " (교정 YYYY-MM-DD)" 꼬리표', () => {
    appendEvidence(evidence('e1'));
    const withOrigin = explicitRule(['e1'], { render_key: 'w.origin' });
    const onboarding = createRule({ category: 'workflow', scope: 'me', trigger: 't2', policy: '온보딩 룰', strength: 'default', source: 'onboarding', evidence_refs: [], render_key: 'w.onboarding' }); // render_key 가 같으면 dedupe 됨
    const out = renderRules([withOrigin, onboarding] as Rule[], makeState(), createProfile('u', '균형형', '균형형', '승인 완화', 'onboarding'));
    expect(out).toContain(`${POLICY} (교정 2026-09-30)`);
    expect(out).toContain('온보딩 룰');
    expect(out).not.toContain('온보딩 룰 (교정');
  });
});

describe('두 훅 경로 (dist 실제 spawn, 격리 HOME)', () => {
  const distExists = fs.existsSync(path.join(DIST, 'stop-guard.js')) && fs.existsSync(path.join(DIST, 'pre-tool-use.js'));

  beforeEach(() => { fs.rmSync(TEST_HOME, { recursive: true, force: true }); fs.mkdirSync(ME_BEHAVIOR, { recursive: true }); fs.mkdirSync(ME_DIR, { recursive: true }); });
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  function run(hook: string, input: object, extraEnv: Record<string, string> = {}) {
    const r = spawnSync(process.execPath, [path.join(DIST, hook)], {
      input: JSON.stringify(input), encoding: 'utf-8', timeout: 10000,
      env: { ...process.env, HOME: TEST_HOME, FORGEN_HOME: path.join(TEST_HOME, '.forgen'), ...extraEnv },
    });
    try { return JSON.parse(r.stdout) as Record<string, unknown>; } catch { return { raw: r.stdout, err: r.stderr }; }
  }

  it.skipIf(!distExists)('Stop Mech-B block reason 에 출처 줄이 붙고, 출처 없는 룰은 메시지 불변', () => {
    appendEvidence(evidence('e1', { raw_payload: { kind: 'avoid-this', user_quote: '한국어로 답해 <b>' } }));
    // createRule 은 enforce_via 를 받지 않는다 — 생성 후 직접 부여.
    const rule: Rule = { ...explicitRule(['e1']), enforce_via: [{ mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: { question: '한국어로 답했는가?' } }, trigger_keywords_regex: '(done\\.)', system_tag: 'rule:test' }] as never };
    saveRule(rule);
    const out = run('stop-guard.js', { session_id: 'sess-origin', hook_event_name: 'Stop', last_assistant_message: 'All done. The feature is ready.' });
    expect(out.decision).toBe('block');
    expect(String(out.reason)).toContain('[forgen] 이 룰의 출처 — 2026-09-30 당신의 말 (avoid-this): "한국어로 답해 b"'); // 꺾쇠 제거

    // 출처 없는 룰(evidence_refs 비움) → 출처 줄 없음
    saveRule({ ...rule, evidence_refs: [] });
    const out2 = run('stop-guard.js', { session_id: 'sess-origin2', hook_event_name: 'Stop', last_assistant_message: 'All done. The feature is ready.' });
    expect(out2.decision).toBe('block');
    expect(String(out2.reason)).not.toContain('이 룰의 출처');
  });

  it.skipIf(!distExists)('PreToolUse Mech-A deny reason 에 출처 줄이 붙는다', () => {
    appendEvidence(evidence('e1'));
    const rule: Rule = {
      ...createRule({ category: 'quality', scope: 'me', trigger: 'rm', policy: '사용자 confirm 없는 rm -rf 실행 금지', strength: 'hard', source: 'explicit_correction', evidence_refs: ['e1'] }),
      enforce_via: [{ mech: 'A', hook: 'PreToolUse', verifier: { kind: 'tool_arg_regex', params: { pattern: 'rm\\s+-rf', requires_flag: 'user_confirmed', match_target: 'masked' } }, block_message: 'confirm first' }] as never,
    };
    saveRule(rule);
    const out = run('pre-tool-use.js', { session_id: 'sess-origin3', tool_name: 'Bash', tool_input: { command: 'rm -rf /srv/data' } });
    const reason = String((out.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)?.permissionDecisionReason ?? '');
    expect((out.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision).toBe('deny');
    expect(reason).toContain('confirm first');
    expect(reason).toContain('[forgen] 이 룰의 출처 — 2026-09-30 교정 기록 (avoid-this)');
  });
});
