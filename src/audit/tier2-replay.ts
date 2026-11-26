/**
 * 두 층 자격 게이트 재생 — `forgen audit tier2 --replay [--apply]` (docs/plans/2026-11-25-v1.0-plan.md §8.1 ②).
 *
 * 룰마다 근거 교정(evidence_refs)의 대화 기록을 재생한다. **교정 발화 자체는 빼고** 그 직전 3턴(사용자 프롬프트 + 그 뒤 도구 호출)에서
 * 런타임과 같은 결정적 판정(사건 하나의 낱말과 룰 낱말 집합이 K 개 이상 겹침)이 발동했나를 본다.
 *   - 룰 낱말 = 정책 문장·trigger 낱말(대화 기록에서 흔한 낱말 제외) + 근거 상황에서 배운 드문 낱말(근거 2개 이상일 때만).
 *   - 배운 낱말이 있는 룰은 leave-one-out: 근거 i 를 맞힐 때는 i 를 뺀 나머지 근거에서 배운 낱말만 쓴다.
 *   - 자격: 재생 가능한 근거가 1개 이상, 발동 비율 ≥ 0.8, 대화 기록 사건 중 발동 비율 ≤ 5%(너무 자주 뜨면 토큰이 는다).
 * 놓침 추정(자격을 지난 룰 안에서): ① 시간 나누기 — 앞선 근거로만 게이트·낱말을 정하고 가장 늦은 근거를 맞히는지
 *   ② 재발 사례 — 같은 말 다시 하기 재생(audit recurrence)이 이 룰에 붙인 교정 직전 3턴에서 발동하는지. 둘 다 게이트에 안 쓴 상황이다.
 * 원천은 읽기만 한다. --apply 일 때만 `state/tier2-index.json` 을 쓴다(재발 이력은 합친다).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { loadAllEvidence } from '../store/evidence-store.js';
import { loadActiveRules } from '../store/rule-store.js';
import type { Evidence, Rule } from '../store/types.js';
import {
  loadTier2Index, MATCH_K, overlap, saveTier2Index, tierOf, TIER2_INDEX_VERSION, toolSignalText, words,
  type Tier2Entry, type Tier2Index, type Tier2Recur,
} from '../core/tier2.js';
import { latestRecurrenceRun } from './recurrence.js';
import { listTopLevelTranscripts, scanTranscripts, SKIP_PREFIX } from './transcripts.js';

export const TURNS = 3;
export const MIN_FIRE_RATE = 0.8;
export const MAX_FREQ = 0.05;
/** 룰 문장 낱말 중 이 비율보다 많은 사건에 나오는 낱말은 버린다(어디서나 나오는 낱말). */
export const MAX_WORD_DF = 0.04;
/** 근거 상황에서 배우는 낱말은 이 비율 이하의 사건에만 나오는 드문 것. */
export const LEARN_DF = 0.01;
const LEARN_PER_CONTEXT = 8;
const MIN_EVENTS_FOR_DF = 500;

export interface ReplayEvent { kind: 'user' | 'tool'; ts: string; words: Set<string> }
interface Ctx { evidence: string; ts: string; events: ReplayEvent[]; learn: string[] }

export interface Tier2ReplayRule {
  id: string; strength: string; source: string; tier1Reason: string | null; approved?: boolean;
  contexts: number; fired: number; firedTurn1: number; qualified: boolean; reason: string; freq: number; words: number;
}

export interface Tier2ReplayResult {
  generatedAt: string;
  params: Tier2Index['params'];
  rules: number;
  /** 1층 조건(hard·strong·30일·재발)에 안 들어 게이트를 보는 룰 */
  candidates: number;
  /** 오너가 승인한 발동 조건으로 2층(게이트 대신) */
  approved: number;
  replayable: number;
  qualified: number;
  passRate: number;
  passRateReplayable: number;
  byReason: Record<string, number>;
  tier1ByReason: Record<string, number>;
  /** 자격을 지난 룰 안에서의 놓침 추정(게이트에 쓰지 않은 상황) */
  miss: { timeSplit: { tested: number; missed: number }; recurrence: { tested: number; missed: number }; inGate: { contexts: number; missed: number } };
  /** 사건(프롬프트·도구 호출)당 발동하는 2층 룰 수 */
  firesPerEvent: { mean: number; p90: number };
  sessions: { needed: number; found: number; events: number; locatedByQuote: number };
  detail: Tier2ReplayRule[];
  notes: string[];
}

