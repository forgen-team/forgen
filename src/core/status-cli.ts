/**
 * forgen status — 통합 상태 명령 (Wave 1, feature-audit 2026-07-21).
 *
 * 이전에는 "내 상태를 보여줘"가 stats/health/dashboard/me/recall/explain/
 * last-block/watch/inspect 9개 명령으로 파편화돼 있었다(~1800줄). 이 하나로
 * 통합해 표면을 줄이고 진입점을 일원화한다. 기존 render/compute 함수는 재사용만
 * 하고 재작성하지 않는다.
 *
 *   forgen status              요약 (학습 흐름 6단계 + one-screen stats)
 *   forgen status --compound   compound 상태 + 최근 회상 이력
 *   forgen status --profile    4축 프로필 + 최근 교정
 *   forgen status --rules      활성 룰
 *   forgen status --blocks [N] 최근 차단 N건 (rule·사유·해결)
 *   forgen status --live       실시간 훅 이벤트 스트림
 *   forgen status --turn       이번 턴 관련 룰 + 각 룰의 원 교정 (ADR-017 D2)
 *   forgen status --health [--json] [--days N]  룰 건강 지표 (2026-11 재설계 D8, N ≤ 365 — 닫힌 날은 보관값)
 *   forgen status --history --json [--days N] [--rule <id>]  룰별 하루 스냅숏 (forgen-rule-history/v1)
 *   forgen status --html [--out <경로>] [--days N]  룰·건강·후보·이력 HTML 한 파일 (외부 리소스 없음)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Rule } from '../store/types.js';
import type { TurnRulesFile } from '../engine/rule-relevance.js';

const VIEWS = ['--compound', '--profile', '--rules', '--blocks', '--live', '--overview', '--turn', '--health'] as const;
type View = (typeof VIEWS)[number];

const ALIASES: Record<string, View> = {
  '-c': '--compound',
  '-p': '--profile',
  '-r': '--rules',
  '-b': '--blocks',
  '-l': '--live',
  '-o': '--overview',
  '-t': '--turn',
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
  // --health 는 자체 --json 을 가진다 — 아래 구(observability) --json 분기보다 먼저 처리.
  const daysArg = (fallback: number): number => {
    const di = args.indexOf('--days');
    return di !== -1 ? Math.min(365, Math.max(1, Number(args[di + 1]) || fallback)) : fallback;
  };
  if (args.includes('--health')) {
    const { renderRuleHealth } = await import('./rule-health.js');
    const { healthWithHistory } = await import('./metrics-history.js');
    const h = healthWithHistory({ days: daysArg(14) });
    if (args.includes('--json')) console.log(JSON.stringify(h, null, 2));
    else for (const l of renderRuleHealth(h)) console.log(l);
    return;
  }
  // 0.7.1: 룰별 하루 스냅숏 (forgen-rule-history/v1)
  if (args.includes('--history')) {
    const { buildRuleHistory, recordClosedDays } = await import('./metrics-history.js');
    recordClosedDays({ limit: 365 });
    const ri = args.indexOf('--rule');
    console.log(JSON.stringify(buildRuleHistory({ days: daysArg(30), rule: ri !== -1 ? args[ri + 1] : undefined }), null, 2));
    return;
  }
  // 0.7.1: 파일 하나짜리 HTML 화면
  if (args.includes('--html')) {
    const { healthWithHistory } = await import('./metrics-history.js');
    const { buildRuleList } = await import('./rule-list-json.js');
    const { renderStatusHtml, writeStatusHtml, defaultHtmlPath, openInBrowser } = await import('./status-html.js');
    // 한 번만 계산 — 이력 탭은 365일 일별 표, 건강 탭은 같은 계산의 최근 N일(흐름·대기열은 N일 창으로 다시 계산).
    const history = healthWithHistory({ days: 365 });
    const n = daysArg(90);
    const health = n === 365 ? history : healthWithHistory({ days: n, record: false });
    let version = '';
    try { version = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version?: string }).version ?? ''; } catch { /* 표시만 */ }
    const html = renderStatusHtml({
      generatedAt: new Date().toISOString(), forgenVersion: version,
      ruleList: buildRuleList(), health,
      history: { days: history.days, retentionDays: history.history.retentionDays, oldestDay: history.history.oldestDay },
    });
    const oi = args.indexOf('--out');
    const out = oi !== -1 && args[oi + 1] ? path.resolve(args[oi + 1]) : defaultHtmlPath();
    writeStatusHtml(html, out);
    console.log(`✓ [forgen] ${out}`);
    if (oi === -1 && !openInBrowser(out)) console.log('  브라우저를 열 수 없는 환경입니다. 위 파일을 직접 여세요.');
    return;
  }
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
  const unknownFlags = args.filter((a) => a.startsWith('-') && !resolveView([a]) && !['--watch', '--json', '--interval', '--limit', '--show'].includes(a.split('=')[0]));
  if (unknownFlags.length > 0) {
    console.error(`[forgen] 알 수 없는 status 옵션: ${unknownFlags.join(' ')}\n  views: --compound | --profile | --rules | --blocks [N] | --overview | --live | --turn | --health | --history | --html`);
    process.exitCode = 1;
    return;
  }

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
    case '--turn': {
      // ADR-017 D2: 현재 세션(FORGEN_SESSION_ID, 없으면 가장 최근 turn-rules 파일)의 관련 룰 + 원 교정.
      const { readTurnRules, resolveTurnRulesSession } = await import('../engine/rule-relevance.js');
      const { loadAllRules } = await import('../store/rule-store.js');
      const { ruleOrigin } = await import('../store/rule-origin.js');
      const session = resolveTurnRulesSession(process.env.FORGEN_SESSION_ID);
      const file = session ? readTurnRules(session) : null;
      for (const line of renderTurnRules(file, loadAllRules(), ruleOrigin)) console.log(line);
      return;
    }
    default: {
      // 요약: 학습 흐름(단계별 입력·마지막 성공·최근 건수) + one-screen stats. 점수(X/100)는 없다.
      const { computeFlow, renderFlow, haikuStatus } = await import('./flow-status.js');
      const { computeStats, renderStats } = await import('./stats-cli.js');
      console.log('\n  forgen status');
      for (const l of renderFlow(computeFlow())) console.log(l);
      console.log(`    Haiku 추출  ${haikuStatus().detail}`);
      try {
        const { queryGateDistribution } = await import('./observability-store.js');
        const dist = queryGateDistribution(30);
        const total = Object.values(dist).reduce((a, b) => a + b, 0);
        if (total > 0) {
          const ordered = Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
          console.log(`    회수 게이트  최근 30일 후보 ${total}건: ${ordered}`);
        }
      } catch { /* 관측 DB 없음 */ }
      console.log(renderStats(computeStats()));
      console.log(
        `  ${dim('views:')} forgen status --compound | --profile | --rules | --blocks [N] | --live | --turn`,
      );
      return;
    }
  }
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

