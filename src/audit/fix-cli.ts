/**
 * forgen fix — 처방 (docs/plans/2026-11-25-v1.0-plan.md §2.1, §5).
 *   forgen fix --list [--kind <종류>] [--json]            처방 목록(지적만인 것은 까닭과 함께)
 *   forgen fix <id> [--apply]                             diff 를 보이고, --apply 면 적용(스냅샷 먼저)
 *   forgen fix --kind <종류|all> --apply                  묶음 적용(종류 순서대로, 종류마다 다시 계획)
 *   forgen fix --undo <id|all>                            그 처방이 건드린 파일만 되돌림 — 그사이 바뀌었으면 멈추고 3자 diff
 *   forgen fix <id> --skip | --unskip                     묶음 적용에서 빼 둠 / 다시 넣음(목록에 "빼 둠"으로 남는다)
 *   forgen fix --report [--json]                          적용률·되돌림률, 적용 전후 폴더별 토큰(N3), 중요 지침 누락, 섞임
 *   공통: [--folder <경로>]... [--claude-dir <경로>] [--no-model]
 * 쓰는 곳은 처방 대상 파일(Q3 범위)과 <FORGEN_HOME>/backups/fix-*, <FORGEN_HOME>/audit/{fix,deleted.jsonl} 뿐이다. 커밋하지 않는다.
 */
import { Judge, takeModelDisclosure } from './judge.js';
import {
  appliedFixes, applyFix, ensureBaseline, FIX_KINDS, KIND_LABEL, lossCheck, measure, newBackupRoot, planFixes, previewFix,
  rates, readLedger, recordProposed, undoFix, unifiedDiff, appendLedger, fixPaths, withFixLock, excludedFixes, sameSetN3, type Fix, type FixKind, type FixPlan,
} from './fix.js';
import { shortPath } from './html.js';

const HELP = `  forgen fix --list [--kind <종류>] [--json]
      감사 결과(결정적 검사 + 모델 판정, 캐시)로 처방 목록을 낸다. 종류: ${FIX_KINDS.join(' · ')}
  forgen fix <id> [--apply]
      바뀌는 파일마다 diff · 이유 · 근거. --apply 면 스냅샷(~/.forgen/backups/fix-<시각>/) 뒤 적용
  forgen fix --kind <종류|all> --apply
      그 종류 처방을 전부 적용(all = 끄기 → 지우기 → 합치기 → 겹침 → 범위 → 옮기기 → 짧게 → 색인 → 기억 추가. 두 층 발동 조건은 all 에 없고 --kind tier2-condition 으로만)
  forgen fix --undo <id|all>
      그 처방이 건드린 파일만 되돌린다. 그사이 그 파일이 바뀌었으면 멈추고 3자 diff(처방 전·처방 뒤·지금)
  forgen fix <id> --skip | --unskip
      그 처방을 묶음 적용(--kind … --apply)에서 빼 둔다 / 다시 넣는다. 예: 두 층 발동 조건 목록을 보고 맞지 않는 것만 빼고 일괄 승인
      (forgen fix --list --kind tier2-condition → forgen fix <id> --skip → forgen fix --kind tier2-condition --apply 로 요약 확인 → --apply --yes)
      두 층 발동 조건은 목록 한 줄에 과거 세션 발동률 추정을 붙인다. 넓음(세션 50%+)·좁음(0%) 경고가 붙은 것은 일괄에서 빠지고 하나씩만 승인
  forgen fix --report [--json]
      적용률·되돌림률 · 적용 전후 폴더별 상시 로드 토큰(스킬 설명 제외) · 중요 지침 누락 · 섞임
  공통: [--folder <경로>]... [--claude-dir <경로>] [--no-model]  (--no-model: 결정적 처방만 — 같은 문장 정리·지우기·색인 줄 내리기·끄기)
  쓰는 곳: 자동 메모 · .claude/rules · forgen 룰 · git 안 CLAUDE.md·AGENTS.md(커밋 안 함). 관리형·git 밖 지침 파일은 지적만`;

const KNOWN = new Set(['--list', '--kind', '--apply', '--yes', '--undo', '--report', '--json', '--folder', '--claude-dir', '--no-model', '--skip', '--unskip', '--help', '-h']);
const WITH_VALUE = new Set(['--kind', '--undo', '--folder', '--claude-dir']);

