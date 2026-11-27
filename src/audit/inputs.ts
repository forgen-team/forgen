/**
 * forgen audit inputs — 사람 발화 주간 재측정(ROADMAP C2). **읽기 전용·모델 호출 없음.**
 *
 * 규칙은 A0 기준값 §1(사전 등록)을 그대로 옮겼다(witems-workspace docs/plans/2026-11-27-A0-baseline.md, 원본 a0-ref/extract.py·build.py·an.py).
 * - 자료: <claude-dir>/projects/<폴더>/<세션>.jsonl 최상위 파일(transcripts.ts 의 listTopLevelTranscripts). 서브에이전트 기록은 읽지 않는다.
 * - 사람 발화: origin.kind == human(+ 대기열 queued_command). origin 이 없으면 무인 실행. 중복(같은 세션·앞 60자·5분 안) 제거.
 * - Handoff 폴더·스크래치패드(-private-tmp) 폴더·일반 폴더의 무인 실행은 기본 집계에서 빼고 따로 센다.
 * - 시각은 KST(UTC+9 고정), 주는 월~일.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { countGate, GATE_OFF_NOTE, gateWarns, readGate, type GateCounts, type GateLog } from './inputs-gate.js';
import { encodeProjectDir } from './sources.js';
import { listTopLevelTranscripts } from './transcripts.js';
import {
  classifyMulti, cpLen, cpSlice, DECISION_ITEM, decisionLabel, decisionReply, DONE_CLAIM, DONE_CLAIM_MIN, hangulStats,
  isSelfFound, lowHangul, primaryOf, SELF_A0, SIMPLE_TYPES, type InputLabel, type InputType,
} from './inputs-classify.js';

export const KST_MS = 9 * 3_600_000;
const DAY = 86_400_000;
const EXCLUDE_PREFIX = ['Another Claude session sent a message', '[Request interrupted', '<command-', '<bash-', '<local-command', '<task-notification', '<system-reminder', 'Caveat:'];
const DEDUPE_KEY = 60;
const DEDUPE_MS = 300_000;

export type FolderKind = 'main' | 'handoff' | 'scratchpad';
export function folderKind(dir: string): FolderKind {
  if (dir.toLowerCase().includes('handoff') || dir.startsWith('-private-var-folders')) return 'handoff';
  if (dir.startsWith('-private-tmp')) return 'scratchpad';
  return 'main';
}

/** 사람 발화(H)·무인 발화(HX)·어시스턴트 text 블록(A)·압축 경계(C)·압축 요약(CS) */
export type Ev =
  | { k: 'H'; ms: number; text: string; queued: boolean; noOrigin: boolean }
  | { k: 'A'; ms: number; text: string; len: number; hangul: number; alpha: number; isJson: boolean; label: 'item' | 'none' | null }
  | { k: 'C' | 'CS'; ms: number };

export interface RawSession { session: string; dir: string; kind: FolderKind; ev: Ev[] }

// ── 원천 읽기 ──

function humanText(c: unknown): string {
  if (typeof c === 'string') return c.trim();
  if (!Array.isArray(c)) return '';
  if (c.some((x) => x && typeof x === 'object' && (x as { type?: string }).type === 'tool_result')) return '';
  const parts: string[] = [];
  for (const x of c) {
    const b = x as { type?: string; text?: unknown };
    if (!b || typeof b !== 'object' || b.type !== 'text') continue;
    const s = typeof b.text === 'string' ? b.text : '';
    if (s.trim().startsWith('<system-reminder')) continue;
    parts.push(s);
  }
  return parts.join('\n').trim();
}

