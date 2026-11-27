/**
 * forgen audit — 호스트 기억 감사 (docs/plans/2026-11-25-v1.0-plan.md §2.1, §4.1).
 *   forgen audit [--folder <경로>]... [--claude-dir <경로>] [--json] [--timing] [--no-model] [--no-open]
 *   forgen audit tokens [--folder <경로>]... [--claude-dir <경로>] [--json]
 *
 *   forgen audit recurrence [--since] [--until] [--lookback 30d] [--limit N] [--no-model] [--json]   (recurrence-cli.ts)
 *   forgen audit baseline [--freeze [--force]] [--until] [--json]
 *   forgen audit review [--import <파일>] [--no-open] · forgen audit score [--json]   (review.ts)
 *
 * 원천은 읽기만 한다. 쓰는 곳은 <FORGEN_HOME>/audit/ 아래뿐이고 `audit tokens` 는 아무것도 쓰지 않는다.
 * `forgen audit` 의 첫 줄(다시 말한 교정)은 가장 최근 `audit recurrence` 결과를 읽어 채운다(모델을 새로 부르지 않음).
 */
import { performance } from 'node:perf_hooks';
import { n3EdgeWarning } from './fix-cli.js';
import { renderAuditHtml, shortPath, TERMS_LINE, topLines } from './html.js';
import { writeFingerprintIfFirst } from './fingerprint.js';
import { handleBaseline, handleRecurrence } from './recurrence-cli.js';
import { AGREEMENT_TARGET, importReview, scoreReviews, writeKindReview, writeReview } from './review.js';
import { resultDigest, runAudit, writeRun, type AuditResult, type AuditRun } from './run.js';
import { Judge, takeModelDisclosure, type JudgeStats } from './judge.js';
import { attachModelChecks, runModelChecks } from './model-checks.js';
import { getLocale, initLocaleFromConfig } from '../i18n/index.js';
import { groupSame } from './activity.js';

const HELP_KO = `  forgen audit [--since 30d] [--share] [--folder <경로>]... [--claude-dir <경로>] [--json] [--timing] [--no-model] [--no-open]
      설치 전에도 됨: npx -y @wooojin/forgen audit --since 30d (결과 폴더 ~/.forgen/audit 밖에는 아무것도 쓰지 않음)
      --since: 그 기간 대화 기록에서 같은 말 다시 하기도 잰다 · --share: 숫자와 발견 유형만 담은 공유용 요약
      CLAUDE.md·.claude/rules·자동 메모(MEMORY.md)·AGENTS.md·forgen 룰을 읽기만 해서 점검한다:
      잘림·크기·토큰·같은 문장·없는 것을 가리키는 줄·다른 프로젝트 지시 섞임·늘 실리는 rules 파일 +
      모델 판정(같은 뜻 중복·부딪힘·섞임 — 내 컴퓨터의 claude CLI, 판정은 저장해 다시 묻지 않음)
      → 첫 화면: 가장 중요한 발견 · 요약 · 다음에 할 일, 자세히: ~/.forgen/audit/<시각>/audit.html
      --no-model 이면 모델 없이 하는 검사만
  forgen audit tokens [--folder <경로>]... [--claude-dir <경로>] [--json]
      폴더별로 세션 시작에 늘 실리는 토큰(파일 종류별). 아무것도 쓰지 않는다
  forgen audit recurrence [--since <날짜>] [--until <날짜>] [--lookback 30d] [--limit N] [--no-model] [--json] [--claude-dir <경로>]
      지난 대화 기록을 읽어 "같은 말 다시 하기"를 센다: 세션에 실렸는데도 · 적혀 있지만 안 실려서 · 어디에도 안 적혀서 · 지운 기억을
      (교정 찾기 Haiku · 같은 말인지 Sonnet, 판정은 저장)
  forgen audit baseline [--freeze [--force]] [--until <날짜>] [--json] [--claude-dir <경로>]
      같은 말 다시 하기 기준값: 직전 6주 + 12주 전체. --freeze 면 ~/.forgen/audit/baseline.json 에 고정
  forgen audit review [--kind <dup|conflict|mix>] [--import <파일>] [--no-open]
      모델 판정 25개를 내 컴퓨터에서만 여는 페이지로 → 답을 내려받아 --import (판정이 맞는지 직접 확인)
  forgen audit score [--json]
      직접 확인한 답과 모델 판정이 얼마나 같은지(기준 90% 이상)
  forgen audit tier2 --replay [--apply] [--json] [--claude-dir <경로>]   (tier2 = 상황 맞춤 룰)
      상황 맞춤 룰 후보 시험: 룰마다 근거 교정 직전 대화를 다시 대 보고 조건이 맞았을지 본다. --apply 면 결과를 적어
      다음 세션부터 통과한 룰은 조건이 맞을 때만 들어온다`;

