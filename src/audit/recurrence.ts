/**
 * 같은 말 다시 하기 재생 — N4 (docs/plans/2026-11-25-v1.0-plan.md §1.2·§4.2·§4.3·부록 B.1).
 *
 * 1. 대화 기록(최상위 세션)에서 직전에 AI 응답이 있는 사용자 발화 = 후보(분모: 프롬프트 1,000개당).
 * 2. 교정 판정(모델) → 교정 요지 한 줄.
 * 3. 교정마다 그 시점에 있던 기억 어휘 후보 상위 6 + 앞선 다른 세션 교정 상위 5 (+ 지운 기억 2, 그 뒤 생긴 기억 2) → 쌍 판정(순서 바꿔 두 번).
 * 4. 갈래: 실렸는데 무시 / 적혀는 있는데 안 실림 / 적히지 않은 채 반복 / 지운 뒤 다시 말함. 쌍이 갈리면 세지 않고 검수 목록으로.
 * 원천은 읽기만 한다. 쓰기는 writeRecurrenceRun()(audit/recurrence/<회차>/)과 판정 캐시(audit/cache/)뿐이다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FORGEN_HOME, STATE_DIR } from '../core/paths.js';
import { readSessionRenders, rulesLoadedAt, tier2PendingAt } from '../core/session-renders.js';
import { renderSessionStartReadOnly } from '../core/v1-bootstrap.js';
import { loadAllEvidence } from '../store/evidence-store.js';
import { appliesForContext, projectKeyFor } from '../store/rule-scope.js';
import type { Rule } from '../store/types.js';
import { CORRECTION_MODEL, CORRECTION_PROMPT_VERSION, Judge, PAIR_MODEL, PAIR_PROMPT_LENIENT_VERSION, PAIR_PROMPT_VERSION, type CorrectionVerdict, type PairVerdict } from './judge.js';
import { bigrams, topK } from './lexical.js';
import { deletedItems, forgenRuleItems, hostFileItems, itemAt, memoryItems, type MemoryItem } from './memory-items.js';
import { forgenVersion } from './run.js';
import { defaultEnv, defaultFolders, hostLoadFor, listMemoryDirs, readMemoryDir, SourceReader, type Layer, type MemoryDir } from './sources.js';
import { scanTranscripts, type Prompt } from './transcripts.js';

export const RECURRENCE_SCHEMA = 'forgen-audit-recurrence/2' as const;
const DAY = 86_400_000;
const SAMPLE_SEED = 'forgen-n4-20261125';
/**
 * 교정당 후보 수(속도, N1 ≤ 5분). 계획 §4.2-3 의 6·5 에서 줄였다 — 근거는 PREFILTER_MIN 주석(실데이터 표본의 "예" 순위).
 */
export const TOP_MEMORY = 4;
export const TOP_EARLIER = 3;
const TOP_DELETED = 2;
const TOP_LATER = 1;
/**
 * 결정적 사전 필터(쌍 판정 전): 글자 2-gram 코사인이 이 값보다 낮은 후보는 모델에 보내지 않는다.
 * 하한 근거(2026-11-25): 합성 픽스처(tests/audit-recurrence)의 같은 뜻 쌍 최저 점수 0.32. 실데이터 복사본 표본 200발화를
 * 필터 없이(하한 0) 돌려 Sonnet(n4-pair/3) 이 "예"라 한 쌍 27개의 점수는 0.054~0.327(중앙값 약 0.11)로 낮았다 — 2-gram 은
 * 같은 뜻을 다른 말로 쓴 쌍을 잘 못 잡는다. 하한 0.05 는 "예" 27/27 을 남기고 쌍 408개 중 28개(7%)만 걸렀다(0.1 이면 16/27).
 * 그래서 사전 필터는 무관한 쌍만 거르는 낮은 하한이고, 후보 수(TOP_*)가 속도를 맡는다. 같은 표본에서 "예"는 기억 순위 4위·앞선 교정 3위 안이었다.
 */
export const PREFILTER_MIN = Number(process.env.FORGEN_AUDIT_PREFILTER_MIN ?? '') || 0.05;
/** 표본 하한(§1.2 공통 규칙): 교정 30개, 30일 환산 교정 10건. */
export const MIN_CORRECTIONS = 30;
export const MIN_CORRECTIONS_30D = 10;
/** 판정 못 한 후보가 이 비율을 넘으면 "판정 불완전". */
const MAX_UNJUDGED_RATIO = 0.1;

export type Branch = 'ignored' | 'not-loaded' | 'unwritten-repeat' | 'deleted-repeat' | 'new';
export type RecurrenceStatus = 'ok' | 'insufficient' | 'incomplete' | 'model-off' | 'no-data';
const HOST_LAYERS = new Set<Layer>(['managed', 'user', 'user-rules', 'project', 'project-local', 'project-rules', 'agents', 'import']);

export interface RecurrenceOptions {
  claudeDir?: string;
  since?: Date;
  until?: Date;
  lookbackDays?: number;
  limit?: number;
  model?: boolean;
  judge?: Judge;
  now?: Date;
  cwd?: string;
}

export interface CorrectionItem {
  id: string;
  session: string;
  ts: string;
  cwd: string;
  gist: string;
  utterance: string;
  taskSpecific: boolean;
  branch: Branch;
  /** 같다고 판정된 기억(갈래 근거) */
  match?: { key: string; kind: string; text: string; loaded?: boolean; loadedVia?: string; reason?: string; path?: string; line?: number; ruleId?: string };
  /** 같다고 판정된 앞선 교정 */
  earlier?: { session: string; ts: string; text: string; source: 'replay' | 'forgen-evidence' };
  /** 그 뒤 같은 뜻의 기억이 생겼나(§4.4 "기억이 된 것") */
  becameMemory: boolean;
  /** 판정한 쌍 전부(검수 표본의 원천). verdict null = 판정 못 함 */
  pairs: PairRecord[];
  /** "모름"으로 판정된 쌍 수(세지 않음) */
  unknown: number;
  /** 쌍 판정에 보내지 않은 까닭(이 작업 전용 교정) */
  skipped?: 'task-specific';
}

