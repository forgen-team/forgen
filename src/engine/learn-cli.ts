import * as fs from 'node:fs';
import * as path from 'node:path';
import { fixupSolutions } from './solution-fixup.js';
import { listQuarantined, pruneQuarantine } from './solution-quarantine.js';
import { computeFitness } from './solution-fitness.js';
import { buildWeaknessReport, saveWeaknessReport } from './solution-weakness.js';
import { listCandidates, promoteCandidate, rollbackSince } from './solution-candidate.js';
import { ME_SOLUTIONS, OUTCOMES_DIR } from '../core/paths.js';

export async function handleLearn(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'fix-up') return runFixUp(args.slice(1));
  if (sub === 'quarantine') return runQuarantine(args.slice(1));
  if (sub === 'fitness') return runFitness(args.slice(1));
  if (sub === 'evolve') return runEvolve(args.slice(1));
  if (sub === 'reset-outcomes') return runResetOutcomes(args.slice(1));
  printUsage();
}

function printUsage(): void {
  console.log(`
  forgen learn — solution index maintenance and fitness

  Usage:
    forgen learn fix-up [--apply]         Repair malformed solution frontmatter (dry-run by default)
    forgen learn quarantine [--prune]     Show files dropped by the index; --prune removes fixed/deleted
    forgen learn fitness [--json]         Show per-solution fitness (accept/correct/error ratios)
    forgen learn evolve [--save|--rollback <ts>|--promote <name>]
                                          Phase 4 evolution: weakness report + candidate lifecycle
    forgen learn reset-outcomes [--apply] Archive pre-audit outcome history (dry-run by default).
                                          Use after upgrading from <0.3.2 to start fitness fresh
                                          under the new attribution gates. Old data is preserved
                                          at ~/.forgen/state/outcomes.archive-<ts>/ (never deleted).
`);
}

/**
 * Archive the outcomes directory to a timestamped sibling so fitness
 * computation starts fresh under v0.3.2's corrected attribution gates
 * (match_score≥0.3, lag≤5min, top-3, single-tag rejection). Pre-0.3.2
 * outcomes were recorded with blanket error-attribution on every tool
 * failure in the session window, producing a 91% global error rate even
 * for solutions that weren't actually causing the failures.
 *
 * Archive, never delete — users who want to audit their pre-0.3.2
 * history can still read `outcomes.archive-<ts>/*.jsonl`.
 */
function runResetOutcomes(args: string[]): void {
  const apply = args.includes('--apply');
  if (!fs.existsSync(OUTCOMES_DIR)) {
    console.log(`\n  No outcomes directory yet — nothing to reset.\n`);
    return;
  }
  const files = fs.readdirSync(OUTCOMES_DIR).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    console.log(`\n  Outcomes directory is empty — nothing to reset.\n`);
    return;
  }
  let totalLines = 0;
  for (const f of files) {
    try {
      totalLines += fs.readFileSync(path.join(OUTCOMES_DIR, f), 'utf-8').split('\n').filter(Boolean).length;
    } catch { /* ignore */ }
  }
  console.log(`\n  Outcomes snapshot: ${files.length} session files, ${totalLines} events.`);
  if (!apply) {
    console.log(`\n  Dry-run. Re-run with --apply to archive:`);
    console.log(`    mv ~/.forgen/state/outcomes  →  ~/.forgen/state/outcomes.archive-<ts>`);
    console.log(`    new empty ~/.forgen/state/outcomes/\n`);
    return;
  }
  const archivePath = `${OUTCOMES_DIR}.archive-${Date.now()}`;
  fs.renameSync(OUTCOMES_DIR, archivePath);
  fs.mkdirSync(OUTCOMES_DIR, { recursive: true });
  console.log(`\n  ✓ Archived to ${archivePath}`);
  console.log(`  ✓ Fresh ${OUTCOMES_DIR} created.`);
  console.log(`\n  Next fitness snapshot reflects v0.3.2 attribution gates only.\n`);
}

function runFixUp(args: string[]): void {
  const apply = args.includes('--apply');
  const result = fixupSolutions(ME_SOLUTIONS, { dryRun: !apply });
  console.log(`\n  ${apply ? 'Applied' : 'Dry-run'}: scanned=${result.scanned} fixed=${result.fixed} untouched=${result.untouched} unfixable=${result.unfixable}`);
  for (const rep of result.reports) {
    const rel = path.basename(rep.path);
    if (rep.changed && rep.remaining_errors.length === 0) {
      console.log(`    ✓ ${rel} — add: ${rep.added.join(', ')}`);
    } else {
      console.log(`    ✗ ${rel} — remaining: ${rep.remaining_errors.join('; ')}`);
    }
  }
  if (!apply && result.fixed > 0) {
    console.log(`\n  Re-run with --apply to write changes.\n`);
  } else if (apply && result.fixed > 0) {
    console.log(`\n  Consider: forgen learn quarantine --prune\n`);
  } else {
    console.log('');
  }
}

function runQuarantine(args: string[]): void {
  if (args.includes('--prune')) {
    const result = pruneQuarantine();
    console.log(`\n  Pruned: removed=${result.removed} kept=${result.kept}\n`);
    return;
  }
  const entries = listQuarantined();
  if (entries.length === 0) {
    console.log(`\n  No quarantined solutions. ✓\n`);
    return;
  }
  console.log(`\n  Quarantined solutions (${entries.length}):\n`);
  for (const e of entries) {
    const rel = path.basename(e.path);
    console.log(`    ${rel} (${e.at})`);
    for (const err of e.errors) console.log(`      - ${err}`);
  }
  console.log(`\n  Fix: forgen learn fix-up --apply  → then: forgen learn quarantine --prune\n`);
}