// ── --turn: 이번 턴 관련 룰 + 원 교정 (ADR-017 D2 "저번에 말한 게 지금 먹었다") ──

type OriginLookup = (rule: Rule) => { date: string; kind?: string; quote: string; quoteSource: 'user' | 'summary' | 'none' } | null;

/**
 * 한 줄: `[category/strength] policy (score) — 출처: 2026-09-30 당신의 말 (avoid-this): "…"`.
 * 출처 문구는 rule-origin.originLine 과 같은 규칙(사용자 원문 > 모델 요약 > 날짜·kind 만)이되 접두사 없이.
 * 채굴 룰(behavior_inference)은 사용자가 한 말이 아니므로 "채굴 룰" 로만 표기한다.
 */
export function formatTurnRuleLine(rule: Rule, score: number, origin: OriginLookup): string {
  const head = `[${rule.category}/${rule.strength}] ${rule.policy} (${score.toFixed(1)})`;
  const o = origin(rule);
  if (!o) return rule.source === 'behavior_inference' ? `${head} — 채굴 룰` : head;
  const kind = o.kind ? ` (${o.kind})` : '';
  if (o.quoteSource === 'user') return `${head} — 출처: ${o.date} 당신의 말${kind}: "${o.quote}"`;
  if (o.quoteSource === 'summary') return `${head} — 출처: ${o.date} 교정 기록${kind}: "${o.quote}"`;
  return `${head} — 출처: ${o.date} 교정 기록${kind}`;
}

/** 순수 렌더 — 테스트용. file 이 null 이거나 관련 룰이 0이면 한 줄("이번 턴 관련 룰 없음"). */
export function renderTurnRules(file: TurnRulesFile | null, allRules: readonly Rule[], origin: OriginLookup): string[] {
  if (!file || file.rules.length === 0) return ['이번 턴 관련 룰 없음'];
  const byId = new Map(allRules.map((r) => [r.rule_id, r]));
  const when = file.at ? ` · ${file.at.slice(0, 16).replace('T', ' ')}` : '';
  const lines = [`이번 턴 관련 룰 ${file.rules.length} ${dim(`(세션 ${file.session_id.slice(0, 8)}${when} · 프롬프트 ${file.prompt_hash || '?'})`)}`];
  for (const r of file.rules) {
    const rule = byId.get(r.rule_id);
    if (!rule) { lines.push(`  ${r.rule_id} (${r.score.toFixed(1)}) — 룰 파일 없음(삭제됨)`); continue; }
    lines.push(`  ${formatTurnRuleLine(rule, r.score, origin)}`);
    if (r.matchedTerms.length > 0) lines.push(`    ${dim(`매칭: ${r.matchedTerms.join(', ')}`)}`);
  }
  return lines;
}
