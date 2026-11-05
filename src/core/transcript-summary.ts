/**
 * Transcript → 추출 입력 요약 (D3, 2026-11-04 재설계).
 *
 * 약속: 요약에는 사용자가 실제로 한 말과 어시스턴트가 실제로 한 말만 들어간다. 그 안에서
 *  1) 세션 끝 구간, 2) 교정 메시지와 그 앞 어시스턴트 발화, 3) 나머지 사용자 발화 순으로 예산을 쓴다.
 *  예산은 "읽은 길이"가 아니라 "남긴 길이"로 센다 — 예전 구현은 원문 길이로 세다 첫 몇 턴(주로 주입
 *  텍스트)에서 조기 종료해 123MB 세션의 0.1%만 요약에 들었다.
 *
 * 제외(주입 텍스트): 스킬 본문, 슬래시 명령 표식, caveat, system-reminder, hook 컨텍스트, forgen-rules,
 *  stop-hook 메시지, 서브에이전트/피어/태스크 알림, 컴팩션 요약, AGENTS.md 주입(Codex).
 *
 * 스키마:
 *   Claude: {type:'user'|'assistant', message:{role, content: string | [{type:'text',text}|tool_result...]}}
 *           (queue-operation 등은 top-level `content` 에 저장 → fallback)
 *   Codex:  {type:'response_item', payload:{role, content:[{type:'input_text'|'output_text', text}]}}
 *
 * 파일은 스트림으로 읽고(`digestTranscriptFile`) 바이트 커서로 이어 읽는다 — 123MB 도 메모리 상수.
 */

import * as fs from 'node:fs';
import { createInterface } from 'node:readline';
import { correctionScore } from './correction-signals.js';

export function extractText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((x): x is { type: 'text'; text?: unknown } =>
        typeof x === 'object' && x !== null && (x as { type?: unknown }).type === 'text')
      .map((x) => (typeof x.text === 'string' ? x.text : ''))
      .join('\n');
  }
  return '';
}

/** Codex content array → flat string. content: [{type:'input_text', text}] */
export function extractCodexText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === 'object' && 'text' in item && typeof (item as { text: unknown }).text === 'string') {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join('\n');
}

// ── 주입 텍스트 판정 ──

const INJECTED_BLOCK_RE =
  /<(system-reminder|forgen-rules|user-prompt-submit-hook|session-start-hook|task-notification|local-command-caveat|local-command-stdout|command-name|command-message|command-args|compound-handoff|teammate-message|environment_context|user_instructions|INSTRUCTIONS)\b[^>]*>[\s\S]*?<\/\1>/gi;
const INJECTED_PREFIX_RE = new RegExp(
  '^(' + [
    '<(command-name|command-message|command-args|local-command|system-reminder|task-notification|forgen-rules|user-prompt-submit-hook|session-start-hook|bash-input|bash-stdout|bash-stderr|ide_|teammate-message|agent-message|INSTRUCTIONS|environment_context|user_instructions|compound-handoff)',
    'Caveat:',
    'Base directory for this skill',
    '# AGENTS\\.md instructions',
    'Stop hook (feedback|error|blocking)',
    '\\[Request interrupted',
    'Another Claude session sent a message',
    'This session is being continued from a previous conversation',
    'Your claude\\.ai usage limit has reset',
    '\\[forgen\\]',
    '\\[Forgen\\]',
  ].join('|') + ')',
  'i',
);

/** 주입 블록을 걷어낸 사람 발화. 남는 게 없거나 전체가 주입이면 ''. */
export function stripInjected(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();
  if (INJECTED_PREFIX_RE.test(trimmed)) return '';
  const cleaned = trimmed.replace(INJECTED_BLOCK_RE, '').trim();
  if (!cleaned || INJECTED_PREFIX_RE.test(cleaned)) return '';
  return cleaned;
}