function runFitness(args: string[]): void {
  const records = computeFitness();
  if (args.includes('--json')) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }
  if (records.length === 0) {
    console.log(`\n  No outcome events yet. Fitness becomes available after solution injections accumulate.\n`);
    return;
  }
  console.log(`\n  Solution Fitness (${records.length} tracked):\n`);
  console.log(`    ${'name'.padEnd(48)} ${'state'.padEnd(14)} ${'inj'.padStart(4)}  ${'acc/cor/err'.padStart(11)}  ${'fit'.padStart(6)}`);
  console.log(`    ${'-'.repeat(48)} ${'-'.repeat(14)} ${'-'.repeat(4)}  ${'-'.repeat(11)}  ${'-'.repeat(6)}`);
  for (const r of records) {
    const name = r.solution.length > 47 ? r.solution.slice(0, 45) + '..' : r.solution;
    const acr = `${r.accepted}/${r.corrected}/${r.errored}`;
    console.log(`    ${name.padEnd(48)} ${r.state.padEnd(14)} ${String(r.injected).padStart(4)}  ${acr.padStart(11)}  ${r.fitness.toFixed(2).padStart(6)}`);
  }
  console.log('');
}

function runEvolve(args: string[]): void {
  const save = args.includes('--save');
  const rollbackIdx = args.indexOf('--rollback');
  const promoteIdx = args.indexOf('--promote');

  if (rollbackIdx >= 0 && args[rollbackIdx + 1]) {
    runEvolveRollback(args[rollbackIdx + 1]);
    return;
  }
  if (promoteIdx >= 0 && args[promoteIdx + 1]) {
    runEvolvePromote(args[promoteIdx + 1]);
    return;
  }

  // Default: generate + optionally save weakness report, print proposer
  // brief so the user can hand it to the ch-solution-evolver agent.
  const report = buildWeaknessReport();
  console.log(`\n  Weakness Report @ ${report.generated_at}\n`);
  console.log(`  Population: ${report.population.total} solutions`);
  console.log(`    champion=${report.population.champion}  active=${report.population.active}  underperform=${report.population.underperform}  draft=${report.population.draft}\n`);
  renderTagRow('Under-served tags', report.under_served_tags.map((t) => `${t.tag} (×${t.correction_mentions})`));
  renderTagRow('Conflict clusters', report.conflict_clusters.map((c) => `${c.shared_tags.slice(0, 2).join('+')}: ${c.champion.name} vs ${c.underperform.name}`));
  renderTagRow('Dead corners', report.dead_corners.map((d) => `${d.solution}: [${d.unique_tags.slice(0, 2).join(',')}]`));
  renderTagRow('Volatile', report.volatile.map((v) => `${v.solution} Δ${v.delta}`));

  if (save) {
    const p = saveWeaknessReport(report);
    console.log(`\n  Saved: ${p}`);
    console.log(`  Next: invoke the ch-solution-evolver agent with this report, then run:`);
    console.log(`    forgen learn evolve --promote <candidate-name>   # accept one of the 3 proposals`);
    console.log(`    forgen learn evolve --rollback ${Date.now()}      # undo this week's candidates`);
    console.log('');
  } else {
    console.log(`\n  Dry-run. Re-run with --save to persist this report and proceed to proposer.\n`);
  }
}

function renderTagRow(label: string, items: string[]): void {
  if (items.length === 0) {
    console.log(`  ${label}: (none)`);
    return;
  }
  console.log(`  ${label}:`);
  for (const item of items.slice(0, 5)) console.log(`    - ${item}`);
}

function runEvolveRollback(ts: string): void {
  const epochMs = /^\d+$/.test(ts) ? Number(ts) : Date.parse(ts);
  if (!Number.isFinite(epochMs)) {
    console.log(`\n  Invalid timestamp: ${ts}. Use epoch ms or ISO-8601.\n`);
    return;
  }
  const result = rollbackSince(epochMs);
  console.log(`\n  Rollback since ${new Date(epochMs).toISOString()}:`);
  if (result.archived.length === 0) {
    console.log(`    (no evolved solutions newer than cutoff)\n`);
    return;
  }
  console.log(`    Archived ${result.archived.length} file(s) → ${result.archive_dir}`);
  for (const p of result.archived) console.log(`      - ${path.basename(p)}`);
  if (result.errors.length > 0) {
    console.log(`    Errors:`);
    for (const e of result.errors) console.log(`      ! ${e}`);
  }
  console.log('');
}

function runEvolvePromote(candidateNameOrList: string): void {
  if (candidateNameOrList === '--list' || candidateNameOrList === 'list') {
    const found = listCandidates();
    if (found.length === 0) {
      console.log(`\n  No pending candidates in ~/.forgen/lab/candidates/\n`);
      return;
    }
    console.log(`\n  Pending candidates (${found.length}):`);
    for (const p of found) console.log(`    - ${path.basename(p, '.md')}`);
    console.log(`\n  Promote one: forgen learn evolve --promote <name>\n`);
    return;
  }
  const result = promoteCandidate(candidateNameOrList);
  if (result.ok) {
    console.log(`\n  ✓ Promoted: ${path.basename(result.dest!)}`);
    console.log(`    from: ${result.source}`);
    console.log(`    to:   ${result.dest}`);
    console.log(`    Cold-start bonus active until 5 injections accumulate (auto-promotes to verified).\n`);
  } else {
    console.log(`\n  ✗ Promotion refused: ${result.reason}\n`);
  }
}
