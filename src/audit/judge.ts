/**
 * 감사 모델 판정기 (docs/plans/2026-11-25-v1.0-plan.md §2.1·§2.4·§4.2).
 *
 * - 보내는 곳: 사용자가 이미 쓰는 로컬 `claude` CLI 뿐. 호출 방식은 세션 학습 추출(extraction-haiku)과 같다 —
 *   격리 옵션(도구·MCP·설정·슬래시 명령 없음, 세션 저장 안 함), 프롬프트는 stdin, 중첩 실행 표시 환경변수.
 * - 판정자는 **모델 ID 고정**(별칭 `haiku` 가 가리키는 모델이 바뀌면 같은 입력이 다른 판정을 받으므로).
 * - 판정 프롬프트는 **사전 등록**: 아래 상수와 판본이 정본이고, 문장을 바꾸면 판본을 올린다(캐시 키에 들어감).
 * - 결과는 (입력 해시, 판정자, 판본) 키로 <FORGEN_HOME>/audit/cache/ 에 캐시한다 → 캐시가 있으면 같은 입력은 같은 판정.
 * - 보내는 양: 교정 판정은 발화 ≤ 500자 + 직전 AI 응답 앞 300자, 쌍 판정은 문장 2개(각 ≤ 400자). 비밀키는 가리고 <private> 구간은 뺀다.
 * - 이 모듈은 extraction-events·haiku-status 를 쓰지 않는다(감사의 쓰기는 audit/ 아래뿐).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { FORGEN_HOME } from '../core/paths.js';
import { classifyFailure, NESTED_ISOLATION_ARGS } from '../core/extraction-haiku.js';
import { NESTED_RUN_ENV } from '../host/exec-host.js';
import { redactSecrets } from '../hooks/secret-filter.js';

/** 판정자 — 모델 ID 고정(2026-11-25 `claude -p --model haiku` 가 가리킨 모델). */
export const JUDGE_MODEL = 'claude-haiku-5-5';
export const UTTER_MAX = 500;
export const PREV_MAX = 300;
export const PAIR_TEXT_MAX = 400;

export const CORRECTION_PROMPT_VERSION = 'n4-correction/1';
/** 사전 등록 — 교정 판정(§4.2-2). 바꾸면 CORRECTION_PROMPT_VERSION 을 올린다. */
export const CORRECTION_PROMPT = `너는 대화 기록 감사의 판정자다. 아래 항목마다 (직전 AI 응답 앞부분, 그 뒤 사용자 발화)가 있다.
사용자 발화가 직전 AI 의 행동·결과·방식을 고치라는 **교정**인지 판정하라.
- 교정: AI 가 한 일·말한 방식·고른 방법이 틀렸거나 원치 않았다고 지적하고 다르게 하라고 하는 것(하지 마라, 그게 아니라, 왜 ~했냐, 다시 해라 등).
- 교정 아님: 새 요청, 질문, 승인·진행 지시, 정보 제공, 칭찬, 다음 단계 지시.
교정이면 gist 에 "고칠 행동과 방향"을 한 줄로 적는다(예: "확인 없이 배포하지 말고 먼저 물어볼 것"). 교정이 아니면 gist 는 "".
task_specific: 그 교정이 이 작업에만 해당하고 다른 작업에 다시 쓸 일반 지시가 아니면 true.
출력은 항목마다 한 줄 JSON 만, 다른 말 없이:
{"id":"<id>","correction":true|false,"gist":"…","task_specific":true|false}`;

export const PAIR_PROMPT_VERSION = 'n4-pair/2';
/**
 * 사전 등록 — 같은 뜻 쌍 판정(§4.2-3). 순서를 바꿔 두 번 묻고 다르면 "갈림". 바꾸면 PAIR_PROMPT_VERSION 을 올린다.
 * 판본 1(2026-11-25)은 "한쪽이 일부 조건만 말하면 다름"을 넣어 일반 룰 ↔ 구체 교정이 순서에 따라 갈렸다(실데이터 표본 교정 46개에서 갈린 쌍 26).
 * 판본 2 는 판정 질문을 대칭으로 둔다: 한쪽을 지켰다면 다른 쪽 지시가 필요 없었는가.
 */
