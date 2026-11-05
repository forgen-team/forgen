#!/usr/bin/env node
/**
 * Forgen — Session Recovery Hook
 *
 * Claude Code SessionStart 훅으로 등록.
 * 이전 세션에서 활성화된 지속 모드(ralph, autopilot, ultrawork)의
 * 상태를 복구하여 작업을 자동 재개합니다.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../core/logger.js';

const log = createLogger('session-recovery');
import { atomicWriteJSON } from './shared/atomic-write.js';
import { sanitizeId } from './shared/sanitize-id.js';
import { isHookEnabled } from './hook-config.js';
import { approve, approveWithContext, approveWithWarning, failOpenWithTracking } from './shared/hook-response.js';
import { HANDOFFS_DIR, STATE_DIR } from '../core/paths.js';
import { recordHookTiming } from './shared/hook-timing.js';

export interface Checkpoint {
  sessionId: string;
  mode: string;
  modifiedFiles: string[];
  lastToolCall: string;
  toolCallCount: number;
  timestamp: string;
  cwd: string;
}

/** 체크포인트 저장 */
export function saveCheckpoint(data: Checkpoint): void {
  try {
    const filePath = path.join(STATE_DIR, `checkpoint-${sanitizeId(data.sessionId)}.json`);
    atomicWriteJSON(filePath, data);
  } catch (e) {
    log.debug('체크포인트 저장 실패', e);
  }
}

/** Checkpoint 구조 검증 */
function isValidCheckpoint(data: unknown): data is Checkpoint {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.sessionId === 'string' &&
    typeof d.timestamp === 'string' &&
    typeof d.mode === 'string' &&
    typeof d.cwd === 'string' &&
    Array.isArray(d.modifiedFiles) &&
    typeof d.lastToolCall === 'string' &&
    typeof d.toolCallCount === 'number'
  );
}

/** ModeState 구조 검증 */
function isValidModeState(data: unknown): data is ModeState {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.active === 'boolean' && typeof d.startedAt === 'string';
}

/** 체크포인트 로드 */
export function loadCheckpoint(sessionId: string): Checkpoint | null {
  try {
    const filePath = path.join(STATE_DIR, `checkpoint-${sanitizeId(sessionId)}.json`);
    if (fs.existsSync(filePath)) {
      const data: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!isValidCheckpoint(data)) {
        log.debug('체크포인트 구조 검증 실패', { sessionId });
        return null;
      }
      return data;
    }
  } catch (e) {
    log.debug('체크포인트 로드 실패', e);
  }
  return null;
}

/** 오래된 체크포인트 삭제 */
export function cleanStaleCheckpoints(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  let cleaned = 0;
  try {
    if (!fs.existsSync(STATE_DIR)) return 0;
    const files = fs.readdirSync(STATE_DIR).filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'));
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(STATE_DIR, file);
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!isValidCheckpoint(parsed)) {
          // 구조 검증 실패한 파일도 정리
          try { fs.unlinkSync(filePath); cleaned++; } catch (e) { log.debug(`invalid checkpoint unlink failed: ${filePath}`, e); }
          continue;
        }
        const age = now - new Date(parsed.timestamp).getTime();
        if (age > maxAgeMs) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch {
        // 파싱 실패한 파일도 정리
        try { fs.unlinkSync(filePath); cleaned++; } catch (e) { log.debug(`corrupt checkpoint unlink failed: ${filePath}`, e); }
      }
    }
  } catch (e) {
    log.debug('스테일 체크포인트 정리 실패', e);
  }
  return cleaned;
}

interface ModeState {
  active: boolean;
  startedAt: string;
  prompt?: string;
  sessionId?: string;
  stage?: string;
  completedSteps?: string[];
}

const PERSISTENT_MODES = ['ralph', 'autopilot', 'ultrawork', 'team', 'pipeline'];

interface SessionStartPayload {
  session_id?: string;
  cwd?: string;
}

export function resolveSessionStartContext(rawInput: string): { sessionId: string; cwd: string } {
  const fallbackCwd = process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd();

  try {
    const parsed = JSON.parse(rawInput) as SessionStartPayload;
    return {
      sessionId: parsed.session_id?.trim() || `session-${Date.now()}`,
      cwd: parsed.cwd?.trim() || fallbackCwd,
    };
  } catch {
    return {
      sessionId: `session-${Date.now()}`,
      cwd: fallbackCwd,
    };
  }
}

