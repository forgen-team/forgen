/**
 * Forgen — Compound Dashboard
 *
 * Provides a rich terminal overview of the compound knowledge system:
 * knowledge inventory, injection activity, lifecycle transitions,
 * session history, and hook health.
 *
 * Data is collected from:
 *   - ME_SOLUTIONS, ME_RULES, ME_BEHAVIOR (knowledge files)
 *   - MATCH_EVAL_LOG_PATH (injection/matching decisions)
 *   - STATE_DIR (hook-errors.json, last-extraction.json)
 *   - Solution frontmatter (lifecycle evidence fields)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ME_SOLUTIONS,
  ME_RULES,
  ME_BEHAVIOR,
  STATE_DIR,
} from './paths.js';
import { parseFrontmatterOnly } from '../engine/solution-format.js';
import type { SolutionFrontmatter, SolutionStatus } from '../engine/solution-format.js';
import { readMatchEvalLog } from '../engine/match-eval-log.js';

// ── ANSI color helpers ──

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }

// ── Box-drawing table helpers ──

function tableRow(cols: string[], widths: number[]): string {
  return '  │ ' + cols.map((c, i) => c.padEnd(widths[i])).join(' │ ') + ' │';
}

function tableSep(widths: number[], top = false, bottom = false): string {
  const left = top ? '┌' : bottom ? '└' : '├';
  const mid = top ? '┬' : bottom ? '┴' : '┼';
  const right = top ? '┐' : bottom ? '┘' : '┤';
  return '  ' + left + widths.map(w => '─'.repeat(w + 2)).join(mid) + right;
}

// ── Data Collection Types ──

export interface KnowledgeOverview {
  solutions: {
    total: number;
    byStatus: Record<SolutionStatus, number>;
  };
  rules: { total: number; categories: Record<string, number> };
  behavior: { total: number };
  dateRange: { oldest: string | null; newest: string | null };
}

export interface InjectionActivity {
  totalRecords: number;
  recentInjections: Array<{ name: string; ts: string; source: string }>;
  topSolutions: Array<{ name: string; count: number }>;
  hookCount: number;
  mcpCount: number;
}

export interface ReflectionData {
  totalSolutions: number;
  reflectedCount: number;
  unreflectedCount: number;
  reflectionRate: number;
}

export interface LifecycleActivity {
  recentPromotionCandidates: Array<{ name: string; status: SolutionStatus; evidence: { reflected: number; sessions: number; negative: number } }>;
  statusDistribution: Record<SolutionStatus, number>;
}

export interface SessionHistory {
  lastExtraction: { date: string; extractionsToday: number } | null;
}

export interface HookHealth {
  errors: Array<{ hookName: string; count: number; lastAt: string }>;
}

// ── Data Collection Functions ──

/** Read all .md files in a directory and return their frontmatter. */
function readFrontmatters(dir: string): SolutionFrontmatter[] {
  const results: SolutionFrontmatter[] = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const fm = parseFrontmatterOnly(content);
        if (fm) results.push(fm);
      } catch { /* skip unreadable files */ }
    }
  } catch { /* skip unreadable directories */ }
  return results;
}

/** Count files in a directory (non-recursive). */
function countDirFiles(dir: string, ext?: string): number {
  try {
    if (!fs.existsSync(dir)) return 0;
    const files = fs.readdirSync(dir);
    return ext ? files.filter(f => f.endsWith(ext)).length : files.length;
  } catch {
    return 0;
  }
}

