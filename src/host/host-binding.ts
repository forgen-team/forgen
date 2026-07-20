/**
 * HostBinding — Multi-Harness Adapter Plan P0 (`reports/harness-probe/adapter-plan-2026-07-20.md` §4.1)
 *
 * `prepareHarness` 의 host if-ladder (`harness.ts:447-479`) 를 formalize 한 계약.
 * 각 host 는 capabilities 선언(`capabilities-registry.ts`) + projection 함수(`projection.ts`) +
 * 세션 준비 단계(hook-surface wiring, 구 if-ladder 분기)를 하나의 등록 단위로 묶는다.
 *
 * `Record<HostId, HostBinding>` 완전성 요구로, 새 host 를 `HostId` 에 추가하면 registry
 * 엔트리 누락이 컴파일 타임에 걸린다 (§4.2 P1 OpenCode 확장의 전제 조건).
 */

import type { HostCapabilities, HostId } from '../core/trust-layer-intent.js';
import type { ProjectToClaudeEvent } from './projection.js';
import type { V1BootstrapResult } from '../core/v1-bootstrap.js';

/** `prepareHarness` 가 host-specific 세션 준비 단계에 넘기는 컨텍스트. */
export interface HarnessSessionContext {
  readonly cwd: string;
  readonly pkgRoot: string;
  readonly env: Record<string, string>;
  readonly v1Result: V1BootstrapResult;
}

export interface HostBinding {
  readonly id: HostId;
  readonly capabilities: HostCapabilities;
  readonly projection: ProjectToClaudeEvent;
  /** harness.ts 의 host-specific artifact 준비 단계 (구 if-ladder 분기 대체). */
  prepareSession(ctx: HarnessSessionContext): Promise<void>;
}