function msOf(ts: unknown): number | null {
  if (typeof ts !== 'string' || !ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

function originKind(o: unknown): string | null {
  return o && typeof o === 'object' && typeof (o as { kind?: unknown }).kind === 'string' ? (o as { kind: string }).kind : null;
}

/** 어시스턴트 블록 본문은 완료 판정에 쓸 만큼만 남긴다(A0 와 같음: 1,600자 넘으면 앞 700 + 뒤 800). */
function keepText(tx: string, len: number): string {
  if (len <= 1600) return tx;
  const cps = Array.from(tx);
  return `${cps.slice(0, 700).join('')}\n…\n${cps.slice(-800).join('')}`;
}

type Line = {
  type?: string; subtype?: string; isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean; timestamp?: string;
  origin?: unknown; message?: { model?: string; content?: unknown };
  attachment?: { type?: string; origin?: unknown; prompt?: unknown; timestamp?: string };
};

export async function readSession(file: string, fromMs: number, toMs: number): Promise<RawSession> {
  const dir = path.basename(path.dirname(file));
  const s: RawSession = { session: path.basename(file, '.jsonl'), dir, kind: folderKind(dir), ev: [] };
  const inRange = (ms: number | null): ms is number => ms !== null && ms >= fromMs && ms < toMs;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const isU = line.includes('"type":"user"') || line.includes('"type": "user"');
      const isA = line.includes('"type":"assistant"') || line.includes('"type": "assistant"');
      const isC = line.includes('compact_boundary');
      const isQ = line.includes('queued_command');
      if (!isU && !isA && !isC && !isQ) continue;
      if (isU && !isQ && (line.includes('"type":"tool_result"') || line.includes('"type": "tool_result"'))) continue;
      let d: Line;
      try { d = JSON.parse(line); } catch { continue; }
      if (!d || d.isSidechain) continue;
      const ms = msOf(d.timestamp);
      if (d.type === 'assistant') {
        if (d.message?.model === '<synthetic>' || !inRange(ms)) continue;
        const content = d.message?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          const b = c as { type?: string; text?: unknown };
          if (b?.type !== 'text' || typeof b.text !== 'string' || !b.text.trim()) continue;
          const len = cpLen(b.text);
          // "판단할 것" 라벨은 잘라 내기 전 전체 본문에서 본다(긴 보고는 가운데가 잘림)
          s.ev.push({ k: 'A', ms, text: keepText(b.text, len), len, ...hangulStats(b.text), label: decisionLabel(b.text) });
        }
      } else if (d.type === 'system' && d.subtype === 'compact_boundary') {
        if (inRange(ms)) s.ev.push({ k: 'C', ms });
      } else if (d.type === 'user') {
        if (d.isMeta) continue;
        if (d.isCompactSummary) { if (inRange(ms)) s.ev.push({ k: 'CS', ms }); continue; }
        const kind = originKind(d.origin);
        const tx = humanText(d.message?.content);
        if (!tx || (kind !== null && kind !== 'human') || EXCLUDE_PREFIX.some((p) => tx.startsWith(p)) || !inRange(ms)) continue;
        s.ev.push({ k: 'H', ms, text: cpSlice(tx, 700), queued: false, noOrigin: kind === null });
      } else if (d.type === 'attachment') {
        const a = d.attachment;
        if (a?.type !== 'queued_command') continue;
        const kind = originKind(a.origin);
        const pr = a.prompt;
        let tx = typeof pr === 'string' ? pr.trim() : humanText(pr);
        if (typeof pr === 'string' && pr.startsWith('[{')) { try { tx = humanText(JSON.parse(pr)); } catch { /* 문자열 그대로 */ } }
        if (!tx || (kind !== null && kind !== 'human') || EXCLUDE_PREFIX.some((p) => tx.startsWith(p))) continue;
        // 대기열에 origin 이 없고 '<' 로 시작하면 사람 발화가 아니다(A0 build.py)
        if (kind === null && tx.startsWith('<')) continue;
        const qms = msOf(a.timestamp) ?? ms;
        if (!inRange(qms)) continue;
        s.ev.push({ k: 'H', ms: qms, text: cpSlice(tx, 700), queued: true, noOrigin: false });
      }
    }
  } catch { /* 읽다 끊긴 파일은 거기까지 */ }
  s.ev.sort((a, b) => a.ms - b.ms);
  return s;
}

