/**
 * Forgen — compound usage signal store (Pathfinder D11 fix, MVP).
 *
 * 배경 (Deep Interview 2026-04-30 Round 5):
 *   verified compound 23개, candidate 8개 — 그러나 mature 0. retro 회고에서
 *   "활용률 측정 불가 — compound-search 호출 카운터 미수집" 확인. 즉 사용자가
 *   compound 를 reuse 했다는 신호 자체가 잡히지 않아서 mature 승격 입력이 없음.
 *
 *   원칙(user-mirror, Round 4 Contrarian): forgen 자기 학습이 아니라 *사용자
 *   reuse* 가 mature 의 권위 종착점. 따라서 compound-read 호출이 있을 때마다
 *   "이 패턴이 사용됐다" 신호를 한 줄 기록.
 *
 * MVP 스코프: 신호 *수집*만. 승격 정책(예: 5회 reuse → mature) 은 다음 사이클.
 *   기록만 잘 쌓이면 임계 설정·승격 로직은 위에 얹기 쉬움.
 *
 * 데이터: append-only JSONL at ~/.forgen/state/compound-usage.jsonl
 *   각 라인: {"at": ISO, "name": "<solution-slug>", "via": "mcp|cli|hook"}
 *   crash-safe: 단순 fs.appendFileSync — 동시 append 는 OS 가 atomic 보장 (POSIX <PIPE_BUF).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from '../core/paths.js';

export const COMPOUND_USAGE_LOG = path.join(STATE_DIR, 'compound-usage.jsonl');

export interface UsageEntry {
  at: string;
  name: string;
  via: 'mcp' | 'cli' | 'hook';
}

export function recordUsage(name: string, via: UsageEntry['via'] = 'mcp'): void {
  if (!name) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const entry: UsageEntry = { at: new Date().toISOString(), name, via };
    fs.appendFileSync(COMPOUND_USAGE_LOG, JSON.stringify(entry) + '\n');
  } catch {
    // fail-open: 신호 수집 실패가 사용자 경험을 방해하면 안 됨
  }
}

/** 단순 카운터 — 승격 정책에서 호출. MVP 에선 미사용. */
export function readUsageCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  if (!fs.existsSync(COMPOUND_USAGE_LOG)) return counts;
  try {
    const lines = fs.readFileSync(COMPOUND_USAGE_LOG, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as UsageEntry;
        if (typeof entry.name === 'string') {
          counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
        }
      } catch {
        // skip malformed
      }
    }
  } catch {
    // fail-open
  }
  return counts;
}
