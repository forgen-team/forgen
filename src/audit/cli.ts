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
import { renderAuditHtml, shortPath, topLines } from './html.js';
import { writeFingerprintIfFirst } from './fingerprint.js';
import { handleBaseline, handleRecurrence } from './recurrence-cli.js';
import { AGREEMENT_TARGET, importReview, scoreReviews, writeKindReview, writeReview } from './review.js';
import { resultDigest, runAudit, writeRun, type AuditResult, type AuditRun } from './run.js';
import { Judge, takeModelDisclosure, type JudgeStats } from './judge.js';
import { attachModelChecks, runModelChecks } from './model-checks.js';

const HELP = `  forgen audit [--folder <경로>]... [--claude-dir <경로>] [--json] [--timing] [--no-model] [--no-open]
      CLAUDE.md 층·.claude/rules·자동 메모리·AGENTS.md·forgen 룰을 읽기만 해서 결정적 검사
      (잘림·크기·토큰·같은 문장·낡음·다른 프로젝트 섞임 후보·paths: 없는 룰) + 모델 판정 검사
      (같은 뜻 중복·부딪힘·섞임 확정 — 로컬 claude CLI Haiku, 캐시) → ~/.forgen/audit/<회차>/audit.html
      --no-model 이면 결정적 검사만
  forgen audit tokens [--folder <경로>]... [--claude-dir <경로>] [--json]
      폴더별 세션 시작 상시 로드 토큰(층별). 아무것도 쓰지 않는다
  forgen audit recurrence [--since <날짜>] [--until <날짜>] [--lookback 30d] [--limit N] [--no-model] [--json] [--claude-dir <경로>]
      대화 기록을 재생해 "같은 말 다시 하기"(N4)를 센다 — 로컬 claude CLI 판정(교정 Haiku · 쌍 Sonnet 1회, 캐시).
      교정 원장의 판정 대기도 같이 푼다
      갈래: 실렸는데 무시 · 적혀는 있는데 안 실림 · 적히지 않은 채 반복 · 지운 뒤 다시 말함 (프롬프트 1,000개당)
  forgen audit baseline [--freeze [--force]] [--until <날짜>] [--json] [--claude-dir <경로>]
      기준값: 직전 6주(앞 30일 조회 전용) + 12주 전체. --freeze 면 ~/.forgen/audit/baseline.json 에 고정
  forgen audit review [--kind <dup|conflict|mix>] [--import <파일>] [--no-open]
      판정 쌍 25개(예 무작위 10 · 아니오 중 점수 높은 10 · 모름 5)를 검수 페이지로 → 답 JSON 을 내려받아 --import
      --kind 가 없으면 같은 말 다시 하기(N4) 쌍, 있으면 가장 최근 forgen audit 회차의 그 검사(N2)
  forgen audit score [--json]
      검수 답과 판정자의 일치율(기준 ≥ 90%)
  forgen audit tier2 --replay [--apply] [--json] [--claude-dir <경로>]
      두 층 주입의 자격 게이트: 룰마다 근거 교정 직전 3턴을 재생해 결정적 발동 판정이 맞히는지(leave-one-out).
      통과율·놓침(시간 나누기·재발 사례)·사건당 발동 수를 낸다. --apply 면 ~/.forgen/state/tier2-index.json 에 적는다
      (그다음 세션부터 자격을 지난 룰은 상황이 맞을 때 한 번 들어오고, 세션 시작에는 색인 줄로만 보인다)`;

function values(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === name && args[i + 1] && !args[i + 1].startsWith('--')) out.push(args[i + 1]); });
  return out;
}

const KNOWN_BY_SUB: Record<string, Set<string>> = {
  '': new Set(['--folder', '--claude-dir', '--json', '--timing', '--no-model', '--no-open', '--help', '-h']),
  tokens: new Set(['--folder', '--claude-dir', '--json', '--help', '-h']),
  recurrence: new Set(['--claude-dir', '--since', '--until', '--lookback', '--limit', '--no-model', '--json', '--help', '-h']),
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
  managed: '관리형', user: '사용자', 'user-rules': '사용자 룰', import: 'import', project: '프로젝트', 'project-local': '로컬',
  agents: 'AGENTS', 'project-rules': '프로젝트 룰', 'memory-index': 'MEMORY.md', 'forgen-render': 'forgen',
};

/** N3 같은 집합 비교(처방 기준값이 있을 때) + 이전 정의 한 줄. */
export function n3Lines(r: AuditResult): string[] {
  const n = r.summary.n3;
  if (!n) return [];
  const sg = (x: number) => `${x > 0 ? '+' : ''}${x}%`;
  return [
    `N3(같은 집합 — 처방 전에 실리던 룰·기억을 그대로 실을 때, 스킬 설명 제외) 기준 ${n.baselineAt.slice(0, 16)}: 중앙값 ${sg(n.medianPct)} (목표 −15% 이상)`,
    ...n.folders.map((f) => `  ${String(f.before).padStart(6)} → ${String(f.sameSet).padStart(6)}  ${sg(f.pct)} (압축 ${sg(f.formatPct)} · 처방·두 층 ${sg(f.fixPct)})  ${shortPath(f.folder)}${f.revived ? `  (되살린 룰 ${f.revived}, 중요 지침 ${f.revivedImportant})` : ''}`),
    `  몫: 압축(형식) 중앙값 ${sg(n.formatMedianPct)} — 처방 전 집합을 압축 전/후 형식으로 렌더한 차이 · 처방·두 층 중앙값 ${sg(n.fixMedianPct)} — 같은 형식에서 처방 전/후 차이`,
    `  되살린 룰 ${n.revived}개(그중 중요 지침 ${n.revivedImportant}개) · 이전 정의(지금 실리는 전부) 중앙값 ${sg(n.allNowMedianPct)}`,
    ...(n3EdgeWarning(n.medianPct) ? [`  ⚠ ${n3EdgeWarning(n.medianPct)}`] : []),
  ];
}

