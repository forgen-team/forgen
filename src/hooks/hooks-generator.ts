/**
 * Forgen — Dynamic hooks.json Generator
 *
 * hook-registry + hook-config + plugin-detector를 조합하여
 * hooks/hooks.json을 동적으로 생성합니다.
 *
 * 생성 시점:
 *   - postinstall (npm install 후)
 *   - forgen config hooks (사용자 설정 변경 후)
 *   - forgen install (플러그인 설치 후)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOOK_REGISTRY, type HookEntry, type HookEventType } from './hook-registry.js';
import { isHookEnabled } from './hook-config.js';
import { detectInstalledPlugins, getHookConflicts } from '../core/plugin-detector.js';
import type { RuntimeHost } from '../core/types.js';
import { getHostRuntime } from '../host/host-runtime.js';

// ── 타입 ──

interface HookCommand {
  type: 'command';
  command: string;
  timeout: number;
}

interface HookMatcher {
  matcher: string;
  hooks: HookCommand[];
}

interface HooksJson {
  description: string;
  hooks: Record<string, HookMatcher[]>;
}

// ── 생성 로직 ──

interface GenerateOptions {
  /** 프로젝트 cwd (플러그인 감지에 사용) */
  cwd?: string;
  /** 훅 실행 스크립트의 루트 경로 */
  pluginRoot?: string;
  /** 런타임 (claude|codex) */
  runtime?: RuntimeHost;
  /**
   * 환경 독립 산출물 모드 (W4, 2026-04-27).
   * true 시 plugin 감지 + hook-config 비활성화 모두 건너뛰어 모든 hook 이 active.
   * 배포(prepack), 테스트 결정론, runtime 환경 분리에 사용.
   */
  releaseMode?: boolean;
}

function splitCommand(raw: string): { script: string; args: string[] } {
  const tokens = raw.match(/"([^"]+)"|\S+/g) ?? [];
  const unquoted = tokens.map(token => token.replace(/^"/, '').replace(/"$/, ''));
  return { script: unquoted[0] ?? '', args: unquoted.slice(1) };
}

function quoteArg(raw: string): string {
  return `"${raw.replace(/"/g, '\\"')}"`;
}

function buildHookCommand(pluginRoot: string, rawScript: string, runtime: RuntimeHost): string {
  const { script, args } = splitCommand(rawScript);
  const quotedArgs = args.map(quoteArg).join(' ');
  // Phase 2: host-runtime 위임 — Codex 표면 (codex-adapter 경유) 을 core 가 모르도록.
  return getHostRuntime(runtime).wrapHookCommand(pluginRoot, script, quotedArgs);
}

/**
 * 활성 훅만 포함한 hooks.json 객체를 생성합니다.
 *
 * 동작:
 *   1. 다른 플러그인 감지
 *   2. 충돌 훅 식별
 *   3. hook-config.json 설정 적용
 *   4. 활성 훅만 hooks.json 구조로 변환
 *
 * releaseMode: 환경 독립 산출물 모드 (W4, 2026-04-27).
 *   - true 시 plugin 감지를 건너뛰고, hook-config.json 의 사용자 비활성화도 무시한다.
 *   - 결과는 항상 모든 hook active — 배포 산출물 결정론화 + 테스트 안정화.
 *   - prepack-hooks.cjs 는 이미 HOME swap 으로 같은 효과를 내지만, 본 옵션은
 *     명시적 API 로 동일 보장을 제공해 테스트가 환경 독립 검증 가능.
 *   - 자기증거: 본 세션이 사용자 HOME 에서 19/21 active 산출물을 받아 우회한
 *     사례 — docs/issues/W4-W5-self-evidence.md 박제.
 */
export function generateHooksJson(options?: GenerateOptions): HooksJson {
  const cwd = options?.cwd;
  const releaseMode = options?.releaseMode ?? false;
  // biome-ignore lint/suspicious/noTemplateCurlyInString: CLAUDE_PLUGIN_ROOT is a Claude Code Plugin SDK variable resolved at runtime
  const pluginRoot = options?.pluginRoot ?? '${CLAUDE_PLUGIN_ROOT}/dist';
  const runtime = options?.runtime ?? 'claude';

  // 다른 플러그인의 충돌 훅 감지 — releaseMode 시 건너뜀
  const hookConflicts = releaseMode ? new Set<string>() : getHookConflicts(cwd);
  const hasOtherPlugins = !releaseMode && detectInstalledPlugins(cwd).length > 0;

  // 활성 훅 필터링
  const activeHooks = HOOK_REGISTRY.filter(hook => {
    // 1) hook-config.json에서 명시적 비활성화 (releaseMode 시 무시)
    if (!releaseMode && !isHookEnabled(hook.name)) return false;

    // 2) 다른 플러그인과 충돌하는 workflow 훅은 자동 비활성
    //    (단, compound-critical 훅은 항상 유지. releaseMode 면 분기 조건이 false)
    if (hasOtherPlugins && hook.tier === 'workflow' && hookConflicts.has(hook.name) && !hook.compoundCritical) {
      return false;
    }

    return true;
  });

  // 이벤트별로 그룹핑
  const byEvent = new Map<HookEventType, HookEntry[]>();
  for (const hook of activeHooks) {
    const list = byEvent.get(hook.event) ?? [];
    list.push(hook);
    byEvent.set(hook.event, list);
  }

  // hooks.json 구조 생성 — matcher별로 그룹핑 (best practice: 도구 필터링)
  const hooks: Record<string, HookMatcher[]> = {};
  for (const [event, entries] of byEvent) {
    // 같은 matcher끼리 그룹핑
    const byMatcher = new Map<string, typeof entries>();
    for (const h of entries) {
      const m = h.matcher ?? '*';
      const group = byMatcher.get(m) ?? [];
      group.push(h);
      byMatcher.set(m, group);
    }
    hooks[event] = [...byMatcher.entries()].map(([matcher, matcherEntries]) => ({
      matcher,
      hooks: matcherEntries.map(h => {
        const command = buildHookCommand(pluginRoot, h.script, runtime);
        return { type: 'command' as const, command, timeout: h.timeout };
      }),
    }));
  }

  return {
    description: `Forgen harness hooks (auto-generated, ${activeHooks.length}/${HOOK_REGISTRY.length} active)`,
    hooks,
  };
}

/**
 * hooks.json 파일을 생성하여 저장합니다.
 * @returns 생성된 훅 수와 비활성화된 훅 수
 */
export function writeHooksJson(hooksDir: string, options?: GenerateOptions): { active: number; disabled: number } {
  const json = generateHooksJson(options);

  // 활성 훅 수 계산
  let active = 0;
  for (const matchers of Object.values(json.hooks)) {
    for (const m of matchers) active += m.hooks.length;
  }
  const disabled = HOOK_REGISTRY.length - active;

  const outputPath = path.join(hooksDir, 'hooks.json');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(json, null, 2)}\n`);

  return { active, disabled };
}
