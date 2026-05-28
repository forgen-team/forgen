/**
 * R9-PA1: `forgen stats` — 7-number single-screen dashboard.
 *
 * Pure aggregation over existing jsonl sources. No new telemetry; surfaces
 * what forgen is *already* learning so users can verify the trust layer is
 * working between Claude sessions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadAllRules } from '../store/rule-store.js';
import { loadAllEvidence } from '../store/evidence-store.js';
import { STATE_DIR, ME_DIR } from './paths.js';
import { computeFixFeatRatio, formatFixRatio } from './git-stats.js';

// v0.4.1 격리 fix: 이전에는 os.homedir() 직접 사용해서 FORGEN_HOME env 로
// 홈 격리해도 이 파일의 경로는 여전히 실 홈 가리켰음. paths.ts 상수 import.
const ENFORCEMENT_DIR = path.join(STATE_DIR, 'enforcement');
const LIFECYCLE_DIR = path.join(STATE_DIR, 'lifecycle');
const SOLUTIONS_DIR = path.join(ME_DIR, 'solutions');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function readJsonl(p: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(p)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch { /* skip malformed */ }
  }
  return out;
}

function countWithin(entries: Array<Record<string, unknown>>, days: number, tsKey = 'at'): number {
  const cutoff = Date.now() - days * MS_PER_DAY;
  let n = 0;
  for (const e of entries) {
    const raw = e[tsKey];
    if (typeof raw !== 'string') continue;
    const t = Date.parse(raw);
    if (Number.isFinite(t) && t >= cutoff) n += 1;
  }
  return n;
}

function readLifecycleRetired(days: number): number {
  if (!fs.existsSync(LIFECYCLE_DIR)) return 0;
  const cutoff = Date.now() - days * MS_PER_DAY;
  let n = 0;
  for (const f of fs.readdirSync(LIFECYCLE_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const entry of readJsonl(path.join(LIFECYCLE_DIR, f))) {
      const action = entry.suggested_action;
      const ts = typeof entry.ts === 'number' ? entry.ts : Date.parse(String(entry.ts ?? ''));
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      if (action === 'retire' || action === 'supersede') n += 1;
    }
  }
  return n;
}

function readLastExtraction(): string {
  // v0.4.1 파일명 정합: auto-compound-runner 는 last-auto-compound.json 에 기록.
  // 이전 코드가 last-extraction.json 을 찾아 "never" 가 만성적으로 표시됨 —
  // 실은 매 auto-compound 세션마다 값이 업데이트되고 있는데도 stats 에 반영 X.
  const candidates = ['last-auto-compound.json', 'last-extraction.json'];
  let p: string | null = null;
  for (const name of candidates) {
    const candidate = path.join(STATE_DIR, name);
    if (fs.existsSync(candidate)) { p = candidate; break; }
  }
  if (!p) return 'never';
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      timestamp?: string;
      date?: string;
      completedAt?: string;
    };
    const ts = data.completedAt ?? data.timestamp ?? data.date;
    if (!ts) return 'never';
    const diffDays = Math.floor((Date.now() - Date.parse(ts)) / MS_PER_DAY);
    const dateStr = new Date(ts).toISOString().slice(0, 10);
    if (diffDays === 0) return `${dateStr} (today)`;
    if (diffDays === 1) return `${dateStr} (yesterday)`;
    return `${dateStr} (${diffDays}d ago)`;
  } catch {
    return 'unknown';
  }
}

export interface StatsSnapshot {
  activeRules: number;
  suppressedRules: number;
  correctionsTotal: number;
  corrections7d: number;
  blocks7d: number;
  acks7d: number;
  bypass7d: number;
  drift7d: number;
  retired7d: number;
  lastExtraction: string;
  assistToday: {
    recallHits: number;
    surfaced: number;
    referenced: number;
    extractedToday: number;
  };
  philosophy?: {
    basePacks: string[];
    trustPolicy: string;
    axisScores: Record<string, number>;
    lastReclassification: string | null;
  };
  /** v0.5.0: solution health — status 분포, 활용률 */
  solutionHealth: {
    total: number;
    byStatus: Record<string, number>;
    avgConfidence: number;
    /** 지난 7일간 match-eval-log에서 한 번이라도 매칭된 솔루션 비율 */
    utilization7d: number;
  };
  /** v0.5.0: 7일간 가장 많이 발동된 규칙 top-3 */
  topRules7d: Array<{ name: string; count: number }>;
  /** v0.5.0: 이번주 vs 지난주 변화량 */
  weeklyTrend: {
    blocksThisWeek: number;
    blocksLastWeek: number;
    recallsThisWeek: number;
    recallsLastWeek: number;
    extractionsThisWeek: number;
    extractionsLastWeek: number;
  };
}

