/**
 * forgen way — 내 방식 요약·내보내기·가져오기·메모리 수집 (ADR-020).
 *   forgen way [--all] [--json]
 *   forgen way export --target <t> [--project k] [--budget n] [--out dir] [--force] [--habits] [--item id]
 *   forgen way import <file.json> [--apply]
 *   forgen way collect-memory [--dir path] [--project key] [--apply] [--json]
 *   forgen way draft <skill|workflow> "<주제>" [--project k] [--out dir] [--force] [--no-llm]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadRenderReport } from '../renderer/render-report.js';
import { createSnapshot } from '../engine/rule-recovery-cli.js';
import { loadAllRules } from '../store/rule-store.js';
import { compile, projectSpecificSuspects } from './compile.js';
import { draftFiles, gatherSources, readTopic, writeDraft, type DraftKind } from './draft.js';
import { buildWay } from './extract.js';
import { applyImport, candidateToItem, parseWayJson, planImport, readMemoryCandidates, writeFiles } from './io.js';
import type { CompileTarget, Way, WayItem } from './types.js';
import { COMPILE_TARGETS } from './types.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
}
function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === name && args[i + 1] && !args[i + 1].startsWith('--')) out.push(args[i + 1]); });
  return out;
}

function blockedMessage(b: { action: string; abs: string }, hint: string): string {
  if (b.action === 'blocked-escape') return `[forgen] 거부: ${b.abs} 는 --out 의 실경로 밖이다 (.. 또는 심링크). 쓰지 않는다.`;
  if (b.action === 'blocked-foreign') return `[forgen] 거부: ${b.abs} 는 forgen way 가 만든 파일이 아니다(파일 앞부분에 표식 줄이 없다). --force 로도 덮어쓰지 않는다.${hint}`;
  return `[forgen] 거부: ${b.abs} 가 이미 있고 내용이 다르다. 덮어쓰려면 --force (기존 파일은 백업된다).`;
}

/** 대상별 전역(사용자 수준) 위치. 1차 문서 기준(ADR-020). `--out` 은 그 위치의 루트다. */
const GLOBAL_HINT: Record<string, string> = {
  'agents-md': '전역(Codex): --out ~/.codex → ~/.codex/AGENTS.md ($CODEX_HOME). 같은 위치에 AGENTS.override.md 가 있으면 그것만 읽힌다. 프로젝트: --out <프로젝트 루트>',
  'claude-rules': '전역(Claude Code): --out ~ → ~/.claude/rules/forgen-way.md. forgen 렌더(v1-rules.md)와 같은 룰이 두 번 들어갈 수 있다',
  skill: '전역(Claude Code): --out ~ → ~/.claude/skills/<name>/SKILL.md. 프로젝트: --out <프로젝트 루트>',
  gemini: '전역(Gemini CLI): --out ~/.gemini → ~/.gemini/GEMINI.md. 프로젝트: --out <프로젝트 루트>',
  cursor: '전역 파일 없음: Cursor 의 User Rules 는 Customize → Rules 화면에 붙여넣는다. 프로젝트: --out <프로젝트 루트> (.cursor/rules)',
};

const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const scope = (i: WayItem) => (i.projects.length ? i.projects.join(',') : '전역');

