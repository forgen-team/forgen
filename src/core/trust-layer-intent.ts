/**
 * Trust Layer Intent — Multi-Host Core Design §9.0 산출물 #1
 *
 * forgen 이 host 위에서 보장하는 행동의 enum. spec §9.0 의 7 의도 매트릭스와 1:1.
 * 각 host adapter 는 이 enum 의 모든 항목에 대해 CapabilityDeclaration 을 선언해야 하며,
 * 미선언은 컴파일 타임(`Record<TrustLayerIntent, _>`) + 런타임(`assertCapabilitiesComplete`) 양쪽에서 fail.
 *
 * 1원칙: Claude semantics 가 reference. 본 enum 의 의미는 Claude Hook schema 의 행동을 그대로 사용한다.
 */

export const TRUST_LAYER_INTENTS = [
  'block-completion',
  'block-tool-use',
  'inject-context',
  'observe-only',
  'secret-filter',
  'forge-loop-state-inject',
  'self-evidence-record',
] as const;

export type TrustLayerIntent = (typeof TRUST_LAYER_INTENTS)[number];

export type CapabilityStatus = 'supported' | 'partial' | 'unsupported';

export interface CapabilityDeclaration {
  readonly status: CapabilityStatus;
  /** host 표면이 이 의도를 표현하는 hook/필드 (예: "Stop + decision:'block' + reason"). */
  readonly expression: string;
  /** partial/unsupported 시 등가성 보존을 위한 mitigation 핸들. supported 면 undefined. */
  readonly mitigation?: string;
  /** source-of-truth (spec 또는 외부 docs/source 인용). */
  readonly source?: string;
}

export type HostId = 'claude' | 'codex' | 'opencode';

export interface HostCapabilities {
  readonly hostId: HostId;
  /**
   * 모든 TrustLayerIntent 에 대한 선언. `Record<TrustLayerIntent, _>` 타입이
   * 컴파일 타임에 누락을 차단한다.
   */
  readonly intents: Record<TrustLayerIntent, CapabilityDeclaration>;
}

/**
 * 런타임 assertion — host adapter 가 새 의도 추가를 누락한 경우 fail.
 * 컴파일 타임 가드를 우회하는 동적 생성 코드를 위한 안전망.
 */
export function assertCapabilitiesComplete(caps: HostCapabilities): void {
  const declared = new Set(Object.keys(caps.intents) as TrustLayerIntent[]);
  const missing = TRUST_LAYER_INTENTS.filter((i) => !declared.has(i));
  if (missing.length > 0) {
    throw new Error(
      `HostCapabilities for "${caps.hostId}" missing intents: ${missing.join(', ')}. ` +
        `All TrustLayerIntent values must be declared (spec §9.0).`,
    );
  }
}
