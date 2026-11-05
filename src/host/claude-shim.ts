/**
 * Claude 고정 shim `<FORGEN_HOME>/bin/forgen-run` (설치 일원화 D1).
 *
 * settings.json 의 hook·statusLine 과 ~/.claude.json 의 MCP 는 이 파일 경로만 가리킨다. 설치 시점의 node 절대경로와
 * 패키지 경로는 shim **내용**에 있어서, Node 전환·재설치는 shim 만 다시 쓰고 settings 는 그대로다.
 * 대상이나 node 를 못 찾으면 호출 종류별로 보이게 실패한다: hook=유효 JSON 경고 + exit 0,
 * MCP=stderr + 비0 종료(stdout JSON 은 프로토콜을 깨뜨린다), statusLine=한 줄 안내.
 * POSIX sh 전용. Windows 는 호출부가 기존 절대경로를 유지한다.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { shimSupported, shq, writeManagedShim } from './codex-hook-shim.js';

export { shimSupported };

export const FORGEN_RUN_MARKER = '# forgen-managed forgen-run shim';
export const REINSTALL_HINT = 'npm i -g @wooojin/forgen  (or: forgen install claude)';

/** FORGEN_HOME 이 있으면 그 아래, 없으면 `<home>/.forgen/bin/forgen-run`. */
export function forgenRunShimPath(homeDir: string = os.homedir()): string {
  const base = process.env.FORGEN_HOME ? path.resolve(process.env.FORGEN_HOME) : path.join(homeDir, '.forgen');
  return path.join(base, 'bin', 'forgen-run');
}

/** 소유 판정용 — 명령이 forgen-run shim 을 가리키는가. */
export function isForgenRunCommand(command: string): boolean {
  return /[\\/]forgen-run"?(\s|$)/.test(command);
}

export function renderForgenRunShim(pkgRoot: string, nodePath: string): string {
  const hookWarn = JSON.stringify({
    continue: true,
    systemMessage: `forgen hooks are not running (target or node not found). Reinstall: ${REINSTALL_HINT}`,
  });
  return [
    '#!/bin/sh',
    FORGEN_RUN_MARKER,
    '# 설치·업그레이드마다 재작성된다. settings.json / ~/.claude.json 은 이 파일 경로만 가리킨다.',
    '# usage: forgen-run <dist 기준 상대경로> [args...]',
    `FORGEN_PKG=${shq(pkgRoot)}`,
    `FORGEN_NODE=${shq(nodePath)}`,
    `FORGEN_HOOK_WARN=${shq(hookWarn)}`,
    'rel="$1"; [ $# -gt 0 ] && shift',
    '[ -x "$FORGEN_NODE" ] || FORGEN_NODE=$(command -v node 2>/dev/null)',
    '# 패키지가 사라졌으면(버전 디렉터리 삭제) PATH 의 forgen 이 속한 prefix 에서 찾는다.',
    'if [ ! -f "$FORGEN_PKG/dist/$rel" ]; then',
    '  f=$(command -v forgen 2>/dev/null)',
    '  if [ -n "$f" ] && [ -f "$(dirname "$f")/../lib/node_modules/@wooojin/forgen/dist/$rel" ]; then',
    '    FORGEN_PKG="$(dirname "$f")/../lib/node_modules/@wooojin/forgen"',
    '  fi',
    'fi',
    'if [ -n "$FORGEN_NODE" ] && [ -f "$FORGEN_PKG/dist/$rel" ]; then',
    '  exec "$FORGEN_NODE" "$FORGEN_PKG/dist/$rel" "$@"',
    'fi',
    'case "$rel" in',
    `  mcp/*) echo "forgen: MCP server not found. Reinstall: ${REINSTALL_HINT}" >&2; exit 1 ;;`,
    '  hooks/*) printf \'%s\\n\' "$FORGEN_HOOK_WARN"; exit 0 ;;',
    `  *) echo "forgen: not found. Reinstall: ${REINSTALL_HINT}"; exit 0 ;;`,
    'esac',
    '',
  ].join('\n');
}

export function writeForgenRunShim(pkgRoot: string, nodePath: string, shimPath: string): 'written' | 'unchanged' | 'foreign' | 'error' {
  return writeManagedShim(shimPath, renderForgenRunShim(pkgRoot, nodePath), FORGEN_RUN_MARKER);
}

/** shim 이 있으면 반환, 쓸 수 없으면(Windows/사용자 파일/쓰기 실패) null → 호출부가 절대경로로 폴백. */
export function ensureForgenRunShim(pkgRoot: string, homeDir: string = os.homedir()): { path: string | null; status: string } {
  if (!shimSupported()) return { path: null, status: 'unsupported' };
  const shimPath = forgenRunShimPath(homeDir);
  const status = writeForgenRunShim(pkgRoot, process.execPath, shimPath);
  return { path: status === 'written' || status === 'unchanged' ? shimPath : null, status };
}
