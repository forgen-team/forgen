/**
 * 학습 흐름 상태 (D8) — 수집 → 추출 → 저장 → 주입 → 사용 → 피드백.
 *
 * 점수(X/100) 대신 단계별로 "입력이 무엇이고, 마지막으로 성공한 때가 언제이고, 최근 N일에 몇 건인지"를 보여 준다.
 * 0건이면 그 단계가 끊겼을 수 있다는 경고를 낸다. 읽기 실패는 0건과 구분해 사유를 표시한다.
 * 모든 시각은 파일 mtime 이 아니라 기록된 이벤트/frontmatter 시각이다 (cp -r 로 숫자가 변하지 않게).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ME_BEHAVIOR, ME_SOLUTIONS, SESSIONS_DIR, STATE_DIR, V1_SESSIONS_DIR } from './paths.js';
import { logFilesWithin } from '../engine/lifecycle/rotated-logs.js';
import { scanRuleFiles } from '../store/rule-store.js';
import { getHaikuConsentState, apiBillingNote } from './compound-consent.js';
import { summarizeRenderReport } from '../renderer/render-report.js';

const DAY = 24 * 60 * 60 * 1000;
export const FLOW_WINDOW_DAYS = 7;

export interface TimedRead {
  /** epoch ms of each recorded event */
  times: number[];
  /** 읽기 실패 사유 (있으면 0건이 아니라 "읽을 수 없음") */
  error?: string;
}

/** 디렉터리/파일을 읽을 수 없는 사유. 없으면(정상 또는 부재) null. */
export function unreadable(p: string): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    fs.accessSync(p, fs.constants.R_OK | (fs.statSync(p).isDirectory() ? fs.constants.X_OK : 0));
    if (fs.statSync(p).isDirectory()) fs.readdirSync(p);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * 현재 로그 + 회전본. 회전 방식이 둘이다: rotateIfBig(`<p>.<timestamp>`)와 state-gc(`<p>.1`, `<p>.2`).
 * 둘 다 읽어야 회전 직후에도 최근 기록이 사라지지 않는다. 오래된 것부터.
 */
export function logFilesWithRotated(p: string, days: number = FLOW_WINDOW_DAYS * 2, now = Date.now()): string[] {
  const numbered = [`${p}.2`, `${p}.1`].filter((f) => fs.existsSync(f));
  const stamped = logFilesWithin(p, days, now).filter((f) => f !== p);
  return [...numbered, ...stamped, p];
}

export function readJsonlTimes(p: string, key: string, filter?: (e: Record<string, unknown>) => boolean): TimedRead {
  const err = unreadable(p);
  if (err) return { times: [], error: err };
  const files = logFilesWithRotated(p).filter((f) => fs.existsSync(f));
  if (files.length === 0) return { times: [] };
  const times: number[] = [];
  try {
    for (const line of files.flatMap((f) => fs.readFileSync(f, 'utf-8').split('\n'))) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (filter && !filter(e)) continue;
        const raw = e[key];
        const t = typeof raw === 'string' ? Date.parse(raw) : typeof raw === 'number' ? raw : NaN;
        if (Number.isFinite(t)) times.push(t);
      } catch { /* 깨진 줄은 건너뜀 */ }
    }
  } catch (e) {
    return { times: [], error: e instanceof Error ? e.message : String(e) };
  }
  return { times };
}

