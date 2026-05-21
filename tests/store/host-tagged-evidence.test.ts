/**
 * Host-tagged evidence + mismatch demote — Multi-Host Core Design §10 우선순위 5
 *
 * 검증:
 *   - createEvidence 가 host 필드를 자동 추론 (explicit → FORGEN_HOST → CODEX_HOME → claude default).
 *   - loadAllEvidence 가 host 미지정 데이터에 'claude' 를 backfill.
 *   - summarizeNegativeSignalsForRef 가 host 분포와 demoteRecommended 를 정확히 산출.
 *
 * FORGEN_HOME 은 paths 모듈 로드 시점에 캡처되므로, 각 test 는 FORGEN_HOME 을 잡은 뒤
 * vi.resetModules() + 동적 import 로 격리한다.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type EvidenceMod = typeof import('../../src/store/evidence-store.js');
type HostMismatchMod = typeof import('../../src/store/host-mismatch.js');

async function reloadStore(): Promise<{ ev: EvidenceMod; hm: HostMismatchMod }> {
  vi.resetModules();
  const ev = (await import('../../src/store/evidence-store.js')) as EvidenceMod;
  const hm = (await import('../../src/store/host-mismatch.js')) as HostMismatchMod;
  return { ev, hm };
}

let originalForgenHome: string | undefined;
let originalForgenHost: string | undefined;
let originalCodexHome: string | undefined;
let isolatedHome: string;

let originalForgenRuntime: string | undefined;

beforeEach(() => {
  originalForgenHome = process.env.FORGEN_HOME;
  originalForgenHost = process.env.FORGEN_HOST;
  originalCodexHome = process.env.CODEX_HOME;
  originalForgenRuntime = process.env.FORGEN_RUNTIME;
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-evidence-host-'));
  process.env.FORGEN_HOME = isolatedHome;
  delete process.env.FORGEN_HOST;
  delete process.env.CODEX_HOME;
  delete process.env.FORGEN_RUNTIME;
});

afterEach(() => {
  if (originalForgenHome === undefined) delete process.env.FORGEN_HOME;
  else process.env.FORGEN_HOME = originalForgenHome;
  if (originalForgenHost === undefined) delete process.env.FORGEN_HOST;
  else process.env.FORGEN_HOST = originalForgenHost;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalForgenRuntime === undefined) delete process.env.FORGEN_RUNTIME;
  else process.env.FORGEN_RUNTIME = originalForgenRuntime;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

const LONG_SUMMARY = 'long enough summary text for behavior observation gate';

describe('createEvidence host detection', () => {
  it('explicit host param 우선', async () => {
    const { ev: store } = await reloadStore();
    const e = store.createEvidence({
      type: 'behavior_observation',
      session_id: 's1',
      source_component: 't',
      summary: LONG_SUMMARY,
      confidence: 0.5,
      host: 'codex',
    });
    expect(e.host).toBe('codex');
  });

  it('FORGEN_HOST env 가 두 번째 우선순위', async () => {
    process.env.FORGEN_HOST = 'codex';
    const { ev: store } = await reloadStore();
    const e = store.createEvidence({
      type: 'behavior_observation',
      session_id: 's1',
      source_component: 't',
      summary: LONG_SUMMARY,
      confidence: 0.5,
    });
    expect(e.host).toBe('codex');
  });

  it('v0.4.10 fix — FORGEN_RUNTIME=codex 가 세 번째 우선순위', async () => {
    // Codex harness 세션의 auto-compound-runner 가 FORGEN_HOST 없이 동작하면
    // 그동안 'claude' 로 잘못 태깅 → 98/2 격차. config-injector.ts:479 가
    // 주입하는 FORGEN_RUNTIME 을 detectHost 가 읽어야 정상.
    process.env.FORGEN_RUNTIME = 'codex';
    const { ev: store } = await reloadStore();
    const e = store.createEvidence({
      type: 'behavior_observation',
      session_id: 's1',
      source_component: 'auto-compound-runner',
      summary: LONG_SUMMARY,
      confidence: 0.5,
    });
    expect(e.host).toBe('codex');
  });

  it('FORGEN_HOST 가 FORGEN_RUNTIME 보다 우선', async () => {
    process.env.FORGEN_HOST = 'claude';
    process.env.FORGEN_RUNTIME = 'codex';
    const { ev: store } = await reloadStore();
    const e = store.createEvidence({
      type: 'behavior_observation',
      session_id: 's1',
      source_component: 't',
      summary: LONG_SUMMARY,
      confidence: 0.5,
    });
    expect(e.host).toBe('claude');
  });

  it('CODEX_HOME 이 보이면 codex 추론', async () => {
    process.env.CODEX_HOME = '/tmp/.codex-test';
    const { ev: store } = await reloadStore();
    const e = store.createEvidence({
      type: 'behavior_observation',
      session_id: 's1',
      source_component: 't',
      summary: LONG_SUMMARY,
      confidence: 0.5,
    });
    expect(e.host).toBe('codex');
  });

  it('default 는 claude (1원칙)', async () => {
    const { ev: store } = await reloadStore();
    const e = store.createEvidence({
      type: 'behavior_observation',
      session_id: 's1',
      source_component: 't',
      summary: LONG_SUMMARY,
      confidence: 0.5,
    });
    expect(e.host).toBe('claude');
  });
});

describe('loadEvidence backfill', () => {
  it('host 가 없는 기존 evidence 는 claude 로 backfill', async () => {
    const behaviorDir = path.join(isolatedHome, 'me', 'behavior');
    fs.mkdirSync(behaviorDir, { recursive: true });
    const legacy = {
      evidence_id: 'legacy-1',
      type: 'behavior_observation',
      session_id: 's-legacy',
      timestamp: '2026-01-01T00:00:00Z',
      source_component: 'test',
      summary: 'legacy evidence without host field — backfill expected',
      axis_refs: [],
      candidate_rule_refs: [],
      confidence: 0.5,
      raw_payload: {},
    };
    fs.writeFileSync(path.join(behaviorDir, 'legacy-1.json'), JSON.stringify(legacy));

    const { hm } = await reloadStore();
    const stats = hm.summarizeAllByHost();
    expect(stats.claude).toBe(1);
    expect(stats.codex).toBe(0);
  });
});

describe('summarizeNegativeSignalsForRef — demote 신호', () => {
  async function pushEvidence(
    store: EvidenceMod,
    host: 'claude' | 'codex',
    refId: string,
    summary: string,
  ): Promise<void> {
    const e = store.createEvidence({
      type: 'behavior_observation',
      session_id: `sess-${host}`,
      source_component: 'mismatch-test',
      summary,
      confidence: 0.5,
      candidate_rule_refs: [refId],
      raw_payload: { ref: refId },
      host,
    });
    store.saveEvidence(e);
  }

  it('한 host 에 80%+ 부정 신호 집중 시 demoteRecommended=true', async () => {
    const { ev: store, hm } = await reloadStore();
    const ref = 'sol:test-rule-claude-fragile';
    for (let i = 0; i < 5; i += 1) {
      await pushEvidence(store, 'codex', ref, `drift detected on rule ${ref} attempt ${i}`);
    }
    const summary = hm.summarizeNegativeSignalsForRef(ref);
    expect(summary.total).toBe(5);
    expect(summary.byHost.codex).toBe(5);
    expect(summary.byHost.claude).toBe(0);
    expect(summary.dominantHost).toBe('codex');
    expect(summary.skew).toBe(1);
    expect(summary.demoteRecommended).toBe(true);
  });

  it('표본 < MIN_TOTAL_FOR_DEMOTE 면 demoteRecommended=false', async () => {
    const { ev: store, hm } = await reloadStore();
    const ref = 'sol:tiny-sample';
    await pushEvidence(store, 'codex', ref, `revert detected on ${ref}`);
    const summary = hm.summarizeNegativeSignalsForRef(ref);
    expect(summary.total).toBe(1);
    expect(summary.demoteRecommended).toBe(false);
  });

  it('balanced 분포 (claude 50% / codex 50%) 는 demote 권고 없음', async () => {
    const { ev: store, hm } = await reloadStore();
    const ref = 'sol:balanced';
    for (let i = 0; i < 5; i += 1) {
      await pushEvidence(store, 'claude', ref, `regress detected ${ref} run ${i}`);
      await pushEvidence(store, 'codex', ref, `regress detected ${ref} run ${i}`);
    }
    const summary = hm.summarizeNegativeSignalsForRef(ref);
    expect(summary.total).toBe(10);
    expect(summary.skew).toBeCloseTo(0.5, 2);
    expect(summary.demoteRecommended).toBe(false);
  });

  it('튜닝 상수 invariant — 임계값 변경 시 회귀 감지', async () => {
    const { hm } = await reloadStore();
    expect(hm.HOST_MISMATCH_TUNING.DOMINANCE_THRESHOLD).toBe(0.8);
    expect(hm.HOST_MISMATCH_TUNING.MIN_TOTAL_FOR_DEMOTE).toBe(5);
  });
});
