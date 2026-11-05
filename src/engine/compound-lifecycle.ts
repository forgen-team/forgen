import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../core/logger.js';
import type { RetiredReason, SolutionFrontmatter, SolutionStatus } from './solution-format.js';
import { parseFrontmatterOnly, parseSolutionV3 } from './solution-format.js';
import { defaultSolutionDirs } from './solution-index.js';
import { mutateSolutionFile } from './solution-writer.js';

const log = createLogger('compound-lifecycle');

import { ME_RULES, ME_SOLUTIONS, META_LEARNING_DIR } from '../core/paths.js';
import { safeReadJSON } from '../hooks/shared/atomic-write.js';
import type { AdaptiveLifecycleThresholds } from './meta-learning/types.js';

/** Circuit breaker negative thresholds by status */
const CIRCUIT_BREAKER_THRESHOLDS: Record<string, number> = {
  experiment: 2,
  candidate: 3,
  verified: 4,
};

/** Minimum age (ms) before promotion is allowed */
const MIN_AGE_FOR_PROMOTION: Record<string, number> = {
  experiment: 7 * 24 * 60 * 60 * 1000, // 7 days
  candidate: 14 * 24 * 60 * 60 * 1000, // 14 days
  verified: 7 * 24 * 60 * 60 * 1000, // 7 days (prevents instant mature)
};

export interface LifecycleResult {
  promoted: string[];
  demoted: string[];
  retired: string[];
  contradictions: string[];
}

/** Confidence-status consistency thresholds */
const STATUS_CONFIDENCE_MIN: Record<SolutionStatus, number> = {
  mature: 0.75,
  verified: 0.5,
  candidate: 0.2,
  experiment: 0.05,
  retired: 0,
};

/** Get the next promotion status */
export function nextStatus(current: SolutionStatus): SolutionStatus | null {
  switch (current) {
    case 'experiment':
      return 'candidate';
    case 'candidate':
      return 'verified';
    case 'verified':
      return 'mature';
    default:
      return null;
  }
}

/** Get confidence for a status level.
 * Spacing: 0.25 between levels for meaningful differentiation in matching scores.
 * Previous: 0.3/0.6/0.8/0.85 had only 0.05 gap between verified and mature. */
export function statusConfidence(status: SolutionStatus): number {
  switch (status) {
    case 'experiment':
      return 0.3;
    case 'candidate':
      return 0.55;
    case 'verified':
      return 0.75;
    case 'mature':
      return 0.9;
    case 'retired':
      return 0;
  }
}

/** Load adaptive thresholds from meta-learning state (returns null if not tuned) */
function loadAdaptiveThresholds(): AdaptiveLifecycleThresholds | null {
  const thresholdsPath = path.join(META_LEARNING_DIR, 'lifecycle-thresholds.json');
  return safeReadJSON<AdaptiveLifecycleThresholds | null>(thresholdsPath, null);
}

/** Check promotion eligibility (with optional adaptive thresholds) */
export function checkPromotion(
  fm: SolutionFrontmatter,
  thresholds?: AdaptiveLifecycleThresholds | null,
): boolean {
  const ev = fm.evidence;
  const t = thresholds ?? null;

  switch (fm.status) {
    case 'experiment': {
      const minReflected = t?.experiment.reflected ?? 3;
      const minSessions = t?.experiment.sessions ?? 3;
      const minReExtracted = t?.experiment.reExtracted ?? 2;
      // A: reflected >= threshold AND negative == 0 AND sessions >= threshold
      // B: reExtracted >= threshold AND negative == 0 AND reflected >= 1
      return (
        ev.negative === 0 &&
        ((ev.reflected >= minReflected && ev.sessions >= minSessions) ||
          (ev.reExtracted >= minReExtracted && ev.reflected >= 1))
      );
    }

    case 'candidate': {
      const minReflected = t?.candidate.reflected ?? 4;
      const minSessions = t?.candidate.sessions ?? 3;
      const minReExtracted = t?.candidate.reExtracted ?? 2;
      // A: reflected >= threshold AND negative == 0 AND sessions >= threshold
      // B: reExtracted >= threshold AND negative == 0
      return (
        ev.negative === 0 &&
        ((ev.reflected >= minReflected && ev.sessions >= minSessions) ||
          ev.reExtracted >= minReExtracted)
      );
    }

    case 'verified': {
      const minReflected = t?.verified.reflected ?? 8;
      const minSessions = t?.verified.sessions ?? 5;
      const maxNegative = t?.verified.negative ?? 1;
      return (
        ev.reflected >= minReflected && ev.negative <= maxNegative && ev.sessions >= minSessions
      );
    }

    default:
      return false;
  }
}

