/**
 * K0 공개 출력 계약 — 이미 있는 JSON 출력 5종(+입력 1종)을 assets/schemas/ 의 JSON Schema 로 검사한다.
 *   forgen-way/1 · forgen-rule-list/v1 · forgen-rule-history/v1 · forgen-rule-health/v1 · forgen-events/v1 · forgen-way-import/1(입력)
 * 출력은 실제 CLI 핸들러(console.log 가로채기) 또는 CLI 가 그대로 찍는 빌더 함수로 얻는다. 모든 파일은 임시 HOME·FORGEN_HOME 안.
 * 픽스처(tests/fixtures/contracts/*.json)는 이 테스트가 만든 실제 출력이다. 다시 뜨려면 FORGEN_WRITE_CONTRACT_FIXTURES=1.
 * 픽스처 문장·id 는 전부 합성 값이다.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { schemaIssues } from './helpers/contract-schema.js';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-k0-')));
const HOME = path.join(ROOT, 'home');
const FH = path.join(HOME, '.forgen');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
const PREV = { HOME: process.env.HOME, FORGEN_HOME: process.env.FORGEN_HOME, FORGEN_CWD: process.env.FORGEN_CWD };
process.env.HOME = HOME;
process.env.FORGEN_HOME = FH;
delete process.env.FORGEN_CWD;

const { handleWay } = await import('../src/way/cli.js');
const { buildWay } = await import('../src/way/extract.js');
const { compile } = await import('../src/way/compile.js');
const { parseWayJson } = await import('../src/way/io.js');
const { buildRuleList } = await import('../src/core/rule-list-json.js');
const { handleStatus } = await import('../src/core/status-cli.js');

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'contracts');
const WRITE_FIXTURES = process.env.FORGEN_WRITE_CONTRACT_FIXTURES === '1';
const FIXTURE_ROOT = '/tmp/forgen-fixture';
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (t: number) => new Date(t).toISOString();

const W = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
// biome-ignore lint/suspicious/noExplicitAny: 일부러 깬 값을 만들기 위한 느슨한 타입
type J = Record<string, any>;

/** CLI 핸들러가 stdout 에 찍은 JSON 하나를 가로채 돌려준다. */
async function stdoutJson(run: () => Promise<void> | void): Promise<J> {
  const out: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try { await run(); } finally { spy.mockRestore(); errSpy.mockRestore(); }
  return JSON.parse(out.join('\n')) as J;
}

/** 실제 출력으로 픽스처를 떠 두고(요청 시), 저장된 픽스처를 돌려준다. 임시 폴더 경로는 고정 문자열로 바꾼다. */
function fixture(id: string, value: unknown, suffix = ''): J {
  const file = path.join(FIXTURES, `${id.replace(/\//g, '.')}${suffix}.json`);
  if (WRITE_FIXTURES || !fs.existsSync(file)) W(file, `${JSON.stringify(value, null, 2).split(ROOT).join(FIXTURE_ROOT)}\n`);
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as J;
}

function expectPass(id: string, value: unknown) { expect(schemaIssues(id, value)).toEqual([]); }
function expectFail(id: string, value: unknown) { expect(schemaIssues(id, value).length).toBeGreaterThan(0); }

// ── 합성 데이터 ──
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const R3 = '33333333-3333-4333-8333-333333333333';
const R4 = '44444444-4444-4444-8444-444444444444';
const R5 = '55555555-5555-4555-8555-555555555555';
const R6 = '66666666-6666-4666-8666-666666666666';
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BORN = iso(NOW - 5 * DAY);

function rule(id: string, over: J): J {
  return {
    schema_version: 1, rule_id: id, category: 'quality', scope: 'me', trigger: '테스트를 돌릴 때', policy: `합성 룰 ${id.slice(0, 4)}`,
    strength: 'default', source: 'explicit_correction', status: 'active', evidence_refs: [], render_key: `quality.k${id.slice(0, 4)}`,
    created_at: BORN, updated_at: BORN,
    lifecycle: { phase: 'active', first_active_at: BORN, inject_count: 0, accept_count: 0, violation_count: 0, bypass_count: 0, conflict_refs: [], meta_promotions: [] },
    ...over,
  };
}