function textOf(content: unknown): { text: string; toolResult: boolean } {
  if (typeof content === 'string') return { text: content, toolResult: false };
  if (!Array.isArray(content)) return { text: '', toolResult: false };
  let toolResult = false;
  const parts: string[] = [];
  for (const b of content) {
    const blk = b as { type?: string; text?: string };
    if (blk?.type === 'tool_result') toolResult = true;
    else if (blk?.type === 'text' && typeof blk.text === 'string') parts.push(blk.text);
  }
  return { text: parts.join(''), toolResult };
}

/** 최상위 세션 한 개의 사건(사람 프롬프트·도구 호출) — 시간순. */
export async function readSessionEvents(file: string): Promise<ReplayEvent[]> {
  const out: ReplayEvent[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line || (!line.includes('"type":"user"') && !line.includes('"tool_use"'))) continue;
      let m: { type?: string; isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean; message?: { content?: unknown }; timestamp?: string };
      try { m = JSON.parse(line); } catch { continue; }
      if (m.isSidechain || !m.timestamp) continue;
      if (m.type === 'user') {
        if (m.isMeta || m.isCompactSummary) continue;
        const { text, toolResult } = textOf(m.message?.content);
        const t = text.trimStart();
        if (toolResult || !t || t.startsWith('<') || SKIP_PREFIX.some((p) => t.startsWith(p))) continue;
        out.push({ kind: 'user', ts: m.timestamp, words: words(text.slice(0, 3000)) });
      } else if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
        for (const b of m.message.content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
          if (b?.type === 'tool_use') out.push({ kind: 'tool', ts: m.timestamp, words: words(toolSignalText(b.name ?? '', b.input)) });
        }
      }
    }
  } catch { /* 읽다 끊긴 파일은 거기까지 */ }
  return out;
}

/** 교정 시각 ts 직전 상황: 교정 발화(ts 이전 마지막 사용자 프롬프트)를 빼고, 그 앞 n 턴(프롬프트 + 뒤따른 도구 호출). */
export function contextBefore(events: ReplayEvent[], ts: string, turns = TURNS): ReplayEvent[] | null {
  let end = events.length;
  while (end > 0 && events[end - 1].ts >= ts) end--;
  const users: number[] = [];
  for (let i = 0; i < end; i++) if (events[i].kind === 'user') users.push(i);
  if (users.length < 2) return null;
  const corr = users[users.length - 1];
  const start = users[Math.max(0, users.length - 1 - turns)];
  return events.slice(start, corr);
}

const fires = (evs: ReplayEvent[], set: Set<string>, k = MATCH_K) => evs.some((e) => overlap(e.words, set) >= k);

function rareWords(evs: ReplayEvent[], df: (w: string) => number, enough: boolean): string[] {
  if (!enough) return [];
  const all = new Set<string>();
  for (const e of evs) for (const w of e.words) if (df(w) <= LEARN_DF) all.add(w);
  return [...all].sort((a, b) => df(a) - df(b) || (a < b ? -1 : 1)).slice(0, LEARN_PER_CONTEXT);
}

export interface ReplayOptions { claudeDir: string; now?: Date; rules?: Rule[]; evidence?: Evidence[] }

