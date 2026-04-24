/**
 * R9-PA1: `forgen stats` — 7-number single-screen dashboard.
 *
 * Pure aggregation over existing jsonl sources. No new telemetry; surfaces
 * what forgen is *already* learning so users can verify the trust layer is
 * working between Claude sessions.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAllRules } from '../store/rule-store.js';
import { loadRecentEvidence } from '../store/evidence-store.js';

const ENFORCEMENT_DIR = path.join(os.homedir(), '.forgen', 'state', 'enforcement');
const LIFECYCLE_DIR = path.join(os.homedir(), '.forgen', 'state', 'lifecycle');
const STATE_DIR = path.join(os.homedir(), '.forgen', 'state');
const SOLUTIONS_DIR = path.join(os.homedir(), '.forgen', 'me', 'solutions');

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
  const p = path.join(STATE_DIR, 'last-extraction.json');
  if (!fs.existsSync(p)) return 'never';
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as { timestamp?: string; date?: string };
    const ts = data.timestamp ?? data.date;
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
  /**
   * H3 / v0.4.1 — assist 축 가시화. enforcement(block/violation) 는 이미 표시되지만
   * assist(recall hit, surface, extraction) 는 v0.4.0 에서 8,000+ 번 작동했음에도
   * 사용자에게 0건 노출되었다. 오늘 기준 숫자로 "지금 학습되고 있다" 를 surface.
   */
  assistToday: {
    recallHits: number;      // match-eval-log 의 오늘 entries (매칭 시도 수)
    surfaced: number;        // implicit-feedback 의 recommendation_surfaced 오늘
    referenced: number;      // implicit-feedback 의 recall_referenced 오늘 (H4 완결)
    extractedToday: number;  // ~/.forgen/me/solutions 중 오늘 mtime
  };
  /**
   * v0.4.1 철학 고도화 지표 — forge-profile.json 이 실제로 학습됐는지 한눈에.
   * 값이 있으면 가시화, 없으면 undefined.
   */
  philosophy?: {
    basePacks: string[];                // ["보수형","확인우선형",...]
    trustPolicy: string;
    axisScores: Record<string, number>; // {quality_safety:0.65,...}
    lastReclassification: string | null;
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
    const profilePath = path.join(os.homedir(), '.forgen', 'me', 'forge-profile.json');
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

  const evidence = loadRecentEvidence(500);
  const corrections = evidence.filter((e) => e.type === 'explicit_correction');
  const correctionsTotal = corrections.length;
  const cutoff7d = Date.now() - 7 * MS_PER_DAY;
  const corrections7d = corrections.filter((e) => Date.parse(e.timestamp) >= cutoff7d).length;

  const violations = readJsonl(path.join(ENFORCEMENT_DIR, 'violations.jsonl'));
  const bypass = readJsonl(path.join(ENFORCEMENT_DIR, 'bypass.jsonl'));
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
  };
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
  lines.push(`  Last extraction: ${s.lastExtraction}`);
  lines.push('');
  return lines.join('\n');
}

export async function handleStats(_args: string[]): Promise<void> {
  const snap = computeStats();
  console.log(renderStats(snap));
}