const HELP_EN = `  forgen audit [--since 30d] [--share] [--folder <path>]... [--claude-dir <path>] [--json] [--timing] [--no-model] [--no-open]
      Works before installing: npx -y @wooojin/forgen audit --since 30d (writes nothing outside ~/.forgen/audit)
      --since: also count repeated corrections in that window · --share: short summary with numbers and finding types only
      Read-only check of CLAUDE.md · .claude/rules · auto memory (MEMORY.md) · AGENTS.md · forgen rules:
      truncation · size · tokens · same sentence · lines pointing at missing files · cross-project mix · always-loaded rules files +
      model checks (same meaning · conflict · mix — your local claude CLI, results stored so nothing is asked twice)
      → first screen: most important findings · summary · what to do next; details: ~/.forgen/audit/<time>/audit.html
      --no-model: only checks that need no model
  forgen audit tokens [--folder <path>]... [--claude-dir <path>] [--json]
      Tokens always loaded at session start, per folder and file type. Writes nothing
  forgen audit recurrence [--since <date>] [--until <date>] [--lookback 30d] [--limit N] [--no-model] [--json] [--claude-dir <path>]
      Replay past transcripts and count corrections you had to repeat: loaded but ignored · written but not loaded · never written · deleted
  forgen audit baseline [--freeze [--force]] [--until <date>] [--json] [--claude-dir <path>]
      Repeat-correction baseline: last 6 weeks + 12 weeks. --freeze writes ~/.forgen/audit/baseline.json
  forgen audit review [--kind <dup|conflict|mix>] [--import <file>] [--no-open]
      25 model verdicts on a local page → download answers and --import (check the model yourself)
  forgen audit score [--json]
      How often your answers agree with the model (target ≥ 90%)
  forgen audit tier2 --replay [--apply] [--json] [--claude-dir <path>]
      Test situational-rule candidates against the conversation right before each source correction. --apply records the result`;

/** 터미널에서 예/아니오 한 번 묻기(기본 예). */
async function askYes(q: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { const a = (await rl.question(q)).trim().toLowerCase(); return !(a === 'n' || a === 'no' || a === '아니오' || a === 'ㄴ'); } finally { rl.close(); }
}

export function auditHelp(): string { initLocaleFromConfig(); return getLocale() === 'ko' ? HELP_KO : HELP_EN; }

function values(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === name && args[i + 1] && !args[i + 1].startsWith('--')) out.push(args[i + 1]); });
  return out;
}

const KNOWN_BY_SUB: Record<string, Set<string>> = {
  '': new Set(['--folder', '--claude-dir', '--json', '--timing', '--no-model', '--no-open', '--since', '--share', '--help', '-h']),
  tokens: new Set(['--folder', '--claude-dir', '--json', '--help', '-h']),
  recurrence: new Set(['--claude-dir', '--since', '--until', '--lookback', '--limit', '--no-model', '--json', '--latest', '--help', '-h']),
  baseline: new Set(['--claude-dir', '--until', '--freeze', '--force', '--json', '--help', '-h']),
  review: new Set(['--import', '--kind', '--no-open', '--json', '--help', '-h']),
  score: new Set(['--json', '--help', '-h']),
  tier2: new Set(['--replay', '--apply', '--json', '--claude-dir', '--help', '-h']),
};
const WITH_VALUE = new Set(['--folder', '--claude-dir', '--since', '--until', '--lookback', '--limit', '--import', '--kind']);

