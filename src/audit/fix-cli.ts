/**
 * forgen fix — 처방 (docs/plans/2026-11-25-v1.0-plan.md §2.1, §5 · 0.9.1 화면 정리 docs/plans/2026-11-26-v0.9.1-fixes.md).
 *   forgen fix --list [--kind <종류>] [--json]            처방 목록(추천 순서·종류 설명과 함께, 지적만인 것은 까닭과 함께)
 *   forgen fix <id> [--apply]                             무엇이 어떻게 바뀌나(전/후 문장 + 파일 diff), --apply 면 적용(백업 먼저)
 *   forgen fix --kind <종류|all> --apply                  묶음 적용(종류 순서대로, 종류마다 다시 계획)
 *   forgen fix --undo <id|all>                            그 처방이 건드린 파일만 되돌림 — 그사이 바뀌었으면 멈추고 3자 diff
 *   forgen fix <id> --skip | --unskip                     묶음 적용에서 빼 둠 / 다시 넣음
 *   forgen fix --report [--json]                          적용 기록, 처방 전후 세션 시작 토큰, 중요 지침 누락, 섞임
 *   공통: [--folder <경로>]... [--claude-dir <경로>] [--no-model]
 * 쓰는 곳은 처방 대상 파일과 <FORGEN_HOME>/backups/fix-*, <FORGEN_HOME>/audit/{fix,deleted.jsonl} 뿐이다. 커밋하지 않는다.
 * 0.9.1 #9: `fix <id> --apply` 는 가장 최근 목록·보기에서 저장한 처방을 쓰고, 대상 파일 해시가 그대로일 때만 바로 적용한다(바뀌었으면 다시 계획).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FORGEN_HOME, ME_RULES } from '../core/paths.js';
import { Judge, takeModelDisclosure } from './judge.js';
import {
  appliedFixes, applyFix, ensureBaseline, FIX_KINDS, KIND_CLI, KIND_LABEL, kindFromCli, lossCheck, measure, newBackupRoot, planFixes, previewFix,
  rates, readLedger, recordProposed, undoFix, unifiedDiff, appendLedger, fixPaths, withFixLock, excludedFixes, sameSetN3, importantMissing, stateHash, fixDir, baselinePath,
  type Fix, type FixKind, type FixPlan,
} from './fix.js';
import { shortPath } from './html.js';
import { groupSame, representative } from './activity.js';
import { getLocale, initLocaleFromConfig } from '../i18n/index.js';

/** 목표(−15%) 경계: −16% ~ −15% 면 룰이 몇 개만 늘어도 깨질 수 있다. 목표 숫자는 오너 결정이라 바꾸지 않는다. */
export function n3EdgeWarning(pct: number): string | null {
  return pct <= -15 && pct >= -16 ? `목표에 아슬아슬함(${pct}%, 목표 −15%) — 룰이 몇 개 늘면 못 미칠 수 있음` : null;
}

const HELP_KO = `  forgen fix --list [--kind <종류>] [--json]
      감사 결과로 처방 목록을 낸다(추천 순서와 종류별 설명). 종류: ${FIX_KINDS.map((k) => KIND_CLI[k]).join(' · ')}
  forgen fix <id> [--apply]
      무엇이 어떻게 바뀌는지(전/후 문장, 그 아래 파일 바뀜). --apply 면 백업(~/.forgen/backups/fix-<시각>/)한 뒤 적용
  forgen fix --kind <종류|all> --apply
      그 종류 처방을 전부 적용(all = 끄기 → 지우기 → 합치기 → 겹침 → 범위 → 옮기기 → 짧게 → MEMORY.md → 기억 추가.
      상황 맞춤 조건은 all 에 없고 --kind condition 으로만)
  forgen fix --undo <id|all>
      그 처방이 건드린 파일만 되돌린다. 그사이 그 파일이 바뀌었으면 멈추고 세 가지(처방 전·처방 뒤·지금)를 보여 준다
  forgen fix <id> --skip | --unskip
      그 처방을 묶음 적용에서 빼 둔다 / 다시 넣는다
  forgen fix --report [--json]
      적용·되돌림 기록 · 처방 전후 세션 시작 토큰(스킬 설명 제외) · 빠진 중요 지침 · 다른 프로젝트 섞임
  공통: [--folder <경로>]... [--claude-dir <경로>] [--no-model]  (--no-model: 모델 없이 만드는 처방만 — 같은 문장 정리·지우기·MEMORY.md 줄·끄기)
  고치는 곳: 자동 메모 · .claude/rules · forgen 룰 · git 안 CLAUDE.md·AGENTS.md(커밋 안 함). 관리형·git 밖 지침 파일은 알리기만 한다`;