/** Check if solution should be demoted due to confidence-status mismatch */
export function checkConfidenceDemotion(fm: SolutionFrontmatter): SolutionStatus | null {
  if (fm.status === 'retired') return null;

  // Check from highest to lowest
  if (fm.status === 'mature' && fm.confidence < STATUS_CONFIDENCE_MIN.mature) return 'verified';
  if (fm.status === 'verified' && fm.confidence < STATUS_CONFIDENCE_MIN.verified)
    return 'candidate';
  if (fm.status === 'candidate' && fm.confidence < STATUS_CONFIDENCE_MIN.candidate)
    return 'experiment';
  if (fm.status === 'experiment' && fm.confidence < STATUS_CONFIDENCE_MIN.experiment)
    return 'retired';

  return null;
}

/** Check if solution identifiers still exist in codebase (staleness detection) */
export function checkIdentifierStaleness(fm: SolutionFrontmatter, cwd: string): boolean {
  if (fm.identifiers.length === 0) return false; // no identifiers to check
  try {
    const validIds = fm.identifiers.slice(0, 5).filter((id) => id.length >= 6);
    // All identifiers were too short — nothing to grep, treat as stale (matches original behavior)
    if (validIds.length === 0) return true;
    // Escape regex metacharacters and join with OR for a single grep call
    // (previously: one execFileSync per identifier — up to 15s worst case)
    const pattern = validIds.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    execFileSync(
      'grep',
      [
        '-r',
        '-E',
        '--include=*.ts',
        '--include=*.tsx',
        '--include=*.js',
        '--include=*.jsx',
        '--exclude-dir=node_modules',
        '--exclude-dir=dist',
        '--exclude-dir=.git',
        '-l',
        '-m',
        '1',
        pattern,
        '.',
      ],
      { cwd, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return false; // grep exit 0 = at least one identifier found = not stale
  } catch (e: unknown) {
    // grep exit 1 = no matches found = stale
    // Other errors (timeout, ENOENT) = don't penalize — same as original outer catch behavior
    const status = (e as NodeJS.ErrnoException & { status?: number }).status;
    return status === 1;
  }
}

/** Status-specific staleness thresholds (days).
 * experiment decays faster, mature gets longer grace period. */
const STALENESS_DAYS: Record<string, number> = {
  experiment: 60,
  candidate: 90,
  verified: 120,
  mature: 120,
};

/** Check if solution is stale (status-specific inactivity threshold) */
export function isStale(fm: SolutionFrontmatter): boolean {
  if (fm.status === 'retired') return false;
  const staleDays = STALENESS_DAYS[fm.status] ?? 90;
  const ninetyDaysMs = staleDays * 24 * 60 * 60 * 1000;

  if (fm.evidence.injected === 0) {
    // Never injected — check age
    // 복귀(reopen)한 솔루션은 updated 가 갱신되므로 둘 중 늦은 쪽을 기준으로 한다 (아니면 복귀 즉시 다시 stale).
    const created = Math.max(new Date(fm.created).getTime(), new Date(fm.updated).getTime() || 0);
    const age = Date.now() - created;
    return age > ninetyDaysMs;
  }
  // Has been injected — check last update
  const updated = new Date(fm.updated).getTime();
  const age = Date.now() - updated;
  return age > ninetyDaysMs;
}

/**
 * Update a solution file with new frontmatter.
 * PR2b: solution-writer.mutateSolutionFile로 통합. lock + fresh re-read + atomic write.
 */
export function updateSolutionFile(
  filePath: string,
  updates: Partial<SolutionFrontmatter>,
): boolean {
  return mutateSolutionFile(filePath, (sol) => {
    sol.frontmatter = {
      ...sol.frontmatter,
      ...updates,
    };
    return true;
  });
}

/**
 * 은퇴 패치. 사유를 남기고, confidence 는 반증(contradicted)일 때만 0 으로 만든다.
 * stale/manual 은 값어치가 없어서가 아니라 시간·사용자 판단 때문이라 confidence 를 보존해야 복귀(reopen)가 의미 있다.
 */
export function retirePatch(fm: SolutionFrontmatter, reason: RetiredReason): Partial<SolutionFrontmatter> {
  return {
    status: 'retired',
    retiredReason: reason,
    retiredAt: new Date().toISOString().split('T')[0],
    ...(reason === 'contradicted' ? { confidence: 0 } : { confidence: fm.confidence }),
  };
}

/** Run lifecycle check on all solutions */
export function runLifecycleCheck(_sessionId: string = 'system', opts: { dryRun?: boolean } = {}): LifecycleResult {
  const dryRun = opts.dryRun === true;
  // dry-run 이면 파일을 쓰지 않고 "바뀔 항목"만 결과에 담는다 (CLI 미리보기).
  const apply = (file: string, patch: Parameters<typeof updateSolutionFile>[1]): boolean => (dryRun ? true : updateSolutionFile(file, patch));
  const result: LifecycleResult = { promoted: [], demoted: [], retired: [], contradictions: [] };

  // Meta-learning: load adaptive thresholds if available
  const adaptiveThresholds = loadAdaptiveThresholds();

  const dirs = [ME_SOLUTIONS, ME_RULES];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatterOnly(content);
        if (!fm || fm.status === 'retired') continue;

        // 1. Check stale
        if (isStale(fm)) {
          if (apply(filePath, retirePatch(fm, 'stale'))) {
            result.retired.push(fm.name);
          }
          continue;
        }

        // 2. Check confidence-status consistency
        const demoteTo = checkConfidenceDemotion(fm);
        if (demoteTo) {
          if (
            apply(filePath, demoteTo === 'retired'
              ? retirePatch(fm, 'contradicted') // experiment 의 confidence 가 하한 아래 = 반증 누적의 결과
              : { status: demoteTo, confidence: statusConfidence(demoteTo) })
          ) {
            result.demoted.push(`${fm.name}: ${fm.status} → ${demoteTo}`);
          }
          continue;
        }

        // 3. Circuit breaker BEFORE promotion — negative evidence takes priority
        const cbThreshold = CIRCUIT_BREAKER_THRESHOLDS[fm.status];
        if (cbThreshold !== undefined && fm.evidence.negative >= cbThreshold) {
          if (apply(filePath, retirePatch(fm, 'contradicted'))) {
            result.retired.push(`${fm.name} (circuit-breaker:${fm.status})`);
          }
          continue;
        }

        // 4. Check promotion FIRST (with minimum age gate based on updated timestamp)
        //    Promotion must run before identifier staleness to give solutions a chance
        //    to be promoted before being penalized for stale identifiers.
        if (checkPromotion(fm, adaptiveThresholds)) {
          const minAgeMs = MIN_AGE_FOR_PROMOTION[fm.status] ?? 0;
          const ageMs = Date.now() - new Date(fm.updated || fm.created).getTime();
          if (ageMs >= minAgeMs) {
            const next = nextStatus(fm.status);
            if (next) {
              if (
                apply(filePath, { status: next, confidence: statusConfidence(next) })
              ) {
                result.promoted.push(`${fm.name}: ${fm.status} → ${next}`);
              }
            }
            continue;
          }
        }

        // 5. Identifier staleness — code references no longer exist
        if (fm.identifiers.length > 0) {
          const effectiveCwd = process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd();
          if (checkIdentifierStaleness(fm, effectiveCwd)) {
            const newConf = Math.max(0, fm.confidence - 0.2);
            if (apply(filePath, { confidence: newConf })) {
              result.demoted.push(`${fm.name}: identifier-stale (confidence → ${newConf})`);
            }
          }
        }
      } catch (e) {
        log.debug(`lifecycle check failed: ${file}`, e);
      }
    }
  }

  // 5. Contradiction detection
  result.contradictions = detectContradictions(dirs);

  return result;
}