/** Collect knowledge overview data. */
export function collectKnowledgeOverview(): KnowledgeOverview {
  const solutionFms = readFrontmatters(ME_SOLUTIONS);
  const ruleFms = readFrontmatters(ME_RULES);

  const byStatus: Record<SolutionStatus, number> = {
    experiment: 0, candidate: 0, verified: 0, mature: 0, retired: 0,
  };
  for (const fm of solutionFms) {
    if (fm.status in byStatus) byStatus[fm.status]++;
  }

  // Rules categorized by type
  const ruleCategories: Record<string, number> = {};
  for (const fm of ruleFms) {
    const key = fm.type ?? 'unknown';
    ruleCategories[key] = (ruleCategories[key] ?? 0) + 1;
  }

  // Behavior file count
  const behaviorCount = countDirFiles(ME_BEHAVIOR, '.md') + countDirFiles(ME_BEHAVIOR, '.json');

  // Date range across all frontmatters
  const allFms = [...solutionFms, ...ruleFms];
  let oldest: string | null = null;
  let newest: string | null = null;
  for (const fm of allFms) {
    if (!oldest || fm.created < oldest) oldest = fm.created;
    if (!newest || fm.updated > newest) newest = fm.updated;
  }

  return {
    solutions: { total: solutionFms.length, byStatus },
    rules: { total: ruleFms.length, categories: ruleCategories },
    behavior: { total: behaviorCount },
    dateRange: { oldest, newest },
  };
}

/** Collect injection activity from match-eval-log. */
export function collectInjectionActivity(): InjectionActivity {
  const records = readMatchEvalLog();

  // Recent injections (last 10)
  const sorted = [...records].sort((a, b) => b.ts.localeCompare(a.ts));
  const recentInjections = sorted.slice(0, 10).flatMap(r =>
    r.rankedTopN.map(name => ({ name, ts: r.ts, source: r.source })),
  ).slice(0, 10);

  // Top 5 most frequently injected solutions
  const freq = new Map<string, number>();
  for (const r of records) {
    for (const name of r.rankedTopN) {
      freq.set(name, (freq.get(name) ?? 0) + 1);
    }
  }
  const topSolutions = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const hookCount = records.filter(r => r.source === 'hook').length;
  const mcpCount = records.filter(r => r.source === 'mcp').length;

  return {
    totalRecords: records.length,
    recentInjections,
    topSolutions,
    hookCount,
    mcpCount,
  };
}

/** Collect code reflection data from solution evidence. */
export function collectReflectionData(): ReflectionData {
  const fms = readFrontmatters(ME_SOLUTIONS);
  const reflected = fms.filter(fm => fm.evidence.reflected > 0).length;
  const unreflected = fms.filter(fm => fm.evidence.reflected === 0 && fm.status !== 'retired').length;
  const activeFms = fms.filter(fm => fm.status !== 'retired');
  const rate = activeFms.length > 0 ? (reflected / activeFms.length) * 100 : 0;

  return {
    totalSolutions: fms.length,
    reflectedCount: reflected,
    unreflectedCount: unreflected,
    reflectionRate: rate,
  };
}

/** Collect lifecycle activity data. */
export function collectLifecycleActivity(): LifecycleActivity {
  const fms = readFrontmatters(ME_SOLUTIONS);

  const statusDistribution: Record<SolutionStatus, number> = {
    experiment: 0, candidate: 0, verified: 0, mature: 0, retired: 0,
  };
  for (const fm of fms) {
    if (fm.status in statusDistribution) statusDistribution[fm.status]++;
  }

  // Solutions approaching promotion (high evidence, not yet promoted)
  const candidates = fms
    .filter(fm => fm.status !== 'retired' && fm.status !== 'mature')
    .map(fm => ({
      name: fm.name,
      status: fm.status,
      evidence: {
        reflected: fm.evidence.reflected,
        sessions: fm.evidence.sessions,
        negative: fm.evidence.negative,
      },
    }))
    .sort((a, b) => b.evidence.reflected - a.evidence.reflected)
    .slice(0, 5);

  return { recentPromotionCandidates: candidates, statusDistribution };
}

/** Collect session extraction history. */
export function collectSessionHistory(): SessionHistory {
  const lastExtractionPath = path.join(STATE_DIR, 'last-extraction.json');
  try {
    if (fs.existsSync(lastExtractionPath)) {
      const data = JSON.parse(fs.readFileSync(lastExtractionPath, 'utf-8'));
      return {
        lastExtraction: {
          date: data.lastExtractedAt ?? 'unknown',
          extractionsToday: data.extractionsToday ?? 0,
        },
      };
    }
  } catch { /* skip */ }
  return { lastExtraction: null };
}

