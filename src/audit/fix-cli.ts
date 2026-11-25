/**
 * forgen fix — 처방 (docs/plans/2026-11-25-v1.0-plan.md §2.1, §5).
 *   forgen fix --list [--kind <종류>] [--json]            처방 목록(지적만인 것은 까닭과 함께)
 *   forgen fix <id> [--apply]                             diff 를 보이고, --apply 면 적용(스냅샷 먼저)
 *   forgen fix --kind <종류|all> --apply                  묶음 적용(종류 순서대로, 종류마다 다시 계획)
 *   forgen fix --undo <id|all>                            그 처방이 건드린 파일만 되돌림 — 그사이 바뀌었으면 멈추고 3자 diff
 *   forgen fix --report [--json]                          적용률·되돌림률, 적용 전후 폴더별 토큰(N3), 중요 지침 누락, 섞임
 *   공통: [--folder <경로>]... [--claude-dir <경로>] [--no-model]
 * 쓰는 곳은 처방 대상 파일(Q3 범위)과 <FORGEN_HOME>/backups/fix-*, <FORGEN_HOME>/audit/{fix,deleted.jsonl} 뿐이다. 커밋하지 않는다.
 */
import { Judge, takeModelDisclosure } from './judge.js';
import {
  appliedFixes, applyFix, ensureBaseline, FIX_KINDS, KIND_LABEL, lossCheck, measure, newBackupRoot, planFixes, previewFix,
  rates, readLedger, recordProposed, undoFix, unifiedDiff, appendLedger, type Fix, type FixKind, type FixPlan,
} from './fix.js';
import { shortPath } from './html.js';

const HELP = `  forgen fix --list [--kind <종류>] [--json]
      감사 결과(결정적 검사 + 모델 판정, 캐시)로 처방 목록을 낸다. 종류: ${FIX_KINDS.join(' · ')}
  forgen fix <id> [--apply]
      바뀌는 파일마다 diff · 이유 · 근거. --apply 면 스냅샷(~/.forgen/backups/fix-<시각>/) 뒤 적용
  forgen fix --kind <종류|all> --apply
      그 종류 처방을 전부 적용(all = 끄기 → 지우기 → 합치기 → 겹침 → 범위 → 옮기기 → 짧게 → 색인 → 기억 추가)
  forgen fix --undo <id|all>
      그 처방이 건드린 파일만 되돌린다. 그사이 그 파일이 바뀌었으면 멈추고 3자 diff(처방 전·처방 뒤·지금)
  forgen fix --report [--json]
      적용률·되돌림률 · 적용 전후 폴더별 상시 로드 토큰(스킬 설명 제외) · 중요 지침 누락 · 섞임
  공통: [--folder <경로>]... [--claude-dir <경로>] [--no-model]  (--no-model: 결정적 처방만 — 같은 문장 정리·지우기·색인 줄 내리기·끄기)
  쓰는 곳: 자동 메모 · .claude/rules · forgen 룰 · git 안 CLAUDE.md·AGENTS.md(커밋 안 함). 관리형·git 밖 지침 파일은 지적만`;

const KNOWN = new Set(['--list', '--kind', '--apply', '--undo', '--report', '--json', '--folder', '--claude-dir', '--no-model', '--help', '-h']);
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

function line(f: Fix): string {
  return `  ${f.id}  ${f.title}${f.tokens > 0 ? `  (−${f.tokens}토큰)` : f.tokens < 0 ? `  (+${-f.tokens}토큰)` : ''}${f.model ? '  [모델 문안]' : ''}${f.blocked ? `\n      지적만: ${f.blocked}` : ''}`;
}

function show(f: Fix): void {
  console.log(`${f.id} · ${KIND_LABEL[f.kind]}${f.model ? ' · 모델 문안(Haiku)' : ''}\n${f.title}\n이유: ${f.why}`);
  if (f.evidence.length) { console.log('근거:'); for (const e of f.evidence) console.log(`  · ${e}`); }
  if (f.blocked) { console.log(`\n지적만 — ${f.blocked}`); return; }
  for (const pv of previewFix(f)) {
    console.log('');
    if (pv.dir) { console.log(`폴더를 백업으로 옮김(끄기): ${shortPath(pv.path)}`); continue; }
    for (const l of unifiedDiff(pv.before, pv.after, shortPath(pv.path))) console.log(l);
  }
  console.log(`\n적용: forgen fix ${f.id} --apply   · 되돌리기: forgen fix --undo ${f.id}`);
}