export interface PairRecord { tier: 'memory' | 'later' | 'deleted' | 'earlier'; key: string; kind: string; text: string; score: number; verdict: PairVerdict | null; path?: string; line?: number }

/**
 * tier2Missed(0.9.0 두 층): notLoaded 중 "2층 미발동" — 적혀 있고 그 세션의 2층 후보였는데 교정 때까지 안 실림(Q11: 누락으로 센다).
 * 옛 결과에는 없다(선택 필드).
 */
export interface Counts { ignored: number; notLoaded: number; written: number; unwrittenRepeat: number; deletedRepeat: number; total: number; tier2Missed?: number }

/** 2주 단위 추적(0.9.0 두 층 도입 뒤 N4): 구간마다 판정한 발화·교정·반복·2층 미발동 재발. */
export interface Biweekly { from: string; to: string; prompts: number; corrections: number; written: number; total: number; tier2Missed: number; per1000: number }

export interface RecurrenceResult {
  schema: typeof RECURRENCE_SCHEMA;
  forgenVersion: string;
  generatedAt: string;
  claudeDir: string;
  window: { since: string; until: string; lookbackDays: number; days: number };
  judge: JudgeInfo | null;
  status: RecurrenceStatus;
  statusNote: string;
  prompts: { window: number; lookback: number; sampled: number; judged: number; unjudged: number; limit: number | null; per30d: number };
  corrections: { total: number; taskSpecific: number; lookback: number; per1000: number; per30d: number; becameMemory: number };
  counts: Counts;
  per1000: Counts;
  per30d: Counts;
  ci95per1000: { total: [number, number]; written: [number, number] };
  /** 오너 결정 2026-11-26 범위: 엄격 판본(아래 끝 = counts 와 같음)·관대 판본(위 끝)의 갈래 수. 발견·처방은 엄격(확실한 것)으로 고른다. */
  range?: { strictVersion: string; lenientVersion: string; lenient: { counts: Counts; per1000: Counts; per30d: Counts } };
  /** "모름"으로 판정된 쌍(세지 않음, 검수 대상) */
  unknown: number;
  pairsJudged: number;
  /** 기억 풀 — 풀(forgen 룰 수 등)이 다르면 숫자가 다르다 */
  memory: { items: number; byKind: Record<string, number>; unknownTime: number; deleted: number };
  loadedVia: { renderLog: number; replay: number };
  /** 2주 단위 N4 추적(갈래 "2층 미발동 재발" 포함). 옛 결과에는 없다. */
  biweekly?: Biweekly[];
  notes: string[];
  items: CorrectionItem[];
}

export interface RecurrenceManifest {
  schema: 'forgen-audit-recurrence-manifest/1';
  forgenVersion: string;
  generatedAt: string;
  claudeDir: string;
  forgenHome: string;
  options: { since: string; until: string; lookbackDays: number; limit: number | null; model: boolean };
  judge: JudgeInfo;
  transcripts: Array<{ path: string; bytes: number; sha256: string }>;
  memory: Array<{ path: string; sha256: string }>;
  sourcesDigest: string;
  resultDigest: string;
}

export interface JudgeInfo {
  correction: { model: string; version: string };
  pair: { model: string; version: string; mode: 'single-asymmetric' };
  prefilterMin: number;
  top: { memory: number; earlier: number; later: number; deleted: number };
}

export function judgeInfo(): JudgeInfo {
  return {
    correction: { model: CORRECTION_MODEL, version: CORRECTION_PROMPT_VERSION },
    pair: { model: PAIR_MODEL, version: PAIR_PROMPT_VERSION, mode: 'single-asymmetric' },
    prefilterMin: PREFILTER_MIN, top: { memory: TOP_MEMORY, earlier: TOP_EARLIER, later: TOP_LATER, deleted: TOP_DELETED },
  };
}

/**
 * 0.9.2: 저장된 재생 결과가 지금과 다른 판정 방식으로 잰 것인가 — 다른 항목 목록(같으면 빈 배열).
 * 비교: 교정 판정·쌍 판정(엄격·관대)의 모델과 판정 문안 번호, 후보 고르기(사전 점수 하한·상위 개수).
 * forgen 버전만 다른 것은 같다고 본다(판정에 영향 있는 변경은 문안 번호를 올린다).
 */
export function judgeChanges(r: RecurrenceResult): string[] {
  if (!r.judge) return [];
  const now = judgeInfo();
  const out: string[] = [];
  const cmp = (label: string, a: string | number | null | undefined, b: string | number) => { if (a !== b) out.push(`${label}: ${a ?? '없음'} → ${b}`); };
  cmp('correction.model', r.judge.correction?.model, now.correction.model);
  cmp('correction.version', r.judge.correction?.version, now.correction.version);
  cmp('pair.model', r.judge.pair?.model, now.pair.model);
  cmp('pair.version', r.judge.pair?.version, now.pair.version);
  if (r.range) cmp('pair.lenientVersion', r.range.lenientVersion, PAIR_PROMPT_LENIENT_VERSION);
  cmp('prefilterMin', r.judge.prefilterMin, now.prefilterMin);
  cmp('top', r.judge.top ? JSON.stringify(r.judge.top) : null, JSON.stringify(now.top));
  return out;
}