/** Detect contradictions between solutions */
export function detectContradictions(dirs: string[]): string[] {
  const contradictions: string[] = [];
  const solutions: Array<{ name: string; tags: string[]; identifiers: string[] }> = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const fm = parseFrontmatterOnly(content);
        if (!fm || fm.status === 'retired') continue;
        solutions.push({ name: fm.name, tags: fm.tags, identifiers: fm.identifiers });
      }
    } catch {
      /* 솔루션 파일 파싱 실패 무시 — 중복 감지는 best-effort */
    }
  }

  // Pre-build tag Sets for O(1) lookup — avoids O(m²) per pair
  const tagSets = solutions.map((s) => new Set(s.tags));

  // Pairwise comparison
  for (let i = 0; i < solutions.length; i++) {
    for (let j = i + 1; j < solutions.length; j++) {
      const a = solutions[i];
      const b = solutions[j];

      // Tags overlap > 70%
      const overlap = a.tags.filter((t) => tagSets[j].has(t));
      const overlapRatio = overlap.length / Math.max(a.tags.length, b.tags.length, 1);
      if (overlapRatio < 0.7) continue;

      // Identifiers completely different
      const idOverlap = a.identifiers.filter((id) => b.identifiers.includes(id));
      if (idOverlap.length === 0 && a.identifiers.length > 0 && b.identifiers.length > 0) {
        contradictions.push(
          `${a.name} vs ${b.name} (tags ${(overlapRatio * 100).toFixed(0)}% overlap, identifiers disjoint)`,
        );
      }
    }
  }

  return contradictions;
}