/** Collect hook error data. */
export function collectHookHealth(): HookHealth {
  const errorPath = path.join(STATE_DIR, 'hook-errors.json');
  try {
    if (fs.existsSync(errorPath)) {
      const data = JSON.parse(fs.readFileSync(errorPath, 'utf-8')) as Record<string, { count: number; lastAt: string }>;
      const errors = Object.entries(data).map(([hookName, info]) => ({
        hookName,
        count: info.count,
        lastAt: info.lastAt,
      }));
      return { errors };
    }
  } catch { /* skip */ }
  return { errors: [] };
}

// ── Rendering ──

function renderKnowledgeOverview(data: KnowledgeOverview): string {
  const lines: string[] = [];
  lines.push(`  ${bold(cyan('Knowledge Overview'))}`);
  lines.push('');

  // Solutions table
  const statusWidths = [14, 6];
  lines.push(tableSep(statusWidths, true));
  lines.push(tableRow(['Status', 'Count'], statusWidths));
  lines.push(tableSep(statusWidths));
  for (const [status, count] of Object.entries(data.solutions.byStatus)) {
    if (count === 0 && status === 'retired') continue;
    const colorFn = status === 'mature' ? green
      : status === 'verified' ? green
      : status === 'experiment' ? yellow
      : status === 'retired' ? red
      : (s: string) => s;
    lines.push(tableRow([colorFn(status), String(count)], statusWidths));
  }
  lines.push(tableSep(statusWidths, false, true));
  lines.push(`  Solutions: ${bold(String(data.solutions.total))}  Rules: ${bold(String(data.rules.total))}  Behavior: ${bold(String(data.behavior.total))}`);

  if (data.dateRange.oldest && data.dateRange.newest) {
    lines.push(`  Date range: ${dim(data.dateRange.oldest)} → ${dim(data.dateRange.newest)}`);
  }

  return lines.join('\n');
}

function renderInjectionActivity(data: InjectionActivity): string {
  const lines: string[] = [];
  lines.push(`  ${bold(cyan('Injection Activity'))}`);
  lines.push('');

  if (data.totalRecords === 0) {
    lines.push(`  ${dim('No injection records found.')}`);
    return lines.join('\n');
  }

  lines.push(`  Total decisions: ${bold(String(data.totalRecords))}  (hook: ${data.hookCount}, mcp: ${data.mcpCount})`);
  lines.push('');

  if (data.topSolutions.length > 0) {
    lines.push(`  ${bold('Top injected solutions:')}`);
    for (const s of data.topSolutions) {
      const bar = '█'.repeat(Math.min(s.count, 30));
      lines.push(`    ${s.name.padEnd(35)} ${green(bar)} ${s.count}`);
    }
  }

  if (data.recentInjections.length > 0) {
    lines.push('');
    lines.push(`  ${bold('Recent injections:')}`);
    for (const inj of data.recentInjections.slice(0, 5)) {
      const date = inj.ts.slice(0, 16).replace('T', ' ');
      lines.push(`    ${dim(date)} [${inj.source}] ${inj.name}`);
    }
  }

  return lines.join('\n');
}

function renderReflectionData(data: ReflectionData): string {
  const lines: string[] = [];
  lines.push(`  ${bold(cyan('Code Reflection'))}`);
  lines.push('');

  if (data.totalSolutions === 0) {
    lines.push(`  ${dim('No solutions to analyze.')}`);
    return lines.join('\n');
  }

  const rateColor = data.reflectionRate >= 50 ? green
    : data.reflectionRate >= 20 ? yellow
    : red;

  lines.push(`  Reflection rate: ${rateColor(`${data.reflectionRate.toFixed(1)}%`)}`);
  lines.push(`  Reflected in code: ${green(String(data.reflectedCount))}  Not reflected: ${data.unreflectedCount > 0 ? yellow(String(data.unreflectedCount)) : String(data.unreflectedCount)}`);

  return lines.join('\n');
}

