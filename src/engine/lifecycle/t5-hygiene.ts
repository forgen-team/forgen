/**
 * T5 충돌 감지 정리 (docs/plans/2026-11-17-rule-quality-redesign.md D1).
 *
 * v0.6.9 에서 한글 부정어 정규식을 고친 뒤 T5 가 처음 동작하면서, 무관한 룰 쌍까지 충돌로 판정하고
 * 같은 쌍을 스캔마다 다시 기록했다(실측: 하루 97쌍 × 약 29회). 그 결과 활성 룰 다수가 flagged 가 됐다.
 * 재설계 전까지 T5 는 기록만 한다(suggested_action 'observe') — 여기서는
 *   1) 최근 기록된 쌍의 재기록을 막고,
 *   2) T5 때문에만 flagged 가 된 룰을 찾아 되돌린다(스냅샷 → 적용, `forgen rule restore` 로 되돌림).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ME_BEHAVIOR, STATE_DIR } from '../../core/paths.js';
import { createSnapshot } from '../rule-recovery-cli.js';
import { loadAllRules, loadRule, rulePath, saveRule } from '../../store/rule-store.js';
import { withFileLockSync } from '../../hooks/shared/file-lock.js';
import type { Rule } from '../../store/types.js';
import type { LifecycleEvent } from './types.js';

export const T5_DEDUPE_DAYS = 7;
/** flagged 를 만들 수 있는 T5 외 이벤트. 하나라도 있으면 그 룰의 flag 는 T5 탓만이 아니다. */
const NON_T5_FLAG_KINDS = new Set(['t1_explicit_correction', 't2_repeated_violation', 't3_user_bypass']);

export function lifecycleDir(): string {
  return path.join(STATE_DIR, 'lifecycle');
}

function pairKey(refs: string[] | undefined): string | null {
  if (!refs || refs.length < 2) return null;
  return [...new Set(refs)].sort().join('|');
}

/** lifecycle 로그 파일 목록(회전본 포함). 디렉터리를 못 읽으면 null. */
function logFiles(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl(\.\d+)?$/.test(f)).map((f) => path.join(dir, f));
  } catch {
    return null;
  }
}

function* readEvents(file: string): Generator<{ kind?: string; rule_id?: string; evidence?: { refs?: string[] } }> {
  let text: string;
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* 깨진 줄은 건너뜀 */ }
  }
}

/** 최근 days 일 동안 기록된 T5 쌍 키. */
export function recentT5PairKeys(now: number = Date.now(), days: number = T5_DEDUPE_DAYS, dir: string = lifecycleDir()): Set<string> {
  const keys = new Set<string>();
  const files = logFiles(dir) ?? [];
  const cutoff = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  for (const f of files) {
    if (path.basename(f).slice(0, 10) < cutoff) continue;
    for (const e of readEvents(f)) {
      if (e.kind !== 't5_conflict_detected') continue;
      const k = pairKey(e.evidence?.refs);
      if (k) keys.add(k);
    }
  }
  return keys;
}

/** 이미 최근에 기록된 쌍(과 같은 호출 안의 중복)을 빼고 T5 이벤트를 돌려준다. T5 외 이벤트는 그대로. */
export function filterNewT5Events(events: LifecycleEvent[], recent: Set<string>): LifecycleEvent[] {
  const seenPairRule = new Set<string>();
  return events.filter((e) => {
    if (e.kind !== 't5_conflict_detected') return true;
    const k = pairKey(e.evidence?.refs);
    if (!k) return true;
    if (recent.has(k)) return false;
    const pr = `${k}#${e.rule_id}`;
    if (seenPairRule.has(pr)) return false;
    seenPairRule.add(pr);
    return true;
  });
}

/**
 * T5 때문에만 flagged 가 된 활성 룰: phase=flagged, conflict_refs 있음, lifecycle 로그 전체에 그 룰의
 * T1·T2·T3 이벤트가 없음. 로그 디렉터리를 읽을 수 없으면 판정할 수 없으므로 빈 목록(보수적으로 유지).
 */
/**
 * T1 기록이 실제로 이 룰을 지목했는가 — 교정 증거의 candidate_rule_refs 또는 raw_payload.target_rule_id.
 * 0.6.9(2026-11-05) 이전의 T1 은 축·단어 겹침으로 추측 매칭했고(실측 9건 중 8건 오탐), 그때 걸린 flag 가 남아 있다.
 * 증거 파일을 못 읽으면 지목한 것으로 본다(보수적 — 정리하지 않음).
 */
