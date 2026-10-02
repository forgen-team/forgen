/**
 * settings-lock — settings.json 동시접근 보호 유틸리티
 *
 * acquireLock/releaseLock + atomicWriteFileSync 패턴을
 * settings.json을 조작하는 모든 모듈에서 재사용합니다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './logger.js';
import { CLAUDE_DIR, SETTINGS_PATH } from './paths.js';

const log = createLogger('settings-lock');

export { CLAUDE_DIR, SETTINGS_PATH };
export const SETTINGS_BACKUP_PATH = path.join(CLAUDE_DIR, 'settings.json.forgen-backup');
const SETTINGS_LOCK_PATH = path.join(CLAUDE_DIR, 'settings.json.lock');

/** lockfile 내용에서 pid 추출 */
function readLockPid(): number | null {
  try {
    const content = fs.readFileSync(SETTINGS_LOCK_PATH, 'utf-8').trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** 프로세스가 살아있는지 확인 (signal 0 전송) */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** settings.json 쓰기 경로가 락으로 보호받지 못할 때 던지는 오류. */
export class SettingsLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsLockError';
  }
}

/**
 * lockfile 획득 (최대 3초 대기, 100ms 간격 재시도).
 *
 * Audit fix #1 (2026-04-21): 이전 구현은 타임아웃 후 기존 holder가
 * **살아있어도** 무조건 `writeFileSync`로 PID를 덮어써 동시 쓰기를 유발했다.
 * 주석은 "보류"라고 되어있었지만 코드는 그렇지 않았다. 이제:
 *   - holder가 살아있으면 `SettingsLockError`를 throw (쓰기 중단)
 *   - holder가 죽었을 때만 stale recovery로 강제 획득
 * 호출자는 락 실패 시 사용자 작업을 망치지 않도록 merge 결과를 버릴 책임을 진다.
 */
export function acquireLock(): void {
  const maxWaitMs = 3000;
  const intervalMs = 100;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      fs.writeFileSync(SETTINGS_LOCK_PATH, String(process.pid), { flag: 'wx' });
      return; // 성공
    } catch {
      // lock 파일이 이미 존재 — 대기 후 재시도
      const elapsed = Date.now() - start;
      if (elapsed + intervalMs >= maxWaitMs) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
    }
  }
  // 타임아웃: lock을 잡고 있는 프로세스가 살아있는지 확인
  const lockPid = readLockPid();
  if (lockPid !== null && isProcessAlive(lockPid)) {
    log.warn(`lockfile 타임아웃 — pid ${lockPid} 프로세스가 활성 상태, 쓰기 중단`);
    throw new SettingsLockError(
      `Could not acquire settings.json lock: another forgen process (pid ${lockPid}) is actively writing`,
    );
  }
  log.debug(`lockfile stale lock 감지 — pid ${lockPid ?? 'unknown'} 종료됨, 회수`);
  fs.writeFileSync(SETTINGS_LOCK_PATH, String(process.pid));
}

/**
 * lockfile 해제.
 *
 * Audit fix #1 (2026-04-21): 이전에는 ownership 확인 없이 `rmSync`로
 * 다른 프로세스의 lock도 지울 수 있었다 (cascade lock loss). 이제 lock
 * 파일의 PID가 내 PID와 일치할 때만 삭제한다. 불일치 시 조용히 no-op —
 * 정상 케이스에서는 내 PID만 존재하므로 영향 없음, 비정상 경합 시에는
 * 다른 프로세스의 lock을 존중한다.
 */
export function releaseLock(): void {
  try {
    const ownerPid = readLockPid();
    if (ownerPid !== null && ownerPid !== process.pid) {
      log.debug(`releaseLock: pid ${ownerPid} owns the lock, not me (${process.pid}) — no-op`);
      return;
    }
    fs.rmSync(SETTINGS_LOCK_PATH, { force: true });
  } catch { /* 이미 없으면 무시 */ }
}

/**
 * 임시파일에 쓴 후 rename으로 원자적 교체.
 *
 * 0.5.7 (critic): 기존 파일의 권한과 심링크를 보존한다. 이전엔 새 파일을 기본 mode(0644)로 만들어 rename 해서
 * 0600 이던 `~/.claude.json`(MCP env 에 비밀값이 들어갈 수 있다)이 0644 로 넓어졌고, 심링크였으면 링크가
 * 일반 파일로 바뀌고 원본은 갱신되지 않았다.
 */
export function atomicWriteFileSync(targetPath: string, data: string): void {
  let realTarget = targetPath;
  let mode: number | undefined;
  try {
    realTarget = fs.realpathSync(targetPath);
    mode = fs.statSync(realTarget).mode & 0o777;
  } catch { /* 새 파일 — 기본 mode */ }
  const tmpPath = `${realTarget}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, data, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined) fs.chmodSync(tmpPath, mode); // umask 로 깎였을 수 있어 명시
  fs.renameSync(tmpPath, realTarget);
}

/**
 * settings.json 안전 읽기.
 * 파일이 없으면 빈 객체 반환. 파싱 실패 시 Error throw (빈 설정 덮어쓰기 방지).
 */
export function readSettings(): Record<string, unknown> {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
  return JSON.parse(raw); // 파싱 실패 시 throw → 호출자가 처리
}

/**
 * settings.json 안전 읽기 + 손상본 보존.
 *
 * 2026-04-21 audit (finding #2, #10): `readSettingsWithBackup`가 parse
 * 실패 시 silent `{}` 반환했고, 이후 merged write가 사용자 원본을 덮어써서
 * 데이터 손실 경로가 됐다. 이제 파싱 실패 시 원본을 `.corrupt-<ts>` 로
 * 별도 보존 후 예외를 던진다 — 호출자가 덮어쓰기를 중단할 수 있도록.
 *
 * Fallthrough: 파일 없음 → `{}`. IO 실패 → throw. Parse 실패 → 손상본
 * 보존 후 throw.
 */
export function readSettingsSafely(): Record<string, unknown> {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    const corruptPath = `${SETTINGS_PATH}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(SETTINGS_PATH, corruptPath);
      log.warn(`settings.json parse 실패 — 손상본을 ${corruptPath}로 보존 후 쓰기 중단`);
    } catch (copyErr) {
      log.warn(`settings.json parse 실패 + 손상본 보존 실패 — 쓰기 중단`, copyErr);
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** settings.json 안전 쓰기. backup 생성 + lock + atomic write */
export function writeSettings(settings: Record<string, unknown>): void {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  acquireLock();
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      fs.copyFileSync(SETTINGS_PATH, SETTINGS_BACKUP_PATH);
    }
    atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } finally {
    releaseLock();
  }
}

/** settings.json.forgen-backup 파일에서 원본 복원 */
export function rollbackSettings(): boolean {
  if (!fs.existsSync(SETTINGS_BACKUP_PATH)) return false;
  acquireLock();
  try {
    // 현재 설정을 rollback 전 백업 (.pre-rollback) — 데이터 손실 방지
    if (fs.existsSync(SETTINGS_PATH)) {
      const preRollbackPath = `${SETTINGS_PATH}.pre-rollback`;
      fs.copyFileSync(SETTINGS_PATH, preRollbackPath);
    }
    const backup = fs.readFileSync(SETTINGS_BACKUP_PATH, 'utf-8');
    atomicWriteFileSync(SETTINGS_PATH, backup);
    fs.rmSync(SETTINGS_BACKUP_PATH);
    return true;
  } catch {
    return false;
  } finally {
    releaseLock();
  }
}
