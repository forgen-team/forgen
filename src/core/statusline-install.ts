/**
 * forgen statusline install [--force|--chain] — ~/.claude/settings.json 의 statusLine 을 forgen 으로 (ADR-017 후속, 2026-10-07)
 *
 * 왜 따로 있나: 오너 실측 — 다른 머신에서 statusLine 이 claude-hud 로 잡혀 있어 forgen statusline 이 한 번도 실행되지 않았고,
 * `forgen install claude` 는 사용자 커스텀 statusLine 을 건드리지 않게 돼 있어 손으로 settings.json 을 고쳐야 했다.
 * 또 `forgen statusline` 처럼 PATH 에 의존하면 nvm 버전마다 다른 바이너리(0.4.8)가 잡힌다 → **절대 경로**로 등록한다.
 *
 * 정책:
 *   - statusLine 이 없거나 forgen 소유(`forgen …` / `…/dist/cli.js statusline`)면 → 현재 패키지의 절대 경로로 갱신.
 *   - 커스텀(claude-hud 등)이면 → 기본은 건드리지 않고 안내만. `--force` 면 `statusLine_backup` 에 보관 후 교체.
 *   - `--chain`: 커스텀을 `forgen statusline --after '<원본>'` 으로 감싸 원본 출력 뒤에 forgen 데이터 줄만 덧붙인다(원본은 statusLine_backup).
 *   - 켜져 있는 세션도 settings.json 의 statusLine.command 변경은 즉시 반영된다(Claude Code 가 감시).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgenRunShimPath, isForgenRunCommand, shimSupported } from '../host/claude-shim.js';
import { CLAUDE_DIR } from './paths.js';
import { quoteArg } from '../hooks/hooks-generator.js';

export interface StatusLineInstallResult {
  status: 'installed' | 'updated' | 'unchanged' | 'skipped_custom' | 'error';
  command: string;
  previous?: string;
  backedUp?: boolean;
  message: string;
}

/**
 * statusline 명령. 고정 shim 경유(`"<shim>" "cli.js" statusline`)라 node 버전·패키지 위치와 무관하다.
 * shim 을 못 쓰는 환경(Windows)은 이 패키지 cli.js 절대경로.
 */
export function forgenStatuslineCommand(shimPath: string | null = shimSupported() ? forgenRunShimPath() : null): string {
  if (shimPath) return `${quoteArg(shimPath)} "cli.js" statusline`;
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  return `"${process.execPath}" "${cli}" statusline`;
}

export function isForgenStatusline(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return true; // 없음 = forgen 이 가져가도 됨
  return /^forgen(\s|$)/.test(command.trim()) || /[\\/]dist[\\/]cli\.js"?\s+statusline(\s|$)/.test(command)
    || (isForgenRunCommand(command) && /"?cli\.js"?\s+statusline(\s|$)/.test(command));
}

/**
 * settings 객체의 statusLine 을 제자리에서 갱신(설치·래퍼 공용). 없거나 forgen 소유면 `command` 로,
 * 체인(`… statusline --after '<원본>'`)이면 forgen 부분만 갱신하고 --after 이후는 보존, 커스텀이면 그대로 둔다.
 */
export function applyStatusLineAuto(settings: Record<string, unknown>, command: string): 'installed' | 'updated' | 'unchanged' | 'custom' {
  const existing = (settings.statusLine as { command?: string } | undefined)?.command;
  if (existing && !isForgenStatusline(existing)) return 'custom';
  const chainAt = existing ? String(existing).search(CHAIN_RE) : -1;
  const next = chainAt >= 0 ? `${command}${String(existing).slice(chainAt + ' statusline'.length)}` : command;
  if (existing === next) return 'unchanged';
  settings.statusLine = { type: 'command', command: next };
  return existing ? 'updated' : 'installed';
}