/** frontmatter 시각 파싱. `2026-11-01` 처럼 날짜만 있으면 UTC 가 아니라 로컬 자정으로 본다 (시간대에 따라 하루 어긋나지 않게). */
export function parseCreated(raw: string): number {
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Date.parse(raw);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** 로컬 시각 `YYYY-MM-DD HH:mm` */
export function localStamp(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** 로컬 달력 기준 며칠 전인가 (자정 경계). */
function calendarDaysAgo(t: number, now: number): number {
  const mid = (x: number) => { const d = new Date(x); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  return Math.round((mid(now) - mid(t)) / DAY);
}

/** hook 경로에서 후보가 1개 이상 나온 recall — 흐름의 "주입"과 통계의 "Recall hits"/주간 추세가 같은 정의를 쓴다. */
export function isInjectedRecall(e: Record<string, unknown>): boolean {
  return e.source === 'hook' && Array.isArray(e.candidates) && e.candidates.length > 0;
}

/** 새로 저장된 것(솔루션 created + 룰 created_at)의 시각 — 흐름의 "저장"과 통계의 "Saved"가 같은 정의를 쓴다. */
export function readSavedTimes(): TimedRead & { undated: number } {
  const sol = readSolutionCreations();
  const rules = scanRuleFiles();
  const ruleTimes = rules.rules.map((r) => Date.parse(r.created_at)).filter(Number.isFinite);
  return { times: [...sol.times, ...ruleTimes], error: sol.error ?? rules.dirError, undated: sol.undated };
}

/** 솔루션 생성 시각 — frontmatter `created`. mtime 은 복사·touch 로 바뀌므로 쓰지 않는다. */
export function readSolutionCreations(): TimedRead & { total: number; undated: number } {
  const out = { times: [] as number[], total: 0, undated: 0 } as TimedRead & { total: number; undated: number };
  const err = unreadable(ME_SOLUTIONS);
  if (err) { out.error = err; return out; }
  if (!fs.existsSync(ME_SOLUTIONS)) return out;
  for (const f of fs.readdirSync(ME_SOLUTIONS)) {
    if (!f.endsWith('.md')) continue;
    out.total++;
    try {
      const head = fs.readFileSync(path.join(ME_SOLUTIONS, f), 'utf-8').split('\n').slice(0, 60).join('\n');
      const m = head.match(/^created:\s*["']?([^"'\n]+?)["']?\s*$/m);
      const t = m ? parseCreated(m[1]) : NaN;
      if (Number.isFinite(t)) out.times.push(t); else out.undated++;
    } catch { out.undated++; }
  }
  return out;
}

export interface EvidenceCounts {
  /** 사용자가 직접 한 교정 (hook 기록) */
  user: TimedRead;
  /** Haiku 채굴 추론 — 사용자 발화가 아니다 */
  mined: TimedRead;
  /** 행동 관찰·세션 요약 */
  other: TimedRead;
}

export function readEvidenceCounts(): EvidenceCounts {
  const r: EvidenceCounts = { user: { times: [] }, mined: { times: [] }, other: { times: [] } };
  const err = unreadable(ME_BEHAVIOR);
  if (err) { for (const k of ['user', 'mined', 'other'] as const) r[k].error = err; return r; }
  if (!fs.existsSync(ME_BEHAVIOR)) return r;
  for (const f of fs.readdirSync(ME_BEHAVIOR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const e = JSON.parse(fs.readFileSync(path.join(ME_BEHAVIOR, f), 'utf-8')) as { type?: string; source_component?: string; timestamp?: string };
      const t = Date.parse(e.timestamp ?? '');
      if (!Number.isFinite(t)) continue;
      if (e.type === 'explicit_correction') (e.source_component === 'auto-compound-miner' ? r.mined : r.user).times.push(t);
      else r.other.times.push(t);
    } catch { /* 깨진 evidence 는 건너뜀 */ }
  }
  return r;
}

export const countSince = (times: number[], days: number, now = Date.now()): number => times.filter((t) => t >= now - days * DAY).length;
export const lastOf = (times: number[]): number | null => (times.length ? Math.max(...times) : null);

export function formatWhen(t: number | null, now = Date.now()): string {
  if (t === null) return '없음';
  const d = calendarDaysAgo(t, now);
  const date = localStamp(t);
  return d <= 0 ? `${date} (오늘)` : `${date} (${d}일 전)`;
}

// ── 추출 이벤트 / Haiku 상태 ──

export interface ExtractionEvents { ok: number[]; failed: number[]; /** 실행됐지만 입력 부족 등으로 일찍 끝난 건 (사유별) — ok 에도 포함 */ skipped: Record<string, number>; trailingFailures: number; lastError?: string; error?: string }

export function readExtractionEvents(): ExtractionEvents {
  const p = path.join(STATE_DIR, 'extraction-events.jsonl');
  const r: ExtractionEvents = { ok: [], failed: [], skipped: {}, trailingFailures: 0 };
  const err = unreadable(p);
  if (err) { r.error = err; return r; }
  const files = logFilesWithRotated(p, 60).filter((f) => fs.existsSync(f));
  if (files.length === 0) return r;
  const seq: Array<{ t: number; ok: boolean; error?: string }> = [];
  for (const line of files.flatMap((f) => fs.readFileSync(f, 'utf-8').split('\n'))) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { at?: string; ok?: boolean; error?: string; skipped?: string; kind?: string };
      if (e.kind) continue; // 호출별/대기열 이벤트(haiku-call, queued, queue-retry)는 러너 실행 횟수에 세지 않는다
      const t = Date.parse(e.at ?? '');
      if (!Number.isFinite(t)) continue;
      seq.push({ t, ok: e.ok !== false, error: e.error });
      if (typeof e.skipped === 'string') r.skipped[e.skipped] = (r.skipped[e.skipped] ?? 0) + 1;
    } catch { /* skip */ }
  }
  seq.sort((a, b) => a.t - b.t);
  for (const s of seq) (s.ok ? r.ok : r.failed).push(s.t);
  for (let i = seq.length - 1; i >= 0 && !seq[i].ok; i--) { r.trailingFailures++; r.lastError ??= seq[i].error; }
  return r;
}

/** 마지막 추출 완료 시각 — last-auto-compound.json(completedAt) 단일 소스. status·inspect 가 같은 값을 쓴다. */
export function lastExtractionTime(): number | null {
  for (const name of ['last-auto-compound.json', 'last-extraction.json']) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), 'utf-8')) as { completedAt?: string; timestamp?: string; date?: string };
      const t = Date.parse(d.completedAt ?? d.timestamp ?? d.date ?? '');
      if (Number.isFinite(t)) return t;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