export async function runTier2Replay(opts: ReplayOptions): Promise<{ result: Tier2ReplayResult; index: Tier2Index }> {
  const now = opts.now ?? new Date();
  const notes: string[] = [];
  const rules = (opts.rules ?? loadActiveRules()).filter((r) => r.status === 'active' && r.scope === 'me').sort((a, b) => (a.rule_id < b.rule_id ? -1 : 1));
  const evidence = new Map((opts.evidence ?? loadAllEvidence()).map((e) => [e.evidence_id, e]));
  const recRun = latestRecurrenceRun();
  const recItems = (recRun?.result.items ?? []).filter((it) => it.match?.ruleId && (it.branch === 'ignored' || it.branch === 'not-loaded'));

  // 1. 필요한 세션의 사건. 근거의 session_id 로 기록을 못 찾으면(다른 세션 id·호스트가 지운 기록) 사용자 인용문으로 교정 발화를 찾는다.
  const allFiles = new Map<string, string>();
  for (const f of listTopLevelTranscripts(opts.claudeDir)) { const s = path.basename(f, '.jsonl'); if (!allFiles.has(s)) allFiles.set(s, f); }
  const located = new Map<string, { session: string; ts: string }>();
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  const quoteOf = (e: Evidence) => norm(String((e.raw_payload as { user_quote?: unknown })?.user_quote ?? ''));
  const unlocated = rules.flatMap((r) => r.evidence_refs ?? []).map((id) => evidence.get(id)).filter((e): e is Evidence => !!e?.timestamp && !(e.session_id && allFiles.has(e.session_id)) && quoteOf(e).length >= 12);
  if (unlocated.length) {
    const scan = await scanTranscripts(opts.claudeDir);
    const prompts = scan.prompts.map((p) => ({ ...p, n: norm(p.text) }));
    for (const e of unlocated) {
      const q = quoteOf(e).slice(0, 60);
      const hits = prompts.filter((p) => p.n.includes(q));
      if (!hits.length) continue;
      const t = Date.parse(e.timestamp);
      hits.sort((a, b) => Math.abs(Date.parse(a.ts) - t) - Math.abs(Date.parse(b.ts) - t) || (a.ts < b.ts ? -1 : 1));
      located.set(e.evidence_id, { session: hits[0].session, ts: new Date(Date.parse(hits[0].ts) + 1).toISOString() });
    }
  }
  const where = (e: Evidence): { session: string; ts: string } | null => (e.session_id && allFiles.has(e.session_id) ? { session: e.session_id, ts: e.timestamp } : located.get(e.evidence_id) ?? null);
  const needed = new Set<string>();
  for (const r of rules) for (const id of r.evidence_refs ?? []) { const e = evidence.get(id); const w = e?.timestamp ? where(e) : null; if (w) needed.add(w.session); }
  for (const it of recItems) needed.add(it.session);
  const files = new Map<string, string>();
  for (const s of needed) { const f = allFiles.get(s); if (f) files.set(s, f); }
  const sessions = new Map<string, ReplayEvent[]>();
  for (const [s, f] of [...files].sort()) sessions.set(s, await readSessionEvents(f));
  let nEvents = 0;
  const dfCount = new Map<string, number>();
  for (const evs of sessions.values()) for (const e of evs) { nEvents++; for (const w of e.words) dfCount.set(w, (dfCount.get(w) ?? 0) + 1); }
  // 빈도 거르기는 사건이 충분할 때만 — 작은 기록에서는 비율이 뜻이 없다(모든 낱말이 "흔함"이 된다).
  const df = (w: string) => (nEvents >= MIN_EVENTS_FOR_DF ? (dfCount.get(w) ?? 0) / nEvents : 0);
  const corpus = [...sessions.values()].flat();

  // 2. 룰별 상황
  const prev = loadTier2Index();
  const recur: Record<string, Tier2Recur> = { ...(prev?.recur ?? {}) };
  for (const it of recItems) {
    const id = it.match?.ruleId as string;
    const kind: Tier2Recur['kind'] = it.match?.reason === 'tier2-missed' ? 'tier2-missed' : 'recurred';
    const cur = recur[id];
    if (!cur || cur.lastAt < it.ts) recur[id] = { lastAt: it.ts, kind: cur?.kind === 'tier2-missed' ? 'tier2-missed' : kind, count: (cur?.count ?? 0) + 1, session: it.session };
  }
  const base: Tier2Index = { version: TIER2_INDEX_VERSION, generatedAt: now.toISOString(), params: { k: MATCH_K, turns: TURNS, minFireRate: MIN_FIRE_RATE, maxFreq: MAX_FREQ }, rules: {}, recur };
  const ctxOf = new Map<string, Ctx[]>();
  for (const r of rules) {
    const cs: Ctx[] = [];
    for (const id of r.evidence_refs ?? []) {
      const e = evidence.get(id);
      const w = e?.timestamp ? where(e) : null;
      if (!w) continue;
      const evs = sessions.get(w.session);
      const c = evs ? contextBefore(evs, w.ts) : null;
      if (c?.length) cs.push({ evidence: id, ts: w.ts, events: c, learn: rareWords(c, df, nEvents >= MIN_EVENTS_FOR_DF) });
    }
    ctxOf.set(r.rule_id, cs.sort((a, b) => (a.ts < b.ts ? -1 : 1)));
  }
  // applies_when(선택 필드)의 도구·명령·경로·낱말은 사람이 정한 발동 조건이라 흔함 거르기 없이 넣는다.
  const appliesWords = (r: Rule) => { const a = r.applies_when; return a ? [...words([...(a.tools ?? []), ...(a.commands ?? []), ...(a.paths ?? []), ...(a.words ?? [])].join(' '))] : []; };
  const baseWords = (r: Rule) => [...new Set([...[...words(`${r.trigger ?? ''} ${r.policy}`)].filter((w) => df(w) <= MAX_WORD_DF), ...appliesWords(r)])];
  const learnedFrom = (cs: Ctx[]) => (cs.length ? new Set(cs.flatMap((c) => c.learn)) : new Set<string>());

  const detail: Tier2ReplayRule[] = [];
  const byReason: Record<string, number> = {};
  const tier1ByReason: Record<string, number> = {};
  let approvedN = 0;
  let timeTested = 0, timeMissed = 0, inGateContexts = 0, inGateMissed = 0;
  const finalSets = new Map<string, Set<string>>();
  for (const r of rules) {
    const cs = ctxOf.get(r.rule_id) ?? [];
    const bw = baseWords(r);
    const learnAll = cs.length >= 2 ? learnedFrom(cs) : new Set<string>();
    const finalSet = new Set([...bw, ...learnAll]);
    // leave-one-out 발동
    let fired = 0, firedTurn1 = 0;
    for (let i = 0; i < cs.length; i++) {
      const others = cs.length >= 2 ? learnedFrom(cs.filter((_, j) => j !== i)) : new Set<string>();
      const set = new Set([...bw, ...others]);
      if (fires(cs[i].events, set)) fired++;
      const users = cs[i].events.map((e, k) => (e.kind === 'user' ? k : -1)).filter((k) => k >= 0);
      if (fires(cs[i].events.slice(users[users.length - 1] ?? 0), set)) firedTurn1++;
    }
    let freq = 0;
    if (finalSet.size >= MATCH_K) { let n = 0; for (const e of corpus) if (overlap(e.words, finalSet) >= MATCH_K) n++; freq = corpus.length ? n / corpus.length : 0; }
    let reason = 'fired';
    let qualified = true;
    if (finalSet.size < MATCH_K) { qualified = false; reason = 'no-words'; }
    else if (!cs.length) { qualified = false; reason = 'no-context'; }
    else if (fired / cs.length < MIN_FIRE_RATE) { qualified = false; reason = 'missed'; }
    else if (nEvents >= MIN_EVENTS_FOR_DF && freq > MAX_FREQ) { qualified = false; reason = 'too-frequent'; }
    const topics = [...bw].sort((a, b) => df(a) - df(b) || (a < b ? -1 : 1)).filter((w) => /[a-z]{3,}|[가-힣]{2}/.test(w)).slice(0, 3);
    const lastObservedAt = cs.length ? cs[cs.length - 1].ts : undefined;
    const entry: Tier2Entry = { qualified, reason, words: [...finalSet].sort(), topics, contexts: cs.length, fired, freq: Math.round(freq * 10000) / 10000, ...(lastObservedAt ? { lastObservedAt } : {}) };
    base.rules[r.rule_id] = entry;
    const t = tierOf(r, base, now.getTime());
    // 'approved'(오너가 승인한 발동 조건)는 게이트를 대신하므로 게이트 대상·통과율에서 뺀다 — 게이트 임계는 그대로다.
    const tier1Reason = t.reason === 'tier2' || t.reason === 'not-qualified' || t.reason === 'approved' ? null : t.reason;
    if (t.reason === 'approved') approvedN++;
    if (tier1Reason) tier1ByReason[tier1Reason] = (tier1ByReason[tier1Reason] ?? 0) + 1;
    else if (t.reason !== 'approved') {
      byReason[reason] = (byReason[reason] ?? 0) + 1;
      if (qualified) {
        finalSets.set(r.rule_id, finalSet);
        inGateContexts += cs.length; inGateMissed += cs.length - fired;
        // ① 시간 나누기: 앞선 근거로만 정하고 가장 늦은 근거를 맞히나
        if (cs.length >= 2) {
          const early = cs.slice(0, -1);
          const eSet = new Set([...bw, ...(early.length >= 2 ? learnedFrom(early) : new Set<string>())]);
          let ef = 0;
          for (let i = 0; i < early.length; i++) {
            const o = early.length >= 2 ? learnedFrom(early.filter((_, j) => j !== i)) : new Set<string>();
            if (fires(early[i].events, new Set([...bw, ...o]))) ef++;
          }
          if (ef / early.length >= MIN_FIRE_RATE) { timeTested++; if (!fires(cs[cs.length - 1].events, eSet)) timeMissed++; }
        }
      }
    }
    detail.push({ id: r.rule_id, strength: r.strength, source: r.source, tier1Reason, ...(t.reason === 'approved' ? { approved: true } : {}), contexts: cs.length, fired, firedTurn1, qualified, reason, freq: entry.freq ?? 0, words: finalSet.size });
  }

  // ② 재발 사례(게이트에 안 쓴 상황)
  let recTested = 0, recMissed = 0;
  const gateTs = new Set([...ctxOf.values()].flat().map((c) => `${c.ts}`));
  for (const it of recItems) {
    const set = finalSets.get(it.match?.ruleId as string);
    if (!set) continue;
    const evs = sessions.get(it.session);
    const c = evs ? contextBefore(evs, it.ts) : null;
    if (!c?.length || gateTs.has(it.ts)) continue;
    recTested++;
    if (!fires(c, set)) recMissed++;
  }

  // 사건당 발동 수(2층 룰만)
  const per: number[] = [];
  if (finalSets.size) for (const e of corpus) { let n = 0; for (const s of finalSets.values()) if (overlap(e.words, s) >= MATCH_K) n++; per.push(n); }
  per.sort((a, b) => a - b);
  const candidates = detail.filter((d) => !d.tier1Reason && !d.approved);
  const replayable = candidates.filter((d) => d.contexts > 0);
  const qualified = candidates.filter((d) => d.qualified);
  if (!recRun) notes.push('같은 말 다시 하기 재생(audit recurrence) 결과가 없어 재발 이력·재발 사례 놓침은 비어 있다');
  notes.push('한계: 2층 미발동은 교정이 나온 경우만 잡는다. 실렸어야 할 때 안 실렸는데 사용자가 교정하지 않았거나, 실렸는데 모델이 무시하고 교정이 없었던 경우는 이 재생으로 알 수 없다');
  const result: Tier2ReplayResult = {
    generatedAt: now.toISOString(), params: base.params,
    rules: rules.length, candidates: candidates.length, approved: approvedN, replayable: replayable.length, qualified: qualified.length,
    passRate: candidates.length ? Math.round((qualified.length / candidates.length) * 1000) / 1000 : 0,
    passRateReplayable: replayable.length ? Math.round((qualified.length / replayable.length) * 1000) / 1000 : 0,
    byReason, tier1ByReason,
    miss: { timeSplit: { tested: timeTested, missed: timeMissed }, recurrence: { tested: recTested, missed: recMissed }, inGate: { contexts: inGateContexts, missed: inGateMissed } },
    firesPerEvent: { mean: per.length ? Math.round((per.reduce((a, b) => a + b, 0) / per.length) * 1000) / 1000 : 0, p90: per.length ? per[Math.floor(per.length * 0.9)] : 0 },
    sessions: { needed: needed.size, found: sessions.size, events: nEvents, locatedByQuote: located.size },
    detail, notes,
  };
  return { result, index: base };
}

