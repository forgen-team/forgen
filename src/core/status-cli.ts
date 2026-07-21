/**
 * forgen status — 통합 상태 명령 (Wave 1, feature-audit 2026-07-21).
 *
 * 이전에는 "내 상태를 보여줘"가 stats/health/dashboard/me/recall/explain/
 * last-block/watch/inspect 9개 명령으로 파편화돼 있었다(~1800줄). 이 하나로
 * 통합해 표면을 줄이고 진입점을 일원화한다. 기존 render/compute 함수는 재사용만
 * 하고 재작성하지 않는다.
 *
 *   forgen status              요약 (health 헤더 + one-screen stats)
 *   forgen status --compound   compound 상태 + 최근 회상 이력
 *   forgen status --profile    4축 프로필 + 최근 교정
 *   forgen status --rules      활성 룰
 *   forgen status --blocks [N] 최근 차단 N건 (rule·사유·해결)
 *   forgen status --live       실시간 훅 이벤트 스트림
 */

const VIEWS = ['--compound', '--profile', '--rules', '--blocks', '--live', '--overview'] as const;
type View = (typeof VIEWS)[number];

const ALIASES: Record<string, View> = {
  '-c': '--compound',
  '-p': '--profile',
  '-r': '--rules',
  '-b': '--blocks',
  '-l': '--live',
  '-o': '--overview',
};

export function resolveView(args: string[]): View | null {
  for (const a of args) {
    const flag = a.split('=')[0]; // --blocks=1 → --blocks
    if ((VIEWS as readonly string[]).includes(flag)) return flag as View;
    if (ALIASES[flag]) return ALIASES[flag];
  }
  return null;
}

export async function handleStatus(args: string[]): Promise<void> {
  // 하위호환: 구 `forgen status --watch|--json|--interval N`(observability dashboard)
  // 은 통합 status 의 observability 모드로 계속 지원. 통합 전 별도 status 였음.
  if (args.includes('--watch') || args.includes('--json') || args.includes('--interval')) {
    const { runDashboard } = await import('./dashboard-cli.js');
    const intervalIdx = args.indexOf('--interval');
    await runDashboard({
      watch: args.includes('--watch'),
      json: args.includes('--json'),
      intervalSec: intervalIdx !== -1 ? Number(args[intervalIdx + 1]) || 5 : 5,
    });
    return;
  }

  const view = resolveView(args);

  switch (view) {
    case '--compound': {
      const { runDashboard } = await import('./dashboard-cli.js');
      await runDashboard({});
      const { handleRecall } = await import('./recall-cli.js');
      await handleRecall(args.filter((a) => a !== '--compound' && a !== '-c'));
      return;
    }
    case '--profile': {
      const { handleInspect } = await import('./inspect-cli.js');
      await handleInspect(['profile']);
      await handleInspect(['corrections']);
      return;
    }
    case '--rules': {
      const { handleInspect } = await import('./inspect-cli.js');
      await handleInspect(['rules']);
      return;
    }
    case '--blocks': {
      // 남은 positional(숫자)이 있으면 explain N, 없으면 최근 1건.
      const { handleExplain } = await import('./explain-cli.js');
      await handleExplain(args.filter((a) => a !== '--blocks' && a !== '-b'));
      return;
    }
    case '--live': {
      const { handleWatch } = await import('./watch-cli.js');
      await handleWatch();
      return;
    }
    case '--overview': {
      // 리치 운영 대시보드(hook health·session history·learning curve·multi-host).
      // 구 `forgen dashboard`의 고유 콘텐츠 — --compound(ROI/compound)와 다른 축이라
      // 별도 뷰로 보존 (Wave 1 리뷰: 콘텐츠 손실 방지).
      const { handleDashboard } = await import('./dashboard.js');
      await handleDashboard();
      return;
    }
    default: {
      // 요약: health 헤더 + one-screen stats (둘 다 computeStats() 기반).
      const { computeHealth, renderHealthLine } = await import('./health-cli.js');
      const { computeStats, renderStats } = await import('./stats-cli.js');
      console.log(renderHealthLine(computeHealth()));
      console.log(renderStats(computeStats()));
      console.log(
        `  ${dim('views:')} forgen status --compound | --profile | --rules | --blocks [N] | --live`,
      );
      return;
    }
  }
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