export const PAIR_PROMPT = `너는 기억 감사의 판정자다. 아래 쌍마다 두 문장 A, B 가 있다. 하나는 사용자가 AI 에게 한 교정의 요지이고, 다른 하나는 기억(룰·메모·지침)이거나 다른 때의 교정이다. 어느 쪽이 A 인지는 무작위다.
두 문장이 **같은 행동 지시**인지 판정하라 — AI 가 한쪽 문장을 지켰다면 다른 쪽 교정·지시가 필요 없었는가.
- 같음(true): 요구하는 핵심 행동이 같다. 표현·언어가 달라도, 한쪽이 더 일반적인 지시이고 다른 쪽이 그 구체적인 경우여도 같음.
- 다름(false): 주제(영역·도구·기능)만 겹치고 요구하는 행동이 다르거나, 서로 반대이거나, 한쪽을 지켜도 다른 쪽 문제가 그대로 남는다.
출력은 쌍마다 한 줄 JSON 만, 다른 말 없이:
{"id":"<id>","same":true|false}`;

export interface CorrectionVerdict { correction: boolean; gist: string; task_specific: boolean }
export type PairVerdict = 'same' | 'different' | 'split';

export interface JudgeOptions {
  /** false 면 모델을 부르지 않는다(캐시만 읽음). */
  model?: boolean;
  concurrency?: number;
  batchSize?: number;
  timeoutMs?: number;
  cacheDir?: string;
}

export interface JudgeStats { calls: number; failedCalls: number; cacheHits: number; judged: number; unjudged: number; ms: number; lastError?: string; stopped?: string }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** 보내기 전 정리: <private> 구간 제거, 비밀키 가림, 길이 자르기. */
export function prepareText(s: string, max: number): string {
  const noPrivate = s.replace(/<private>[\s\S]*?<\/private>/gi, '[private]');
  return redactSecrets(noPrivate).redacted.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function cacheDirDefault(): string { return path.join(FORGEN_HOME, 'audit', 'cache'); }

/** (판본, 판정자)마다 JSONL 한 파일: {"k":<입력 해시>,"v":<판정>}. 같은 키는 처음 것을 쓴다. */
export class JudgeCache {
  private maps = new Map<string, Map<string, unknown>>();
  constructor(readonly dir = cacheDirDefault()) {}
  private file(version: string): string { return path.join(this.dir, `${version.replace(/[^A-Za-z0-9._-]/g, '_')}__${JUDGE_MODEL}.jsonl`); }
  private map(version: string): Map<string, unknown> {
    let m = this.maps.get(version);
    if (m) return m;
    m = new Map();
    try {
      for (const line of fs.readFileSync(this.file(version), 'utf-8').split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line) as { k: string; v: unknown }; if (r.k && !m.has(r.k)) m.set(r.k, r.v); } catch { /* 깨진 줄 */ }
      }
    } catch { /* 없음 */ }
    this.maps.set(version, m);
    return m;
  }
  get<T>(version: string, key: string): T | undefined { return this.map(version).get(key) as T | undefined; }
  put(version: string, key: string, v: unknown): void {
    const m = this.map(version);
    if (m.has(key)) return;
    m.set(key, v);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file(version), `${JSON.stringify({ k: key, v })}\n`, { mode: 0o600 });
    } catch { /* 캐시 쓰기 실패는 다음 실행이 다시 부를 뿐 */ }
  }
}

export function correctionKey(utter: string, prev: string): string { return sha(`${CORRECTION_PROMPT_VERSION}\0${JUDGE_MODEL}\0${utter}\0${prev}`); }
export function pairKey(a: string, b: string): string { return sha(`${PAIR_PROMPT_VERSION}\0${JUDGE_MODEL}\0${a}\0${b}`); }