/** 읽을 파일: 최상위 기록 중 구간 시작 이후에 수정된 것(이전에 수정된 파일에는 구간 안 기록이 없다). */
export async function readSessions(claudeDir: string, fromMs: number, toMs: number): Promise<RawSession[]> {
  const out: RawSession[] = [];
  for (const f of listTopLevelTranscripts(claudeDir)) {
    try { if (fs.statSync(f).mtimeMs < fromMs) continue; } catch { continue; }
    out.push(await readSession(f, fromMs, toMs));
  }
  return out;
}

// ── 주·날짜 (KST) ──

export function kstDay(ms: number): number { return Math.floor((ms + KST_MS) / DAY); }
export function kstDayStartMs(day: number): number { return day * DAY - KST_MS; }
export function dayLabel(day: number): string { return new Date(day * DAY).toISOString().slice(0, 10); }
/** 월요일의 KST 날 번호(1970-01-01 = 목요일) */
export function mondayOf(ms: number): number { const d = kstDay(ms); return d - ((d + 3) % 7); }
export function weekKey(ms: number): string { return dayLabel(mondayOf(ms)); }
export function parseKstDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`날짜는 YYYY-MM-DD(KST): ${s}`);
  const day = Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY);
  if (dayLabel(day) !== s.trim()) throw new Error(`없는 날짜: ${s}`);
  return day;
}

// ── 집계 ──

export interface Utterance { session: string; ms: number; labels: InputType[]; primary: InputLabel }
type TypeCounts = Record<InputLabel, number>;
const zeroTypes = (): TypeCounts => ({ nudge: 0, lang: 0, done: 0, proxy: 0, defect: 0, other: 0 });
interface Ratio { n: number; low: number; ratio: number | null }
const ratio = (n: number, low: number): Ratio => ({ n, low, ratio: n ? Math.round((low / n) * 1000) / 1000 : null });

export interface Claim { session: string; ms: number; done: boolean; next: InputType[] | null; nextIsOther: boolean; selfBlocks: number; selfA0: boolean; decision: boolean; decisionReply: Reply | null; label: 'item' | 'none' | null; labelReply: Reply | null }
type Reply = 'overturn' | 'accept' | 'unclear';
interface ReplyCounts { withNext: number; overturned: number; accepted: number; unclear: number; ratio: number | null }

interface Counts {
  human: number; sessions: number; types: TypeCounts; primary: TypeCounts; simple: number; multiLabeled: number;
  lang: { all: Ratio; final: Ratio; correctionUtterances: number };
  /** 주 지표 = defectPerDoneClaim(결함 보고 ÷ 완료 보고)의 주간 추이. afterDone 은 보조(완료 보고 바로 다음 발화가 결함인 비율) */
  m2: { defectPerDoneClaim: number | null; defectReports: number; doneClaims: number; afterDone: { turnsWithReply: number; doneWithNext: number; nextDefect: number; ratio: number | null; control: { turns: number; nextDefect: number; ratio: number | null } } };
  selfFound: { blocks: number; doneClaimsWithSelfFound: number; a0Phrase: number };
  /** labeled = 턴 마지막 보고에 "판단할 것" 라벨 줄이 있는 수, labeledNone = 그 라벨이 "없음". 뒤집기 비율의 분모는 라벨에 항목이 있고 다음 사람 발화가 있는 보고 */
  m3: { labeled: number; labeledNone: number; labeledItem: number } & ReplyCounts & { legacy: { decisionReports: number } & ReplyCounts };
}

export interface SessionRow { session: string; folder: string; first: string; last: string; human: number; types: TypeCounts; simple: number; compactions: number }
export interface WithGate extends Counts { gate: GateCounts }
export interface WeekRow extends WithGate { week: string; days: number }

