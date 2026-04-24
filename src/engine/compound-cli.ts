import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractTags, parseFrontmatterOnly, parseSolutionV3 } from './solution-format.js';
import { mutateSolutionFile } from './solution-writer.js';

import { ARCHIVED_DIR, ME_SOLUTIONS, ME_RULES } from '../core/paths.js';

interface CompoundEntrySummary {
  name: string;
  status: string;
  confidence: number;
  type: string;
  category: 'solution' | 'rule';
  tags: string[];
  evidence: { injected: number; reflected: number; negative: number; sessions: number; reExtracted: number };
  created: string;
  filePath: string;
}

/** Scan saved compound entries and return summaries */
function scanEntries(): CompoundEntrySummary[] {
  const summaries: CompoundEntrySummary[] = [];
  const dirs = [
    { dir: ME_SOLUTIONS, category: 'solution' as const },
    { dir: ME_RULES, category: 'rule' as const },
  ];

  for (const { dir, category } of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(dir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatterOnly(content);
        if (!fm) continue;
        summaries.push({
          name: fm.name,
          status: fm.status,
          confidence: fm.confidence,
          type: fm.type,
          category,
          tags: fm.tags,
          evidence: fm.evidence,
          created: fm.created,
          filePath,
        });
      }
    } catch { /* 개별 솔루션 파일 파싱 실패 무시 — 손상된 파일은 건너뛰기 */ }
  }

  return summaries;
}

/** Status icon */
function statusIcon(status: string): string {
  switch (status) {
    case 'mature': return 'M';
    case 'verified': return 'V';
    case 'candidate': return 'C';
    case 'experiment': return 'E';
    case 'retired': return 'R';
    default: return '?';
  }
}

/** List all solutions with status summary */
export function listSolutions(): void {
  const entries = scanEntries();

  if (entries.length === 0) {
    console.log('\n  No compound entries found.\n');
    return;
  }

  // Group by status
  const groups: Record<string, CompoundEntrySummary[]> = {};
  for (const entry of entries) {
    if (!groups[entry.status]) groups[entry.status] = [];
    groups[entry.status].push(entry);
  }

  const order = ['mature', 'verified', 'candidate', 'experiment', 'retired'];

  console.log('\n  Compound Entries\n');
  console.log('  (inj: 누적 주입, ref: 명시 참조, neg: 부정 피드백 — ref 측정은 v0.4.1+ 부터 시작됨)\n');

  let total = 0;
  for (const status of order) {
    const group = groups[status];
    if (!group || group.length === 0) continue;
    total += group.length;
    console.log(`  [${statusIcon(status)}] ${status} (${group.length})`);
    for (const entry of group) {
      const ev = entry.evidence;
      const evStr = `inj:${ev.injected} ref:${ev.reflected} neg:${ev.negative}`;
      console.log(`      ${entry.name} [${entry.category}]  (${entry.confidence.toFixed(2)})  ${evStr}  [${entry.tags.slice(0, 3).join(', ')}]`);
    }
  }

  // retired 카운트: scanEntries는 모든 상태를 포함하므로 직접 계산
  const retiredCount = entries.filter(e => e.status === 'retired').length;
  const activeCount = total - retiredCount;
  const highConfidence = entries.filter(e => e.status === 'verified' || e.status === 'mature').length;
  const denominator = total;
  const precision = denominator > 0 ? Math.round((highConfidence / denominator) * 100) : null;

  console.log(`\n  Total: ${activeCount} active + ${retiredCount} retired`);
  if (precision !== null) {
    console.log(`  Extraction precision: ${precision}%`);
  }
  console.log();
}

