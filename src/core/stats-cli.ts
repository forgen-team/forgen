/**
 * R9-PA1: `forgen stats` — 7-number single-screen dashboard.
 *
 * Pure aggregation over existing jsonl sources. No new telemetry; surfaces
 * what forgen is *already* learning so users can verify the trust layer is
 * working between Claude sessions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadAllRules, scanRuleFiles } from '../store/rule-store.js';
import { readEvidenceCounts, readSavedTimes, countSince, formatLastExtraction, unreadable, haikuStatus, isInjectedRecall, logFilesWithRotated } from './flow-status.js';
import { STATE_DIR, ME_DIR } from './paths.js';
import { readJsonlWindow, isRealBlock, isConfirmedBypass, isSyntheticEntry, precisionByRule, readVerdicts } from '../engine/lifecycle/signals.js';
import { computeFixFeatRatio, formatFixRatio } from './git-stats.js';

// v0.4.1 격리 fix: 이전에는 os.homedir() 직접 사용해서 FORGEN_HOME env 로
// 홈 격리해도 이 파일의 경로는 여전히 실 홈 가리켰음. paths.ts 상수 import.
const ENFORCEMENT_DIR = path.join(STATE_DIR, 'enforcement');
const LIFECYCLE_DIR = path.join(STATE_DIR, 'lifecycle');
const SOLUTIONS_DIR = path.join(ME_DIR, 'solutions');

const C_DIM = '\x1b[2m';
const C_RESET = '\x1b[0m';
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

/** 회전본(.1/.2/타임스탬프)까지 이어 읽는다. */
function readJsonlRotated(p: string): Array<Record<string, unknown>> {
  return logFilesWithRotated(p).flatMap((f) => readJsonl(f));
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

export interface StatsSnapshot {
  activeRules: number;
  suppressedRules: number;
  /** 사용자가 직접 한 교정 (hook 기록) */
  correctionsTotal: number;
  corrections7d: number;
  /** Haiku 채굴 추론 — 사용자 발화가 아님 */
  minedTotal: number;
  mined7d: number;
  /** 읽기 실패·깨진 파일 경고 (0건과 구분) */
  readErrors: string[];
  blocks7d: number;
  /** ADR-017 §2 원칙 1: 집계에서 제외된 합성 세션(default/unknown) 기록 수 — 누락을 가시화. */
  syntheticExcluded7d: number;
  acks7d: number;
  bypass7d: number;
  drift7d: number;
  retired7d: number;
  lastExtraction: string;
  assistToday: {
    /** 후보가 1개 이상 나온 실세션(hook) recall. */
    recallHits: number;
    /** 오늘 hook 경로 recall 시도 전체(후보 0건 포함). */
    recallAttempts: number;
    /** 오늘 mcp(compound-search) 경로 호출 수 — 테스트 격리(2026-10-06) 이후엔 실 호출. 별도 표기. */
    recallMcp: number;
    surfaced: number;
    referenced: number;
    /** 오늘 새로 저장된 솔루션·룰 (흐름의 "저장"과 같은 정의) */
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
  /** ADR-017 D1: 룰별 precision(7d) — 판정 출처 무관 유효 판정 기준. */
  precision7d: Array<{ rule_id: string; correct: number; false_positive: number; unjudged: number; precision: number | null }>;
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

  // ADR-017 §1.5a: 이전엔 match-eval-log 의 오늘 entry 수 전체를 "Recall hits" 로 셌다 —
  // 후보 0건·mcp 쿼리·vitest 픽스처(7d 773건 중 351건)까지 포함돼 "25회 recall 에 0 surfaced"
  // 라는 틀린 그림을 만들었다. hit = source:hook 이고 후보 ≥1. attempts = hook 전체.
  const matchLog = readJsonlRotated(path.join(STATE_DIR, 'match-eval-log.jsonl'));
  let recallHits = 0;
  let recallAttempts = 0;
  let recallMcp = 0;
  for (const e of matchLog) {
    const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    if (e.source === 'mcp') { recallMcp++; continue; }
    if (e.source !== 'hook') continue;
    recallAttempts++;
    if (isInjectedRecall(e)) recallHits++;
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

  // extracted today: 솔루션 frontmatter created 기준 (mtime 은 touch·cp 로 바뀐다)
  const extractedToday = readSavedTimes().times.filter((t) => t >= cutoffMs).length;

  return { recallHits, recallAttempts, recallMcp, surfaced, referenced, extractedToday };
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
  const ruleScan = scanRuleFiles();
  const rules = ruleScan.dirError ? [] : loadAllRules();
  const activeRules = rules.filter((r) => r.status === 'active').length;
  const suppressedRules = rules.filter((r) => r.status === 'suppressed').length;

  // 교정은 출처별로 분리: 사용자가 직접 한 것(hook)과 Haiku 채굴 추론(auto-compound-miner).
  // 합쳐서 "Corrections 271" 로 표시하면 실제 사용자 교정 39건이 묻힌다.
  const evidence = readEvidenceCounts();
  const correctionsTotal = evidence.user.times.length;
  const corrections7d = countSince(evidence.user.times, 7);
  const minedTotal = evidence.mined.times.length;
  const mined7d = countSince(evidence.mined.times, 7);
  const readErrors: string[] = [];
  if (evidence.user.error) readErrors.push(`behavior 디렉터리: ${evidence.user.error}`);
  const stateErr = unreadable(ENFORCEMENT_DIR);
  if (stateErr) readErrors.push(`state/enforcement: ${stateErr}`);
  if (ruleScan.dirError) readErrors.push(`룰 디렉터리: ${ruleScan.dirError}`);
  if (ruleScan.broken.length > 0) readErrors.push(`깨진 룰 파일 ${ruleScan.broken.length}개 (${ruleScan.broken.slice(0, 2).map((b) => b.file).join(', ')}${ruleScan.broken.length > 2 ? ' …' : ''}) — 룰 수에 포함되지 않음`);

  const violations = readJsonlWindow<Record<string, unknown>>(path.join(ENFORCEMENT_DIR, 'violations.jsonl'), 30);
  // v0.4.1 historical false-positive 제거: pre-0.4.1 bypass-detector 가 Write/Edit
  // content 의 quote 본문까지 raw 매칭해서 bypass 로 오기록. 실 관찰: L1-no-rm-rf
  // -unconfirmed bypass 20건 중 Write/Edit 15건. stats 표시는 **실 실행 맥락** 인
  // Bash/Agent/기타만 집계 — 앞으로의 시계열 일관성 + 과거 noise 제거.
  // ADR-017 D1: bypass.jsonl(자연어 휴리스틱)은 더 이상 읽지 않는다 — 실측 전량 오탐, 실 우회 0건.
  // "Bypass" 는 FORGEN_USER_CONFIRMED=1 명시 우회(kind:'bypass_confirmed')만 센다.
  const bypass = violations.filter(isConfirmedBypass);
  const drift = readJsonlWindow<Record<string, unknown>>(path.join(ENFORCEMENT_DIR, 'drift.jsonl'), 30);
  const acks = readJsonlWindow<Record<string, unknown>>(path.join(ENFORCEMENT_DIR, 'acknowledgments.jsonl'), 30);

  // R9-PA2: violations 는 'block' (stop-guard/post-tool) + 'deny' (pre-tool Mech-A)
  // + 'correction' (메타가드 advise) + 'bypass_confirmed' (사용자 명시 우회) 혼재. 사용자 관점에서 "Block" 은 앞의 2종이며
  // correction 은 제외해야 ack ratio 가 의미를 갖는다. legacy-undefined 엔트리도 포함.
  // ADR-017 §2 원칙 2: session_id 'default'/'unknown'(훅이 session 없이 호출 — 실측 전부 테스트
  // 유래) 도 제외. 기준은 signals.isRealBlock 하나로 통일(explain/lifecycle 과 동일).
  const realBlocks = violations.filter(isRealBlock);

  return {
    activeRules,
    suppressedRules,
    correctionsTotal,
    corrections7d,
    minedTotal,
    mined7d,
    readErrors,
    blocks7d: countWithin(realBlocks, 7),
    syntheticExcluded7d: countWithin(violations.filter((e) => isSyntheticEntry(e)), 7),
    acks7d: countWithin(acks, 7),
    bypass7d: countWithin(bypass, 7),
    drift7d: countWithin(drift, 7),
    retired7d: readLifecycleRetired(7),
    lastExtraction: formatLastExtraction(),
    assistToday: computeAssistToday(),
    philosophy: computePhilosophy(),
    solutionHealth: computeSolutionHealth(),
    topRules7d: computeTopRules7d(realBlocks),
    precision7d: [...precisionByRule(violations as unknown as import('../engine/lifecycle/types.js').ViolationEntry[], readVerdicts(), 7).values()].sort((a, b) => (b.correct + b.false_positive + b.unjudged) - (a.correct + a.false_positive + a.unjudged)).slice(0, 8),
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
  const matchLog = readJsonlRotated(path.join(STATE_DIR, 'match-eval-log.jsonl'));
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
    // ADR-017 D1 (critic 관찰): 이전엔 rule_id 를 보지 않아 'pre-tool-guard' 같은 source 로 집계돼
    // 룰별 precision 과 조인되지 않았다. rule_id 우선.
    const rule = typeof v.rule_id === 'string' ? v.rule_id
      : typeof v.rule === 'string' ? v.rule
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

  const matchLog = readJsonlRotated(path.join(STATE_DIR, 'match-eval-log.jsonl'));
  let recallsThisWeek = 0;
  let recallsLastWeek = 0;
  for (const e of matchLog) {
    const ts = typeof e.ts === 'string' ? Date.parse(e.ts) : NaN;
    if (!Number.isFinite(ts) || !isInjectedRecall(e)) continue; // 흐름의 "주입"·Today 의 Recall hits 와 같은 정의
    if (ts >= thisWeekStart) recallsThisWeek++;
    else if (ts >= lastWeekStart) recallsLastWeek++;
  }

  // 저장 수: 흐름의 "저장"과 같은 정의 — 솔루션 created + 룰 created_at (파일 mtime 아님)
  let extractionsThisWeek = 0;
  let extractionsLastWeek = 0;
  for (const t of readSavedTimes().times) {
    if (t >= thisWeekStart) extractionsThisWeek++;
    else if (t >= lastWeekStart) extractionsLastWeek++;
  }

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
  lines.push(`  Corrections (you)     ${padNum(s.correctionsTotal)}    (+${s.corrections7d} last 7d) — 당신이 직접 한 교정`);
  lines.push(`  Mined (Haiku)         ${padNum(s.minedTotal)}    (+${s.mined7d} last 7d) — 대화에서 추론한 후보, 당신의 발화 아님`);
  for (const e of s.readErrors) lines.push(`  ⚠ 읽기 문제: ${e}`);
  lines.push('');
  lines.push('  Last 7 days');
  // R9-PA2: ack rate = block→retract→pass 루프가 실제 작동한 비율.
  // ack/block 비율은 서로 다른 로그를 나눈 값이라 의미가 없어 표시하지 않는다 (건수만).
  lines.push(`    Blocks              ${padNum(s.blocks7d)}    — times Claude was asked to retract`);
  lines.push(`    Acknowledgments     ${padNum(s.acks7d)}    — block → retract → pass loops`);
  lines.push(`    Bypass (confirmed)  ${padNum(s.bypass7d)}    — FORGEN_USER_CONFIRMED=1 overrides (audited)`);
  if (s.syntheticExcluded7d > 0) lines.push(`    Excluded            ${padNum(s.syntheticExcluded7d)}    — session-less records (tests/probes), not counted above`);
  lines.push(`    Drift events        ${padNum(s.drift7d)}    — stuck-loop force-approves`);
  lines.push(`    Retired rules       ${padNum(s.retired7d)}    — superseded or timed out`);
  lines.push('');
  // H3: Assist 축 — enforcement 옆에 나란히 가시화.
  lines.push('  Today (assist)');
  lines.push(`    Recall hits         ${padNum(s.assistToday.recallHits)}    — 후보가 나온 recall (hook 시도 ${s.assistToday.recallAttempts} · mcp ${s.assistToday.recallMcp})`);
  lines.push(`    Surfaced            ${padNum(s.assistToday.surfaced)}    — 실제 주입된 솔루션 수`);
  lines.push(`    Referenced          ${padNum(s.assistToday.referenced)}    — Claude 응답에 인용됨`);
  lines.push(`    Saved               ${padNum(s.assistToday.extractedToday)}    — 오늘 새로 저장된 솔루션·룰 (흐름의 저장과 같은 기준)`);
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
    lines.push(`    Matched (7d)        ${padNum(Math.round(sh.utilization7d * sh.total))}    — 최근 7일에 한 번이라도 매칭된 솔루션 (전체 ${sh.total})`);
    lines.push('');
  }

  // v0.5.0: Top rules (7d) + ADR-017 D1 precision
  if (s.topRules7d.length > 0) {
    lines.push('  Top rules (7d)                 precision (judged / unjudged)');
    const adviseRules = new Set((() => { try { return loadAllRules(); } catch { return []; } })().filter((r) => r.enforce_mode === 'advise').map((r) => r.rule_id));
    const pmap = new Map(s.precision7d.map((p) => [p.rule_id, p]));
    for (const r of s.topRules7d) {
      const p = pmap.get(r.name);
      const prec = !p ? '' : p.precision === null ? `  —  (0 / ${p.unjudged})` : `  ${Math.round(p.precision * 100)}%  (${p.correct + p.false_positive} / ${p.unjudged})`;
      const advise = adviseRules.has(r.name) ? '  [advise]' : '';
      lines.push(`    ${padNum(r.count)}x  ${r.name.padEnd(28).slice(0, 28)}${prec}${advise}`);
    }
    const unjudged = s.precision7d.reduce((n, p) => n + p.unjudged, 0);
    if (unjudged > 0) {
      const h = haikuStatus();
      const how = h.state === 'off' ? '자동 판정(Haiku)이 꺼져 있어 사람이 판정해야 합니다: forgen block <id> --ok|--fp'
        : h.state === 'on' ? '자동 판정 대기 중' : `자동 판정 불가 (${h.detail})`;
      lines.push(`    ${C_DIM}unjudged ${unjudged} — ${how}${C_RESET}`);
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
  lines.push(`    Recall hits  ${padNum(wt.recallsThisWeek)} → ${padNum(wt.recallsLastWeek, 2)} prev   (${trendArrow(wt.recallsThisWeek, wt.recallsLastWeek)})`);
  lines.push(`    Saved        ${padNum(wt.extractionsThisWeek)} → ${padNum(wt.extractionsLastWeek, 2)} prev   (${trendArrow(wt.extractionsThisWeek, wt.extractionsLastWeek)})`);
  lines.push('');

  lines.push(`  Last extraction: ${s.lastExtraction}`);
  lines.push('');
  return lines.join('\n');
}

export async function handleStats(_args: string[]): Promise<void> {
  const snap = computeStats();
  console.log(renderStats(snap));
}
