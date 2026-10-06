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
 *   forgen status --turn       이번 턴 관련 룰 + 각 룰의 원 교정 (ADR-017 D2)
 */

import type { Rule } from '../store/types.js';
import type { TurnRulesFile } from '../engine/rule-relevance.js';

const VIEWS = ['--compound', '--profile', '--rules', '--blocks', '--live', '--overview', '--turn'] as const;
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
      // 요약: health 헤더 + one-screen stats (둘 다 computeStats() 기반).
      const { computeHealth, renderHealthLine } = await import('./health-cli.js');
      const { computeStats, renderStats } = await import('./stats-cli.js');
      console.log(renderHealthLine(computeHealth()));
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