export interface InputsResult {
  schema: 'forgen-audit-inputs/1';
  generatedAt: string;
  range: { since: string; until: string; untilExclusive: string; tz: 'Asia/Seoul (UTC+9)' };
  source: { claudeDir: string; filesRead: number; reportGate: { path: string; exists: boolean; firstRecord: string | null; unreadableLines: number } };
  fieldLabels: Record<string, '실측' | '근사'>;
  total: WithGate;
  excluded: { handoff: { human: number; unattended: number }; scratchpad: { human: number; unattended: number }; mainUnattended: number; queuedDuplicates: number };
  weeks: WeekRow[];
  /** M2 주 지표의 주간 추이(지난 주 포함) */
  trend: { defectPerDoneClaim: { week: string; days: number; value: number | null; defectReports: number; doneClaims: number }[] };
  previousWeek: WeekRow | null;
  sessions: { top: SessionRow[]; share: { top1: number | null; top3: number | null; top15: number | null }; compactions: number };
  notes: string[];
}

export const FIELD_LABELS: InputsResult['fieldLabels'] = {
  human: '실측', sessions: '실측', 'excluded.*': '실측', 'sessions.share': '실측', compactions: '실측',
  types: '근사', primary: '근사', simple: '근사', multiLabeled: '근사',
  'lang.all': '실측', 'lang.final': '실측', 'lang.correctionUtterances': '근사',
  'm2.*': '근사', 'trend.defectPerDoneClaim': '근사', 'selfFound.*': '근사',
  'm3.labeled': '실측', 'm3.labeledNone': '실측', 'm3.labeledItem': '실측', 'm3.withNext': '실측', 'm3.overturned': '근사', 'm3.accepted': '근사', 'm3.unclear': '근사', 'm3.ratio': '근사', 'm3.legacy.*': '근사',
  'gate.judged': '실측', 'gate.byDecision': '실측', 'gate.byProblem': '실측', 'gate.byMissing': '실측', 'gate.judgeNone': '실측', 'gate.inCountedSessions': '실측',
  'gate.blockedRatio': '실측',
};

