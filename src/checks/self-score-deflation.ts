/**
 * Forgen v0.4.1 — TEST-2: 자가 점수 인플레이션 가드
 *
 * Claude 가 자신의 작업 품질/확신도/완성도를 **숫자**로 상향 선언하면서 해당
 * 턴(또는 세션)에 측정 도구 호출이 0 건이면 block. TEST-1 (사실 vs 합의) 보다
 * 강한 신호 — 구체적 숫자 인플레이션은 합의-기반 자기-아부(sycophancy)의
 * 가장 또렷한 표식.
 *
 * 배경 (RC2): v0.4.0 self-interview 에서 "8/10", "신뢰도 90%", "0.85 → 0.95"
 *   같은 자가 점수가 턴마다 올라갔지만 `npm test` / `curl` / `Read` 등 실제
 *   측정 호출은 0건. TEST-1 이 서술체 사실 주장을 잡았다면, TEST-2 는 **숫자**
 *   점수의 인플레이션에 초점을 맞춘다.
 *
 * 순수 함수 — Stop hook block 경로에 붙는다.
 */

/**
 * 측정성 도구 — **숫자 점수**를 뒷받침할 수 있는 실 **실행** 범주.
 *
 * v0.4.1 coverage fix (2026-04-24 buyer-day1 R4 관찰): 이전에는 Read/Edit/Write/
 * Grep/Glob 도 측정으로 간주했으나, 파일 "읽기/수정" 은 "신뢰도 95/100" 같은
 * 수치 판정을 뒷받침 못 함. Read 1회면 minMeasurements=1 충족되어 block 회피.
 * 실제 구매자 시나리오: Claude 가 자가평가 전에 대상 파일 한 번 Read 하면
 * TEST-2 무력화 — 가드의 본 의도 훼손.
 *
 * 새 기준: **실행 결과** 만 측정 — `Bash` (npm test / curl / node --check 등)
 * 와 `NotebookEdit` (cell 실행). 읽기 전용 도구는 수치 점수의 근거가 될 수 없음.
 */
const MEASUREMENT_TOOLS = new Set([
  'Bash',
  'NotebookEdit',
]);

/**
 * "자가 점수" 신호 — 숫자 + 품질/완성도/확신도 컨텍스트.
 *  - "신뢰도 90%", "품질 점수 85/100", "확신도 0.9", "8/10", "90점"
 *  - "0.7 → 0.9" 같은 증감 표기
 *
 * 이 regex 들은 *숫자 그 자체* 만 매칭하지 않고 품질-관련 명사와 같이 나타날 때만
 * 매칭하도록 좁힘 (false positive 방지).
 */
const SELF_SCORE_PATTERNS: RegExp[] = [
  // "신뢰도 90%" / "quality 85%" / "확신도 0.9"
  /(신뢰도|확신도|완성도|품질|자신감|confidence|quality|completeness)[\s:：]*(\d+(?:\.\d+)?)\s*(%|점|\/\s*\d+|\/100|\/10)?/gi,
  // "0.85 → 0.95" / "7 -> 9" score delta
  /(\d+(?:\.\d+)?)\s*(?:→|->|–>|~>)\s*(\d+(?:\.\d+)?)/g,
  // "8/10", "85/100" — 단독 분수 점수 (앞뒤 품질 컨텍스트 확인은 하지 않지만 보수적 매칭)
  /\b(\d+(?:\.\d+)?)\s*\/\s*(10|100)\b/g,
  // 별 점수 "⭐⭐⭐⭐" 4개 이상
  /⭐{4,}/g,
];

export interface SelfScoreCheckInput {
  text: string;
  /** 이번 턴(또는 윈도우) 내 실행된 도구 이름 목록. */
  recentTools: string[];
  /** score delta 임계 — 이 이상의 증가를 인플레이션으로 간주. 기본 0 (모든 상승). */
  minDelta?: number;
  /** 측정 도구 최소 호출 수 — 기본 1. */
  minMeasurements?: number;
}

export interface SelfScoreCheckResult {
  /** true = 자가 점수 인플레이션 감지 (측정 없이 숫자 증가 선언). block 대상. */
  block: boolean;
  /** 매칭된 점수 표현 raw 스트링 (최대 3개). */
  scoreSignals: string[];
  /** 감지된 positive delta 목록 (from → to). */
  deltas: Array<{ from: number; to: number }>;
  measurementCount: number;
  reason: string;
}

function extractDeltas(text: string): Array<{ from: number; to: number }> {
  const re = /(\d+(?:\.\d+)?)\s*(?:→|->|–>|~>)\s*(\d+(?:\.\d+)?)/g;
  const out: Array<{ from: number; to: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (Number.isFinite(from) && Number.isFinite(to)) out.push({ from, to });
  }
  return out;
}

function findScoreSignals(text: string, max = 3): string[] {
  const out: string[] = [];
  for (const p of SELF_SCORE_PATTERNS) {
    if (out.length >= max) break;
    // 각 호출마다 lastIndex 초기화를 위해 새 RegExp 생성
    const re = new RegExp(p.source, p.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && out.length < max) {
      out.push(m[0]);
    }
  }
  return out;
}

export function checkSelfScoreInflation(input: SelfScoreCheckInput): SelfScoreCheckResult {
  const minDelta = input.minDelta ?? 0;
  const minMeasurements = input.minMeasurements ?? 1;

  const scoreSignals = findScoreSignals(input.text);
  const allDeltas = extractDeltas(input.text);
  const positiveDeltas = allDeltas.filter((d) => d.to - d.from > minDelta);

  const measurementCount = input.recentTools.filter((t) => MEASUREMENT_TOOLS.has(t)).length;
  const measurementMissing = measurementCount < minMeasurements;

  // 인플레이션 신호가 하나라도 있고 측정이 없으면 block
  const hasInflationSignal = scoreSignals.length > 0 || positiveDeltas.length > 0;
  const block = hasInflationSignal && measurementMissing;

  let reason = '';
  if (block) {
    const parts: string[] = [];
    if (positiveDeltas.length > 0) {
      const sample = positiveDeltas.slice(0, 2).map((d) => `${d.from}→${d.to}`).join(', ');
      parts.push(`자가 점수 상승 선언 ${positiveDeltas.length}건 (${sample})`);
    }
    if (scoreSignals.length > 0) {
      parts.push(`점수 표현 ${scoreSignals.length}건 ("${scoreSignals[0]}")`);
    }
    parts.push(`측정 도구 호출 ${measurementCount}회 (< ${minMeasurements}) — 숫자 변동을 뒷받침할 실행/확인 증거 없음`);
    parts.push('block: 테스트/빌드/curl 실행 결과를 턴에 포함하여 재응답');
    reason = parts.join('. ');
  }

  return {
    block,
    scoreSignals,
    deltas: positiveDeltas,
    measurementCount,
    reason,
  };
}
