#!/usr/bin/env node
/**
 * prepack — regenerate hooks/hooks.json deterministically before
 * `npm pack` / `npm publish`.
 *
 * Why this exists:
 *   `hooks/hooks.json` is gitignored (postinstall regenerates it
 *   per-user) but IS included in the npm tarball via package.json's
 *   `files:` field. If the publisher's local env has a conflicting
 *   Claude Code plugin installed (e.g. `oh-my-claudecode` or
 *   `superpowers`), their postinstall rewrites hooks.json with some
 *   hooks auto-disabled, and that tarball ships with a stale
 *   "17/19 active" hooks.json — every user who installs gets the
 *   broken version until they manually run regeneration.
 *
 *   v0.4.2 (W4): `generateHooksJson({ releaseMode: true })` 옵션이
 *   plugin 감지 + hook-config 비활성화를 모두 무시하므로 환경 의존성이
 *   API 차원에서 제거됨. 본 스크립트는 명시적 releaseMode 호출로 단순화.
 *   (이전 HOME swap 우회는 v0.4.1 까지의 임시방편이었고, releaseMode 가
 *   같은 보장을 더 명시적으로 제공.)
 *
 * Runs automatically on `npm pack` / `npm publish` via the `prepack`
 * script in package.json. Safe to run manually.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// P1-C1 fix (2026-04-20): plugin.json version을 package.json의 version으로 동기화.
// 과거에는 package.json v0.3.1 vs plugin.json v5.1.2로 최초 커밋부터 분리된 버전
// 계보가 있었고, Claude Code Plugin SDK가 plugin.json 버전으로 업데이트 감지를
// 할 경우 0.3.0→0.3.1이 "변경 없음"으로 인식될 수 있었다. prepack/publish 시에만
// 주입하므로 dev 수정 흐름에는 영향 없음.
function syncPluginVersion() {
  const pkg = require(path.resolve(__dirname, '..', 'package.json'));
  const targetVersion = pkg.version;
  const pluginFiles = [
    path.resolve(__dirname, '..', 'plugin.json'),
    path.resolve(__dirname, '..', '.claude-plugin', 'plugin.json'),
  ];
  for (const pluginPath of pluginFiles) {
    if (!fs.existsSync(pluginPath)) continue;
    const original = fs.readFileSync(pluginPath, 'utf-8');
    const data = JSON.parse(original);
    if (data.version === targetVersion) continue;
    data.version = targetVersion;
    fs.writeFileSync(pluginPath, JSON.stringify(data, null, 2) + '\n');
    console.log(`[forgen prepack] ${path.basename(path.dirname(pluginPath))}/plugin.json version → ${targetVersion}`);
  }
}

async function main() {
  // P1-C1: plugin.json version을 package.json에 맞춤 (두 배포 포맷 단일 소스화)
  syncPluginVersion();

  // Dist must exist. npm 7+ runs `prepack` BEFORE `prepare`, so we
  // can't rely on `prepare` building dist — package.json's `prepack`
  // script runs `npm run build` first before invoking this file.
  const distHooksGenerator = path.resolve(__dirname, '..', 'dist', 'hooks', 'hooks-generator.js');
  if (!fs.existsSync(distHooksGenerator)) {
    console.error(`[forgen prepack] ${distHooksGenerator} not found. Run 'npm run build' first.`);
    process.exit(1);
  }

  // Windows ESM 호환: 절대경로 import 는 file:// URL 이어야 함 ('d:' protocol 거부).
  const { writeHooksJson } = await import(pathToFileURL(distHooksGenerator).href);
  const hooksDir = path.resolve(__dirname, '..', 'hooks');
  // W4 (v0.4.2): releaseMode=true 가 plugin 감지 + hook-config 비활성화 모두
  // 무시. 환경변수 swap 없이 명시적 API 로 결정론 보장.
  const result = writeHooksJson(hooksDir, { releaseMode: true });

  const hookRegistry = require(path.resolve(__dirname, '..', 'dist', 'hooks', 'hook-registry.js'));
  const expectedActive = hookRegistry.HOOK_REGISTRY.length;

  if (result.active !== expectedActive) {
    console.error(
      `[forgen prepack] ERROR: generated hooks.json has ${result.active}/${expectedActive} active. ` +
      `releaseMode=true 가 모든 hook 을 active 로 만들어야 하는데 그렇지 않음 — generator 결함. ` +
      `Abort the publish.`,
    );
    process.exit(1);
  }

  console.log(`[forgen prepack] hooks/hooks.json regenerated (releaseMode, ${result.active}/${expectedActive} active)`);
}

main().catch(err => {
  console.error(`[forgen prepack] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