/** 영문·한글 낱말 집합의 Jaccard 유사도 (0~1). 같은 이름이라도 내용이 다르면 복귀 대상이 아니다. */
export function contentSimilarity(a: string, b: string): number {
  const tokens = (t: string) => new Set((t.toLowerCase().match(/[a-z0-9가-힣]{2,}/g) ?? []));
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 재추출 내용이 은퇴본과 이만큼 비슷해야 "같은 내용이 다시 나왔다"고 본다. */
export const REOPEN_MIN_SIMILARITY = 0.5;

/** me + 설치된 팩 + cwd 프로젝트 솔루션 디렉터리에서 이름으로 파일을 찾는다 (심볼릭 링크 제외). */
function findSolutionFile(solutionName: string, cwd?: string): { filePath: string; fm: SolutionFrontmatter; raw: string } | null {
  for (const { dir } of defaultSolutionDirs(cwd)) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const filePath = path.join(dir, file);
      try { if (fs.lstatSync(filePath).isSymbolicLink()) continue; } catch { continue; }
      const raw = fs.readFileSync(filePath, 'utf-8');
      const fm = parseFrontmatterOnly(raw);
      if (fm && fm.name === solutionName) return { filePath, fm, raw };
    }
  }
  return null;
}

/**
 * 은퇴한 솔루션을 후보 상태로 되돌린다 (D6 복귀 경로). me·팩·프로젝트 솔루션 모두 대상.
 * - 은퇴 전 등급을 지킨다: 보존된 confidence 가 verified(0.75)/mature(0.9) 이상이면 그 등급으로 복귀, 아니면 candidate.
 * - 은퇴 사유/시각 제거, updated=오늘(오래됨 판정 리셋).
 * - contradicted 와 사유 미상(구버전 은퇴, 반증이었을 수 있다)은 negative 증거를 0 으로 되돌린다 — 그대로 두면 회로 차단기가 바로 다시 은퇴시킨다.
 */
