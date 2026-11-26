/**
 * 결정 원장 수집 (0.8.0, docs/plans/2026-11-25-direction.md §3 A·§9 오너 결정) — 수집만, 동작은 바꾸지 않는다.
 *
 * 대화 기록에서 선택형 질문(AskUserQuestion) 호출과 답을 결정적으로 뽑아 `me/decisions/<YYYY-MM>.jsonl` 에 쌓는다.
 * 모델 호출 없음, 기기 밖 전송 없음(내보내기 대상 아님). 대화 기록은 호스트가 기간이 지나면 지우므로 지금 쌓지 않으면 잃는다.
 *
 * 집계 정의(direction.md §1 고정): 단위 = 질문, 범위 = 최상위 세션 기록(서브에이전트 폴더 제외),
 * 호출 ID 로 중복 제거하되 결과 줄이 여러 번이면 답이 든 것을 쓴다.
 * 분류: unanswered → multi(multiSelect) → free(선택지 밖 입력) → no-recommendation → accept / override.
 * 추천 판별: 선택지 라벨에 "(추천)" 또는 "(Recommended)" 가 붙은 것.
 */
import { HIDDEN_HEADER, stripRecommendation } from './hidden-recommendation.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ME_DIR, STATE_DIR } from './paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import { withFileLockSync } from '../hooks/shared/file-lock.js';
import { projectKeyFor } from '../store/rule-scope.js';

export const DECISIONS_DIR = path.join(ME_DIR, 'decisions');
const INDEX_PATH = path.join(STATE_DIR, 'decisions-index.json');
const BACKFILL_MARK = path.join(STATE_DIR, 'decisions-backfill-done');
const REC_RE = /\((추천|recommended)\)/i;

/**
 * hidden-accept / hidden-override: 추천을 숨기고 물은 질문(0.9.0, hidden-recommendation.ts)에서
 * 숨긴 추천과 같은 답 / 다른 선택지. 직접 입력은 숨김 여부와 상관없이 'free'.
 */
export type DecisionKind = 'accept' | 'override' | 'free' | 'multi' | 'no-recommendation' | 'unanswered' | 'hidden-accept' | 'hidden-override';
export interface DecisionRecord {
  id: string;            // `${tool_use_id}#${질문 순서}`
  at: string;
  session: string;
  host: 'claude';
  cwd?: string;
  project?: string | null;
  question: string;
  header?: string;
  options: string[];     // 보여 준 순서 그대로
  recommended: string[];
  multiSelect: boolean;
  answer?: string;
  kind: DecisionKind;
  /** 추천 숨김 표본이면 true. options 는 실제로 보인 순서, recommended 는 빈 배열, 숨긴 추천은 hiddenRecommended. */
  hidden?: true;
  hiddenRecommended?: string[];
}

interface Pending { at: string; cwd?: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string }>; multiSelect?: boolean }> }
type Shown = Pending['questions'] | null;
interface Index { version: 1; seen: Record<string, true>; sessions: Record<string, { offset: number; pending: Record<string, Pending> }> }

function loadIndex(): Index {
  const i = safeReadJSON<Index | null>(INDEX_PATH, null);
  return i && i.version === 1 ? i : { version: 1, seen: {}, sessions: {} };
}

export function classifyAnswer(q: Pending['questions'][number], answer: string | undefined): DecisionKind {
  if (answer === undefined) return 'unanswered';
  if (q.multiSelect) return 'multi';
  const labels = q.options.map((o) => o.label);
  if (!labels.includes(answer)) return 'free';
  const rec = labels.filter((l) => REC_RE.test(l));
  if (rec.length === 0) return 'no-recommendation';
  return rec.includes(answer) ? 'accept' : 'override';
}

function toRecords(toolUseId: string, p: Pending, answers: Record<string, string> | null, session: string, shown: Shown = null): DecisionRecord[] {
  return p.questions.map((q, n) => {
    const answer = answers ? answers[q.question] : undefined;
    const s = shown?.[n];
    if (s && s.header === HIDDEN_HEADER && s.question === q.question && Array.isArray(s.options)) {
      // 추천 숨김 표본: 원래 추천(모델이 쓴 원본 입력)과 실제로 보인 선택지(toolUseResult)를 맞대어 남긴다.
      const shownLabels = s.options.map((o) => o.label);
      const hiddenRec = q.options.map((o) => o.label).filter((l) => REC_RE.test(l)).map(stripRecommendation);
      const kind: DecisionKind = answer === undefined ? 'unanswered'
        : !shownLabels.includes(answer) ? 'free'
          : hiddenRec.includes(answer) ? 'hidden-accept' : 'hidden-override';
      return {
        id: `${toolUseId}#${n}`, at: p.at, session, host: 'claude' as const,
        ...(p.cwd ? { cwd: p.cwd, project: (() => { try { return projectKeyFor(p.cwd as string); } catch { return null; } })() } : {}),
        question: q.question, header: HIDDEN_HEADER, options: shownLabels, recommended: [], multiSelect: false,
        ...(answer !== undefined ? { answer } : {}), kind, hidden: true as const, hiddenRecommended: hiddenRec,
      };
    }
    const labels = q.options.map((o) => o.label);
    return {
      id: `${toolUseId}#${n}`, at: p.at, session, host: 'claude' as const,
      ...(p.cwd ? { cwd: p.cwd, project: (() => { try { return projectKeyFor(p.cwd as string); } catch { return null; } })() } : {}),
      question: q.question, ...(q.header ? { header: q.header } : {}), options: labels,
      recommended: labels.filter((l) => REC_RE.test(l)), multiSelect: Boolean(q.multiSelect),
      ...(answer !== undefined ? { answer } : {}), kind: classifyAnswer(q, answer),
    };
  });
}

