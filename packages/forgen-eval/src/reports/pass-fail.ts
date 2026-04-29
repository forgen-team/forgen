/**
 * Pass-Fail report — φ master gate first, then effect metrics.
 * ADR-006 §PASS Gate.
 */

import type { MetricBundle, PassFailVerdict, RunReport } from '../types.js';

export function judgePassFail(
  metrics: MetricBundle,
  discardRate: number,
): PassFailVerdict {
  const status: Record<string, 'pass' | 'fail' | 'na'> = {};

  // ★ Master gates evaluated FIRST. φ priority: any positive → all other metrics ignored.
  if (metrics.phi > 0.05) {
    return {
      passed: false,
      hardFailReason: 'phi_exceeded',
      metricStatus: { phi: 'fail' },
    };
  }
  if (metrics.psi <= 0) {
    return {
      passed: false,
      hardFailReason: 'psi_non_positive',
      metricStatus: { psi: 'fail' },
    };
  }
  if (metrics.kappa.dev < 0.8 || metrics.kappa.public < 0.7) {
    return {
      passed: false,
      hardFailReason: 'kappa_low',
      metricStatus: { kappa: 'fail' },
    };
  }
  if (discardRate > 0.1) {
    return {
      passed: false,
      hardFailReason: 'discard_high',
      metricStatus: { discard: 'fail' },
    };
  }

  // Effect metrics (all required for PASS)
  status.phi = 'pass';
  status.psi = 'pass';
  status.kappa = 'pass';
  status.gamma = metrics.gamma.cohenD >= 0.8 ? 'pass' : 'fail';
  status.beta = metrics.beta.pairedDiff >= 0.5 ? 'pass' : 'fail';
  status.delta =
    Object.values(metrics.delta).some((v) => v >= 0.9) ? 'pass' : 'fail';
  status.epsilon =
    Object.values(metrics.epsilon).some((v) => v >= 0.85) ? 'pass' : 'fail';
  status.zeta =
    Object.values(metrics.zeta).some((v) => v >= 0.85) ? 'pass' : 'fail';

  const allPass = Object.values(status).every((s) => s === 'pass');
  return { passed: allPass, metricStatus: status };
}

export function renderMarkdownReport(r: RunReport): string {
  const v = r.passFail;
  const verdict = v.passed ? '✓ PASS' : `✗ FAIL (${v.hardFailReason ?? 'metric_below_threshold'})`;
  return [
    `# Forgen Testbed Run ${r.runId}`,
    `**Track**: ${r.track} | **Tier**: ${r.tier}`,
    `**claude-mem version**: ${r.claudeMemVersion} | **dataset**: ${r.datasetVersion}`,
    `**Cases**: ${r.totalCases} (${r.discardedCases} discarded, ${((r.discardedCases / r.totalCases) * 100).toFixed(1)}%)`,
    '',
    `## Verdict: ${verdict}`,
    '',
    '## Master Gates',
    `- φ (FP): ${(r.metrics.phi * 100).toFixed(1)}% (${r.metrics.phi <= 0.05 ? '✓' : '✗'} ≤ 5%)`,
    `- ψ (synergy): ${r.metrics.psi.toFixed(2)} (${r.metrics.psi > 0 ? '✓' : '✗'} > 0)`,
    `- κ_DEV: ${r.metrics.kappa.dev.toFixed(2)} | κ_PUBLIC: ${r.metrics.kappa.public.toFixed(2)}`,
    '',
    '## Effect Metrics',
    `- γ Cohen's d: ${r.metrics.gamma.cohenD.toFixed(2)} (Wilcoxon r: ${r.metrics.gamma.wilcoxonR.toFixed(2)}, p=${r.metrics.gamma.pValue.toFixed(3)})`,
    `- β paired diff: ${r.metrics.beta.pairedDiff.toFixed(2)} likert`,
    '',
    `## Cost: $${r.costUsd.toFixed(2)}`,
    r.warnings.length ? `\n## Warnings\n${r.warnings.map((w) => `- ${w}`).join('\n')}` : '',
  ].join('\n');
}
