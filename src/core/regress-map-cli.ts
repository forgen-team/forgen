/**
 * `forgen regress-map` — fix:feat 비율 워닝을 actionable 로.
 *
 * doctor 의 36% 시그널을 받아 "어느 파일이 진앙인가" 를 한 화면에 보여준다.
 * `--days N` (기본 30), `--top N` (기본 10), `--json` 지원.
 */

import { computeRegressMap, formatFixRatio, computeFixFeatRatio } from './git-stats.js';

function parseIntArg(args: string[], flag: string, fallback: number): number {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const v = Number.parseInt(args[i + 1] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export async function handleRegressMap(args: string[] = []): Promise<void> {
  const days = parseIntArg(args, '--days', 30);
  const top = parseIntArg(args, '--top', 10);
  const asJson = args.includes('--json');

  const map = computeRegressMap(process.cwd(), days, top);
  const ratio = computeFixFeatRatio(process.cwd(), 30);

  if (asJson) {
    process.stdout.write(JSON.stringify({ fixFeat: ratio, regress: map }, null, 2));
    process.stdout.write('\n');
    return;
  }

  if (!map.available) {
    console.log('regress-map: git unavailable or no commits in window.');
    return;
  }

  console.log('  ┌─ forgen dev regress-map ───────────────────────────────────┐');
  console.log(`  │ window: last ${map.windowDays} days · fix commits: ${map.fixCommits}`.padEnd(60) + '│');
  if (ratio.available) {
    console.log(`  │ ${formatFixRatio(ratio)}`.padEnd(60) + '│');
  }
  console.log('  ├────────────────────────────────────────────────────────┤');

  if (map.hotspots.length === 0) {
    console.log('  │ No fix-touched files in window.'.padEnd(60) + '│');
  } else {
    console.log('  │ rank  hits  file (last fix · sha)'.padEnd(60) + '│');
    map.hotspots.forEach((h, i) => {
      const rank = String(i + 1).padStart(2, ' ');
      const hits = String(h.fixHits).padStart(3, ' ');
      const meta = `${h.lastFixDate} ${h.lastFixSha}`;
      const pathBudget = 56 - 4 - 4 - meta.length - 3;
      const shownPath = h.path.length > pathBudget
        ? '…' + h.path.slice(-(pathBudget - 1))
        : h.path;
      const line = `  ${rank}    ${hits}  ${shownPath}  (${meta})`;
      console.log(`  │ ${line}`.padEnd(60) + '│');
    });
  }
  console.log('  └────────────────────────────────────────────────────────┘');

  if (ratio.available && ratio.exceedsThreshold) {
    console.log('');
    console.log('  ⚠ fix:feat 비율 초과 — 상위 파일의 invariant/테스트 보강 권장.');
    console.log('  → 같은 파일이 3회 이상 fix 닿았다면 책임 분리 또는 회귀 테스트 우선.');
  }
}