export function formatLastExtraction(now = Date.now()): string {
  const t = lastExtractionTime();
  if (t === null) return 'never';
  const d = calendarDaysAgo(t, now);
  const date = localStamp(t).slice(0, 10);
  return d <= 0 ? `${date} (today)` : d === 1 ? `${date} (yesterday)` : `${date} (${d}d ago)`;
}

export interface HaikuCallStats { today: number; failedToday: number; maxPerSession: number; sessionsToday: number }

/**
 * 오늘(로컬 날짜) Haiku 호출 수. 호출 하나하나가 extraction-events 의 `haiku-call` 이벤트라 그대로 센다.
 * 세션별 호출 수(한 세션이 하루에 몇 번 불렀나)도 집계해 과다 호출을 눈으로 볼 수 있게 한다.
 */
export function haikuCallStats(now = Date.now()): HaikuCallStats {
  const r: HaikuCallStats = { today: 0, failedToday: 0, maxPerSession: 0, sessionsToday: 0 };
  const p = path.join(STATE_DIR, 'extraction-events.jsonl');
  const files = logFilesWithRotated(p, 2, now).filter((f) => fs.existsSync(f));
  const day = localStamp(now).slice(0, 10);
  const per = new Map<string, number>();
  for (const line of files.flatMap((f) => fs.readFileSync(f, 'utf-8').split('\n'))) {
    if (!line.includes('haiku-call')) continue;
    try {
      const e = JSON.parse(line) as { at?: string; kind?: string; outcome?: string; sessionId?: string };
      const t = Date.parse(e.at ?? '');
      if (e.kind !== 'haiku-call' || !Number.isFinite(t) || localStamp(t).slice(0, 10) !== day) continue;
      r.today++;
      if (e.outcome !== 'ok') r.failedToday++;
      const k = e.sessionId ?? '(unknown)';
      per.set(k, (per.get(k) ?? 0) + 1);
    } catch { /* skip */ }
  }
  r.sessionsToday = per.size;
  r.maxPerSession = Math.max(0, ...per.values());
  return r;
}