interface CallResult { ok: boolean; output: string; reason?: string; fatal?: boolean }

function callClaude(prompt: string, timeoutMs: number): Promise<CallResult> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: CallResult) => { if (!done) { done = true; resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('claude', ['-p', '--model', JUDGE_MODEL, ...NESTED_ISOLATION_ARGS], { env: { ...process.env, ...NESTED_RUN_ENV }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      const c = classifyFailure({ code: (e as NodeJS.ErrnoException).code, message: String(e) });
      finish({ ok: false, output: '', reason: c.reason, fatal: c.outcome === 'unavailable' });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* 이미 끝남 */ } finish({ ok: false, output: '', reason: `타임아웃 ${Math.round(timeoutMs / 1000)}s` }); }, timeoutMs);
    child.stdout?.on('data', (c) => { out += String(c); });
    child.stderr?.on('data', (c) => { err += String(c); });
    child.on('error', (e) => {
      clearTimeout(timer);
      const c = classifyFailure({ code: (e as NodeJS.ErrnoException).code, message: e.message, stderr: err });
      finish({ ok: false, output: '', reason: c.reason, fatal: c.outcome === 'unavailable' });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) { finish({ ok: true, output: out }); return; }
      const c = classifyFailure({ signal, stderr: err, stdout: out, message: code === 0 ? '빈 응답' : `exit ${code}` });
      finish({ ok: false, output: '', reason: c.reason, fatal: c.outcome === 'unavailable' });
    });
    child.stdin?.on('error', () => { /* 옵션을 거절한 CLI 가 먼저 끝나면 EPIPE — close 에서 판정 */ });
    child.stdin?.end(prompt);
  });
}

/** 출력에서 {"id":…} 객체를 모은다 — 코드 울타리·앞뒤 말·JSON 배열·문자열 안의 괄호도 견딘다. 같은 id 는 첫 것. */
export function parseJsonLines(output: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < output.length; i++) {
    const ch = output[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch !== '}' || depth === 0) continue;
    depth--;
    if (depth > 0 || start < 0) continue;
    try {
      const o = JSON.parse(output.slice(start, i + 1)) as Record<string, unknown>;
      if (o && typeof o.id === 'string' && !out.has(o.id)) out.set(o.id, o);
    } catch { /* 깨진 객체 */ }
    start = -1;
  }
  return out;
}

async function pool<T>(tasks: Array<() => Promise<T>>, n: number): Promise<T[]> {
  const res: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => { while (next < tasks.length) { const i = next++; res[i] = await tasks[i](); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, tasks.length)) }, worker));
  return res;
}

export class Judge {
  readonly stats: JudgeStats = { calls: 0, failedCalls: 0, cacheHits: 0, judged: 0, unjudged: 0, ms: 0 };
  readonly cache: JudgeCache;
  private readonly model: boolean;
  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;

  constructor(opts: JudgeOptions = {}) {
    this.model = opts.model !== false;
    this.concurrency = opts.concurrency ?? (Number(process.env.FORGEN_AUDIT_CONCURRENCY) || 4);
    this.batchSize = opts.batchSize ?? 20;
    this.timeoutMs = opts.timeoutMs ?? (Number(process.env.FORGEN_AUDIT_TIMEOUT_MS) || 180_000);
    this.cache = new JudgeCache(opts.cacheDir);
  }

  get modelEnabled(): boolean { return this.model; }