/** 대화 기록 한 줄에서 질문 호출·답을 뽑아 pending/out 에 반영. */
function scanLine(line: string, pending: Record<string, Pending>, onResult: (id: string, answers: Record<string, string> | null, shown: Shown) => void): void {
  if (!line.includes('AskUserQuestion') && !line.includes('tool_result')) return;
  let d: { timestamp?: string; cwd?: string; message?: { content?: unknown }; toolUseResult?: { answers?: Record<string, string>; questions?: Pending['questions'] } };
  try { d = JSON.parse(line); } catch { return; }
  const content = d.message?.content;
  if (!Array.isArray(content)) return;
  for (const b of content as Array<Record<string, unknown>>) {
    if (b?.type === 'tool_use' && b.name === 'AskUserQuestion' && typeof b.id === 'string') {
      const input = b.input as { questions?: Pending['questions'] } | undefined;
      if (Array.isArray(input?.questions)) pending[b.id] = { at: d.timestamp ?? new Date().toISOString(), ...(d.cwd ? { cwd: d.cwd } : {}), questions: input.questions };
    } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && pending[b.tool_use_id]) {
      const answers = d.toolUseResult && typeof d.toolUseResult.answers === 'object' ? d.toolUseResult.answers : null;
      const shown = Array.isArray(d.toolUseResult?.questions) ? d.toolUseResult.questions : null;
      onResult(b.tool_use_id, answers, shown);
    }
  }
}