/** H3: 오늘 (local midnight ~ now) 기준 assist 카운트. */
function computeAssistToday(): StatsSnapshot['assistToday'] {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const cutoffMs = startOfDay.getTime();

  // recall hits: match-eval-log 의 오늘 entries
  const matchLog = readJsonl(path.join(STATE_DIR, 'match-eval-log.jsonl'));
  let recallHits = 0;
  for (const e of matchLog) {
    const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
    if (Number.isFinite(ts) && ts >= cutoffMs) recallHits++;
  }

  // surfaced + referenced — 같은 스트림 1회 loop 로.
  const feedback = readJsonl(path.join(STATE_DIR, 'implicit-feedback.jsonl'));
  let surfaced = 0;
  let referenced = 0;
  for (const e of feedback) {
    const ts = typeof e.at === 'string' ? Date.parse(e.at) : NaN;
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    if (e.type === 'recommendation_surfaced') surfaced++;
    else if (e.type === 'recall_referenced') referenced++;
  }

  // extracted today: solutions dir 에서 오늘 mtime 인 .md 파일
  let extractedToday = 0;
  try {
    if (fs.existsSync(SOLUTIONS_DIR)) {
      for (const f of fs.readdirSync(SOLUTIONS_DIR)) {
        if (!f.endsWith('.md')) continue;
        const stat = fs.statSync(path.join(SOLUTIONS_DIR, f));
        if (stat.mtimeMs >= cutoffMs) extractedToday++;
      }
    }
  } catch { /* fail-open */ }

  return { recallHits, surfaced, referenced, extractedToday };
}

/** v0.4.1: forge-profile 에서 고도화 지표 추출. 파일 없거나 깨지면 undefined. */
function computePhilosophy(): StatsSnapshot['philosophy'] {
  try {
    const profilePath = path.join(ME_DIR, 'forge-profile.json');
    if (!fs.existsSync(profilePath)) return undefined;
    const d = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as {
      axes?: Record<string, { score?: number }>;
      base_packs?: Record<string, string>;
      trust_preferences?: { desired_policy?: string };
      metadata?: { last_reclassification_at?: string | null };
    };
    const axisScores: Record<string, number> = {};
    for (const [k, v] of Object.entries(d.axes ?? {})) {
      if (v && typeof v.score === 'number') axisScores[k] = v.score;
    }
    return {
      basePacks: Object.values(d.base_packs ?? {}),
      trustPolicy: d.trust_preferences?.desired_policy ?? 'unknown',
      axisScores,
      lastReclassification: d.metadata?.last_reclassification_at ?? null,
    };
  } catch {
    return undefined;
  }
}

