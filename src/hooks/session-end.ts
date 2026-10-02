#!/usr/bin/env node
/**
 * Forgen — SessionEnd Hook (ADR-015 C-G6 Claude, ADR-016 D2 Codex)
 *
 * Claude Code `SessionEnd` (reason: clear|resume|logout|prompt_input_exit|other, 기본 예산 1.5s)
 * 에서 이전 세션 transcript 를 auto-compound 러너에 넘긴다. 기존 트리거(Stop / PreCompact /
 * 다음 SessionStart) 는 Stop 이 안 오는 종료(Ctrl+C, /exit 직후 종료) 와 "마지막 컴팩션 이후
 * 학습" 을 놓쳤다 (memory: forgen-autocompound-gap). runAutoCompound 의 in-flight/cooldown dedup
 * 이 이중 실행을 막는다.
 *
 * - 예산(기본 1.5s, registry timeout 3s 로 상향) 안에 끝나야 하므로: stdin 파싱 → user 메시지 수
 *   (앞 200KB 만 읽음, 대용량 transcript 보호) → detached spawn.
 * - Codex 0.153+ 에도 등록한다 (ADR-016 D2). Codex 의 SessionEnd 는 stdin 이
 *   `session_id`/`transcript_path`/`cwd`/`reason`(항상 "other") 이고 stdout 을 무시하며 타임아웃을 1~3s 로
 *   clamp 한다 — 같은 "bounded count → detached spawn" 경로가 그대로 맞는다. trust 해시가 핸들러 단위라
 *   새 이벤트 추가는 기존 훅의 신뢰를 깨지 않는다 (이 훅 1개만 `/hooks` 승인 필요).
 * - fail-open: 어떤 실패도 종료를 막지 않는다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../core/logger.js';
import { readStdinJSON } from './shared/read-stdin.js';
import { isHookEnabled } from './hook-config.js';
import { approve } from './shared/hook-response.js';
import { recordHookTiming } from './shared/hook-timing.js';

const log = createLogger('session-end');

/** session-recovery 와 동일 임계값 — 짧은 세션은 compound 가치가 없다. */
export const MIN_USER_MESSAGES = 10;

export interface SessionEndInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  reason?: string;
}

/** 앞 N바이트만 읽는 상한. critic 2026-10-01: 239MB transcript 전체 스트리밍은 3.2s → 예산 초과로 SIGKILL. */
export const COUNT_SCAN_BYTES = 200 * 1024;

/**
 * user 메시지 수를 transcript 앞 COUNT_SCAN_BYTES 만 읽어 센다 (session-recovery 와 동일 방식).
 * 임계값(MIN_USER_MESSAGES) 판정에만 쓰이므로 하한 추정으로 충분하다. 큰 transcript 에서도 O(200KB).
 */
export function countUserMessagesBounded(transcriptPath: string, maxBytes: number = COUNT_SCAN_BYTES): number {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const content = buf.toString('utf-8', 0, bytesRead);
    let n = 0;
    for (const line of content.split('\n')) {
      try {
        const t = (JSON.parse(line) as { type?: unknown }).type;
        if (t === 'user' || t === 'queue-operation') n += 1;
      } catch { /* partial last line / non-JSON */ }
    }
    return n;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * host 별 user 메시지 수. Codex rollout 은 스키마가 달라 전용 카운터를 쓴다 (ADR-016 D2 — 실제 사용자
 * 프롬프트만, raw 바이트 스캔). codex-adapter 가 delegate 훅에 FORGEN_RUNTIME=codex 를 주입한다.
 */
export async function countSessionUserMessages(transcriptPath: string, runtime: string | undefined = process.env.FORGEN_RUNTIME): Promise<number> {
  if (runtime === 'codex') {
    const { countCodexUserPrompts } = await import('../host/codex-rollout.js');
    return countCodexUserPrompts(transcriptPath);
  }
  return countUserMessagesBounded(transcriptPath);
}

/** 순수 판정: 이 입력으로 auto-compound 를 띄울지. (테스트 대상) */
export function shouldRunSessionEndCompound(input: SessionEndInput | null, userMessageCount: number): boolean {
  if (!input || typeof input.transcript_path !== 'string' || input.transcript_path.length === 0) return false;
  return userMessageCount >= MIN_USER_MESSAGES;
}

export async function main(): Promise<void> {
  const start = Date.now();
  try {
    const input = await readStdinJSON<SessionEndInput>();
    if (!isHookEnabled('session-end') || !input) {
      console.log(approve());
      return;
    }
    const { runAutoCompound } = await import('../core/spawn.js');
    const transcript = input.transcript_path ?? '';
    let count = 0;
    if (transcript && fs.existsSync(transcript)) {
      try { count = await countSessionUserMessages(transcript); } catch (e) { log.debug('user message count 실패', e); }
    }
    if (shouldRunSessionEndCompound(input, count)) {
      const cwd = input.cwd ?? process.cwd();
      const sessionId = input.session_id ?? path.basename(transcript, '.jsonl');
      const status = runAutoCompound(cwd, transcript, sessionId, count);
      log.debug(`SessionEnd auto-compound: ${status} (reason=${input.reason ?? '?'}, msgs=${count})`);
    }
    console.log(approve());
  } catch (e) {
    log.debug('session-end 실패 (fail-open)', e);
    console.log(approve());
  } finally {
    recordHookTiming('session-end', Date.now() - start, 'SessionEnd');
  }
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.log(approve());
  });
}
