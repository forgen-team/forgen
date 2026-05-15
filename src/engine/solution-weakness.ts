import * as fs from 'node:fs';
import * as path from 'node:path';
import { ME_SOLUTIONS, STATE_DIR } from '../core/paths.js';
import { parseFrontmatterOnly } from './solution-format.js';
import { computeFitness, type FitnessRecord } from './solution-fitness.js';
import { readAllOutcomes } from './solution-outcomes.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('solution-weakness');

export interface UnderServedTag {
  tag: string;
  correction_mentions: number;
  best_matching_champion: string | null;
  best_fitness: number;
}

export interface ConflictCluster {
  shared_tags: string[];
  champion: { name: string; fitness: number };
  underperform: { name: string; fitness: number };
}

export interface DeadCorner {
  solution: string;
  unique_tags: string[];
  injected: number;
}

export interface VolatileSolution {
  solution: string;
  accept_rate_window_a: number;
  accept_rate_window_b: number;
  delta: number;
}

export interface WeaknessReport {
  generated_at: string;
  population: { total: number; champion: number; active: number; underperform: number; draft: number };
  under_served_tags: UnderServedTag[];
  conflict_clusters: ConflictCluster[];
  dead_corners: DeadCorner[];
  volatile: VolatileSolution[];
}

interface SolutionRow {
  name: string;
  tags: string[];
  fitness?: FitnessRecord;
}

function loadSolutionRows(solutionsDir: string): SolutionRow[] {
  if (!fs.existsSync(solutionsDir)) return [];
  const rows: SolutionRow[] = [];
  for (const file of fs.readdirSync(solutionsDir)) {
    if (!file.endsWith('.md')) continue;
    try {
      const content = fs.readFileSync(path.join(solutionsDir, file), 'utf-8');
      const fm = parseFrontmatterOnly(content);
      if (!fm) continue;
      rows.push({ name: fm.name, tags: fm.tags });
    } catch { /* skip */ }
  }
  return rows;
}

function findUnderServedTags(rows: SolutionRow[], fitnessByName: Map<string, FitnessRecord>): UnderServedTag[] {
  // Read correction evidence tags from ~/.forgen/me/behavior/*.json — each
  // entry carries a `raw_payload` with inferred tags or keywords. Be
  // tolerant: the schema has drifted historically, so we accept any string
  // array we can find under likely field names.
  const behaviorDir = path.join(ME_SOLUTIONS, '..', 'behavior');
  const correctionTags = new Map<string, number>();
  if (fs.existsSync(behaviorDir)) {
    for (const file of fs.readdirSync(behaviorDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(behaviorDir, file), 'utf-8'));
        const payload = data.raw_payload ?? data.payload ?? {};
        const tags = collectTags(payload).concat(collectTags(data.axis_refs ?? []));
        const summary = typeof data.summary === 'string' ? data.summary.toLowerCase() : '';
        for (const tag of new Set(tags)) {
          correctionTags.set(tag, (correctionTags.get(tag) ?? 0) + 1);
        }
        // Summary keywords fallback — split on whitespace, filter obvious fillers
        for (const word of summary.split(/\s+/)) {
          if (word.length >= 5 && word.length <= 20) {
            correctionTags.set(word, (correctionTags.get(word) ?? 0) + 0.3);
          }
        }
      } catch { /* skip bad json */ }
    }
  }

  const result: UnderServedTag[] = [];
  for (const [tag, count] of correctionTags) {
    if (count < 2) continue; // noise cutoff
    let bestName: string | null = null;
    let bestFitness = 0;
    for (const row of rows) {
      if (!row.tags.includes(tag)) continue;
      const fit = fitnessByName.get(row.name)?.fitness ?? 0;
      if (fit > bestFitness || (bestName === null && fit >= 0)) {
        bestFitness = fit;
        bestName = row.name;
      }
    }
    // Under-served: no matching solution, or best match is not a champion
    const bestFit = bestName ? fitnessByName.get(bestName) : null;
    const isChampion = bestFit?.state === 'champion';
    if (!bestName || !isChampion) {
      result.push({
        tag,
        correction_mentions: Math.round(count),
        best_matching_champion: isChampion ? bestName : null,
        best_fitness: bestFitness,
      });
    }
  }
  result.sort((a, b) => b.correction_mentions - a.correction_mentions);
  return result.slice(0, 10);
}

function collectTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (v && typeof v === 'object') {
    return Object.values(v as Record<string, unknown>)
      .filter((x): x is string => typeof x === 'string');
  }
  return [];
}