/** 옛 판정 방식 결과에 붙이는 안내(첫 화면·fix --report·공유 요약). */
export const STALE_JUDGE_NOTE = '이전 판정 방식으로 잰 값 — forgen audit recurrence 로 다시 재세요';

export interface RecurrenceRun { result: RecurrenceResult; manifest: RecurrenceManifest; timing: Record<string, number>; judgeStats: Judge['stats'] | null; memoryFiles: string[] }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const r1 = (x: number) => Math.round(x * 10) / 10;
const zero = (): Counts => ({ ignored: 0, notLoaded: 0, written: 0, unwrittenRepeat: 0, deletedRepeat: 0, total: 0, tier2Missed: 0 });

/** 포아송 95% 구간(Byar 근사) — 건수 k 의 하한·상한. */
export function poissonCi(k: number): [number, number] {
  if (k <= 0) return [0, 3.689];
  const lo = k * (1 - 1 / (9 * k) - 1.96 / (3 * Math.sqrt(k))) ** 3;
  const k1 = k + 1;
  const hi = k1 * (1 - 1 / (9 * k1) + 1.96 / (3 * Math.sqrt(k1))) ** 3;
  return [Math.max(0, lo), hi];
}

/** 같은 입력이면 같은 표본: 시드 + 세션 + 발화 ID 해시 순. */
export function sampleOrder(p: Prompt): string { return sha(`${SAMPLE_SEED}:${p.session}:${p.uuid || p.ts}`); }

export function promptId(p: Prompt): string { return sha(`${p.session}:${p.uuid || p.ts}`).slice(0, 12); }

interface EarlierItem { key: string; session: string; ts: string; text: string; grams: Set<string>; source: 'replay' | 'forgen-evidence' }

