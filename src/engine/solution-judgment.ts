/**
 * 솔루션 사용 판정 (0.8.0 M3) — 기록만. 카운터·승급·강등에 쓰지 않는다(오너 표본 검수 뒤 0.9 에서 정한다).
 *
 * 이미 도는 솔루션 추출 Haiku 호출에 "이 세션에 노출된 솔루션" 목록을 붙여, 각각 used / ignored / wrong 을
 * 대화 요약의 원문 인용과 함께 받는다. 추가 모델 호출은 없다(ADR-001). 인용이 요약에 있어야 기록한다.
 * 기록: state/metrics/solution-judgments.jsonl. (solution_events 의 event_type CHECK 제약을 바꾸지 않으려고 별도 파일)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR, ME_SOLUTIONS } from '../core/paths.js';
import { parseSolutionV3 } from './solution-format.js';
import { quoteInSummary } from './quote-grounding.js';

export const JUDGMENTS_PATH = path.join(STATE_DIR, 'metrics', 'solution-judgments.jsonl');
export type Verdict = 'used' | 'ignored' | 'wrong';
const MAX_LISTED = 10;

/** 프롬프트에 붙일 목록. 노출된 솔루션이 없으면 빈 문자열(판정 요청 자체를 하지 않는다). */
export function judgmentPromptSection(surfacedNames: string[]): string {
  const names = [...new Set(surfacedNames)].slice(0, MAX_LISTED);
  const items: string[] = [];
  for (const n of names) {
    try {
      const s = parseSolutionV3(fs.readFileSync(path.join(ME_SOLUTIONS, `${path.basename(n)}.md`), 'utf-8'));
      if (s) items.push(`- ${n}: ${s.content.replace(/\s+/g, ' ').slice(0, 120)}`);
    } catch { /* 없어진 솔루션은 뺀다 */ }
  }
  if (!items.length) return '';
  return `

이 세션에 참고로 보여 준 기존 솔루션(아래)이 실제로 어땠는지도 판정해 주세요. 판정할 근거가 대화에 있을 때만, 각각 정확히 한 줄:
forgen judge "솔루션 이름" "used|ignored|wrong" "user|assistant" "근거 인용"
- used: 대화에서 그 방법대로 했다 / ignored: 관련 상황이었는데 쓰지 않았다 / wrong: 그 방법이 틀렸거나 맞지 않았다고 드러났다
- 근거 인용은 대화 요약에 실제로 있는 문장을 그대로 20~200자. 근거가 없으면 그 솔루션은 판정하지 말 것.
${items.join('\n')}`;
}

const JUDGE_RE = /forgen judge\s+"((?:[^"\\]|\\.)+)"\s+"(used|ignored|wrong)"\s+"(user|assistant)"\s+"((?:[^"\\]|\\.)+)"/g;

/** 모델 출력에서 판정 줄을 뽑아 인용 검사를 통과한 것만 기록한다. 기록한 수와 버린 수. */
export function recordJudgments(output: string, summary: string, sessionId: string, allowed: string[]): { recorded: number; dropped: number } {
  const ok = new Set(allowed);
  let recorded = 0; let dropped = 0;
  const lines: string[] = [];
  for (const m of output.matchAll(JUDGE_RE)) {
    const [, name, verdict, kind, rawQuote] = m;
    const quote = rawQuote.replace(/\\"/g, '"');
    if (!ok.has(name) || !quoteInSummary(quote, summary)) { dropped++; continue; }
    lines.push(JSON.stringify({ at: new Date().toISOString(), session: sessionId, solution: name, verdict, kind, quote: quote.slice(0, 300) }));
    recorded++;
  }
  if (lines.length) {
    fs.mkdirSync(path.dirname(JUDGMENTS_PATH), { recursive: true });
    fs.appendFileSync(JUDGMENTS_PATH, `${lines.join('\n')}\n`);
  }
  return { recorded, dropped };
}

export function summarizeJudgments(sinceMs = 0): Record<Verdict, number> {
  const out: Record<Verdict, number> = { used: 0, ignored: 0, wrong: 0 };
  try {
    for (const l of fs.readFileSync(JUDGMENTS_PATH, 'utf-8').split('\n')) {
      if (!l) continue;
      try { const j = JSON.parse(l) as { at: string; verdict: Verdict }; if (Date.parse(j.at) >= sinceMs && j.verdict in out) out[j.verdict]++; } catch { /* */ }
    }
  } catch { /* 기록 없음 */ }
  return out;
}
