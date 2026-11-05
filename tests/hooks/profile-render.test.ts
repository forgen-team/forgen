/**
 * D12-F / R8: 프로필 4축 facet 이 실제 주입본(SessionStart)을 바꾼다 — 프로세스 테스트.
 * 이전에는 facet 을 전부 0 이나 1 로 바꿔도 렌더가 같았다(`include_pack_summary` 가 항상 false).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const HOOK = path.join(ROOT, 'dist', 'hooks', 'session-recovery.js');
const have = fs.existsSync(HOOK);
let root: string;

type Profile = { axes: Record<string, { facets: Record<string, number> }> };
const fixture = (): Profile => JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'forge-profile-neutral.json'), 'utf-8'));

function inject(name: string, profile: Profile | null): string {
  const home = path.join(root, name); const fh = path.join(home, '.forgen'); const work = path.join(root, `${name}-work`);
  fs.mkdirSync(path.join(fh, 'me'), { recursive: true }); fs.mkdirSync(work, { recursive: true });
  if (profile) fs.writeFileSync(path.join(fh, 'me', 'forge-profile.json'), JSON.stringify(profile));
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: `66666666-6666-4666-8666-${name.padEnd(12, '0').slice(0, 12)}`, cwd: work, source: 'startup' }),
    encoding: 'utf-8', timeout: 20000, cwd: work,
    env: { ...process.env, HOME: home, FORGEN_HOME: fh, FORGEN_CWD: work, FORGEN_NESTED_RUN: '', FORGEN_NO_BLOCK_JUDGE: '1', CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
  });
  expect(r.status).toBe(0);
  const lines = r.stdout.split('\n').filter((l) => l.trim());
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]).hookSpecificOutput?.additionalContext ?? '';
}

beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-prof-')); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!have)('프로필 facet → 주입본', () => {
  it('중간값(0.5) 프로필은 facet 규칙을 넣지 않는다', () => {
    expect(inject('neutral', fixture())).not.toContain('[profile]');
  });
  it('facet 을 극단값으로 바꾸면 주입본이 바뀐다', () => {
    const p = fixture();
    p.axes.quality_safety.facets.verification_depth = 0.95;
    p.axes.communication_style.facets.verbosity = 0.05;
    const hi = inject('extreme', p);
    expect(hi).toContain('[profile] 완료 선언 전 실행 로그');
    expect(hi).toContain('[profile] 코드 표시가 필요하지 않으면 답변은 3문장 이내');
    expect(hi).not.toBe(inject('neutral2', fixture()));
  });
  it('반대 극단은 반대 규칙을 낸다 (verbosity 0.95)', () => {
    const p = fixture(); p.axes.communication_style.facets.verbosity = 0.95;
    const out = inject('verbose', p);
    expect(out).toContain('결정 배경·대안·tradeoff');
    expect(out).not.toContain('3문장 이내');
  });
  it('임계값 경계: 0.85 는 발화, 0.84 는 아님', () => {
    const a = fixture(); a.axes.judgment_philosophy.facets.evidence_first_bias = 0.85;
    const b = fixture(); b.axes.judgment_philosophy.facets.evidence_first_bias = 0.84;
    expect(inject('edge-a', a)).toContain('근거(파일:라인, 로그, 측정값)를 먼저');
    expect(inject('edge-b', b)).not.toContain('근거(파일:라인, 로그, 측정값)를 먼저');
  });
  it('프로필이 없으면 facet 규칙을 생략하고 정상 동작 (null 안전)', () => {
    const out = inject('noprofile', null);
    expect(out).not.toContain('[profile]');
  });
});