function seed(): void {
  const rules = path.join(FH, 'me', 'rules');
  const put = (dir: string, r: J) => W(path.join(dir, `${r.rule_id}.json`), JSON.stringify(r, null, 2));
  put(rules, rule(R1, {
    policy: '테스트는 임시 폴더에서 격리해 돌린다', evidence_refs: ['ev-user-1'],
    lifecycle: { phase: 'active', first_active_at: BORN, last_inject_at: iso(NOW - DAY), last_violation_at: iso(NOW - 2 * 3600_000), inject_count: 3, accept_count: 0, violation_count: 2, bypass_count: 0, conflict_refs: [], meta_promotions: [] },
  }));
  put(rules, rule(R2, {
    category: 'workflow', policy: '빌드 전에 타입 검사를 먼저 돌린다', source: 'behavior_inference', strength: 'soft', projects: ['proj-a'], evidence_refs: ['ev-mined-1'],
    lifecycle: { phase: 'flagged', first_active_at: BORN, inject_count: 1, accept_count: 0, violation_count: 0, bypass_count: 1, conflict_refs: [], meta_promotions: [] },
  }));
  put(rules, rule(R3, { category: 'communication', policy: '답변 끝에 다음 단계를 한 줄로 적는다', source: 'imported', imported_from: 'proj-a/feedback_next.md' }));
  put(rules, rule(R4, {
    policy: '오래된 합성 룰', status: 'suppressed', updated_at: iso(NOW - DAY),
    status_history: [{ at: iso(NOW - DAY), from: 'active', to: 'suppressed', reason: 'user: 더 안 씀', by: 'cli' }],
    lifecycle: { phase: 'suppressed', first_active_at: BORN, inject_count: 0, accept_count: 0, violation_count: 0, bypass_count: 0, conflict_refs: [], meta_promotions: [] },
  }));
  put(rules, rule(R5, { policy: '후보 합성 룰: 커밋 전 린트', source: 'behavior_inference', status: 'candidate', scope_state: 'unresolved' }));
  put(path.join(FH, 'me', 'rules-archive'), rule(R6, {
    policy: '보관된 합성 룰', status: 'removed', status_history: [{ at: iso(NOW - 3 * DAY), from: 'active', to: 'removed', reason: 'prune', by: 'auto' }],
  }));

  const beh = path.join(FH, 'me', 'behavior');
  W(path.join(beh, 'ev-user-1.json'), JSON.stringify({
    evidence_id: 'ev-user-1', type: 'explicit_correction', session_id: S1, timestamp: iso(NOW - 4 * DAY), source_component: 'correction-record',
    summary: '테스트 격리 교정', axis_refs: [], candidate_rule_refs: [R1], confidence: 0.9, raw_payload: { user_quote: '테스트는 임시 폴더에서 돌려', target_rule_id: R1, kind: 'prefer-from-now' },
  }));
  W(path.join(beh, 'ev-mined-1.json'), JSON.stringify({
    evidence_id: 'ev-mined-1', type: 'explicit_correction', session_id: S2, timestamp: iso(NOW - 3 * 3600_000), source_component: 'auto-compound-miner',
    summary: '타입 검사 먼저(추론)', axis_refs: [], candidate_rule_refs: [R2], confidence: 0.6, raw_payload: {},
  }));
  W(path.join(beh, 'auto-2026-11-01-workflow.md'), ['---', 'created: "2026-11-01"', '---', '- [workflow] 작업을 시작하기 전에 할 일 목록을 먼저 적는다', ''].join('\n'));
  W(path.join(FH, 'me', 'solutions', 'docker-cache-bust.md'), ['---', 'name: docker-cache-bust', 'version: 1', 'status: verified', 'confidence: 0.8', 'type: pattern', 'scope: me', 'tags:', '  - "docker"', 'identifiers: []', 'evidence:', '  injected: 0', '  reflected: 0', '  negative: 0', '  sessions: 0', '  reExtracted: 0', 'created: 2026-10-01', 'updated: 2026-10-01', 'supersedes: null', 'extractedBy: manual', '---', '', '## Context', '도커 빌드가 옛 캐시를 쓸 때', '', '## Content', '1. 캐시 없이 다시 빌드한다.', ''].join('\n'));

  const enf = path.join(FH, 'state', 'enforcement');
  const lines = (rows: J[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
  W(path.join(enf, 'violations.jsonl'), lines([
    { violation_id: 'v-1', at: iso(NOW - DAY), session_id: S1, rule_id: R1, kind: 'block' },
    { violation_id: 'v-2', at: iso(NOW - 2 * 3600_000), session_id: S1, rule_id: R1, kind: 'deny' },
    { violation_id: 'v-3', at: iso(NOW - 3 * 3600_000), session_id: S2, rule_id: R2, kind: 'bypass_confirmed' },
    { violation_id: 'v-4', at: iso(NOW - 3600_000), session_id: S2, rule_id: R2, kind: 'correction' },
  ]));
  W(path.join(enf, 'verdicts.jsonl'), lines([{ violation_id: 'v-1', rule_id: R1, verdict: 'false_positive', by: 'user', at: iso(NOW - 20 * 3600_000) }]));
  W(path.join(enf, 'checks.jsonl'), lines([{ at: iso(NOW - 3600_000), session_id: S1, rule_id: R1, result: 'pass' }]));
  W(path.join(FH, 'state', 'lifecycle', `${iso(NOW).slice(0, 10)}.jsonl`), lines([
    { kind: 't1_explicit_correction', rule_id: R1, ts: NOW - 3600_000 },
    { kind: 'meta_promote_to_a', rule_id: R1, ts: NOW - 1800_000 },
  ]));
  W(path.join(FH, 'state', 'render-report.json'), JSON.stringify({ at: iso(NOW - 3600_000), included: [R1, R3], omitted: [{ rule_id: R2, strength: 'soft', policy: '빌드 전에 타입 검사를 먼저 돌린다' }], chars: 512 }));

  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void } };
  const db = new DatabaseSync(path.join(FH, 'sessions.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, started_at TEXT); CREATE TABLE solution_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT, solution_id TEXT NOT NULL, event_type TEXT NOT NULL)');
  db.prepare('INSERT INTO sessions (id, cwd, started_at) VALUES (?, ?, ?)').run(S1, `${FIXTURE_ROOT}/work/proj-a`, iso(NOW - DAY - 3600_000));
  db.prepare('INSERT INTO sessions (id, cwd, started_at) VALUES (?, ?, ?)').run(S2, `${FIXTURE_ROOT}/work/proj-b`, iso(NOW - 5 * 3600_000));
  db.prepare('INSERT INTO solution_events (ts, session_id, solution_id, event_type) VALUES (?, ?, ?, ?)').run(NOW - 4 * 3600_000, S2, 'docker-cache-bust', 'matched');
  db.prepare('INSERT INTO solution_events (ts, session_id, solution_id, event_type) VALUES (?, ?, ?, ?)').run(NOW - 4 * 3600_000 + 1000, S2, 'docker-cache-bust', 'surfaced');
  db.prepare('INSERT INTO solution_events (ts, session_id, solution_id, event_type) VALUES (?, ?, ?, ?)').run(NOW - 3 * 3600_000, S2, 'docker-cache-bust', 'acted_on');
  db.close();

  W(path.join(ROOT, 'mem', '-nonexistent-proj', 'memory', 'feedback_reply.md'), '---\nname: a\ndescription: "답변은 항상 한국어로 쓴다"\n---\n\n본문.\n\n**Why:** 읽는 사람이 한국어 화자다.\n**How to apply:** 영어 답변은 하지 않는다.\n');
}

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ── 빈 상태(룰·증거·기록 0) ──
describe('K0 빈 상태 출력도 스키마를 통과한다', () => {
  it('forgen way --json', async () => {
    const out = await stdoutJson(() => handleWay(['--json']));
    expect(out.items).toEqual([]);
    expect(out.render).toBeNull();
    expectPass('forgen-way/1', out);
  });
  it('forgen rule list --json', () => {
    const out = clone(buildRuleList());
    expect(out.rules).toEqual([]);
    expectPass('forgen-rule-list/v1', out);
  });
  it('forgen status --history --json', async () => {
    const out = await stdoutJson(() => handleStatus(['--history', '--json', '--days', '30']));
    expect(out.days.every((d: J) => d.rows.length === 0)).toBe(true); // 룰이 없으면 어제 스냅숏은 빈 행으로 남는다
    expectPass('forgen-rule-history/v1', out);
  });
  it('forgen status --health --json', async () => {
    const out = await stdoutJson(() => handleStatus(['--health', '--json']));
    expect(out.rules.active.total).toBe(0);
    expectPass('forgen-rule-health/v1', out);
  });
  it('forgen status --events --json', async () => {
    const out = await stdoutJson(() => handleStatus(['--events', '--json']));
    expect(out.events).toEqual([]);
    expect(out.sources).toEqual({ enforcement: false, evidence: false, sessionsDb: false });
    expectPass('forgen-events/v1', out);
  });
});

describe('K0 합성 데이터가 있을 때', () => {
  let way: J; let ruleList: J; let history: J; let health: J; let events: J;
  beforeAll(async () => {
    seed();
    fs.rmSync(path.join(FH, 'state', 'metrics'), { recursive: true, force: true }); // 빈 상태 단계에서 쓴 일별 보관값을 지운다
    way = await stdoutJson(() => handleWay(['--json']));
    ruleList = clone(buildRuleList({ archive: true })); // cli.ts 의 `rule list --json` 이 그대로 JSON.stringify 하는 값
    history = await stdoutJson(() => handleStatus(['--history', '--json', '--days', '30']));
    health = await stdoutJson(() => handleStatus(['--health', '--json', '--days', '14']));
    events = await stdoutJson(() => handleStatus(['--events', '--json']));
  });

  describe('forgen-way/1', () => {
    const ID = 'forgen-way/1';
    it('way --json 실제 출력과 픽스처가 통과', () => {
      expect(way.items.map((i: J) => i.kind)).toEqual(expect.arrayContaining(['rule', 'solution', 'habit']));
      expect(way.items.map((i: J) => i.provenance.kind)).toEqual(expect.arrayContaining(['you-said', 'mined', 'imported']));
      expect(way.render).not.toBeNull();
      expectPass(ID, way);
      expectPass(ID, fixture(ID, way));
    });
    it('export --target json·collect-memory --json 도 같은 스키마로 통과', async () => {
      const file = compile(buildWay(), 'json', { project: 'proj-a' }).files[0];
      const exported = JSON.parse(file.content) as J;
      expect(exported.project).toBe('proj-a');
      expectPass(ID, exported);
      expectPass(ID, fixture(ID, exported, '.export'));
      const collected = await stdoutJson(() => handleWay(['collect-memory', '--dir', path.join(ROOT, 'mem'), '--json']));
      expect(collected.items.length).toBe(1);
      expectPass(ID, collected);
    });
    it('깬 값은 실패', () => {
      const bad = [
        (v: J) => { v.schema = 'forgen-way/2'; },
        (v: J) => { delete v.items; },
        (v: J) => { delete v.items[0].enforceable; },
        (v: J) => { v.items[0].kind = 'memo'; },
        (v: J) => { v.items[0].strength = 'medium'; },
        (v: J) => { v.items.find((i: J) => i.provenance.kind === 'imported').provenance = { kind: 'imported' }; },
        (v: J) => { v.items[0].provenance = { kind: 'guessed' }; },
        (v: J) => { v.stats.rules_active = -1; },
        (v: J) => { v.render.included = 'all'; },
      ];
      for (const b of bad) { const v = clone(way); b(v); expectFail(ID, v); }
    });
  });

  describe('forgen-rule-list/v1', () => {
    const ID = 'forgen-rule-list/v1';
    it('실제 출력과 픽스처가 통과', () => {
      expect(ruleList.rules.length).toBe(6);
      expect(ruleList.rules.some((r: J) => r.scopeState === 'unresolved')).toBe(true);
      expect(ruleList.rules.some((r: J) => r.archived)).toBe(true);
      expectPass(ID, ruleList);
      expectPass(ID, fixture(ID, ruleList));
    });
    it('깬 값은 실패', () => {
      const bad = [
        (v: J) => { v.schema = 'forgen-rule-list/v2'; },
        (v: J) => { delete v.rules[0].counts; },
        (v: J) => { v.rules[0].status = 'paused'; },
        (v: J) => { v.rules[0].enforce.mode = 'warn'; },
        (v: J) => { v.rules[0].phase = 'gone'; },
        (v: J) => { v.rules[0].scopeState = 'resolved'; },
        (v: J) => { v.rules[0].evidence = [{ id: 'x', at: null, kind: 'robot', summary: null }]; },
        (v: J) => { v.rules[0].archived = 'no'; },
      ];
      for (const b of bad) { const v = clone(ruleList); b(v); expectFail(ID, v); }
    });
  });

  describe('forgen-rule-history/v1', () => {
    const ID = 'forgen-rule-history/v1';
    it('실제 출력과 픽스처가 통과', () => {
      expect(history.days.length).toBeGreaterThan(0);
      expect(history.days.at(-1).rows.length).toBe(5);
      expectPass(ID, history);
      expectPass(ID, fixture(ID, history));
    });
    it('깬 값은 실패', () => {
      const bad = [
        (v: J) => { v.schema = 'forgen-daily/v1'; },
        (v: J) => { delete v.columns; },
        (v: J) => { v.days[0].day = '2026/11/01'; },
        (v: J) => { delete v.days[0].asOf; },
        (v: J) => { v.days[0].rows = [[true]]; },
      ];
      for (const b of bad) { const v = clone(history); b(v); expectFail(ID, v); }
    });
  });

  describe('forgen-rule-health/v1', () => {
    const ID = 'forgen-rule-health/v1';
    it('실제 출력과 픽스처가 통과', () => {
      expect(health.flow.blocks).toBe(2);
      expect(health.top.recorrected.length).toBe(1);
      expect(health.days.every((d: J) => ['live', 'closed', 'backfill'].includes(d.source))).toBe(true);
      expectPass(ID, health);
      expectPass(ID, fixture(ID, health));
    });
    it('깬 값은 실패', () => {
      const bad = [
        (v: J) => { v.schema = 'forgen-health/v1'; },
        (v: J) => { delete v.flow.blocks; },
        (v: J) => { delete v.history; },
        (v: J) => { v.days[0].source = 'cached'; },
        (v: J) => { v.rules.active.total = 1.5; },
        (v: J) => { v.top.blocking[0].policy = 3; },
        (v: J) => { delete v.flow.correctionClasses.recurrence; },
      ];
      for (const b of bad) { const v = clone(health); b(v); expectFail(ID, v); }
    });
  });

  describe('forgen-events/v1', () => {
    const ID = 'forgen-events/v1';
    it('실제 출력과 픽스처가 통과', () => {
      expect(new Set(events.events.map((e: J) => e.kind))).toEqual(new Set(['block', 'bypass', 'false_positive', 'correction_user', 'correction_mined', 'solution_matched', 'solution_surfaced', 'solution_acted_on']));
      expect(events.sessions.length).toBe(2);
      expectPass(ID, events);
      expectPass(ID, fixture(ID, events));
    });
    it('깬 값은 실패', () => {
      const bad = [
        (v: J) => { v.schema = 'forgen-events/v2'; },
        (v: J) => { delete v.sources.sessionsDb; },
        (v: J) => { v.events[0].kind = 'advisory'; },
        (v: J) => { delete v.events[0].ruleId; },
        (v: J) => { v.events[0].sessionId = 7; },
        (v: J) => { delete v.sessions[0].cwd; },
      ];
      for (const b of bad) { const v = clone(events); b(v); expectFail(ID, v); }
    });
  });

  describe('forgen-way-import/1 (입력) — io.ts 검사기와 판정이 같다', () => {
    const ID = 'forgen-way-import/1';
    const item = (over: J = {}): J => ({ id: 'mem-new-1', kind: 'rule', statement: '새 합성 룰', applies_when: '', projects: [], strength: 'default', provenance: { kind: 'imported', from: 'notes.md' }, enforceable: false, ...over });
    const doc = (items: J[], top: J = {}): J => ({ schema: 'forgen-way/1', items, ...top });
    it('검사기가 받는 문서는 스키마도 통과', () => {
      const accepted: J[] = [
        clone(way), // way --json 출력(stats·render 포함)을 그대로 다시 가져올 수 있다
        doc([]),
        doc([item()]),
        doc([item({ why: '근거', status: 'active', category: 'workflow', provenance: { kind: 'you-said', quote: '그렇게 해', date: '2026-11-01', from: 'x' } })]),
        doc([item({ provenance: { kind: 'mined' } })], { generator: 'forgen-way', generated_at: iso(NOW), project: null }),
      ];
      const sample = fixture(ID, doc([item(), item({ id: R1, statement: '테스트는 임시 폴더에서 격리해 돌린다', provenance: { kind: 'you-said', date: '2026-11-01' }, status: 'active', why: '' })], { generator: 'forgen-way', generated_at: iso(NOW) }));
      accepted.push(sample);
      for (const d of accepted) {
        expect(parseWayJson(JSON.stringify(d)).ok).toBe(true);
        expectPass(ID, d);
      }
    });
    it('검사기가 거부하는 문서는 스키마도 실패', () => {
      const noEnf = item(); delete noEnf.enforceable;
      const noApplies = item(); delete noApplies.applies_when;
      const rejected: J[] = [
        doc([item()], { schema: 'forgen-way/2' }),
        doc([item()], { extra: 1 }),
        { schema: 'forgen-way/1' },
        doc([item({ color: 'red' })]),
        doc([noEnf]),
        doc([noApplies]),
        doc([item({ id: '' })]),
        doc([item({ kind: 'memo' })]),
        doc([item({ statement: '   ' })]),
        doc([item({ projects: ['a', 1] })]),
        doc([item({ strength: 'medium' })]),
        doc([item({ provenance: { kind: 'imported' } })]),
        doc([item({ provenance: { kind: 'guessed' } })]),
        doc([item({ provenance: { kind: 'mined', note: 'x' } })]),
        doc([item({ status: 'candidate' })]),
        doc([item({ enforceable: 'no' })]),
      ];
      for (const d of rejected) {
        expect(parseWayJson(JSON.stringify(d)).ok).toBe(false);
        expectFail(ID, d);
      }
    });
    it('스키마로 못 잡는 검사(같은 파일 id 중복)는 검사기에만 있다', () => {
      const d = doc([item(), item()]);
      expect(parseWayJson(JSON.stringify(d)).ok).toBe(false);
      expectPass(ID, d);
    });
  });
});