  /** 한 묶음 호출: 항목을 i0,i1… 로 적어 보내고 돌아온 줄을 항목에 맞춘다. 빠진 항목은 한 번 더(작게) 묻는다. */
  private async batch(header: string, blocks: string[], parse: (o: Record<string, unknown>) => unknown): Promise<Array<unknown | undefined>> {
    const out: Array<unknown | undefined> = new Array(blocks.length).fill(undefined);
    const ask = async (idx: number[]) => {
      if (this.stats.stopped || !idx.length) return;
      const prompt = `${header}\n\n${idx.map((i, j) => `### i${j}\n${blocks[i]}`).join('\n\n')}\n`;
      const t0 = Date.now();
      this.stats.calls++;
      const r = await callClaude(prompt, this.timeoutMs);
      this.stats.ms += Date.now() - t0;
      if (!r.ok) {
        this.stats.failedCalls++;
        this.stats.lastError = r.reason;
        if (r.fatal) this.stats.stopped = r.reason;
        return;
      }
      const got = parseJsonLines(r.output);
      idx.forEach((i, j) => { const o = got.get(`i${j}`); if (o) { const v = parse(o); if (v !== undefined) out[i] = v; } });
    };
    const all = blocks.map((_, i) => i);
    await ask(all);
    await ask(all.filter((i) => out[i] === undefined));
    return out;
  }

  /** 교정 판정. 결과 null = 판정 못 함(모델 꺼짐이면서 캐시 없음, 호출 실패). */
  async corrections(items: Array<{ id: string; utter: string; prev: string }>): Promise<Map<string, CorrectionVerdict | null>> {
    const res = new Map<string, CorrectionVerdict | null>();
    const todo: Array<{ id: string; key: string; utter: string; prev: string }> = [];
    for (const it of items) {
      const utter = prepareText(it.utter, UTTER_MAX);
      const prev = prepareText(it.prev, PREV_MAX);
      const key = correctionKey(utter, prev);
      const hit = this.cache.get<CorrectionVerdict>(CORRECTION_PROMPT_VERSION, key);
      if (hit) { this.stats.cacheHits++; res.set(it.id, hit); continue; }
      if (!this.model) { res.set(it.id, null); continue; }
      todo.push({ id: it.id, key, utter, prev });
    }
    const chunks: typeof todo[] = [];
    for (let i = 0; i < todo.length; i += this.batchSize) chunks.push(todo.slice(i, i + this.batchSize));
    await pool(chunks.map((chunk) => async () => {
      const verdicts = await this.batch(CORRECTION_PROMPT, chunk.map((c) => `AI: ${c.prev || '(없음)'}\nUSER: ${c.utter}`), (o) => (typeof o.correction === 'boolean'
        ? { correction: o.correction, gist: o.correction ? String(o.gist ?? '').slice(0, 200) : '', task_specific: o.task_specific === true } : undefined));
      chunk.forEach((c, j) => { const v = verdicts[j] as CorrectionVerdict | undefined; if (v) this.cache.put(CORRECTION_PROMPT_VERSION, c.key, v); });
    }), this.concurrency);
    // 같은 입력이 한 번에 여러 개면 캐시의 첫 판정으로 맞춘다 — 같은 실행 안에서도, 캐시 뒤 다시 돌려도 같은 결과.
    for (const c of todo) res.set(c.id, this.cache.get<CorrectionVerdict>(CORRECTION_PROMPT_VERSION, c.key) ?? null);
    for (const v of res.values()) { if (v) this.stats.judged++; else this.stats.unjudged++; }
    return res;
  }