interface TranscriptEntry {
  type?: string;
  operation?: string;
  content?: unknown;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  message?: { role?: string; content?: unknown };
  payload?: { role?: string; type?: string; content?: unknown };
}

/** 한 JSONL 엔트리 → {role,text} (주입/비대화는 null). */
export function classifyEntry(entry: TranscriptEntry): { role: 'user' | 'assistant'; text: string } | null {
  if (entry.type === 'user' || entry.type === 'queue-operation') {
    if (entry.isSidechain || entry.isMeta || entry.isCompactSummary) return null;
    if (entry.origin?.kind && entry.origin.kind !== 'human') return null;
    if (entry.type === 'queue-operation' && entry.operation && entry.operation !== 'enqueue') return null;
    const text = stripInjected(extractText(entry.message?.content ?? entry.content));
    return text ? { role: 'user', text } : null;
  }
  if (entry.type === 'assistant') {
    if (entry.isSidechain) return null;
    const text = extractText(entry.message?.content ?? entry.content).trim();
    return text ? { role: 'assistant', text } : null;
  }
  if (entry.type === 'response_item' && entry.payload && (entry.payload.type === undefined || entry.payload.type === 'message')) {
    const role = entry.payload.role;
    if (role !== 'user' && role !== 'assistant') return null;
    const raw = extractCodexText(entry.payload.content);
    const text = role === 'user' ? stripInjected(raw) : raw.trim();
    return text ? { role, text } : null;
  }
  return null;
}

// ── 다이제스트 ──

export interface DigestItem {
  line: number;
  role: 'user' | 'assistant';
  /** MAX_KEEP 으로 잘린 본문 */
  text: string;
  /** 사용자 발화의 교정 신호 점수 (0 = 없음) */
  score: number;
}

export interface Digest {
  items: DigestItem[];
  totalLines: number;
  /** 다음 증분 읽기 시작 바이트 (완결된 마지막 줄 끝) */
  endOffset: number;
  userMessages: number;
  correctionCandidates: number;
}

const MAX_KEEP = 600;
const RECENT_DEDUP = 64;

export interface DigestState {
  items: DigestItem[];
  lineNo: number;
  userMessages: number;
  correctionCandidates: number;
  recentUser: string[];
}

export function newDigestState(): DigestState {
  return { items: [], lineNo: 0, userMessages: 0, correctionCandidates: 0, recentUser: [] };
}

/** 한 줄을 먹인다. 파싱 실패/비대화 줄은 줄 번호만 올린다. */
export function feedLine(st: DigestState, line: string): void {
  st.lineNo++;
  // 값싼 선필터: 큰 줄(attachment, 스냅샷 등)은 JSON.parse 하지 않는다.
  if (!(line.includes('"type":"user"') || line.includes('"type":"assistant"')
    || line.includes('"type":"queue-operation"') || line.includes('"type":"response_item"')
    || line.includes('"type": "user"') || line.includes('"type": "assistant"')
    || line.includes('"type": "queue-operation"') || line.includes('"type": "response_item"'))) return;
  let entry: TranscriptEntry;
  try { entry = JSON.parse(line) as TranscriptEntry; } catch { return; }
  const c = classifyEntry(entry);
  if (!c) return;
  const text = c.text.length > MAX_KEEP ? c.text.slice(0, MAX_KEEP) : c.text;
  let score = 0;
  if (c.role === 'user') {
    const key = text.slice(0, 120);
    if (st.recentUser.includes(key)) return; // queue-operation + user 이중 기록 제거
    st.recentUser.push(key);
    if (st.recentUser.length > RECENT_DEDUP) st.recentUser.shift();
    st.userMessages++;
    score = correctionScore(text);
    if (score > 0) st.correctionCandidates++;
  }
  st.items.push({ line: st.lineNo, role: c.role, text, score });
}

