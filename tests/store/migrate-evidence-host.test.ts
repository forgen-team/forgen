/**
 * migrateEvidenceHost — unit tests
 *
 * FORGEN_HOME 은 paths 모듈 로드 시점에 캡처되므로,
 * 각 test 는 FORGEN_HOME 을 설정한 뒤 vi.resetModules() + 동적 import 로 격리.
 * (host-tagged-evidence.test.ts 의 vi.resetModules 패턴 참고)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MigrateMod = typeof import('../../src/core/migrate-evidence-host.js');

async function reloadMigrate(): Promise<MigrateMod> {
  vi.resetModules();
  return (await import('../../src/core/migrate-evidence-host.js')) as MigrateMod;
}

let originalForgenHome: string | undefined;
let isolatedHome: string;
let behaviorDir: string;

beforeEach(() => {
  originalForgenHome = process.env.FORGEN_HOME;
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-migrate-host-'));
  behaviorDir = path.join(isolatedHome, 'me', 'behavior');
  fs.mkdirSync(behaviorDir, { recursive: true });
  process.env.FORGEN_HOME = isolatedHome;
});

afterEach(() => {
  if (originalForgenHome === undefined) delete process.env.FORGEN_HOME;
  else process.env.FORGEN_HOME = originalForgenHome;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

/** host 필드 없는 evidence JSON 작성 헬퍼 */
function writeNoHost(id: string): void {
  const data = {
    evidence_id: id,
    type: 'behavior_observation',
    session_id: 'sess-test',
    timestamp: '2026-01-01T00:00:00Z',
    source_component: 'test',
    summary: `legacy evidence ${id} without host field`,
    axis_refs: [],
    candidate_rule_refs: [],
    confidence: 0.5,
    raw_payload: {},
  };
  fs.writeFileSync(path.join(behaviorDir, `${id}.json`), JSON.stringify(data, null, 2));
}

/** host 필드 있는 evidence JSON 작성 헬퍼 */
function writeWithHost(id: string, host: 'claude' | 'codex'): void {
  const data = {
    evidence_id: id,
    type: 'behavior_observation',
    session_id: 'sess-test',
    timestamp: '2026-01-01T00:00:00Z',
    source_component: 'test',
    summary: `evidence ${id} with host=${host}`,
    axis_refs: [],
    candidate_rule_refs: [],
    confidence: 0.5,
    raw_payload: {},
    host,
  };
  fs.writeFileSync(path.join(behaviorDir, `${id}.json`), JSON.stringify(data, null, 2));
}

describe('migrateEvidenceHost', () => {
  it('host 없는 3건 migrated=3, host 있는 2건 skipped=2', async () => {
    writeNoHost('ev-no-1');
    writeNoHost('ev-no-2');
    writeNoHost('ev-no-3');
    writeWithHost('ev-has-1', 'claude');
    writeWithHost('ev-has-2', 'codex');

    const mod = await reloadMigrate();
    const result = mod.migrateEvidenceHost({ defaultHost: 'claude' });

    expect(result.migrated).toBe(3);
    expect(result.skipped).toBe(2);
    expect(result.total).toBe(5);
  });

  it('두 번째 호출 → migrated=0 (idempotent)', async () => {
    writeNoHost('ev-no-1');
    writeNoHost('ev-no-2');
    writeNoHost('ev-no-3');
    writeWithHost('ev-has-1', 'claude');
    writeWithHost('ev-has-2', 'codex');

    const mod = await reloadMigrate();
    mod.migrateEvidenceHost({ defaultHost: 'claude' });

    // 두 번째 호출 — 이미 backfill 됨
    vi.resetModules();
    const mod2 = (await import('../../src/core/migrate-evidence-host.js')) as MigrateMod;
    const result2 = mod2.migrateEvidenceHost({ defaultHost: 'claude' });

    expect(result2.migrated).toBe(0);
    expect(result2.skipped).toBe(5);
    expect(result2.total).toBe(5);
  });

  it('dryRun=true 시 디스크 미수정', async () => {
    writeNoHost('ev-dry-1');
    writeNoHost('ev-dry-2');

    const mod = await reloadMigrate();
    const result = mod.migrateEvidenceHost({ defaultHost: 'claude', dryRun: true });

    expect(result.migrated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.total).toBe(2);

    // 디스크 파일에 host 필드가 없어야 함
    const raw1 = JSON.parse(fs.readFileSync(path.join(behaviorDir, 'ev-dry-1.json'), 'utf-8')) as Record<string, unknown>;
    const raw2 = JSON.parse(fs.readFileSync(path.join(behaviorDir, 'ev-dry-2.json'), 'utf-8')) as Record<string, unknown>;
    expect(raw1['host']).toBeUndefined();
    expect(raw2['host']).toBeUndefined();
  });

  it('behavior 디렉토리가 없으면 total=0 반환', async () => {
    // behaviorDir 을 삭제하여 없는 상태로 만듦
    fs.rmSync(behaviorDir, { recursive: true, force: true });

    const mod = await reloadMigrate();
    const result = mod.migrateEvidenceHost({ defaultHost: 'claude' });

    expect(result.migrated).toBe(0);
    expect(result.total).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