function values(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === name && args[i + 1] && !args[i + 1].startsWith('--')) out.push(args[i + 1]); });
  return out;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

interface Ctx { folders: string[]; claudeDir?: string; model: boolean; json: boolean }

/** 이 실행에서 부른 모델 호출 수(판정 + 처방 문안, 캐시 적중 제외). */
const modelUse = { calls: 0, failed: 0, cacheHits: 0, ms: 0 };

async function plan(c: Ctx): Promise<FixPlan> {
  const judge = c.model ? new Judge({ model: true }) : null;
  if (judge) { const d = takeModelDisclosure(); if (d) (c.json ? process.stderr.write.bind(process.stderr) : (s: string) => console.log(s))(`${d}\n`); }
  const p = await planFixes({ folders: c.folders.length ? c.folders : undefined, claudeDir: c.claudeDir, judge });
  if (judge) { modelUse.calls += judge.stats.calls; modelUse.failed += judge.stats.failedCalls; modelUse.cacheHits += judge.stats.cacheHits; modelUse.ms += judge.stats.ms; }
  recordProposed(p.fixes);
  return p;
}

function line(f: Fix, skipped = false): string {
  return `  ${f.id}  ${skipped ? '[빼 둠] ' : ''}${f.title}${f.tokens > 0 ? `  (−${f.tokens}토큰)` : f.tokens < 0 ? `  (+${-f.tokens}토큰)` : ''}${f.model ? '  [모델 문안]' : ''}${f.blocked ? `\n      지적만: ${f.blocked}` : ''}${f.manual ? `\n      하나씩만: ${f.manual}` : ''}`;
}

function show(f: Fix): void {
  console.log(`${f.id} · ${KIND_LABEL[f.kind]}${f.model ? ' · 모델 문안(Haiku)' : ''}\n${f.title}\n이유: ${f.why}`);
  if (f.evidence.length) { console.log('근거:'); for (const e of f.evidence) console.log(`  · ${e}`); }
  if (f.blocked) { console.log(`\n지적만 — ${f.blocked}`); return; }
  if (f.manual) console.log(`\n하나씩만 — ${f.manual}`);
  for (const pv of previewFix(f)) {
    console.log('');
    if (pv.dir) { console.log(`폴더를 백업으로 옮김(끄기): ${shortPath(pv.path)}`); continue; }
    for (const l of unifiedDiff(pv.before, pv.after, shortPath(pv.path))) console.log(l);
  }
  console.log(`\n적용: forgen fix ${f.id} --apply   · 되돌리기: forgen fix --undo ${f.id}`);
}