async function handleReview(rest: string[]): Promise<void> {
  const file = values(rest, '--import')[0];
  if (rest.includes('--import') && !file) throw new Error('--import 뒤에 답 파일 경로');
  if (file) {
    const r = importReview(file);
    console.log(`✓ [forgen] 검수 답 ${r.answered}개를 넣음: ${r.path}\n  일치율: forgen audit score`);
    return;
  }
  const kind = values(rest, '--kind')[0];
  if (rest.includes('--kind') && !kind) throw new Error('--kind 뒤에 dup|conflict|mix');
  if (kind && kind !== 'dup' && kind !== 'conflict' && kind !== 'mix') throw new Error(`알 수 없는 검수 종류: ${kind} (dup|conflict|mix)`);
  const out = kind ? writeKindReview(kind as 'dup' | 'conflict' | 'mix') : writeReview();
  if ('error' in out) throw new Error(out.error);
  const n = (b: string) => out.sample.pairs.filter((p) => p.bucket === b).length;
  if (rest.includes('--json')) { console.log(JSON.stringify({ htmlPath: out.htmlPath, samplePath: out.samplePath, runId: out.sample.runId, pairs: out.sample.pairs.length }, null, 2)); return; }
  console.log(`검수 쌍 ${out.sample.pairs.length}개 (예 무작위 ${n('yes-random')} · 아니오 중 점수 높은 ${n('no-top-score')} · 모름 ${n('unknown')}) — 판정자의 답은 페이지에서 숨김`);
  console.log(`✓ [forgen] ${out.htmlPath}`);
  console.log('  다 고른 뒤 "답 저장"으로 JSON 을 내려받아: forgen audit review --import <파일>');
  if (!rest.includes('--no-open')) {
    const { openInBrowser } = await import('../core/status-html.js');
    if (!openInBrowser(out.htmlPath)) console.log('  브라우저를 열 수 없는 환경입니다. 위 파일을 직접 여세요.');
  }
}