export function reopenSolution(solutionName: string, cwd?: string): { ok: boolean; reason?: string; previous?: RetiredReason | 'unknown'; status?: SolutionStatus } {
  const found = findSolutionFile(solutionName, cwd);
  if (!found) return { ok: false, reason: 'not-found' };
  const { filePath, fm } = found;
  if (fm.status !== 'retired') return { ok: false, reason: 'not-retired' };
  const previous = fm.retiredReason ?? 'unknown';
  let restored: SolutionStatus = 'candidate';
  const ok = mutateSolutionFile(filePath, (sol) => {
    const f = sol.frontmatter;
    restored = f.confidence >= statusConfidence('mature') ? 'mature' : f.confidence >= statusConfidence('verified') ? 'verified' : 'candidate';
    f.status = restored;
    f.confidence = f.confidence > 0 ? f.confidence : statusConfidence('candidate');
    delete f.retiredReason;
    delete f.retiredAt;
    if (previous === 'contradicted' || previous === 'unknown') f.evidence.negative = 0;
    return true;
  });
  return ok ? { ok: true, previous, status: restored } : { ok: false, reason: 'write-failed' };
}

/** 사용자가 직접 끈다. 사유 manual — confidence 는 보존하고 재추출돼도 자동으로 되살리지 않는다. */
export function deactivateSolution(solutionName: string): boolean {
  if (!fs.existsSync(ME_SOLUTIONS)) return false;
  for (const file of fs.readdirSync(ME_SOLUTIONS).filter((f) => f.endsWith('.md'))) {
    const filePath = path.join(ME_SOLUTIONS, file);
    try { if (fs.lstatSync(filePath).isSymbolicLink()) continue; } catch { continue; }
    const fm = parseFrontmatterOnly(fs.readFileSync(filePath, 'utf-8'));
    if (!fm || fm.name !== solutionName || fm.status === 'retired') continue;
    return updateSolutionFile(filePath, retirePatch(fm, 'manual'));
  }
  return false;
}

export type ReExtractOutcome = 'reopened' | 'different' | 'blocked' | 'none';

/**
 * 재추출된 솔루션과 같은 이름의 은퇴본이 있을 때의 처리. 이름만으로 복귀시키지 않고 **내용이 비슷할 때만** 복귀한다.
 *  - 'reopened'  내용이 비슷하고 stale/사유 미상 → 복귀
 *  - 'blocked'   내용이 비슷하지만 manual(사용자가 끔)·contradicted(반증됨) → 되살리지 않음 (새 추출은 버려도 된다)
 *  - 'different' 이름만 같고 내용이 다르다 → 복귀하지 않는다. 호출자는 새 추출을 버리면 안 된다
 *  - 'none'      은퇴본 없음
 */
export function reopenIfReExtracted(solutionName: string, newContent: string, cwd?: string): ReExtractOutcome {
  const found = findSolutionFile(solutionName, cwd);
  if (!found || found.fm.status !== 'retired') return 'none';
  const oldBody = parseSolutionV3(found.raw)?.content ?? found.raw;
  const newBody = parseSolutionV3(newContent)?.content ?? newContent;
  if (contentSimilarity(oldBody, newBody) < REOPEN_MIN_SIMILARITY) return 'different';
  if (found.fm.retiredReason === 'manual' || found.fm.retiredReason === 'contradicted') return 'blocked';
  return reopenSolution(solutionName, cwd).ok ? 'reopened' : 'none';
}

/** Manual verify command: immediately promote to verified */
export function verifySolution(solutionName: string): boolean {
  const dirs = [ME_SOLUTIONS, ME_RULES];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(dir, file);
        // PR2c-4 (security L-1): symlink을 통한 임의 파일 read 차단.
        // mutateSolutionByName과 일관성 유지.
        try {
          if (fs.lstatSync(filePath).isSymbolicLink()) continue;
        } catch {
          continue;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatterOnly(content);
        if (!fm || fm.name !== solutionName) continue;
        if (fm.status === 'verified' || fm.status === 'mature') return true; // already verified
        return updateSolutionFile(filePath, { status: 'verified', confidence: 0.8 });
      }
    } catch {
      /* 솔루션 파일 읽기/업데이트 실패 무시 — false 반환으로 재시도 가능 */
    }
  }
  return false;
}
