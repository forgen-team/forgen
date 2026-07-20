/**
 * Forgen v0.5.0 — per-model 가드 프로필 (ADR-010 W4-3, F3)
 *
 * 근거 (v0.4.11 실측, docs/release/v0.4.11-calibration-pending.md):
 * opus-4.8 에서 완료 가드(TEST-1/2/3) blocks=0 — easy N=10 / hard N=6,
 * false-completion 압박 케이스 포함. 프론티어 모델은 스스로 정직해져서
 * 완료 가드가 발화하지 않으며, 발화한다면 거짓양성일 개연성이 높다.
 * → 측정된 모델은 block 대신 advise(기록+주입만)로 강등한다.
 *
 * 미측정 모델(sonnet-5 포함)은 보수적으로 block 유지 — R1/R2 재캘리브레이션이
 * 측정을 제공하면 테이블을 갱신한다. DANGEROUS 가드(파괴 명령)는 모델 무관
 * 결정적 안전장치라 이 프로필의 대상이 아니다.
 *
 * 모델 식별 경로 (probe 2026-07-16): hook stdin 에는 모델 필드가 없다.
 * Claude Code statusline stdin 에는 session_id + model.id 가 오므로,
 * `forgen statusline` 이 세션별 캐시를 남기고 Stop/SubagentStop 가드가
 * session_id 로 조회한다. 캐시 부재(statusline 미사용 등) 시 'unknown'
 * → 현행 동작(block) 유지. FORGEN_MODEL env 가 있으면 최우선.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type CompletionGuardMode = 'block' | 'advise';

/**
 * 측정 기반 기본 테이블. 버전 경계 안전 매칭 (리뷰 SEV-2: 단순 prefix 는
 * 가상의 'claude-opus-4-80' 같은 미측정 후속 모델까지 매치한다) —
 * 정확히 해당 버전이거나 뒤에 비숫자 구분자([·- 등)가 와야 한다.
 * opus-4-8 만 측정됨(v0.4.11 blocks=0, easy+hard) — 그 외 전부 보수적 block.
 */
const MEASURED_ADVISE_RES: readonly RegExp[] = Object.freeze([
  /^claude-opus-4-8(?![0-9])/, // claude-opus-4-8, claude-opus-4-8[1m] — 4-80 은 불일치
]);

export function guardModeForModel(modelId: string | null | undefined): CompletionGuardMode {
  if (!modelId) return 'block'; // unknown → 현행 유지
  return MEASURED_ADVISE_RES.some(re => re.test(modelId)) ? 'advise' : 'block';
}

function cachePath(sessionId: string, home: string): string {
  // sessionId 는 호출측에서 sanitize 된 값이어야 함 (경로 주입 방지)
  return path.join(home, '.forgen', 'state', `current-model-${sessionId}.json`);
}

/** statusline 이 세션별 모델을 기록 (fail-open) */
export function cacheSessionModel(sessionId: string, modelId: string, home: string = os.homedir()): void {
  try {
    const p = cachePath(sessionId, home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify({ modelId, at: new Date().toISOString() })}\n`);
  } catch { /* fail-open */ }
}

/** 가드가 세션별 모델 조회. 우선순위: FORGEN_MODEL env > statusline 캐시 > null */
export function readSessionModel(sessionId: string, home: string = os.homedir()): string | null {
  const envModel = process.env.FORGEN_MODEL;
  if (envModel && envModel.trim().length > 0) return envModel.trim();
  try {
    const raw = fs.readFileSync(cachePath(sessionId, home), 'utf-8');
    const parsed = JSON.parse(raw) as { modelId?: unknown };
    return typeof parsed.modelId === 'string' ? parsed.modelId : null;
  } catch {
    return null;
  }
}
