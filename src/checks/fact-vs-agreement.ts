/**
 * Forgen v0.4.1 — TEST-1: 사실 vs 합의 가드
 *
 * 목적: Claude 가 "동작합니다 / 통과했습니다 / 검증됐습니다" 같은 **사실 주장**을
 *   내놓을 때, 그 턴(또는 최근 N턴)에 실제 측정/검증을 수행한 도구 호출이 있었는가?
 *   측정 없이 합의(agreement)만으로 사실로 변환된다면 alert.
 *
 * 배경 (RC1): v0.4.0 릴리즈 직전 self-assessment 에서 점수가 조금씩 올라가는데
 *   측정 도구 호출은 0건인 케이스가 반복. 메타 점수 인플레이션 (TEST-2 / US-13)
 *   의 직전 단계. 여기서는 alert 레벨까지만 — block 은 TEST-2 에서.
 *
 * 순수 함수 설계: I/O 없이 텍스트 + 측정 신호 메타데이터만 받아 판정.
 *   Stop hook / session scorer / CLI 어느 쪽에서도 호출 가능.
 */

/**
 * 측정성 도구 — 실행 결과가 사실 주장을 뒷받침할 수 있는 카테고리.
 *
 * v0.4.1 coverage fix: TEST-2 와 같은 논리로, Read/Edit/Write/Grep/Glob 은 파일
 * 내용 확인/수정이지 "통과/검증/완료" 같은 실 실행 주장을 뒷받침 못 함. 오직
 * Bash (실 실행) + NotebookEdit (실행 결과) 만 strong measurement.
 *
 * 이전 넓은 집합은 신규 사용자 시나리오 (buyer-day1 R4) 에서 Claude 가 Read
 * 한 번만 해도 alert 회피 → TEST-1 본 의도 훼손.
 */
const MEASUREMENT_TOOL_CATEGORIES = new Set([
  'Bash',
  'NotebookEdit',
]);

/** 사실-주장 키워드 — "측정됐다/검증됐다" 류 강한 확정 언어. */
const FACT_ASSERTION_PATTERNS: RegExp[] = [
  /\b(pass(es|ed)?|passing)\b/i,
  /\bverified\b/i,
  /\bconfirmed\b/i,
  /\bvalidated\b/i,
  /\ball tests? pass/i,
  /(통과(했|됐|함|합니다))/,
  /(검증(됐|했|됨|완료))/,
  /(동작(합니다|함|한다))/,
  /(성공(했|했습니다|적))/,
  /(완료(했|됐|됨|됐습니다))/,
];

/** 합의/추측 표현 — 측정 없이 확언으로 가는 다리. 이 패턴이 많으면 합의→사실 전환 위험. */
const AGREEMENT_SOFTENERS: RegExp[] = [
  /\b(should|would|might)\s+(work|pass)/i,
  /\blikely\b/i,
  /\bprobably\b/i,
  /(생각합니다|생각함|생각해|봅니다|예상(합니다|돼))/,
  /(그럴\s*것\s*같|맞을\s*것\s*같)/,
];

/**
 * 측정-증거 지표 — 실제 실행/측정 결과가 응답에 *paste 되어 있다*는 신호.
 *
 * v0.4.4 (2026-05-06): FP 감소. "Docker e2e 77/77 PASS" 같은 *정량 사실 보고*
 * 가 recentTools 윈도우 밖 측정 (예: 이전 turn Bash 결과, 사용자 paste, CI 로그
 * 인용)이라 Bash 카운트가 0이지만 본질적으로 measurement-backed 응답.
 *
 * 임계: 본 패턴이 2+ 매칭되면 alert 억제 (응답이 측정 증거를 *제시*하고 있다고 본다).
 */