export const NOTES = [
  '분류는 키워드 규칙(A0 분류기 v2)이다 [근사]. 오너 판정(A0 §7-0)대로 재설명 규칙은 버렸고, 한 발화가 여러 유형에 들 수 있다(types = 다중 분류, 합이 사람 발화 수보다 클 수 있음). primary 는 A0 와 같은 첫 일치(재설명 제외)로 A0 숫자와 견주는 용도.',
  '단순 입력(simple) = 재촉·언어·완료 확인·조작 대행 중 하나라도 걸린 발화 수.',
  '언어 누수 [실측]: 사람 발화가 있는 일반 폴더 세션의 어시스턴트 text 블록. 코드·인라인 코드·URL·경로를 지운 뒤 한글/(한글+영문) < 0.3 이면 저한글. 20자 미만·JSON 응답·코드뿐인 응답은 뺀다. final = 턴의 마지막 text 블록만.',
  'M2 [근사]: 주 지표는 defectPerDoneClaim = 결함 보고 발화 수 ÷ 완료 보고 수의 주간 추이(trend.defectPerDoneClaim). 완료 보고 = 턴 마지막 text 블록이 150자 이상이고 완료 문구를 담음. 보조(afterDone): 완료 보고 바로 다음 사람 발화에 결함 보고 유형이 있는 비율과, 완료 보고가 아닌 턴 뒤의 같은 비율(control) — A0 에서 둘이 구별되지 않아 보조로 내렸다.',
  '스스로 찾은 결함 [근사]: 완료 보고 턴(앞 사람 발화 ~ 완료 보고) 안의 어시스턴트 text 블록 중 발견 동사+결함 명사(또는 결함 명사+고침 동사)가 한 줄에 가까이 붙은 블록 수(blocks)와 그런 블록이 하나라도 있는 완료 보고 수. 한계: 문구 매칭이라 "결함은 없습니다"·계획 설명·사람 말 인용도 걸릴 수 있고, 말없이 고친 것은 못 센다. 도구 호출 내용(diff)은 보지 않는다. a0Phrase = A0 §3 의 거친 대용 문구가 완료 보고 블록에 있는 수(연속성 비교용).',
  'M3: 턴 마지막 보고에 "판단할 것" 라벨 줄(/판단할\\s*것/)이 있으면 labeled [실측]. 라벨 뒤(같은 줄, 비었으면 다음 줄)가 "없음"이면 labeledNone, 아니면 labeledItem. labeledItem 중 다음 사람 발화가 있는 것이 분모(withNext). 그 발화가 부정·대안 어휘("아니·말고·대신·반대로…")를 담으면 overturned, "추천대로·그대로·ㅇㅇ…"면 accepted, 나머지 unclear [근사 — 답 판정은 키워드]. legacy = 라벨 도입 전 키워드 근사("판단/결정할 것" 류 문구)로, 연속성 비교용.',
  '보고 관문(B1 Stop 훅): <claude-dir>/hooks/state/report-gate.jsonl 을 읽기만 한다. 관문은 완료 보고로 판정한 때에만 기록하므로 판정 수 자체가 관문이 본 완료 보고 수다. 판정 수·decision 별·problems 별·missing 별·judgeNone 수·막힌 비율 blockedRatio = block ÷ (block + pass + cap-pass) [실측]. status: no-file(파일 없음)·before-first-record(첫 기록 전 구간, 경고 안 함)·maybe-off(첫 기록 이후 키워드 규칙의 완료 보고가 있는데 판정 0)·ok. 관문은 무인 실행에도 걸릴 수 있어 inCountedSessions(기본 집계 세션의 판정)를 따로 낸다.',
  '작업 경계·세션: 세션 = 대화 기록 파일 1개. 압축 = compact_boundary 수(없으면 압축 요약 수).',
];

function sessionSeq(s: RawSession): { H: { ev: Ev & { k: 'H' }; u: Utterance }[]; seq: Ev[]; dups: number } {
  const recent: { key: string; ms: number }[] = [];
  const seq: Ev[] = [];
  const H: { ev: Ev & { k: 'H' }; u: Utterance }[] = [];
  let dups = 0;
  for (const e of s.ev) {
    if (e.k === 'H' && !e.noOrigin) {
      const key = e.text.slice(0, DEDUPE_KEY);
      if (recent.some((r) => r.key === key && Math.abs(e.ms - r.ms) < DEDUPE_MS)) { dups++; continue; }
      recent.push({ key, ms: e.ms });
      const labels = classifyMulti(e.text);
      H.push({ ev: e, u: { session: s.session, ms: e.ms, labels, primary: primaryOf(labels) } });
    }
    if (e.k === 'H' && e.noOrigin) continue;
    seq.push(e);
  }
  return { H, seq, dups };
}

function emptyCounts(): Counts {
  return {
    human: 0, sessions: 0, types: zeroTypes(), primary: zeroTypes(), simple: 0, multiLabeled: 0,
    lang: { all: ratio(0, 0), final: ratio(0, 0), correctionUtterances: 0 },
    m2: { defectPerDoneClaim: null, defectReports: 0, doneClaims: 0, afterDone: { turnsWithReply: 0, doneWithNext: 0, nextDefect: 0, ratio: null, control: { turns: 0, nextDefect: 0, ratio: null } } },
    selfFound: { blocks: 0, doneClaimsWithSelfFound: 0, a0Phrase: 0 },
    m3: { labeled: 0, labeledNone: 0, labeledItem: 0, withNext: 0, overturned: 0, accepted: 0, unclear: 0, ratio: null, legacy: { decisionReports: 0, withNext: 0, overturned: 0, accepted: 0, unclear: 0, ratio: null } },
  };
}

