/**
 * 훅 공유 유틸: timeout-protected stdin 읽기
 *
 * event-based 패턴으로 Linux에서 hang을 방지합니다.
 * (for await of process.stdin은 일부 환경에서 hang 발생)
 */

const MAX_STDIN_BYTES = 10 * 1024 * 1024; // 10MB — 메모리 고갈 방지

/**
 * 0.4.6 perf #11 — idle-based early resolve + initial-wait fallback.
 *
 * Claude/Codex CLI 가 hook 호출 후 stdin 을 EOF 닫지 않고 hang on 하는 케이스가 있어
 * 이전엔 timeoutMs (2000ms) 까지 무조건 대기 → p95 hook latency 가 2003ms 였음
 * (hook-timing.jsonl 측정 결과).
 *
 * 두 단계 fix:
 *  1. IDLE_RESOLVE_MS — 'data' 받은 후 추가 chunk 없으면 100ms 후 resolve
 *  2. INITIAL_WAIT_MS — 'data' 자체가 안 오는 케이스 (codex 일부 hook event)
 *     를 대비해 INITIAL_WAIT_MS 후 chunks 가 비어 있으면 빈 데이터로 resolve
 *
 * 합법적 데이터 손실 위험 없음 — Claude/Codex 의 stdin 페이로드는 호출 즉시
 * (≤ INITIAL_WAIT_MS) 첫 chunk 도착. 안 오면 그 이벤트는 stdin 자체가 없는 것.
 */
const IDLE_RESOLVE_MS = 100;
const INITIAL_WAIT_MS = 300;

/** stdin에서 JSON 데이터를 읽어 파싱. 실패 시 null 반환. */
export async function readStdinJSON<T = Record<string, unknown>>(timeoutMs = 2000): Promise<T | null> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  let settled = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const raw = await new Promise<string>((resolve) => {
    const settle = (clearIdle = true) => {
      if (settled) return;
      settled = true;
      if (clearIdle && idleTimer) clearTimeout(idleTimer);
      clearTimeout(timeout);
      process.stdin.removeAllListeners();
      if (typeof process.stdin.pause === 'function') process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf-8'));
    };

    const timeout = setTimeout(() => settle(), timeoutMs);

    // perf: INITIAL_WAIT_MS 안에 'data' 가 한 번도 안 오면 stdin 부재로 간주, 조기 resolve.
    // codex 일부 hook event (e.g. SessionStart, Stop without payload) 가 stdin 안 보내는 케이스 대응.
    const initialWait = setTimeout(() => {
      if (!settled && chunks.length === 0) settle();
    }, INITIAL_WAIT_MS);

    // 일부 Node.js 환경에서 stdin이 paused 상태로 시작 — 명시적 resume 필요
    if (typeof process.stdin.resume === 'function') {
      process.stdin.resume();
    }

    process.stdin.on('data', (chunk: Buffer | string) => {
      clearTimeout(initialWait);
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalSize += buf.length;
      if (totalSize > MAX_STDIN_BYTES) { settle(); return; }
      chunks.push(buf);

      // perf: 데이터 수신 후 IDLE_RESOLVE_MS 동안 추가 chunk 없으면 early resolve
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => settle(false), IDLE_RESOLVE_MS);
    });
    process.stdin.on('end', () => settle());
    process.stdin.on('error', () => settle());
  });

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
