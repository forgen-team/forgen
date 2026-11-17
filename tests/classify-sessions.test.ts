/**
 * D6-3 (docs/plans/2026-11-17-rule-quality-redesign.md): 범위 없는 학습 룰을 근거 세션의 작업 폴더로 범위 제안.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-classify-sessions-'));
process.env.FORGEN_HOME = TMP_HOME;
process.env.FORGEN_DISABLE_PROJECT_RULES = '1';

const { sessionCwd, planSessionScopes } = await import('../src/engine/rule-project-cli.js');
const { createRule, saveRule } = await import('../src/store/rule-store.js');
const { createEvidence, saveEvidence } = await import('../src/store/evidence-store.js');

beforeEach(() => fs.rmSync(path.join(TMP_HOME, 'me'), { recursive: true, force: true }));

function ev(sid: string): string {
  const e = createEvidence({ type: 'explicit_correction', session_id: sid, source_component: 't', summary: 'some correction text here', confidence: 1 });
  saveEvidence(e);
  return e.evidence_id;
}
function rule(id: string, refs: string[], o: Record<string, unknown> = {}) {
  const r = createRule({ category: 'workflow', scope: 'me', trigger: id, policy: `policy ${id}`, strength: 'default', source: 'explicit_correction', render_key: `w.${id}`, evidence_refs: refs });
  saveRule({ ...r, rule_id: id, ...o } as typeof r);
}

describe('sessionCwd', () => {
  it('대화 기록 앞부분의 cwd 를 읽고, 없으면 null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-cc-projects-'));
    fs.mkdirSync(path.join(dir, '-work-a'));
    fs.writeFileSync(path.join(dir, '-work-a', 'sid1.jsonl'), '{"type":"mode"}\n{"type":"user","cwd":"/work/a\\"b","sessionId":"sid1"}\n');
    expect(sessionCwd('sid1', dir)).toBe('/work/a"b');
    expect(sessionCwd('nope', dir)).toBeNull();
    expect(sessionCwd('../x', dir)).toBeNull();
  });
});

describe('planSessionScopes', () => {
  const cwds: Record<string, string | null> = { s1: '/w/alpha', s2: '/w/alpha', s3: '/w/beta', h: '/home/u' };
  const keyOf = (c: string) => (c.startsWith('/w/') ? path.basename(c) : null);
  const plan = () => planSessionScopes({ cwdOf: (s) => cwds[s] ?? null, keyOf });

  it('근거 세션이 모두 프로젝트 안이면 합집합 제안, 하나라도 홈·기록 없음이면 제안 안 함', () => {
    rule('one', [ev('s1'), ev('s2')]);
    rule('two', [ev('s1'), ev('s3')]);
    rule('home', [ev('s1'), ev('h')]);
    rule('lost', [ev('s1'), ev('zz')]);
    const got = Object.fromEntries(plan().map((p) => [p.rule.rule_id, p.projects]));
    expect(got).toEqual({ one: ['alpha'], two: ['alpha', 'beta'] });
  });

  it('이미 범위가 있거나 hard·비활성·온보딩 룰은 대상 아님', () => {
    rule('scoped', [ev('s1')], { projects: ['x'] });
    rule('hard', [ev('s1')], { strength: 'hard' });
    rule('off', [ev('s1')], { status: 'suppressed' });
    rule('onb', [ev('s1')], { source: 'onboarding' });
    rule('cand', [ev('s3')], { status: 'candidate', source: 'behavior_inference', render_key: 'auto:w.c' });
    expect(plan().map((p) => p.rule.rule_id)).toEqual(['cand']);
  });
});
