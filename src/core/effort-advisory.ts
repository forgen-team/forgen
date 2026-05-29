/**
 * forgen effort advisory (ADR-009 §5) — nudge-only.
 *
 * Claude Opus 4.8 은 effort(high/xhigh)·ultracode 를 도입했다. forgen 은 hook
 * 인터페이스를 통해 동작하므로 Claude 의 effort 를 **프로그램적으로 설정할 수 없다**.
 * 따라서 이 모듈은 *권고만* 한다 — long-running/비동기 작업(forge-loop, 대규모
 * 워크플로우)에서는 xhigh/ultracode 가 유리하다는 힌트를 사용자에게 노출한다.
 *
 * 순수 함수 (IO 없음) — doctor 등에서 surface.
 */

export interface EffortAdvisory {
  recommend: 'high' | 'xhigh';
  reason: string;
}

export interface EffortContext {
  /** forge-loop 등 장시간 무인 실행이 활성인가. */
  longRunningActive: boolean;
}

/**
 * effort 권고를 반환한다. long-running 컨텍스트면 xhigh, 아니면 high(기본).
 * 4.8 기본값이 이미 high 이므로 일상 작업엔 추가 권고가 불필요하다.
 */
export function effortAdvisory(ctx: EffortContext): EffortAdvisory {
  if (ctx.longRunningActive) {
    return {
      recommend: 'xhigh',
      reason:
        'long-running 컨텍스트 감지(forge-loop). Opus 4.8 은 어려운/비동기 작업에 ' +
        'xhigh(=extra) 또는 /effort ultracode 를 권장 — forgen 은 effort 를 직접 설정할 수 ' +
        '없으니 /effort 로 수동 전환하세요. (nudge-only)',
    };
  }
  return {
    recommend: 'high',
    reason:
      'Opus 4.8 기본 effort=high 로 충분. 대규모 마이그레이션/리팩터/감사 시에만 ' +
      '/effort xhigh|ultracode 고려.',
  };
}
