/**
 * Block judge — 차단 영수증 자동 판정 (ADR-017 D1, 오너 결정 "안 누를 것 같다 → 자동으로")
 *
 * 차단 직후 background 로 Haiku 에게 영수증(룰 policy + 출처 교정 + 매칭 프래그먼트 + 전후 문맥)을
 * 보여 주고 `{verdict: correct|false_positive|unsure, reason}` 을 받아 verdicts.jsonl 에 by:'auto' 로
 * 기록한다. 사용자 판정(`forgen block <id> --ok|--fp`)은 자동 판정을 덮어쓴다.
 *
 * 안전장치:
 *   - auto-compound 와 같은 consent(ADR-012, compound-consent) — 동의 없으면 아무것도 보내지 않는다.
 *   - 같은 execHost 경로 + FORGEN_NESTED_RUN 재귀 가드.
 *   - 비용 상한: 세션당 10건, 일 30건 (verdicts.jsonl 의 by:'auto' 기준).
 *   - 심판 실패·타임아웃·파싱 실패 → 'unsure'(미판정) 로 남긴다. 거짓 확신 금지.
 *   - precision 강등(enforce_mode:'advise')은 **하드 룰(strength 'hard')·builtin 에 적용하지 않는다**.
 *     그 외 룰은 7d 판정 ≥ 5 이고 precision < 0.5 이면 advise 로 강등하고 알린다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { STATE_DIR } from '../core/paths.js';
import {
  readJsonlSafe, readReceipt, readVerdicts, setVerdict, precisionByRule,
} from './lifecycle/signals.js';
import type { ViolationEntry, Verdict } from './lifecycle/types.js';
import { loadRule, saveRule } from '../store/rule-store.js';
import { originLine } from '../store/rule-origin.js';
import { isHaikuCompoundEnabled } from '../core/compound-consent.js';

export const JUDGE_MODEL = 'haiku';
export const JUDGE_CAP_PER_SESSION = 10;
export const JUDGE_CAP_PER_DAY = 30;
export const DEMOTE_MIN_JUDGED = 5;
export const DEMOTE_PRECISION_BELOW = 0.5;

const VIOLATIONS_PATH = path.join(STATE_DIR, 'enforcement', 'violations.jsonl');

export interface JudgeInput {
  violation: ViolationEntry;
  rulePolicy: string;
  originLine: string;
  receipt: string;
}

export interface JudgeOutput {
  verdict: Verdict;
  reason: string;
}

/** 영수증을 심판 프롬프트로. 전문은 2,000자로 자르고 매칭 프래그먼트 주변을 우선 보여준다. */
export function buildJudgePrompt(input: JudgeInput): string {
  const { violation: v, rulePolicy, originLine: origin, receipt } = input;
  const excerpt = excerptAround(receipt, v.matched ?? '', 2000);
  const kindKo = v.kind === 'deny' ? '도구 실행 차단(PreToolUse)' : '응답 차단(Stop)';
  return [
    '당신은 코딩 에이전트 가드레일의 오탐 심판입니다. 아래 차단이 룰의 **의도**에 비추어 정당한지 판정하세요.',
    '판정 기준: 룰이 막으려던 실제 위험/위반이 대상에 있으면 correct. 룰의 문자 패턴에는 걸렸지만 의도상 무해',
    '(예: 명령을 설명하는 평문, 자기 임시 폴더 정리, 인용/문서 안의 문자열)면 false_positive. 확신이 없으면 unsure.',
    '',
    `## 룰\n${rulePolicy}`,
    origin ? `\n## 룰의 출처\n${origin}` : '',
    `\n## 차단 종류\n${kindKo} — 매칭 프래그먼트: ${v.matched ?? '(없음)'}`,
    `\n## 차단된 대상 (${v.target_kind ?? 'unknown'}, 비밀값 마스킹됨)\n\`\`\`\n${excerpt}\n\`\`\``,
    '',
    '반드시 아래 JSON 한 줄만 출력하세요. 다른 텍스트 금지.',
    '{"verdict":"correct"|"false_positive"|"unsure","reason":"<한국어 한 문장>"}',
  ].filter((l) => l !== '').join('\n');
}

