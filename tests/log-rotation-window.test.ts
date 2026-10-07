/**
 * 측정 부채(ADR-017 §9): 회전된 로그가 창 기반 리더에서 사라지던 결함 + 회전본 영구 보존 +
 * lifecycle 카운터(violation_count/bypass_count) 미갱신.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  rotateIfBig, listRotated, logFilesWithin, readJsonlWindow, deriveRuleCounters,
  ROTATED_KEEP_MAX, ROTATED_KEEP_DAYS,
} from '../src/engine/lifecycle/signals.js';
import { pruneRotatedEnforcementLogs, pruneState } from '../src/core/state-gc.js';
import type { ViolationEntry } from '../src/engine/lifecycle/types.js';

const DAY = 24 * 3600 * 1000;
let dir: string;

function put(p: string, lines: unknown[], mtimeMs?: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (mtimeMs) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-logwin-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('회전본을 읽는 창 리더', () => {
  it('rotateIfBig 직후에도 현재 파일 + 회전본에서 창 안 기록을 모두 읽는다', () => {
    const p = path.join(dir, 'violations.jsonl');
    fs.writeFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), rule_id: 'R', n: 1 })}\n${' '.repeat(10 * 1024 * 1024 + 1)}`);
    rotateIfBig(p);
    expect(fs.existsSync(p)).toBe(false);
    expect(listRotated(p)).toHaveLength(1);
    fs.appendFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), rule_id: 'R', n: 2 })}\n`);
    const rows = readJsonlWindow<{ n: number }>(p, 7);
    expect(rows.map((r) => r.n)).toEqual([1, 2]); // 오래된 회전본 먼저, 현재 파일 마지막
  });

  it('mtime 이 창 밖인 회전본은 읽지 않고, 회전본 아닌 이름은 무시한다', () => {
    const p = path.join(dir, 'violations.jsonl');
    const now = Date.now();
    put(`${p}.${now - 40 * DAY}`, [{ n: 'old' }], now - 40 * DAY);
    put(`${p}.${now - 3 * DAY}`, [{ n: 'mid' }], now - 3 * DAY);
    put(`${p}.bak`, [{ n: 'bak' }]);
    put(`${p}.1`, [{ n: 'short-suffix' }]);
    put(p, [{ n: 'cur' }]);
    expect(readJsonlWindow<{ n: string }>(p, 7, now).map((r) => r.n)).toEqual(['mid', 'cur']);
    expect(readJsonlWindow<{ n: string }>(p, 60, now).map((r) => r.n)).toEqual(['old', 'mid', 'cur']);
    expect(logFilesWithin(p, 7, now)).toHaveLength(2);
  });

  it('현재 파일이 없어도(회전 직후) 회전본만으로 읽힌다', () => {
    const p = path.join(dir, 'drift.jsonl');
    put(`${p}.${Date.now()}`, [{ n: 1 }]);
    expect(readJsonlWindow(p, 30)).toHaveLength(1);
  });
});

describe('회전본 보존 상한 (state-gc)', () => {
  it('로그당 최신 3개 + 60일 이내만 남기고 현재 파일은 건드리지 않는다', () => {
    const state = path.join(dir, 'state');
    const enf = path.join(state, 'enforcement');
    const now = Date.now();
    const p = path.join(enf, 'violations.jsonl');
    put(p, [{ n: 'cur' }]);
    for (const d of [1, 2, 3, 4, 5]) put(`${p}.${now - d * DAY}`, [{ d }], now - d * DAY);
    put(`${p}.${now - 90 * DAY}`, [{ d: 90 }], now - 90 * DAY);
    const dryRun = pruneRotatedEnforcementLogs({ stateDir: state, dryRun: true, now });
    expect(dryRun.pruned).toBe(3); // 4일·5일(개수 초과) + 90일
    expect(listRotated(p)).toHaveLength(6); // dry-run 은 삭제 안 함
    const r = pruneRotatedEnforcementLogs({ stateDir: state, dryRun: false, now });
    expect(r.pruned).toBe(3);
    expect(listRotated(p)).toHaveLength(ROTATED_KEEP_MAX);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('3개 이하여도 60일 넘은 회전본은 지우고 pruneState 가 이를 호출한다', () => {
    const state = path.join(dir, 'state');
    const p = path.join(state, 'enforcement', 'checks.jsonl');
    const now = Date.now();
    put(`${p}.${now - (ROTATED_KEEP_DAYS + 5) * DAY}`, [{ x: 1 }], now - (ROTATED_KEEP_DAYS + 5) * DAY);
    put(`${p}.${now - DAY}`, [{ x: 2 }], now - DAY);
    const rep = pruneState({ stateDir: state, outcomesDir: path.join(state, 'outcomes'), dryRun: false, now });
    expect(rep.pruned).toBe(1);
    expect(listRotated(p)).toHaveLength(1);
  });
});

describe('lifecycle 카운터는 로그에서 파생', () => {
  const v = (o: Partial<ViolationEntry>): ViolationEntry => ({ at: '2026-10-01T00:00:00.000Z', rule_id: 'R1', session_id: 's1', source: 'x', kind: 'block', ...o } as ViolationEntry);

  it('실차단/명시 우회만 세고 합성 세션·correction 은 제외한다', () => {
    const m = deriveRuleCounters([
      v({}), v({ at: '2026-10-03T00:00:00.000Z' }), v({ kind: 'deny' }),
      v({ session_id: 'default' }), v({ kind: 'correction' }),
      v({ kind: 'bypass_confirmed' }), v({ rule_id: 'R2' }),
    ]);
    expect(m.get('R1')).toEqual({ violation_count: 3, bypass_count: 1, last_violation_at: '2026-10-03T00:00:00.000Z' });
    expect(m.get('R2')?.violation_count).toBe(1);
  });
});

describe('rule-store: project override 가 로컬 lifecycle 을 지우지 않는다 / 카운터 동기화', () => {
  let home: string;
  let proj: string;
  beforeEach(() => {
    home = path.join(dir, 'home');
    proj = path.join(dir, 'proj');
    vi.resetModules();
    vi.stubEnv('FORGEN_HOME', home);
    vi.stubEnv('FORGEN_CWD', proj);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  const base = (lifecycle: unknown) => ({
    rule_id: 'L1-x', category: 'safety', scope: 'me', trigger: 't', policy: 'p', strength: 'hard', source: 'explicit_correction',
    status: 'active', evidence_refs: [], render_key: 'k', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', lifecycle,
  });
  const lc = (inject: number) => ({ phase: 'active', first_active_at: '2026-01-01T00:00:00.000Z', inject_count: inject, accept_count: 0, violation_count: 0, bypass_count: 0, conflict_refs: [], meta_promotions: [] });

  it('loadAllRules: project 룰이 me 룰을 덮어써도 me 의 inject_count 를 유지한다', async () => {
    fs.mkdirSync(path.join(home, 'me', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.forgen', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(home, 'me', 'rules', 'L1-x.json'), JSON.stringify(base(lc(33))));
    fs.writeFileSync(path.join(proj, '.forgen', 'rules', 'L1-x.json'), JSON.stringify(base(lc(0))));
    const { loadAllRules } = await import('../src/store/rule-store.js');
    expect(loadAllRules().find((r) => r.rule_id === 'L1-x')?.lifecycle?.inject_count).toBe(33);
  });

  it('syncRuleCounters: 카운터만 갱신(updated_at/inject_count 보존), 동일 값이면 쓰지 않는다', async () => {
    fs.mkdirSync(path.join(home, 'me', 'rules'), { recursive: true });
    const f = path.join(home, 'me', 'rules', 'L1-x.json');
    fs.writeFileSync(f, JSON.stringify(base(lc(33))));
    const { syncRuleCounters } = await import('../src/store/rule-store.js');
    const c = { violation_count: 82, bypass_count: 2, last_violation_at: '2026-10-06T00:00:00.000Z' };
    expect(syncRuleCounters('L1-x', c)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(f, 'utf-8'));
    expect(saved.lifecycle).toMatchObject({ inject_count: 33, violation_count: 82, bypass_count: 2, last_violation_at: c.last_violation_at });
    expect(saved.updated_at).toBe('2026-01-02T00:00:00.000Z');
    expect(syncRuleCounters('L1-x', c)).toBe(false);
  });
});