export function finishDigest(st: DigestState, endOffset: number): Digest {
  return {
    items: st.items, totalLines: st.lineNo, endOffset,
    userMessages: st.userMessages, correctionCandidates: st.correctionCandidates,
  };
}

/** 교정 후보가 많은 세션일수록 예산을 늘린다(상한 32K자). 남긴 길이 기준. */
export function budgetFor(d: Pick<Digest, 'correctionCandidates'>, base = 12_000): number {
  return Math.min(32_000, base + 60 * d.correctionCandidates);
}

const TAIL_FRACTION = 0.2;
const TAIL_BUDGET_SHARE = 0.25;

function fmt(it: DigestItem, cap: number): string {
  const body = it.text.length > cap ? `${it.text.slice(0, cap)}…` : it.text;
  return `[${it.role === 'user' ? 'User' : 'Assistant'}] ${body}`;
}

/** 등간격 추출: 후보 중 예산에 맞게 n개만, 시간축 전체에 퍼지도록. */
function stride<T>(arr: T[], n: number): T[] {
  if (n >= arr.length) return arr;
  if (n <= 0) return [];
  const out: T[] = [];
  for (let k = 0; k < n; k++) out.push(arr[Math.floor((k * arr.length) / n)]);
  return out;
}

/**
 * 다이제스트 → 예산 안 요약 문자열(시간순). 우선순위:
 *  1) 세션 끝 20% 구간(예산 25% 상한, 늦은 것부터)  2) 교정 발화(강한 신호 먼저, 등간격)와 직전 어시스턴트
 *  3) 나머지 사용자 발화(등간격)  4) 남으면 어시스턴트 응답.
 */
export function renderDigest(d: Digest, budget: number = budgetFor(d)): string {
  const chosen = new Set<DigestItem>();
  let used = 0;
  const cost = (it: DigestItem, cap: number) => Math.min(it.text.length, cap) + 14;
  const take = (it: DigestItem, cap: number): boolean => {
    if (chosen.has(it)) return true;
    const c = cost(it, cap);
    if (used + c > budget) return false;
    chosen.add(it); used += c; return true;
  };
  const caps = new Map<DigestItem, number>();
  const takeCap = (it: DigestItem, cap: number): boolean => {
    const ok = take(it, cap);
    if (ok) caps.set(it, Math.max(caps.get(it) ?? 0, cap));
    return ok;
  };

  const tailStart = d.totalLines * (1 - TAIL_FRACTION);
  const tail = d.items.filter((i) => i.line > tailStart);
  const tailBudget = budget * TAIL_BUDGET_SHARE;
  let tailUsed = 0;
  for (let k = tail.length - 1; k >= 0; k--) {
    const c = cost(tail[k], 300);
    if (tailUsed + c > tailBudget) { if (chosen.size > 0) continue; }
    if (takeCap(tail[k], 300)) tailUsed += c;
  }

  const idxOf = new Map<DigestItem, number>();
  d.items.forEach((it, i) => idxOf.set(it, i));

  const corr = d.items.filter((i) => i.role === 'user' && i.score > 0 && !chosen.has(i));
  for (const tier of [3, 2]) {
    const group = corr.filter((i) => i.score === tier);
    if (group.length === 0) continue;
    const avg = Math.max(30, group.reduce((s, i) => s + cost(i, 200), 0) / group.length);
    // 교정 발화 자체에 예산의 80% 까지, 나머지는 앞뒤 맥락/일반 발화에.
    const room = Math.max(0, budget * 0.8 - used);
    const n = Math.floor(room / avg);
    for (const it of stride(group, n)) takeCap(it, 200);
  }
  // 교정 직전 어시스턴트 발화(맥락) — 남은 예산의 일부
  const ctxBudgetEnd = used + (budget - used) * 0.5;
  for (const it of [...chosen]) {
    if (it.role !== 'user' || it.score < 3) continue;
    const prev = d.items[(idxOf.get(it) ?? 0) - 1];
    if (prev && prev.role === 'assistant' && used + cost(prev, 140) <= ctxBudgetEnd) takeCap(prev, 140);
  }
  const rest = d.items.filter((i) => i.role === 'user' && !chosen.has(i));
  if (rest.length > 0) {
    const avg = Math.max(30, rest.reduce((s, i) => s + cost(i, 200), 0) / rest.length);
    const n = Math.floor((budget - used) / avg);
    for (const it of stride(rest, n)) takeCap(it, 200);
  }
  const asst = d.items.filter((i) => i.role === 'assistant' && !chosen.has(i));
  if (asst.length > 0 && budget - used > 200) {
    const n = Math.floor((budget - used) / 170);
    for (const it of stride(asst, n)) takeCap(it, 140);
  }

  const ordered = d.items.filter((i) => chosen.has(i));
  return ordered.map((i) => fmt(i, caps.get(i) ?? MAX_KEEP)).join('\n\n');
}

