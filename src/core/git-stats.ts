/**
 * Git Stats — P4 셀프 가드 (2026-04-27)
 *
 * 최근 N커밋의 conventional commit 분포를 측정해 fix:feat 비율을 계산.
 * 정상 OSS 권장은 fix < 20%. 36% 초과 시 회귀 패턴 의심 — forgen 의 자기 메타 가드.
 *
 * 이번 세션 측정값: v0.4.1 시점 fix 비율 36% (정상의 약 2배). 이 코드가 다음 릴리즈
 * 시 같은 비율을 자동 노출하여 사용자가 회귀 패턴을 빠르게 인지하게 한다.
 */

import { execFileSync } from 'node:child_process';

export interface FixRatioStats {
  windowSize: number;
  fixCount: number;
  featCount: number;
  /** fix / (fix + feat), 0~1. fix+feat=0 이면 0. */
  ratio: number;
  threshold: number;
  exceedsThreshold: boolean;
  /** git 명령이 성공했는지 (저장소 외부 또는 git 미설치 시 false). */
  available: boolean;
}

const DEFAULT_THRESHOLD = 0.30;
const DEFAULT_WINDOW = 30;
const SCOPE_EXCLUSIONS = new Set(['test', 'tests', 'docs', 'doc']);

/**
 * git log --no-merges -N 결과에서 conventional commit 형식의 fix/feat 만 카운트.
 *
 * 분류:
 *   - `feat: ...` / `feat(scope): ...` → feat
 *   - `fix: ...` / `fix(scope): ...` → fix (단, scope ∈ {test, tests, docs, doc} 제외)
 *   - 그 외 (chore, refactor, docs, style, test, hash 없는 라인) → 무시
 *
 * fix(test):, fix(docs): 가 제외되는 이유: 사소한 노이즈 fix 가 회귀 신호를
 * 흐리지 않도록. 진짜 위험은 fix(core), fix(hook), fix(api) 같은 logic fix.
 */
export function computeFixFeatRatio(
  cwd: string = process.cwd(),
  windowSize: number = DEFAULT_WINDOW,
  threshold: number = DEFAULT_THRESHOLD,
): FixRatioStats {
  try {
    const out = execFileSync(
      'git',
      ['log', '--no-merges', '--oneline', `-${windowSize}`],
      { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return parseGitLog(out, windowSize, threshold);
  } catch {
    return makeUnavailable(windowSize, threshold);
  }
}

/** 테스트용 — git log 출력 텍스트를 직접 파싱. */
export function parseGitLog(
  rawLog: string,
  windowSize: number = DEFAULT_WINDOW,
  threshold: number = DEFAULT_THRESHOLD,
): FixRatioStats {
  const lines = rawLog.trim().split('\n').filter(Boolean);
  let fix = 0;
  let feat = 0;
  for (const line of lines) {
    const msg = line.replace(/^[a-f0-9]{4,40}\s+/, '');
    const m = msg.match(/^(fix|feat)(?:\(([^)]+)\))?:/);
    if (!m) continue;
    const type = m[1];
    const scope = (m[2] ?? '').toLowerCase().trim();
    if (type === 'fix' && SCOPE_EXCLUSIONS.has(scope)) continue;
    if (type === 'fix') fix++;
    else feat++;
  }
  const total = fix + feat;
  const ratio = total === 0 ? 0 : fix / total;
  return {
    windowSize,
    fixCount: fix,
    featCount: feat,
    ratio,
    threshold,
    exceedsThreshold: ratio > threshold,
    available: true,
  };
}

function makeUnavailable(windowSize: number, threshold: number): FixRatioStats {
  return {
    windowSize, fixCount: 0, featCount: 0, ratio: 0,
    threshold, exceedsThreshold: false, available: false,
  };
}

/** 사람용 한 줄 라벨. */
export function formatFixRatio(s: FixRatioStats): string {
  if (!s.available) return 'fix:feat ratio    n/a    (git unavailable)';
  const pct = (s.ratio * 100).toFixed(0);
  const thresholdPct = (s.threshold * 100).toFixed(0);
  const flag = s.exceedsThreshold ? `  ⚠ over ${thresholdPct}%` : '';
  return `fix:feat ratio    ${pct}%   (${s.fixCount}/${s.fixCount + s.featCount} in last ${s.windowSize})${flag}`;
}
