/**
 * Codex rollout 파일 헬퍼 — ADR-016 (SessionEnd 훅 + notify 폴백 공용)
 *
 * rollout: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local ts>-<thread id>.jsonl` (compact JSONL).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** rollout 탐색 시 최근 일자 디렉토리만 본다 (resume 된 오래된 세션 대비 여유). */
const MAX_DAY_DIRS = 45;

function sortedDesc(dir: string): string[] {
  try { return fs.readdirSync(dir).sort().reverse(); } catch { return []; }
}

/**
 * thread id(= 훅의 session_id = notify 의 `thread-id`) 로 rollout 파일을 찾는다 (최근 날짜부터).
 * id 는 UUID 형태만 허용한다.
 */
export function findCodexRollout(codexHome: string, threadId: string): string | null {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(threadId)) return null;
  const root = path.join(codexHome, 'sessions');
  let scanned = 0;
  for (const y of sortedDesc(root)) {
    for (const m of sortedDesc(path.join(root, y))) {
      for (const d of sortedDesc(path.join(root, y, m))) {
        if (scanned >= MAX_DAY_DIRS) return null;
        scanned += 1;
        const dayDir = path.join(root, y, m, d);
        const hit = sortedDesc(dayDir).find(
          (f) => f.startsWith('rollout-') && f.endsWith('.jsonl') && f.includes(`-${threadId}`),
        );
        if (hit) return path.join(dayDir, hit);
      }
    }
  }
  return null;
}

const USER_PROMPT_NEEDLE = Buffer.from('"type":"user_message"');
const CHUNK_BYTES = 1024 * 1024;

/** 스캔 상한. SessionEnd 훅은 3s 예산이라 전체 스트리밍(239MB ≈ 3s) 대신 raw 바이트 스캔 + 상한을 쓴다. */
export const CODEX_PROMPT_SCAN_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Codex rollout 의 *실제 사용자 프롬프트* 수 — `event_msg` / `payload.type:"user_message"` 레코드.
 *
 * `response_item` role=user 는 AGENTS.md·환경 컨텍스트 주입까지 포함해 실측 ~1.8배 과대계수이고
 * (51 vs 91), 줄당 수십 KB 인 tool 출력 때문에 "앞 200KB 만 JSON.parse" 로는 프롬프트 1~2개밖에 못 본다.
 * 그래서 JSON 을 파싱하지 않고 구조 수준의 바이트 패턴을 센다 — 문자열 값 안의 같은 텍스트는 따옴표가
 * `\"` 로 이스케이프되므로 매치되지 않는다. maxBytes 까지만 읽는다 (하한 추정).
 */
export function countCodexUserPrompts(rolloutPath: string, maxBytes: number = CODEX_PROMPT_SCAN_MAX_BYTES): number {
  const fd = fs.openSync(rolloutPath, 'r');
  try {
    const overlap = USER_PROMPT_NEEDLE.length - 1;
    const buf = Buffer.alloc(CHUNK_BYTES + overlap);
    let carry = 0;
    let pos = 0;
    let count = 0;
    while (pos < maxBytes) {
      const read = fs.readSync(fd, buf, carry, Math.min(CHUNK_BYTES, maxBytes - pos), pos);
      if (read <= 0) break;
      const view = buf.subarray(0, carry + read);
      let idx = view.indexOf(USER_PROMPT_NEEDLE);
      while (idx !== -1) {
        count += 1;
        idx = view.indexOf(USER_PROMPT_NEEDLE, idx + USER_PROMPT_NEEDLE.length);
      }
      // 청크 경계에 걸친 패턴 대비: 끝 overlap 바이트를 다음 청크 앞에 붙인다 (needle 보다 짧아 이중계수 없음).
      carry = Math.min(overlap, view.length);
      view.copy(buf, 0, view.length - carry, view.length);
      pos += read;
    }
    return count;
  } finally {
    fs.closeSync(fd);
  }
}