function handleScore(rest: string[]): void {
  const s = scoreReviews();
  if (rest.includes('--json')) { console.log(JSON.stringify({ schema: 'forgen-audit-score/1', target: AGREEMENT_TARGET, runs: s }, null, 2)); return; }
  if (!s.length) { console.log('검수 답이 없다 — forgen audit review 로 페이지를 만들고 답을 --import'); return; }
  for (const r of s) {
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}% (${a}/${b})` : '—');
    const j = r.judge as { pair?: { model: string; version: string }; check?: { kind: string; model: string; version: string } } | null;
    console.log(`회차 ${r.runId} · 판정자 ${j?.check ? `${j.check.kind} ${j.check.model}(${j.check.version})` : `쌍 ${j?.pair?.model ?? '?'}(${j?.pair?.version ?? '?'})`}`);
    console.log(`  판정자-오너 일치 ${pct(r.agree, r.compared)} — 기준 ≥ ${AGREEMENT_TARGET * 100}% (§12.1-2): ${r.pass === null ? '판정 불가' : r.pass ? '통과' : '미달'}`);
    console.log(`  판정자 "예" 중 오너도 같은 뜻 ${pct(r.yes.agree, r.yes.compared)} · 판정자 "아니오" 중 오너도 다름 ${pct(r.no.agree, r.no.compared)} · 오너 모르겠음 ${r.ownerUnsure}`);
    console.log(`  판정자 "모름" 쌍에 오너: 같은 뜻 ${r.unknown.same} · 다름 ${r.unknown.different} · 모르겠음 ${r.unknown.unsure}`);
  }
}

async function handleTier2(rest: string[], claudeDir?: string): Promise<void> {
  if (!rest.includes('--replay')) throw new Error('forgen audit tier2 --replay [--apply] — 지금은 재생만 있다');
  const { runTier2Replay, applyTier2Index } = await import('./tier2-replay.js');
  const { defaultEnv } = await import('./sources.js');
  const { result: r, index } = await runTier2Replay({ claudeDir: defaultEnv(claudeDir).claudeDir });
  if (rest.includes('--apply')) applyTier2Index(index);
  if (rest.includes('--json')) { console.log(JSON.stringify({ schema: 'forgen-audit-tier2/1', applied: rest.includes('--apply'), ...r }, null, 2)); return; }
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}% (${a}/${b})` : '— (0)');
  console.log(`두 층 자격 게이트 재생 — 룰 ${r.rules}개 · 대화 기록 세션 ${r.sessions.found}/${r.sessions.needed} · 사건 ${r.sessions.events}`);
  console.log(`  1층 고정(게이트를 보지 않음): ${Object.entries(r.tier1ByReason).map(([k, v]) => `${k} ${v}`).join(' · ') || '없음'}`);
  console.log(`  게이트 대상 ${r.candidates} → 통과 ${r.qualified} — 통과율 ${pct(r.qualified, r.candidates)} (재생 가능한 것 중 ${pct(r.qualified, r.replayable)})`);
  console.log(`  떨어진 까닭: ${Object.entries(r.byReason).filter(([k]) => k !== 'fired').map(([k, v]) => `${k} ${v}`).join(' · ') || '없음'}`);
  console.log(`  2층 놓침(게이트에 안 쓴 상황): 시간 나누기 ${pct(r.miss.timeSplit.missed, r.miss.timeSplit.tested)} · 재발 사례 ${pct(r.miss.recurrence.missed, r.miss.recurrence.tested)} — 출시 조건 ≤ 20%`);
  console.log(`  사건(프롬프트·도구 호출)당 발동 2층 룰: 평균 ${r.firesPerEvent.mean} · p90 ${r.firesPerEvent.p90} (턴당 최대 2개만 넣음)`);
  for (const n of r.notes) console.log(`  - ${n}`);
  console.log(rest.includes('--apply') ? '✓ [forgen] 자격 결과를 적음 — 다음 세션부터 두 층' : '  (--apply 를 붙이면 적용 — 지금은 아무것도 쓰지 않았다)');
}

/** 모델 판정 검사를 회차에 붙인다(판정기·캐시는 judge.ts). */
export async function modelChecks(run: AuditRun, judge = new Judge({ model: true })): Promise<JudgeStats> {
  const t = performance.now();
  const mc = await runModelChecks(run.result, run.ctx, judge);
  attachModelChecks(run, mc, resultDigest);
  run.timing.model = Math.round(performance.now() - t);
  return judge.stats;
}

function unknownFlags(args: string[], sub: string): string[] {
  const known = KNOWN_BY_SUB[sub] ?? KNOWN_BY_SUB[''];
  return args.filter((a, i) => a.startsWith('-') && !known.has(a) && !(i > 0 && WITH_VALUE.has(args[i - 1])));
}

const LAYER_LABEL: Record<string, string> = {
  managed: '관리형', user: '사용자 CLAUDE.md', 'user-rules': '사용자 rules', import: '@import', project: '프로젝트 CLAUDE.md', 'project-local': 'CLAUDE.local.md',
  agents: 'AGENTS.md', 'project-rules': '프로젝트 rules', 'memory-index': 'MEMORY.md', 'forgen-render': 'forgen 룰', skills: '스킬 설명',
};

