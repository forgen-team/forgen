/**
 * Shared retry + exponential backoff for transient CLI failures.
 *
 * 2026-05-12: codex N=20 retry sequential 측정에서 fallback 2.5 = 123 발생 →
 *   분석 결과 119/123 이 *claude-cli judge* 의 "Command failed" (claude CLI
 *   subscription rate-limit). driver 에만 retry 적용 (commit 7b333b2) 했고
 *   judge 에는 미적용이었음. judge 호출량 = N × 4 arms × 2 axes × 2 judges
 *   = 160 calls/run (codex N=20) 으로 rate-limit window 초과.
 *
 *   본 모듈로 retry 로직을 driver / judge 공통화. transient (rate-limit,
 *   network, timeout) → retry. deterministic (E2BIG, ENOENT) → 즉시 throw.
 */

const DEFAULT_RETRYABLE_PATTERNS = [
  /Command failed/i,
  /rate.{0,5}limit/i,
  /\b(429|502|503|504)\b/,
  /ECONNRESET|ETIMEDOUT|ENETUNREACH/,
  /timeout after/i,
  /Input exceeds the maximum length/i, // codex 1MB — 가끔 transient
];

export function defaultIsRetryable(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  if (/E2BIG|ENOENT|EACCES/.test(msg)) return false;
  return DEFAULT_RETRYABLE_PATTERNS.some((p) => p.test(msg));
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    isRetryable?: (e: unknown) => boolean;
    label?: string;
  } = {},
): Promise<T> {
  const max = opts.maxAttempts ?? Number(process.env.DRIVER_RETRY_MAX_ATTEMPTS ?? 5);
  const base = opts.baseDelayMs ?? Number(process.env.DRIVER_RETRY_BASE_MS ?? 2000);
  const retryable = opts.isRetryable ?? defaultIsRetryable;
  const label = opts.label ?? 'cli';
  let lastErr: unknown;
  for (let attempt = 0; attempt < max; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!retryable(e) || attempt === max - 1) throw e;
      const delay = base * Math.pow(2, attempt);
      const reason = ((e as Error)?.message ?? String(e)).slice(0, 120);
      process.stderr.write(`  [${label}] retry ${attempt + 1}/${max - 1} after ${delay}ms — ${reason}\n`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