function summary(way: Way, all: boolean): string {
  const rules = way.items.filter((i) => i.kind === 'rule' && i.status === 'active');
  const said = rules.filter((i) => i.provenance.kind === 'you-said');
  const mined = rules.filter((i) => i.provenance.kind === 'mined');
  const imported = rules.filter((i) => i.provenance.kind === 'imported');
  const sols = way.items.filter((i) => i.kind === 'solution');
  const habits = way.items.filter((i) => i.kind === 'habit');
  const cap = all ? Infinity : 4;
  const out: string[] = [];
  const mark = (i: WayItem) => (i.enforceable ? '강제' : '자문');

  const quoted = said.filter((i) => i.provenance.kind === 'you-said' && i.provenance.quote).length;
  out.push(`내가 말한 규칙 ${said.length}  (발화 원문 있음 ${quoted}, 날짜만 ${said.length - quoted})`);
  const byScope = new Map<string, WayItem[]>();
  for (const i of said) byScope.set(scope(i), [...(byScope.get(scope(i)) ?? []), i]);
  for (const [sc, list] of [...byScope].sort((a, b) => (a[0] === '전역' ? -1 : b[0] === '전역' ? 1 : a[0].localeCompare(b[0])))) {
    out.push(`  [${sc}] ${list.length}`);
    list.slice(0, cap).forEach((i) => out.push(`    ${i.strength.padEnd(7)} ${mark(i)}  ${clip(i.statement, 74)}`));
    if (list.length > cap) out.push(`    … 외 ${list.length - cap}개 (--all)`);
  }
  out.push('', `추론된 규칙 ${mined.length}  (행동에서 채굴. 내가 한 말이 아님)`);
  mined.slice(0, all ? Infinity : 3).forEach((i) => out.push(`    ${i.strength.padEnd(7)} ${mark(i)}  [${scope(i)}] ${clip(i.statement, 66)}`));
  if (!all && mined.length > 3) out.push(`    … 외 ${mined.length - 3}개 (--all)`);
  if (imported.length) out.push('', `가져온 규칙 ${imported.length}  (호스트 메모리 등)`);

  out.push('', `검증된 솔루션 ${way.stats.solutions_verified}  (미검증 ${way.stats.solutions_unverified}는 내보내지 않음)`);
  if (all) sols.forEach((i) => out.push(`    ${clip(i.id.replace('solution:', ''), 70)}`));
  out.push(`습관 ${habits.length}  (기본 내보내기에서 제외, --habits 로 포함)`);
  if (all) habits.forEach((i) => out.push(`    ${clip(i.statement, 74)}`));

  const suspects = projectSpecificSuspects(way.items.filter((i) => i.kind === 'rule' && i.status === 'active'));
  if (suspects.length) {
    out.push('', `프로젝트 전용일 수 있는 전역 룰 ${suspects.length}개 (프로젝트 미지정 산출물에 섞인다). forgen rule classify-projects --project <키> --keywords a,b`);
    if (all) suspects.forEach((x) => out.push(`    ${x.id.slice(0, 8)} ${x.why}`));
  }
  const habitConflicts = habits.filter((h) => h.conflicts_with);
  if (habitConflicts.length) out.push(`활성 룰과 상반되는 습관 ${habitConflicts.length}개 (내보내기에서 제외)`);
  out.push('', `강제 중 ${way.stats.rules_enforceable} / 자문 ${way.stats.rules_active - way.stats.rules_enforceable}  (강제 = 위반 시 실제로 막는 룰. 다른 모델 산출물에서는 모두 자문)`);

  const rep = loadRenderReport();
  if (!rep) out.push('렌더: 기록 없음');
  else {
    const strong = rep.omitted.filter((o) => o.strength === 'strong' || o.strength === 'hard').length;
    out.push(`렌더 누락: ${rep.omitted.length}개 (strong 이상 ${strong}) / 포함 ${rep.included.length}  [${rep.at.slice(0, 16).replace('T', ' ')}]`);
    if (all) rep.omitted.forEach((o) => out.push(`    ${o.strength.padEnd(7)} ${clip(o.policy, 70)}`));
  }
  return out.join('\n');
}

