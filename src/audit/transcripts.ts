/**
 * 대화 기록 읽기 — **읽기 전용** (docs/plans/2026-11-25-v1.0-plan.md §4.2-1, 부록 B.1-1).
 *
 * <claude-dir>/projects/<폴더>/<세션>.jsonl 최상위 세션만 읽는다(<세션>/subagents/ 아래 서브에이전트 기록은 제외).
 * 사용자 발화: type 'user' 이고 사이드체인·메타·압축 요약이 아니며, 도구 결과가 아니고, `<` 로 시작하지 않고(명령·붙여 넣은 태그),
 * 중단 표시·다른 세션이 보낸 메시지가 아닌 것. 직전에 AI 응답이 있었는지(prevAssistant)와 그 응답 앞부분을 같이 남긴다.
 * 메모 폴더 경로(…/projects/<폴더>/memory/…)에 대한 Write/Edit 호출은 시각·내용과 함께 모은다 — 메모의 "그때 모습"(§2.2).
 * 파일마다 크기·sha256 을 같이 낸다(manifest).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createHash } from 'node:crypto';

export interface Prompt {
  session: string;
  uuid: string;
  ts: string;
  cwd: string;
  /** 직전(앞 사용자 발화 이후)에 AI 응답이 있었나 */
  prevAssistant: boolean;
  /** 직전 AI 응답(글자가 있는 마지막 메시지) 앞 600자 */
  prevText: string;
  /** 발화 앞 1,500자 */
  text: string;
  length: number;
}

export interface MemoryWrite {
  /** projects 아래 상대 경로: <인코딩된 폴더>/memory/<파일> */
  rel: string;
  at: string;
  tool: string;
  /** 쓴 내용(Write content · Edit new_string · MultiEdit new_string 들) */
  content: string;
  /** 그때 모습 복원용: Write 의 전문, Edit·MultiEdit 의 (old → new) 바꾸기 목록 */
  full?: string;
  edits?: Array<{ old: string; new: string; all?: boolean }>;
}

export interface TranscriptFile { path: string; session: string; bytes: number; sha256: string }

export interface TranscriptScan {
  files: TranscriptFile[];
  prompts: Prompt[];
  memoryWrites: MemoryWrite[];
  /** 세션 → 첫 기록의 cwd */
  sessionCwd: Map<string, string>;
}

export const SKIP_PREFIX = ['[Request interrupted', 'Another Claude session sent a message'];
const MEMORY_REL = /[\\/]projects[\\/]([^\\/]+)[\\/]memory[\\/](.+)$/;

export function listTopLevelTranscripts(claudeDir: string): string[] {
  const root = path.join(claudeDir, 'projects');
  const out: string[] = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root).sort(); } catch { return []; }
  for (const d of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(root, d)).sort(); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const p = path.join(root, d, n);
      try { if (fs.statSync(p).isFile()) out.push(p); } catch { /* 없음 */ }
    }
  }
  return out;
}

function textOf(content: unknown): { text: string; toolResult: boolean } {
  if (typeof content === 'string') return { text: content, toolResult: false };
  if (!Array.isArray(content)) return { text: '', toolResult: false };
  let toolResult = false;
  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const blk = b as { type?: string; text?: string };
    if (blk.type === 'tool_result') toolResult = true;
    else if (blk.type === 'text' && typeof blk.text === 'string') parts.push(blk.text);
  }
  return { text: parts.join(''), toolResult };
}