async function applyKinds(c: Ctx, kinds: FixKind[]): Promise<void> {
  const root = newBackupRoot();
  const excluded = excludedFixes();
  let applied = 0;
  let skipped = 0;
  let baselineSet = false;
  const done = new Set<string>();
  let manual = 0;
  for (const k of kinds) {
    // 한 번 계획에서는 서로 다른 파일을 건드리는 처방만 적용하고, 같은 파일을 고치는 나머지는 다시 계획해서(앞 처방 뒤의 내용으로) 줄을 찾는다
    for (let pass = 0; pass < 50; pass++) {
      const p = await plan(c);
      if (!baselineSet) { ensureBaseline(p.run); baselineSet = true; }
      const todo = p.fixes.filter((x) => x.kind === k && !x.blocked && !done.has(x.id) && !excluded.has(x.id));
      if (pass === 0) manual += todo.filter((x) => x.manual).length;
      const touched = new Set<string>();
      let deferred = 0;
      for (const f of todo.filter((x) => !x.manual)) {
        const paths = fixPaths(f);
        if (paths.some((x) => touched.has(x))) { deferred++; continue; }
        done.add(f.id);
        try { applyFix(f, root); applied++; for (const x of paths) touched.add(x); if (!c.json) console.log(`✓ ${f.id}  ${f.title}`); } catch (e) {
          skipped++;
          appendLedger({ at: new Date().toISOString(), event: 'skip', id: f.id, kind: f.kind, note: e instanceof Error ? e.message : String(e) });
          if (!c.json) console.log(`· 건너뜀 ${f.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!deferred) break;
    }
  }
  if (c.json) console.log(JSON.stringify({ schema: 'forgen-fix-apply/1', applied, skipped, manual, excluded: excluded.size, backup: root, model: modelUse }, null, 2));
  else console.log(`\n✓ [forgen] 처방 ${applied}개 적용${skipped ? ` · ${skipped}개 건너뜀(대상이 바뀜 — 다시 --list)` : ''}${manual ? ` · 하나씩만 적용하는 처방 ${manual}개는 뺌(중요 지침·발동 넓음/좁음 경고 — forgen fix --list 에서 보고 <id> --apply)` : ''}${excluded.size ? ` · 빼 둔 처방(--skip) ${excluded.size}개 제외` : ''} · 스냅샷 ${root}\n  되돌리기: forgen fix --undo <id> | --undo all · 측정: forgen fix --report${c.model ? `\n  모델 호출 ${modelUse.calls}회(실패 ${modelUse.failed}, 캐시 적중 ${modelUse.cacheHits})` : ''}`);
}

function printConflicts(id: string, conflicts: Array<{ path: string; base: string | null; fixed: string | null; current: string | null }>): void {
  console.log(`✗ [forgen] ${id}: 처방 뒤에 바뀐 파일이 있어 되돌리지 않았다(아무것도 바꾸지 않음). 3자 비교:`);
  for (const c of conflicts) {
    console.log(`\n== ${shortPath(c.path)}`);
    console.log('-- 처방 전 → 처방 뒤(forgen 이 바꾼 것)');
    for (const l of unifiedDiff(c.base, c.fixed, shortPath(c.path))) console.log(l);
    console.log('-- 처방 뒤 → 지금(그사이 바뀐 것)');
    for (const l of unifiedDiff(c.fixed, c.current, shortPath(c.path))) console.log(l);
  }
  console.log('\n직접 합친 뒤 다시 처방하거나, 처방 전 원본은 스냅샷 폴더의 before/ 에 있다.');
}

async function report(c: Ctx): Promise<void> {
  const { runAudit } = await import('./run.js');
  const events = readLedger();
  const run = runAudit({ folders: c.folders.length ? c.folders : undefined, claudeDir: c.claudeDir });
  const before = ensureBaseline(run);
  const after = measure(run);
  const loss = lossCheck(before, after, events);
  let mix: number | null = null;
  if (c.model) {
    const { runModelChecks } = await import('./model-checks.js');
    mix = (await runModelChecks(run.result, run.ctx, new Judge({ model: true }))).counts.mixConfirmed;
  }
  // 기억 추가는 N3 다이어트와 따로 센다(새 기억이 실리는 몫 — N4 처방): 폴더 비교는 그 몫을 뺀 값으로
  const live = new Map<string, (typeof events)[number]>();
  for (const e of events) { if (e.event === 'apply') live.set(e.id, e); if (e.event === 'undo') live.delete(e.id); }
  const added = new Map<string, number>();
  for (const e of live.values()) if (e.addsTo) added.set(e.addsTo.folder, (added.get(e.addsTo.folder) ?? 0) + e.addsTo.tokens);
  const p1 = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
  // N3 = 같은 집합 비교(오너 결정 2026-11-26): 처방 전에 실리던 룰·기억 집합을 그대로 실을 때의 토큰. 빈자리를 채워 새로 실린 룰은 "되살린 룰"로 따로.
  const same = new Map(sameSetN3(before, after, run).map((x) => [x.folder, x]));
  const rows = before.folders.map((b) => {
    const total = after.folders.find((x) => x.folder === b.folder)?.tokens ?? 0;
    const mem = added.get(b.folder) ?? 0;
    const ss = same.get(b.folder);
    const revivedTokens = ss?.revivedTokens ?? 0;
    const diet = total - mem - revivedTokens;
    const allNow = total - mem; // 이전 정의(지금 실리는 전부)
    // 기대치: 2층 룰이 발동률 추정만큼 들어온다고 보고 더한 값(넓은 조건은 절감 0). 최대치(diet)와 따로 낸다 — 선전에는 기대치.
    const exp = run.result.folders.find((x) => x.folder === b.folder)?.forgenTier2?.expected ?? 0;
    return {
      folder: b.folder, before: b.tokens, after: diet, expected: diet + exp, addedMemory: mem, withMemory: total, delta: diet - b.tokens, pct: p1(diet, b.tokens), expectedPct: p1(diet + exp, b.tokens), pctWithMemory: p1(total, b.tokens),
      revived: ss?.revived.length ?? 0, revivedImportant: ss?.revivedImportant.length ?? 0, revivedTokens, allNow, allNowPct: p1(allNow, b.tokens),
    };
  });
  const r = rates(events);
  // Q11: 2층 룰은 색인 줄에 보이면 누락이 아니지만, 필요한 순간에 안 실린 "2층 미발동"(재생)은 누락으로 센다.
  const { latestRecurrence } = await import('./recurrence.js');
  const rec = latestRecurrence();
  const tier2Missed = (rec?.items ?? []).filter((it) => it.match?.reason === 'tier2-missed').map((it) => ({ ruleId: it.match?.ruleId ?? '', ts: it.ts }));
  const tier2 = { rules: run.ctx.tier2In?.size ?? 0, tokensUpper: run.result.folders.map((f) => ({ folder: f.folder, rules: f.forgenTier2?.rules ?? 0, tokens: f.forgenTier2?.tokens ?? 0 })) };
  const out = {
    schema: 'forgen-fix-report/1', n3Definition: 'same-set/2026-11-26', rates: r, folders: rows, medianPct: median(rows.map((x) => x.pct)), expectedMedianPct: median(rows.map((x) => x.expectedPct)),
    allNowMedianPct: median(rows.map((x) => x.allNowPct)),
    revived: new Set([...same.values()].flatMap((x) => x.revived)).size, revivedImportant: new Set([...same.values()].flatMap((x) => x.revivedImportant)).size, increased: rows.filter((x) => x.delta > 0).map((x) => x.folder),
    loss, tier2Missed, tier2, mixConfirmed: mix, applied: appliedFixes().length, baselineAt: before.at,
  };
  if (c.json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`처방: 제안 ${r.proposed} · 적용 ${r.applied} (적용률 ${pct(r.applied, r.proposed)}) · 되돌림 ${r.undone} (되돌림률 ${pct(r.undone, r.applied)}, 목표 ≤ 10%)`);
  for (const [k, v] of Object.entries(r.byKind)) console.log(`  ${KIND_LABEL[k as FixKind] ?? k}: 제안 ${v.proposed} · 적용 ${v.applied} · 되돌림 ${v.undone}`);
  console.log(`\n폴더별 상시 로드 토큰(N3, 스킬 설명 제외) — 처방 전(${before.at.slice(0, 16)}) → 지금`);
  const sg = (n: number) => `${n > 0 ? '+' : ''}${n}%`;
  console.log('  같은 집합 기준(처방 전에 실리던 룰·기억을 그대로 실을 때) — 빈자리를 채워 새로 실린 룰은 "되살린 룰"로 따로 센다');
  for (const x of rows) console.log(`  ${String(x.before).padStart(6)} → ${String(x.after).padStart(6)}  ${sg(x.pct)}  ${shortPath(x.folder)}${x.revived ? `   (되살린 룰 ${x.revived}개, 그중 중요 지침 ${x.revivedImportant}개 · ${x.revivedTokens}토큰)` : ''}${x.addedMemory ? `   (+ 기억 추가 ${x.addedMemory}토큰 → 합 ${sg(x.pctWithMemory)})` : ''}`);
  if (out.revived) console.log(`  되살린 룰 ${out.revived}개(그중 중요 지침 ${out.revivedImportant}개) — 처방 전에는 예산에서 빠지던 룰이 빈자리로 다시 실림(N3 에서 뺌)`);
  console.log(`  이전 정의(지금 실리는 전부): ${rows.map((x) => `${shortPath(x.folder)} ${sg(x.allNowPct)}`).join(' · ')} · 중앙값 ${sg(out.allNowMedianPct)}`);
  if (added.size) console.log('  기억 추가(적히지 않은 채 반복된 교정의 새 메모)는 N3 다이어트 비교에서 빼고 따로 적는다');
  console.log(`  중앙값 ${out.medianPct > 0 ? '+' : ''}${out.medianPct}% (목표 −15% 이상) · 늘어난 폴더 ${out.increased.length}`);
  if (rows.some((x) => x.expected !== x.after)) {
    console.log('  두 층 기대치(2층 룰이 과거 발동률만큼 들어온다고 보고, 넓은 조건은 절감 0) — 선전에는 이 값을 쓴다:');
    for (const x of rows) console.log(`    ${String(x.before).padStart(6)} → ${String(x.expected).padStart(6)}  ${sg(x.expectedPct)}  ${shortPath(x.folder)}`);
    console.log(`    중앙값 ${out.expectedMedianPct > 0 ? '+' : ''}${out.expectedMedianPct}% (위 "지금" 값은 최대치)`);
  }
  console.log(`중요 지침 누락 ${loss.reduce((n, l) => n + l.missing.length, 0)}${loss.length ? `: ${loss.map((l) => `${shortPath(l.folder)} ${l.missing.join(', ')}`).join(' / ')}` : ''}`);
  if (tier2.rules || tier2Missed.length) {
    console.log(`  2층(색인 줄로만 보이고 상황이 맞으면 한 번 들어옴) ${tier2.rules}개 — Q11: 자격 게이트를 지났고 색인에 보이므로 누락으로 세지 않음`);
    console.log(`  2층 미발동(재생, 누락으로 셈) ${tier2Missed.length}${tier2Missed.length ? `: ${tier2Missed.map((x) => `${x.ruleId.slice(0, 8)}@${x.ts.slice(0, 10)}`).join(', ')}` : ''}`);
    console.log('  한계: 2층 미발동은 교정이 나온 경우만 잡는다. 안 실렸는데 교정 없이 지나갔거나 실렸는데 모델이 무시하고 교정이 없었던 경우는 못 잡는다');
  }
  console.log(`다른 프로젝트 섞임(모델 판정) ${mix === null ? '— (--no-model)' : mix}`);
}

export async function handleFix(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { console.log(HELP); return; }
  const bad = args.filter((a, i) => a.startsWith('-') && !KNOWN.has(a) && !(i > 0 && WITH_VALUE.has(args[i - 1])));
  if (bad.length) { console.error(`[forgen] 알 수 없는 fix 옵션: ${bad.join(' ')}\n${HELP}`); process.exitCode = 1; return; }
  const c: Ctx = { folders: values(args, '--folder'), claudeDir: values(args, '--claude-dir')[0], model: !args.includes('--no-model'), json: args.includes('--json') };
  const kindArg = values(args, '--kind')[0];
  // 쉼표로 여러 종류(적용 순서는 FIX_KINDS 순서)
  // all 에는 두 층 발동 조건을 넣지 않는다 — 오너가 목록을 보고 --kind tier2-condition 으로 따로 승인한다.
  const wanted = kindArg === 'all' ? FIX_KINDS.filter((k) => k !== 'tier2-condition') : kindArg ? kindArg.split(',').map((k) => k.trim()) : null;
  const kinds: FixKind[] | null = wanted?.every((k) => FIX_KINDS.includes(k as FixKind)) ? FIX_KINDS.filter((k) => wanted.includes(k)) : null;
  if (kindArg && !kinds) { console.error(`[forgen] 알 수 없는 처방 종류: ${kindArg} (${FIX_KINDS.join(' · ')} · all)`); process.exitCode = 1; return; }
  try {
    if (args.includes('--undo')) {
      const target = values(args, '--undo')[0];
      if (!target) throw new Error('--undo 뒤에 처방 id 또는 all');
      await withFixLock(async () => {
        const list = target === 'all' ? appliedFixes() : [{ id: target }];
        if (!list.length) { console.log('되돌릴 처방이 없다.'); return; }
        for (const { id } of list) {
          const r = undoFix(id);
          if ('conflicts' in r) { printConflicts(id, r.conflicts); process.exitCode = 1; return; }
          if (!c.json) console.log(`✓ [forgen] ${id} 되돌림(파일 ${r.restored}개)`);
        }
      });
      return;
    }
    if (args.includes('--report')) { await report(c); return; }
    const positional = args.filter((a, i) => !a.startsWith('-') && !(i > 0 && WITH_VALUE.has(args[i - 1])));
    if (args.includes('--apply') && kinds) {
      // 두 층 발동 조건 일괄 승인은 요약을 보이고 --yes 가 있어야 적용한다. 넓음·좁음 경고가 붙은 것은 일괄에서 빠진다(개별 승인만).
      if (kinds.includes('tier2-condition') && !args.includes('--yes')) {
        const p = await plan(c);
        const xs = p.fixes.filter((f) => f.kind === 'tier2-condition' && !f.blocked);
        const ex = excludedFixes();
        const wide = xs.filter((f) => f.estimate?.wide).length;
        const narrow = xs.filter((f) => f.estimate?.narrow).length;
        const skipped = xs.filter((f) => ex.has(f.id)).length;
        const go = xs.filter((f) => !f.manual && !ex.has(f.id)).length;
        const tokens = xs.filter((f) => !f.manual && !ex.has(f.id)).reduce((n, f) => n + f.tokens, 0);
        console.log(`두 층 발동 조건 ${xs.length}개 — 넓음 경고 ${wide} · 좁음 경고 ${narrow} · 빼 둠 ${skipped}`);
        console.log(`일괄 승인하면 ${go}개 적용(세션 시작 약 −${tokens}토큰 상한). 경고 붙은 ${wide + narrow}개는 일괄에서 빠진다 — 보고 나서 forgen fix <id> --apply 로 하나씩`);
        console.log('목록: forgen fix --list --kind tier2-condition · 빼기: forgen fix <id> --skip · 확인 뒤 적용: forgen fix --kind tier2-condition --apply --yes');
        return;
      }
      await withFixLock(() => applyKinds(c, kinds));
      return;
    }
    const p = await plan(c);
    if (positional[0]) {
      const f = p.fixes.find((x) => x.id === positional[0]) ?? (p.fixes.filter((x) => x.id.startsWith(positional[0])).length === 1 ? p.fixes.find((x) => x.id.startsWith(positional[0])) : undefined);
      if (!f) throw new Error(`처방을 찾지 못함: ${positional[0]} — forgen fix --list (원천이 바뀌면 처방도 바뀐다)`);
      if (args.includes('--skip') || args.includes('--unskip')) {
        const skip = args.includes('--skip');
        appendLedger({ at: new Date().toISOString(), event: skip ? 'exclude' : 'include', id: f.id, kind: f.kind });
        console.log(skip ? `✓ [forgen] ${f.id} 를 묶음 적용에서 빼 둠 — 되돌리기: forgen fix ${f.id} --unskip` : `✓ [forgen] ${f.id} 를 묶음 적용에 다시 넣음`);
        return;
      }
      if (!args.includes('--apply')) { show(f); return; }
      const r = await withFixLock(async () => { ensureBaseline(p.run); return applyFix(f, newBackupRoot()); });
      console.log(`✓ [forgen] ${f.id} 적용 · 스냅샷 ${r.backup}\n  되돌리기: forgen fix --undo ${f.id}`);
      return;
    }
    const list = kinds ? p.fixes.filter((f) => kinds.includes(f.kind)) : p.fixes;
    if (c.json) { console.log(JSON.stringify({ schema: 'forgen-fix-list/1', generatedAt: p.generatedAt, model: !!p.model, fixes: list.map(({ ops: _o, ...f }) => f) }, null, 2)); return; }
    const excluded = excludedFixes();
    const ready = list.filter((f) => !f.blocked);
    console.log(`처방 ${ready.length}개 · 지적만 ${list.length - ready.length}개${p.model ? '' : ' (--no-model: 결정적 처방만)'}`);
    for (const k of FIX_KINDS) {
      const xs = list.filter((f) => f.kind === k);
      if (!xs.length) continue;
      console.log(`\n${KIND_LABEL[k]} (${xs.filter((f) => !f.blocked).length}${xs.some((f) => f.blocked) ? ` · 지적만 ${xs.filter((f) => f.blocked).length}` : ''})`);
      for (const f of xs) console.log(line(f, excluded.has(f.id)));
      if (k === 'tier2-condition') console.log('  ↳ 승인하면 그 룰은 세션 시작에 색인 줄로만 보이고 조건이 맞을 때 한 번 들어온다 · 빼기: forgen fix <id> --skip · 일괄 승인: forgen fix --kind tier2-condition --apply --yes(경고 붙은 것은 빠짐) · 되돌리기: forgen fix --undo <id>');
    }
    if (ready.length) console.log('\n보기: forgen fix <id> · 적용: forgen fix <id> --apply · 묶음: forgen fix --kind <종류|all> --apply');
    if (c.model) console.log(`모델 호출 ${modelUse.calls}회(실패 ${modelUse.failed}, 캐시 적중 ${modelUse.cacheHits})`);
  } catch (e) {
    console.error(`[forgen] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