function appendRecords(recs: DecisionRecord[]): void {
  if (!recs.length) return;
  fs.mkdirSync(DECISIONS_DIR, { recursive: true, mode: 0o700 });
  const byMonth = new Map<string, DecisionRecord[]>();
  for (const r of recs) { const m = r.at.slice(0, 7); byMonth.set(m, [...(byMonth.get(m) ?? []), r]); }
  for (const [m, rs] of byMonth) fs.appendFileSync(path.join(DECISIONS_DIR, `${m}.jsonl`), `${rs.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
}

/**
 * 한 세션 기록에서 새 결정을 모은다(증분: 지난번 읽은 위치부터). 답이 아직 없는 질문은 다음 실행까지 기다린다.
 * 같은 호출의 결과 줄이 여러 번이면 답이 든 것을 쓴다 — 답 없는 결과만 보이면 기다렸다가 끝(final)에 unanswered 로.
 */
export function collectDecisions(transcriptPath: string, sessionId: string, opts: { final?: boolean } = {}): number {
  if (!fs.existsSync(transcriptPath)) return 0;
  fs.mkdirSync(STATE_DIR, { recursive: true }); // 새 설치에는 state 폴더가 없을 수 있다(잠금 파일 자리)
  return withFileLockSync(INDEX_PATH, () => {
    const idx = loadIndex();
    const st = idx.sessions[sessionId] ?? { offset: 0, pending: {} };
    let size = 0;
    try { size = fs.statSync(transcriptPath).size; } catch { return 0; }
    if (size < st.offset) st.offset = 0; // 파일이 교체됨
    const out: DecisionRecord[] = [];
    let closing = false;
    const settle = (id: string, answers: Record<string, string> | null, shown: Shown = null) => {
      const p = st.pending[id];
      if (!p) return;
      if (!answers && !closing) return; // 답이 든 사본이 뒤에 올 수 있다 — 파일 끝까지 기다린다
      for (const r of toRecords(id, p, answers, sessionId, shown)) if (!idx.seen[r.id]) { idx.seen[r.id] = true; out.push(r); }
      delete st.pending[id];
    };
    let fd: number | null = null;
    try {
      fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(1024 * 1024);
      let pos = st.offset; let rest = Buffer.alloc(0); let lastComplete = st.offset;
      while (pos < size) {
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        let chunk = Buffer.concat([rest, buf.subarray(0, n)]);
        const chunkStart = pos - rest.length;
        pos += n;
        let consumed = 0; let nl = chunk.indexOf(10);
        while (nl >= 0) { scanLine(chunk.subarray(0, nl).toString('utf-8'), st.pending, settle); consumed += nl + 1; chunk = chunk.subarray(nl + 1); nl = chunk.indexOf(10); }
        lastComplete = chunkStart + consumed;
        rest = Buffer.from(chunk);
      }
      st.offset = lastComplete;
    } finally { if (fd !== null) fs.closeSync(fd); }
    if (opts.final) { closing = true; for (const id of Object.keys(st.pending)) settle(id, null); }
    idx.sessions[sessionId] = st;
    appendRecords(out);
    atomicWriteJSON(INDEX_PATH, idx, { mode: 0o600 });
    return out.length;
  });
}

/** 업그레이드 뒤 1회: 남아 있는 최상위 대화 기록 전부에서 소급 수집. 서브에이전트 폴더는 제외. */
export function backfillDecisionsOnce(projectsDir = path.join(os.homedir(), '.claude', 'projects')): number | null {
  if (fs.existsSync(BACKFILL_MARK)) return null;
  let total = 0;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { dirs = []; }
  const all: Array<{ file: string; sid: string }> = [];
  for (const d of dirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(projectsDir, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) all.push({ file: path.join(projectsDir, d, f), sid: f.replace(/\.jsonl$/, '') });
  }
  // 두 번 돈다: 먼저 답이 있는 것만 모으고(이어하기·포크로 같은 질문이 여러 파일에 있어도 답 있는 사본이 이긴다),
  // 그다음 끝내 답이 없는 것을 unanswered 로 닫는다.
  for (const pass of [false, true]) {
    for (const { file, sid } of all) {
      try { total += collectDecisions(file, sid, { final: pass }); } catch { /* 한 파일 실패는 건너뜀 */ }
    }
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(BACKFILL_MARK, JSON.stringify({ at: new Date().toISOString(), collected: total }));
  return total;
}

/** fromMonth('YYYY-MM') 이전 달 파일은 읽지 않는다. */
export function readDecisions(fromMonth = ''): DecisionRecord[] {
  let files: string[] = [];
  try { files = fs.readdirSync(DECISIONS_DIR).filter((f) => f.endsWith('.jsonl') && f.slice(0, 7) >= fromMonth).sort(); } catch { return []; }
  const out: DecisionRecord[] = [];
  for (const f of files) for (const l of fs.readFileSync(path.join(DECISIONS_DIR, f), 'utf-8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* */ } }
  return out;
}

export function summarizeDecisions(sinceMs = 0): Record<DecisionKind, number> {
  const out: Record<DecisionKind, number> = { accept: 0, override: 0, free: 0, multi: 0, 'no-recommendation': 0, unanswered: 0, 'hidden-accept': 0, 'hidden-override': 0 };
  const fromMonth = sinceMs > 0 ? new Date(sinceMs).toISOString().slice(0, 7) : '';
  for (const d of readDecisions(fromMonth)) if (Date.parse(d.at) >= sinceMs) out[d.kind]++;
  return out;
}

/**
 * N6(계획 2026-11-25-v1.0 §1.2): ⓐ 추천이 붙은 단일 선택 답 중 추천 그대로 / ⓑ 추천을 숨긴 단일 선택 답 중 숨긴 추천과 같음.
 * 직접 입력(free)은 분모에 넣는다(ⓐ 는 추천이 보였던 것, ⓑ 는 숨김 표본만). 표본 하한 30 미만이면 judgeable=false.
 * 주의: ⓑ 의 모집단은 ⓐ 의 부분집합이다(되돌릴 수 있는 질문만 숨긴다). gap 은 같은 조건 질문끼리 비교한 것이 아니며,
 * 비가역 결정(배포·삭제 등)은 ⓑ 에 들어가지 않는다. 표본은 forgen PreToolUse 훅이 도는 대화형 Claude 세션에 한정된다.
 */
export interface DecisionScore { shownRate: number | null; shownN: number; hiddenRate: number | null; hiddenN: number; gap: number | null; judgeable: boolean }
export function scoreDecisions(sinceMs = 0, untilMs = Number.POSITIVE_INFINITY): DecisionScore {
  const fromMonth = sinceMs > 0 ? new Date(sinceMs).toISOString().slice(0, 7) : '';
  let sA = 0, sN = 0, hA = 0, hN = 0;
  for (const d of readDecisions(fromMonth)) {
    const at = Date.parse(d.at);
    if (!(at >= sinceMs && at < untilMs) || d.multiSelect || d.answer === undefined) continue;
    if (d.hidden) { hN++; if (d.kind === 'hidden-accept') hA++; continue; }
    if (d.recommended.length === 0) continue;
    sN++; if (d.kind === 'accept') sA++;
  }
  const shownRate = sN ? sA / sN : null; const hiddenRate = hN ? hA / hN : null;
  return { shownRate, shownN: sN, hiddenRate, hiddenN: hN, gap: shownRate !== null && hiddenRate !== null ? shownRate - hiddenRate : null, judgeable: sN >= 30 && hN >= 30 };
}
