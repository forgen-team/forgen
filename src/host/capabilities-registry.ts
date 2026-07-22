/**
 * Host Capabilities Registry — Multi-Host Core Design §10 우선순위 1
 *
 * 등록된 모든 host 의 HostCapabilities 를 모듈 로드 시점에 검증한다.
 * 새 TrustLayerIntent 추가 시 두 host 어댑터가 모두 선언을 추가하지 않으면 컴파일 fail.
 * (TypeScript `Record<TrustLayerIntent, _>` 타입 + 이 모듈의 runtime assert 이중 가드.)
 */

import {
  type HostCapabilities,
  type HostId,
  type TrustLayerIntent,
  assertCapabilitiesComplete,
} from '../core/trust-layer-intent.js';
import { claudeCapabilities } from './capabilities-claude.js';
import { codexCapabilities } from './capabilities-codex.js';
import { opencodeCapabilities } from './capabilities-opencode.js';

const REGISTRY: ReadonlyMap<HostId, HostCapabilities> = new Map([
  [claudeCapabilities.hostId, claudeCapabilities],
  [codexCapabilities.hostId, codexCapabilities],
  [opencodeCapabilities.hostId, opencodeCapabilities],
]);

// 모듈 로드 시점 자기 검증 — 하나라도 미선언이면 즉시 throw.
for (const caps of REGISTRY.values()) {
  assertCapabilitiesComplete(caps);
}

export function getHostCapabilities(host: HostId): HostCapabilities {
  const caps = REGISTRY.get(host);
  if (!caps) throw new Error(`Unknown host: ${host}`);
  return caps;
}

export function listRegisteredHosts(): readonly HostId[] {
  return Array.from(REGISTRY.keys());
}

export function intentSupported(host: HostId, intent: TrustLayerIntent): boolean {
  return getHostCapabilities(host).intents[intent].status === 'supported';
}
