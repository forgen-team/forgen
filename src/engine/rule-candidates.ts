/**
 * 채굴(추론) 룰 후보 (2026-11 재설계 D5, 0.7.0).
 *
 *   forgen rule candidates              후보 목록(근거 세션 수·마지막 근거·범위)
 *   forgen activate-rule <id>           후보를 직접 켜기(기존 명령)
 *
 * demoteWeakMinedRules: 0.7.0 업그레이드 1회 마이그레이션(오너 결정 2026-11-17). 활성 채굴 룰 중 근거 세션이
 * 2곳 미만인 룰을 후보로 돌린다. 적용 전 스냅샷 — 되돌리기: forgen rule restore <스냅샷> --yes
 */
import { loadAllRules, loadRule, rulePath, saveRule } from '../store/rule-store.js';
import { withStatusChange } from '../store/rule-lifecycle.js';
import { withFileLockSync } from '../hooks/shared/file-lock.js';
import { evidenceSessions, isMinedRule, lastEvidenceAt, MIN_CANDIDATE_SESSIONS } from '../store/mined-candidates.js';
import { createSnapshot } from './rule-recovery-cli.js';
import type { Rule } from '../store/types.js';

export function planMinedDemotion(rules: Rule[] = loadAllRules()): Rule[] {
  return rules.filter((r) => r.scope === 'me' && r.status === 'active' && isMinedRule(r) && r.strength !== 'hard'
    && evidenceSessions(r.evidence_refs ?? []).size < MIN_CANDIDATE_SESSIONS);
}

export function demoteWeakMinedRules(): { count: number; snapshot: string | null } {
  const plan = planMinedDemotion();
  if (plan.length === 0) return { count: 0, snapshot: null };
  const snapshot = createSnapshot('pre-candidate');
  let count = 0;
  for (const r of plan) {
    try {
      withFileLockSync(rulePath(r.rule_id), () => {
        const fresh = loadRule(r.rule_id);
        if (!fresh || fresh.status !== 'active' || !isMinedRule(fresh)) return;
        if (evidenceSessions(fresh.evidence_refs ?? []).size >= MIN_CANDIDATE_SESSIONS) return;
        saveRule(withStatusChange(fresh, 'candidate', 'migrate-0.7.0-candidate', 'migration'));
        count++;
      });
    } catch { /* 잠금 실패 — 이 룰은 활성으로 남는다 */ }
  }
  return { count, snapshot };
}

export function handleRuleCandidates(_args: string[]): void {
  const list = loadAllRules()
    .filter((r) => r.status === 'candidate')
    .map((r) => ({ r, sessions: evidenceSessions(r.evidence_refs ?? []).size, last: lastEvidenceAt(r) }))
    .sort((a, b) => b.last - a.last);
  if (list.length === 0) { console.log('추론 룰 후보가 없습니다.'); return; }
  console.log(`\n  추론 룰 후보 ${list.length}개 — 다른 세션에서 같은 교정이 한 번 더 잡히면 주입됩니다(근거 세션 ${MIN_CANDIDATE_SESSIONS}곳).\n`);
  for (const { r, sessions, last } of list.slice(0, 50)) {
    const scope = r.projects?.length ? r.projects.join(',') : '전역';
    console.log(`    ${r.rule_id.slice(0, 8)}  세션 ${sessions} · 마지막 ${new Date(last).toISOString().slice(0, 10)} · ${scope}  ${r.policy.replace(/\s+/g, ' ').slice(0, 70)}`);
  }
  if (list.length > 50) console.log(`    … 외 ${list.length - 50}개`);
  console.log('\n  바로 켜기: forgen activate-rule <id>    마지막 근거 21일이 지나면 자동으로 정리됩니다.\n');
}