function tokenTable(r: AuditResult): string[] {
  const out = [`폴더별 상시 로드 토큰 (로컬 근사: 영문 4자≈1 · 그 밖 1자≈0.9)`];
  for (const f of r.folders) {
    const parts = Object.entries(f.byLayer).filter(([, v]) => v).map(([k, v]) => `${LAYER_LABEL[k] ?? k} ${v}`).join(' · ');
    out.push(`  ${String(f.totalTokens).padStart(6)}  ${shortPath(f.folder)}${f.projectKey ? ` [${f.projectKey}]` : ''}`);
    out.push(`          ${parts || '(없음)'}${f.reducible.total ? `  → 줄일 몫 ${f.reducible.total} (${f.reducible.pct}%)` : ''}${f.mixCandidateTokens ? ` · 섞임 후보 ${f.mixCandidateTokens}` : ''}`);
  }
  return out;
}

export async function handleAudit(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { console.log(HELP); return; }
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : null;
  if (sub && !(sub in KNOWN_BY_SUB)) {
    console.error(`[forgen] 알 수 없는 audit 하위 명령: ${sub}\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  const rest = sub ? args.slice(1) : args;
  const bad = unknownFlags(rest, sub ?? '');
  if (bad.length) {
    console.error(`[forgen] 알 수 없는 audit 옵션: ${bad.join(' ')}\n${HELP}`);
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
  const run = runAudit({ folders: values(rest, '--folder'), claudeDir });
  try { const n3 = (await import('./fix.js')).n3Summary(run); if (n3) run.result.summary.n3 = n3; } catch (e) { process.stderr.write(`[forgen] N3 같은 집합 비교 실패: ${e instanceof Error ? e.message : String(e)}\n`); }
  const json = rest.includes('--json');
  let judgeStats: JudgeStats | null = null;
  if (sub !== 'tokens' && !rest.includes('--no-model')) {
    const d = takeModelDisclosure();
    if (d) { if (json) process.stderr.write(`${d}\n\n`); else console.log(`${d}\n`); }
    judgeStats = await modelChecks(run);
  }

  if (sub === 'tokens') {
    if (json) console.log(JSON.stringify({ schema: 'forgen-audit-tokens/1', generatedAt: run.result.generatedAt, ...(run.result.summary.n3 ? { n3: run.result.summary.n3 } : {}), folders: run.result.folders.map((f) => ({ folder: f.folder, projectKey: f.projectKey, totalTokens: f.totalTokens, ...(f.forgenTier2 ? { forgenTier2: f.forgenTier2, expectedTokens: f.totalTokens + (f.forgenTier2.expected ?? 0) } : {}), byLayer: f.byLayer, reducible: f.reducible, mixCandidateTokens: f.mixCandidateTokens, entries: f.entries })) }, null, 2));
    else { for (const l of tokenTable(run.result)) console.log(l); for (const l of n3Lines(run.result)) console.log(l); }
    return;
  }

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
  console.log(r.model.used
    ? 'forgen 감사 — 결정적 검사 + 모델 판정(같은 뜻 중복·부딪힘·섞임, 로컬 claude CLI · 후보 문장만 보냄)\n'
    : 'forgen 감사 — 결정적 검사 (--no-model: 모델을 부르지 않음, 아무것도 기기 밖으로 보내지 않음)\n');
  for (const l of topLines(r)) console.log(`  • ${l}`);
  console.log('');
  for (const l of tokenTable(r)) console.log(l);
  const c = r.checks;
  console.log(`\n검사별: 잘림 ${r.summary.truncation.truncated}/${c.truncation.length} · 200줄 넘는 지침 ${c.claudeMdOver200.length} · 같은 문장 ${c.sameSentence.length} · 낡음 ${c.stale.length} · 섞임 후보 ${c.mix.length} · paths: 없는 룰 ${c.unscopedRules.length}`);
  if (c.model) {
    const m = c.model;
    console.log(`모델 판정: 같은 뜻 중복 ${m.counts.dupGroups}묶음(예 쌍 ${m.counts.dupPairs}/후보 ${m.candidates.dup}) · 부딪힘 ${m.counts.conflicts}(후보 ${m.candidates.conflict}) · 섞임 확정 ${m.counts.mixConfirmed}(후보 ${m.candidates.mix}) · 모름 ${m.counts.unknown}${m.status === 'incomplete' ? ` · ${m.statusNote}` : ''}`);
    if (judgeStats) console.log(`  모델 호출 ${judgeStats.calls}회 · 실패 ${judgeStats.failedCalls} · 캐시 적중 ${judgeStats.cacheHits} · ${Math.round((run.timing.model ?? 0) / 1000)}초 — 검수: forgen audit review --kind dup|conflict|mix`);
  }
  if (r.sources.unreadable.length || r.sources.brokenRules.length) console.log(`읽지 못한 파일 ${r.sources.unreadable.length} · 깨진 forgen 룰 ${r.sources.brokenRules.length} (건너뛰고 계속함)`);
  console.log(`읽은 원천 ${r.sources.files}개 · 회차 ${out.runId}`);
  if (fp) console.log(`첫 감사 — 기억 지문을 남김: ${fp}`);
  console.log(`✓ [forgen] ${out.htmlPath}`);
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
