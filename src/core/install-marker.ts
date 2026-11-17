/**
 * 설치 마무리(postinstall) 실행 여부 표식과 자동 보완.
 *
 * npm 11 은 전역 설치에서도 설치 스크립트를 기본으로 건너뛸 수 있다(`npm warn install-scripts`).
 * 그러면 `npm i -g @wooojin/forgen` 업그레이드 후 hook·스킬 갱신과 1회 마이그레이션이 조용히 빠진다.
 * postinstall 은 끝까지 성공하면 `~/.forgen/state/installed-version` 에 패키지 버전을 남긴다.
 * 표식이 지금 패키지 버전과 다르면 설치 마무리가 안 된 것으로 보고
 *   - SessionStart: postinstall 을 백그라운드로 실행(같은 버전은 6시간에 한 번만 시도)
 *   - doctor: 실패 항목으로 표시, `--repair` 가 postinstall 을 직접 실행
 * 한다. 저장소 체크아웃(.git)은 postinstall 이 사용자 설정을 건드리지 않으므로 대상이 아니다.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SELF_SETUP_RETRY_MS = 6 * 60 * 60 * 1000;

function forgenHome(): string {
  return process.env.FORGEN_HOME ? path.resolve(process.env.FORGEN_HOME) : path.join(os.homedir(), '.forgen');
}
export function installedVersionPath(home: string = forgenHome()): string {
  return path.join(home, 'state', 'installed-version');
}
function attemptPath(home: string): string {
  return path.join(home, 'state', 'self-setup-attempt.json');
}

/** 실행 중인 패키지 루트 (dist/core/install-marker.js 기준 두 단계 위) */
export function currentPkgRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}
export function packageVersion(pkgRoot: string = currentPkgRoot()): string | null {
  try { return String(JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8')).version); } catch { return null; }
}
export function readInstalledVersion(home: string = forgenHome()): string | null {
  try { return fs.readFileSync(installedVersionPath(home), 'utf-8').trim() || null; } catch { return null; }
}

export interface SetupState {
  /** 표식이 지금 패키지 버전과 다르다 (설치 마무리가 필요) */
  pending: boolean;
  pkgVersion: string | null;
  installed: string | null;
  /** 저장소 체크아웃 등 자동 보완 대상이 아님 */
  skip?: string;
}

export function setupState(pkgRoot: string = currentPkgRoot(), home: string = forgenHome()): SetupState {
  const pkgVersion = packageVersion(pkgRoot);
  const installed = readInstalledVersion(home);
  if (fs.existsSync(path.join(pkgRoot, '.git'))) return { pending: false, pkgVersion, installed, skip: 'repo checkout' };
  if (!fs.existsSync(path.join(pkgRoot, 'scripts', 'postinstall.js'))) return { pending: false, pkgVersion, installed, skip: 'no postinstall script' };
  if (process.env.FORGEN_SKIP_POSTINSTALL === '1') return { pending: false, pkgVersion, installed, skip: 'FORGEN_SKIP_POSTINSTALL' };
  return { pending: !!pkgVersion && installed !== pkgVersion, pkgVersion, installed };
}

function postinstallEnv(): NodeJS.ProcessEnv {
  // postinstall 은 npm_config_global 이 없으면 "프로젝트 의존성 설치"로 보고 아무것도 하지 않는다.
  return { ...process.env, npm_config_global: 'true', FORGEN_SELF_SETUP: '1' };
}

/**
 * SessionStart 용: 설치 마무리가 필요하면 postinstall 을 detached 로 띄운다.
 * 같은 버전은 SELF_SETUP_RETRY_MS 안에 다시 시도하지 않는다(실패가 반복돼도 세션마다 돌지 않게).
 * 띄웠으면 true.
 */
export function maybeStartSelfSetup(opts: { pkgRoot?: string; home?: string; now?: number } = {}): boolean {
  const pkgRoot = opts.pkgRoot ?? currentPkgRoot();
  const home = opts.home ?? forgenHome();
  const now = opts.now ?? Date.now();
  const st = setupState(pkgRoot, home);
  if (!st.pending) return false;
  try {
    const prev = JSON.parse(fs.readFileSync(attemptPath(home), 'utf-8')) as { version?: string; at?: number };
    if (prev.version === st.pkgVersion && typeof prev.at === 'number' && now - prev.at < SELF_SETUP_RETRY_MS) return false;
  } catch { /* 시도 기록 없음 */ }
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(attemptPath(home), JSON.stringify({ version: st.pkgVersion, at: now }));
  let log: number | 'ignore' = 'ignore';
  try { log = fs.openSync(path.join(home, 'state', 'self-setup.log'), 'w'); } catch { /* 로그 없이 진행 */ }
  const child = spawn(process.execPath, [path.join(pkgRoot, 'scripts', 'postinstall.js')], {
    detached: true,
    stdio: ['ignore', log, log],
    env: postinstallEnv(),
    cwd: os.homedir(),
  });
  child.unref();
  if (typeof log === 'number') { try { fs.closeSync(log); } catch { /* ignore */ } }
  return true;
}

/** doctor --repair 용: postinstall 을 동기로 실행한다. 성공 여부는 호출부가 표식으로 재검증한다. */
export function runSetupNow(pkgRoot: string = currentPkgRoot()): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [path.join(pkgRoot, 'scripts', 'postinstall.js')], {
    env: postinstallEnv(), cwd: os.homedir(), encoding: 'utf-8', timeout: 120_000,
  });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
