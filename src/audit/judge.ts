/**
 * 감사 모델 판정기 (docs/plans/2026-11-25-v1.0-plan.md §2.1·§2.4·§4.2).
 *
 * - 보내는 곳: 사용자가 이미 쓰는 로컬 `claude` CLI 뿐. 호출 방식은 세션 학습 추출(extraction-haiku)과 같다 —
 *   격리 옵션(도구·MCP·설정·슬래시 명령 없음, 세션 저장 안 함), 프롬프트는 stdin, 중첩 실행 표시 환경변수.
 * - 판정자 두 단계, **모델 ID 고정**(별칭이 가리키는 모델이 바뀌면 같은 입력이 다른 판정을 받으므로):
 *     교정 판정 = Haiku(후보 전부라 많음) · 쌍 판정 = Sonnet 1회 비대칭(오너 결정 2026-11-25, 결정적 사전 필터를 지난 쌍만)
 * - 판정 프롬프트는 **사전 등록**: 아래 상수와 판본이 정본이고, 문장을 바꾸면 판본을 올린다(캐시 키·manifest 에 들어감).
 * - 결과는 (입력 해시, 판정자, 판본) 키로 <FORGEN_HOME>/audit/cache/ 에 캐시한다 → 캐시가 있으면 같은 입력은 같은 판정.
 * - 보내는 양: 교정 판정은 발화 ≤ 500자 + 직전 AI 응답 앞 300자, 쌍 판정은 교정 요지 한 줄(≤ 200자) + 기억 문장 ≤ 400자.
 *   비밀키는 가리고 <private> 구간은 뺀다.
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

/** 교정 판정자 — 2026-11-25 `claude -p --model haiku` 가 가리킨 모델. */
export const CORRECTION_MODEL = 'claude-haiku-5-5';
/** 쌍 판정자 — 2026-11-25 `claude -p --model sonnet` 이 가리킨 모델. */
export const PAIR_MODEL = 'claude-sonnet-5-5';
export const UTTER_MAX = 500;
export const PREV_MAX = 300;
export const GIST_MAX = 200;
export const PAIR_TEXT_MAX = 400;

export const CORRECTION_PROMPT_VERSION = 'n4-correction/2';
/**
 * 사전 등록 — 교정 판정(§4.2-2). 바꾸면 CORRECTION_PROMPT_VERSION 을 올린다.
 * 판본 2: task_specific 을 좁혔다. 판본 1 은 실데이터 표본 교정 51개 중 43개를 "이 작업 전용"으로 냈고, 그중에도 적혀 있던 기억과
 * 같은 뜻인 것(확인 전에 단정하지 말 것 등)이 2개 있었다. task_specific 이면 쌍 판정에 보내지 않으므로 일반화할 수 있으면 false 로 둔다.
 */
export const CORRECTION_PROMPT = `너는 대화 기록 감사의 판정자다. 아래 항목마다 (직전 AI 응답 앞부분, 그 뒤 사용자 발화)가 있다.
사용자 발화가 직전 AI 의 행동·결과·방식을 고치라는 **교정**인지 판정하라.
- 교정: AI 가 한 일·말한 방식·고른 방법이 틀렸거나 원치 않았다고 지적하고 다르게 하라고 하는 것(하지 마라, 그게 아니라, 왜 ~했냐, 다시 해라 등).
- 교정 아님: 새 요청, 질문, 승인·진행 지시, 정보 제공, 칭찬, 다음 단계 지시.
교정이면 gist 에 "고칠 행동과 방향"을 다른 작업에도 통하는 말로 한 줄 적는다(예: "확인 없이 배포하지 말고 먼저 물어볼 것"). 교정이 아니면 gist 는 "".
task_specific: 이 결과물의 내용(이 화면의 문구·이 값·이 파일·이 일정)만 고치라는 것이고, 거기서 다른 작업에 다시 쓸 행동 지시(확인 먼저, 단정 금지, 끝까지 진행, 언어·말투, 범위 지키기 등)를 하나도 뽑을 수 없을 때만 true. 조금이라도 일반화할 수 있으면 false.
출력은 항목마다 한 줄 JSON 만, 다른 말 없이:
{"id":"<id>","correction":true|false,"gist":"…","task_specific":true|false}`;