export function haikuUsageLine(now = Date.now()): string {
  const u = haikuCallStats(now);
  return `오늘 호출 ${u.today}회${u.failedToday ? ` (실패 ${u.failedToday})` : ''}${u.sessionsToday ? ` · 세션 ${u.sessionsToday}개, 세션당 최대 ${u.maxPerSession}회` : ''}`;
}

export type HaikuStatus = { state: 'off' | 'on' | 'unavailable' | 'failing'; detail: string };

function claudeOnPath(): boolean {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { stdio: 'pipe' }); return true; } catch { return false; }
}

function readHaikuStatusSync(): { ok: boolean; outcome: string; reason?: string } | null {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'haiku-status.json'), 'utf-8')); } catch { return null; }
}

/** 재시도 대기 중인 추출 작업 수 (D4). */
function queueSuffix(): string {
  try {
    const q = (JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'extraction-queue.json'), 'utf-8')) as { entries?: unknown[] }).entries ?? [];
    return q.length > 0 ? ` · 재시도 대기 ${q.length}건` : '';
  } catch { return ''; }
}

export function haikuStatus(ev: ExtractionEvents = readExtractionEvents()): HaikuStatus {
  const c = getHaikuConsentState();
  if (!c.enabled) return { state: 'off', detail: `꺼짐 (${c.source}) — 결정론 룰 승급·세션 검색만 동작. 켜기: forgen compound consent on` };
  if (!claudeOnPath()) return { state: 'unavailable', detail: '호출 불가 — claude CLI 를 PATH 에서 찾지 못함. 룰 승급·세션 검색은 계속 동작' };
  const last = readHaikuStatusSync();
  if (last && !last.ok && last.outcome === 'unavailable') return { state: 'unavailable', detail: `호출 불가 — ${last.reason ?? '원인 미상'}. 룰 승급·세션 검색은 계속 동작` };
  if (ev.trailingFailures >= 2) return { state: 'failing', detail: `연속 실패 ${ev.trailingFailures}회${ev.lastError ? ` — ${ev.lastError.slice(0, 80)}` : ''}${queueSuffix()}` };
  const billing = apiBillingNote();
  return { state: 'on', detail: `켜짐 (${c.source === 'default' ? '기본값' : c.source}) — 세션 요약을 내 Haiku 로 전송${queueSuffix()} · ${haikuUsageLine()}${billing ? `\n      ! API 과금 계정으로 호출됨 (ANTHROPIC_API_KEY 설정됨). 끄기: forgen compound consent off` : '. 끄기: forgen compound consent off'}` };
}

// ── 단계 ──

export interface FlowStage {
  label: string;
  input: string;
  last: number | null;
  count: number;
  /** 읽기 실패 사유 — 있으면 count 는 의미 없음 */
  error?: string;
  note?: string;
}

