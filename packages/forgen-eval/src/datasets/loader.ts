/**
 * Dataset loader — fetches from external `forgen-eval-data` repo (ADR-005).
 * Pinned commit hash in `datasets-version.json`.
 *
 * Persona spec is *not* authored by us (Round 11 [HIGH] fix). Sources:
 *   1. academic dataset (e.g., SWE-bench persona schemas)
 *   2. anonymized real forgen users (with consent)
 *   3. public GitHub Issue corpus
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TestCase } from '../types.js';

export interface DatasetVersion {
  repo: string;
  commit: string;
  fetchedAt: string;
}

export interface LoadOptions {
  /** Path to local checkout of forgen-eval-data (mirrors the external repo). */
  rootDir: string;
  /** Filter by scenario (1-6 per Spec §10a). */
  scenarios?: number[];
  /** Cap N for smoke tier. */
  limit?: number;
  /** Mix ratio for synthetic vs retro-real (default min 30% retro per ADR-005). */
  realRetroMinRatio?: number;
}

export function loadDatasetVersion(rootDir: string): DatasetVersion {
  const path = join(rootDir, 'datasets-version.json');
  if (!existsSync(path)) {
    throw new Error(`datasets-version.json missing at ${path} — run forgen-eval-data sync first`);
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as DatasetVersion;
}

export function loadTestCases(opts: LoadOptions): TestCase[] {
  const synth = readJsonl<TestCase>(join(opts.rootDir, 'correction-sequences', 'synthetic.jsonl'));
  const real = readJsonl<TestCase>(join(opts.rootDir, 'correction-sequences', 'retro-real.jsonl'));

  const minRatio = opts.realRetroMinRatio ?? 0.3;
  if (real.length / (synth.length + real.length) < minRatio) {
    throw new Error(
      `Real retro ratio ${(real.length / (synth.length + real.length)).toFixed(2)} below min ${minRatio} (ADR-005 §realism)`,
    );
  }

  let combined = [...synth, ...real];
  if (opts.scenarios) combined = combined.filter((c) => opts.scenarios!.includes(c.scenario));
  if (opts.limit) combined = combined.slice(0, opts.limit);
  return combined;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}