export const PAIR_PROMPT_VERSION = 'n4-pair/3';
/**
 * 사전 등록 — 쌍 판정(§4.2-3, 오너 결정 2026-11-25). Sonnet 1회, 비대칭 질문, 답은 예/아니오/모름.
 * 판본 1·2(Haiku, 순서 바꿔 두 번)는 일반 룰 ↔ 구체 교정에서 순서에 따라 답이 갈렸다(실데이터 표본에서 갈린 쌍 21~26).
 * 질문 자체가 비대칭(기억이 교정을 덮었는가)이므로 한 방향으로만 묻고, 판정자가 확신하지 못하면 "모름"으로 둔다. "모름"은 세지 않는다.
 */
export const PAIR_PROMPT = `너는 기억 감사의 판정자다. 아래 쌍마다 "교정"(사용자가 AI 에게 한 교정의 요지)과 "기억"(그 교정 시점에 이미 있던 룰·메모·지침, 또는 그보다 앞선 다른 교정)이 있다.
질문: 이 교정이 고치려는 행동을, 이 기억이 그 시점에 이미 지시하고 있었나?
- yes: 기억을 AI 가 지켰다면 이 교정은 필요 없었다. 기억이 더 일반적인 지시이고 교정이 그 구체적인 경우여도 yes.
- no: 주제(영역·도구·기능)만 겹치고 요구하는 행동이 다르거나, 기억을 지켜도 이 교정의 문제가 그대로 남는다.
- unknown: 문장만으로는 판단할 수 없다(뜻이 모호하거나 맥락이 더 필요함).
출력은 쌍마다 한 줄 JSON 만, 다른 말 없이:
{"id":"<id>","answer":"yes"|"no"|"unknown"}`;

export interface CorrectionVerdict { correction: boolean; gist: string; task_specific: boolean }
export type PairVerdict = 'yes' | 'no' | 'unknown';

export interface JudgeOptions {
  /** false 면 모델을 부르지 않는다(캐시만 읽음). */
  model?: boolean;
  concurrency?: number;
  batchSize?: number;
  timeoutMs?: number;
  cacheDir?: string;
}

export interface JudgeStats { calls: number; failedCalls: number; cacheHits: number; judged: number; unjudged: number; ms: number; byModel: Record<string, number>; lastError?: string; stopped?: string }

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
  private file(version: string, model: string): string { return path.join(this.dir, `${version.replace(/[^A-Za-z0-9._-]/g, '_')}__${model}.jsonl`); }
  private map(version: string, model: string): Map<string, unknown> {
    const id = `${version}\0${model}`;
    let m = this.maps.get(id);
    if (m) return m;
    m = new Map();
    try {
      for (const line of fs.readFileSync(this.file(version, model), 'utf-8').split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line) as { k: string; v: unknown }; if (r.k && !m.has(r.k)) m.set(r.k, r.v); } catch { /* 깨진 줄 */ }
      }
    } catch { /* 없음 */ }
    this.maps.set(id, m);
    return m;
  }
  get<T>(version: string, model: string, key: string): T | undefined { return this.map(version, model).get(key) as T | undefined; }
  put(version: string, model: string, key: string, v: unknown): void {
    const m = this.map(version, model);
    if (m.has(key)) return;
    m.set(key, v);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file(version, model), `${JSON.stringify({ k: key, v })}\n`, { mode: 0o600 });
    } catch { /* 캐시 쓰기 실패는 다음 실행이 다시 부를 뿐 */ }
  }
}

export function correctionKey(utter: string, prev: string): string { return sha(`${CORRECTION_PROMPT_VERSION}\0${CORRECTION_MODEL}\0${utter}\0${prev}`); }
export function pairKey(gist: string, memory: string): string { return sha(`${PAIR_PROMPT_VERSION}\0${PAIR_MODEL}\0${gist}\0${memory}`); }

interface CallResult { ok: boolean; output: string; reason?: string; fatal?: boolean }