function renderLifecycleActivity(data: LifecycleActivity): string {
  const lines: string[] = [];
  lines.push(`  ${bold(cyan('Lifecycle Activity'))}`);
  lines.push('');

  // Status distribution bar
  const total = Object.values(data.statusDistribution).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const barWidth = 30;
    const segments: string[] = [];
    for (const [status, count] of Object.entries(data.statusDistribution)) {
      if (count === 0) continue;
      const width = Math.max(1, Math.round((count / total) * barWidth));
      const char = status === 'mature' ? `${GREEN}${'█'.repeat(width)}${RESET}`
        : status === 'verified' ? `${GREEN}${'▓'.repeat(width)}${RESET}`
        : status === 'candidate' ? `${CYAN}${'▒'.repeat(width)}${RESET}`
        : status === 'experiment' ? `${YELLOW}${'░'.repeat(width)}${RESET}`
        : `${RED}${'·'.repeat(width)}${RESET}`;
      segments.push(char);
    }
    lines.push(`  ${segments.join('')}`);
    lines.push(`  ${dim('█ mature  ▓ verified  ▒ candidate  ░ experiment  · retired')}`);
  }

  if (data.recentPromotionCandidates.length > 0) {
    lines.push('');
    lines.push(`  ${bold('Approaching promotion:')}`);
    for (const c of data.recentPromotionCandidates) {
      const ev = c.evidence;
      const negStr = ev.negative > 0 ? red(` neg:${ev.negative}`) : '';
      lines.push(`    ${c.name.padEnd(35)} [${c.status}] ref:${ev.reflected} sess:${ev.sessions}${negStr}`);
    }
  }

  return lines.join('\n');
}

function renderSessionHistory(data: SessionHistory): string {
  const lines: string[] = [];
  lines.push(`  ${bold(cyan('Session History'))}`);
  lines.push('');

  if (!data.lastExtraction) {
    lines.push(`  ${dim('No extraction history found.')}`);
    return lines.join('\n');
  }

  const ext = data.lastExtraction;
  lines.push(`  Last extraction: ${dim(ext.date)}`);
  lines.push(`  Extractions today: ${bold(String(ext.extractionsToday))}`);

  return lines.join('\n');
}

function renderHookHealth(data: HookHealth): string {
  const lines: string[] = [];
  lines.push(`  ${bold(cyan('Hook Health'))}`);
  lines.push('');

  if (data.errors.length === 0) {
    lines.push(`  ${green('All hooks healthy — no errors recorded.')}`);
    return lines.join('\n');
  }

  const widths = [25, 6, 20];
  lines.push(tableSep(widths, true));
  lines.push(tableRow(['Hook', 'Errors', 'Last Error'], widths));
  lines.push(tableSep(widths));
  for (const err of data.errors.sort((a, b) => b.count - a.count)) {
    const lastDate = err.lastAt.slice(0, 16).replace('T', ' ');
    lines.push(tableRow([
      err.hookName,
      red(String(err.count)),
      dim(lastDate),
    ], widths));
  }
  lines.push(tableSep(widths, false, true));

  return lines.join('\n');
}

// ── Main Dashboard Renderer ──

// ── Learning Curve: 교정 추이 + 절약 시간 추정 ──

export interface LearningCurve {
  correctionsLast7d: number;
  correctionsPrev7d: number;
  correctionTrend: 'improving' | 'stable' | 'worsening';
  evidenceTotalDays: number;
  sessionsAnalyzed: number;
  estimatedMinutesSaved: number;
  topCorrectionAxes: Array<{ axis: string; count: number }>;
}

/**
 * Learning Curve 수집.
 * evidence 파일(교정 기록)과 compound 활용률을 교차 분석하여 "쓸수록 나아진다"를 정량화.
 */