function findConflictClusters(rows: SolutionRow[], fitnessByName: Map<string, FitnessRecord>): ConflictCluster[] {
  const champions = rows.filter((r) => fitnessByName.get(r.name)?.state === 'champion');
  const underperformers = rows.filter((r) => fitnessByName.get(r.name)?.state === 'underperform');
  const clusters: ConflictCluster[] = [];
  for (const ch of champions) {
    const chFitness = fitnessByName.get(ch.name)?.fitness;
    if (chFitness === undefined) continue;
    for (const up of underperformers) {
      const upFitness = fitnessByName.get(up.name)?.fitness;
      if (upFitness === undefined) continue;
      const shared = ch.tags.filter((t) => up.tags.includes(t));
      if (shared.length < 2) continue;
      clusters.push({
        shared_tags: shared,
        champion: { name: ch.name, fitness: chFitness },
        underperform: { name: up.name, fitness: upFitness },
      });
    }
  }
  clusters.sort((a, b) => b.shared_tags.length - a.shared_tags.length);
  return clusters.slice(0, 5);
}

function findDeadCorners(rows: SolutionRow[], fitnessByName: Map<string, FitnessRecord>): DeadCorner[] {
  // Dead = injected=0. Unique tags = tags present only in this solution.
  const injectedRows = rows.filter((r) => (fitnessByName.get(r.name)?.injected ?? 0) > 0);
  const injectedTags = new Set<string>();
  for (const r of injectedRows) for (const t of r.tags) injectedTags.add(t);
  const dead: DeadCorner[] = [];
  for (const r of rows) {
    const injected = fitnessByName.get(r.name)?.injected ?? 0;
    if (injected > 0) continue;
    const unique = r.tags.filter((t) => !injectedTags.has(t));
    if (unique.length === 0) continue;
    dead.push({ solution: r.name, unique_tags: unique, injected });
  }
  dead.sort((a, b) => b.unique_tags.length - a.unique_tags.length);
  return dead.slice(0, 10);
}

function findVolatile(_fitnessByName: Map<string, FitnessRecord>): VolatileSolution[] {
  const events = readAllOutcomes();
  if (events.length === 0) return [];
  // Split events into two halves by timestamp; compute per-solution accept
  // rate delta between halves. Volatile = |delta| > 0.3 and enough data.
  const mid = events[Math.floor(events.length / 2)].ts;
  type Counts = { a_accept: number; a_total: number; b_accept: number; b_total: number };
  const by = new Map<string, Counts>();
  for (const ev of events) {
    const c = by.get(ev.solution) ?? { a_accept: 0, a_total: 0, b_accept: 0, b_total: 0 };
    if (ev.outcome === 'accept' || ev.outcome === 'correct' || ev.outcome === 'error') {
      const isA = ev.ts < mid;
      if (isA) { c.a_total++; if (ev.outcome === 'accept') c.a_accept++; }
      else { c.b_total++; if (ev.outcome === 'accept') c.b_accept++; }
    }
    by.set(ev.solution, c);
  }
  const result: VolatileSolution[] = [];
  for (const [name, c] of by) {
    if (c.a_total < 3 || c.b_total < 3) continue;
    const rateA = c.a_accept / c.a_total;
    const rateB = c.b_accept / c.b_total;
    const delta = rateB - rateA;
    if (Math.abs(delta) < 0.3) continue;
    result.push({
      solution: name,
      accept_rate_window_a: Number(rateA.toFixed(3)),
      accept_rate_window_b: Number(rateB.toFixed(3)),
      delta: Number(delta.toFixed(3)),
    });
  }
  result.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return result.slice(0, 5);
}

export function buildWeaknessReport(solutionsDir: string = ME_SOLUTIONS): WeaknessReport {
  const rows = loadSolutionRows(solutionsDir);
  const fitnessList = computeFitness();
  const fitnessByName = new Map(fitnessList.map((f) => [f.solution, f]));
  const population = {
    total: fitnessList.length,
    champion: fitnessList.filter((f) => f.state === 'champion').length,
    active: fitnessList.filter((f) => f.state === 'active').length,
    underperform: fitnessList.filter((f) => f.state === 'underperform').length,
    draft: fitnessList.filter((f) => f.state === 'draft').length,
  };
  return {
    generated_at: new Date().toISOString(),
    population,
    under_served_tags: findUnderServedTags(rows, fitnessByName),
    conflict_clusters: findConflictClusters(rows, fitnessByName),
    dead_corners: findDeadCorners(rows, fitnessByName),
    volatile: findVolatile(fitnessByName),
  };
}

export function saveWeaknessReport(report: WeaknessReport): string {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const ts = Date.now();
  const p = path.join(STATE_DIR, `weakness-report-${ts}.json`);
  try {
    fs.writeFileSync(p, JSON.stringify(report, null, 2));
  } catch (e) {
    log.debug(`save failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return p;
}

export function latestWeaknessReport(): WeaknessReport | null {
  if (!fs.existsSync(STATE_DIR)) return null;
  const candidates = fs.readdirSync(STATE_DIR)
    .filter((f) => f.startsWith('weakness-report-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (candidates.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, candidates[0]), 'utf-8')) as WeaknessReport;
  } catch {
    return null;
  }
}