interface Analyzed { utterances: Utterance[]; claims: Claim[]; lang: { ms: number; low: boolean; final: boolean }[]; sessionsUsed: { s: RawSession; utt: Utterance[]; compactions: number }[]; excluded: InputsResult['excluded'] }

/** 구간 [fromMs, toMs) 의 사건만으로 A0 규칙을 돌린다. */
export function analyze(raw: RawSession[], fromMs: number, toMs: number): Analyzed {
  const out: Analyzed = { utterances: [], claims: [], lang: [], sessionsUsed: [], excluded: { handoff: { human: 0, unattended: 0 }, scratchpad: { human: 0, unattended: 0 }, mainUnattended: 0, queuedDuplicates: 0 } };
  for (const r0 of raw) {
    const r: RawSession = { ...r0, ev: r0.ev.filter((e) => e.ms >= fromMs && e.ms < toMs) };
    const { H, seq, dups } = sessionSeq(r);
    const unattended = r.ev.filter((e) => e.k === 'H' && e.noOrigin).length;
    if (r.kind !== 'main') { const x = out.excluded[r.kind]; x.human += H.length; x.unattended += unattended; continue; }
    out.excluded.mainUnattended += unattended;
    out.excluded.queuedDuplicates += dups;
    if (!H.length) continue;
    const utt = H.map((h) => h.u);
    out.utterances.push(...utt);
    const nC = seq.filter((e) => e.k === 'C').length;
    const nCS = seq.filter((e) => e.k === 'CS').length;
    out.sessionsUsed.push({ s: r, utt, compactions: Math.max(nC, nCS) });
    const byEv = new Map(H.map((h) => [h.ev, h.u]));
    // 언어 누수: 블록마다, 마지막 블록 = 다음 A/H 가 H 이거나 없음
    const AH = seq.filter((e) => e.k === 'A' || e.k === 'H');
    AH.forEach((e, i) => {
      if (e.k !== 'A') return;
      const low = lowHangul(e);
      if (low === null) return;
      const nxt = AH[i + 1];
      out.lang.push({ ms: e.ms, low, final: !nxt || nxt.k === 'H' });
    });
    // 턴: 사람 발화와 다음 사람 발화 사이의 어시스턴트 블록들
    const humIdx = AH.map((e, i) => (e.k === 'H' ? i : -1)).filter((i) => i >= 0);
    humIdx.forEach((hi, k) => {
      const end = k + 1 < humIdx.length ? humIdx[k + 1] : AH.length;
      const blocks = AH.slice(hi + 1, end).filter((e): e is Ev & { k: 'A' } => e.k === 'A');
      if (!blocks.length) return;
      const last = blocks[blocks.length - 1];
      const nextU = end < AH.length ? byEv.get(AH[end] as Ev & { k: 'H' }) ?? null : null;
      const done = last.len >= DONE_CLAIM_MIN && DONE_CLAIM.test(last.text);
      const decision = DECISION_ITEM.test(last.text);
      out.claims.push({
        session: r.session, ms: last.ms, done, next: nextU ? nextU.labels : null, nextIsOther: !!nextU && !nextU.labels.length,
        selfBlocks: done ? blocks.filter((b) => isSelfFound(b.text)).length : 0, selfA0: done && SELF_A0.test(last.text),
        decision, decisionReply: decision && nextU ? decisionReply((AH[end] as Ev & { k: 'H' }).text) : null,
        label: last.label, labelReply: last.label === 'item' && nextU ? decisionReply((AH[end] as Ev & { k: 'H' }).text) : null,
      });
    });
  }
  return out;
}

