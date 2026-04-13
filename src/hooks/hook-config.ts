/**
 * Forgen — Hook Config Loader
 *
 * hook-config.json 에서 훅별 설정을 읽어 반환합니다.
 * 파일이 없거나 읽기에 실패하면 null 을 반환합니다 (failure-tolerant).
 *
 * 설정 로딩 우선순위:
 *   1. 프로젝트 레벨: {cwd}/.forgen/hook-config.json
 *   2. 글로벌 레벨: FORGEN_HOME/hook-config.json (~/.forgen/hook-config.json)
 *   프로젝트 설정은 글로벌 설정과 머지됩니다 (훅 단위 오버라이드).
 *   프로젝트 설정이 없으면 글로벌 설정만 사용 (하위호환).
 *
 * cwd 결정: process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd()
 *
 * 설정 형식 (hook-config.json):
 * {
 *   "tiers": { "compound-core": { "enabled": true }, "safety": { "enabled": true }, "workflow": { "enabled": true } },
 *   "hooks": { "hookName": { "enabled": false, ...customConfig } },
 *   "hookName": { "enabled": false }  // 레거시 호환 (hooks 키 없이 직접 지정)
 * }
 *
 * 안전 보장:
 *   - compound-core 티어는 tiers 설정으로 비활성화 불가 (복리화 보호)
 *   - 개별 hooks.hookName.enabled: false 로만 비활성화 가능
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOOK_REGISTRY } from './hook-registry.js';
import { FORGEN_HOME } from '../core/paths.js';

/** 훅 설정 파일의 전체 구조 타입 */
export type HookConfig = Record<string, unknown>;

const GLOBAL_CONFIG_PATH = path.join(FORGEN_HOME, 'hook-config.json');

/**
 * 훅 → 티어 매핑 (hook-registry.ts에서 자동 파생).
 * 이중 구현 방지: HOOK_REGISTRY가 단일 소스 오브 트루스.
 */
const HOOK_TIER_MAP: Record<string, 'compound-core' | 'safety' | 'workflow'> =
  Object.fromEntries(HOOK_REGISTRY.map(h => [h.name, h.tier]));

/**
 * 프로젝트의 작업 디렉토리를 결정합니다.
 * FORGEN_CWD → COMPOUND_CWD → process.cwd() 순서.
 */
export function resolveProjectCwd(): string {
  return process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd();
}

/** JSON 파일을 파싱하여 반환. 파일 없음 또는 파싱 실패 시 null. */
function loadJsonFile(filePath: string): HookConfig | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HookConfig;
  } catch {
    return null;
  }
}

/**
 * 글로벌 설정과 프로젝트 설정을 머지합니다.
 * 프로젝트 설정이 글로벌 설정을 훅 단위로 오버라이드합니다.
 *
 * 머지 규칙:
 *   - tiers: 프로젝트가 글로벌을 훅 단위로 오버라이드 (shallow merge)
 *   - hooks: 프로젝트가 글로벌을 훅 단위로 오버라이드 (shallow merge)
 *   - 최상위 레거시 키: 프로젝트가 글로벌을 키 단위로 오버라이드
 *   - 프로젝트에 없는 키는 글로벌에서 상속
 */
export function mergeHookConfigs(global: HookConfig, project: HookConfig): HookConfig {
  const merged: HookConfig = { ...global };

  // tiers 머지 (shallow per-tier)
  const globalTiers = global.tiers as Record<string, Record<string, unknown>> | undefined;
  const projectTiers = project.tiers as Record<string, Record<string, unknown>> | undefined;
  if (globalTiers || projectTiers) {
    merged.tiers = { ...globalTiers, ...projectTiers };
  }

  // hooks 머지 (shallow per-hook)
  const globalHooks = global.hooks as Record<string, Record<string, unknown>> | undefined;
  const projectHooks = project.hooks as Record<string, Record<string, unknown>> | undefined;
  if (globalHooks || projectHooks) {
    merged.hooks = { ...globalHooks, ...projectHooks };
  }

  // 나머지 최상위 키: 프로젝트가 글로벌을 오버라이드
  for (const key of Object.keys(project)) {
    if (key === 'tiers' || key === 'hooks') continue;
    merged[key] = project[key];
  }

  return merged;
}

/** 프로세스 내 설정 캐시 (각 훅은 별도 프로세스이므로 수명 = 1회 실행) */
let _configCache: HookConfig | null | undefined;

/** 전체 설정 파일을 파싱합니다 (글로벌 + 프로젝트 머지). 실패 시 null. 프로세스 내 캐싱. */
function loadFullConfig(): HookConfig | null {
  if (_configCache !== undefined) return _configCache;

  const globalConfig = loadJsonFile(GLOBAL_CONFIG_PATH);
  const projectConfigPath = path.join(resolveProjectCwd(), '.forgen', 'hook-config.json');
  const projectConfig = loadJsonFile(projectConfigPath);

  if (!globalConfig && !projectConfig) {
    _configCache = null;
    return null;
  }

  if (globalConfig && projectConfig) {
    _configCache = mergeHookConfigs(globalConfig, projectConfig);
  } else {
    _configCache = globalConfig ?? projectConfig ?? null;
  }

  return _configCache;
}

/** 특정 훅의 설정을 반환합니다. 실패 시 null 반환. */
export function loadHookConfig(hookName: string): Record<string, unknown> | null {
  const all = loadFullConfig();
  if (!all) return null;

  // v2 형식: hooks.hookName
  const hooksSection = all.hooks as Record<string, Record<string, unknown>> | undefined;
  if (hooksSection?.[hookName]) return hooksSection[hookName];

  // 레거시 형식: 최상위에 hookName 직접 지정
  const legacy = all[hookName] as Record<string, unknown> | undefined;
  return legacy ?? null;
}

/**
 * 훅이 활성화되어 있는지 확인합니다.
 *
 * 우선순위:
 *   1. hooks.hookName.enabled (개별 훅 설정)
 *   2. tiers.tierName.enabled (티어 설정) — compound-core는 티어 비활성화 무시
 *   3. hookName.enabled (레거시 형식)
 *   4. 기본값 true (하위호환)
 */
export function isHookEnabled(hookName: string): boolean {
  const all = loadFullConfig();
  if (!all) return true;

  // 1) 개별 훅 설정 (v2: hooks 섹션)
  const hooksSection = all.hooks as Record<string, Record<string, unknown>> | undefined;
  if (hooksSection?.[hookName]?.enabled === false) return false;
  if (hooksSection?.[hookName]?.enabled === true) return true;

  // 2) 티어 설정 — compound-core는 절대 티어 비활성화로 끄지 않음
  const tier = HOOK_TIER_MAP[hookName];
  if (tier && tier !== 'compound-core') {
    const tiers = all.tiers as Record<string, Record<string, unknown>> | undefined;
    if (tiers?.[tier]?.enabled === false) return false;
  }

  // 3) 레거시 형식 (최상위 hookName.enabled)
  const legacy = all[hookName] as Record<string, unknown> | undefined;
  if (legacy?.enabled === false) return false;

  // 4) 기본값: 활성화
  return true;
}