/** Inspect a single saved entry in detail */
export function inspectSolution(name: string): void {
  const entries = scanEntries();
  const entry = entries.find(s => s.name === name);

  if (!entry) {
    console.log(`\n  Entry "${name}" not found.\n`);
    return;
  }

  // Read full content
  const content = fs.readFileSync(entry.filePath, 'utf-8');
  const full = parseSolutionV3(content);

  console.log(`\n  Entry: ${entry.name}`);
  console.log(`  Category: ${entry.category}`);
  console.log(`  Status: ${entry.status} (confidence: ${entry.confidence.toFixed(2)})`);
  console.log(`  Type: ${entry.type}`);
  console.log(`  Tags: [${entry.tags.join(', ')}]`);
  console.log(`  Created: ${entry.created}`);
  console.log(`  Evidence:`);
  console.log(`    injected: ${entry.evidence.injected}`);
  console.log(`    reflected: ${entry.evidence.reflected}`);
  console.log(`    negative: ${entry.evidence.negative}`);
  console.log(`    sessions: ${entry.evidence.sessions}`);
  console.log(`    reExtracted: ${entry.evidence.reExtracted}`);

  if (full) {
    if (full.context) console.log(`\n  Context: ${full.context}`);
    if (full.content) console.log(`\n  Content:\n    ${full.content.split('\n').join('\n    ')}`);
  }

  console.log(`\n  File: ${entry.filePath}\n`);
}

/** Remove a saved entry by name */
export function removeSolution(name: string): void {
  const entries = scanEntries();
  const entry = entries.find(s => s.name === name);

  if (!entry) {
    console.log(`\n  Entry "${name}" not found.\n`);
    return;
  }

  try {
    fs.unlinkSync(entry.filePath);
    console.log(`\n  Removed: ${name} [${entry.category}] (${entry.filePath})\n`);
  } catch (e) {
    console.log(`\n  Failed to remove: ${(e as Error).message}\n`);
  }
}

/**
 * Names of extractors that have been removed from the compound pipeline.
 * Any solution file on disk whose `name` matches one of these entries is
 * an artifact of a removed extractor and should be retired.
 *
 * Current list (added by C4 cleanup, 2026-04-09):
 *   - `recurring-task-pattern`: word-frequency histogram, not a real
 *     pattern. Observed injected 105+ times in production.
 *   - `modification-hotspot`: directory modification count with generic
 *     "maybe refactor this" advice.
 *
 * Add future entries here whenever an extractor is removed from
 * `compound-extractor.ts` so users can clean up their stores.
 */
const STALE_EXTRACTOR_NAMES: readonly string[] = [
  'recurring-task-pattern',
  'modification-hotspot',
];

/**
 * Retire solutions whose names match extractors that have been removed
 * from the compound pipeline. Retired solutions are excluded from the
 * index (see `solution-index.ts:142`) so they stop being surfaced in
 * MCP search and hook injection, but the file stays on disk for
 * audit / undo purposes.
 *
 * M-3 (2026-04-09): the C4 extractor cleanup left orphaned files in
 * users' `~/.forgen/me/solutions/` directories. Without this migration,
 * files like `recurring-task-pattern.md` (which had injected=113 on
 * the author's own machine at fix time) continue to pollute matching
 * results until the user manually deletes them.
 */
export function cleanStaleSolutions(): void {
  const entries = scanEntries().filter(e => e.category === 'solution');

  const stale = entries.filter(e => STALE_EXTRACTOR_NAMES.includes(e.name));

  if (stale.length === 0) {
    console.log('\n  No stale extractor artifacts found.\n');
    return;
  }

  console.log(`\n  Found ${stale.length} stale extractor artifact(s):`);
  for (const entry of stale) {
    console.log(`    - ${entry.name} (status: ${entry.status}, injected: ${entry.evidence.injected})`);
  }
  console.log();

  let retired = 0;
  for (const entry of stale) {
    // Skip already-retired files — idempotent.
    if (entry.status === 'retired') {
      console.log(`    ✓ ${entry.name} already retired, skipping`);
      continue;
    }
    const ok = mutateSolutionFile(entry.filePath, sol => {
      sol.frontmatter.status = 'retired';
      sol.frontmatter.updated = new Date().toISOString().split('T')[0];
      return true;
    });
    if (ok) {
      retired++;
      console.log(`    ✗ ${entry.name} retired`);
    } else {
      console.log(`    ! ${entry.name} failed to update`);
    }
  }

  console.log(`\n  Retired ${retired}/${stale.length} stale artifact(s).\n`);
  console.log('  Tip: retired files are excluded from index + MCP search but');
  console.log('  remain on disk. Use `forgen compound remove <name>` to delete.\n');
}