const HELP_EN = `  forgen fix --list [--kind <kind>] [--json]
      List prescriptions from the audit (recommended order and what each kind does). Kinds: ${FIX_KINDS.map((k) => KIND_CLI[k]).join(' · ')}
  forgen fix <id> [--apply]
      What changes and how (before/after sentence, then the file diff). --apply backs up to ~/.forgen/backups/fix-<time>/ first
  forgen fix --kind <kind|all> --apply
      Apply every prescription of that kind (all = plugin-off → remove → merge → overlap → scope → move → rewrite → index → add-memory;
      situational conditions are not in all — use --kind condition)
  forgen fix --undo <id|all>
      Restore only the files that prescription touched. If a file changed since, stop and show before / after / now
  forgen fix <id> --skip | --unskip
      Leave a prescription out of batch apply / put it back
  forgen fix --report [--json]
      Apply/undo history · session-start tokens before vs now (skill descriptions excluded) · important rules not loaded · cross-project mix
  Common: [--folder <path>]... [--claude-dir <path>] [--no-model]  (--no-model: only prescriptions that need no model)
  Writes: auto memory · .claude/rules · forgen rules · CLAUDE.md/AGENTS.md inside git (never commits). Managed and out-of-git files are only reported`;

export function fixHelp(): string { initLocaleFromConfig(); return getLocale() === 'ko' ? HELP_KO : HELP_EN; }

/** 종류마다 한 줄 설명(목록 머리). */
export const KIND_HELP: Record<FixKind, string> = {
  'plugin-off': '안 쓰거나 겹치는 플러그인·스킬을 끈다(지우지 않음)',
  remove: '지금 없는 파일·명령을 가리키는 줄을 지우거나 룰을 끈다',
  merge: '같은 문장·같은 뜻 지시를 한 곳만 남긴다',
  overlap: 'forgen 룰과 Claude 기억에 같은 교정이 있으면 forgen 쪽을 세션 시작에서 뺀다(룰은 남김)',
  scope: '한 프로젝트 전용인 forgen 룰을 그 프로젝트에서만 실리게 한다',
  move: '모든 프로젝트에 실리는 파일의 한 프로젝트 전용 줄을 그 저장소로 옮긴다',
  rewrite: '너무 긴 지시를 같은 뜻의 짧은 문장으로 바꾼다',
  index: 'MEMORY.md 의 긴 줄을 짧게 하고 설명 원문은 메모 파일에 남긴다',
  'add-memory': '어디에도 안 적혀 되풀이한 교정을 새 메모로 적는다',
  'tier2-condition': '특정 상황에서만 필요한 룰을 그 상황에만 넣게 한다',
};

const KNOWN = new Set(['--list', '--kind', '--apply', '--yes', '--undo', '--report', '--json', '--folder', '--claude-dir', '--no-model', '--skip', '--unskip', '--help', '-h']);
const WITH_VALUE = new Set(['--kind', '--undo', '--folder', '--claude-dir']);

