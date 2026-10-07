/**
 * Codex 훅 고정 shim (2026-10-07, 오너 피드백 "매번 trust all 해야 에러가 안 난다").
 *
 * Codex 의 훅 trust 해시는 핸들러 명령 **문자열** 단위다(ADR-016). 이전엔 명령에
 * `node "<nvm>/v22.x/lib/node_modules/@wooojin/forgen/dist/host/codex-adapter.js" "<…>/dist/hooks/x.js"`
 * 처럼 node·패키지 경로가 박혀 있어서 nvm 버전 전환·재설치 위치 변경마다 모든 훅이 `modified` →
 * Codex 가 skip → `/hooks` 에서 다시 trust 해야 했다.
 *
 * 해결: 명령은 버전 무관한 고정 경로 `<CODEX_HOME>/forgen-hook "hooks/x.js" args` 로 쓰고, 실제 위임 대상
 * (node 바이너리·패키지 경로)은 **shim 파일 내용**에 둔다. 설치·업그레이드는 shim 내용만 다시 쓰므로
 * hooks.json 바이트가 그대로 → trust 해시 유지. (shim 도입 직후 1회만 재승인 필요.)
 *
 * POSIX sh 스크립트라 node 프로세스가 추가로 뜨지 않는다(exec). Windows 는 기존 방식 유지.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const SHIM_MARKER = '# forgen-managed codex-hook shim';

/** shim 은 codexHome 아래 — 실환경 `~/.codex/forgen-hook`(고정), 격리 테스트는 임시 codexHome 으로 자동 격리. */
export function codexHookShimPath(codexHome: string): string {
  return path.join(codexHome, 'forgen-hook');
}

/** 소유 판정용 — 명령이 forgen shim 을 가리키는가. */
export const SHIM_COMMAND_RE = /[\\/]forgen-hook"?(?![\w-])/;

export function shimSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function renderShim(pkgRoot: string, nodePath: string): string {
  return [
    '#!/bin/sh',
    SHIM_MARKER,
    '# 설치·업그레이드마다 재작성된다. Codex hooks.json 은 이 파일 경로만 가리키므로 node/패키지 경로가',
    '# 바뀌어도 훅 명령 문자열(= trust 해시)이 그대로 유지된다.',
    `FORGEN_PKG=${shq(pkgRoot)}`,
    `FORGEN_NODE=${shq(nodePath)}`,
    '[ -x "$FORGEN_NODE" ] || FORGEN_NODE=node',
    'rel="$1"; shift',
    'exec "$FORGEN_NODE" "$FORGEN_PKG/dist/host/codex-adapter.js" "$FORGEN_PKG/dist/$rel" "$@"',
    '',
  ].join('\n');
}

/**
 * shim 을 (재)작성. 내용이 같으면 쓰지 않는다. 사용자가 마커를 지운 파일은 덮어쓰지 않는다.
 * 반환: 'written' | 'unchanged' | 'foreign'(사용자 파일) | 'error'.
 */
export function writeCodexHookShim(pkgRoot: string, nodePath: string, shimPath: string): 'written' | 'unchanged' | 'foreign' | 'error' {
  try {
    const content = renderShim(pkgRoot, nodePath);
    if (fs.existsSync(shimPath)) {
      const cur = fs.readFileSync(shimPath, 'utf-8');
      if (cur === content) return 'unchanged';
      if (!cur.includes(SHIM_MARKER)) return 'foreign';
    }
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    const tmp = `${shimPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { mode: 0o755 });
    fs.renameSync(tmp, shimPath);
    return 'written';
  } catch {
    return 'error';
  }
}

/**
 * `node "<root>/host/codex-adapter.js" "<root>/<rel>" args` → `"<shim>" "<rel>" args`.
 * 형태가 다르면(사용자 수정 등) 원문 그대로 반환.
 */
export function toShimCommand(command: string, shimPath: string): string {
  const m = command.match(/^node "(.+?)[\\/]host[\\/]codex-adapter\.js" "(.+?)"(.*)$/s);
  if (!m) return command;
  const [, root, full, rest] = m;
  if (!full.startsWith(`${root}/`) && !full.startsWith(`${root}\\`)) return command;
  const rel = full.slice(root.length + 1);
  return `"${shimPath}" "${rel}"${rest}`;
}

/** 이전 형식 forgen 훅 명령(`node "<…>/dist/host/codex-adapter.js" "<…>/dist/hooks/…"`)인가. */
const LEGACY_FORGEN_CMD_RE = /^node "[^"]*[\\/]dist[\\/]host[\\/]codex-adapter\.js" "[^"]*[\\/]dist[\\/]hooks[\\/][a-z][a-z0-9-]*\.js"/;

export interface ShimMigrationResult {
  status: 'migrated' | 'none' | 'no-hooks-file' | 'shim-foreign' | 'error';
  rewritten: number;
}

/**
 * npm postinstall 용 자동 마이그레이션 (2026-10-07, 오너 피드백 "forgen install codex 도 자동으로").
 * hooks.json 의 **이전 형식 forgen 훅 명령만** 제자리에서 shim 형식으로 바꾸고 shim 을 쓴다.
 * 그룹/훅 순서(= Codex trust 키 `<event>:<groupIdx>:<hookIdx>`)·사용자 훅·config.toml 은 건드리지 않는다.
 * Codex 의 trust 승인 자체는 자동화하지 않는다(보안 정책 우회가 되므로) — 전환 후 마지막 1회만 필요.
 */
export function migrateCodexHooksToShim(codexHome: string, pkgRoot: string, nodePath: string): ShimMigrationResult {
  const hooksPath = path.join(codexHome, 'hooks.json');
  try {
    if (!fs.existsSync(hooksPath)) return { status: 'no-hooks-file', rewritten: 0 };
    const raw = fs.readFileSync(hooksPath, 'utf-8');
    const file = JSON.parse(raw) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    const shimPath = codexHookShimPath(codexHome);
    let rewritten = 0;
    for (const groups of Object.values(file.hooks ?? {})) {
      for (const g of groups ?? []) {
        for (const h of g.hooks ?? []) {
          if (typeof h.command !== 'string' || !LEGACY_FORGEN_CMD_RE.test(h.command)) continue;
          const next = toShimCommand(h.command, shimPath);
          if (next !== h.command) { h.command = next; rewritten += 1; }
        }
      }
    }
    if (rewritten === 0) return { status: 'none', rewritten: 0 };
    const w = writeCodexHookShim(pkgRoot, nodePath, shimPath);
    if (w === 'foreign') return { status: 'shim-foreign', rewritten: 0 };
    if (w === 'error') return { status: 'error', rewritten: 0 };
    fs.copyFileSync(hooksPath, `${hooksPath}.bak-pre-shim`);
    const tmp = `${hooksPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
    fs.renameSync(tmp, hooksPath);
    return { status: 'migrated', rewritten };
  } catch {
    return { status: 'error', rewritten: 0 };
  }
}