export function computeFlow(days: number = FLOW_WINDOW_DAYS, now = Date.now()): FlowStage[] {
  const ev = readEvidenceCounts();
  const ext = readExtractionEvents();
  const saved = readSavedTimes();
  const matchLog = readJsonlTimes(path.join(STATE_DIR, 'match-eval-log.jsonl'), 'ts', isInjectedRecall);
  const referenced = readJsonlTimes(path.join(STATE_DIR, 'implicit-feedback.jsonl'), 'at', (e) => e.type === 'recall_referenced');
  const acks = readJsonlTimes(path.join(STATE_DIR, 'enforcement', 'acknowledgments.jsonl'), 'at');
  const verdicts = readJsonlTimes(path.join(STATE_DIR, 'enforcement', 'verdicts.jsonl'), 'at');
  const render = summarizeRenderReport();

  const extractTimes = ext.ok;
  const lastRun = lastExtractionTime();
  const stage = (label: string, input: string, r: TimedRead, extra?: Partial<FlowStage>): FlowStage =>
    ({ label, input, last: lastOf(r.times), count: countSince(r.times, days, now), error: r.error, ...extra });

  return [
    stage('수집', '사용자 교정 (hook 기록)', ev.user),
    stage('추출', 'auto-compound 실행 (세션 종료 후)', { times: extractTimes.length === 0 && !ext.failed.length && lastRun !== null ? [lastRun] : extractTimes, error: ext.error }, {
      last: lastRun ?? lastOf(extractTimes),
      note: ext.trailingFailures >= 1 ? `최근 ${ext.trailingFailures}회 연속 실패`
        : Object.keys(ext.skipped).length > 0 ? `일찍 끝난 실행: ${Object.entries(ext.skipped).map(([k, v]) => `${k} ${v}`).join(', ')}`
        : extractTimes.length === 0 && !ext.failed.length && lastRun !== null ? '실행 이력(extraction-events)은 이 버전부터 쌓임 — 마지막 1회만 확인됨' : undefined,
    }),
    stage('저장', '새 솔루션(created) + 새 룰(created_at)', saved,
      { note: saved.undated > 0 ? `created 없는 솔루션 ${saved.undated}개는 집계 제외` : undefined }),
    stage('주입', '후보가 나온 recall (hook)', matchLog, {
      note: render ? `룰 렌더 마지막 ${formatWhen(Date.parse(render.at), now)}: 포함 ${render.included} · 누락 ${render.omitted}${render.omitted ? ` (${Object.entries(render.omittedByStrength).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}` : '룰 렌더 기록 없음',
    }),
    stage('사용', '응답에 인용된 recall', referenced),
    stage('피드백', '차단 승인(ack) + 차단 판정', { times: [...acks.times, ...verdicts.times], error: acks.error ?? verdicts.error }),
  ];
}

/** 이 홈에 남은 세션 기록 수 (state/sessions + sessions). 큰 쪽을 쓴다. */
export function flowSessionCount(): number {
  const n = (d: string): number => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
  return Math.max(n(V1_SESSIONS_DIR), n(SESSIONS_DIR));
}

/** 경고를 내려면 필요한 최소 세션 수. 이보다 적으면 0건이 정상일 수 있다. */
export const FLOW_MIN_SESSIONS = 3;

/**
 * 0건 경고 판정. 활동이 충분할 때만, 그리고 그 단계가 정상적으로 0일 수 없을 때만 낸다.
 *   추출·저장·주입: 세션이 충분한데 0건이면 경고.
 *   사용: 주입이 있는데 인용이 0건일 때만 (주입이 없으면 쓸 것도 없다).
 *   수집·피드백: 사용자가 교정·차단을 만나야 쌓이는 값이라 0건이 정상 — 경고하지 않는다.
 */
export function flowWarning(stage: FlowStage, stages: FlowStage[], sessions: number): string | null {
  if (stage.error || stage.count > 0 || sessions < FLOW_MIN_SESSIONS) return null;
  if (stage.label === '추출' || stage.label === '저장' || stage.label === '주입') return '⚠ 0건 — 이 단계가 끊겼을 수 있음';
  if (stage.label === '사용') return (stages.find((x) => x.label === '주입')?.count ?? 0) > 0 ? '⚠ 주입은 있는데 인용 0건' : null;
  return null;
}

export function renderFlow(stages: FlowStage[], days: number = FLOW_WINDOW_DAYS, now = Date.now(), sessions: number = flowSessionCount()): string[] {
  const lines: string[] = [];
  lines.push(`  흐름 (최근 ${days}일)  수집 → 추출 → 저장 → 주입 → 사용 → 피드백`);
  if (sessions === 0) lines.push('    아직 세션 없음 — 첫 세션을 마치면 채워집니다');
  for (const s of stages) {
    if (s.error) {
      lines.push(`    ${s.label}  읽을 수 없음 — ${s.error.slice(0, 80)}`);
      continue;
    }
    const w = flowWarning(s, stages, sessions);
    lines.push(`    ${s.label}  ${String(s.count).padStart(4)}건  마지막 ${formatWhen(s.last, now)}  ← ${s.input}${w ? `  ${w}` : ''}`);
    if (s.note) lines.push(`         ${s.note}`);
  }
  return lines;
}