function count(a: Analyzed, inR: (ms: number) => boolean): Counts {
  const c = emptyCounts();
  const utt = a.utterances.filter((u) => inR(u.ms));
  c.human = utt.length;
  c.sessions = new Set(utt.map((u) => u.session)).size;
  for (const u of utt) {
    if (!u.labels.length) c.types.other++;
    for (const t of u.labels) c.types[t]++;
    c.primary[u.primary]++;
    if (u.labels.some((t) => SIMPLE_TYPES.has(t))) c.simple++;
    if (u.labels.length > 1) c.multiLabeled++;
    if (u.labels.includes('lang')) c.lang.correctionUtterances++;
  }
  const L = a.lang.filter((x) => inR(x.ms));
  c.lang.all = ratio(L.length, L.filter((x) => x.low).length);
  const LF = L.filter((x) => x.final);
  c.lang.final = ratio(LF.length, LF.filter((x) => x.low).length);
  const cl = a.claims.filter((x) => inR(x.ms));
  const done = cl.filter((x) => x.done);
  const dn = done.filter((x) => x.next);
  const nd = cl.filter((x) => !x.done && x.next);
  const r3 = (p: number, q: number) => (q ? Math.round((p / q) * 1000) / 1000 : null);
  const nextDefect = dn.filter((x) => x.next?.includes('defect')).length;
  const ctlDefect = nd.filter((x) => x.next?.includes('defect')).length;
  c.m2 = {
    defectPerDoneClaim: r3(c.types.defect, done.length), defectReports: c.types.defect, doneClaims: done.length,
    afterDone: { turnsWithReply: cl.filter((x) => x.next).length, doneWithNext: dn.length, nextDefect, ratio: r3(nextDefect, dn.length), control: { turns: nd.length, nextDefect: ctlDefect, ratio: r3(ctlDefect, nd.length) } },
  };
  c.selfFound = { blocks: done.reduce((n, x) => n + x.selfBlocks, 0), doneClaimsWithSelfFound: done.filter((x) => x.selfBlocks > 0).length, a0Phrase: done.filter((x) => x.selfA0).length };
  const replies = (xs: (Reply | null)[]): ReplyCounts => {
    const r = xs.filter((x): x is Reply => x !== null);
    const over = r.filter((x) => x === 'overturn').length;
    return { withNext: r.length, overturned: over, accepted: r.filter((x) => x === 'accept').length, unclear: r.filter((x) => x === 'unclear').length, ratio: r3(over, r.length) };
  };
  const dec = cl.filter((x) => x.decision);
  c.m3 = {
    labeled: cl.filter((x) => x.label).length, labeledNone: cl.filter((x) => x.label === 'none').length, labeledItem: cl.filter((x) => x.label === 'item').length,
    ...replies(cl.map((x) => x.labelReply)),
    legacy: { decisionReports: dec.length, ...replies(dec.map((x) => x.decisionReply)) },
  };
  return c;
}

export function shortFolder(dir: string): string {
  const home = `${encodeProjectDir(os.homedir())}-`;
  return (dir.startsWith(home) ? dir.slice(home.length) : dir).replace('repo-witems-workspace-', 'ws:').replace('repo-', '').replace('orca-workspaces-', 'orca:').slice(0, 34);
}

/** 구간 [fromMs, toMs) 의 보고 관문 판정을 같은 구간 완료 보고와 견준다 */
function gateOf(g: GateLog, a: Analyzed, fromMs: number, toMs: number): GateCounts {
  const done = a.claims.filter((c) => c.done && c.ms >= fromMs && c.ms < toMs).map((c) => c.ms);
  return countGate(g, fromMs, toMs, done, new Set(a.sessionsUsed.map((x) => x.s.session)));
}

function weekRows(a: Analyzed, g: GateLog, fromMs: number, toMs: number): WeekRow[] {
  const rows: WeekRow[] = [];
  for (let mon = mondayOf(fromMs); kstDayStartMs(mon) < toMs; mon += 7) {
    const ws = Math.max(fromMs, kstDayStartMs(mon));
    const we = Math.min(toMs, kstDayStartMs(mon + 7));
    rows.push({ week: dayLabel(mon), days: Math.round((we - ws) / DAY * 10) / 10, ...count(a, (ms) => ms >= ws && ms < we), gate: gateOf(g, a, ws, we) });
  }
  return rows;
}