function memoryWritesOf(m: { message?: { content?: unknown }; timestamp?: string }): MemoryWrite[] {
  const out: MemoryWrite[] = [];
  const content = m.message?.content;
  if (!Array.isArray(content) || !m.timestamp) return out;
  for (const b of content) {
    const blk = b as { type?: string; name?: string; input?: Record<string, unknown> };
    if (blk?.type !== 'tool_use' || !blk.input) continue;
    if (blk.name !== 'Write' && blk.name !== 'Edit' && blk.name !== 'MultiEdit') continue;
    const fp = typeof blk.input.file_path === 'string' ? blk.input.file_path : '';
    const rel = MEMORY_REL.exec(fp);
    if (!rel) continue;
    let text = '';
    let full: string | undefined;
    let edits: MemoryWrite['edits'];
    const inp = blk.input as { content?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown; edits?: unknown };
    if (typeof inp.content === 'string') { text = inp.content; full = inp.content; }
    else if (typeof inp.new_string === 'string') { text = inp.new_string; edits = typeof inp.old_string === 'string' ? [{ old: inp.old_string, new: inp.new_string, all: inp.replace_all === true }] : undefined; }
    else if (Array.isArray(inp.edits)) {
      const es = inp.edits as Array<{ old_string?: string; new_string?: string; replace_all?: boolean }>;
      text = es.map((e) => e?.new_string ?? '').join('\n');
      if (es.every((e) => typeof e?.old_string === 'string' && typeof e?.new_string === 'string')) edits = es.map((e) => ({ old: e.old_string as string, new: e.new_string as string, all: e.replace_all === true }));
    }
    out.push({ rel: `${rel[1]}/memory/${rel[2].replace(/\\/g, '/')}`, at: m.timestamp, tool: blk.name, content: text, ...(full !== undefined ? { full } : {}), ...(edits ? { edits } : {}) });
  }
  return out;
}

/** 한 파일을 줄 단위로 흘려 읽는다(큰 기록도 메모리에 다 올리지 않음). */
async function scanFile(file: string, scan: TranscriptScan): Promise<void> {
  const session = path.basename(file, '.jsonl');
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = fs.createReadStream(file);
  stream.on('data', (c) => { hash.update(c); bytes += c.length; });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let prevAssistant = false;
  let prevText = '';
  try {
    for await (const line of rl) {
      if (!line) continue;
      const isUser = line.includes('"type":"user"');
      const isAssistant = line.includes('"type":"assistant"');
      if (!isUser && !isAssistant) continue;
      let m: { type?: string; isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean; message?: { content?: unknown }; timestamp?: string; cwd?: string; uuid?: string };
      try { m = JSON.parse(line); } catch { continue; }
      if (m.cwd && !scan.sessionCwd.has(session)) scan.sessionCwd.set(session, m.cwd);
      if (m.type === 'assistant') {
        if (m.isSidechain) continue;
        prevAssistant = true;
        const { text } = textOf(m.message?.content);
        if (text.trim()) prevText = text.slice(0, 600);
        if (line.includes('/memory/')) scan.memoryWrites.push(...memoryWritesOf(m));
        continue;
      }
      if (m.type !== 'user' || m.isSidechain || m.isMeta || m.isCompactSummary) continue;
      const { text, toolResult } = textOf(m.message?.content);
      if (toolResult || !text.trim()) continue;
      const t = text.trimStart();
      if (t.startsWith('<') || SKIP_PREFIX.some((p) => t.startsWith(p))) continue;
      scan.prompts.push({ session, uuid: m.uuid ?? '', ts: m.timestamp ?? '', cwd: m.cwd ?? '', prevAssistant, prevText, text: text.slice(0, 1500), length: text.length });
      prevAssistant = false;
      prevText = '';
    }
  } catch { /* 읽다 끊긴 파일은 거기까지 */ }
  scan.files.push({ path: file, session, bytes, sha256: hash.digest('hex') });
}

export async function scanTranscripts(claudeDir: string): Promise<TranscriptScan> {
  const scan: TranscriptScan = { files: [], prompts: [], memoryWrites: [], sessionCwd: new Map() };
  for (const f of listTopLevelTranscripts(claudeDir)) await scanFile(f, scan);
  scan.files.sort((a, b) => (a.path < b.path ? -1 : 1));
  scan.prompts.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.session < b.session ? -1 : a.session > b.session ? 1 : a.uuid < b.uuid ? -1 : 1));
  scan.memoryWrites.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return scan;
}