export function computeStats(): StatsSnapshot {
  const rules = loadAllRules();
  const activeRules = rules.filter((r) => r.status === 'active').length;
  const suppressedRules = rules.filter((r) => r.status === 'suppressed').length;

  // v0.4.1 정확도 수정: loadRecentEvidence(500) 제한은 "Corrections (total)"
  // 라벨과 모순 — 실 behavior 618건 중 118건 누락됐음. 전체 evidence 스캔으로
  // 교체. explicit_correction 만 filter 이므로 memory overhead 는 N * ~1KB 수준.
  const evidence = loadAllEvidence();
  const corrections = evidence.filter((e) => e.type === 'explicit_correction');
  const correctionsTotal = corrections.length;
  const cutoff7d = Date.now() - 7 * MS_PER_DAY;
  const corrections7d = corrections.filter((e) => Date.parse(e.timestamp) >= cutoff7d).length;

  const violations = readJsonl(path.join(ENFORCEMENT_DIR, 'violations.jsonl'));
  // v0.4.1 historical false-positive 제거: pre-0.4.1 bypass-detector 가 Write/Edit
  // content 의 quote 본문까지 raw 매칭해서 bypass 로 오기록. 실 관찰: L1-no-rm-rf
  // -unconfirmed bypass 20건 중 Write/Edit 15건. stats 표시는 **실 실행 맥락** 인
  // Bash/Agent/기타만 집계 — 앞으로의 시계열 일관성 + 과거 noise 제거.
  const bypassRaw = readJsonl(path.join(ENFORCEMENT_DIR, 'bypass.jsonl'));
  const bypass = bypassRaw.filter((e) => e.tool !== 'Write' && e.tool !== 'Edit');
  const drift = readJsonl(path.join(ENFORCEMENT_DIR, 'drift.jsonl'));
  const acks = readJsonl(path.join(ENFORCEMENT_DIR, 'acknowledgments.jsonl'));

  // R9-PA2: violations 는 'block' (stop-guard/post-tool) + 'deny' (pre-tool Mech-A)
  // + 'correction' (user bypass audit) 혼재. 사용자 관점에서 "Block" 은 앞의 2종이며
  // correction 은 제외해야 ack ratio 가 의미를 갖는다. legacy-undefined 엔트리도 포함.
  const realBlocks = violations.filter((e) =>
    e.kind === 'block' || e.kind === 'deny' || e.kind === undefined,
  );

  return {
    activeRules,
    suppressedRules,
    correctionsTotal,
    corrections7d,
    blocks7d: countWithin(realBlocks, 7),
    acks7d: countWithin(acks, 7),
    bypass7d: countWithin(bypass, 7),
    drift7d: countWithin(drift, 7),
    retired7d: readLifecycleRetired(7),
    lastExtraction: readLastExtraction(),
    assistToday: computeAssistToday(),
    philosophy: computePhilosophy(),
    solutionHealth: computeSolutionHealth(),
    topRules7d: computeTopRules7d(realBlocks),
    weeklyTrend: computeWeeklyTrend(realBlocks),
  };
}

function computeSolutionHealth(): StatsSnapshot['solutionHealth'] {
  const byStatus: Record<string, number> = {};
  let total = 0;
  let confidenceSum = 0;
  const localNames = new Set<string>();

  try {
    if (!fs.existsSync(SOLUTIONS_DIR)) return { total: 0, byStatus: {}, avgConfidence: 0, utilization7d: 0 };
    const files = fs.readdirSync(SOLUTIONS_DIR).filter(f => f.endsWith('.md'));
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(SOLUTIONS_DIR, f), 'utf-8');
        const statusMatch = content.match(/status:\s*"?([a-z]+)"?/);
        const confMatch = content.match(/confidence:\s*([0-9.]+)/);
        const st = statusMatch?.[1] ?? 'unknown';
        byStatus[st] = (byStatus[st] ?? 0) + 1;
        confidenceSum += parseFloat(confMatch?.[1] ?? '0');
        localNames.add(f.replace(/\.md$/, ''));
        total++;
      } catch { /* skip */ }
    }
  } catch { /* fail-open */ }

  const cutoff7d = Date.now() - 7 * MS_PER_DAY;
  const matchLog = readJsonl(path.join(STATE_DIR, 'match-eval-log.jsonl'));
  const matchedLocalNames = new Set<string>();
  for (const e of matchLog) {
    const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(ts) || ts < cutoff7d) continue;
    const ranked = e.rankedTopN;
    if (Array.isArray(ranked)) {
      for (const r of ranked) {
        let name: string | null = null;
        if (typeof r === 'string') name = r;
        else if (typeof r === 'object' && r !== null && typeof (r as Record<string, unknown>).name === 'string') {
          name = (r as Record<string, string>).name;
        }
        // Only count matches against LOCAL solutions to avoid skew from
        // starter-pack/team-pack matches that aren't in this user's me/solutions/.
        if (name && localNames.has(name)) {
          matchedLocalNames.add(name);
        }
      }
    }
  }

  return {
    total,
    byStatus,
    avgConfidence: total > 0 ? confidenceSum / total : 0,
    utilization7d: total > 0 ? matchedLocalNames.size / total : 0,
  };
}