export interface InputsOptions { claudeDir: string; sinceMs: number; untilMs: number; top?: number; now?: Date }

export async function runInputs(o: InputsOptions): Promise<InputsResult> {
  const prevFrom = o.sinceMs - 7 * DAY;
  const raw = await readSessions(o.claudeDir, prevFrom, o.untilMs);
  const a = analyze(raw, o.sinceMs, o.untilMs);
  const p = analyze(raw, prevFrom, o.sinceMs);
  const g = readGate(o.claudeDir);
  const total = { ...count(a, () => true), gate: gateOf(g, a, o.sinceMs, o.untilMs) };
  const weeks = weekRows(a, g, o.sinceMs, o.untilMs);
  const rows = a.sessionsUsed.map(({ s, utt, compactions }) => {
    const types = zeroTypes();
    for (const u of utt) { if (!u.labels.length) types.other++; for (const t of u.labels) types[t]++; }
    return {
      session: s.session.slice(0, 8), folder: shortFolder(s.dir), first: dayLabel(kstDay(utt[0].ms)).slice(5), last: dayLabel(kstDay(utt[utt.length - 1].ms)).slice(5),
      human: utt.length, types, simple: utt.filter((u) => u.labels.some((t) => SIMPLE_TYPES.has(t))).length, compactions,
    };
  }).sort((x, y) => y.human - x.human || (x.session < y.session ? -1 : 1));
  const share = (k: number) => (total.human ? Math.round((rows.slice(0, k).reduce((n, r) => n + r.human, 0) / total.human) * 100) / 100 : null);
  const prevCounts = count(p, () => true);
  const untilDay = kstDay(o.untilMs - 1);
  const prevRow: WeekRow | null = prevCounts.human || prevCounts.lang.all.n ? { week: dayLabel(mondayOf(prevFrom)), days: 7, ...prevCounts, gate: gateOf(g, p, prevFrom, o.sinceMs) } : null;
  const offWeeks = weeks.filter((w) => gateWarns(w.gate)).map((w) => w.week);
  const gateNote = !g.exists
    ? `${GATE_OFF_NOTE}: 판정 기록 파일이 없다(${g.path}).`
    : offWeeks.length ? `${GATE_OFF_NOTE}: 완료 보고가 있는데 관문 판정이 0 인 주 — ${offWeeks.join(', ')}.` : null;
  return {
    schema: 'forgen-audit-inputs/1',
    generatedAt: (o.now ?? new Date()).toISOString(),
    range: { since: dayLabel(kstDay(o.sinceMs)), until: dayLabel(untilDay), untilExclusive: new Date(o.untilMs).toISOString(), tz: 'Asia/Seoul (UTC+9)' },
    source: { claudeDir: o.claudeDir, filesRead: raw.length, reportGate: { path: g.path, exists: g.exists, firstRecord: g.firstMs === null ? null : new Date(g.firstMs).toISOString(), unreadableLines: g.unreadableLines } },
    fieldLabels: FIELD_LABELS,
    total,
    excluded: a.excluded,
    weeks,
    trend: { defectPerDoneClaim: [...(prevRow ? [prevRow] : []), ...weeks].map((w) => ({ week: w.week, days: w.days, value: w.m2.defectPerDoneClaim, defectReports: w.m2.defectReports, doneClaims: w.m2.doneClaims })) },
    previousWeek: prevRow,
    sessions: { top: rows.slice(0, o.top ?? 15), share: { top1: share(1), top3: share(3), top15: share(15) }, compactions: rows.reduce((n, r) => n + r.compactions, 0) },
    notes: gateNote ? [gateNote, ...NOTES] : NOTES,
  };
}