export function applyTier2Index(index: Tier2Index): void { saveTier2Index(index); }

/** 재발 이력을 색인에 합친다(audit recurrence 뒤) — 2층 미발동이면 그 룰은 다음 세션부터 1층(자동 복귀). 색인이 없으면 아무것도 안 한다. */
export function mergeRecurrence(items: Array<{ ts: string; session: string; branch: string; match?: { ruleId?: string; reason?: string } }>): { updated: number; tier2Missed: string[] } {
  const idx = loadTier2Index();
  if (!idx) return { updated: 0, tier2Missed: [] };
  let updated = 0;
  const missed: string[] = [];
  for (const it of items) {
    const id = it.match?.ruleId;
    if (!id || (it.branch !== 'ignored' && it.branch !== 'not-loaded')) continue;
    const kind: Tier2Recur['kind'] = it.match?.reason === 'tier2-missed' ? 'tier2-missed' : 'recurred';
    if (kind === 'tier2-missed') missed.push(id);
    const cur = idx.recur[id];
    if (cur && cur.lastAt >= it.ts && (cur.kind === 'tier2-missed' || kind === 'recurred')) continue;
    idx.recur[id] = { lastAt: cur && cur.lastAt > it.ts ? cur.lastAt : it.ts, kind: cur?.kind === 'tier2-missed' || kind === 'tier2-missed' ? 'tier2-missed' : 'recurred', count: (cur?.count ?? 0) + 1, session: it.session };
    updated++;
  }
  if (updated) saveTier2Index(idx);
  return { updated, tier2Missed: [...new Set(missed)].sort() };
}
