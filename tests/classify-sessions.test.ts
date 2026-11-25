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

const { sessionCwd, planSessionScopes, evidenceProjectKey } = await import('../src/engine/rule-project-cli.js');
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

describe('evidenceProjectKey — 교정 시점 위치 (0.8.0 S4)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-tx-'));
  const keyOf = (c: string) => (c.startsWith('/w/') ? c.split('/')[2] : null);
  const line = (ts: string, cwd: string, file?: string) => JSON.stringify({ timestamp: ts, cwd, message: { content: file ? [{ type: 'tool_use', input: { file_path: file } }] : 'x' } });
  fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'proj', 'sx.jsonl'), [
    line('2026-11-01T00:00:00Z', '/home/u'),
    line('2026-11-01T01:00:00Z', '/w/alpha/src'),
    line('2026-11-01T02:00:00Z', '/home/u', '/w/beta/a.ts'),
    line('2026-11-01T02:01:00Z', '/home/u', '/w/beta/b.ts'),
    line('2026-11-01T02:02:00Z', '/home/u', '/w/gamma/c.ts'),
  ].join('\n'));
  const at = (ts: string, payload: Record<string, unknown> = {}) => evidenceProjectKey({ session_id: 'sx', timestamp: ts, raw_payload: payload }, { projectsDir: dir, keyOf });

  it('세션 첫 폴더(홈)가 아니라 교정 직전 폴더를 본다', () => expect(at('2026-11-01T01:30:00Z')).toBe('alpha'));
  it('직전 폴더가 홈이면 최근에 만진 파일의 프로젝트 중 과반', () => expect(at('2026-11-01T03:00:00Z')).toBe('beta'));
  it('기록보다 이른 교정은 모름', () => expect(at('2026-10-01T00:00:00Z')).toBeNull());
  it('0.8.0 근거의 origin.project 가 있으면 그것을 쓴다', () => expect(at('2026-11-01T00:30:00Z', { origin: { project: 'delta' } })).toBe('delta'));
  it('깨진 줄·cwd 없는 줄은 건너뛴다', () => {
    fs.appendFileSync(path.join(dir, 'proj', 'sx.jsonl'), '\n{not json\n{"timestamp":"2026-11-01T04:00:00Z"}\n');
    expect(at('2026-11-01T05:00:00Z')).toBe('beta');
  });
  it('origin.project 가 빈 문자열이면 기록으로 판정', () => expect(at('2026-11-01T01:30:00Z', { origin: { project: '' } })).toBe('alpha'));
  it('기록이 없는 세션은 모름', () => expect(evidenceProjectKey({ session_id: 'none', timestamp: 'z' }, { projectsDir: dir, keyOf })).toBeNull());
});