function cmdExport(args: string[]): number {
  const target = flag(args, '--target') as CompileTarget | undefined;
  if (!target || !COMPILE_TARGETS.includes(target)) {
    console.error(`[forgen] --target 이 필요하다: ${COMPILE_TARGETS.join(' | ')}`);
    return 1;
  }
  const budgetRaw = flag(args, '--budget');
  const budget = budgetRaw === undefined ? undefined : Number(budgetRaw);
  if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) { console.error('[forgen] --budget 은 양의 정수'); return 1; }
  const only = flags(args, '--item');
  const way = buildWay();
  const res = compile(way, target, { project: flag(args, '--project')?.toLowerCase(), budget, habits: args.includes('--habits'), only: only.length ? only : undefined });
  const out = flag(args, '--out');
  const report: string[] = [];
  const byReason = new Map<string, number>();
  for (const o of res.omitted) byReason.set(o.reason, (byReason.get(o.reason) ?? 0) + 1);
  const wayOf = (id: string) => way.items.find((i) => i.id === id);
  report.push(`[forgen] ${target}: 파일 ${res.files.length}개, 빠진 항목 ${res.omitted.length}개${byReason.size ? ` (${[...byReason].map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}, 자문 전환 ${res.degraded.length}개`);
  for (const o of res.omitted.filter((x) => x.reason === 'budget')) report.push(`  예산으로 뺌: ${clip(wayOf(o.id)?.statement ?? o.id, 70)}`);
  for (const d of res.degraded.slice(0, 5)) report.push(`  ${clip(wayOf(d.id)?.statement ?? d.id, 50)} → ${d.reason}`);
  if (res.degraded.length > 5) report.push(`  … 외 ${res.degraded.length - 5}개`);
  for (const w of res.warnings) report.push(`  경고: ${w}`);
  if (GLOBAL_HINT[target]) report.push(`  위치: ${GLOBAL_HINT[target]}`);
  if (!res.files.length) { console.error(`${report.join('\n')}\n[forgen] 내보낼 항목이 없다.`); return 1; }

  if (!out) {
    for (const f of res.files) console.log(`===== ${f.path} =====\n${f.content}`);
    console.error(`${report.join('\n')}\n[forgen] 미리보기. 파일로 쓰려면 --out <dir>`);
    return 0;
  }
  const outDir = path.resolve(out);
  const { plan, written } = writeFiles(res.files, outDir, args.includes('--force'));
  for (const p of plan) console.log(`  ${p.action.padEnd(15)} ${path.join(outDir, p.path)}`);
  console.log(report.join('\n'));
  const blocked = plan.filter((p) => p.action.startsWith('blocked'));
  if (blocked.length) {
    for (const b of blocked) console.error(blockedMessage(b, ' 다른 --out 을 쓰거나 파일을 옮겨라.'));
    console.error('[forgen] 아무 파일도 쓰지 않았다.');
    return 1;
  }
  for (const p of plan.filter((x) => x.backup)) console.log(`  백업 ${p.backup}`);
  console.log(`[forgen] ${written}개 작성 (${outDir})`);
  return 0;
}

function cmdImport(args: string[]): number {
  const file = args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
  if (!file) { console.error('[forgen] 사용법: forgen way import <file.json> [--apply] [--allow-enforced-edit]'); return 1; }
  let text: string;
  try { text = fs.readFileSync(file, 'utf-8'); } catch (e) { console.error(`[forgen] 파일을 읽을 수 없다: ${(e as Error).message}`); return 1; }
  const parsed = parseWayJson(text);
  if (!parsed.ok) { console.error(`[forgen] 스키마 오류 ${parsed.errors.length}건:\n${parsed.errors.map((e) => `  - ${e}`).join('\n')}`); return 1; }
  const plan = planImport(parsed.items, loadAllRules(), { allowEnforcedEdit: args.includes('--allow-enforced-edit') });
  for (const c of plan.changes) console.log(`  ${c.field.padEnd(9)} ${c.id.slice(0, 8)}  ${c.from !== undefined ? `${clip(c.from, 50)} → ` : ''}${clip(c.to, 60)}`);
  for (const ig of plan.ignored) console.log(`  무시      ${ig.id.slice(0, 8)}  ${ig.reason}`);
  for (const w of plan.warnings) console.log(`  경고      ${w}`);
  for (const e of plan.errors) console.error(`  오류      ${e}`);
  console.log(`[forgen] 변경 ${plan.changes.length}건, 무시 ${plan.ignored.length}건, 오류 ${plan.errors.length}건`);
  if (plan.errors.length) { console.error('[forgen] 오류가 있어 적용하지 않는다.'); return 1; }
  if (!args.includes('--apply')) { console.log('[forgen] 미리보기. 적용하려면 --apply'); return 0; }
  const snap = createSnapshot('pre-way-import');
  console.log(`[forgen] 적용 전 스냅샷 ${snap} (복원: forgen rule restore ${snap} --yes)`);
  const r = applyImport(parsed.items, plan);
  console.log(`[forgen] 적용 ${r.applied}건${r.created.length ? ` (새 룰 ${r.created.length})` : ''}. 렌더는 다음 세션 시작 때 반영된다.`);
  return 0;
}

const shown = (c: { statement: string; excluded?: { reason: string } }) => (c.excluded?.reason === 'secret' ? '(비밀로 보여 내용 숨김)' : clip(c.statement, 50));

function cmdCollect(args: string[]): number {
  const rules = loadAllRules();
  const { candidates, scanned } = readMemoryCandidates(flag(args, '--dir'), rules);
  const override = flag(args, '--project')?.toLowerCase();
  const fresh = candidates.filter((c) => !c.excluded);
  const excluded = candidates.filter((c) => c.excluded);
  if (args.includes('--json')) {
    const items = fresh.map((c) => candidateToItem(c, override));
    for (const c of excluded) console.error(`제외 [${c.excluded?.reason}] ${shown(c)} (${c.source})`);
    console.log(JSON.stringify({ schema: 'forgen-way/1', generator: 'forgen-way', generated_at: new Date().toISOString(), items }, null, 2));
    return 0;
  }
  const byReason = new Map<string, number>();
  for (const c of excluded) byReason.set(c.excluded?.reason ?? '', (byReason.get(c.excluded?.reason ?? '') ?? 0) + 1);
  console.log(`메모리 파일 ${scanned.length}개 → 후보 ${candidates.length}개 (새 ${fresh.length}, 제외 ${excluded.length}${byReason.size ? `: ${[...byReason].map(([k, v]) => `${k} ${v}`).join(', ')}` : ''})`);
  for (const c of fresh) {
    const proj = override ?? c.project;
    console.log(`  + [${proj ?? '전역(확인 필요)'}] ${clip(c.statement, 70)}\n      근거: ${c.source}${override ? '' : `  (${c.projectGuess})`}`);
  }
  for (const c of excluded) console.log(`  - ${c.excluded?.reason.padEnd(18)} ${shown(c)}  ${c.excluded?.detail}`);
  if (!args.includes('--apply')) {
    console.log('[forgen] 미리보기. 고치려면 `forgen way collect-memory --json > f.json` 로 내보내 projects·strength 를 고치고 `forgen way import f.json --apply`. 한 프로젝트 전용이면 --project <key>. 그대로 적용하려면 --apply');
    return 0;
  }
  const items = fresh.map((c) => candidateToItem(c, override));
  if (!items.length) { console.log('[forgen] 추가할 룰이 없다.'); return 0; }
  const snap = createSnapshot('pre-collect-memory');
  console.log(`[forgen] 적용 전 스냅샷 ${snap}`);
  const r = applyImport(items, { changes: items.map((i) => ({ id: i.id, field: 'new' as const, to: i.statement })), ignored: [], errors: [], warnings: [], newRules: items });
  console.log(`[forgen] 룰 ${r.created.length}개 추가 (source: imported, 근거: 프로젝트/파일명). 고치려면 forgen way export --target json`);
  return 0;
}

function cmdDraft(args: string[]): number {
  const kind = args[0] as DraftKind | undefined;
  if (kind !== 'skill' && kind !== 'workflow') { console.error('[forgen] 사용법: forgen way draft <skill|workflow> "<주제>" [--project k] [--out dir] [--no-llm]'); return 1; }
  const topic = readTopic(args.slice(1));
  if (!topic) { console.error('[forgen] 주제가 필요하다: forgen way draft skill "격리 검증"'); return 1; }
  const project = flag(args, '--project')?.toLowerCase();
  const { sources, excludedPrivate } = gatherSources(topic, { project });
  const by = (k: string) => sources.filter((s) => s.kind === k).length;
  console.error(`[forgen] 근거 ${sources.length}개 (룰 ${by('rule')}, 솔루션 ${by('solution')}, 교정 원문 ${by('correction')})${excludedPrivate ? `, private 제외 ${excludedPrivate}` : ''}. 전송 전 비밀 마스킹·<private> 제거.`);
  if (sources.length === 0) { console.error('[forgen] 주제와 관련된 룰·솔루션·교정을 찾지 못했다. 초안을 쓰지 않는다(호출·파일 없음). 주제어를 바꾸거나 --project 를 확인하라.'); return flag(args, '--out') ? 1 : 0; }
  const outcome = writeDraft(kind, topic, sources, { noLlm: args.includes('--no-llm') });
  if (outcome.mode === 'deterministic') console.error(`[forgen] 초안을 쓰지 못했다 (${outcome.reason}). 관련 항목 묶음을 대신 출력한다.`);
  else console.error(`[forgen] Haiku 초안 (${((outcome.ms ?? 0) / 1000).toFixed(1)}s)`);
  const files = draftFiles(kind, topic, outcome, sources, excludedPrivate);
  const out = flag(args, '--out');
  if (!out) {
    console.log(files[0].content);
    console.log(`\n---- 근거 항목 ----\n${sources.map((s) => `${s.id}`).join('\n') || '(없음)'}`);
    console.error('[forgen] 미리보기. 파일로 쓰려면 --out <dir> (근거는 옆 파일)');
    return 0;
  }
  const outDir = path.resolve(out);
  const { plan, written } = writeFiles(files, outDir, args.includes('--force'));
  for (const p of plan) console.log(`  ${p.action.padEnd(15)} ${path.join(outDir, p.path)}`);
  const blocked = plan.filter((p) => p.action.startsWith('blocked'));
  if (blocked.length) {
    for (const b of blocked) console.error(blockedMessage(b, ''));
    console.error('[forgen] 아무 파일도 쓰지 않았다.');
    return 1;
  }
  for (const p of plan.filter((x) => x.backup)) console.log(`  백업 ${p.backup}`);
  console.log(`[forgen] ${written}개 작성 (${outDir})`);
  return 0;
}

export async function handleWay(args: string[]): Promise<void> {
  const sub = args[0];
  let code = 0;
  if (sub === 'export') code = cmdExport(args.slice(1));
  else if (sub === 'import') code = cmdImport(args.slice(1));
  else if (sub === 'collect-memory') code = cmdCollect(args.slice(1));
  else if (sub === 'draft') code = cmdDraft(args.slice(1));
  else if (!sub || sub.startsWith('--')) {
    const way = buildWay();
    if (args.includes('--json')) console.log(JSON.stringify({ ...way, render: loadRenderReport() }, null, 2));
    else console.log(`${summary(way, args.includes('--all'))}\n`);
  } else {
    console.error(`[forgen] 알 수 없는 way 하위 명령: ${sub}\n  forgen way [--all|--json] | export | import | collect-memory | draft`);
    code = 1;
  }
  if (code) process.exitCode = code;
}