/** 처방 전후(처방 기준값이 있을 때) — `audit tokens` 에서 보인다. */
export function n3Lines(r: AuditResult): string[] {
  const n = r.summary.n3;
  if (!n) return [];
  const sg = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x)}%`;
  const rep = n.rep;
  return [
    `처방 전(${n.baselineAt.slice(0, 16).replace('T', ' ')}) → 지금, 같은 룰·기억을 실을 때(스킬 설명 제외): ${rep ? `${rep.weighted ? '자주 쓰는 폴더 평균' : '폴더 평균'} ${sg(rep.pct)} (forgen 룰 표기를 짧게 해서 ${sg(rep.formatPct)} · 처방으로 ${sg(rep.fixPct)})` : sg(n.medianPct)} · 목표 −15%`,
    ...groupSame(n.folders, (f) => `${f.before}|${f.sameSet}|${f.revived}`).map((g) => `  ${String(g.first.before).padStart(6)} → ${String(g.first.sameSet).padStart(6)}  ${sg(g.first.pct)}  ${shortPath(g.first.folder)}${g.rows.length > 1 ? ` 외 ${g.rows.length - 1}곳` : ''}`),
    ...(n.revived ? [`  전에는 세션 시작 분량 상한을 넘어서 빠지던 forgen 룰 ${n.revived}개가 이제 실림(그중 중요 지침 ${n.revivedImportant}개) — 위 비교에서는 뺐고, 넣고 세면 ${sg(rep?.allNowPct ?? n.allNowMedianPct)}`] : []),
    ...(n3EdgeWarning(rep?.pct ?? n.medianPct) ? [`  ⚠ ${n3EdgeWarning(rep?.pct ?? n.medianPct)}`] : []),
  ];
}

function tokenTable(r: AuditResult): string[] {
  const out = ['폴더별 세션 시작에 늘 실리는 토큰 (어림값: 영문 4자≈1 · 한글 1자≈0.9)'];
  // 0.9.1 #5: 모델 판정으로 섞임을 확정했으면 "섞임 의심" 토큰은 보이지 않는다(같은 개념은 한 출처 — 확정 판정)
  const confirmed = !!r.checks.model;
  const layers = (f: AuditResult['folders'][number]) => Object.entries(f.byLayer).filter(([, v]) => v).map(([k, v]) => `${LAYER_LABEL[k] ?? k} ${v}`).join(' · ');
  const groups = groupSame(r.folders, (f) => `${f.totalTokens}|${layers(f)}|${f.reducible.total}`);
  for (const g of groups.sort((a, b) => (b.first.sessions30d ?? 0) - (a.first.sessions30d ?? 0) || b.first.totalTokens - a.first.totalTokens)) {
    const f = g.first;
    const sessions = g.rows.reduce((n, x) => n + (x.sessions30d ?? 0), 0);
    const rare = g.rows.every((x) => (x.sessions30d ?? 0) < 3);
    out.push(`  ${String(f.totalTokens).padStart(6)}  ${shortPath(f.folder)}${g.rows.length > 1 ? ` 외 ${g.rows.length - 1}곳(결과 같음)` : ''}${f.projectKey ? ` [${f.projectKey}]` : ''}  — 최근 30일 세션 ${g.rows.length > 1 ? '합 ' : ''}${sessions}개${rare ? '(거의 안 씀 — 평균에서 뺌)' : ''}`);
    out.push(`          ${layers(f) || '(없음)'}${f.reducible.total ? `  → 바로 줄일 수 있는 양 ${f.reducible.total} (${f.reducible.pct}%)` : ''}${!confirmed && f.mixCandidateTokens ? ` · 섞임 의심 ${f.mixCandidateTokens}` : ''}`);
  }
  return out;
}

export async function handleAudit(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { console.log(auditHelp()); return; }
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : null;
  if (sub && !(sub in KNOWN_BY_SUB)) {
    console.error(`[forgen] 알 수 없는 audit 하위 명령: ${sub}\n${auditHelp()}`);
    process.exitCode = 1;
    return;
  }
  const rest = sub ? args.slice(1) : args;
  const bad = unknownFlags(rest, sub ?? '');
  if (bad.length) {
    console.error(`[forgen] 알 수 없는 audit 옵션: ${bad.join(' ')}\n${auditHelp()}`);
    process.exitCode = 1;
    return;
  }
  const started = performance.now();
  const claudeDir = values(rest, '--claude-dir')[0];
  if (sub === 'recurrence' || sub === 'baseline' || sub === 'review' || sub === 'score' || sub === 'tier2') {
    try {
      if (sub === 'tier2') await handleTier2(rest, claudeDir);
      else if (sub === 'recurrence') await handleRecurrence(rest, claudeDir);
      else if (sub === 'baseline') await handleBaseline(rest, claudeDir);
      else if (sub === 'review') await handleReview(rest);
      else handleScore(rest);
    } catch (e) {
      console.error(`[forgen] ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
    return;
  }
  const json = rest.includes('--json');
  let useModel = sub !== 'tokens' && !rest.includes('--no-model');
  // 0.9.1 #11: 모델 판정은 첫 실행에 범위를 알리고, 터미널이면 묻는다(아니오 = --no-model 과 같음).
  if (useModel) {
    const d = takeModelDisclosure();
    if (d) {
      if (json) process.stderr.write(`${d}\n\n`); else console.log(`${d}\n`);
      if (!json && process.stdin.isTTY && process.stdout.isTTY) useModel = await askYes('모델 판정을 쓸까요? [Y/n] (n = 모델 없이, 아무것도 보내지 않음) ');
    }
  }
  // 0.9.1 #11: --since 면 그 기간 대화 기록에서 "같은 말 다시 하기"도 같이 잰다(설치 전 미리 보기). 결과 폴더(~/.forgen/audit) 밖에는 쓰지 않는다.
  const sinceArg = values(rest, '--since')[0];
  if (rest.includes('--since') && !sinceArg) { console.error('[forgen] --since 뒤에 30d 처럼 날 수나 날짜'); process.exitCode = 1; return; }
  if (sinceArg && sub !== 'tokens') {
    try {
      const { runRecurrence, writeRecurrenceRun } = await import('./recurrence.js');
      const { parseDate, parseDays } = await import('./recurrence-cli.js');
      const days = /^\d+\s*d?$/.test(sinceArg.trim()) ? parseDays(sinceArg) : undefined;
      const since = days !== undefined ? new Date(Date.now() - days * 86_400_000) : parseDate(sinceArg, '--since');
      writeRecurrenceRun(await runRecurrence({ claudeDir, since, model: useModel }));
    } catch (e) { process.stderr.write(`[forgen] 같은 말 다시 하기를 재지 못함: ${e instanceof Error ? e.message : String(e)}\n`); }
  }
  const run = runAudit({ folders: values(rest, '--folder'), claudeDir });
  try { const n3 = (await import('./fix.js')).n3Summary(run); if (n3) run.result.summary.n3 = n3; } catch (e) { process.stderr.write(`[forgen] 처방 전후 비교 실패: ${e instanceof Error ? e.message : String(e)}\n`); }
  let judgeStats: JudgeStats | null = null;
  if (useModel) judgeStats = await modelChecks(run);

  if (sub === 'tokens') {
    if (json) console.log(JSON.stringify({ schema: 'forgen-audit-tokens/1', generatedAt: run.result.generatedAt, ...(run.result.summary.n3 ? { n3: run.result.summary.n3 } : {}), folders: run.result.folders.map((f) => ({ folder: f.folder, projectKey: f.projectKey, totalTokens: f.totalTokens, ...(f.forgenTier2 ? { forgenTier2: f.forgenTier2, expectedTokens: f.totalTokens + (f.forgenTier2.expected ?? 0) } : {}), byLayer: f.byLayer, reducible: f.reducible, mixCandidateTokens: f.mixCandidateTokens, entries: f.entries })) }, null, 2));
    else { for (const l of tokenTable(run.result)) console.log(l); for (const l of n3Lines(run.result)) console.log(l); }
    return;
  }

  try { (await import('./top.js')).attachTop(run); } catch (e) { process.stderr.write(`[forgen] 첫 화면 발견을 만들지 못함: ${e instanceof Error ? e.message : String(e)}\n`); }
  const t = performance.now();
  const out = writeRun(run, renderAuditHtml);
  const fp = writeFingerprintIfFirst(run.manifest.sources.map((x) => x.path), new Date(), run.result.forgenVersion);
  // 첫 감사: N3 의 "처방 전" 기준값도 같이 남긴다(이미 있으면 그대로) — 0.9.0 이전 형식(압축 전) 토큰을 함께 적는다.
  if (fp) { try { (await import('./fix.js')).ensureBaseline(run); } catch (e) { process.stderr.write(`[forgen] N3 기준값을 남기지 못함: ${e instanceof Error ? e.message : String(e)}\n`); } }
  run.timing.page = Math.round(performance.now() - t);
  run.timing.total = Math.round(performance.now() - started);
  if (json) {
    console.log(JSON.stringify({ ...run.result, runId: out.runId, dir: out.dir, ...(rest.includes('--timing') ? { timing: run.timing } : {}) }, null, 2));
    return;
  }
  const r = run.result;
  if (rest.includes('--share')) {
    // 0.9.1 #14: 숫자와 발견 유형만(경로·이름·본문 없음) — 터미널 글 + 붙여 넣기용 마크다운
    const sh = (await import('./top.js')).shareSummary(run);
    console.log('forgen 감사 요약 (공유용 — 경로·프로젝트 이름·기억 내용 없음)');
    for (const l of sh.text) console.log(`  • ${l}`);
    console.log(`\n붙여 넣기용 마크다운:\n\n${sh.markdown}\n`);
    console.log(`자세히(나만 보기): ${shortPath(out.htmlPath)}`);
    return;
  }
  console.log(r.model.used
    ? 'forgen 감사 — 내 Claude 기억(CLAUDE.md·메모·forgen 룰)을 읽기만 해서 점검했습니다. 부딪힘·같은 뜻·섞임은 내 컴퓨터의 claude CLI 가 판정(판정할 지시 문장만 골라 보냄)'
    : 'forgen 감사 — 내 Claude 기억(CLAUDE.md·메모·forgen 룰)을 읽기만 해서 점검했습니다(--no-model: 모델을 부르지 않음, 아무것도 밖으로 보내지 않음)');
  console.log(`${TERMS_LINE}\n`);
  const top = r.summary.top;
  if (top?.findings.length) {
    console.log('가장 중요한 발견');
    top.findings.forEach((f, i) => { console.log(`  ${i + 1}. ${f}`); });
    console.log('');
  }
  console.log('요약');
  for (const l of topLines(r)) console.log(`  • ${l}`);
  console.log('');
  for (const l of tokenTable(r)) console.log(l);
  if (judgeStats) console.log(`\n모델 호출 ${judgeStats.calls}번(실패 ${judgeStats.failedCalls}, 저장된 판정 ${judgeStats.cacheHits}개 재사용) · ${Math.round((run.timing.model ?? 0) / 1000)}초${r.checks.model?.status === 'incomplete' ? ` · ${r.checks.model.statusNote}` : ''}`);
  if (r.sources.unreadable.length || r.sources.brokenRules.length) console.log(`읽지 못한 파일 ${r.sources.unreadable.length} · 깨진 forgen 룰 ${r.sources.brokenRules.length} (건너뛰고 계속함)`);
  console.log(`읽은 파일 ${r.sources.files}개${fp ? ` · 처음 감사라 지금 기억 상태를 적어 둠: ${shortPath(fp)}` : ''}`);
  console.log(`✓ [forgen] 자세히(표·목록): ${shortPath(out.htmlPath)}  (~/.forgen/audit 밖에는 아무것도 쓰지 않았음)`);
  if (top?.next.length) {
    console.log('\n다음에 할 일');
    top.next.forEach((l, i) => { console.log(`  ${i + 1}. ${l}`); });
  }
  if (rest.includes('--timing')) {
    const tm = run.timing;
    const checks = (tm.checksBase ?? 0) + (tm.checks ?? 0);
    console.log(`시간(ms): 원천 ${tm.sources} · forgen 렌더·스킬 ${tm.forgenRender} · 검사 ${checks} · 근거 교정 위치(대화 기록 읽기) ${tm.sessionEvidence ?? 0}${tm.model !== undefined ? ` · 모델 판정 ${tm.model}` : ''} · 페이지 ${tm.page} · 합계 ${tm.total}`);
  }
  if (!rest.includes('--no-open')) {
    const { openInBrowser } = await import('../core/status-html.js');
    if (!openInBrowser(out.htmlPath)) console.log('  브라우저를 열 수 없는 환경입니다. 위 파일을 직접 여세요.');
  }
}
