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

/**
 * 지원 host 의 정준 런타임 목록(단일 소스). `HostId` 는 여기서 파생되므로 새 host 추가 시
 * 이 배열만 넓히면 타입·런타임이 함께 확장된다. 자유형 `host === 'claude'` 이진 비교 대신
 * `(HOST_IDS as readonly string[]).includes(host)` 로 "유효 host 인지" 를 판정하라
 * (W3-3 리뷰 SEV-3 #5: Record<HostId> 는 Record 리터럴만 강제, 자유비교는 미포착).
 */
export const HOST_IDS = ['claude', 'codex', 'opencode'] as const;

export type HostId = (typeof HOST_IDS)[number];

/**
 * 능력 선언의 검증 수준 (W3-3 리뷰 SEV-3 #1).
 *   - 'runtime': forgen 이 이 host 에서 실제로 강제/실행함(레퍼런스 host — claude).
 *   - 'source' : host 의 hook schema 소스로 검증했고 forgen 배선 완료(codex).
 *   - 'docs'   : host 문서 기반 선언이나 **forgen 배선 미완**(opencode P1 — plugin 슬림 전).
 *
 * status='supported' 의 의미가 host 마다 다른 문제를 구조화한다: 'runtime'/'source' 의
 * supported 는 "forgen 이 강제함", 'docs' 의 supported 는 "플랫폼이 가능하나 forgen 미배선".
 * 프로그램 소비자는 verificationLevel 로 둘을 게이트해야 한다(intentEnforced 참조).
 */
export type CapabilityVerificationLevel = 'runtime' | 'source' | 'docs';

export interface HostCapabilities {
  readonly hostId: HostId;
  /** 이 host 선언 전체의 검증 수준. 'docs' 면 아래 status 는 "플랫폼-가능"이지 "forgen-배선"이 아니다. */
  readonly verificationLevel: CapabilityVerificationLevel;
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
