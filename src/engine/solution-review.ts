/**
 * 솔루션 검토·출처 정리 (0.8.0 K2·K3).
 *
 *   forgen compound review                     재관측된(서로 다른 세션 2곳 이상) 후보 — 승인하면 verified
 *   forgen compound review --approve <name...> 승인(묶음 가능)
 *   forgen compound relabel [--apply|--undo]   자동 추출인데 manual 로 표시된 솔루션의 출처 바로잡기(미리보기 기본)
 *
 * 오너 결정(2026-11-25): 검증 승격은 항상 오너 승인. 재관측은 승인 목록에 올리는 조건일 뿐 검증이 아니다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ME_SOLUTIONS, STATE_DIR } from '../core/paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import { parseSolutionV3 } from './solution-format.js';
import type { SolutionFrontmatter } from './solution-format.js';
import { mutateSolutionFile } from './solution-writer.js';
import { verifySolution } from './compound-lifecycle.js';

export const REVIEW_MIN_SESSIONS = 2;
/** 러너가 Context 끝에 남기는 출처 표식(auto-compound-runner solutionContext). */
const RUNNER_MARK = /출처: .+ 세션 [0-9a-f]{8} \(\d{4}-\d{2}-\d{2}\), auto-compound/;

interface Item { name: string; file: string; fm: SolutionFrontmatter; context: string }

function readAll(dir = ME_SOLUTIONS): Item[] {
  if (!fs.existsSync(dir)) return [];
  const out: Item[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const file = path.join(dir, f);
    try {
      if (fs.lstatSync(file).isSymbolicLink()) continue;
      const s = parseSolutionV3(fs.readFileSync(file, 'utf-8'));
      if (s) out.push({ name: s.frontmatter.name, file, fm: s.frontmatter, context: s.context });
    } catch { /* 깨진 파일은 건너뜀 */ }
  }
  return out;
}

/** 승인 대기: 후보(또는 실험)이면서 서로 다른 근거 세션이 2곳 이상, 부정 근거 0. */
export function pendingReview(dir = ME_SOLUTIONS): Item[] {
  return readAll(dir)
    .filter((i) => (i.fm.status === 'candidate' || i.fm.status === 'experiment')
      && new Set(i.fm.evidenceSessions ?? []).size >= REVIEW_MIN_SESSIONS && (i.fm.evidence?.negative ?? 0) === 0)
    .sort((a, b) => (b.fm.evidenceSessions?.length ?? 0) - (a.fm.evidenceSessions?.length ?? 0) || a.name.localeCompare(b.name));
}

/** 서로 다른 근거 세션이 2곳 이상인 솔루션 수(상태 무관, 은퇴 제외). */
export function reobservedCount(dir = ME_SOLUTIONS): number {
  return readAll(dir).filter((i) => i.fm.status !== 'retired' && new Set(i.fm.evidenceSessions ?? []).size >= REVIEW_MIN_SESSIONS).length;
}

export function relabelPlan(dir = ME_SOLUTIONS): Item[] {
  return readAll(dir).filter((i) => i.fm.extractedBy === 'manual' && RUNNER_MARK.test(i.context));
}

export function handleReview(args: string[]): void {
  const ai = args.indexOf('--approve');
  if (ai >= 0) {
    const names = args.slice(ai + 1).filter((a) => !a.startsWith('--'));
    if (!names.length) { console.log('  Usage: forgen compound review --approve <name...>'); process.exitCode = 1; return; }
    const pending = new Set(pendingReview().map((i) => i.name));
    for (const n of names) {
      if (!pending.has(n)) console.log(`  ─ ${n}: 승인 대기 목록에 없음(재관측 2세션 미만이거나 이미 검증됨). 그래도 올리려면 forgen compound --verify ${n}`);
      else console.log(verifySolution(n) ? `  ✓ ${n} → verified` : `  ✗ ${n}: 승인 실패`);
    }
    return;
  }
  const list = pendingReview();
  if (!list.length) { console.log('\n  승인 대기 솔루션 없음 (서로 다른 세션 2곳 이상에서 다시 나온 후보만 오릅니다).\n'); return; }
  console.log(`\n  승인 대기 ${list.length}개 — 서로 다른 세션에서 다시 나온 교훈. 자주 나왔다는 뜻이지 맞다는 뜻은 아닙니다.\n`);
  for (const i of list.slice(0, 20)) {
    console.log(`  ${i.name}  [${i.fm.status}, 세션 ${new Set(i.fm.evidenceSessions).size}곳]`);
    for (const g of (i.fm.grounding ?? []).slice(-2)) console.log(`      근거(${g.kind === 'user' ? '사용자' : '어시스턴트'}): "${g.quote.slice(0, 120)}"`);
  }
  console.log(`\n  승인: forgen compound review --approve <name...>   (승인한 것만 verified 가 됩니다)\n`);
}

const RELABEL_LOG = path.join(STATE_DIR, 'solution-relabel-last.json');

export function handleRelabel(args: string[]): void {
  if (args.includes('--undo')) {
    const last = safeReadJSON<{ names?: string[] } | null>(RELABEL_LOG, null);
    const names = new Set(last?.names ?? []);
    let n = 0;
    for (const i of readAll()) {
      if (!names.has(i.name)) continue;
      if (mutateSolutionFile(i.file, (s) => { if (s.frontmatter.extractedBy !== 'auto') return false; s.frontmatter.extractedBy = 'manual'; return true; }, { touchUpdated: false })) n++;
    }
    console.log(`\n  ✓ 마지막 relabel 되돌림: ${n}개를 manual 로.\n`);
    return;
  }
  const plan = relabelPlan();
  if (!args.includes('--apply')) {
    console.log(`\n  자동 추출인데 사람이 쓴 것(manual)으로 표시된 솔루션: ${plan.length}개 (Context 의 auto-compound 출처 표식으로 판정)`);
    console.log('  바꾸면 자동 추출 전용 정리 규칙(습관 로그 판정, rollback)의 대상이 됩니다.');
    for (const i of plan.slice(0, 15)) console.log(`    ${i.name}`);
    if (plan.length) console.log(`\n  적용: forgen compound relabel --apply\n`);
    return;
  }
  const changed: string[] = [];
  for (const i of plan) {
    if (mutateSolutionFile(i.file, (s) => { if (s.frontmatter.extractedBy !== 'manual') return false; s.frontmatter.extractedBy = 'auto'; return true; }, { touchUpdated: false })) changed.push(i.name);
  }
  atomicWriteJSON(RELABEL_LOG, { at: new Date().toISOString(), names: changed }, { pretty: true });
  console.log(`\n  ✓ ${changed.length}개 솔루션의 출처를 auto 로 바로잡았습니다. 되돌리기: forgen compound relabel --undo\n`);
}