function computeTopRules7d(violations: Array<Record<string, unknown>>): StatsSnapshot['topRules7d'] {
  const cutoff = Date.now() - 7 * MS_PER_DAY;
  const counts = new Map<string, number>();

  for (const v of violations) {
    const ts = typeof v.at === 'string' ? Date.parse(v.at) : NaN;
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const rule = typeof v.rule === 'string' ? v.rule
      : typeof v.guard === 'string' ? v.guard
      : typeof v.source === 'string' ? v.source
      : 'unknown';
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));
}

function computeWeeklyTrend(violations: Array<Record<string, unknown>>): StatsSnapshot['weeklyTrend'] {
  const now = Date.now();
  const thisWeekStart = now - 7 * MS_PER_DAY;
  const lastWeekStart = now - 14 * MS_PER_DAY;

  const blocksThisWeek = countWithin(violations, 7);
  let blocksLastWeek = 0;
  for (const v of violations) {
    const ts = typeof v.at === 'string' ? Date.parse(v.at) : NaN;
    if (Number.isFinite(ts) && ts >= lastWeekStart && ts < thisWeekStart) blocksLastWeek++;
  }

  const matchLog = readJsonl(path.join(STATE_DIR, 'match-eval-log.jsonl'));
  let recallsThisWeek = 0;
  let recallsLastWeek = 0;
  for (const e of matchLog) {
    const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(ts)) continue;
    if (ts >= thisWeekStart) recallsThisWeek++;
    else if (ts >= lastWeekStart) recallsLastWeek++;
  }

  let extractionsThisWeek = 0;
  let extractionsLastWeek = 0;
  try {
    if (fs.existsSync(SOLUTIONS_DIR)) {
      for (const f of fs.readdirSync(SOLUTIONS_DIR)) {
        if (!f.endsWith('.md')) continue;
        const mtime = fs.statSync(path.join(SOLUTIONS_DIR, f)).mtimeMs;
        if (mtime >= thisWeekStart) extractionsThisWeek++;
        else if (mtime >= lastWeekStart) extractionsLastWeek++;
      }
    }
  } catch { /* fail-open */ }

  return { blocksThisWeek, blocksLastWeek, recallsThisWeek, recallsLastWeek, extractionsThisWeek, extractionsLastWeek };
}

function padNum(n: number, width = 4): string {
  return String(n).padStart(width);
}

