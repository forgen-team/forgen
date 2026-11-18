/**
 * 0.7.1 (docs/plans/2026-11-18-forgen-own-metrics.md): 룰 목록 JSON · 일별 이력 보관 · HTML.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-own-metrics-'));
process.env.FORGEN_HOME = TMP_HOME;
process.env.FORGEN_DISABLE_PROJECT_RULES = '1';

const { buildRuleList, RULE_LIST_SCHEMA } = await import('../src/core/rule-list-json.js');
const { recordClosedDays, readDaily, listDailyDays, healthWithHistory, buildRuleHistory, dailyDir, DEFINITION } = await import('../src/core/metrics-history.js');
const { renderStatusHtml, embedJson } = await import('../src/core/status-html.js');
const { createRule, saveRule } = await import('../src/store/rule-store.js');
const { createEvidence, saveEvidence } = await import('../src/store/evidence-store.js');
const { withStatusChange } = await import('../src/store/rule-lifecycle.js');

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-18T05:00:00Z');
const SID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  for (const d of ['me', 'state']) fs.rmSync(path.join(TMP_HOME, d), { recursive: true, force: true });
});

function rule(id: string, o: Record<string, unknown> = {}) {
  const r = { ...createRule({ category: 'workflow', scope: 'me', trigger: id, policy: `policy text ${id}`, strength: 'default', source: 'explicit_correction', render_key: `w.${id}` }), rule_id: id, created_at: '2026-01-01T00:00:00.000Z', ...o };
  saveRule(r as never);
  return r;
}
function correction(at: string, quote?: string) {
  const e = createEvidence({ type: 'explicit_correction', session_id: SID, source_component: 'mcp', summary: 'model summary text', confidence: 1, raw_payload: quote ? { user_quote: quote } : {} });
  const ev = { ...e, timestamp: at };
  saveEvidence(ev);
  return ev.evidence_id;
}

describe('forgen rule list --json', () => {
  it('schema·모든 status·근거 교정(user_quote 우선, 최신 순)·누적 카운터·막는 방식', () => {
    const e1 = correction('2026-11-10T00:00:00Z', '내가 한 말 그대로');
    const e2 = correction('2026-11-12T00:00:00Z');
    const base = rule('a', { evidence_refs: [e1, e2], projects: ['alpha'] }) as never as Parameters<typeof withStatusChange>[0];
    saveRule({ ...base, lifecycle: { ...base.lifecycle!, inject_count: 5, violation_count: 2, bypass_count: 1, last_inject_at: '2026-11-17T00:00:00Z' } });
    rule('c', { status: 'candidate', source: 'behavior_inference', render_key: 'auto:w.c' });
    saveRule(withStatusChange(rule('s') as never, 'suppressed', 'user', 'cli'));
    const list = buildRuleList({ now: NOW });
    expect(list.schema).toBe(RULE_LIST_SCHEMA);
    const a = list.rules.find((r) => r.id === 'a')!;
    expect(a).toMatchObject({ origin: 'user', projects: ['alpha'], counts: { inject: 5, violation: 2, bypass: 1 }, lastInjectAt: '2026-11-17T00:00:00Z', archived: false });
    expect(a.evidence.map((e) => e.summary)).toEqual(['model summary text', '내가 한 말 그대로']);
    expect(a.evidence[1]).toMatchObject({ kind: 'user', at: '2026-11-10T00:00:00Z' });
    expect(a.enforce.label).toMatch(/^(차단|탐지|자문)$/);
    expect(list.rules.find((r) => r.id === 'c')).toMatchObject({ status: 'candidate', origin: 'mined' });
    const s = list.rules.find((r) => r.id === 's')!;
    expect(s.statusHistory.at(-1)).toMatchObject({ from: 'active', to: 'suppressed', reason: 'user' });
  });

  it('상위 schema_version 룰은 건너뛰고, --archive 일 때만 보관함 룰을 넣는다', () => {
    rule('new', { schema_version: 999 });
    const arch = path.join(TMP_HOME, 'me', 'rules-archive');
    fs.mkdirSync(arch, { recursive: true });
    fs.writeFileSync(path.join(arch, 'old.json'), JSON.stringify({ ...createRule({ category: 'workflow', scope: 'me', trigger: 'o', policy: 'old policy', strength: 'default', source: 'explicit_correction', render_key: 'w.o' }), rule_id: 'old', status: 'removed' }));
    expect(buildRuleList().rules.map((r) => r.id)).toEqual([]);
    expect(buildRuleList({ archive: true }).rules.map((r) => [r.id, r.archived])).toEqual([['old', true]]);
  });
});

describe('일별 이력 보관', () => {
  it('어제까지 빠진 닫힌 날을 채우고(오늘 제외), 스냅샷은 마지막 날에만, 다시 돌리면 아무것도 안 함', () => {
    rule('r1');
    correction('2026-11-16T10:00:00Z');
    correction('2026-11-17T10:00:00Z');
    correction('2026-11-18T01:00:00Z'); // 오늘 — 보관 안 함
    const r = recordClosedDays({ limit: 3, now: NOW });
    expect(r.written).toEqual(['2026-11-15', '2026-11-16', '2026-11-17']);
    expect(readDaily('2026-11-18')).toBeNull();
    const y = readDaily('2026-11-17')!;
    expect(y).toMatchObject({ source: 'closed', definition: DEFINITION });
    expect(y.totals.correctionsUser).toBe(1);
    expect(y.rules?.rows.map((row) => row[0])).toEqual(['r1']);
    expect(readDaily('2026-11-16')!.rules).toBeNull();
    expect(recordClosedDays({ limit: 3, now: NOW }).skipped).toBe('up-to-date');
  });

  it('7일보다 오래된 날을 처음 쓰면 backfill, 400일 지난 파일은 정리, 첫 룰 생성일 이전은 채우지 않음', () => {
    rule('first', { created_at: '2026-11-07T12:00:00Z' });
    fs.mkdirSync(dailyDir(), { recursive: true });
    fs.writeFileSync(path.join(dailyDir(), '2024-01-01.json'), '{}');
    recordClosedDays({ limit: 12, now: NOW });
    expect(readDaily('2026-11-08')!.source).toBe('backfill');
    expect(readDaily('2026-11-12')!.source).toBe('closed');
    expect(listDailyDays()).not.toContain('2024-01-01');
    expect(readDaily('2026-11-06')).toBeNull();
    expect(listDailyDays()[0]).toBe('2026-11-07');
  });

  it('--health 는 닫힌 날에 보관값을 쓰고(원천이 지워져도 유지), 정의 번호가 다르면 원천으로 다시 센다', () => {
    rule('base');
    const e = correction('2026-11-17T10:00:00Z');
    recordClosedDays({ limit: 2, now: NOW });
    fs.unlinkSync(path.join(TMP_HOME, 'me', 'behavior', `${e}.json`)); // 원천 삭제
    let h = healthWithHistory({ days: 3, now: NOW, record: false });
    const d17 = h.days.find((d) => d.day === '2026-11-17')!;
    expect(d17).toMatchObject({ correctionsUser: 1, source: 'closed' });
    expect(h.days.at(-1)).toMatchObject({ day: '2026-11-18', source: 'live' });
    expect(h.history.oldestDay).toBe('2026-11-16');
    const f = path.join(dailyDir(), '2026-11-17.json');
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf-8')), definition: DEFINITION + 1 }));
    h = healthWithHistory({ days: 3, now: NOW, record: false });
    expect(h.days.find((d) => d.day === '2026-11-17')).toMatchObject({ correctionsUser: 0, source: 'live' });
  });

  it('--history 는 룰별 하루 스냅숏, --rule 로 거른다', () => {
    rule('aaa1'); rule('bbb2');
    recordClosedDays({ limit: 1, now: NOW });
    const h = buildRuleHistory({ days: 5, now: NOW });
    expect(h.schema).toBe('forgen-rule-history/v1');
    expect(h.days).toHaveLength(1);
    expect(buildRuleHistory({ days: 5, rule: 'bbb', now: NOW }).days[0].rows.map((r) => r[0])).toEqual(['bbb2']);
  });
});

describe('status --html', () => {
  it('룰 문구의 </script>·HTML 이 스크립트를 끊지 못하고, 외부 리소스를 부르지 않는다', () => {
    const evil = '</script><script>alert(1)</script><img src=x onerror=alert(2)>  ';
    const html = renderStatusHtml({ ruleList: { rules: [{ statement: evil }] } });
    const dataBlock = html.split('<script type="application/json" id="forgen-data">')[1].split('</script>')[0];
    expect(dataBlock).not.toContain('<');
    expect(JSON.parse(dataBlock).ruleList.rules[0].statement).toBe(evil);
    expect(embedJson('a&b>c')).toBe('"a\\u0026b\\u003ec"');
    expect(html).toContain("default-src 'none'");
    const urls = html.match(/(?:src|href)\s*=\s*["']?https?:/gi) ?? [];
    expect(urls).toHaveLength(0);
    expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest|navigator\.sendBeacon|new WebSocket/);
  });
});

describe('0.7.2 status --events', () => {
  it('차단·우회·오탐·교정·솔루션 사건과 세션 목록, 문구 없음, 합성 세션·창 밖 제외', async () => {
    const { buildEvents, EVENTS_SCHEMA } = await import('../src/core/events-json.js');
    const enf = path.join(TMP_HOME, 'state', 'enforcement');
    fs.mkdirSync(enf, { recursive: true });
    const v = (o: Record<string, unknown>) => JSON.stringify({ violation_id: 'v-' + Math.random(), rule_id: 'r1', session_id: SID, source: 'stop-guard', message_preview: 'SECRET TEXT', ...o });
    fs.writeFileSync(path.join(enf, 'violations.jsonl'), [
      v({ at: '2026-11-17T01:00:00Z', kind: 'block', violation_id: 'vb' }),
      v({ at: '2026-11-17T02:00:00Z', kind: 'bypass_confirmed' }),
      v({ at: '2026-11-17T03:00:00Z', kind: 'correction' }), // 자문 — 사건 아님
      v({ at: '2026-11-17T04:00:00Z', kind: 'deny', session_id: 'default' }), // 합성 세션
      v({ at: '2026-10-01T00:00:00Z', kind: 'block' }), // 창 밖
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(enf, 'verdicts.jsonl'), JSON.stringify({ at: '2026-11-17T05:00:00Z', violation_id: 'vb', rule_id: 'r1', verdict: 'false_positive', reason: 'SECRET REASON' }) + '\n');
    correction('2026-11-17T06:00:00Z', 'SECRET QUOTE');
    const e = createEvidence({ type: 'explicit_correction', session_id: SID, source_component: 'auto-compound-miner', summary: 'SECRET MINED', confidence: 0.5, candidate_rule_refs: ['r9'] });
    saveEvidence({ ...e, timestamp: '2026-11-17T07:00:00Z' });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(TMP_HOME, 'sessions.db'));
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, started_at TEXT NOT NULL, message_count INTEGER DEFAULT 0);
      CREATE TABLE solution_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_id TEXT, solution_id TEXT NOT NULL, event_type TEXT NOT NULL);`);
    db.prepare('INSERT INTO sessions (id,cwd,started_at) VALUES (?,?,?)').run(SID, '/w/proj', '2026-11-17T00:30:00.000Z');
    db.prepare('INSERT INTO sessions (id,cwd,started_at) VALUES (?,?,?)').run('old', '/w/old', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO solution_events (ts,session_id,solution_id,event_type) VALUES (?,?,?,?)').run(Date.parse('2026-11-17T08:00:00Z'), SID, 'secret-solution-name', 'acted_on');
    db.close();

    const r = buildEvents({ since: Date.parse('2026-11-16T00:00:00Z'), now: NOW });
    expect(r.schema).toBe(EVENTS_SCHEMA);
    expect(r.sources).toEqual({ enforcement: true, evidence: true, sessionsDb: true });
    expect(r.events.map((x) => [x.kind, x.sessionId, x.ruleId])).toEqual([
      ['block', SID, 'r1'], ['bypass', SID, 'r1'], ['false_positive', SID, 'r1'],
      ['correction_user', SID, null], ['correction_mined', SID, 'r9'], ['solution_acted_on', SID, null],
    ]);
    expect(r.sessions).toEqual([{ id: SID, cwd: '/w/proj', startedAt: '2026-11-17T00:30:00.000Z' }]);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|secret-solution/);
  });
});

describe('0.7.2 top.blockingAll', () => {
  it('모든 룰의 창 안 차단 수, 닫힌 날은 보관값(원천이 지워져도 유지)', () => {
    rule('base');
    const enf = path.join(TMP_HOME, 'state', 'enforcement');
    fs.mkdirSync(enf, { recursive: true });
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(JSON.stringify({ at: '2026-11-17T01:00:00Z', kind: 'block', rule_id: `r${i}`, session_id: SID }));
    lines.push(JSON.stringify({ at: '2026-11-17T02:00:00Z', kind: 'block', rule_id: 'r0', session_id: SID }));
    fs.writeFileSync(path.join(enf, 'violations.jsonl'), lines.join('\n') + '\n');
    recordClosedDays({ limit: 2, now: NOW });
    expect(readDaily('2026-11-17')!.blocksByRule).toMatchObject({ r0: 2, r9: 1 });
    fs.writeFileSync(path.join(enf, 'violations.jsonl'), ''); // 원천 회전·삭제
    const h = healthWithHistory({ days: 3, now: NOW, record: false });
    expect(h.top.blockingAll).toHaveLength(10);
    expect(h.top.blockingAll[0]).toEqual({ ruleId: 'r0', blocks: 2 });
    expect(h.top.blocking).toHaveLength(0); // 상위 8개 목록은 원천 기준 그대로
  });
});
