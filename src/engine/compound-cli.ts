import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractSolutionTags, parseFrontmatterOnly, parseSolutionV3 } from './solution-format.js';
import { mutateSolutionFile } from './solution-writer.js';

import { ARCHIVED_DIR, ME_SOLUTIONS, ME_RULES, ME_BEHAVIOR } from '../core/paths.js';
import { isHabitLog } from './solution-habit.js';
import { createSnapshot } from './rule-recovery-cli.js';
import { classifyBehaviorKind } from '../core/behavior-classifier.js';

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

/**
 * 기존 솔루션의 태그를 현재 extractTags(조사·템플릿 단어·잘린 어간 정리 반영)로 다시 계산한다.
 * 상태를 바꾸는 명령이라 기본은 미리보기 — `--apply` 를 줘야 쓴다. 입력은 저장 시와 같은 "제목 + 본문"이다
 * (제목은 파일 이름 슬러그로 복원). 바뀌는 항목만 추가/제거 태그를 보여 준다.
 */
export function retagSolutions(apply = false): { changed: number; total: number } {
  const entries = scanEntries().filter(e => e.category === 'solution');

  if (entries.length === 0) {
    console.log('\n  No solutions to retag.\n');
    return { changed: 0, total: 0 };
  }

  let changed = 0;
  let snapshot: string | null = null;
  for (const entry of entries) {
    const parsed = parseSolutionV3(fs.readFileSync(entry.filePath, 'utf-8'));
    if (!parsed || parsed.frontmatter.status === 'retired') continue; // 은퇴본은 매칭 대상이 아니다
    const title = parsed.frontmatter.name.replace(/-/g, ' ');
    const text = `${title} ${parsed.content}`;
    const extracted = extractSolutionTags(text);
    const old = parsed.frontmatter.tags;
    // 수동 태그 보존: 자동 추출 태그는 언제나 제목·본문에서 나온다. 본문에 없는 태그는 사람이 붙인 것으로 보고 남긴다.
    const lower = `${text} ${parsed.context}`.toLowerCase();
    const manual = old.filter(t => !lower.includes(t.toLowerCase()));
    const newTags = [...new Set([...extracted, ...manual])];
    const added = newTags.filter(t => !old.includes(t));
    const removed = old.filter(t => !newTags.includes(t));
    if (added.length === 0 && removed.length === 0) continue;
    changed++;
    console.log(`    ${entry.name}: +[${added.join(', ')}] -[${removed.join(', ')}]${manual.length ? ` (수동 태그 유지: ${manual.join(', ')})` : ''}`);
    if (apply) {
      // 적용 전 스냅샷 (forgen rule restore 로 되돌린다). 첫 변경 직전에 한 번만.
      if (!snapshot) {
        snapshot = createSnapshot('pre-retag');
        console.log(`    스냅샷: ${snapshot} (되돌리기: forgen rule restore ${snapshot} --yes)`);
      }
      // PR2b: solution-writer.mutateSolutionFile 로 lock + fresh re-read. updated 는 건드리지 않는다 (오래됨 판정 기준이라).
      const ok = mutateSolutionFile(entry.filePath, sol => {
        sol.frontmatter.tags = newTags;
        return true;
      }, { touchUpdated: false });
      if (!ok) console.log(`    Failed: ${entry.name}`);
    }
  }

  console.log(`\n  ${apply ? 'Retagged' : '[preview] would retag'} ${changed}/${entries.length} solutions.`);
  if (!apply && changed > 0) console.log('  적용하려면: forgen compound retag --apply');
  console.log();
  return { changed, total: entries.length };
}

/**
 * 습관 로그(`works-with-typescript` 류)를 솔루션에서 behavior 로 옮긴다. 기본은 미리보기.
 * 원본은 삭제하지 않고 me/solutions-archive/ 로 옮긴다(되돌릴 수 있게).
 */
