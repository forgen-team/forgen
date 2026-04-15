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
import { type RuntimeHost } from '../core/types.js';

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
  const scriptPath = `${pluginRoot}/${script}`;
  const quotedArgs = args.map(quoteArg).join(' ');

  if (runtime === 'codex') {
    const adapterPath = `${pluginRoot}/host/codex-adapter.js`;
    const baseCommand = `node ${quoteArg(adapterPath)} ${quoteArg(scriptPath)}`;
    return `${baseCommand}${quotedArgs ? ` ${quotedArgs}` : ''}`;
  }

  return quotedArgs
    ? `node ${quoteArg(scriptPath)} ${quotedArgs}`
    : `node ${quoteArg(scriptPath)}`;
}

/**
 * 활성 훅만 포함한 hooks.json 객체를 생성합니다.
 *
 * 동작:
 *   1. 다른 플러그인 감지
 *   2. 충돌 훅 식별
 *   3. hook-config.json 설정 적용
 *   4. 활성 훅만 hooks.json 구조로 변환
 */
export function generateHooksJson(options?: GenerateOptions): HooksJson {
  const cwd = options?.cwd;
  // biome-ignore lint/suspicious/noTemplateCurlyInString: CLAUDE_PLUGIN_ROOT is a Claude Code Plugin SDK variable resolved at runtime
  const pluginRoot = options?.pluginRoot ?? '${CLAUDE_PLUGIN_ROOT}/dist';
  const runtime = options?.runtime ?? 'claude';

  // 다른 플러그인의 충돌 훅 감지
  const hookConflicts = getHookConflicts(cwd);
  const detectedPlugins = detectInstalledPlugins(cwd);
  const hasOtherPlugins = detectedPlugins.length > 0;

  // 활성 훅 필터링
  const activeHooks = HOOK_REGISTRY.filter(hook => {
    // 1) hook-config.json에서 명시적 비활성화
    if (!isHookEnabled(hook.name)) return false;

    // 2) 다른 플러그인과 충돌하는 workflow 훅은 자동 비활성
    //    (단, compound-critical 훅은 항상 유지)
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