/**
 * JSONL 파일을 fromOffset 바이트부터 스트림으로 읽어 줄마다 콜백. 반환값 = 다음 증분 읽기 시작 바이트.
 * 개행 없이 끝난 마지막 줄이 JSON 으로 깨져 있으면(쓰는 중) 그 줄은 커서에 넣지 않는다.
 */
export async function streamTranscriptLines(
  filePath: string,
  fromOffset: number,
  onLine: (line: string) => void,
): Promise<number> {
  const size = fs.statSync(filePath).size;
  const start = fromOffset > size ? 0 : fromOffset; // 파일이 줄었으면 처음부터
  if (start >= size) return size;
  const stream = fs.createReadStream(filePath, { start, end: size - 1, highWaterMark: 1 << 20 });
  // readline 은 줄 끝(\n / \r\n)을 지워 버려 실제 바이트 수를 알 수 없다 — CRLF 파일에서 커서가 줄마다 1바이트씩 어긋났다.
  // 직접 \n 바이트로 나누고, 커서는 원본 바이트(종결자 포함)로 센다.
  let offset = start;
  let carry: Buffer = Buffer.alloc(0);
  const emit = (raw: Buffer): void => {
    let line = raw.toString('utf-8');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    onLine(line);
  };
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let nl: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: 바이트 스캔 관용구
    while ((nl = buf.indexOf(0x0a)) !== -1) {
      emit(buf.subarray(0, nl));
      offset += nl + 1;
      buf = buf.subarray(nl + 1);
    }
    carry = Buffer.from(buf);
  }
  let endOffset = offset;
  if (carry.length > 0) {
    // 개행 없이 끝난 마지막 줄: JSON 으로 온전하면 처리하고 커서에 넣고, 깨져 있으면(쓰는 중) 커서에 넣지 않는다.
    const tail = carry.toString('utf-8').replace(/\r$/, '');
    let ok = true;
    try { JSON.parse(tail); } catch { ok = false; }
    if (tail.length > 0) onLine(tail);
    if (ok) endOffset = offset + carry.length;
  }
  return Math.min(endOffset, size);
}

/** 파일 → 다이제스트 (스트림, fromOffset 바이트부터). */
export async function digestTranscriptFile(filePath: string, fromOffset = 0): Promise<Digest> {
  const st = newDigestState();
  const end = await streamTranscriptLines(filePath, fromOffset, (line) => {
    if (line) feedLine(st, line); else st.lineNo++;
  });
  return finishDigest(st, end);
}

/** 문자열 JSONL → 요약 (테스트·소형 입력용 동기 경로). */
export function summarizeTranscript(rawText: string, maxChars?: number): string {
  const st = newDigestState();
  for (const line of rawText.split('\n')) {
    if (line) feedLine(st, line); else st.lineNo++;
  }
  const d = finishDigest(st, Buffer.byteLength(rawText));
  return renderDigest(d, maxChars ?? budgetFor(d));
}