export function migrateHabitLogs(apply = false): { moved: string[] } {
  const moved: string[] = [];
  if (!fs.existsSync(ME_SOLUTIONS)) return { moved };
  const archive = path.join(path.dirname(ME_SOLUTIONS), 'solutions-archive');
  let snapshot: string | null = null;
  for (const file of fs.readdirSync(ME_SOLUTIONS).filter(f => f.endsWith('.md'))) {
    const filePath = path.join(ME_SOLUTIONS, file);
    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }
    const parsed = parseSolutionV3(raw);
    if (!parsed || !isHabitLog(parsed.frontmatter.name, raw)) continue;
    const name = parsed.frontmatter.name;
    // 파일 이름은 영숫자·한글·`-`·`_` 만 남긴다 (이름에 `/`, `..`, 따옴표 등이 있어도 behavior 밖으로 나가거나 frontmatter 를 깨지 않게).
    const safe = name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'unnamed';
    const slug = `habit-${safe}`;
    const dest = path.join(ME_BEHAVIOR, `${slug}.md`);
    if (apply && fs.existsSync(dest)) {
      console.log(`    ${name} → 건너뜀: behavior/${slug}.md 가 이미 있다 (덮어쓰지 않음)`);
      continue;
    }
    moved.push(name);
    console.log(`    ${name} → behavior (observed ${parsed.frontmatter.evidence.reflected})`);
    if (!apply) continue;
    if (!snapshot) {
      snapshot = createSnapshot('pre-habits');
      console.log(`    스냅샷: ${snapshot} (되돌리기: forgen rule restore ${snapshot} --yes)`);
    }
    const today = new Date().toISOString().split('T')[0];
    const kind = classifyBehaviorKind(parsed.content);
    fs.mkdirSync(ME_BEHAVIOR, { recursive: true });
    const q = (v: string) => JSON.stringify(v);
    const body = `---\nname: ${q(slug)}\nversion: 1\nkind: ${q(kind)}\nobservedCount: ${Math.max(1, parsed.frontmatter.evidence.reflected)}\nconfidence: 0.6\ntags: ["auto-observed", "habit"]\ncreated: ${q(parsed.frontmatter.created)}\nupdated: ${q(today)}\nsource: "migrated-habit-log"\n---\n\n## Content\n${parsed.content}\n${parsed.context ? `\n## Origin\n${parsed.context}\n` : ''}`;
    fs.writeFileSync(dest, body, { flag: 'wx' });
    fs.mkdirSync(archive, { recursive: true });
    let archived = path.join(archive, file);
    if (fs.existsSync(archived)) archived = path.join(archive, `${Date.now()}-${file}`); // 덮어쓰지 않는다
    fs.renameSync(filePath, archived);
  }
  console.log(`\n  ${apply ? 'Moved' : '[preview] would move'} ${moved.length} habit log(s) to behavior.`);
  if (!apply && moved.length > 0) console.log('  적용하려면: forgen compound habits --apply');
  if (apply && snapshot) console.log(`  되돌리기: forgen rule restore ${snapshot} --yes (원본은 me/solutions-archive/ 에도 남아 있다)`);
  console.log();
  return { moved };
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

/**
 * 은퇴한 솔루션 목록과 복구 후보 판정. 읽기 전용 — 적용은 `forgen compound reopen <name>` 로만 한다.
 * 사유(retiredReason)가 없는 구버전 은퇴는 "unknown" 으로 표시하고, 기록된 증거로 복구 우선순위를 낸다.
 */
const ageDays = (created: string): number => (Date.now() - new Date(created).getTime()) / 86_400_000;

export function listRetired(): Array<{ name: string; reason: string; confidence: number; injected: number; reflected: number; negative: number; created: string; advice: string }> {
  const rows: Array<{ name: string; reason: string; confidence: number; injected: number; reflected: number; negative: number; created: string; advice: string }> = [];
  if (!fs.existsSync(ME_SOLUTIONS)) return rows;
  for (const file of fs.readdirSync(ME_SOLUTIONS).filter(f => f.endsWith('.md'))) {
    const fm = parseFrontmatterOnly(fs.readFileSync(path.join(ME_SOLUTIONS, file), 'utf-8'));
    if (!fm || fm.status !== 'retired') continue;
    const ev = fm.evidence;
    const reason = fm.retiredReason ?? 'unknown';
    // 반증 증거(negative)가 있으면 복구 비추천. 없고 사용 흔적/최근성이 있으면 복구 후보.
    const advice = isHabitLog(fm.name, fs.readFileSync(path.join(ME_SOLUTIONS, file), 'utf-8')) ? '복구 비추천 (습관 로그 — 솔루션이 아니라 behavior. compound habits 이관 대상)'
      : ev.negative > 0 || reason === 'contradicted' ? '복구 비추천 (반증 증거)'
      : reason === 'manual' ? '유지 (사용자가 끔)'
      : ev.reflected > 0 || ev.injected > 0 ? '복구 후보 (사용 흔적 있음)'
      : ageDays(fm.created) > 90 ? '복구 후보 (생성 90일 넘음 + 사용 흔적 없음 = 기간 경과 은퇴로 추정 — 내용 확인 후 결정)'
      : '확인 필요 (생성 90일 안인데 은퇴됨 — 기간 경과가 아니라 수동·다른 경로로 끈 것으로 추정, 사유 기록 없음)';
    rows.push({ name: fm.name, reason, confidence: fm.confidence, injected: ev.injected, reflected: ev.reflected, negative: ev.negative, created: fm.created, advice });
  }
  if (rows.length === 0) console.log('\n  은퇴한 솔루션이 없습니다.\n');
  else {
    console.log(`\n  은퇴한 솔루션 ${rows.length}개 (읽기 전용):\n`);
    for (const r of rows) console.log(`    ${r.name}  [사유 ${r.reason}] conf=${r.confidence} injected=${r.injected} reflected=${r.reflected} negative=${r.negative} created=${r.created}\n      → ${r.advice}`);
    console.log('\n  복구: forgen compound reopen <name>\n');
  }
  return rows;
}
