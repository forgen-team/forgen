/**
 * Forgen Usage Telemetry — ADR-008 §"테마 A unattended resilience"
 *
 * 5h / weekly window 의 tool call 수를 sliding window 로 추적하여 statusline
 * (`forgen me`) 에 노출. rate-limit hit 전에 사용자가 사용량을 가시화할 수 있도록.
 *
 * 정책:
 *  - 각 PostToolUse 마다 append-only JSONL 에 timestamp 한 줄 기록
 *  - read 시 sliding window 로 필터 + 카운트 (스트리밍 — 메모리 절약)
 *  - 10K 엔트리 누적 시 weekly cap 밖 엔트리 prune (rewrite once)
 *  - fail-open: 모든 I/O 실패는 로그 후 무시, 호출 측 차단 안 함
 *
 * 0.4.6 신설. limit prediction 은 의도적으로 제외 — Anthropic 의 실제 limit 가
 * 계정/플랜별 가변이라 hard-code 부정확. raw count 만 노출하고 사용자가 판단.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';
import { createLogger } from './logger.js';

const log = createLogger('usage-telemetry');

const TELEMETRY_PATH = path.join(STATE_DIR, 'usage-telemetry.jsonl');

const HOUR5_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_THRESHOLD = 10_000; // 10K lines 누적 시 prune

export interface UsageStats {
  hour5: { claude: number; codex: number; total: number };
  week: { claude: number; codex: number; total: number };
}

interface TelemetryEntry {
  ts: number;       // epoch ms
  rt?: 'claude' | 'codex';
}

/**
 * @deprecated ADR-010 W2-2 (2026-07-16): native `/usage` 가 plan limit 를
 * skill/subagent/plugin/MCP 별로 정확히 분해하므로 forgen 의 raw count 는
 * 중복 표면. 기록 중단(no-op shim — API 만 유지), v0.6.0 에서 모듈 삭제 예정.
 */
export function recordToolCall(_runtime: 'claude' | 'codex' = 'claude'): void {
  // no-op — 사용량 추적은 native /usage 로 이관됨.
}

/**
 * sliding window count. fail-open: 파일 미존재/parse 실패는 0 반환.
 *
 * @param now epoch ms (테스트 결정성)
 */
export function getUsageStats(now: number = Date.now()): UsageStats {
  const stats: UsageStats = {
    hour5: { claude: 0, codex: 0, total: 0 },
    week: { claude: 0, codex: 0, total: 0 },
  };
  try {
    if (!fs.existsSync(TELEMETRY_PATH)) return stats;
    const cutoff5h = now - HOUR5_MS;
    const cutoffWeek = now - WEEK_MS;
    const raw = fs.readFileSync(TELEMETRY_PATH, 'utf-8');
    const lines = raw.split('\n');
    let total = 0;
    for (const line of lines) {
      if (!line) continue;
      total++;
      try {
        const e = JSON.parse(line) as TelemetryEntry;
        if (typeof e.ts !== 'number' || e.ts < cutoffWeek) continue;
        const rt = e.rt === 'codex' ? 'codex' : 'claude';
        stats.week[rt]++;
        stats.week.total++;
        if (e.ts >= cutoff5h) {
          stats.hour5[rt]++;
          stats.hour5.total++;
        }
      } catch { /* skip malformed line */ }
    }
    if (total > PRUNE_THRESHOLD) pruneOldEntries(now);
  } catch (e) {
    log.debug('telemetry read 실패', e);
  }
  return stats;
}

/** 누적 엔트리가 PRUNE_THRESHOLD 초과 시 weekly cap 밖 entry 제거 (rewrite). */
function pruneOldEntries(now: number): void {
  try {
    const cutoff = now - WEEK_MS;
    const raw = fs.readFileSync(TELEMETRY_PATH, 'utf-8');
    const kept: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as TelemetryEntry;
        if (typeof e.ts === 'number' && e.ts >= cutoff) kept.push(line);
      } catch { /* drop malformed */ }
    }
    fs.writeFileSync(TELEMETRY_PATH, kept.join('\n') + (kept.length ? '\n' : ''));
    log.debug(`telemetry pruned to ${kept.length} entries`);
  } catch (e) { log.debug('telemetry prune 실패', e); }
}