/** POSIX 단일 인용 — 내부 `'` 는 `'\''` 로. `$(…)`·`"`·`\` 도 리터럴로 보존된다. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 원본 statusLine 명령을 `--after` 로 감싼 forgen 체인 명령. */
export function forgenChainCommand(original: string): string {
  return `${forgenStatuslineCommand()} --after ${shQuote(original)}`;
}

const CHAIN_RE = /\sstatusline\s+--after\s/;
export function isChainedStatusline(command: unknown): boolean {
  return typeof command === 'string' && /[\\/"]cli\.js"?\s+statusline\s+--after\s/.test(command);
}

export function installStatusline(opts: { force?: boolean; chain?: boolean; settingsPath?: string } = {}): StatusLineInstallResult {
  const settingsPath = opts.settingsPath ?? path.join(CLAUDE_DIR, 'settings.json');
  const command = forgenStatuslineCommand();
  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch (e) {
    return { status: 'error', command, message: `settings.json 파싱 실패 — 건드리지 않음: ${(e as Error).message}` };
  }
  const existing = settings.statusLine as { type?: string; command?: string } | undefined;
  const previous = existing?.command;

  if (isChainedStatusline(previous) && !(opts.force && !opts.chain)) {
    // 이미 체인 — chain 요청이면 no-op, 일반 install 이면 체인을 풀지 않고 forgen 경로만 갱신(--after 보존).
    const prev = previous as string;
    const next = `${command}${prev.slice(prev.search(CHAIN_RE) + ' statusline'.length)}`;
    if (opts.chain || prev === next) return { status: 'unchanged', command: prev, previous, message: '이미 체인 모드입니다(forgen statusline --after …). 변경 없음.' };
    settings.statusLine = { type: 'command', command: next };
    return writeSettings(settingsPath, settings, next, previous, false);
  }

  if (previous === command) return { status: 'unchanged', command, previous, message: '이미 forgen statusline(절대 경로)입니다.' };

  if (!isForgenStatusline(previous) && opts.chain) {
    const chained = forgenChainCommand(previous as string);
    settings.statusLine_backup = previous;
    settings.statusLine = { type: 'command', command: chained };
    return writeSettings(settingsPath, settings, chained, previous, true);
  }

  if (!isForgenStatusline(previous) && !opts.force) {
    return {
      status: 'skipped_custom', command, previous,
      message: `statusLine 이 다른 명령으로 설정돼 있어 건드리지 않았습니다: ${String(previous).slice(0, 80)}\n  forgen 으로 바꾸려면: forgen statusline install --force  (기존 값은 settings.json 의 statusLine_backup 에 보관)\n  기존 것을 유지한 채 forgen 줄만 뒤에 덧붙이려면: forgen statusline install --chain`,
    };
  }

  let backedUp = false;
  if (!isForgenStatusline(previous) && opts.force) {
    settings.statusLine_backup = previous;
    backedUp = true;
  }
  settings.statusLine = { type: 'command', command };
  return writeSettings(settingsPath, settings, command, previous, backedUp);
}

function writeSettings(settingsPath: string, settings: Record<string, unknown>, command: string, previous: string | undefined, backedUp: boolean): StatusLineInstallResult {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
    const tmp = `${settingsPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
    fs.renameSync(tmp, settingsPath);
  } catch (e) {
    return { status: 'error', command, previous, message: `settings.json 쓰기 실패: ${(e as Error).message}` };
  }
  return {
    status: previous ? 'updated' : 'installed', command, previous, backedUp,
    message: `statusLine → ${command}${backedUp ? '  (기존 값 statusLine_backup 에 보관)' : ''}\n  켜져 있는 세션도 다음 메시지부터 반영됩니다.`,
  };
}

export async function handleStatuslineInstall(args: string[]): Promise<void> {
  const force = args.includes('--force');
  const r = installStatusline({ force, chain: args.includes('--chain') });
  const icon = r.status === 'error' ? '✗' : r.status === 'skipped_custom' ? 'ℹ' : '✓';
  console.log(`${icon} [forgen] ${r.message}`);
  if (r.status === 'error') process.exitCode = 1;
}
