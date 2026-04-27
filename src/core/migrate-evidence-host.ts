/**
 * Forgen — Evidence Host Backfill Migration
 *
 * spec §10 우선순위 5 + §4.2:
 * 사용자가 명시적으로 디스크의 evidence 파일에 host 필드를 박제하고 싶을 때 사용.
 * (마이그레이션 박제, audit 목적)
 *
 * loadEvidence 의 자동 backfill (evidence-store.ts::backfillHost) 과는 독립.
 * 이 모듈은 디스크 파일을 직접 수정하는 명시적 경로.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ME_BEHAVIOR } from './paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';

export interface MigrateEvidenceHostOptions {
  /** backfill 할 host 값 (host 필드 없는 파일에만 적용) */
  defaultHost: 'claude' | 'codex';
  /**
   * true 이면 디스크를 수정하지 않고 카운트만 반환.
   * @default false
   */
  dryRun?: boolean;
}

export interface MigrateEvidenceHostResult {
  /** host 필드를 새로 추가한 파일 수 */
  migrated: number;
  /** 처리 대상 전체 .json 파일 수 */
  total: number;
  /** 이미 host 필드가 있어 건너뛴 파일 수 */
  skipped: number;
}

/**
 * `~/.forgen/me/behavior/*.json` 을 순회하여 host 필드가 없는 파일에
 * `defaultHost` 를 추가한다.
 *
 * - dryRun=true 이면 디스크 미수정, 카운트만 반환.
 * - 이미 host 필드가 있는 파일은 건너뜀 (idempotent).
 * - 파싱 실패 / host 필드가 아닌 값인 파일도 건너뜀 (안전).
 */
export function migrateEvidenceHost(
  options: MigrateEvidenceHostOptions,
): MigrateEvidenceHostResult {
  const { defaultHost, dryRun = false } = options;

  if (!fs.existsSync(ME_BEHAVIOR)) {
    return { migrated: 0, total: 0, skipped: 0 };
  }

  const files = fs.readdirSync(ME_BEHAVIOR).filter((f) => f.endsWith('.json'));
  let migrated = 0;
  let skipped = 0;

  for (const file of files) {
    const filePath = path.join(ME_BEHAVIOR, file);
    const data = safeReadJSON<Record<string, unknown> | null>(filePath, null);

    if (data === null || typeof data !== 'object') {
      skipped++;
      continue;
    }

    const host = data['host'];
    if (host === 'claude' || host === 'codex') {
      skipped++;
      continue;
    }

    if (!dryRun) {
      atomicWriteJSON(filePath, { ...data, host: defaultHost }, { pretty: true });
    }
    migrated++;
  }

  return { migrated, total: files.length, skipped };
}