export function collectLearningCurve(): LearningCurve {
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  let correctionsLast7d = 0;
  let correctionsPrev7d = 0;
  const axisCounts = new Map<string, number>();
  const uniqueDays = new Set<string>();

  try {
    if (fs.existsSync(ME_BEHAVIOR)) {
      const files = fs.readdirSync(ME_BEHAVIOR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(ME_BEHAVIOR, f), 'utf-8')) as {
            timestamp?: string;
            axis_hint?: string;
          };
          if (!data.timestamp) continue;
          const ts = new Date(data.timestamp).getTime();
          if (!Number.isFinite(ts)) continue;
          const age = now - ts;
          if (age < SEVEN_DAYS_MS) correctionsLast7d++;
          else if (age < 2 * SEVEN_DAYS_MS) correctionsPrev7d++;

          if (data.axis_hint) {
            axisCounts.set(data.axis_hint, (axisCounts.get(data.axis_hint) ?? 0) + 1);
          }
          uniqueDays.add(new Date(ts).toISOString().slice(0, 10));
        } catch { /* 개별 파일 파싱 실패 무시 */ }
      }
    }
  } catch { /* fail-open */ }

  // 추세 판정: 전주 대비 30% 이상 감소 = improving, 30% 이상 증가 = worsening
  let correctionTrend: 'improving' | 'stable' | 'worsening' = 'stable';
  if (correctionsPrev7d > 0) {
    const delta = (correctionsLast7d - correctionsPrev7d) / correctionsPrev7d;
    if (delta < -0.3) correctionTrend = 'improving';
    else if (delta > 0.3) correctionTrend = 'worsening';
  }

  // 상위 교정 축
  const topCorrectionAxes = Array.from(axisCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([axis, count]) => ({ axis, count }));

  // 세션 수: evidence 날짜 기준 (고유 날짜 × 평균 2세션/일 가정)
  const sessionsAnalyzed = uniqueDays.size * 2;

  // 추정 절약 시간: 지난 7일 compound 주입 이벤트당 평균 8분 절약 가정
  // (경쟁자 분석에서 도출한 경험적 수치 — 카운터팩추얼의 하한 추정)
  const injection = collectInjectionActivity();
  let successfulInjections = 0;
  try {
    for (const rec of injection.recentInjections ?? []) {
      const ts = new Date(rec.ts).getTime();
      if (Number.isFinite(ts) && now - ts < SEVEN_DAYS_MS) successfulInjections++;
    }
  } catch { /* fail-open */ }
  const estimatedMinutesSaved = Math.round(successfulInjections * 8);

  return {
    correctionsLast7d,
    correctionsPrev7d,
    correctionTrend,
    evidenceTotalDays: uniqueDays.size,
    sessionsAnalyzed,
    estimatedMinutesSaved,
    topCorrectionAxes,
  };
}

function renderLearningCurve(data: LearningCurve): string {
  const trendIcon = data.correctionTrend === 'improving'
    ? green('↓ 감소')
    : data.correctionTrend === 'worsening'
      ? red('↑ 증가')
      : dim('→ 유지');

  const axisLines = data.topCorrectionAxes.length > 0
    ? data.topCorrectionAxes.map(a => `    ${a.axis}: ${a.count}회`).join('\n')
    : `    ${dim('(아직 교정 데이터 없음)')}`;

  const savedHours = Math.floor(data.estimatedMinutesSaved / 60);
  const savedMins = data.estimatedMinutesSaved % 60;
  const savedStr = savedHours > 0 ? `${savedHours}시간 ${savedMins}분` : `${savedMins}분`;

  return [
    `  ${bold('📈 Learning Curve / 학습 곡선')}`,
    ``,
    `  교정 추이 (지난 7일):`,
    `    이번 주: ${data.correctionsLast7d}건`,
    `    지난 주: ${data.correctionsPrev7d}건`,
    `    추세: ${trendIcon}`,
    ``,
    `  주요 교정 축 (누적):`,
    axisLines,
    ``,
    `  누적 사용:`,
    `    활동한 일수: ${data.evidenceTotalDays}일`,
    `    분석된 세션: 약 ${data.sessionsAnalyzed}회`,
    ``,
    `  ${cyan('추정 절약 시간')} (compound 주입 성공 기반):`,
    `    ${bold(savedStr)} ${dim('(지난 7일)')}`,
    `    ${dim('※ compound가 힌트를 제공한 매 1회당 평균 8분 절약 가정')}`,
  ].join('\n');
}

