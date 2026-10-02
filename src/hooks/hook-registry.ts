/**
 * Forgen — Hook Registry
 *
 * 모든 훅의 메타데이터를 중앙 관리합니다.
 * 단일 소스 오브 트루스: hooks/hook-registry.json
 * postinstall.js와 이 모듈이 동일한 JSON을 읽으므로 중복/불일치 방지.
 *
 * 3개 티어로 분류:
 *   - compound-core: 경험 축적 엔진 (항상 활성)
 *   - safety: 범용 안전 훅 (기본 활성, 개별 비활성 가능)
 *   - workflow: 워크플로우 스킬 훅 (다른 플러그인 감지 시 자동 비활성)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type HookTier = 'compound-core' | 'safety' | 'workflow';

export type HookEventType =
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'Stop'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'SessionEnd';

export interface HookEntry {
  /** 고유 이름 (hook-config.json에서 사용) */
  name: string;
  /** 티어 분류 */
  tier: HookTier;
  /** Claude Code 훅 이벤트 */
  event: HookEventType;
  /** 도구명 매칭 패턴 (regex 또는 '*'). Best practice: 필요한 도구만 필터링. */
  matcher: string;
  /** 실행 스크립트 (dist/ 기준 상대 경로) */
  script: string;
  /** 타임아웃 (초) */
  timeout: number;
  /** compound 피드백 루프에 필수인 훅인지 */
  compoundCritical: boolean;
  /**
   * ADR-015: 이 훅을 등록할 host 목록. 생략 시 모든 host. Codex 의 hooks.json 은 바이트 동일성이
   * 훅 신뢰(trust) 와 묶여 있으므로, Claude 에만 추가하는 이벤트는 `["claude"]` 로 한정한다.
   */
  hosts?: Array<'claude' | 'codex' | 'opencode'>;
  /**
   * ADR-016 D2: Codex hooks.json 핸들러에만 붙는 필드. Codex 의 trust 해시는 핸들러 단위라
   * 여기 값을 바꾸면 *그 핸들러만* `/hooks` 재승인이 필요하다 (다른 핸들러는 영향 없음).
   */
  codex?: {
    /**
     * `additionalContext` 를 임시 파일로 스필하는 임계(근사 토큰, 기본 2500 ≈ 10KB). 0 = 스필 안 함.
     * Codex 는 PreToolUse/PostToolUse/SessionStart/UserPromptSubmit/SubagentStart 에서만 인정한다.
     */
    additionalContextLimit?: number;
  };
}

/**
 * 단일 소스 오브 트루스: hooks/hook-registry.json
 *
 * 순서가 중요함:
 *   - pre-tool-use는 db-guard/rate-limiter보다 앞에 위치
 *     (Code Reflection + permission hints 주입 타이밍)
 *   - 같은 이벤트 내 훅은 배열 순서대로 실행됨
 *
 * Why readFileSync (not `import ... with { type: 'json' }`):
 *   Import attributes는 Node 20.10+에서만 파싱됨. 20.0-20.9 사용자가 npm i -g
 *   이후 모든 훅이 SyntaxError로 깨지는 것을 방지하기 위해 fs.readFileSync 사용.
 */
const REGISTRY_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
  'shared',
  'hook-registry.json',
);
export const HOOK_REGISTRY: HookEntry[] = JSON.parse(
  readFileSync(REGISTRY_PATH, 'utf-8'),
) as HookEntry[];

/** 티어별 훅 목록 조회 */
export function getHooksByTier(tier: HookTier): HookEntry[] {
  return HOOK_REGISTRY.filter(h => h.tier === tier);
}

/** compound-critical 훅만 조회 (이 훅들은 비활성화하면 복리화가 깨짐) */
export function getCompoundCriticalHooks(): HookEntry[] {
  return HOOK_REGISTRY.filter(h => h.compoundCritical);
}
