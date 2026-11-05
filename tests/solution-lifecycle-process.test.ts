/**
 * D5·D6 프로세스 검증: 빌드된 CLI(`forgen compound ...`)와 hook 을 격리 FORGEN_HOME 에서 실제로 실행한다. 대역 없음.
 * 은퇴 사유·복귀, ROI 격리 해제, 프로젝트 범위(hook ↔ MCP 경로 일치), 게이트 탈락 사유 기록.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DIST = path.resolve(__dirname, '..', 'dist');
let root: string, home: string, forgen: string, work: string;
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, FORGEN_HOME: forgen, FORGEN_SYNTHETIC: '1', FORGEN_CWD: work, FORGEN_NO_BLOCK_JUDGE: '1', ...extra });
const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(DIST, 'cli.js'), ...args], { encoding: 'utf-8', cwd: work, env: env(), timeout: 60_000 });
const hook = (cwd: string, prompt: string, sid: string) =>
  spawnSync(process.execPath, [path.join(DIST, 'hooks', 'solution-injector.js')], { input: JSON.stringify({ session_id: sid, prompt, cwd, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf-8', cwd, env: env({ FORGEN_CWD: cwd }), timeout: 60_000 });
const injected = (stdout: string): string[] => {
  try { return [...(JSON.parse(stdout.trim().split('\n')[0]).hookSpecificOutput?.additionalContext ?? '').matchAll(/^- ([^\s:[\]]+)/gm)].map((m) => m[1]); } catch { return []; }
};
const solPath = (name: string) => path.join(forgen, 'me', 'solutions', `${name}.md`);
function fm(name: string): Record<string, any> {
  const raw = fs.readFileSync(solPath(name), 'utf-8');
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  const o: Record<string, any> = { evidence: {} };
  let inEv = false;
  for (const l of (m?.[1] ?? '').split('\n')) {
    if (/^evidence:/.test(l)) { inEv = true; continue; }
    const k = l.match(/^(\s*)([A-Za-z]+):\s*(.*)$/);
    if (!k) continue;
    const v = k[3].replace(/^"|"$/g, '');
    if (inEv && k[1]) o.evidence[k[2]] = Number(v); else { inEv = false; o[k[2]] = v; }
  }
  return o;
}
function write(name: string, o: { status?: string; confidence?: number; created?: string; negative?: number; injected?: number; tags?: string[]; projects?: string[]; extra?: string } = {}) {
  const md = ['---', `name: ${name}`, 'version: 1', `status: ${o.status ?? 'candidate'}`, `confidence: ${o.confidence ?? 0.55}`, 'type: pattern', 'scope: me',
    'tags:', ...(o.tags ?? ['alpha', 'beta']).map((t) => `  - ${JSON.stringify(t)}`), 'identifiers: []',
    ...(o.projects ? ['projects:', ...o.projects.map((p) => `  - ${p}`)] : []),
    'evidence:', `  injected: ${o.injected ?? 0}`, '  reflected: 0', `  negative: ${o.negative ?? 0}`, '  sessions: 0', '  reExtracted: 0',
    `created: ${o.created ?? '2026-11-01'}`, `updated: ${o.created ?? '2026-11-01'}`, 'supersedes: null', 'extractedBy: manual', ...(o.extra ? [o.extra] : []), '---', '', '## Context', '', '', '## Content',
    '이런 상황에서는 이렇게 한다. 근거와 주의를 포함한 충분히 긴 본문입니다.', ''].join('\n');
  fs.writeFileSync(solPath(name), md);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-life-'));
  home = path.join(root, 'home'); forgen = path.join(home, '.forgen'); work = path.join(root, 'work');
  fs.mkdirSync(path.join(forgen, 'me', 'solutions'), { recursive: true }); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(forgen, 'forge-profile.json'), '{}');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('D6 은퇴 사유와 복귀', () => {
  it('stale 은 confidence 를 보존하고 contradicted 만 0 으로 만든다. 사용자가 끈 것은 manual', () => {
    write('old-stale', { created: '2026-04-01' });
    write('bad-contra', { negative: 3 });
    write('manual-one');
    write('fresh-ok');
    expect(cli('compound', 'deactivate', 'manual-one').stdout).toContain('Deactivated');
    cli('compound', '--lifecycle', '--apply');
    expect(fm('old-stale')).toMatchObject({ status: 'retired', retiredReason: 'stale', confidence: '0.55' });
    expect(fm('bad-contra')).toMatchObject({ status: 'retired', retiredReason: 'contradicted', confidence: '0' });
    expect(fm('manual-one')).toMatchObject({ status: 'retired', retiredReason: 'manual', confidence: '0.55' });
    expect(fm('fresh-ok').status).toBe('candidate');
  }, 120_000);

  it('reopen: 후보로 돌아오고 다음 수명주기에서 바로 다시 은퇴하지 않는다 (contradicted 는 negative 초기화)', () => {
    write('old-stale', { created: '2026-04-01' });
    write('bad-contra', { negative: 3 });
    cli('compound', '--lifecycle', '--apply');
    expect(cli('compound', 'reopen', 'old-stale').stdout).toContain('Reopened');
    expect(cli('compound', 'reopen', 'bad-contra').stdout).toContain('Reopened');
    const s = fm('old-stale'); const c = fm('bad-contra');
    expect(s).toMatchObject({ status: 'candidate', confidence: '0.55' });
    expect(s.retiredReason).toBeUndefined();
    expect(c).toMatchObject({ status: 'candidate' });
    expect(c.evidence.negative).toBe(0);
    expect(Number(c.confidence)).toBeGreaterThan(0);
    cli('compound', '--lifecycle', '--apply');
    expect(fm('old-stale').status).toBe('candidate');
    expect(fm('bad-contra').status).toBe('candidate');
    expect(cli('compound', 'reopen', 'old-stale').stdout).toContain('not-retired');
  }, 120_000);

  it('같은 내용이 재추출되면 stale 은 복귀, manual 은 그대로 둔다', () => {
    write('re-stale', { status: 'retired', created: '2026-01-01', extra: 'retiredReason: stale' });
    write('re-manual', { status: 'retired', extra: 'retiredReason: manual' });
    write('re-legacy', { status: 'retired', confidence: 0, created: '2026-01-01' }); // 구버전 은퇴: 사유 없음, confidence 0
    const out1 = cli('compound', '--solution', 're-stale', '이런 상황에서는 이렇게 한다. 충분히 긴 본문입니다 재추출').stdout;
    expect(out1).toContain('reopened from retired');
    expect(fm('re-stale')).toMatchObject({ status: 'candidate' });
    expect(cli('compound', '--solution', 're-manual', '이런 상황에서는 이렇게 한다. 충분히 긴 본문입니다 재추출').stdout).toContain('already exists');
    expect(fm('re-manual').status).toBe('retired');
    expect(cli('compound', '--solution', 're-legacy', '이런 상황에서는 이렇게 한다. 충분히 긴 본문입니다 재추출').stdout).toContain('reopened');
    const legacy = fm('re-legacy');
    expect(legacy.status).toBe('candidate');
    expect(Number(legacy.confidence)).toBeGreaterThan(0); // 0 으로 남아 영구 사멸하지 않는다
  }, 120_000);

  it('retired 목록은 읽기 전용이고 사유·복구 판단을 보여 준다', () => {
    write('r-old', { status: 'retired', confidence: 0, created: '2026-01-01' });
    write('r-contra', { status: 'retired', negative: 3, extra: 'retiredReason: contradicted' });
    const before = fs.statSync(solPath('r-old')).mtimeMs;
    const out = cli('compound', 'retired').stdout;
    expect(out).toContain('r-old'); expect(out).toContain('사유 unknown'); expect(out).toContain('복구 후보');
    expect(out).toContain('r-contra'); expect(out).toContain('복구 비추천');
    expect(fs.statSync(solPath('r-old')).mtimeMs).toBe(before);
  }, 60_000);
});

describe('D6 ROI 격리: acted_on 신뢰 전까지 꺼짐 + FORGEN_HOME 존중', () => {
  const quarantine = () => {
    const p = path.join(forgen, 'state', 'roi-demotions.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ 'roi-q': { solutionId: 'roi-q', reason: 'low-roi', demotedAt: '2026-10-01T00:00:00Z', windowCount: 10, lastEvaluatedAt: '2026-10-02T00:00:00Z', surfaced: 3, actedOn: 0 } }));
    return p;
  };
  const seed = () => write('roi-q', { confidence: 0.9, tags: ['kubernetes', 'ingress', 'rollout'] });
  const PROMPT = 'kubernetes ingress rollout 설정이 궁금해';

  it('기본(꺼짐)에서는 기존 격리가 있어도 주입되고, 갱신 시 격리가 백업과 함께 해제된다', () => {
    seed(); const p = quarantine();
    expect(injected(hook(work, PROMPT, 'roi-off').stdout)).toContain('roi-q');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { updateRoiDemotions } from ${JSON.stringify(path.join(DIST, 'engine', 'roi-demotion.js'))}; console.log(JSON.stringify(updateRoiDemotions()));`], { encoding: 'utf-8', env: env() });
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ released: 1 });
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({});
    expect(fs.existsSync(p.replace(/\.json$/, '.released.json'))).toBe(true);
  }, 120_000);

  it('켜면(config.roiDemotion.enabled) 격리가 적용된다 — 파일 위치는 FORGEN_HOME 을 따른다 (HOME 아님)', () => {
    seed(); quarantine();
    fs.writeFileSync(path.join(forgen, 'config.json'), JSON.stringify({ roiDemotion: { enabled: true } }));
    expect(injected(hook(work, PROMPT, 'roi-on').stdout)).not.toContain('roi-q');
    // FORGEN_HOME 과 HOME 이 다른 환경에서 HOME/.forgen 을 건드리지 않았다
    expect(fs.existsSync(path.join(home, '.forgen', 'state', 'roi-demotions.json'))).toBe(true); // forgen === home/.forgen 이므로 같은 곳
    const other = path.join(root, 'elsewhere');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import { roiDemotionsPath } from ${JSON.stringify(path.join(DIST, 'engine', 'roi-demotion.js'))}; console.log(roiDemotionsPath());`], { encoding: 'utf-8', env: { ...env(), FORGEN_HOME: other } });
    expect(r.stdout.trim()).toBe(path.join(other, 'state', 'roi-demotions.json'));
  }, 120_000);
});

describe('D5 프로젝트 범위 (hook 과 MCP 검색이 같은 결과)', () => {
  const mcp = (cwd: string, q: string): string[] => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { searchSolutions, defaultSolutionDirs } from ${JSON.stringify(path.join(DIST, 'mcp', 'solution-reader.js'))};
      console.log(JSON.stringify(searchSolutions(${JSON.stringify(q)}, { dirs: defaultSolutionDirs(${JSON.stringify(cwd)}), cwd: ${JSON.stringify(cwd)} }).map((x) => x.name)));`], { encoding: 'utf-8', env: env({ FORGEN_CWD: cwd }) });
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? '[]');
  };
  const repo = (name: string) => { const d = path.join(root, name); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
  const PROMPT = 'terraform module backend state 잠금 설정';

  it('프로젝트 안에서는 다른 프로젝트 것 제외, 밖에서는 제외하지 않고 가중치만', () => {
    write('global-sol', { tags: ['terraform', 'module', 'backend', 'state'] });
    write('proj-a-sol', { tags: ['terraform', 'module', 'backend', 'state'], projects: ['proj-a'] });
    write('proj-b-sol', { tags: ['terraform', 'module', 'backend', 'state'], projects: ['proj-b'] });
    const a = repo('proj-a'); const b = repo('proj-b');
    const inA = injected(hook(a, PROMPT, 'p-a').stdout);
    expect(inA).toContain('global-sol'); expect(inA).toContain('proj-a-sol'); expect(inA).not.toContain('proj-b-sol');
    const inB = injected(hook(b, PROMPT, 'p-b').stdout);
    expect(inB).toContain('proj-b-sol'); expect(inB).not.toContain('proj-a-sol');
    const out = injected(hook(work, PROMPT, 'p-out').stdout); // 프로젝트 밖(git 아님)
    expect(out).toContain('proj-a-sol'); expect(out).toContain('proj-b-sol');
    // MCP 검색도 같은 범위 규칙을 쓴다
    expect(mcp(a, PROMPT)).toEqual(expect.arrayContaining(['global-sol', 'proj-a-sol']));
    expect(mcp(a, PROMPT)).not.toContain('proj-b-sol');
    expect(mcp(work, PROMPT)).toEqual(expect.arrayContaining(['proj-a-sol', 'proj-b-sol']));
  }, 180_000);

  it('hook 과 MCP 가 팩 솔루션을 똑같이 본다', () => {
    const packDir = path.join(forgen, 'packs', 'starter', 'solutions');
    fs.mkdirSync(packDir, { recursive: true });
    write('tmp-pack', { tags: ['ansible', 'playbook', 'inventory', 'vault'] });
    fs.renameSync(solPath('tmp-pack'), path.join(packDir, 'tmp-pack.md'));
    const q = 'ansible playbook inventory vault 암호화';
    expect(injected(hook(work, q, 'pk').stdout)).toContain('tmp-pack');
    expect(mcp(work, q)).toContain('tmp-pack');
  }, 120_000);

  it('compound --solution --project 와 import-pack 이 projects 를 기록한다 (구버전 파서가 쓰는 검증을 통과)', () => {
    cli('compound', '--solution', 'scoped-one', '이런 상황에서는 이렇게 한다. 충분히 긴 본문입니다 범위 기록', '--project', 'Proj-A');
    expect(fs.readFileSync(solPath('scoped-one'), 'utf-8')).toMatch(/projects:\n\s+- proj-a/);
    const packDir = path.join(forgen, 'packs', 'mypack', 'solutions');
    fs.mkdirSync(packDir, { recursive: true });
    fs.copyFileSync(solPath('scoped-one'), path.join(packDir, 'packed.md'));
    fs.writeFileSync(path.join(packDir, 'packed.md'), fs.readFileSync(path.join(packDir, 'packed.md'), 'utf-8').replace('name: scoped-one', 'name: packed').replace(/projects:\n\s+- proj-a\n/, ''));
    fs.writeFileSync(path.join(forgen, 'packs', 'mypack', 'pack.json'), JSON.stringify({ name: 'mypack', version: '1.0.0' }));
    const out = cli('rule', 'import-pack', 'mypack', '--project', 'proj-z', '--apply');
    expect(out.status).toBe(0);
    expect(fs.readFileSync(solPath('packed'), 'utf-8')).toMatch(/projects:\n\s+- proj-z/);
  }, 120_000);
});

describe('D5 탈락 사유 기록', () => {
  it('matched 이벤트의 meta.gate 에 통과/탈락 사유가 enum 으로 남고 status 가 분포를 보여 준다', () => {
    write('gate-pass', { confidence: 0.9, tags: ['postgres', 'vacuum', 'autovacuum', 'bloat'] });
    write('gate-weak', { confidence: 0.9, tags: ['postgres', 'zzzfiller1', 'zzzfiller2', 'zzzfiller3', 'zzzfiller4', 'zzzfiller5'] });
    hook(work, 'postgres vacuum autovacuum bloat 정리 방법', 'g1');
    hook(work, 'postgres 질문', 'g2');
    const db = new DatabaseSync(path.join(forgen, 'sessions.db'));
    const rows = db.prepare("SELECT meta FROM solution_events WHERE event_type = 'matched'").all() as Array<{ meta: string }>;
    db.close();
    const gates = rows.map((r) => JSON.parse(r.meta).gate);
    expect(gates).toContain('passed');
    expect(gates.some((g) => ['below-relevance', 'too-few-tags'].includes(g))).toBe(true);
    for (const g of gates) expect(['passed', 'below-relevance', 'too-few-tags', 'experiment-cap', 'prompt-cap', 'already-injected']).toContain(g);
    const st = cli('status').stdout;
    expect(st).toContain('회수 게이트');
    expect(st).toMatch(/passed \d+/);
  }, 120_000);
});