/** Retag all solutions using improved extractTags */
export function retagSolutions(): void {
  const entries = scanEntries().filter(e => e.category === 'solution');

  if (entries.length === 0) {
    console.log('\n  No solutions to retag.\n');
    return;
  }

  // PR2b: solution-writer.mutateSolutionFile로 통합. lock + fresh re-read.
  // 동시 hook이 같은 .md를 update해도 retag 결과가 손실되지 않는다.
  let retagged = 0;
  for (const entry of entries) {
    const ok = mutateSolutionFile(entry.filePath, sol => {
      const source = [sol.context, sol.content].filter(Boolean).join(' ');
      const newTags = extractTags(source);
      sol.frontmatter.tags = newTags;
      return true;
    });
    if (ok) retagged++;
    else console.log(`    Failed: ${entry.name}`);
  }

  console.log(`\n  Retagged ${retagged}/${entries.length} solutions.\n`);
}

/** Result of a rollback operation — used by tests and callers that need counts. */
export interface RollbackCliResult {
  archived: string[];
  archiveDir: string | null;
  skipped: string[];
  errors: string[];
  dryRun: boolean;
}

/**
 * Rollback auto-extracted solutions created since a given date.
 *
 * Invariant (2026-04-20, feedback_core_loop_invariant):
 *   rollback은 **archive 이동**만 수행한다. `fs.unlinkSync`로 솔루션 파일을
 *   영구 삭제하지 않는다. 실수로 rollback을 실행해도 `~/.forgen/lab/archived/
 *   rollback-{ts}/`에서 복구할 수 있어야 한다. (과거 `unlinkSync` 경로는
 *   time-bounded rollback이 "되돌리기 불가 영구 삭제"로 동작하던 버그였다.)
 *
 * 필터 기준:
 *   - category === 'solution'만 대상 (rule은 제외)
 *   - reflected > 0 OR sessions > 0인 것은 유지 (사용된 솔루션 보호)
 *   - created >= since 인 것만 대상
 *
 * dryRun=true면 아무 파일도 건드리지 않고 대상 목록만 반환.
 */
export function rollbackSolutions(
  sinceDate: string,
  opts: { dryRun?: boolean } = {},
): RollbackCliResult {
  const result: RollbackCliResult = {
    archived: [],
    archiveDir: null,
    skipped: [],
    errors: [],
    dryRun: !!opts.dryRun,
  };

  const since = new Date(sinceDate);
  if (Number.isNaN(since.getTime())) {
    console.log(`\n  Invalid date: ${sinceDate}\n`);
    result.errors.push(`invalid-date:${sinceDate}`);
    return result;
  }

  const solutions = scanEntries().filter((entry) => entry.category === 'solution');
  const toRollback = solutions.filter((solution) => {
    if (solution.evidence.reflected > 0 || solution.evidence.sessions > 0) return false;
    const created = new Date(solution.created);
    return created >= since;
  });

  if (toRollback.length === 0) {
    console.log(`\n  No solutions to rollback since ${sinceDate}.\n`);
    return result;
  }

  if (opts.dryRun) {
    console.log(`\n  [dry-run] ${toRollback.length} solutions would be archived since ${sinceDate}:\n`);
    for (const sol of toRollback) {
      console.log(`    Would archive: ${sol.name}`);
      result.skipped.push(sol.filePath);
    }
    console.log(`\n  Re-run without --dry-run to archive them.\n`);
    return result;
  }

  const archiveDir = path.join(ARCHIVED_DIR, `rollback-${Date.now()}`);
  result.archiveDir = archiveDir;

  console.log(`\n  Rolling back ${toRollback.length} solutions since ${sinceDate} → ${archiveDir}:\n`);
  for (const sol of toRollback) {
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      // 원본 경로 정보를 destName에 보존 — 복원 시 원위치 판별용.
      // 예: "solutions__my-pattern.md"
      const originDir = path.basename(path.dirname(sol.filePath));
      const destName = `${originDir}__${path.basename(sol.filePath)}`;
      fs.renameSync(sol.filePath, path.join(archiveDir, destName));
      console.log(`    Archived: ${sol.name}`);
      result.archived.push(sol.filePath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`    Failed: ${sol.name} — ${msg}`);
      result.errors.push(`${sol.filePath}: ${msg}`);
    }
  }
  console.log(`\n  ${result.archived.length}/${toRollback.length} archived. Restore from ${archiveDir} if needed.\n`);
  return result;
}
