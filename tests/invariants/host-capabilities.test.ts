/**
 * Invariant: HostCapabilities 완전성
 *
 * Multi-Host Core Design §10 우선순위 1.
 * 모든 등록된 host adapter 가 모든 TrustLayerIntent 에 대해 선언을 가져야 한다.
 *
 * 이 invariant 가 깨지면:
 *   - 새 host 가 추가됐는데 일부 의도를 미선언했거나
 *   - 새 TrustLayerIntent 가 추가됐는데 기존 host 가 따라가지 못한 것이다.
 * 어느 쪽이든 빌드 fail 이 옳다. corpus 자체를 약화시키지 말 것.
 */

import { describe, expect, it } from 'vitest';
import {
  TRUST_LAYER_INTENTS,
  type HostCapabilities,
  type TrustLayerIntent,
  assertCapabilitiesComplete,
} from '../../src/core/trust-layer-intent.js';
import { claudeCapabilities } from '../../src/host/capabilities-claude.js';
import { codexCapabilities } from '../../src/host/capabilities-codex.js';
import { opencodeCapabilities } from '../../src/host/capabilities-opencode.js';
import {
  getHostCapabilities,
  listRegisteredHosts,
  intentSupported,
  intentEnforced,
} from '../../src/host/capabilities-registry.js';

describe('Invariant: HostCapabilities 완전성', () => {
  it('TRUST_LAYER_INTENTS 는 spec §9.0 의 7 의도를 정확히 포함', () => {
    expect(TRUST_LAYER_INTENTS).toEqual([
      'block-completion',
      'block-tool-use',
      'inject-context',
      'observe-only',
      'secret-filter',
      'forge-loop-state-inject',
      'self-evidence-record',
    ]);
  });

  it.each([claudeCapabilities, codexCapabilities])(
    '$hostId 어댑터는 모든 TrustLayerIntent 를 선언한다',
    (caps) => {
      // 컴파일 타임 가드(`Record<TrustLayerIntent, _>`) 외 런타임 보강.
      expect(() => assertCapabilitiesComplete(caps)).not.toThrow();
      for (const intent of TRUST_LAYER_INTENTS) {
        const decl = caps.intents[intent];
        expect(decl, `${caps.hostId}.${intent} 미선언`).toBeDefined();
        expect(decl.status).toMatch(/^(supported|partial|unsupported)$/);
        expect(decl.expression.length).toBeGreaterThan(0);
        if (decl.status !== 'supported') {
          expect(decl.mitigation, `${caps.hostId}.${intent} 가 ${decl.status} 인데 mitigation 없음`).toBeDefined();
        }
      }
    },
  );

  it('Claude 는 7 의도 모두 supported (reference host identity)', () => {
    for (const intent of TRUST_LAYER_INTENTS) {
      expect(claudeCapabilities.intents[intent].status, intent).toBe('supported');
    }
  });

  it('Codex 는 secret-filter 만 partial, 나머지 6 supported (spec §18 source verified)', () => {
    const partials = TRUST_LAYER_INTENTS.filter(
      (i) => codexCapabilities.intents[i].status === 'partial',
    );
    expect(partials).toEqual(['secret-filter']);
    const unsupported = TRUST_LAYER_INTENTS.filter(
      (i) => codexCapabilities.intents[i].status === 'unsupported',
    );
    expect(unsupported).toEqual([]);
  });

  it('registry 는 claude + codex + opencode 세 host 등록', () => {
    expect(listRegisteredHosts().sort()).toEqual(['claude', 'codex', 'opencode']);
  });

  it('OpenCode 정직 매트릭스 (W3-3 P1 docs-level 선언): block-completion 만 unsupported, inject/forge-loop partial', () => {
    const unsupported = TRUST_LAYER_INTENTS.filter(
      (i) => opencodeCapabilities.intents[i].status === 'unsupported',
    );
    // 완료 강제 차단 표면 부재 → advise-only (Cursor 와 동일 한계)
    expect(unsupported).toEqual(['block-completion']);

    const partials = TRUST_LAYER_INTENTS.filter(
      (i) => opencodeCapabilities.intents[i].status === 'partial',
    ).sort();
    // experimental 주입 표면 → inject-context / forge-loop-state-inject 는 partial
    expect(partials).toEqual(['forge-loop-state-inject', 'inject-context']);

    // block-tool-use(throw)·secret-filter·observe-only·self-evidence-record 는 supported
    expect(intentSupported('opencode', 'block-tool-use')).toBe(true);
    expect(intentSupported('opencode', 'secret-filter')).toBe(true);
    expect(intentSupported('opencode', 'block-completion')).toBe(false); // unsupported → false
  });

  it('verificationLevel (SEV-3 #1): claude=runtime, codex=source, opencode=docs', () => {
    expect(claudeCapabilities.verificationLevel).toBe('runtime');
    expect(codexCapabilities.verificationLevel).toBe('source');
    expect(opencodeCapabilities.verificationLevel).toBe('docs');
  });

  it('intentEnforced 는 docs-level(opencode)를 게이트 — supported 여도 forgen 미배선이면 false', () => {
    // opencode block-tool-use 는 status=supported 이나 verificationLevel=docs → 강제 아님
    expect(intentSupported('opencode', 'block-tool-use')).toBe(true);
    expect(intentEnforced('opencode', 'block-tool-use')).toBe(false);
    // claude/codex 의 supported 는 실배선이라 enforced=true
    expect(intentEnforced('claude', 'block-tool-use')).toBe(true);
    expect(intentEnforced('codex', 'block-tool-use')).toBe(true);
  });

  it('getHostCapabilities 가 잘못된 host 에 대해 throw', () => {
    expect(() => getHostCapabilities('gemini' as never)).toThrow(/Unknown host/);
  });

  it('intentSupported 가 supported/partial 을 정확히 구분', () => {
    expect(intentSupported('claude', 'secret-filter')).toBe(true);
    expect(intentSupported('codex', 'secret-filter')).toBe(false); // partial → false
    expect(intentSupported('codex', 'block-completion')).toBe(true);
  });

  it('assertCapabilitiesComplete 는 의도 누락을 즉시 감지', () => {
    const incomplete: HostCapabilities = {
      hostId: 'claude',
      intents: {
        'block-completion': { status: 'supported', expression: 'x' },
      } as Record<TrustLayerIntent, never>,
    };
    expect(() => assertCapabilitiesComplete(incomplete)).toThrow(/missing intents/);
  });
});