function renderFitnessSummary(): string {
  // Lazy import: keep dashboard startup cheap if outcomes are absent.
  let summary: { total: number; champion: number; active: number; underperform: number; draft: number; top: Array<{ name: string; fitness: number; state: string }> };
  try {
    const { computeFitness } = require('../engine/solution-fitness.js') as typeof import('../engine/solution-fitness.js');
    const records = computeFitness();
    summary = {
      total: records.length,
      champion: records.filter((r) => r.state === 'champion').length,
      active: records.filter((r) => r.state === 'active').length,
      underperform: records.filter((r) => r.state === 'underperform').length,
      draft: records.filter((r) => r.state === 'draft').length,
      top: records.slice(0, 3).map((r) => ({ name: r.solution, fitness: r.fitness, state: r.state })),
    };
  } catch {
    summary = { total: 0, champion: 0, active: 0, underperform: 0, draft: 0, top: [] };
  }

  if (summary.total === 0) {
    return [
      `  ${bold('🎯 Solution Fitness / 솔루션 적합도')}`,
      ``,
      `    ${dim('아직 outcome 이벤트 데이터 없음.')}`,
      `    ${dim('솔루션 주입이 누적되면 자동으로 채워집니다.')}`,
    ].join('\n');
  }

  const topLines = summary.top.length > 0
    ? summary.top.map((t) => {
        const icon = t.state === 'champion' ? green('●') : t.state === 'underperform' ? red('●') : cyan('●');
        return `    ${icon} ${t.name.slice(0, 44).padEnd(44)} ${t.fitness.toFixed(2)} (${t.state})`;
      }).join('\n')
    : `    ${dim('(top 3 없음)')}`;

  return [
    `  ${bold('🎯 Solution Fitness / 솔루션 적합도')}`,
    ``,
    `  상태 분포 (총 ${summary.total}개):`,
    `    ${green('champion')}: ${summary.champion}   ${cyan('active')}: ${summary.active}   ${red('underperform')}: ${summary.underperform}   ${dim('draft')}: ${summary.draft}`,
    ``,
    `  Top 3 by fitness:`,
    topLines,
    ``,
    `  ${dim('상세: forgen learn fitness')}`,
  ].join('\n');
}

export function renderDashboard(): string {
  const knowledge = collectKnowledgeOverview();
  const injection = collectInjectionActivity();
  const reflection = collectReflectionData();
  const lifecycle = collectLifecycleActivity();
  const session = collectSessionHistory();
  const hookHealth = collectHookHealth();
  const learning = collectLearningCurve();

  const divider = `  ${dim('─'.repeat(50))}`;

  const sections = [
    '',
    `  ${BOLD}${CYAN}╔══════════════════════════════════════════════╗${RESET}`,
    `  ${BOLD}${CYAN}║         Forgen Compound Dashboard            ║${RESET}`,
    `  ${BOLD}${CYAN}╚══════════════════════════════════════════════╝${RESET}`,
    '',
    renderLearningCurve(learning),
    divider,
    renderFitnessSummary(),
    divider,
    renderKnowledgeOverview(knowledge),
    divider,
    renderInjectionActivity(injection),
    divider,
    renderReflectionData(reflection),
    divider,
    renderLifecycleActivity(lifecycle),
    divider,
    renderSessionHistory(session),
    divider,
    renderHookHealth(hookHealth),
    '',
  ];

  return sections.join('\n');
}

/** CLI handler: forgen dashboard */
export async function handleDashboard(): Promise<void> {
  console.log(renderDashboard());
}
