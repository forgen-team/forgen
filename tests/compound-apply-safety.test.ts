/**
 * retag/habits --apply 와 reopen 의 안전장치를 실제 CLI·dist 모듈 프로세스로 확인한다 (대역 없음).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

const DIST = path.resolve(__dirname, '..', 'dist');
let root: string, home: string, forgen: string, work: string, sols: string;
const env = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, FORGEN_HOME: forgen, FORGEN_SYNTHETIC: '1', FORGEN_CWD: work, FORGEN_NO_BLOCK_JUDGE: '1' });
const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(DIST, 'cli.js'), ...a], { encoding: 'utf-8', cwd: work, env: env(), timeout: 60_000 });
const node = (code: string) => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf-8', cwd: work, env: env(), timeout: 60_000 }).stdout.trim().split('\n').pop() ?? 'null');

function sol(dir: string, name: string, o: { tags?: string[]; status?: string; confidence?: number; updated?: string; by?: string; reason?: string; negative?: number; context?: string; body: string }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), ['---', `name: ${name}`, 'version: 1', `status: ${o.status ?? 'candidate'}`, `confidence: ${o.confidence ?? 0.5}`, 'type: pattern', 'scope: me',
    'tags:', ...(o.tags ?? ['alpha']).map((t) => `  - ${JSON.stringify(t)}`), 'identifiers: []', 'evidence:', '  injected: 0', '  reflected: 0', `  negative: ${o.negative ?? 0}`, '  sessions: 0', '  reExtracted: 0',
    'created: 2026-01-01', `updated: ${o.updated ?? '2026-01-02'}`, 'supersedes: null', `extractedBy: ${o.by ?? 'manual'}`, ...(o.reason ? [`retiredReason: ${o.reason}`, 'retiredAt: 2026-03-01'] : []), '---', '', '## Context', o.context ?? '', '', '## Content', o.body, ''].join('\n'));
}
const rd = (f: string) => fs.readFileSync(f, 'utf-8');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-apply-'));
  home = path.join(root, 'home'); forgen = path.join(home, '.forgen'); work = path.join(root, 'work'); sols = path.join(forgen, 'me', 'solutions');
  fs.mkdirSync(sols, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(forgen, 'forge-profile.json'), '{}');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('retag --apply', () => {
  it('updated 를 건드리지 않고, 본문에 없는 수동 태그를 보존하고, 적용 전 스냅샷을 만든다', () => {
    sol(sols, 'cache-invalidate-policy', { tags: ['무엇', '대신', 'my-manual-label'], updated: '2026-01-02', body: '무엇: 레디스 캐시 무효화 시점을 명시한다. 왜: 만료가 길면 오래된 값이 남는다. 주의: ttl 을 짧게 둔다.' });
    const r = cli('compound', 'retag', '--apply');
    expect(r.status).toBe(0);
    const after = rd(path.join(sols, 'cache-invalidate-policy.md'));
    expect(after).toContain('updated: 2026-01-02');
    expect(after).toContain('my-manual-label');
    expect(after).not.toMatch(/- "?무엇"?\n/);
    const backups = fs.readdirSync(path.join(forgen, 'backups'));
    expect(backups.some((n) => n.endsWith('-pre-retag'))).toBe(true);
    const snap = backups.find((n) => n.endsWith('-pre-retag'))!;
    expect(rd(path.join(forgen, 'backups', snap, 'solutions', 'cache-invalidate-policy.md'))).toContain('무엇');
  });
});

describe('habits --apply', () => {
  it('자동 표식이 있는 것만 옮기고, 사용자가 쓴 짧은 솔루션은 두며, 기존 behavior 는 덮어쓰지 않는다', () => {
    sol(sols, 'works-with-typescript', { by: 'auto', body: '주로 TypeScript 코드를 작성합니다.' });
    sol(sols, 'uses-redis-ttl', { by: 'manual', body: '레디스 ttl 은 30초로 둔다.' });
    sol(sols, 'writes-long-content', { by: 'auto', body: '긴 글을 쓴다.' });
    const behavior = path.join(forgen, 'me', 'behavior');
    fs.mkdirSync(behavior, { recursive: true });
    fs.writeFileSync(path.join(behavior, 'habit-writes-long-content.md'), 'KEEP-ME');
    const r = cli('compound', 'habits', '--apply');
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(sols, 'works-with-typescript.md'))).toBe(false);
    expect(fs.existsSync(path.join(behavior, 'habit-works-with-typescript.md'))).toBe(true);
    expect(fs.existsSync(path.join(sols, 'uses-redis-ttl.md'))).toBe(true); // 사용자 솔루션 오이관 방지
    expect(rd(path.join(behavior, 'habit-writes-long-content.md'))).toBe('KEEP-ME'); // 덮어쓰기 금지
    expect(fs.existsSync(path.join(sols, 'writes-long-content.md'))).toBe(true); // 못 옮겼으면 원본 유지
    expect(r.stdout).toContain('forgen rule restore');
  });
});

describe('reopen', () => {
  const lifecycle = (body: string) => node(`import * as m from ${JSON.stringify(path.join(DIST, 'engine', 'compound-lifecycle.js'))}; ${body}`);
  const same = '레디스 캐시 무효화 시점을 명시하고 ttl 을 짧게 둔다 만료가 길면 오래된 값이 남는다 주의 근거 포함';

  it('내용이 비슷할 때만 복귀하고, verified 등급을 지킨다', () => {
    sol(sols, 'redis-cache', { status: 'retired', confidence: 0.75, reason: 'stale', body: same });
    const out = lifecycle(`console.log(JSON.stringify(m.reopenIfReExtracted('redis-cache', ${JSON.stringify(same + ' 추가')})))`);
    expect(out).toBe('reopened');
    const after = rd(path.join(sols, 'redis-cache.md'));
    expect(after).toContain('status: verified');
    expect(after).not.toContain('retiredReason');
  });

  it('이름만 같고 내용이 다르면 복귀하지 않고 different 를 돌려준다 (호출자가 새 추출을 보존)', () => {
    sol(sols, 'redis-cache', { status: 'retired', confidence: 0.5, reason: 'stale', body: same });
    const out = lifecycle(`console.log(JSON.stringify(m.reopenIfReExtracted('redis-cache', '쿠버네티스 파드 재시작 정책과 헬스체크 프로브 설정 방법을 정리한다')))`);
    expect(out).toBe('different');
    expect(rd(path.join(sols, 'redis-cache.md'))).toContain('status: retired');
  });

  it('사유 미상 은퇴는 복귀 시 negative 증거를 0 으로 되돌린다', () => {
    sol(sols, 'redis-cache', { status: 'retired', confidence: 0, negative: 4, body: same });
    expect(lifecycle(`console.log(JSON.stringify(m.reopenSolution('redis-cache')))`)).toMatchObject({ ok: true, previous: 'unknown' });
    expect(rd(path.join(sols, 'redis-cache.md'))).toMatch(/negative: 0/);
  });

  it('프로젝트 솔루션도 복귀한다', () => {
    sol(path.join(work, '.compound', 'solutions'), 'proj-only', { status: 'retired', confidence: 0.55, reason: 'stale', body: same });
    expect(lifecycle(`console.log(JSON.stringify(m.reopenSolution('proj-only', ${JSON.stringify(work)})))`)).toMatchObject({ ok: true });
    expect(rd(path.join(work, '.compound', 'solutions', 'proj-only.md'))).toContain('status: candidate');
  });
});

describe('게이트 분포', () => {
  it('matched 5분 중복 제거와 무관하게 프롬프트마다 센다', () => {
    sol(sols, 'redis-cache-ttl', { tags: ['redis', 'cache', 'ttl', 'invalidate'], body: '레디스 캐시 무효화는 ttl 을 짧게 두고 시점을 명시한다. 근거와 주의를 포함한 충분히 긴 본문이다.' });
    const run = () => spawnSync(process.execPath, [path.join(DIST, 'hooks', 'solution-injector.js')], { input: JSON.stringify({ session_id: 'gate-1', cwd: work, prompt: 'redis cache invalidate ttl 정책', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf-8', cwd: work, env: env(), timeout: 60_000 });
    run(); run();
    const db = new DatabaseSync(path.join(forgen, 'sessions.db'));
    try {
      const matched = (db.prepare("SELECT COUNT(*) n FROM solution_events WHERE event_type='matched'").get() as { n: number }).n;
      const verdicts = (db.prepare('SELECT COUNT(*) n FROM gate_verdicts').get() as { n: number }).n;
      expect(matched).toBe(1);
      expect(verdicts).toBe(2);
    } finally { db.close(); }
    const dist = node(`import { queryGateDistribution } from ${JSON.stringify(path.join(DIST, 'core', 'observability-store.js'))}; console.log(JSON.stringify(queryGateDistribution(30)))`);
    expect(Object.values(dist as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(2);
  }, 120_000);
});