function callClaude(prompt: string, timeoutMs: number, model: string): Promise<CallResult> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: CallResult) => { if (!done) { done = true; resolve(r); } };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('claude', ['-p', '--model', model, ...NESTED_ISOLATION_ARGS], { env: { ...process.env, ...NESTED_RUN_ENV }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  readonly stats: JudgeStats = { calls: 0, failedCalls: 0, cacheHits: 0, judged: 0, unjudged: 0, ms: 0, byModel: {} };
  readonly cache: JudgeCache;
  private readonly model: boolean;
  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;

  constructor(opts: JudgeOptions = {}) {
    this.model = opts.model !== false;
    // 동시 호출 6: 실데이터 표본에서 4 → 6 으로 올려도 실패 0(구독 한도 안), 그 이상은 한도·과부하 위험만 늘어난다.
    this.concurrency = opts.concurrency ?? (Number(process.env.FORGEN_AUDIT_CONCURRENCY) || 6);
    this.batchSize = opts.batchSize ?? 20;
    this.timeoutMs = opts.timeoutMs ?? (Number(process.env.FORGEN_AUDIT_TIMEOUT_MS) || 180_000);
    this.cache = new JudgeCache(opts.cacheDir);
  }

  get modelEnabled(): boolean { return this.model; }

  /** 한 묶음 호출: 항목을 i0,i1… 로 적어 보내고 돌아온 줄을 항목에 맞춘다. 빠진 항목은 한 번 더 묻는다. */
  private async batch(model: string, header: string, blocks: string[], parse: (o: Record<string, unknown>) => unknown): Promise<Array<unknown | undefined>> {
    const out: Array<unknown | undefined> = new Array(blocks.length).fill(undefined);
    const ask = async (idx: number[]) => {
      if (this.stats.stopped || !idx.length) return;
      const prompt = `${header}\n\n${idx.map((i, j) => `### i${j}\n${blocks[i]}`).join('\n\n')}\n`;
      const t0 = Date.now();
      this.stats.calls++;
      this.stats.byModel[model] = (this.stats.byModel[model] ?? 0) + 1;
      const r = await callClaude(prompt, this.timeoutMs, model);
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

  /** 같은 입력은 한 번만 묻고, 결과는 캐시의 첫 판정으로 맞춘다 — 같은 실행 안에서도, 캐시 뒤 다시 돌려도 같은 결과. */
  private async run<I, V>(o: {
    version: string; model: string; header: string; items: Array<{ id: string; key: string; input: I }>;
    block: (i: I) => string; parse: (r: Record<string, unknown>) => V | undefined;
  }): Promise<Map<string, V | null>> {
    const todo: Array<{ key: string; input: I }> = [];
    const asked = new Set<string>();
    for (const it of o.items) {
      if (this.cache.get(o.version, o.model, it.key) !== undefined) { this.stats.cacheHits++; continue; }
      if (this.model && !asked.has(it.key)) { asked.add(it.key); todo.push({ key: it.key, input: it.input }); }
    }
    const chunks: typeof todo[] = [];
    for (let i = 0; i < todo.length; i += this.batchSize) chunks.push(todo.slice(i, i + this.batchSize));
    await pool(chunks.map((chunk) => async () => {
      const verdicts = await this.batch(o.model, o.header, chunk.map((c) => o.block(c.input)), o.parse);
      chunk.forEach((c, j) => { if (verdicts[j] !== undefined) this.cache.put(o.version, o.model, c.key, verdicts[j]); });
    }), this.concurrency);
    const res = new Map<string, V | null>();
    for (const it of o.items) {
      const v = this.cache.get<V>(o.version, o.model, it.key) ?? null;
      res.set(it.id, v);
      if (v !== null) this.stats.judged++; else this.stats.unjudged++;
    }
    return res;
  }

  /** 교정 판정(Haiku). 결과 null = 판정 못 함(모델 꺼짐이면서 캐시 없음, 호출 실패). */
  corrections(items: Array<{ id: string; utter: string; prev: string }>): Promise<Map<string, CorrectionVerdict | null>> {
    return this.run<{ utter: string; prev: string }, CorrectionVerdict>({
      version: CORRECTION_PROMPT_VERSION, model: CORRECTION_MODEL, header: CORRECTION_PROMPT,
      items: items.map((it) => {
        const utter = prepareText(it.utter, UTTER_MAX);
        const prev = prepareText(it.prev, PREV_MAX);
        return { id: it.id, key: correctionKey(utter, prev), input: { utter, prev } };
      }),
      block: (c) => `AI: ${c.prev || '(없음)'}\nUSER: ${c.utter}`,
      parse: (r) => (typeof r.correction === 'boolean'
        ? { correction: r.correction, gist: r.correction ? String(r.gist ?? '').slice(0, GIST_MAX) : '', task_specific: r.task_specific === true } : undefined),
    });
  }

  /** 쌍 판정(Sonnet 1회, 비대칭): 이 교정이 고치려는 행동을 이 기억이 이미 지시했나 — yes/no/unknown, 못 물으면 null. */
  pairs(items: Array<{ id: string; gist: string; memory: string }>): Promise<Map<string, PairVerdict | null>> {
    return this.run<{ gist: string; memory: string }, PairVerdict>({
      version: PAIR_PROMPT_VERSION, model: PAIR_MODEL, header: PAIR_PROMPT,
      items: items.map((it) => {
        const gist = prepareText(it.gist, GIST_MAX);
        const memory = prepareText(it.memory, PAIR_TEXT_MAX);
        return { id: it.id, key: pairKey(gist, memory), input: { gist, memory } };
      }),
      block: (c) => `교정: ${c.gist}\n기억: ${c.memory}`,
      parse: (r) => (r.answer === 'yes' || r.answer === 'no' || r.answer === 'unknown' ? r.answer : undefined),
    });
  }
}

/** 첫 실행 공개(§2.4 표). 모델을 쓰는 감사를 처음 돌릴 때(판정자가 바뀌면 다시) 한 번 보여 준다. */
export const MODEL_DISCLOSURE = [
  '[forgen] 감사에 모델 판정을 씁니다 — 처음 한 번만 보이는 안내 (끄기: --no-model)',
  '  쓰는 곳              보내는 것                                                          모델               끄면',
  `  교정 판정(N4)        사용자 발화 1개(≤ ${UTTER_MAX}자) + 직전 AI 응답 앞 ${PREV_MAX}자                           ${CORRECTION_MODEL}   N4 를 내지 않고 "모델 판정 꺼짐"`,
  `  쌍 판정(N4·원장)     교정 요지 한 줄(≤ ${GIST_MAX}자) + 기억 문장(≤ ${PAIR_TEXT_MAX}자) — 사전 필터를 지난 쌍만, 쌍마다 1회   ${PAIR_MODEL}  결정적 검사만 남음`,
  '  보내는 곳은 내가 이미 쓰는 로컬 `claude` CLI 뿐입니다(forgen 서버·제3자 없음). 대화 전체·파일 전체는 보내지 않고, 비밀키는 가리며 <private> 구간은 뺍니다.',
  '  판정 결과는 ~/.forgen/audit/cache/ 에 캐시되어 같은 입력은 다시 보내지 않습니다.',
].join('\n');

/** 공개를 이미 보였는가 — <FORGEN_HOME>/audit/model-notice.json. 이번 판정자 구성으로 보이지 않았으면 표시하고 기록한다. */
export function takeModelDisclosure(now = new Date()): string | null {
  const p = path.join(FORGEN_HOME, 'audit', 'model-notice.json');
  try {
    const prev = JSON.parse(fs.readFileSync(p, 'utf-8')) as { pairModel?: string };
    if (prev.pairModel === PAIR_MODEL) return null;
  } catch { /* 처음 */ }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, JSON.stringify({ shownAt: now.toISOString(), correctionModel: CORRECTION_MODEL, pairModel: PAIR_MODEL, versions: [CORRECTION_PROMPT_VERSION, PAIR_PROMPT_VERSION] }), { mode: 0o600 });
  } catch { /* 기록 실패면 다음에 또 보인다 */ }
  return MODEL_DISCLOSURE;
}
