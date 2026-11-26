/**
 * N3 기준값을 0.9.0 이전 형식(압축 전)으로 고정 — 0.9.0 을 설치한 직후 처음 처방하거나 감사해도 압축 몫이 N3 에 보여야 한다.
 * 모든 파일은 임시 HOME·FORGEN_HOME 안. 문장은 합성.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-n3legacy-')));
const HOME = path.join(ROOT, 'home');
const FH = path.join(HOME, '.forgen');
const CLAUDE = path.join(HOME, '.claude');
const FOLDER = path.join(HOME, 'ws', 'proj-n');
for (const d of [CLAUDE, path.join(FOLDER, '.git'), path.join(FH, 'me', 'rules'), path.join(FH, 'state')]) fs.mkdirSync(d, { recursive: true });
const PREV = { HOME: process.env.HOME, FORGEN_HOME: process.env.FORGEN_HOME, FORGEN_CWD: process.env.FORGEN_CWD };
process.env.HOME = HOME;
process.env.FORGEN_HOME = FH;
delete process.env.FORGEN_CWD;
afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const OLD = '2026-08-01T00:00:00.000Z';
for (let i = 0; i < 12; i++) {
  fs.writeFileSync(path.join(FH, 'me', 'rules', `n${i}.json`), JSON.stringify({
    rule_id: `n${i}`, category: i % 2 ? 'quality' : 'workflow', scope: 'me', trigger: 't', policy: `합성 작업 규칙 ${i}: 변경 전에 관련 테스트를 먼저 돌려 결과를 확인한다`,
    strength: i === 0 ? 'strong' : 'default', source: 'onboarding', status: 'active', evidence_refs: [], render_key: `k.n${i}`, created_at: OLD, updated_at: OLD,
  }));
}
const { handleFix } = await import('../src/audit/fix-cli.js');
const { handleAudit } = await import('../src/audit/cli.js');
const { baselinePath } = await import('../src/audit/fix.js');
const capture = async (fn: () => Promise<void>) => {
  const out: string[] = [];
  const log = console.log;
  console.log = (...x: unknown[]) => { out.push(x.join(' ')); };
  try { await fn(); } finally { console.log = log; }
  return out.join('\n');
};

describe('N3 기준값 = 0.9.0 이전 형식(압축 전)', () => {
  it('0.9.0 설치 직후 첫 감사가 기준값을 남기고(압축 전 토큰 함께), 처방 없이도 report 가 압축 몫을 보인다', async () => {
    await capture(() => handleAudit(['--folder', FOLDER, '--claude-dir', CLAUDE, '--no-model', '--no-open']));
    const base = JSON.parse(fs.readFileSync(baselinePath(), 'utf-8')) as { folders: Array<{ tokens: number; legacyTokens?: number }> };
    expect(base.folders[0].legacyTokens).toBeGreaterThan(base.folders[0].tokens);
    const rep = JSON.parse(await capture(() => handleFix(['--report', '--json', '--folder', FOLDER, '--claude-dir', CLAUDE, '--no-model']))) as { folders: Array<{ before: number; after: number; pct: number; legacyBase: boolean }> };
    const f = rep.folders[0];
    expect(f.legacyBase).toBe(true);
    expect(f.before).toBe(base.folders[0].legacyTokens);
    expect(f.after).toBe(base.folders[0].tokens);
    expect(f.pct).toBeLessThan(-5); // 처방 0개 — 줄어든 몫은 전부 압축
    // 몫 나누기: 압축(형식) 몫 + 처방·두 층 몫 = N3. 처방 0개라 처방 몫은 0
    const g = f as unknown as { formatPct: number; fixPct: number };
    expect(g.formatPct).toBe(f.pct);
    expect(g.fixPct).toBe(0);
    const text = await capture(() => handleFix(['--report', '--folder', FOLDER, '--claude-dir', CLAUDE, '--no-model']));
    expect(text).toContain('0.9.0 이전 형식(압축 전)으로 센 값');
    expect(text).toMatch(/압축 -\d+(\.\d)?% · 처방·두 층 0%/);
    const { n3EdgeWarning } = await import('../src/audit/fix-cli.js');
    expect(n3EdgeWarning(-15.4)).toContain('목표 경계');
    expect(n3EdgeWarning(-16)).toContain('목표 경계');
    expect(n3EdgeWarning(-14.9)).toBeNull();
    expect(n3EdgeWarning(-16.1)).toBeNull();
  });
});