async function applyKinds(c: Ctx, kinds: FixKind[]): Promise<void> {
  const root = newBackupRoot();
  let applied = 0;
  let skipped = 0;
  let baselineSet = false;
  for (const k of kinds) {
    // 같은 종류 처방끼리 같은 줄을 건드려 건너뛴 것이 있으면 다시 계획해서 한 번 더(최대 3번)
    for (let pass = 0; pass < 3; pass++) {
      const p = await plan(c);
      if (!baselineSet) { ensureBaseline(p.run); baselineSet = true; }
      let failed = 0;
      for (const f of p.fixes.filter((x) => x.kind === k && !x.blocked)) {
        try { applyFix(f, root); applied++; if (!c.json) console.log(`✓ ${f.id}  ${f.title}`); } catch (e) {
          failed++;
          appendLedger({ at: new Date().toISOString(), event: 'skip', id: f.id, kind: f.kind, note: e instanceof Error ? e.message : String(e) });
          if (!c.json) console.log(`· 건너뜀 ${f.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!failed) break;
      if (pass === 2) skipped += failed;
    }
  }
  if (c.json) console.log(JSON.stringify({ schema: 'forgen-fix-apply/1', applied, skipped, backup: root, model: modelUse }, null, 2));
  else console.log(`\n✓ [forgen] 처방 ${applied}개 적용${skipped ? ` · ${skipped}개 건너뜀(대상이 바뀜 — 다시 --list)` : ''} · 스냅샷 ${root}\n  되돌리기: forgen fix --undo <id> | --undo all · 측정: forgen fix --report${c.model ? `\n  모델 호출 ${modelUse.calls}회(실패 ${modelUse.failed}, 캐시 적중 ${modelUse.cacheHits})` : ''}`);
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
  const rows = before.folders.map((b) => {
    const a = after.folders.find((x) => x.folder === b.folder);
    return { folder: b.folder, before: b.tokens, after: a?.tokens ?? 0, delta: (a?.tokens ?? 0) - b.tokens, pct: b.tokens ? Math.round((((a?.tokens ?? 0) - b.tokens) / b.tokens) * 1000) / 10 : 0 };
  });
  const r = rates(events);
  const out = {
    schema: 'forgen-fix-report/1', rates: r, folders: rows, medianPct: median(rows.map((x) => x.pct)), increased: rows.filter((x) => x.delta > 0).map((x) => x.folder),
    loss, mixConfirmed: mix, applied: appliedFixes().length, baselineAt: before.at,
  };
  if (c.json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`처방: 제안 ${r.proposed} · 적용 ${r.applied} (적용률 ${pct(r.applied, r.proposed)}) · 되돌림 ${r.undone} (되돌림률 ${pct(r.undone, r.applied)}, 목표 ≤ 10%)`);
  for (const [k, v] of Object.entries(r.byKind)) console.log(`  ${KIND_LABEL[k as FixKind] ?? k}: 제안 ${v.proposed} · 적용 ${v.applied} · 되돌림 ${v.undone}`);
  console.log(`\n폴더별 상시 로드 토큰(N3, 스킬 설명 제외) — 처방 전(${before.at.slice(0, 16)}) → 지금`);
  for (const x of rows) console.log(`  ${String(x.before).padStart(6)} → ${String(x.after).padStart(6)}  ${x.pct > 0 ? '+' : ''}${x.pct}%  ${shortPath(x.folder)}`);
  console.log(`  중앙값 ${out.medianPct > 0 ? '+' : ''}${out.medianPct}% (목표 −15% 이상) · 늘어난 폴더 ${out.increased.length}`);
  console.log(`중요 지침 누락 ${loss.reduce((n, l) => n + l.missing.length, 0)}${loss.length ? `: ${loss.map((l) => `${shortPath(l.folder)} ${l.missing.join(', ')}`).join(' / ')}` : ''}`);
  console.log(`다른 프로젝트 섞임(모델 판정) ${mix === null ? '— (--no-model)' : mix}`);
}

export async function handleFix(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { console.log(HELP); return; }
  const bad = args.filter((a, i) => a.startsWith('-') && !KNOWN.has(a) && !(i > 0 && WITH_VALUE.has(args[i - 1])));
  if (bad.length) { console.error(`[forgen] 알 수 없는 fix 옵션: ${bad.join(' ')}\n${HELP}`); process.exitCode = 1; return; }
  const c: Ctx = { folders: values(args, '--folder'), claudeDir: values(args, '--claude-dir')[0], model: !args.includes('--no-model'), json: args.includes('--json') };
  const kindArg = values(args, '--kind')[0];
  // 쉼표로 여러 종류(적용 순서는 FIX_KINDS 순서)
  const wanted = kindArg === 'all' ? FIX_KINDS : kindArg ? kindArg.split(',').map((k) => k.trim()) : null;
  const kinds: FixKind[] | null = wanted?.every((k) => FIX_KINDS.includes(k as FixKind)) ? FIX_KINDS.filter((k) => wanted.includes(k)) : null;
  if (kindArg && !kinds) { console.error(`[forgen] 알 수 없는 처방 종류: ${kindArg} (${FIX_KINDS.join(' · ')} · all)`); process.exitCode = 1; return; }
  try {
    if (args.includes('--undo')) {
      const target = values(args, '--undo')[0];
      if (!target) throw new Error('--undo 뒤에 처방 id 또는 all');
      const list = target === 'all' ? appliedFixes() : [{ id: target }];
      if (!list.length) { console.log('되돌릴 처방이 없다.'); return; }
      for (const { id } of list) {
        const r = undoFix(id);
        if ('conflicts' in r) { printConflicts(id, r.conflicts); process.exitCode = 1; return; }
        if (!c.json) console.log(`✓ [forgen] ${id} 되돌림(파일 ${r.restored}개)`);
      }
      return;
    }
    if (args.includes('--report')) { await report(c); return; }
    const positional = args.filter((a, i) => !a.startsWith('-') && !(i > 0 && WITH_VALUE.has(args[i - 1])));
    if (args.includes('--apply') && kinds) { await applyKinds(c, kinds); return; }
    const p = await plan(c);
    if (positional[0]) {
      const f = p.fixes.find((x) => x.id === positional[0]) ?? (p.fixes.filter((x) => x.id.startsWith(positional[0])).length === 1 ? p.fixes.find((x) => x.id.startsWith(positional[0])) : undefined);
      if (!f) throw new Error(`처방을 찾지 못함: ${positional[0]} — forgen fix --list (원천이 바뀌면 처방도 바뀐다)`);
      if (!args.includes('--apply')) { show(f); return; }
      ensureBaseline(p.run);
      const r = applyFix(f, newBackupRoot());
      console.log(`✓ [forgen] ${f.id} 적용 · 스냅샷 ${r.backup}\n  되돌리기: forgen fix --undo ${f.id}`);
      return;
    }
    const list = kinds ? p.fixes.filter((f) => kinds.includes(f.kind)) : p.fixes;
    if (c.json) { console.log(JSON.stringify({ schema: 'forgen-fix-list/1', generatedAt: p.generatedAt, model: !!p.model, fixes: list.map(({ ops: _o, ...f }) => f) }, null, 2)); return; }
    const ready = list.filter((f) => !f.blocked);
    console.log(`처방 ${ready.length}개 · 지적만 ${list.length - ready.length}개${p.model ? '' : ' (--no-model: 결정적 처방만)'}`);
    for (const k of FIX_KINDS) {
      const xs = list.filter((f) => f.kind === k);
      if (!xs.length) continue;
      console.log(`\n${KIND_LABEL[k]} (${xs.filter((f) => !f.blocked).length}${xs.some((f) => f.blocked) ? ` · 지적만 ${xs.filter((f) => f.blocked).length}` : ''})`);
      for (const f of xs) console.log(line(f));
    }
    if (ready.length) console.log('\n보기: forgen fix <id> · 적용: forgen fix <id> --apply · 묶음: forgen fix --kind <종류|all> --apply');
    if (c.model) console.log(`모델 호출 ${modelUse.calls}회(실패 ${modelUse.failed}, 캐시 적중 ${modelUse.cacheHits})`);
  } catch (e) {
    console.error(`[forgen] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