export async function runRecurrence(opts: RecurrenceOptions = {}): Promise<RecurrenceRun> {
  const timing: Record<string, number> = {};
  let t0 = Date.now();
  const lap = (k: string) => { const t = Date.now(); timing[k] = t - t0; t0 = t; };
  const env = defaultEnv(opts.claudeDir);
  const now = opts.now ?? new Date();
  const until = opts.until ?? now;
  const lookbackDays = opts.lookbackDays ?? 30;
  const since = opts.since ?? new Date(until.getTime() - 30 * DAY);
  const lookFrom = new Date(since.getTime() - lookbackDays * DAY);
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();
  const lookIso = lookFrom.toISOString();
  const days = Math.max(1 / 24, (until.getTime() - since.getTime()) / DAY);
  const useModel = opts.model !== false;
  const notes: string[] = [];

  // 1. 대화 기록
  const scan = await scanTranscripts(env.claudeDir);
  lap('transcripts');
  const windowAll = scan.prompts.filter((p) => p.prevAssistant && p.ts >= sinceIso && p.ts < untilIso);
  const lookAll = scan.prompts.filter((p) => p.prevAssistant && p.ts >= lookIso && p.ts < sinceIso);
  const byOrder = (a: Prompt, b: Prompt) => (sampleOrder(a) < sampleOrder(b) ? -1 : 1);
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : null;
  const windowSample = limit && windowAll.length > limit ? [...windowAll].sort(byOrder).slice(0, limit) : windowAll;
  const frac = windowAll.length ? windowSample.length / windowAll.length : 1;
  const lookSample = frac < 1 ? [...lookAll].sort(byOrder).slice(0, Math.round(lookAll.length * frac)) : lookAll;
  if (limit && frac < 1) notes.push(`요청 ${windowAll.length}개 중 ${windowSample.length}개만 뽑아 잰 어림값이다(매번 같은 것을 뽑음). 앞선 교정도 같은 비율로 줄어 "어디에도 안 적혀 또 말함"은 실제보다 적게 나온다`);
  const per30dPrompts = (windowAll.length / days) * 30;

  // 2. 기억
  const reader = new SourceReader();
  const memDirs = new Map<string, MemoryDir>();
  for (const d of listMemoryDirs(env.claudeDir)) memDirs.set(d, readMemoryDir(reader, d));
  const sessionCwds = [...new Set([...scan.sessionCwd.values()].filter((c) => c && fs.existsSync(c)))];
  const folders = [...new Set([...defaultFolders(env, opts.cwd ?? process.cwd()), ...sessionCwds])].sort();
  const loadCache = new Map<string, ReturnType<typeof hostLoadFor>>();
  const hostLoad = (cwd: string) => {
    let h = loadCache.get(cwd);
    if (!h) { h = hostLoadFor(reader, env, cwd, memDirs); loadCache.set(cwd, h); }
    return h;
  };
  const hostFiles: Array<{ path: string; layer: Layer }> = [];
  for (const f of folders) for (const e of hostLoad(f).entries) if (HOST_LAYERS.has(e.layer)) hostFiles.push({ path: e.path, layer: e.layer });
  const { items: ruleItems, rules } = forgenRuleItems();
  const memory: MemoryItem[] = [...ruleItems, ...memoryItems(env.claudeDir, [...memDirs.values()], scan.memoryWrites), ...hostFileItems(reader, env, hostFiles)];
  const deleted = deletedItems();
  const byKind: Record<string, number> = {};
  for (const m of memory) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
  const unknownTime = memory.filter((m) => !m.since).length;
  const memoryFiles = [...new Set(memory.map((m) => m.path).filter((p): p is string => !!p))].sort();
  lap('memory');

  const base = {
    schema: RECURRENCE_SCHEMA, forgenVersion: forgenVersion(), generatedAt: now.toISOString(), claudeDir: env.claudeDir,
    window: { since: sinceIso, until: untilIso, lookbackDays, days: r1(days) },
    judge: useModel ? judgeInfo() : null,
    memory: { items: memory.length, byKind, unknownTime, deleted: deleted.length },
  };
  const manifestFor = (result: RecurrenceResult): RecurrenceManifest => {
    const transcripts = scan.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 }));
    const mem = memoryFiles.map((p) => ({ path: p, sha256: reader.files.get(p)?.sha256 ?? fileSha(p) }));
    return {
      schema: 'forgen-audit-recurrence-manifest/1', forgenVersion: result.forgenVersion, generatedAt: result.generatedAt, claudeDir: env.claudeDir, forgenHome: FORGEN_HOME,
      options: { since: sinceIso, until: untilIso, lookbackDays, limit, model: useModel },
      judge: judgeInfo(),
      transcripts, memory: mem,
      sourcesDigest: sha(JSON.stringify({ transcripts, mem, options: { sinceIso, untilIso, lookbackDays, limit } })),
      resultDigest: recurrenceDigest(result),
    };
  };
  const empty = (status: RecurrenceStatus, statusNote: string, judged = 0): RecurrenceResult => ({
    ...base, status, statusNote,
    prompts: { window: windowAll.length, lookback: lookAll.length, sampled: windowSample.length, judged, unjudged: 0, limit, per30d: r1(per30dPrompts) },
    corrections: { total: 0, taskSpecific: 0, lookback: 0, per1000: 0, per30d: 0, becameMemory: 0 },
    counts: zero(), per1000: zero(), per30d: zero(), ci95per1000: { total: [0, 0], written: [0, 0] }, unknown: 0, pairsJudged: 0,
    loadedVia: { renderLog: 0, replay: 0 }, notes, items: [],
  });
  if (!useModel) {
    const result = empty('model-off', '모델 판정 꺼짐(--no-model) — 같은 말 다시 하기(N4)는 교정 판정에 모델이 필요해 내지 않는다');
    return { result, manifest: manifestFor(result), timing, judgeStats: null, memoryFiles };
  }
  if (windowAll.length === 0) {
    const result = empty('no-data', '이 기간에 직전 AI 응답이 있는 사용자 발화가 없다');
    return { result, manifest: manifestFor(result), timing, judgeStats: null, memoryFiles };
  }

  // 3. 교정 판정
  const judge = opts.judge ?? new Judge({ model: true });
  const toJudge = [...windowSample, ...lookSample];
  const verdicts = await judge.corrections(toJudge.map((p) => ({ id: promptId(p), utter: p.text, prev: p.prevText })));
  lap('correctionJudge');
  const v = (p: Prompt): CorrectionVerdict | null => verdicts.get(promptId(p)) ?? null;
  const judgedWindow = windowSample.filter((p) => v(p));
  const unjudged = windowSample.length - judgedWindow.length;
  const windowCorr = judgedWindow.filter((p) => v(p)?.correction);
  const lookCorr = lookSample.filter((p) => v(p)?.correction);

  // 4. 비교 대상: 앞선 교정(재생 판정 + forgen 이 감지한 직접 교정)
  const earlierPool: EarlierItem[] = [];
  for (const p of [...lookCorr, ...windowCorr]) {
    const g = v(p)?.gist || p.text.slice(0, 200);
    earlierPool.push({ key: `replay:${promptId(p)}`, session: p.session, ts: p.ts, text: g, grams: bigrams(g), source: 'replay' });
  }
  try {
    for (const e of loadAllEvidence()) {
      if (e.type !== 'explicit_correction' || !e.session_id || !e.timestamp || !e.summary) continue;
      if (e.timestamp >= untilIso) continue;
      const text = e.summary.slice(0, 300);
      earlierPool.push({ key: `evidence:${e.evidence_id}`, session: e.session_id, ts: e.timestamp, text, grams: bigrams(text), source: 'forgen-evidence' });
    }
  } catch { notes.push('forgen 에 저장된 교정 기록을 읽지 못해, 앞선 교정은 대화 기록에서 찾은 것만 썼다'); }
  earlierPool.sort((a, b) => (a.key < b.key ? -1 : 1));

  // 5. 후보 고르기 → 쌍 판정
  const sessionStart = new Map<string, string>();
  for (const p of scan.prompts) if (p.ts && (!sessionStart.has(p.session) || p.ts < (sessionStart.get(p.session) as string))) sessionStart.set(p.session, p.ts);
  type Cand = { tier: PairRecord['tier']; key: string; text: string; score: number; mem?: MemoryItem; earlier?: EarlierItem };
  const plan = new Map<string, { p: Prompt; gist: string; cands: Cand[]; skipped: boolean }>();
  const pairs: Array<{ id: string; gist: string; memory: string }> = [];
  const pick = <T extends { grams: Set<string> }>(q: Set<string>, xs: T[], k: number, key: (x: T) => string) => topK(q, xs, k, (x) => x.grams, key).filter((x) => x.score >= PREFILTER_MIN);
  for (const p of windowCorr) {
    const gist = (v(p) as CorrectionVerdict).gist || p.text.slice(0, 200);
    // 이 작업에만 해당하는 교정은 기억감이 아니다 — 쌍 판정에 보내지 않는다(속도). 교정 수에는 들어간다.
    if (v(p)?.task_specific) { plan.set(promptId(p), { p, gist, cands: [], skipped: true }); continue; }
    const q = bigrams(`${gist} ${p.text.slice(0, 200)}`);
    // 그때 모습: 그 교정 시각에 적혀 있던 내용으로 비교한다(교정 뒤에 덧붙인 문장으로 '이미 적혀 있었다'고 세지 않게). 복원 못 하면 세지 않음.
    const before = memory.map((m) => itemAt(m, p.ts)).filter((m): m is MemoryItem => !!m);
    const later = memory.filter((m) => m.since && m.since > p.ts);
    const del = deleted.filter((m) => m.until && m.until < p.ts);
    const earlier = earlierPool.filter((e) => e.ts < p.ts && e.session !== p.session);
    const cands: Cand[] = [
      ...pick(q, before, TOP_MEMORY, (m) => m.key).map(({ item, score }) => ({ tier: 'memory' as const, key: item.key, text: item.text, score, mem: item })),
      ...pick(q, later, TOP_LATER, (m) => m.key).map(({ item, score }) => ({ tier: 'later' as const, key: item.key, text: item.text, score, mem: item })),
      ...pick(q, del, TOP_DELETED, (m) => m.key).map(({ item, score }) => ({ tier: 'deleted' as const, key: item.key, text: item.text, score, mem: item })),
      ...pick(q, earlier, TOP_EARLIER, (e) => e.key).map(({ item, score }) => ({ tier: 'earlier' as const, key: item.key, text: item.text, score, earlier: item })),
    ];
    const id = promptId(p);
    plan.set(id, { p, gist, cands, skipped: false });
    for (const c of cands) pairs.push({ id: `${id}|${c.tier}|${c.key}`, gist, memory: c.text });
  }
  // 사전 등록(2026-11-26): 교정 뒤에 생긴 기억과의 짝은 "그때 이미 지시하고 있었나"로 묻지 않고 따로("나중 기억이 이 교정을 반영했나") 판정한다.
  const isLater = (x: { id: string }) => x.id.includes('|later|');
  const laterVerdicts = await judge.laterPairs(pairs.filter(isLater));
  const pairVerdicts = new Map([...(await judge.pairs(pairs.filter((x) => !isLater(x)))), ...laterVerdicts]);
  // 범위의 위 끝: 같은 쌍을 관대 판본으로도(캐시) — 경계가 애매한 교정은 판본에 따라 갈린다
  const lenientVerdicts = new Map([...(await judge.pairs(pairs.filter((x) => !isLater(x)), 'lenient')), ...laterVerdicts]);
  lap('pairJudge');

  // 6. 실렸는가 + 갈래
  const renders = readSessionRenders(STATE_DIR);
  const replayCache = new Map<string, Set<string>>();
  const loadedVia = { renderLog: 0, replay: 0 };
  const forgenLoaded = (p: Prompt): { ids: Set<string>; via: 'render-log' | 'replay' } => {
    const rec = rulesLoadedAt(renders.get(p.session), p.ts);
    if (rec) return { ids: rec, via: 'render-log' };
    const k = `${p.session}`;
    let ids = replayCache.get(k);
    if (!ids) {
      try { ids = new Set(renderSessionStartReadOnly(p.cwd || env.home, { asOf: sessionStart.get(p.session) ?? p.ts }).includedRuleIds); } catch { ids = new Set(); }
      replayCache.set(k, ids);
    }
    return { ids, via: 'replay' };
  };
  const loadedOf = (m: MemoryItem, p: Prompt): { loaded: boolean; via?: string; reason?: string } => {
    if (m.kind === 'forgen-rule') {
      const l = forgenLoaded(p);
      if (l.ids.has(m.ruleId ?? '')) return { loaded: true, via: l.via };
      const rule = rules.get(m.ruleId ?? '') as Rule | undefined;
      // 지금은 활성이 아닌 룰(보관·억제)은 재생 렌더가 되살리지 못한다 — 안 실렸는지 알 수 없음을 따로 적는다.
      if (l.via === 'replay' && rule && rule.status !== 'active') return { loaded: false, via: l.via, reason: 'replay-unknown' };
      // 0.9.0 두 층: 그 세션의 2층 후보였는데 교정 때까지 상황 판정이 한 번도 넣지 않았다 = "2층 미발동"(자동 1층 복귀 신호)
      if (l.via === 'render-log' && tier2PendingAt(renders.get(p.session), p.ts).has(m.ruleId ?? '')) return { loaded: false, via: l.via, reason: 'tier2-missed' };
      let key: string | null = null;
      try { key = p.cwd ? projectKeyFor(p.cwd) : null; } catch { /* 없음 */ }
      return { loaded: false, via: l.via, reason: rule && !appliesForContext(rule, key) ? 'scope' : 'budget-or-other' };
    }
    if (m.kind === 'memory-topic') return { loaded: false, reason: 'topic-only' };
    if (!p.cwd || !fs.existsSync(p.cwd)) return { loaded: false, reason: 'cwd-missing' };
    const h = hostLoad(p.cwd);
    if (m.kind === 'memory-index') {
      if (h.memoryDir !== m.memoryDir) return { loaded: false, reason: 'other-folder' };
      const md = memDirs.get(m.memoryDir ?? '');
      return md && (m.line ?? 0) <= md.loadedLines ? { loaded: true, via: 'host-load' } : { loaded: false, reason: 'truncated' };
    }
    const e = h.entries.find((x) => x.path === m.path);
    if (!e) return { loaded: false, reason: 'other-folder' };
    return e.always ? { loaded: true, via: 'host-load' } : { loaded: false, reason: 'conditional' };
  };

  const classify = (vm: Map<string, PairVerdict | null>) => {
  const items: CorrectionItem[] = [];
  const counts = zero();
  let unknown = 0;
  let pairsJudged = 0;
  let becameMemory = 0;
  for (const [id, { p, gist, cands, skipped }] of plan) {
    const verdict = (c: Cand): PairVerdict | null => vm.get(`${id}|${c.tier}|${c.key}`) ?? null;
    const same = (tier: Cand['tier']) => cands.filter((c) => c.tier === tier && verdict(c) === 'yes');
    const recs: PairRecord[] = cands.map((c) => ({
      tier: c.tier, key: c.key, kind: c.mem?.kind ?? (c.earlier ? `earlier:${c.earlier.source}` : ''), text: c.text.slice(0, 400), score: c.score, verdict: verdict(c),
      ...(c.mem?.path ? { path: c.mem.path } : {}), ...(c.mem?.line ? { line: c.mem.line } : {}),
    }));
    const itemUnknown = recs.filter((r) => r.verdict === 'unknown').length;
    unknown += itemUnknown;
    pairsJudged += recs.filter((r) => r.verdict).length;
    const mem = same('memory').map((c) => ({ c, l: loadedOf(c.mem as MemoryItem, p) }));
    const it: CorrectionItem = {
      id, session: p.session, ts: p.ts, cwd: p.cwd, gist, utterance: p.text.slice(0, 500), taskSpecific: !!v(p)?.task_specific,
      branch: 'new', becameMemory: same('later').length > 0, pairs: recs, unknown: itemUnknown, ...(skipped ? { skipped: 'task-specific' as const } : {}),
    };
    const hit = mem.find((x) => x.l.loaded) ?? mem[0];
    if (hit) {
      const m = hit.c.mem as MemoryItem;
      it.branch = hit.l.loaded ? 'ignored' : 'not-loaded';
      it.match = { key: m.key, kind: m.kind, text: m.text.slice(0, 300), loaded: hit.l.loaded, ...(hit.l.via ? { loadedVia: hit.l.via } : {}), ...(hit.l.reason ? { reason: hit.l.reason } : {}), ...(m.path ? { path: m.path } : {}), ...(m.line ? { line: m.line } : {}), ...(m.ruleId ? { ruleId: m.ruleId } : {}) };
      if (hit.l.via === 'render-log') loadedVia.renderLog++;
      else if (hit.l.via === 'replay') loadedVia.replay++;
    } else if (same('deleted').length) {
      const m = same('deleted')[0].mem as MemoryItem;
      it.branch = 'deleted-repeat';
      it.match = { key: m.key, kind: m.kind, text: m.text.slice(0, 300) };
    } else if (same('earlier').length) {
      const e = same('earlier')[0].earlier as EarlierItem;
      it.branch = 'unwritten-repeat';
      it.earlier = { session: e.session, ts: e.ts, text: e.text.slice(0, 300), source: e.source };
    }
    if (it.becameMemory) becameMemory++;
    if (it.branch === 'ignored') counts.ignored++;
    else if (it.branch === 'not-loaded') { counts.notLoaded++; if (it.match?.reason === 'tier2-missed') counts.tier2Missed = (counts.tier2Missed ?? 0) + 1; }
    else if (it.branch === 'unwritten-repeat') counts.unwrittenRepeat++;
    else if (it.branch === 'deleted-repeat') counts.deletedRepeat++;
    items.push(it);
  }
  counts.written = counts.ignored + counts.notLoaded;
  counts.total = counts.written + counts.unwrittenRepeat + counts.deletedRepeat;
  items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  return { items, counts, unknown, pairsJudged, becameMemory };
  };
  const loadedSnap = { ...loadedVia };
  const lenientRun = classify(lenientVerdicts);
  Object.assign(loadedVia, loadedSnap, { renderLog: 0, replay: 0 });
  const { items, counts, unknown, pairsJudged, becameMemory } = classify(pairVerdicts);

  const n = judgedWindow.length;
  const scale = (c: Counts, f: number): Counts => Object.fromEntries(Object.entries(c).map(([k, x]) => [k, r1(x * f)])) as unknown as Counts;
  const per1000 = scale(counts, n ? 1000 / n : 0);
  const per30d = scale(per1000, per30dPrompts / 1000);
  const lp1000 = scale(lenientRun.counts, n ? 1000 / n : 0);
  const range = { strictVersion: PAIR_PROMPT_VERSION, lenientVersion: PAIR_PROMPT_LENIENT_VERSION, lenient: { counts: lenientRun.counts, per1000: lp1000, per30d: scale(lp1000, per30dPrompts / 1000) } };
  const ci = (k: number): [number, number] => { const [lo, hi] = poissonCi(k); return n ? [r1((lo * 1000) / n), r1((hi * 1000) / n)] : [0, 0]; };
  const corrPer1000 = n ? (windowCorr.length * 1000) / n : 0;
  const corr30 = r1((corrPer1000 * per30dPrompts) / 1000);

  let status: RecurrenceStatus = 'ok';
  let statusNote = '';
  const pairUnjudged = [...pairVerdicts.values()].filter((x) => x === null).length;
  if (judge.stats.stopped || unjudged > windowSample.length * MAX_UNJUDGED_RATIO || pairUnjudged > pairs.length * MAX_UNJUDGED_RATIO) {
    status = 'incomplete';
    const what = [unjudged ? `요청 ${windowSample.length}개 ${unjudged >= windowSample.length ? '모두' : `중 ${unjudged}개`}` : '', pairUnjudged ? `비교 ${pairs.length}개 ${pairUnjudged >= pairs.length ? '모두' : `중 ${pairUnjudged}개`}` : ''].filter(Boolean).join(', ');
    statusNote = `모델이 ${unjudged >= windowSample.length && windowSample.length ? '' : '일부를 '}판정하지 못함${what ? ` — ${what}` : ''}${judge.stats.stopped ? ` (${judge.stats.stopped})` : judge.stats.lastError ? ` (${judge.stats.lastError})` : ''}. 다시 돌리면 이미 판정한 것은 다시 묻지 않고 나머지만 묻는다`;
  } else if (windowCorr.length < MIN_CORRECTIONS || corr30 < MIN_CORRECTIONS_30D) {
    status = 'insufficient';
    statusNote = `참고값(교정 ${windowCorr.length}개로 잼)`;
  }
  const pool = `forgen 룰 ${byKind['forgen-rule'] ?? 0} · 메모 파일 ${byKind['memory-topic'] ?? 0} · MEMORY.md 줄 ${byKind['memory-index'] ?? 0} · CLAUDE.md 등 지침 줄 ${byKind['host-md'] ?? 0}`;
  notes.push(`비교한 기억: ${pool} — 기억이 바뀌면(룰을 지우거나 더하면) 같은 대화 기록이라도 숫자가 달라진다`);
  const ts = windowCorr.filter((p) => v(p)?.task_specific).length;
  if (ts) notes.push(`그 작업에만 해당하는 교정 ${ts}개는 기억과 비교하지 않았다(기억으로 남길 것이 아님)`);
  if (unknown) notes.push(`모델이 "모르겠다"고 한 비교 ${unknown}개는 세지 않았다(직접 확인: forgen audit review)`);
  if (unknownTime) notes.push(`언제 적혔는지 모르는 기억 ${unknownTime}개는 "이미 적혀 있던 것"으로 세지 않았다(적게 세는 쪽)`);
  if (loadedVia.replay) notes.push(`그 세션에 forgen 룰이 실렸는지 ${loadedVia.replay}건은 기록이 없어, 그 세션 시작 때 있던 룰로 다시 만들어 보고 추정했다(그 뒤 지운 룰·바뀐 강도는 모름)`);
  notes.push('CLAUDE.md·MEMORY.md 가 그 세션에 실렸는지는 지금 파일 구성으로 판단한다');
  if (counts.tier2Missed) notes.push(`상황 맞춤 룰이 필요한 순간에 안 들어와 다시 말한 일 ${counts.tier2Missed}번 — 그 룰은 다음 세션부터 세션마다 실린다(90일 동안 다시 안 나오면 상황 맞춤으로 되돌릴지 다시 본다)`);
  notes.push('한계: 다시 교정한 경우만 센다. 룰이 안 들어왔거나 무시됐는데 내가 다시 말하지 않고 넘어간 경우는 대화 기록으로 알 수 없다');
  // 2주 단위 추적(두 층 도입 뒤 N4): 구간마다 판정한 발화 수와 갈래
  const biweekly: Biweekly[] = [];
  for (let a = since.getTime(); a < until.getTime(); a += 14 * DAY) {
    const from = new Date(a).toISOString();
    const to = new Date(Math.min(a + 14 * DAY, until.getTime())).toISOString();
    const inB = (ts: string) => ts >= from && ts < to;
    const its = items.filter((x) => inB(x.ts));
    const prompts = judgedWindow.filter((x) => inB(x.ts)).length;
    const total = its.filter((x) => x.branch !== 'new').length;
    biweekly.push({
      from, to, prompts, corrections: its.length, written: its.filter((x) => x.branch === 'ignored' || x.branch === 'not-loaded').length, total,
      tier2Missed: its.filter((x) => x.match?.reason === 'tier2-missed').length, per1000: prompts ? r1((total * 1000) / prompts) : 0,
    });
  }

  const result: RecurrenceResult = {
    ...base, status, statusNote,
    prompts: { window: windowAll.length, lookback: lookAll.length, sampled: windowSample.length, judged: n, unjudged, limit, per30d: r1(per30dPrompts) },
    corrections: { total: windowCorr.length, taskSpecific: windowCorr.filter((p) => v(p)?.task_specific).length, lookback: lookCorr.length, per1000: r1(corrPer1000), per30d: corr30, becameMemory },
    counts, per1000, per30d, ci95per1000: { total: ci(counts.total), written: ci(counts.written) }, range, unknown, pairsJudged,
    loadedVia, biweekly, notes, items,
  };
  lap('classify');
  return { result, manifest: manifestFor(result), timing, judgeStats: judge.stats, memoryFiles };
}