export function excerptAround(text: string, matched: string, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  const core = matched.replace(/…$/, '').slice(0, 60);
  const idx = core ? text.indexOf(core) : -1;
  if (idx < 0) return `${text.slice(0, maxLen)}\n…(이하 생략)`;
  const start = Math.max(0, idx - Math.floor(maxLen / 2));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + maxLen)}${start + maxLen < text.length ? '…' : ''}`;
}

/** 모델 출력 파싱 — JSON 한 줄을 찾는다. 실패하면 unsure. */
export function parseJudgeOutput(raw: string): JudgeOutput {
  try {
    const m = raw.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/);
    if (!m) return { verdict: 'unsure', reason: 'judge output unparsable' };
    const o = JSON.parse(m[0]) as { verdict?: unknown; reason?: unknown };
    const v = o.verdict === 'correct' || o.verdict === 'false_positive' || o.verdict === 'unsure' ? o.verdict : 'unsure';
    const reason = typeof o.reason === 'string' ? o.reason.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    return { verdict: v, reason };
  } catch {
    return { verdict: 'unsure', reason: 'judge output unparsable' };
  }
}

/** 비용 상한 확인 — by:'auto' 판정 수 기준. */
export function withinJudgeCaps(sessionId: string, now: number = Date.now(), verdicts = readVerdicts(), violations?: ViolationEntry[]): boolean {
  const dayCutoff = now - 24 * 3600 * 1000;
  const auto = verdicts.filter((v) => v.by === 'auto');
  const today = auto.filter((v) => Date.parse(v.at) >= dayCutoff).length;
  if (today >= JUDGE_CAP_PER_DAY) return false;
  const vio = violations ?? readJsonlSafe<ViolationEntry>(VIOLATIONS_PATH);
  const sessionIds = new Set(vio.filter((v) => v.session_id === sessionId && v.violation_id).map((v) => v.violation_id as string));
  const thisSession = auto.filter((v) => sessionIds.has(v.violation_id)).length;
  return thisSession < JUDGE_CAP_PER_SESSION;
}

export function findViolation(violationId: string): ViolationEntry | null {
  const all = readJsonlSafe<ViolationEntry>(VIOLATIONS_PATH);
  for (let i = all.length - 1; i >= 0; i--) if (all[i].violation_id === violationId) return all[i];
  return null;
}

/**
 * 한 건 판정 (동기, 호출자는 detached 프로세스). consent·캡 확인 → 프롬프트 → execHost(haiku) → 기록.
 * 반환: 기록된 verdict 또는 null(스킵).
 */
export async function judgeViolation(violationId: string, deps: {
  exec?: (prompt: string) => Promise<string>;
  consent?: () => boolean;
  now?: number;
} = {}): Promise<Verdict | null> {
  const v = findViolation(violationId);
  if (!v || !(v.kind === 'block' || v.kind === 'deny')) return null;
  const consent = deps.consent ?? isHaikuCompoundEnabled;
  if (!consent()) return null;
  if (!withinJudgeCaps(v.session_id, deps.now)) return null;
  const receipt = readReceipt(violationId) ?? v.message_preview ?? '';
  const rule = v.rule_id.startsWith('builtin:') ? null : loadRule(v.rule_id);
  const rulePolicy = rule?.policy ?? builtinPolicy(v.rule_id);
  const origin = rule ? originLine(rule) : '';
  const prompt = buildJudgePrompt({ violation: v, rulePolicy, originLine: origin, receipt });
  const exec = deps.exec ?? defaultExec;
  let out: JudgeOutput;
  try {
    out = parseJudgeOutput(await exec(prompt));
  } catch (e) {
    out = { verdict: 'unsure', reason: `judge failed: ${(e as Error).message.slice(0, 80)}` };
  }
  setVerdict({ violation_id: violationId, rule_id: v.rule_id, verdict: out.verdict, by: 'auto', reason: out.reason });
  if (out.verdict !== 'unsure' && rule) maybeDemote(rule.rule_id, deps.now);
  return out.verdict;
}

function builtinPolicy(ruleId: string): string {
  if (ruleId === 'builtin:dangerous-response-pattern') return '응답이 파괴적 명령(rm -rf, git push --force 등)을 사용자 확인 없이 실행하라고 제안하면 안 된다. 명령을 설명·인용만 하는 평문은 위반이 아니다.';
  if (ruleId === 'builtin:conclusion-ratio') return '검증 없이 결론만 나열하는 응답 금지(결론/검증 비율).';
  if (ruleId === 'builtin:self-score-inflation') return '측정 없이 스스로 점수를 매기는 응답 금지.';
  return ruleId;
}

async function defaultExec(prompt: string): Promise<string> {
  const { execHost } = await import('../host/exec-host.js');
  const r = execHost({ prompt, model: JUDGE_MODEL, host: 'claude', timeout: 30_000 });
  return r.message;
}

/**
 * precision 강등: 7d 판정 ≥ DEMOTE_MIN_JUDGED 이고 precision < DEMOTE_PRECISION_BELOW 이면 enforce_mode='advise'.
 * 하드 룰·builtin 제외(ADR-017 D1). 이미 advise 면 no-op. 복귀는 사용자 명시(`forgen rule <id> --enforce`).
 */
export function maybeDemote(ruleId: string, now: number = Date.now()): boolean {
  const rule = loadRule(ruleId);
  if (!rule || rule.strength === 'hard' || rule.enforce_mode === 'advise') return false;
  const violations = readJsonlSafe<ViolationEntry>(VIOLATIONS_PATH);
  const p = precisionByRule(violations, readVerdicts(), 7, now).get(ruleId);
  if (!p || p.precision === null) return false;
  if (p.correct + p.false_positive < DEMOTE_MIN_JUDGED || p.precision >= DEMOTE_PRECISION_BELOW) return false;
  rule.enforce_mode = 'advise';
  saveRule(rule);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'enforcement', 'demotions.jsonl'),
      `${JSON.stringify({ at: new Date(now).toISOString(), rule_id: ruleId, precision: p.precision, judged: p.correct + p.false_positive })}\n`);
  } catch { /* best-effort */ }
  return true;
}

/**
 * 훅에서 호출: detached 로 심판 프로세스를 띄운다. 훅 지연 0. 조건 미충족이면 즉시 return.
 * (consent 는 자식에서도 재확인하지만 여기서 먼저 걸러 불필요한 spawn 을 막는다.)
 */
export function spawnBlockJudge(violationId: string, sessionId: string): boolean {
  try {
    if (!violationId || process.env.FORGEN_NESTED_RUN === '1' || process.env.FORGEN_NO_BLOCK_JUDGE === '1') return false;
    if (!isHaikuCompoundEnabled()) return false;
    if (!withinJudgeCaps(sessionId)) return false;
    const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'block-judge-cli.js');
    if (!fs.existsSync(script)) return false;
    const child = spawn(process.execPath, [script, violationId], {
      detached: true, stdio: 'ignore', env: { ...process.env, FORGEN_NESTED_RUN: '1' },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