  /** 쌍 판정: (A,B)·(B,A) 를 다른 호출로 묻고 둘 다 같으면 same, 둘 다 아니면 different, 엇갈리면 split. 못 물으면 null. */
  async pairs(items: Array<{ id: string; a: string; b: string }>): Promise<Map<string, PairVerdict | null>> {
    type Dir = { pair: string; dir: 0 | 1; key: string; a: string; b: string };
    const dirs: Dir[] = [];
    const asked = new Set<string>();
    const keysOf = new Map<string, [string, string]>();
    const got = new Map<string, Array<boolean | undefined>>();
    for (const it of items) {
      const a = prepareText(it.a, PAIR_TEXT_MAX);
      const b = prepareText(it.b, PAIR_TEXT_MAX);
      const pair: Array<boolean | undefined> = [undefined, undefined];
      got.set(it.id, pair);
      keysOf.set(it.id, [pairKey(a, b), pairKey(b, a)]);
      ([[a, b], [b, a]] as const).forEach(([x, y], d) => {
        const key = pairKey(x, y);
        const hit = this.cache.get<boolean>(PAIR_PROMPT_VERSION, key);
        if (hit !== undefined) { this.stats.cacheHits++; pair[d] = hit; } else if (this.model && !asked.has(key)) { asked.add(key); dirs.push({ pair: it.id, dir: d as 0 | 1, key, a: x, b: y }); }
      });
    }
    // 정방향 묶음과 역방향 묶음을 따로 보낸다 — 같은 호출 안에서 앞 답을 베끼지 않게.
    const chunks: Dir[][] = [];
    for (const d of [0, 1] as const) {
      const list = dirs.filter((x) => x.dir === d);
      for (let i = 0; i < list.length; i += this.batchSize) chunks.push(list.slice(i, i + this.batchSize));
    }
    await pool(chunks.map((chunk) => async () => {
      const verdicts = await this.batch(PAIR_PROMPT, chunk.map((c) => `A: ${c.a}\nB: ${c.b}`), (o) => (typeof o.same === 'boolean' ? o.same : undefined));
      chunk.forEach((c, j) => {
        const v = verdicts[j] as boolean | undefined;
        if (v !== undefined) this.cache.put(PAIR_PROMPT_VERSION, c.key, v);
      });
    }), this.concurrency);
    // 같은 방향 쌍이 여러 항목에 걸쳐 있어도 한 번만 묻고, 캐시의 첫 판정으로 모두 맞춘다.
    for (const [id, keys] of keysOf) {
      const pair = got.get(id) as Array<boolean | undefined>;
      keys.forEach((k, d) => { pair[d] ??= this.cache.get<boolean>(PAIR_PROMPT_VERSION, k); });
    }
    const res = new Map<string, PairVerdict | null>();
    for (const [id, [x, y]] of got) {
      const v: PairVerdict | null = x === undefined || y === undefined ? null : x && y ? 'same' : !x && !y ? 'different' : 'split';
      res.set(id, v);
      if (v) this.stats.judged++; else this.stats.unjudged++;
    }
    return res;
  }
}

/** 첫 실행 공개(§2.4 표). 모델을 쓰는 감사를 처음 돌릴 때 한 번 보여 준다. */
export const MODEL_DISCLOSURE = [
  '[forgen] 감사에 모델 판정을 씁니다 — 처음 한 번만 보이는 안내 (끄기: --no-model)',
  '  쓰는 곳              보내는 것                                         모델              끄면',
  `  교정 판정(N4)        사용자 발화 1개(≤ ${UTTER_MAX}자) + 직전 AI 응답 앞 ${PREV_MAX}자          ${JUDGE_MODEL}  N4 를 내지 않고 "모델 판정 꺼짐"`,
  `  같은 뜻 판정(N4)     지시 문장 2개(각 ≤ ${PAIR_TEXT_MAX}자), 순서를 바꿔 두 번                 ${JUDGE_MODEL}  결정적 검사만 남음`,
  '  보내는 곳은 내가 이미 쓰는 로컬 `claude` CLI 뿐입니다(forgen 서버·제3자 없음). 대화 전체·파일 전체는 보내지 않고, 비밀키는 가리며 <private> 구간은 뺍니다.',
  '  판정 결과는 ~/.forgen/audit/cache/ 에 캐시되어 같은 입력은 다시 보내지 않습니다.',
].join('\n');

/** 공개를 이미 보였는가 — <FORGEN_HOME>/audit/model-notice.json. 보이지 않았으면 표시하고 기록한다. */
export function takeModelDisclosure(now = new Date()): string | null {
  const p = path.join(FORGEN_HOME, 'audit', 'model-notice.json');
  try { if (fs.existsSync(p)) return null; } catch { return null; }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify({ shownAt: now.toISOString(), model: JUDGE_MODEL, versions: [CORRECTION_PROMPT_VERSION, PAIR_PROMPT_VERSION] }), { mode: 0o600 });
  } catch { /* 기록 실패면 다음에 또 보인다 */ }
  return MODEL_DISCLOSURE;
}