function fileSha(p: string): string {
  try { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; }
}

/** 생성 시각을 뺀 결과 해시 — 같은 원천·같은 캐시면 같은 값. */
export function recurrenceDigest(r: RecurrenceResult): string {
  const { generatedAt: _g, ...rest } = r;
  return sha(JSON.stringify(rest));
}

/** <FORGEN_HOME>/audit/recurrence/<회차>/ 에 result.json·manifest.json(권한 600, 폴더 700). */
export function writeRecurrenceRun(run: RecurrenceRun): { dir: string; runId: string } {
  const base = path.join(FORGEN_HOME, 'audit', 'recurrence');
  const stamp = run.result.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let runId = `${stamp}-${run.manifest.sourcesDigest.slice(0, 8)}`;
  for (let i = 2; fs.existsSync(path.join(base, runId)); i++) runId = `${stamp}-${run.manifest.sourcesDigest.slice(0, 8)}-${i}`;
  const dir = path.join(base, runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.join(FORGEN_HOME, 'audit'), 0o700); fs.chmodSync(base, 0o700); } catch { /* 윈도우 등 */ }
  fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify(run.result, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ ...run.manifest, runId, timing: run.timing, judgeStats: run.judgeStats }, null, 2)}\n`, { mode: 0o600 });
  return { dir, runId };
}

/** 가장 최근 재생 결과(첫 화면용). 표본(--limit) 결과보다 전체 결과를, 그다음 최신을 고른다. 없으면 null. */
export function latestRecurrenceRun(): { runId: string; result: RecurrenceResult } | null {
  const base = path.join(FORGEN_HOME, 'audit', 'recurrence');
  let names: string[] = [];
  try { names = fs.readdirSync(base).sort().reverse(); } catch { return null; }
  // 0.9.3: 판정을 대부분 못 한 회차(incomplete)는 앞서 제대로 잰 회차를 가리지 않는다 — 그런 회차가 없을 때만 보인다
  let sampled: { runId: string; result: RecurrenceResult } | null = null;
  let incomplete: { runId: string; result: RecurrenceResult } | null = null;
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(base, n, 'result.json'), 'utf-8')) as RecurrenceResult;
      if (r.schema !== RECURRENCE_SCHEMA || r.status === 'model-off') continue;
      if (r.status === 'incomplete') { incomplete ??= { runId: n, result: r }; continue; }
      if (r.prompts.limit === null) return { runId: n, result: r };
      sampled ??= { runId: n, result: r };
    } catch { /* 깨진 회차 */ }
  }
  return sampled ?? incomplete;
}

export function latestRecurrence(): RecurrenceResult | null {
  return latestRecurrenceRun()?.result ?? null;
}

/**
 * 첫 화면 첫 줄(§0, §4.4 작을 때 규칙). 30일 환산 "적혀 있는데도 또 말함" ≥ 10 이면 그것을,
 * 아니면 반복 교정 전체를, 그것도 10 미만이면 "교정 N번 중 기억이 된 것 a, 다시 나온 것 b".
 */
/** 범위 안내 한 마디(처음 보는 사람용). */
export const RANGE_NOTE = '판정 기준에 따라 — 경계가 애매한 교정이 있어 범위로 보여 줍니다';
/** 엄격 값~관대 값(범위가 없으면 엄격 값 하나). fmt 로 숫자 꼴을 정한다. */
export function rangeText(r: RecurrenceResult, k: keyof Counts, unit: 'counts' | 'per1000' | 'per30d', fmt: (x: number) => string): string {
  const lo = (r[unit] as Counts)[k] ?? 0;
  const hi = r.range ? ((r.range.lenient[unit] as Counts)[k] ?? 0) : lo;
  const [a, b] = [Math.min(lo, hi), Math.max(lo, hi)];
  return fmt(a) === fmt(b) ? fmt(a) : `${fmt(a)}~${fmt(b)}`;
}

/** 옛 판정 방식 결과: 범위 대신 그때 값 하나를 옛 값이라고 밝혀 보인다. */
export function staleLine(r: RecurrenceResult): string {
  const pct = `${Math.round(r.per1000.total) / 10}%`;
  return `같은 말 다시 하기: ${STALE_JUDGE_NOTE} (${r.generatedAt.slice(0, 10)} 에 잰 옛 값 ${pct} — 지금 방식과 기준이 달라 비교하지 마세요)`;
}

/** 0.9.3: 모델이 대부분 판정하지 못한 회차 — 숫자(0% 등)를 보이지 않고 못 잰 까닭만. */
export function unmeasuredLine(r: RecurrenceResult): string {
  return `같은 말 다시 하기: 재지 못함 — ${r.statusNote || '모델이 대부분 판정하지 못함'}`;
}

export function recurrenceLine(r: RecurrenceResult | null): string {
  if (!r) return '같은 교정을 다시 한 횟수: 아직 재지 않음 — forgen audit recurrence 로 지난 대화 기록을 읽어 잰다(내 컴퓨터의 claude CLI 로 판정)';
  if (r.status === 'model-off') return '같은 교정을 다시 한 횟수: 모델을 끄고 재서 세지 않음';
  if (r.status === 'no-data') return `같은 교정을 다시 한 횟수: ${r.statusNote}`;
  if (r.status === 'incomplete') return unmeasuredLine(r);
  if (judgeChanges(r).length) return staleLine(r);
  const c = r.per30d;
  const f = (x: number) => (x >= 10 ? String(Math.round(x)) : String(r1(x)));
  const tag = r.status === 'ok' ? '' : r.status === 'insufficient' ? ` [참고값(교정 ${r.corrections.total}개)]` : ' [일부 판정 못 함]';
  const sample = r.prompts.limit ? ` · 요청 ${r.prompts.window}개 중 ${r.prompts.judged}개만 뽑아 잼` : '';
  const head = `지난 30일 교정 약 ${f(r.corrections.per30d)}번`;
  const R = (k: keyof Counts) => rangeText(r, k, 'per30d', f);
  const P = rangeText(r, 'total', 'per1000', (x) => `${Math.round(x) / 10}%`);
  const note = r.range ? ` (${RANGE_NOTE})` : '';
  // 범위(엄격~관대): 작을 때 규칙(§4.4)은 엄격 값(아래 끝)으로 고른다
  if (c.written >= MIN_CORRECTIONS_30D) {
    return `${head}, 그중 이미 적혀 있는데 또 말한 것 약 ${R('written')}번 (세션에 실렸는데도 ${R('ignored')} · 적혀 있지만 그 세션에 안 실려서 ${R('notLoaded')}${c.tier2Missed ? `, 그중 상황 맞춤 룰이 안 들어와서 ${f(c.tier2Missed)}` : ''}) · 어디에도 안 적혀 또 말한 것 약 ${R('unwrittenRepeat')}${c.deletedRepeat ? ` · 지운 기억을 다시 말한 것 ${R('deletedRepeat')}` : ''} — 내 요청의 ${P}가 같은 말 다시 하기${note}${sample}${tag}`;
  }
  if (c.total >= MIN_CORRECTIONS_30D) {
    return `${head}, 그중 같은 말 다시 하기 약 ${R('total')}번 (이미 적혀 있던 것 ${R('written')} · 어디에도 안 적힌 것 ${R('unwrittenRepeat')}${c.deletedRepeat ? ` · 지운 기억 ${R('deletedRepeat')}` : ''}) — 내 요청의 ${P}${note}${sample}${tag}`;
  }
  const became = r.corrections.total ? r1((r.corrections.becameMemory / r.corrections.total) * r.corrections.per30d) : 0;
  return `${head} 중 그 뒤 기억으로 남은 것 약 ${f(became)}, 다시 말한 것 약 ${f(c.total)} — 같은 말을 다시 하는 일이 적다(기억이 먹히고 있음)${sample}${tag}`;
}
