/**
 * Forgen Meta-Learning — Runner (Orchestrator)
 *
 * Coordinates execution of all meta-learning features at session end.
 * Called from auto-compound-runner.ts as Step 5.
 *
 * Design:
 *   - Each feature is independently gated by config + cold-start check
 *   - Failures in one feature do not block others (fail-open per feature)
 *   - Session quality scoring always runs first (feeds other features)
 */

import { recordFrozenUse } from '../../core/frozen-features.js';
import * as path from 'node:path';
import { safeReadJSON } from '../../hooks/shared/atomic-write.js';
import { computeAdaptiveThresholds } from './adaptive-thresholds.js';
import { computeExtractionBias } from './extraction-tuner.js';
import { tuneMatcherWeights } from './matcher-weight-tuner.js';
import { checkScopePromotions, updateProjectUsageMap } from './scope-promoter.js';
import { saveSessionQuality, scoreSession } from './session-quality-scorer.js';
import { DEFAULT_CONFIG, type MetaLearningConfig, type MetaLearningResult } from './types.js';

export function loadMetaLearningConfig(): MetaLearningConfig {
  const hookConfigPath = path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? '',
    '.forgen',
    'hook-config.json',
  );
  const hookConfig = safeReadJSON<Record<string, unknown>>(hookConfigPath, {});
  const metaSection = hookConfig?.['meta-learning'] as Partial<MetaLearningConfig> | undefined;

  if (!metaSection) return DEFAULT_CONFIG;

  return {
    enabled: metaSection.enabled ?? DEFAULT_CONFIG.enabled,
    features: { ...DEFAULT_CONFIG.features, ...metaSection.features },
    coldStart: { ...DEFAULT_CONFIG.coldStart, ...metaSection.coldStart },
    guardrails: { ...DEFAULT_CONFIG.guardrails, ...metaSection.guardrails },
  };
}

export function runMetaLearning(sessionId: string, cwd: string): MetaLearningResult {
  const config = loadMetaLearningConfig();
  if (!config.enabled) {
    return { skipped: true, reason: 'meta-learning disabled in config' };
  }

  recordFrozenUse('meta-learning'); // 켜 둔 사용자만 여기 온다(기본 off)
  const result: MetaLearningResult = {};

  // Feature 1: Session Quality Scorer (always first — feeds other features)
  if (config.features.sessionQualityScorer) {
    try {
      const score = scoreSession(sessionId);
      if (score) {
        saveSessionQuality(score);
        result.qualityScore = score;
      }
    } catch (e) {
      process.stderr.write(
        `[forgen-meta] quality scorer: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // Feature 2: Matcher Weight Tuning
  if (config.features.matcherWeightTuning) {
    try {
      result.matcherWeights = tuneMatcherWeights(config);
    } catch (e) {
      process.stderr.write(
        `[forgen-meta] matcher tuning: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // Feature 3: Scope Auto-Promotion
  if (config.features.scopeAutoPromotion) {
    try {
      updateProjectUsageMap(sessionId, cwd, config);
      result.scopePromotions = checkScopePromotions(config);
    } catch (e) {
      process.stderr.write(
        `[forgen-meta] scope promotion: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // Feature 4: Adaptive Thresholds
  if (config.features.adaptiveThresholds) {
    try {
      result.thresholds = computeAdaptiveThresholds(config);
    } catch (e) {
      process.stderr.write(
        `[forgen-meta] adaptive thresholds: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // Feature 5: Extraction Tuning
  if (config.features.extractionTuning) {
    try {
      result.extractionBias = computeExtractionBias(config);
    } catch (e) {
      process.stderr.write(
        `[forgen-meta] extraction tuning: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  return result;
}