function values(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === name && args[i + 1] && !args[i + 1].startsWith('--')) out.push(args[i + 1]); });
  return out;
}

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10; };
const sg = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}%`;

interface Ctx { folders: string[]; claudeDir?: string; model: boolean; json: boolean }

/** 이 실행에서 부른 모델 호출 수(판정 + 처방 문안, 저장된 판정 재사용 제외). */
const modelUse = { calls: 0, failed: 0, cacheHits: 0, ms: 0 };

// ── 가장 최근 처방 목록 저장(0.9.1 #9) ──
const planPath = () => path.join(fixDir(), 'plan-latest.json');
interface SavedPlan { schema: 'forgen-fix-plan/1'; generatedAt: string; rulesStamp?: string; fixes: Array<Fix & { hashes: Record<string, string>; dirs?: Record<string, string> }> }
/** 폴더 한 단계의 지문(이름·크기·수정 시각) — 그 폴더에 파일이 새로 생기거나 바뀌면 달라진다. 하위 폴더는 보지 않는다. */
function dirStamp(dir: string): string {
  try {
    const items = fs.readdirSync(dir).sort().map((n) => { try { const st = fs.statSync(path.join(dir, n)); return `${n}|${st.size}|${Math.round(st.mtimeMs)}`; } catch { return `${n}|?`; } });
    return createHash('sha256').update(items.join('\n')).digest('hex').slice(0, 16);
  } catch { return 'absent'; }
}
/** 가장 최근 감사 회차 시각(ISO). 회차 폴더 이름 20261126T070736Z-… 에서 읽는다. */
function latestAuditAt(): string | null {
  try {
    const names = fs.readdirSync(path.join(FORGEN_HOME, 'audit')).filter((n) => /^\d{8}T\d{6}Z-/.test(n)).sort();
    const n = names[names.length - 1];
    return n ? `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 8)}T${n.slice(9, 11)}:${n.slice(11, 13)}:${n.slice(13, 15)}Z` : null;
  } catch { return null; }
}
function savePlan(p: FixPlan): void {
  try {
    const body: SavedPlan = { schema: 'forgen-fix-plan/1', generatedAt: p.generatedAt, rulesStamp: dirStamp(ME_RULES), fixes: p.fixes.map((f) => ({ ...f, hashes: Object.fromEntries(fixPaths(f).map((x) => [x, stateHash(x)])), dirs: Object.fromEntries([...new Set(fixPaths(f).map((x) => path.dirname(x)))].map((d) => [d, dirStamp(d)])) })) };
    fs.mkdirSync(fixDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(planPath(), JSON.stringify(body), { mode: 0o600 });
  } catch { /* 저장 실패 = 다음 적용은 다시 계획 */ }
}
/** 저장한 처방 중 대상 파일이 그대로인 것. 없거나 바뀌었으면 null(다시 계획). */
export function savedFix(idOrPrefix: string): Fix | null {
  let saved: SavedPlan;
  try { saved = JSON.parse(fs.readFileSync(planPath(), 'utf-8')) as SavedPlan; } catch { return null; }
  if (saved.schema !== 'forgen-fix-plan/1') return null;
  // A2: 처방이 가장 최근 감사 회차보다 오래됐거나, 그 뒤 룰 저장소·대상 폴더가 바뀌었으면 다시 계산한다(대상 파일 해시만 보지 않는다).
  const audited = latestAuditAt();
  if (audited && saved.generatedAt.slice(0, 19) < audited.slice(0, 19)) return null;
  if (saved.rulesStamp !== undefined && saved.rulesStamp !== dirStamp(ME_RULES)) return null;
  const hits = saved.fixes.filter((x) => x.id === idOrPrefix || x.id.startsWith(idOrPrefix));
  const f = hits.find((x) => x.id === idOrPrefix) ?? (hits.length === 1 ? hits[0] : undefined);
  if (!f) return null;
  for (const [p, h] of Object.entries(f.hashes)) if (stateHash(p) !== h) return null;
  for (const [d, h] of Object.entries(f.dirs ?? {})) if (dirStamp(d) !== h) return null;
  const { hashes: _h, dirs: _d, ...fix } = f;
  return fix;
}

async function plan(c: Ctx): Promise<FixPlan> {
  const judge = c.model ? new Judge({ model: true }) : null;
  if (judge) { const d = takeModelDisclosure(); if (d) (c.json ? process.stderr.write.bind(process.stderr) : (s: string) => console.log(s))(`${d}\n`); }
  const p = await planFixes({ folders: c.folders.length ? c.folders : undefined, claudeDir: c.claudeDir, judge });
  if (judge) { modelUse.calls += judge.stats.calls; modelUse.failed += judge.stats.failedCalls; modelUse.cacheHits += judge.stats.cacheHits; modelUse.ms += judge.stats.ms; }
  recordProposed(p.fixes);
  savePlan(p);
  return p;
}

/** 긴 줄은 100자마다 줄바꿈(들여쓰기 맞춤) — 전문을 자르지 않는다. */
const wrap = (s: string, w = 100) => (s.match(new RegExp(`.{1,${w}}`, 'gu')) ?? ['']).join('\n        ');
const tokenTag = (f: Fix) => (f.tokens > 0 ? `  (세션마다 −${f.tokens}토큰)` : f.tokens < 0 ? `  (세션마다 +${-f.tokens}토큰)` : '');

export function line(f: Fix, skipped = false): string {
  const out = [`  ${f.id}  ${skipped ? '[빼 둠] ' : ''}${f.title}${tokenTag(f)}${f.model ? '  [문장은 모델이 씀]' : ''}`];
  if (f.change && !f.blocked) out.push(`      전: ${f.change.before}`, `      후: ${f.change.after}`);
  if (!f.blocked) out.push(`      근거: ${f.quote ?? '파일 비교'}`);
  if (f.blocked) out.push(`      (고치지 않고 알려만 줌) ${f.blocked}`);
  if (f.manual) out.push(`      하나씩만: ${f.manual}`);
  return out.join('\n');
}

function show(f: Fix): void {
  console.log(`${f.id} · ${KIND_LABEL[f.kind]}${f.model ? ' · 문장은 모델이 씀' : ''}\n${f.title}${tokenTag(f)}`);
  if (f.lines?.length) {
    // 줄마다 전·후 전문(잘라 내지 않음)과 빠지는 설명이 남는 곳
    f.lines.forEach((x, i) => { console.log(`  [${i + 1}/${f.lines?.length}]\n    전: ${wrap(x.before)}\n    후: ${wrap(x.after)}\n    빠지는 설명: ${x.keptIn}`); });
  } else if (f.change && !f.blocked) console.log(`  전: ${f.change.before}\n  후: ${f.change.after}`);
  console.log(`  근거: ${f.quote ?? '파일 비교'}`);
  console.log(`\n왜: ${f.why}`);
  if (f.evidence.length) { console.log('근거:'); for (const e of f.evidence) console.log(`  · ${e}`); }
  if (f.blocked) { console.log(`\n(고치지 않고 알려만 줌) ${f.blocked}`); return; }
  if (f.manual) console.log(`\n하나씩만 — ${f.manual}`);
  console.log(`\n적용: forgen fix ${f.id} --apply   · 되돌리기: forgen fix --undo ${f.id}`);
  console.log('\n── 상세: 바뀌는 파일 ──');
  for (const pv of previewFix(f)) {
    if (pv.dir) { console.log(`폴더를 백업으로 옮김(끄기): ${shortPath(pv.path)}`); continue; }
    for (const l of unifiedDiff(pv.before, pv.after, shortPath(pv.path))) console.log(l);
  }
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
  else console.log(`\n✓ [forgen] 처방 ${applied}개 적용${skipped ? ` · ${skipped}개 건너뜀(그사이 대상이 바뀜 — 다시 --list)` : ''}${manual ? ` · 하나씩만 적용하는 처방 ${manual}개는 뺌(forgen fix --list 에서 보고 <id> --apply)` : ''}${excluded.size ? ` · 빼 둔 처방 ${excluded.size}개 제외` : ''} · 백업 ${shortPath(root)}\n  되돌리기: forgen fix --undo <id> | --undo all · 전후 비교: forgen fix --report${c.model ? `\n  모델 호출 ${modelUse.calls}번(실패 ${modelUse.failed}, 저장된 판정 ${modelUse.cacheHits}개 재사용)` : ''}`);
}

function printConflicts(id: string, conflicts: Array<{ path: string; base: string | null; fixed: string | null; current: string | null }>): void {
  console.log(`✗ [forgen] ${id}: 처방 뒤에 바뀐 파일이 있어 되돌리지 않았다(아무것도 바꾸지 않음). 세 가지 비교:`);
  for (const c of conflicts) {
    console.log(`\n== ${shortPath(c.path)}`);
    console.log('-- 처방 전 → 처방 뒤(forgen 이 바꾼 것)');
    for (const l of unifiedDiff(c.base, c.fixed, shortPath(c.path))) console.log(l);
    console.log('-- 처방 뒤 → 지금(그사이 바뀐 것)');
    for (const l of unifiedDiff(c.fixed, c.current, shortPath(c.path))) console.log(l);
  }
  console.log('\n직접 합친 뒤 다시 처방하거나, 처방 전 원본은 백업 폴더의 before/ 에 있다.');
}

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

async function report(c: Ctx): Promise<void> {
  const { runAudit } = await import('./run.js');
  const events = readLedger();
  const run = runAudit({ folders: c.folders.length ? c.folders : undefined, claudeDir: c.claudeDir });
  const before = ensureBaseline(run);
  const after = measure(run);
  // 처방 전 대비로 사라진 메모(합치기·지우기 뒤 같은 뜻으로도 안 실리는 교정 메모) — forgen 룰은 아래 절대값으로 센다
  const lostMemos = lossCheck(before, after, events).map((l) => ({ folder: l.folder, missing: l.missing.filter((k) => !k.startsWith('rule:')) })).filter((l) => l.missing.length);
  const missing = importantMissing(run);
  let mix: number | null = null;
  if (c.model) {
    const { runModelChecks } = await import('./model-checks.js');
    mix = (await runModelChecks(run.result, run.ctx, new Judge({ model: true }))).counts.mixConfirmed;
  }
  // 기억 추가는 줄인 양 비교와 따로 센다(새 기억이 실리는 몫): 폴더 비교는 그 몫을 뺀 값으로
  const live = new Map<string, (typeof events)[number]>();
  for (const e of events) { if (e.event === 'apply') live.set(e.id, e); if (e.event === 'undo') live.delete(e.id); }
  const added = new Map<string, number>();
  for (const e of live.values()) if (e.addsTo) added.set(e.addsTo.folder, (added.get(e.addsTo.folder) ?? 0) + e.addsTo.tokens);
  const p1 = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
  // 같은 룰·기억을 실을 때끼리 비교: 처방 뒤 빈자리로 새로 실린 룰(전에는 자리가 없어 빠지던 룰)은 줄인 양에서 빼고 따로 센다.
  const same = new Map(sameSetN3(before, after, run).map((x) => [x.folder, x]));
  const sessionsOf = new Map(run.result.folders.map((f) => [f.folder, f.sessions30d ?? 0]));
  const rows = before.folders.map((b) => {
    const total = after.folders.find((x) => x.folder === b.folder)?.tokens ?? 0;
    const mem = added.get(b.folder) ?? 0;
    const ss = same.get(b.folder);
    const revivedTokens = ss?.revivedTokens ?? 0;
    const diet = total - mem - revivedTokens;
    const allNow = total - mem;
    const exp = run.result.folders.find((x) => x.folder === b.folder)?.forgenTier2?.expected ?? 0;
    const base = b.legacyTokens ?? b.tokens;
    return {
      folder: b.folder, sessions: sessionsOf.get(b.folder) ?? 0, before: base, after: diet, expected: diet + exp, addedMemory: mem, withMemory: total, delta: diet - base, pct: p1(diet, base), expectedPct: p1(diet + exp, base), pctWithMemory: p1(total, base),
      revived: ss?.revived.length ?? 0, revivedImportant: ss?.revivedImportant.length ?? 0, revivedTokens, allNow, allNowPct: p1(allNow, base), legacyBase: b.legacyTokens !== undefined,
      formatPct: b.legacyTokens !== undefined ? p1(b.tokens, base) : 0, fixPct: Math.round((p1(diet, base) - (b.legacyTokens !== undefined ? p1(b.tokens, base) : 0)) * 10) / 10,
    };
  });
  const rep = (val: (x: (typeof rows)[number]) => number) => representative(rows.map((x) => ({ value: val(x), sessions: x.sessions })));
  const r = rates(events);
  const { latestRecurrence } = await import('./recurrence.js');
  const rec = latestRecurrence();
  const tier2Missed = (rec?.items ?? []).filter((it) => it.match?.reason === 'tier2-missed').map((it) => ({ ruleId: it.match?.ruleId ?? '', ts: it.ts }));
  const tier2 = { rules: run.ctx.tier2In?.size ?? 0, tokensUpper: run.result.folders.map((f) => ({ folder: f.folder, rules: f.forgenTier2?.rules ?? 0, tokens: f.forgenTier2?.tokens ?? 0 })) };
  const repPct = rep((x) => x.pct);
  const out = {
    schema: 'forgen-fix-report/2', n3Definition: 'same-set/2026-11-26', representative: 'session-weighted/active-30d', rates: r, folders: rows,
    representativePct: repPct?.value ?? 0, representativeWeighted: repPct?.weighted ?? false, representativeFolders: repPct?.folders ?? 0,
    medianPct: median(rows.map((x) => x.pct)), expectedPct: rep((x) => x.expectedPct)?.value ?? 0,
    allNowPct: rep((x) => x.allNowPct)?.value ?? 0, formatPct: rep((x) => x.formatPct)?.value ?? 0, fixPct: rep((x) => x.fixPct)?.value ?? 0,
    revived: new Set([...same.values()].flatMap((x) => x.revived)).size, revivedImportant: new Set([...same.values()].flatMap((x) => x.revivedImportant)).size, increased: rows.filter((x) => x.delta > 0).map((x) => x.folder),
    importantMissing: missing.filter((m) => m.rules.length), lostMemos, tier2Missed, tier2, mixConfirmed: mix, applied: appliedFixes().length, baselineAt: before.at,
  };
  if (c.json) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`처방 기록: 지금까지 낸 처방 ${r.proposed}개(이미 적용·끈 것 포함 — 지금 목록에는 남은 것만 나옴) 중 ${r.applied}개 적용 · ${r.undone}개 되돌림`);
  console.log(`  종류별(적용/제안): ${Object.entries(r.byKind).map(([k, v]) => `${KIND_LABEL[k as FixKind] ?? k} ${v.applied}/${v.proposed}${v.undone ? `(되돌림 ${v.undone})` : ''}`).join(' · ')}`);
  console.log(`\n세션 시작에 실리는 기억 — 처방 전(${before.at.slice(0, 16).replace('T', ' ')}) → 지금, 스킬 설명 제외`);
  if (repPct) {
    console.log(`  ${repPct.weighted ? `자주 쓰는 폴더(최근 30일 세션 3개 이상) ${repPct.folders}곳, 세션 수로 가중한 평균` : `모든 폴더 ${repPct.folders}곳 평균(최근 30일 세션 3개 넘는 폴더 없음)`}: ${sg(repPct.value)} (목표 −15%)`);
    if (rows.every((x) => x.legacyBase)) console.log(`    그중 forgen 룰 표기를 짧게 바꿔서 ${sg(out.formatPct)} · 처방으로 ${sg(out.fixPct)}`);
    const edge = n3EdgeWarning(repPct.value);
    if (edge) console.log(`    ⚠ ${edge}`);
  }
  console.log('  폴더별:');
  const groups = groupSame(rows, (x) => `${x.before}|${x.after}|${x.revived}|${x.addedMemory}`);
  for (const g of groups.sort((a, b) => b.first.sessions - a.first.sessions)) {
    const x = g.first;
    const names = g.rows.length > 1 ? `${shortPath(x.folder)} 외 ${g.rows.length - 1}곳(결과 같음)` : shortPath(x.folder);
    const sessions = g.rows.reduce((n, y) => n + y.sessions, 0);
    const rare = g.rows.every((y) => y.sessions < 3);
    console.log(`    ${String(x.before).padStart(6)} → ${String(x.after).padStart(6)}  ${sg(x.pct).padStart(7)}  ${names}  (최근 30일 세션 ${g.rows.length > 1 ? '합 ' : ''}${sessions}개${rare ? ' · 거의 안 씀, 평균에서 뺌' : ''})${x.addedMemory ? `  + 새 메모 ${x.addedMemory}토큰` : ''}`);
  }
  if (out.revived) console.log(`  전에는 세션 시작 분량 상한을 넘어서 빠지던 forgen 룰 ${out.revived}개가 이제 실린다(그중 중요 지침 ${out.revivedImportant}개). 위 줄인 양에서는 뺐고, 넣고 세면 ${sg(out.allNowPct)}`);
  if (added.size) console.log('  기억 추가로 새로 실리는 메모는 위 줄인 양에서 뺐다(폴더 줄 끝 "+ 새 메모")');
  if (rows.some((x) => x.expected !== x.after)) console.log(`  상황 맞춤 룰이 지난 세션만큼 들어온다고 보면: ${sg(out.expectedPct)} (위 값은 하나도 안 들어올 때)`);
  const nMissing = out.importantMissing.reduce((n, m) => n + m.rules.length, 0);
  console.log(`\n중요 지침(직접 교정했거나 반드시·강하게 지킬 forgen 룰) 중 그 폴더 세션 시작에 안 실린 것: ${nMissing}개`);
  for (const m of out.importantMissing) console.log(`  ${shortPath(m.folder)} ${m.rules.length}개 — 예: "${clip(m.rules[0].policy, 50)}"`);
  if (lostMemos.length) {
    console.log(`처방 뒤 세션 시작에 안 실리게 된 교정 메모: ${lostMemos.reduce((n, l) => n + l.missing.length, 0)}개`);
    for (const l of lostMemos) console.log(`  ${shortPath(l.folder)} ${l.missing.length}개 — 예: ${path.basename(l.missing[0].replace(/^[a-z]+:/, ''))}`);
  }
  if (tier2.rules || tier2Missed.length) {
    console.log(`상황 맞춤 룰(조건이 맞을 때만 들어옴) ${tier2.rules}개 · 필요한 순간에 안 들어와 같은 교정을 다시 한 일 ${tier2Missed.length}번${tier2Missed.length ? ' — 그 룰은 다시 세션마다 실리게 바뀜' : ''}`);
    console.log('  한계: 다시 교정하지 않고 지나간 경우는 셀 수 없다');
  }
  console.log(`다른 프로젝트 지시가 섞인 것(모델 판정): ${mix === null ? '— (--no-model 이라 안 셈)' : `${mix}개`}`);
  if (rec && rec.status !== 'model-off' && rec.status !== 'no-data') {
    const { judgeChanges, rangeText, RANGE_NOTE, recurrenceLine, staleLine } = await import('./recurrence.js');
    if (rec.status === 'incomplete') console.log(recurrenceLine(rec));
    else if (judgeChanges(rec).length) console.log(staleLine(rec));
    else console.log(`같은 말 다시 하기(가장 최근 재생 ${rec.generatedAt.slice(0, 10)}): 내 요청의 ${rangeText(rec, 'total', 'per1000', (x) => `${Math.round(x) / 10}%`)} · 이미 적혀 있는데 또 말한 것 30일 약 ${rangeText(rec, 'written', 'per30d', (x) => String(Math.round(x)))}번${rec.range ? ` (${RANGE_NOTE})` : ''}`);
  }
  console.log('자세히(룰 ID·폴더별 전체 숫자): forgen fix --report --json');
  console.log('\n다음에 할 일');
  console.log(`  1. forgen fix --list — 남은 처방을 추천 순서로 봅니다`);
  if (nMissing) console.log('  2. forgen rule list — 안 실린 중요 지침이 그 폴더에 맞는 룰인지 봅니다');
  else console.log('  2. forgen audit — 처방 뒤 첫 화면을 다시 봅니다');
}

/** 목록 머리: 추천 순서(되돌리기 쉬운 것 → 판단이 필요한 것). 있는 종류만. */
function recommendedOrder(ready: Fix[]): string[] {
  const has = (...ks: FixKind[]) => ready.filter((f) => ks.includes(f.kind) && !f.manual).length;
  const out: string[] = [];
  const easy = has('plugin-off', 'remove') + ready.filter((f) => f.kind === 'merge' && !f.model).length;
  if (easy) out.push(`되돌리기 쉬운 것부터(${easy}개): 끄기·지우기·같은 문장 합치기 — forgen fix --kind plugin-off,remove,merge --apply`);
  const text = ready.filter((f) => (f.kind === 'merge' && f.model) || f.kind === 'rewrite' || f.kind === 'index' || f.kind === 'overlap').length;
  if (text) out.push(`문장이 바뀌는 것(${text}개): 같은 뜻 합치기·짧게 쓰기·MEMORY.md 줄 — forgen fix <id> 로 전/후를 보고 하나씩`);
  const judge = ready.filter((f) => f.kind === 'scope' || f.kind === 'move' || f.kind === 'add-memory' || f.kind === 'tier2-condition' || f.manual).length;
  if (judge) out.push(`판단이 필요한 것(${judge}개): 범위 옮기기·기억 추가·상황 맞춤 조건 — 내용을 보고 맞는 것만`);
  return out;
}

export async function handleFix(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { console.log(fixHelp()); return; }
  const bad = args.filter((a, i) => a.startsWith('-') && !KNOWN.has(a) && !(i > 0 && WITH_VALUE.has(args[i - 1])));
  if (bad.length) { console.error(`[forgen] 알 수 없는 fix 옵션: ${bad.join(' ')}\n${fixHelp()}`); process.exitCode = 1; return; }
  const c: Ctx = { folders: values(args, '--folder'), claudeDir: values(args, '--claude-dir')[0], model: !args.includes('--no-model'), json: args.includes('--json') };
  const kindArg = values(args, '--kind')[0];
  // 쉼표로 여러 종류(적용 순서는 FIX_KINDS 순서). all 에는 상황 맞춤 조건을 넣지 않는다 — 목록을 보고 --kind condition 으로 따로 승인한다.
  const wanted = kindArg === 'all' ? FIX_KINDS.filter((k) => k !== 'tier2-condition') : kindArg ? kindArg.split(',').map((k) => kindFromCli(k.trim())) : null;
  const kinds: FixKind[] | null = wanted?.every((k) => k !== null) ? FIX_KINDS.filter((k) => wanted.includes(k)) : null;
  if (kindArg && !kinds) { console.error(`[forgen] 알 수 없는 처방 종류: ${kindArg} (${FIX_KINDS.map((k) => KIND_CLI[k]).join(' · ')} · all)`); process.exitCode = 1; return; }
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
      // 상황 맞춤 조건 일괄 승인은 요약을 보이고 --yes 가 있어야 적용한다. 경고가 붙은 것은 일괄에서 빠진다(하나씩만).
      if (kinds.includes('tier2-condition') && !args.includes('--yes')) {
        const p = await plan(c);
        const xs = p.fixes.filter((f) => f.kind === 'tier2-condition' && !f.blocked);
        const ex = excludedFixes();
        const wide = xs.filter((f) => f.estimate?.wide).length;
        const skipped = xs.filter((f) => ex.has(f.id)).length;
        const go = xs.filter((f) => !f.manual && !ex.has(f.id)).length;
        const tokens = xs.filter((f) => !f.manual && !ex.has(f.id)).reduce((n, f) => n + f.tokens, 0);
        console.log(`상황 맞춤 조건 ${xs.length}개 — 거의 늘 걸리는 것 ${wide} · 빼 둔 것 ${skipped}${p.notProposedConditions ? ` · 제안 안 함 ${p.notProposedConditions}개(최근 세션에서 쓸 일이 없음)` : ''}`);
        console.log(`한꺼번에 승인하면 ${go}개 적용(세션 시작 최대 약 −${tokens}토큰). 경고 붙은 ${wide}개는 빠진다 — 보고 나서 forgen fix <id> --apply 로 하나씩`);
        console.log('목록: forgen fix --list --kind condition · 빼기: forgen fix <id> --skip · 확인 뒤 적용: forgen fix --kind condition --apply --yes');
        return;
      }
      await withFixLock(() => applyKinds(c, kinds));
      return;
    }
    // 0.9.1 #9: 하나 적용은 가장 최근 목록·보기에서 저장한 처방을 쓴다(대상 파일 해시가 같을 때). 기준값이 없으면 감사만 다시 돈다(모델 없이).
    if (positional[0] && args.includes('--apply') && !args.includes('--skip') && !args.includes('--unskip')) {
      const f = savedFix(positional[0]);
      if (f) {
        const r = await withFixLock(async () => {
          if (!fs.existsSync(baselinePath())) { const { runAudit } = await import('./run.js'); ensureBaseline(runAudit({ folders: c.folders.length ? c.folders : undefined, claudeDir: c.claudeDir })); }
          return applyFix(f, newBackupRoot());
        });
        console.log(`✓ [forgen] ${f.id} 적용 · 백업 ${shortPath(r.backup)}\n  ${f.title}\n  되돌리기: forgen fix --undo ${f.id}`);
        return;
      }
    }
    const p = await plan(c);
    if (positional[0]) {
      const f = p.fixes.find((x) => x.id === positional[0]) ?? (p.fixes.filter((x) => x.id.startsWith(positional[0])).length === 1 ? p.fixes.find((x) => x.id.startsWith(positional[0])) : undefined);
      if (!f) throw new Error(`처방을 찾지 못함: ${positional[0]} — forgen fix --list (기억 파일이 바뀌면 처방도 바뀐다)`);
      if (args.includes('--skip') || args.includes('--unskip')) {
        const skip = args.includes('--skip');
        appendLedger({ at: new Date().toISOString(), event: skip ? 'exclude' : 'include', id: f.id, kind: f.kind });
        console.log(skip ? `✓ [forgen] ${f.id} 를 묶음 적용에서 빼 둠 — 다시 넣기: forgen fix ${f.id} --unskip` : `✓ [forgen] ${f.id} 를 묶음 적용에 다시 넣음`);
        return;
      }
      if (!args.includes('--apply')) { show(f); return; }
      const r = await withFixLock(async () => { ensureBaseline(p.run); return applyFix(f, newBackupRoot()); });
      console.log(`✓ [forgen] ${f.id} 적용 · 백업 ${shortPath(r.backup)}\n  ${f.title}\n  되돌리기: forgen fix --undo ${f.id}`);
      return;
    }
    const list = kinds ? p.fixes.filter((f) => kinds.includes(f.kind)) : p.fixes;
    if (c.json) { console.log(JSON.stringify({ schema: 'forgen-fix-list/1', generatedAt: p.generatedAt, model: !!p.model, notProposedConditions: p.notProposedConditions ?? 0, fixes: list.map(({ ops: _o, ...f }) => f) }, null, 2)); return; }
    const excluded = excludedFixes();
    const ready = list.filter((f) => !f.blocked);
    console.log(`처방 ${ready.length}개 · 고치지 않고 알려만 주는 것 ${list.length - ready.length}개 (이미 적용·끈 것은 빼고 남은 것만)${p.model ? '' : ' (--no-model: 모델 없이 만드는 처방만)'}`);
    // B8: 처방 줄의 "세션마다 −N토큰" 기준
    {
      const fs0 = p.run.result.folders;
      const act = fs0.filter((x) => (x.sessions30d ?? 0) >= 3);
      const use = act.length ? act : fs0;
      const w = use.reduce((n, x) => n + (act.length ? (x.sessions30d ?? 0) : 1), 0);
      const avg = w ? Math.round(use.reduce((n, x) => n + x.totalTokens * (act.length ? (x.sessions30d ?? 0) : 1), 0) / w) : 0;
      if (avg) console.log(`토큰 기준: 자주 쓰는 폴더의 세션 시작 기억은 평균 약 ${avg}토큰 — 처방 줄의 "세션마다 −N토큰"은 그 처방이 걸린 폴더에서 세션마다 줄어드는 양(−${Math.round(avg / 100)}토큰 ≈ 1%)`);
    }
    const order = recommendedOrder(ready);
    if (order.length) { console.log('\n추천 순서'); order.forEach((l, i) => { console.log(`  ${i + 1}. ${l}`); }); }
    for (const k of FIX_KINDS) {
      const xs = list.filter((f) => f.kind === k);
      if (!xs.length) continue;
      console.log(`\n${KIND_LABEL[k]} (${xs.filter((f) => !f.blocked).length}${xs.some((f) => f.blocked) ? ` · 알려만 주는 것 ${xs.filter((f) => f.blocked).length}` : ''}) — ${KIND_HELP[k]}`);
      // 같은 까닭으로 고치지 않는 것이 3개 이상이면 한 줄로 묶는다(예 하나 + 수)
      const blockedBy = new Map<string, Fix[]>();
      for (const f of xs.filter((x) => x.blocked)) blockedBy.set(f.blocked as string, [...(blockedBy.get(f.blocked as string) ?? []), f]);
      for (const f of xs) {
        const same = f.blocked ? blockedBy.get(f.blocked) ?? [] : [];
        if (same.length >= 3) { if (same[0] === f) console.log(`  (고치지 않고 알려만 줌) ${same.length}개 — ${f.blocked}. 예: ${f.title} (각각: forgen fix --list --json)`); continue; }
        console.log(line(f, excluded.has(f.id)));
      }
      if (k === 'tier2-condition') console.log('  ↳ 빼기: forgen fix <id> --skip · 한꺼번에 승인: forgen fix --kind condition --apply --yes(경고 붙은 것은 빠짐) · 되돌리기: forgen fix --undo <id>');
    }
    if (p.notProposedConditions && (!kinds || kinds.includes('tier2-condition'))) console.log(`\n상황 맞춤 조건 제안 안 함 ${p.notProposedConditions}개(최근 세션에서 쓸 일이 없음)`);
    if (ready.length) console.log('\n보기: forgen fix <id> · 적용: forgen fix <id> --apply · 종류째: forgen fix --kind <종류|all> --apply');
    if (c.model) console.log(`모델 호출 ${modelUse.calls}번(실패 ${modelUse.failed}, 저장된 판정 ${modelUse.cacheHits}개 재사용)`);
  } catch (e) {
    console.error(`[forgen] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
