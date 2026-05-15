/**
 * Forgen v0.4.1 — Implicit Feedback Store (TEST-5)
 *
 * `~/.forgen/state/implicit-feedback.jsonl` 의 append/read.
 *
 * TEST-5 / RC5: 누적된 엔트리들이 `type` 문자열만 가지고 category 없이 섞여 있어
 *   - drift_critical / drift_warning / revert_detected / repeated_edit / agent_* 가 한 스트림에 섞여
 *   - 집계/쿼리 시 카테고리 enum 부재로 휴리스틱 문자열 매칭에 의존
 *   - 스키마 검증이 없어 빈/잘못된 필드로 쓰여도 나중에 분석 불가
 * 이 모듈은 category 필드를 **필수화**하고, 기존 레거시 라인은 read 시 `type→category`
 * 백필로 보정한다. 새 write 는 category 없으면 drift/revert 계열은 **거부**한다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from '../core/paths.js';

export const IMPLICIT_FEEDBACK_LOG = path.join(STATE_DIR, 'implicit-feedback.jsonl');

/**
 * TEST-5/H4: 카테고리 enum.
 *  - drift / revert: 네거티브 signal (schema 강제)
 *  - edit / agent: 네거티브-ish signal (휴리스틱)
 *  - positive: H4 양수 신호 — assist (recommendation_surfaced, recall_referenced)
 */
export type ImplicitFeedbackCategory = 'drift' | 'revert' | 'edit' | 'agent' | 'positive';

export interface ImplicitFeedbackEntry {
  type: string;
  category: ImplicitFeedbackCategory;
  sessionId?: string;
  at: string;
  [key: string]: unknown;
}

/** 호출지 입력 — category 선택적 (schema 가 허용하면 inference 로 채움). */
export interface ImplicitFeedbackInput {
  type: string;
  category?: ImplicitFeedbackCategory;
  sessionId?: string;
  at: string;
  [key: string]: unknown;
}

/** type → category 추론. 레거시 엔트리 마이그레이션과 호출지 기본값 계산에 공용. */
export function inferCategoryFromType(type: string): ImplicitFeedbackCategory | null {
  if (type === 'drift_critical' || type === 'drift_warning') return 'drift';
  if (type === 'revert_detected') return 'revert';
  if (type === 'repeated_edit') return 'edit';
  if (type.startsWith('agent_')) return 'agent';
  // H4: 양수 assist 신호 — 솔루션이 사용자에게 노출/참조되었음을 기록.
  if (type === 'recommendation_surfaced' || type === 'recall_referenced') return 'positive';
  return null;
}

/**
 * TEST-5 스키마 검증 — drift/revert 계열은 category 누락 시 쓰기 거부.
 * agent/edit 은 fail-open (기존 호출지가 빠뜨려도 로깅 자체는 보존), 대신 inference
 * 가 가능하면 자동 보정.
 */
function validateAndNormalize(entry: ImplicitFeedbackInput): ImplicitFeedbackEntry | null {
  if (!entry.type || !entry.at) return null;
  const inferred = inferCategoryFromType(entry.type);
  const category = entry.category ?? inferred;

  // drift/revert/positive 는 schema 강제: 명시든 추론이든 올바른 카테고리여야 함.
  if (entry.type === 'drift_critical' || entry.type === 'drift_warning') {
    if (category !== 'drift') return null;
  }
  if (entry.type === 'revert_detected') {
    if (category !== 'revert') return null;
  }
  if (entry.type === 'recommendation_surfaced' || entry.type === 'recall_referenced') {
    if (category !== 'positive') return null;
  }
  if (!category) return null;

  return { ...entry, category };
}

/**
 * TEST-5 메인 라이터. 내부에서 스키마 검증 후 append.
 * drift/revert 스키마 위반 시 silent drop (hot path 에서 throw 금지).
 * 반환값: 실제로 기록되었는지 (테스트 검증용).
 */
export function appendImplicitFeedback(entry: ImplicitFeedbackInput): boolean {
  const normalized = validateAndNormalize(entry);
  if (!normalized) return false;

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(IMPLICIT_FEEDBACK_LOG, `${JSON.stringify(normalized)}\n`);
    return true;
  } catch {
    // fail-open: implicit feedback recording must not throw.
    return false;
  }
}

/**
 * TEST-5 리더. 세션 필터링 + 레거시 라인에 대한 lazy 마이그레이션 (category 백필).
 * 디스크 상 파일은 건드리지 않고 읽기 시점에만 category 를 보정한다 — atomic-write
 * 없이 append-only 로그를 rewrite 하면 race 위험이 있기 때문.
 * 영구 백필은 `migrateImplicitFeedbackLog()` 를 명시적으로 호출한다.
 */
export function loadImplicitFeedback(sessionId: string): ImplicitFeedbackEntry[] {
  try {
    if (!fs.existsSync(IMPLICIT_FEEDBACK_LOG)) return [];
    const lines = fs.readFileSync(IMPLICIT_FEEDBACK_LOG, 'utf-8').split('\n').filter(Boolean);
    const entries: ImplicitFeedbackEntry[] = [];
    for (const line of lines) {
      try {
        const raw = JSON.parse(line) as Partial<ImplicitFeedbackEntry>;
        if (raw.sessionId !== sessionId) continue;
        if (!raw.type || !raw.at) continue;
        const category = raw.category ?? inferCategoryFromType(raw.type);
        if (!category) continue;
        entries.push({ ...(raw as ImplicitFeedbackEntry), category });
      } catch {
        /* skip malformed lines */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * 영구 마이그레이션 — 레거시 로그 파일을 읽어 category 백필 후 원자적으로 재기록.
 * 마이그레이션 불가 라인 (type 도 category 도 없거나 inference 실패) 은 drop.
 * 반환: { migrated: 백필된 라인 수, dropped: 버려진 라인 수 }
 */
export function migrateImplicitFeedbackLog(): { migrated: number; dropped: number } {
  if (!fs.existsSync(IMPLICIT_FEEDBACK_LOG)) return { migrated: 0, dropped: 0 };

  const lines = fs.readFileSync(IMPLICIT_FEEDBACK_LOG, 'utf-8').split('\n').filter(Boolean);
  const out: string[] = [];
  let migrated = 0;
  let dropped = 0;

  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as Partial<ImplicitFeedbackEntry>;
      if (!raw.type || !raw.at) {
        dropped++;
        continue;
      }
      if (raw.category) {
        out.push(JSON.stringify(raw));
        continue;
      }
      const inferred = inferCategoryFromType(raw.type);
      if (!inferred) {
        dropped++;
        continue;
      }
      const repaired = { ...raw, category: inferred } as ImplicitFeedbackEntry;
      out.push(JSON.stringify(repaired));
      migrated++;
    } catch {
      dropped++;
    }
  }

  // atomic replace via temp file
  const tmp = `${IMPLICIT_FEEDBACK_LOG}.migrate.${process.pid}`;
  fs.writeFileSync(tmp, out.length > 0 ? `${out.join('\n')}\n` : '');
  fs.renameSync(tmp, IMPLICIT_FEEDBACK_LOG);

  return { migrated, dropped };
}
