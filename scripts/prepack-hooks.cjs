#!/usr/bin/env node
/**
 * prepack — regenerate hooks/hooks.json in a CLEAN environment before
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
 *   This script fixes that by forcing `writeHooksJson` into a clean
 *   tmp-HOME env where `detectInstalledPlugins` finds nothing, so
 *   the shipped file is always the pristine full-hooks baseline.
 *
 * Runs automatically on `npm pack` / `npm publish` via the `prepack`
 * script in package.json. Safe to run manually.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  // Set HOME to a throwaway empty tmp dir so `detectInstalledPlugins`
  // can't find any plugin caches. Keep the original HOME restored in
  // `finally` so we don't leak state.
  const originalHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-prepack-hooks-'));
  process.env.HOME = tmpHome;

  // P1-C1: plugin.json version을 package.json에 맞춤 (두 배포 포맷 단일 소스화)
  syncPluginVersion();

  try {
    // Dist must exist. npm 7+ runs `prepack` BEFORE `prepare`, so we
    // can't rely on `prepare` building dist — package.json's `prepack`
    // script runs `npm run build` first before invoking this file.
    const distHooksGenerator = path.resolve(__dirname, '..', 'dist', 'hooks', 'hooks-generator.js');
    if (!fs.existsSync(distHooksGenerator)) {
      console.error(`[forgen prepack] ${distHooksGenerator} not found. Run 'npm run build' first.`);
      process.exit(1);
    }

    const { writeHooksJson } = await import(distHooksGenerator);
    const hooksDir = path.resolve(__dirname, '..', 'hooks');
    // W4 (2026-04-27): releaseMode=true 명시. HOME swap 도 유지하여 double safety.
    // releaseMode 단독으로도 결정론 보장하지만, 기존 HOME swap 관성으로 인한 임의
    // 재발을 막기 위해 두 layer 모두 사용.
    const result = writeHooksJson(hooksDir, { cwd: tmpHome, releaseMode: true });

    const hookRegistry = require(path.resolve(__dirname, '..', 'dist', 'hooks', 'hook-registry.js'));
    const expectedActive = hookRegistry.HOOK_REGISTRY.length;

    if (result.active !== expectedActive) {
      console.error(
        `[forgen prepack] ERROR: generated hooks.json has ${result.active}/${expectedActive} active. ` +
        `This means the clean-env regeneration still found a plugin conflict, which should be impossible. ` +
        `Abort the publish and investigate HOME=${tmpHome}.`,
      );
      process.exit(1);
    }

    console.log(`[forgen prepack] hooks/hooks.json regenerated in clean env (${result.active}/${expectedActive} active)`);
  } finally {
    process.env.HOME = originalHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

main().catch(err => {
  console.error(`[forgen prepack] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
