/**
 * forgen health — single-line health score (0-100).
 *
 * Combines:
 *   - Solution utilization (7d match rate)      30%
 *   - Block→ack effectiveness                   25%
 *   - Knowledge growth (extractions this week)   20%
 *   - Rule coverage (active rules)               15%
 *   - Profile completeness                       10%
 */

import { computeStats } from './stats-cli.js';

const isTTY = process.stdout.isTTY;
const C = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  red: isTTY ? '\x1b[31m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
};

export interface HealthScore {
  total: number;
  components: {
    utilization: number;
    effectiveness: number;
    growth: number;
    coverage: number;
    profile: number;
  };
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

export function computeHealth(): HealthScore {
  const s = computeStats();

  // 1. Utilization (30%): % of solutions matched in last 7d, capped at 100%
  const utilization = Math.min(1, s.solutionHealth.utilization7d) * 30;

  // 2. Effectiveness (25%): if blocks happened, what % were acknowledged
  let effectiveness: number;
  if (s.blocks7d === 0) {
    effectiveness = 25; // no blocks = no problems
  } else {
    effectiveness = (s.acks7d / s.blocks7d) * 25;
  }

  // 3. Growth (20%): extractions this week (1 extraction = 10pts, cap at 20)
  const growth = Math.min(20, s.weeklyTrend.extractionsThisWeek * 10);

  // 4. Coverage (15%): active rules (1 rule = 3pts, cap at 15)
  const coverage = Math.min(15, s.activeRules * 3);

  // 5. Profile (10%): has profile + has philosophy + axis scores populated
  let profile = 0;
  if (s.philosophy) {
    profile += 4; // profile exists
    if (s.philosophy.basePacks.length > 0) profile += 3;
    if (Object.keys(s.philosophy.axisScores).length >= 4) profile += 3;
  }

  const total = Math.round(utilization + effectiveness + growth + coverage + profile);

  const grade = total >= 80 ? 'A' : total >= 60 ? 'B' : total >= 40 ? 'C' : total >= 20 ? 'D' : 'F';

  return {
    total,
    components: {
      utilization: Math.round(utilization),
      effectiveness: Math.round(effectiveness),
      growth: Math.round(growth),
      coverage: Math.round(coverage),
      profile: Math.round(profile),
    },
    grade,
  };
}

function gradeColor(grade: string): string {
  if (grade === 'A') return C.green;
  if (grade === 'B') return C.cyan;
  if (grade === 'C') return C.yellow;
  return C.red;
}

function bar(value: number, max: number, width = 10): string {
  const filled = Math.round((value / max) * width);
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, width - filled));
}

/** 한 줄 health 요약 — `forgen status` 요약 헤더에서 재사용. */
export function renderHealthLine(h: HealthScore): string {
  const gc = gradeColor(h.grade);
  return `\n  ${C.bold}forgen status${C.reset}  ${gc}${C.bold}${h.grade}${C.reset}  ${gc}${h.total}/100${C.reset}`;
}

export async function handleHealth(): Promise<void> {
  const h = computeHealth();
  const gc = gradeColor(h.grade);

  console.log('');
  console.log(`  ${C.bold}forgen status${C.reset}  ${gc}${C.bold}${h.grade}${C.reset}  ${gc}${h.total}/100${C.reset}`);
  console.log('');
  console.log(`    Utilization    ${bar(h.components.utilization, 30)}  ${h.components.utilization}/30   ${C.dim}solution match rate (7d)${C.reset}`);
  console.log(`    Effectiveness  ${bar(h.components.effectiveness, 25)}  ${h.components.effectiveness}/25   ${C.dim}block→ack ratio${C.reset}`);
  console.log(`    Growth         ${bar(h.components.growth, 20)}  ${h.components.growth}/20   ${C.dim}extractions this week${C.reset}`);
  console.log(`    Coverage       ${bar(h.components.coverage, 15)}  ${h.components.coverage}/15   ${C.dim}active rules${C.reset}`);
  console.log(`    Profile        ${bar(h.components.profile, 10)}  ${h.components.profile}/10   ${C.dim}personalization depth${C.reset}`);
  console.log('');
}