async function main(): Promise<void> {
  const _hookStart = Date.now();
  try {
  // SessionStart 훅은 stdin으로 세션 정보를 받음 (타임아웃 포함)
  const chunks: string[] = [];
  process.stdin.setEncoding('utf-8');
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      resolve();
    }, 2000);
    process.stdin.on('data', (chunk) => chunks.push(String(chunk)));
    process.stdin.on('end', () => { clearTimeout(timeout); resolve(); });
  });
  const sessionContext = resolveSessionStartContext(chunks.join(''));

  if (!isHookEnabled('session-recovery')) {
    console.log(approve());
    return;
  }

  // 0.4.6 — codex/claude 진입점 양쪽에서 v1-bootstrap 보장.
  // 이전엔 prepareHarness (fgx/forgen wrapper) 만 호출 → 직접 claude/codex 호출 시
  // ~/.forgen/state/sessions/<id>.json 미생성. SessionStart hook 에서도 호출하여
  // 양쪽 진입 경로 모두에서 session state 박제.
  // doctor 프로브(FORGEN_DOCTOR_PROBE=1): 세션 상태 기록·백그라운드 스폰 등 부작용 경로를 건너뛴다.
  const doctorProbe = process.env.FORGEN_DOCTOR_PROBE === '1';
  let v1RenderedRules: string | null = null;
  try {
    if (doctorProbe) throw new Error('doctor probe — 세션 상태 기록 생략');
    const { bootstrapV1Session } = await import('../core/v1-bootstrap.js');
    v1RenderedRules = bootstrapV1Session(sessionContext.cwd).renderedRules;
  } catch (e) { log.debug('v1-bootstrap SessionStart 호출 실패 (fail-open)', e); }

  // 모든 호스트가 같은 경로로 룰을 받는다(ADR-014 D1 확장). 래퍼 없이 실행해도 매 세션 최신 룰이 들어간다.
  const rulesBlock: string | null = await (async () => {
    try {
      const { isCodexRuntime, buildRulesContext } = await import('../host/codex-rules-context.js');
      const { reclaimRenderedRuleFiles } = await import('../core/rendered-rules-manifest.js');
      reclaimRenderedRuleFiles(sessionContext.cwd);
      return await buildRulesContext(sessionContext.cwd, v1RenderedRules, isCodexRuntime() ? 'codex' : 'claude');
    } catch (e) {
      log.debug('rules block 생성 실패 (fail-open)', e);
      return null;
    }
  })();

  if (!fs.existsSync(STATE_DIR)) {
    console.log(approve());
    return;
  }

  // 활성 모드 찾기
  const recoveryMessages: string[] = [];

  for (const mode of PERSISTENT_MODES) {
    const statePath = path.join(STATE_DIR, `${mode}-state.json`);
    if (!fs.existsSync(statePath)) continue;

    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (!isValidModeState(parsed)) {
        log.debug(`상태 파일 구조 검증 실패: ${mode}`);
        continue;
      }
      const state: ModeState = parsed;
      if (!state.active) continue;

      // H6: 키워드로 켜진 모드 상태는 그 세션의 것이다. 다른 세션(새 세션)에 "이전 세션에서 복구됨"으로 주입하면
      // 오너가 요청하지 않은 autopilot/ralph 지시가 새 세션을 지배한다. resume/compact 는 같은 session_id 를 쓰므로
      // 같은 세션일 때만 복구하고, sessionId 가 없거나 다르면 건너뛴다.
      if (!state.sessionId || state.sessionId !== sessionContext.sessionId) {
        log.debug(`${mode} 상태는 다른 세션(${state.sessionId ?? 'unknown'}) 소유 — 복구 주입 생략`);
        continue;
      }

      // 24시간 이상 경과한 상태는 만료
      const startedAt = new Date(state.startedAt).getTime();
      const elapsed = Date.now() - startedAt;
      if (elapsed > 24 * 60 * 60 * 1000) {
        fs.unlinkSync(statePath);
        continue;
      }

      const elapsedMinutes = Math.round(elapsed / 60000);
      // Security: 상태 파일의 사용자 입력을 XML에 삽입하기 전 이스케이프
      const escXml = (s: string) => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c);
      recoveryMessages.push(
        `<compound-recovery mode="${mode}">` +
        `\n${mode} mode from previous session has been recovered.` +
        `\nStarted: ${state.startedAt} (${elapsedMinutes} minutes ago)` +
        (state.prompt ? `\nOriginal request: ${escXml(state.prompt)}` : '') +
        (state.stage ? `\nCurrent stage: ${escXml(state.stage)}` : '') +
        (state.completedSteps?.length ? `\nCompleted steps: ${state.completedSteps.map((s: string) => escXml(s)).join(', ')}` : '') +
        `\n\nContinue the previous work. To stop, type "cancelforgen".` +
        `\n</compound-recovery>`
      );
    } catch (e) {
      log.debug(`상태 파일 파싱 실패`, e);
    }
  }

  // Phase 0: endTime이 없는 이전 세션 backfill (file mtime 기반)
  // 최근 7일 파일만 대상 — 오래된 파일은 무시하여 성능 보장
  try {
    const { SESSIONS_DIR: sessDir } = await import('../core/paths.js');
    if (fs.existsSync(sessDir)) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const sessionFiles = fs.readdirSync(sessDir)
        .filter(f => f.endsWith('.json'))
        .filter(f => {
          try { return fs.statSync(path.join(sessDir, f)).mtimeMs > cutoff; } catch { return false; }
        });
      for (const file of sessionFiles) {
        const fp = path.join(sessDir, file);
        try {
          const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          if (raw.startTime && !raw.endTime) {
            const mtime = fs.statSync(fp).mtime;
            raw.endTime = mtime.toISOString();
            raw.durationMs = mtime.getTime() - new Date(raw.startTime).getTime();
            raw.recoveredEndTime = true;
            atomicWriteJSON(fp, raw);
          }
        } catch { /* individual file recovery failure — skip and continue */ }
      }
    }
  } catch (e) {
    log.debug('세션 endTime backfill 실패', e);
  }

  // 미완료 체크포인트 감지
  try {
    const checkpointFiles = fs.readdirSync(STATE_DIR)
      .filter(f => f.startsWith('checkpoint-') && f.endsWith('.json'));
    for (const file of checkpointFiles) {
      try {
        const parsedCp: unknown = JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), 'utf-8'));
        if (!isValidCheckpoint(parsedCp)) {
          log.debug(`체크포인트 파일 구조 검증 실패: ${file}`);
          continue;
        }
        const cp: Checkpoint = parsedCp;
        const age = Date.now() - new Date(cp.timestamp).getTime();
        if (age > 24 * 60 * 60 * 1000) {
          fs.unlinkSync(path.join(STATE_DIR, file));
          continue;
        }
        const elapsedMin = Math.round(age / 60000);
        const safeSessionId = String(cp.sessionId).replace(/[&"<>]/g, '_');
        const safeLastTool = String(cp.lastToolCall ?? '').replace(/[<>]/g, '_');
        const safeCwd = String(cp.cwd ?? '').replace(/[<>]/g, '_');
        recoveryMessages.push(
          `<compound-checkpoint session="${safeSessionId}">` +
          `\nIncomplete checkpoint found (${elapsedMin} minutes ago)` +
          `\n- Modified files: ${cp.modifiedFiles.length}` +
          `\n- Tool calls: ${cp.toolCallCount}` +
          `\n- Last tool: ${safeLastTool}` +
          `\n- Working directory: ${safeCwd}` +
          `\n</compound-checkpoint>`
        );
      } catch { /* 개별 파일 파싱 실패 무시 */ }
    }
  } catch (e) {
    log.debug('체크포인트 스캔 실패', e);
  }

  // pending-compound 마커 확인 (이전 세션에서 compound loop 필요 표시)
  const pendingPath = path.join(STATE_DIR, 'pending-compound.json');
  if (fs.existsSync(pendingPath)) {
    try {
      const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
      recoveryMessages.push(
        `<compound-pending>` +
        `\nCompound loop was scheduled in the previous session (${pending.promptCount ?? '?'} prompts).` +
        `\nRun \`forgen compound\` to preview, then \`forgen compound --save\` to persist patterns/solutions.` +
        `\n</compound-pending>`
      );
      // 마커 삭제 (한 번만 안내)
      fs.unlinkSync(pendingPath);
    } catch (e) {
      log.debug('pending-compound 마커 읽기 실패', e);
    }
  }

  // 핸드오프 파일 확인
  const handoffDir = HANDOFFS_DIR;
  if (fs.existsSync(handoffDir)) {
    try {
      const handoffs = fs.readdirSync(handoffDir)
        .filter(f => f.endsWith('.md'))
        .sort();

      if (handoffs.length > 0) {
        const latest = handoffs[handoffs.length - 1];
        const latestPath = path.join(handoffDir, latest);
        // Security: symlink 방지 + XML 이스케이프
        if (fs.lstatSync(latestPath).isSymbolicLink()) throw new Error('symlink rejected');
        const raw = fs.readFileSync(latestPath, 'utf-8');
        const safeName = latest.replace(/[&"<>]/g, '_');
        const escaped = raw.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g, m => m.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
        recoveryMessages.push(
          `<compound-handoff file="${safeName}">\n${escaped}\n</compound-handoff>`
        );
        // 마커 삭제 (한 번만 안내 — pending-compound.json과 동일 패턴)
        try { fs.unlinkSync(latestPath); } catch (e) { log.debug('handoff 파일 삭제 실패', e); }
      }
    } catch (e) { log.debug('handoff 파일 읽기 실패', e); }
  }

  // Load latest session brief
  try {
    const briefFiles = fs.readdirSync(HANDOFFS_DIR)
      .filter(f => f.endsWith('-session-brief.json'))
      .sort()
      .reverse();
    if (briefFiles.length > 0) {
      const brief = JSON.parse(fs.readFileSync(path.join(HANDOFFS_DIR, briefFiles[0]), 'utf-8'));
      const briefContext = `Previous session: ${brief.mode || 'general'}, ${brief.promptCount || 0} prompts, ${(brief.modifiedFiles || []).length} files modified, ${(brief.solutionsInjected || []).length} solutions used.`;
      recoveryMessages.push(briefContext);
    }
  } catch { /* fail-open */ }

  // US-M1 (RC6 가드): 직전 forge-loop findings 또는 진행 중 stories 자동 inject.
  // 본 세션 자기증거 — head -80 truncation 으로 findings 누락 → 같은 가설 재발.
  try {
    const { readForgeLoopState, renderForgeLoopForSession } = await import('./shared/forge-loop-state.js');
    const block = renderForgeLoopForSession(readForgeLoopState());
    if (block) recoveryMessages.push(block);
  } catch (e) { log.debug('forge-loop findings inject 실패', e); }

  const sessionId = sessionContext.sessionId;

  // 이전 세션 자동 compound (fire-and-forget)
  // /new로 세션 리셋 시 SessionStart가 다시 호출됨 — 이때 이전 transcript를 compound
  try {
    const cwd = sessionContext.cwd;
    const sanitized = cwd.replace(/\//g, '-');
    const projectDir = path.join(os.homedir(), '.claude', 'projects', sanitized);
    if (fs.existsSync(projectDir)) {
      const transcripts = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && f !== `${sessionId}.jsonl`) // 현재 세션 제외
        .map(f => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      // D9: 직전 1개만 보던 단일 슬롯 판정 대신, 최근 7일 안의 미처리/자란 transcript 를 최대 3개까지 전수 확인한다.
      // 처리 여부는 세션별 러너 기록(sessionNeedsRun: 마지막 실행 이후 transcript 크기)으로 판정 — 길이 게이트 없음.
      // 러너는 승급·인덱싱이 멱등이고 Haiku 는 새 구간만 읽으므로 중복 비용이 없다.
      const { sessionNeedsRun, transcriptSignature } = await import('../core/extraction-queue.js');
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      let spawned = 0;
      for (const t of transcripts) {
        if (spawned >= 3 || doctorProbe) break;
        if (Date.now() - t.mtime > WEEK_MS) break; // mtime 내림차순 — 이후는 더 오래됨
        const prevTranscript = path.join(projectDir, t.name);
        const prevSessionId = t.name.replace('.jsonl', '');
        let size = 0;
        try { size = fs.statSync(prevTranscript).size; } catch { continue; }
        if (size === 0 || !sessionNeedsRun(prevSessionId, size, { sig: transcriptSignature(prevTranscript) })) continue;
        const { spawn: spawnProcess } = await import('node:child_process');
        const autoCompound = spawnProcess(process.execPath, [
          path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'auto-compound-runner.js'),
          cwd, prevTranscript, prevSessionId, '0', 'final',
        ], { detached: true, stdio: 'ignore' });
        autoCompound.unref();
        spawned++;
        log.debug(`이전 세션 auto-compound 시작: ${prevSessionId}`);
      }
      // D4: 새로 처리할 세션이 없어도 대기열(타임아웃·실패로 밀린 추출)에 기한이 된 항목이 있으면 재시도 러너를 띄운다.
      if (spawned === 0 && !doctorProbe) {
        const { readQueue } = await import('../core/extraction-queue.js');
        const now = Date.now();
        if (readQueue().some((e) => e.nextAt <= now && (e.claimedUntil ?? 0) <= now)) {
          const { spawn: spawnProcess } = await import('node:child_process');
          const q = spawnProcess(process.execPath, [
            path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'auto-compound-runner.js'),
            cwd, '-', 'queue-retry',
          ], { detached: true, stdio: 'ignore' });
          q.unref();
        }
      }
    }
  } catch (e) { log.debug('이전 세션 auto-compound 체크 실패', e); }

  // v1: regex 기반 패턴 학습(prompt-learner) 제거. Evidence 기반으로 전환됨.

  // Compound v3: Run lifecycle check once per day
  try {
    const lastLifecyclePath = path.join(STATE_DIR, 'last-lifecycle.json');
    let shouldRun = true;
    try {
      if (fs.existsSync(lastLifecyclePath)) {
        const data = JSON.parse(fs.readFileSync(lastLifecyclePath, 'utf-8'));
        const last = new Date(data.lastRun).getTime();
        shouldRun = Date.now() - last > 24 * 60 * 60 * 1000;
      }
    } catch { /* last-lifecycle.json parse failure — run lifecycle check anyway */ }
    if (shouldRun && !doctorProbe) {
      // B-4: detached background spawn — hook timeout 초과 방지.
      //
      // Audit fix #5 (2026-04-21): prior invocation interpolated
      // `sessionId` into a `-e` template literal
      //   `import('${path}').then(m => m.runLifecycleCheck('${sessionId}'))`
      // which created a code-injection surface (a crafted sessionId
      // could break out of the single quotes and execute arbitrary JS
      // under the user's Claude-Code privileges). The runner was moved
      // to a dedicated script file and the id is now passed via argv —
      // no shell, no eval, no interpolation.
      const runnerPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'internal',
        'run-lifecycle-check.js',
      );
      const { spawn: spawnLifecycle } = await import('node:child_process');
      const lifecycleRunner = spawnLifecycle(process.execPath, [runnerPath, sessionId], {
        detached: true,
        stdio: 'ignore',
      });
      lifecycleRunner.unref();
      const { atomicWriteJSON: writeJSON } = await import('./shared/atomic-write.js');
      writeJSON(lastLifecyclePath, { lastRun: new Date().toISOString() });
    }
  } catch (e) { log.debug('lifecycle check 실패', e); }

  // D2: 최초 1회 Haiku 전송 안내 / 호출 불가 사유 — 사용자 화면(systemMessage)에 보인다.
  let haikuNotice: string | null = null;
  if (!doctorProbe) {
    try {
      const { takeSessionStartNotice } = await import('../core/compound-consent.js');
      haikuNotice = await takeSessionStartNotice();
    } catch (e) { log.debug('Haiku 안내 생성 실패', e); }
  }

  if (rulesBlock || recoveryMessages.length > 0) {
    const { fitSessionContext } = await import('./shared/injection-caps.js');
    console.log(approveWithContext(fitSessionContext(rulesBlock, recoveryMessages), 'SessionStart', haikuNotice ?? undefined));
  } else if (haikuNotice) {
    console.log(approveWithWarning(haikuNotice));
  } else {
    console.log(approve());
  }
  } finally {
    recordHookTiming('session-recovery', Date.now() - _hookStart, 'SessionStart');
  }
}

// ESM main guard: 다른 모듈에서 import 시 main() 실행 방지
// realpathSync로 symlink 해석 (플러그인 캐시가 symlink일 때 경로 불일치 방지)
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[ch-hook] ${e instanceof Error ? e.message : String(e)}\n`);
    console.log(failOpenWithTracking('session-recovery', e));
  });
}
