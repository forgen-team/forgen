/**
 * 0.9.0 두 층 자격 게이트 재생 — `forgen audit tier2 --replay` (docs/plans/2026-11-25-v1.0-plan.md §8.1 ②).
 * 합성 대화 기록 2세션: 직전 턴의 도구 호출이 룰 낱말과 맞는 룰만 통과, 낱말이 교정 발화에만 있는 룰은 탈락.
 * 모든 파일은 임시 HOME·FORGEN_HOME 안. 픽스처 문장은 전부 합성이다.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-tier2-replay-')));
const home = path.join(root, 'home');
const fhome = path.join(home, '.forgen');
const claudeDir = path.join(home, '.claude');
for (const d of [path.join(fhome, 'me', 'rules'), path.join(fhome, 'state'), claudeDir]) fs.mkdirSync(d, { recursive: true });
const PREV = { HOME: process.env.HOME, FORGEN_HOME: process.env.FORGEN_HOME, FORGEN_CWD: process.env.FORGEN_CWD };
process.env.HOME = home;
process.env.FORGEN_HOME = fhome;
delete process.env.FORGEN_CWD;
const { runTier2Replay } = await import('../src/audit/tier2-replay.js');
import type { Rule, Evidence } from '../src/store/types.js';

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});

const OLD = '2026-08-01T00:00:00.000Z';
function rule(id: string, policy: string, extra: Partial<Rule> = {}): Rule {
  return { rule_id: id, category: 'workflow', scope: 'me', trigger: 't', policy, strength: 'default', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: `k.${id}`, created_at: OLD, updated_at: OLD, ...extra } as Rule;
}
const R_HARD = rule('hard1', '비밀 파일을 커밋하지 않는다', { strength: 'hard', category: 'safety' });
const R_STRONG = rule('strong1', '배포 전에 오너 승인을 받는다', { strength: 'strong' });
const R_T2A = rule('t2a', 'storybook 스냅샷은 chromatic 으로 비교하고 baseline 갱신은 따로 커밋한다');
const R_T2B = rule('t2b', 'terraform plan 결과를 apply 전에 보여 준다');

describe('자격 게이트 재생(대화 기록 합성)', () => {
  it('근거 교정 직전 3턴에서 발동한 룰만 통과, 교정 발화 자체는 보지 않는다', async () => {
    const proj = path.join(claudeDir, 'projects', '-ws');
    fs.mkdirSync(proj, { recursive: true });
    const line = (o: Record<string, unknown>) => JSON.stringify(o);
    const mk = (sid: string, turns: Array<{ user: string; tool?: { name: string; input: Record<string, unknown> } }>, corr: string, at: number) => {
      const out: string[] = [];
      let t = at;
      const ts = () => new Date(t += 60_000).toISOString();
      for (const x of turns) {
        out.push(line({ type: 'user', sessionId: sid, timestamp: ts(), message: { role: 'user', content: x.user } }));
        out.push(line({ type: 'assistant', sessionId: sid, timestamp: ts(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, ...(x.tool ? [{ type: 'tool_use', id: 'x', name: x.tool.name, input: x.tool.input }] : [])] } }));
      }
      const corrTs = ts();
      out.push(line({ type: 'user', sessionId: sid, timestamp: corrTs, message: { role: 'user', content: corr } }));
      fs.writeFileSync(path.join(proj, `${sid}.jsonl`), `${out.join('\n')}\n`);
      return new Date(Date.parse(corrTs) + 5000).toISOString();
    };
    const base = Date.parse('2026-08-10T00:00:00Z');
    const tA = mk('sa', [{ user: '디자인 점검 시작' }, { user: 'storybook 스냅샷 정리해 줘', tool: { name: 'Bash', input: { command: 'npx chromatic --baseline storybook-static' } } }], '그게 아니라 baseline 은 따로 커밋', base);
    const tB = mk('sb', [{ user: '인프라 정리' }, { user: '오늘 할 일 정리' }], 'terraform plan 결과를 apply 전에 보여 줘', base + 3_600_000);
    const ev = (id: string, sid: string, ts: string): Evidence => ({ evidence_id: id, type: 'explicit_correction', session_id: sid, timestamp: ts, source_component: 't', summary: 's', axis_refs: [], candidate_rule_refs: [], confidence: 1, raw_payload: {} });
    const rules = [{ ...R_T2A, evidence_refs: ['ea'] }, { ...R_T2B, evidence_refs: ['eb'] }, R_HARD, R_STRONG];
    const { result, index: idx } = await runTier2Replay({ claudeDir, rules, evidence: [ev('ea', 'sa', tA), ev('eb', 'sb', tB)], now: new Date('2026-11-26T00:00:00Z') });
    expect(result.tier1ByReason).toMatchObject({ hard: 1, strong: 1 });
    expect(result.candidates).toBe(2);
    // t2a: 직전 턴의 도구 호출 하나(사건 단위)가 룰 낱말과 3개 이상 겹침 → 통과. t2b: 낱말이 교정 발화에만 있음 → 떨어짐
    expect(idx.rules.t2a).toMatchObject({ qualified: true, reason: 'fired', contexts: 1, fired: 1 });
    expect(idx.rules.t2b).toMatchObject({ qualified: false, reason: 'missed' });
    expect(result.passRate).toBe(0.5);
    expect(result.notes.join(' ')).toContain('교정이 나온 경우만 잡는다');
  });
});

describe('감사 N3·누락이 두 층을 반영(세션 시작 몫 = 1층 + 색인)', () => {
  it('audit: 2층 룰은 세션 시작 토큰에서 빠지고 색인 줄만 더해진다 · Q11 누락 검사에서는 실린 것으로 본다', async () => {
    const { runAudit } = await import('../src/audit/run.js');
    const { measure } = await import('../src/audit/fix.js');
    const { words } = await import('../src/core/tier2.js');
    const folder = path.join(home, 'ws');
    fs.mkdirSync(folder, { recursive: true });
    for (const r of [R_HARD, R_STRONG, R_T2A, R_T2B]) fs.writeFileSync(path.join(fhome, 'me', 'rules', `${r.rule_id}.json`), JSON.stringify(r));
    const before = runAudit({ folders: [folder], claudeDir, sessionEvidence: false });
    const idx = { version: 1, generatedAt: OLD, params: { k: 3, turns: 3, minFireRate: 0.8, maxFreq: 0.05 }, rules: { t2a: { qualified: true, reason: 'fired', words: [...words(R_T2A.policy)], topics: ['storybook'], contexts: 1, fired: 1 } }, recur: {} };
    const idxPath = path.join(fhome, 'state', 'tier2-index.json');
    fs.writeFileSync(idxPath, JSON.stringify(idx));
    try {
      const after = runAudit({ folders: [folder], claudeDir, sessionEvidence: false });
      const b = before.result.folders[0];
      const a = after.result.folders[0];
      expect(b.forgenTier2).toBeUndefined();
      expect(a.forgenTier2?.rules).toBe(1);
      expect(a.forgenRules).toBe(b.forgenRules - 1);
      // 세션 시작 몫 = 1층 + 색인 줄: 빠진 룰 한 줄 대신 색인 줄(룰이 적은 합성 데이터라 색인 줄이 더 길 수 있다)
      const { estimateTokens } = await import('../src/audit/tokens.js');
      const { tier2IndexLine } = await import('../src/renderer/rule-renderer.js');
      const line = estimateTokens(`\n\n${tier2IndexLine([R_T2A], new Map([['t2a', ['storybook']]]))}`);
      expect((a.byLayer['forgen-render'] ?? 0) - (b.byLayer['forgen-render'] ?? 0)).toBeLessThanOrEqual(line - 1);
      const m = measure(after);
      expect(m.folders[0].loaded).toContain('rule:t2a');
      expect(after.ctx.loadedIn.get('t2a:0')).toBeUndefined();
    } finally { fs.rmSync(idxPath, { force: true }); }
  });
});