export function renderStats(s: StatsSnapshot): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  forgen — trust layer status');
  lines.push('  ───────────────────────────');
  lines.push(`  Active rules          ${padNum(s.activeRules)}    (${s.suppressedRules} suppressed)`);
  lines.push(`  Corrections (total)   ${padNum(s.correctionsTotal)}    (+${s.corrections7d} last 7d)`);
  lines.push('');
  lines.push('  Last 7 days');
  // R9-PA2: ack rate = block→retract→pass 루프가 실제 작동한 비율.
  const ackRateLabel = s.blocks7d > 0
    ? `(${Math.round((s.acks7d / s.blocks7d) * 100)}% acknowledged)`
    : '';
  lines.push(`    Blocks              ${padNum(s.blocks7d)}    — times Claude was asked to retract ${ackRateLabel}`);
  lines.push(`    Acknowledgments     ${padNum(s.acks7d)}    — block → retract → pass loops`);
  lines.push(`    Bypass              ${padNum(s.bypass7d)}    — user overrides`);
  lines.push(`    Drift events        ${padNum(s.drift7d)}    — stuck-loop force-approves`);
  lines.push(`    Retired rules       ${padNum(s.retired7d)}    — superseded or timed out`);
  lines.push('');
  // H3: Assist 축 — enforcement 옆에 나란히 가시화.
  lines.push('  Today (assist)');
  lines.push(`    Recall hits         ${padNum(s.assistToday.recallHits)}    — compound 매칭 시도 수`);
  lines.push(`    Surfaced            ${padNum(s.assistToday.surfaced)}    — 실제 주입된 솔루션 수`);
  const ratio = s.assistToday.surfaced > 0
    ? ` (${Math.round(100 * s.assistToday.referenced / s.assistToday.surfaced)}% referenced)`
    : '';
  lines.push(`    Referenced          ${padNum(s.assistToday.referenced)}    — Claude 응답에 인용됨${ratio}`);
  lines.push(`    Extracted           ${padNum(s.assistToday.extractedToday)}    — 오늘 새로 저장된 패턴`);
  lines.push('');

  // v0.4.1 철학 고도화 단면 — "개인화가 어디까지 학습됐나" 1섹션.
  if (s.philosophy) {
    lines.push('  Philosophy (learned)');
    lines.push(`    Base packs          ${s.philosophy.basePacks.join(' / ')}`);
    lines.push(`    Trust policy        ${s.philosophy.trustPolicy}`);
    const scores = Object.entries(s.philosophy.axisScores)
      .map(([k, v]) => `${k}:${v.toFixed(2)}`)
      .join('  ');
    if (scores) lines.push(`    Axis scores         ${scores}`);
    lines.push(`    Last reclass        ${s.philosophy.lastReclassification ?? 'never'}`);
    lines.push('');
  }
  // P4 셀프 가드 — 최근 30커밋 fix:feat 비율로 회귀 패턴 자가 노출.
  // 30% 초과 시 "이거 고치면 저거 버그난다" 패턴 의심 → forgen doctor 가 경고.
  try {
    const ratio = computeFixFeatRatio();
    if (ratio.available) {
      lines.push('  Repo health (last 30 commits)');
      lines.push(`    ${formatFixRatio(ratio)}`);
      lines.push('');
    }
  } catch { /* fail-open: git 없거나 비-repo 환경 */ }

  // v0.5.0: Solution health
  if (s.solutionHealth.total > 0) {
    const sh = s.solutionHealth;
    const statusParts = Object.entries(sh.byStatus).map(([k, v]) => `${k}:${v}`).join(' ');
    lines.push('  Solutions');
    lines.push(`    Total               ${padNum(sh.total)}    ${statusParts}`);
    lines.push(`    Avg confidence      ${sh.avgConfidence.toFixed(2)}`);
    lines.push(`    Utilization (7d)    ${Math.round(sh.utilization7d * 100)}%   — matched at least once`);
    lines.push('');
  }

  // v0.5.0: Top rules (7d)
  if (s.topRules7d.length > 0) {
    lines.push('  Top rules (7d)');
    for (const r of s.topRules7d) {
      lines.push(`    ${padNum(r.count)}x  ${r.name}`);
    }
    lines.push('');
  }

  // v0.5.0: Weekly trend
  const wt = s.weeklyTrend;
  const trendArrow = (curr: number, prev: number) => {
    if (curr > prev) return `+${curr - prev}`;
    if (curr < prev) return `${curr - prev}`;
    return '=';
  };
  lines.push('  Weekly trend (this vs last)');
  lines.push(`    Blocks       ${padNum(wt.blocksThisWeek)} → ${padNum(wt.blocksLastWeek, 2)} prev   (${trendArrow(wt.blocksThisWeek, wt.blocksLastWeek)})`);
  lines.push(`    Recalls      ${padNum(wt.recallsThisWeek)} → ${padNum(wt.recallsLastWeek, 2)} prev   (${trendArrow(wt.recallsThisWeek, wt.recallsLastWeek)})`);
  lines.push(`    Extractions  ${padNum(wt.extractionsThisWeek)} → ${padNum(wt.extractionsLastWeek, 2)} prev   (${trendArrow(wt.extractionsThisWeek, wt.extractionsLastWeek)})`);
  lines.push('');

  lines.push(`  Last extraction: ${s.lastExtraction}`);
  lines.push('');
  return lines.join('\n');
}

export async function handleStats(_args: string[]): Promise<void> {
  const snap = computeStats();
  console.log(renderStats(snap));
}