export function t1Targets(ruleId: string, evidenceRef: string | undefined): boolean {
  if (!evidenceRef || evidenceRef !== path.basename(evidenceRef)) return true;
  try {
    const e = JSON.parse(fs.readFileSync(path.join(ME_BEHAVIOR, `${evidenceRef}.json`), 'utf-8')) as { candidate_rule_refs?: string[]; raw_payload?: { target_rule_id?: string } };
    return (e.candidate_rule_refs ?? []).includes(ruleId) || e.raw_payload?.target_rule_id === ruleId;
  } catch { return true; }
}

/**
 * 오탐 flag 만 남은 활성 룰: phase=flagged 이고, lifecycle 로그의 flag 근거가 T5(충돌 감지) 기록이나
 * 룰을 지목하지 않은 옛 T1 기록뿐인 룰. 지목한 T1·T2·T3 기록이 하나라도 있으면 제외. 근거 기록이 아예 없으면 제외.
 * 로그 디렉터리를 읽을 수 없으면 판정할 수 없으므로 빈 목록(보수적으로 유지).
 */
export function planT5Unflag(rules: Rule[], dir: string = lifecycleDir()): Rule[] {
  const files = logFiles(dir);
  if (files === null) return [];
  const flagged = new Set(rules.filter((r) => r.status === 'active' && r.lifecycle?.phase === 'flagged').map((r) => r.rule_id));
  const real = new Set<string>();
  const falseOnly = new Set<string>();
  for (const f of files) {
    for (const e of readEvents(f)) {
      if (!e.rule_id || !flagged.has(e.rule_id)) continue;
      if (e.kind === 't5_conflict_detected') { falseOnly.add(e.rule_id); continue; }
      if (e.kind === 't1_explicit_correction') {
        if (t1Targets(e.rule_id, e.evidence?.refs?.[0])) real.add(e.rule_id); else falseOnly.add(e.rule_id);
        continue;
      }
      if (e.kind && NON_T5_FLAG_KINDS.has(e.kind)) real.add(e.rule_id);
    }
  }
  return rules.filter((r) => flagged.has(r.rule_id) && falseOnly.has(r.rule_id) && !real.has(r.rule_id));
}

export interface T5UnflagResult { count: number; snapshot: string | null; ruleIds: string[] }

/** 판정된 룰의 phase 를 active 로 되돌린다. 적용 전에 스냅샷을 만든다. conflict_refs 는 기록으로 남긴다. */
export function applyT5Unflag(opts: { dir?: string; rules?: Rule[] } = {}): T5UnflagResult {
  const targets = planT5Unflag(opts.rules ?? loadAllRules(), opts.dir);
  if (targets.length === 0) return { count: 0, snapshot: null, ruleIds: [] };
  const snapshot = createSnapshot('pre-t5-unflag');
  for (const r of targets) {
    try {
      // 파일 잠금 + 잠금 안에서 다시 읽기 — 라이브 세션(markRulesInjected 등)과 동시에 돌 수 있다.
      withFileLockSync(rulePath(r.rule_id), () => {
        const fresh = loadRule(r.rule_id);
        if (fresh?.lifecycle?.phase !== 'flagged') return;
        saveRule({ ...fresh, lifecycle: { ...fresh.lifecycle, phase: 'active' } });
      });
    } catch { /* 잠금 실패한 룰은 다음 forgen rule unflag --apply 에서 */ }
  }
  return { count: targets.length, snapshot, ruleIds: targets.map((r) => r.rule_id) };
}

/** `forgen rule unflag [--apply]` — 미리보기가 기본. */
export function handleRuleUnflag(args: string[]): void {
  const rules = loadAllRules();
  const targets = planT5Unflag(rules);
  if (!args.includes('--apply')) {
    console.log(`오탐 판정(충돌 감지 T5 / 룰을 지목하지 않은 옛 교정 매칭) 때문에만 검토 대기가 된 활성 룰: ${targets.length}개`);
    for (const r of targets.slice(0, 30)) console.log(`  ${r.rule_id.slice(0, 8)}  ${r.policy.replace(/\s+/g, ' ').slice(0, 80)}`);
    if (targets.length > 30) console.log(`  … 외 ${targets.length - 30}개`);
    if (targets.length > 0) console.log('적용: forgen rule unflag --apply  (적용 전 스냅샷, 되돌리기: forgen rule restore <이름> --yes)');
    return;
  }
  const r = applyT5Unflag({ rules });
  console.log(r.count === 0 ? '되돌릴 룰이 없습니다.' : `✓ [forgen] ${r.count}개 룰을 검토 대기에서 정상으로 되돌렸습니다. 되돌리기: forgen rule restore ${r.snapshot} --yes`);
}