const EVIDENCE_INDICATORS: RegExp[] = [
  /\b\d+\/\d+\b/,                           // test counts: "77/77", "22/22"
  /\bexit\s*code\s*[:=]?\s*\d+/i,           // exit code
  /\b\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/i,  // timings: "232s", "1.5ms"
  /\b(?:Test|Spec)s?\s*Files?\s+\d+/i,      // vitest "Test Files 218"
  /\b(?:Tests?:?\s+)?\d+\s+passed?\b/i,     // "2382 passed"
  /\b(?:CI|HEAD|sha|commit)\s*[:=]?\s*[a-f0-9]{7,}/i, // commit ref
  /^[+-]{3}\s/m,                            // diff hunks
  /\bcoverage\s*[:=]?\s*\d+(\.\d+)?%/i,     // coverage %
  /^\s*✓\s|^\s*✗\s|^\s*PASS\b|^\s*FAIL\b/m, // test runner output markers
];

/** TEST-1 판정 입력. */
export interface FactCheckInput {
  /** Claude 의 최근 턴 응답 텍스트. */
  text: string;
  /**
   * 최근 N 턴에서 실행된 도구 이름 목록 (중복 OK). 없으면 빈 배열.
   * 호출지가 0턴/전체 세션 등 윈도우를 결정한다.
   */
  recentTools: string[];
  /**
   * optional: 측정으로 간주할 최소 tool count. 기본 1.
   * 빌드/테스트같은 확정 측정 1회면 충분하다고 간주.
   */
  minMeasurements?: number;
}

export interface FactCheckResult {
  /** true = 측정 없는 사실-주장 감지, alert 필요. */
  alert: boolean;
  /** 매칭된 사실-주장 키워드 (최대 3개). */
  factAssertions: string[];
  /** 감지된 합의/추측 신호 (최대 3개). */
  agreementSofteners: string[];
  /** 관찰된 측정성 도구 호출 수. */
  measurementCount: number;
  /** 호출지가 surface 하기 좋은 사람-읽기 이유. */
  reason: string;
}

function findMatches(text: string, patterns: RegExp[], max = 3): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    if (out.length >= max) break;
    const m = text.match(p);
    if (m) out.push(m[0]);
  }
  return out;
}

/**
 * 핵심 판정 — 텍스트에 사실-주장이 있고 측정 도구가 없으면 alert.
 * 측정이 있거나 사실-주장이 없으면 alert=false.
 * 합의 softener 는 참고용 — softener 많을수록 reason 에 경고 추가.
 */
export function checkFactVsAgreement(input: FactCheckInput): FactCheckResult {
  const { text, recentTools } = input;
  const minMeasurements = input.minMeasurements ?? 1;

  const factAssertions = findMatches(text, FACT_ASSERTION_PATTERNS);
  const agreementSofteners = findMatches(text, AGREEMENT_SOFTENERS);

  const measurementCount = recentTools.filter((t) => MEASUREMENT_TOOL_CATEGORIES.has(t)).length;

  // Evidence indicator suppression — 응답에 측정 결과가 *paste* 되어 있으면
  // recentTools 윈도우 밖 측정으로 보고 alert 억제 (FP 감소).
  const evidenceIndicators = findMatches(text, EVIDENCE_INDICATORS, 99);
  const hasMeasurementEvidence = evidenceIndicators.length >= 2;

  const hasFactAssertion = factAssertions.length > 0;
  const measurementMissing = measurementCount < minMeasurements && !hasMeasurementEvidence;

  const alert = hasFactAssertion && measurementMissing;

  let reason = '';
  if (alert) {
    const parts: string[] = [];
    parts.push(`사실-주장 키워드 ${factAssertions.length}건 감지 ("${factAssertions.join('", "')}")`);
    parts.push(`그러나 최근 측정 도구 호출 ${measurementCount}회 (< ${minMeasurements})`);
    if (agreementSofteners.length > 0) {
      parts.push(`합의성 표현 ${agreementSofteners.length}건 (${agreementSofteners.join(', ')})`);
    }
    reason = parts.join('. ');
  }

  return {
    alert,
    factAssertions,
    agreementSofteners,
    measurementCount,
    reason,
  };
}
