/**
 * CLI handler for `forgen suppress-rule <id>` / `forgen activate-rule <id>`.
 *
 * R7-U2: Day-1 탈출구 — 사용자가 차단 메시지를 보고 JSON 을 손으로 편집하지 않아도
 * 한 명령으로 규칙을 끄거나 되살릴 수 있도록.
 *
 * 구현:
 *   - prefix-match 지원 (첫 8자만 쳐도 OK).
 *   - multiple match 이면 목록 출력하고 중단.
 *   - hard strength rule 은 cli 로도 suppress 불가 (ADR-002 불변 원칙).
 */

import { loadAllRules, saveRule } from '../store/rule-store.js';
import { withStatusChange } from '../store/rule-lifecycle.js';
import type { Rule } from '../store/types.js';

export async function handleSuppressRule(args: string[]): Promise<void> {
  const partial = args[0];
  if (!partial) {
    console.error('Usage: forgen suppress-rule <rule_id | prefix>');
    process.exit(2);
  }

  const all = loadAllRules();
  const matches = all.filter((r) => r.rule_id === partial || r.rule_id.startsWith(partial));
  if (matches.length === 0) {
    console.error(`No rule found matching "${partial}". Try \`forgen inspect rules\`.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Ambiguous prefix "${partial}" — ${matches.length} rules match:`);
    for (const r of matches) {
      console.error(`  ${r.rule_id}  [${r.strength}]  ${r.policy.slice(0, 60)}`);
    }
    console.error('Use a longer prefix or the full rule_id.');
    process.exit(1);
  }

  const rule = matches[0];
  if (rule.strength === 'hard') {
    console.error(`Refusing to suppress hard rule "${rule.rule_id}" (ADR-002 immutability).`);
    console.error('  Hard rules require explicit removal from the rule source file.');
    process.exit(1);
  }

  if (rule.status === 'suppressed') {
    console.log(`Rule ${rule.rule_id} is already suppressed.`);
    return;
  }

  saveRule(withStatusChange(rule, 'suppressed', 'user: suppress-rule', 'cli'));
  console.log(`✓ Suppressed rule ${rule.rule_id}`);
  console.log(`  Policy: ${rule.policy.slice(0, 80)}`);
  console.log(`  Re-activate with: forgen activate-rule ${rule.rule_id}`);
}

/**
 * ADR-017 D1: enforce_mode 전환. `advise` = 차단 대신 기록만, `enforce` = 차단 켬(사용자 명시).
 * 의미 룰(self_check)은 기본이 기록만이라 `enforce` 로 켠 것만 차단한다. 하드 룰은 advise 로 내릴 수 없다.
 */
export async function handleEnforceMode(args: string[], mode: 'block' | 'advise'): Promise<void> {
  const { loadAllRules, saveRule } = await import('../store/rule-store.js');
  const prefix = args[0];
  if (!prefix) { console.log(`usage: forgen rule ${mode === 'advise' ? 'advise' : 'enforce'} <id-or-prefix>`); return; }
  const matches = loadAllRules().filter((r) => r.rule_id.startsWith(prefix) && r.status === 'active');
  if (matches.length === 0) { console.log(`no active rule matching ${prefix}`); return; }
  if (matches.length > 1) { console.log(`ambiguous prefix ${prefix} → ${matches.map((r) => r.rule_id.slice(0, 8)).join(', ')}`); return; }
  const rule = matches[0];
  if (mode === 'advise' && rule.strength === 'hard') { console.log(`✗ [forgen] hard rule ${rule.rule_id.slice(0, 8)} cannot be set to advise`); return; }
  const { ruleEnforced } = await import('./rule-detectability.js');
  if (mode === 'block' && !(rule.enforce_via ?? []).some((s) => !!s.verifier)) {
    console.log(`✗ [forgen] ${rule.rule_id.slice(0, 8)} 에는 판정기가 없어 차단할 수 없습니다. 주입만 됩니다.`);
    process.exitCode = 1;
    return;
  }
  const prev = rule.enforce_mode ?? (ruleEnforced(rule) ? 'block' : 'advise');
  rule.enforce_mode = mode;
  saveRule(rule);
  console.log(`✓ [forgen] ${rule.rule_id.slice(0, 8)} enforce_mode: ${prev} → ${mode}${mode === 'block' ? ' (차단 켬)' : ' (기록만, 차단 안 함)'}`);
}

export async function handleActivateRule(args: string[]): Promise<void> {
  const partial = args[0];
  if (!partial) {
    console.error('Usage: forgen activate-rule <rule_id | prefix>');
    process.exit(2);
  }

  const all = loadAllRules();
  const matches = all.filter((r) => r.rule_id === partial || r.rule_id.startsWith(partial));
  if (matches.length === 0) {
    console.error(`No rule found matching "${partial}".`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`Ambiguous prefix "${partial}" — ${matches.length} rules. Use longer prefix.`);
    process.exit(1);
  }

  const rule = matches[0];
  if (rule.status === 'active') {
    console.log(`Rule ${rule.rule_id} is already active.`);
    return;
  }
  if (rule.status === 'removed' || rule.status === 'superseded') {
    console.error(`Cannot activate rule with status=${rule.status}. Edit the rule file directly.`);
    process.exit(1);
  }

  saveRule(withStatusChange(rule, 'active', 'user: activate-rule', 'cli'));
  console.log(`✓ Activated rule ${rule.rule_id}`);
  console.log(`  Policy: ${rule.policy.slice(0, 80)}`);
}

/**
 * D12-C: precision 판정으로 advise 강등된 룰을 한꺼번에 복구한다.
 * 강등의 근거였던 오탐 판정 중 상당수는 "무관한 룰이 무관한 완료 보고를 막은" 주제 게이트 이전 오탐이었다.
 * 기본은 목록만 보여주고(--apply 로 실행), 실행하면 enforce_mode 를 block 으로 되돌리고
 * 게이트 이전 stop-guard 판정이 정밀도 계산에 다시 쓰이지 않도록 epoch 를 기록한다.
 */
export async function handleRestoreDemoted(args: string[]): Promise<void> {
  const apply = args.includes('--apply');
  const { loadAllRules, saveRule } = await import('../store/rule-store.js');
  const { lastDemotion } = await import('./block-judge.js');
  const { writeRuleEpoch } = await import('./lifecycle/signals.js');
  // precision 자동 강등으로 기록된 룰만(강등 기록 = 이전 모드·사유가 남은 것). 사용자가 직접 advise 로 둔 룰은 건드리지 않는다.
  const { stopBlocks } = await import('./rule-detectability.js');
  // 의미 룰은 지금 정책의 기본이 기록만이다. 일괄 복구로 차단을 켜지 않는다(켜려면 forgen rule enforce).
  const semantic = (r: Rule) => (r.enforce_via ?? []).some((s) => s.hook === 'Stop' && !!s.verifier) && !stopBlocks({ ...r, enforce_mode: undefined });
  const demoted = loadAllRules().filter((r) => r.status === 'active' && r.enforce_mode === 'advise' && lastDemotion(r.rule_id) && !semantic(r));
  if (demoted.length === 0) { console.log('복구할 자동 강등 룰이 없습니다.'); return; }
  console.log(`자동 강등(advise) 룰 ${demoted.length}개${apply ? ' — 복구합니다' : ' (미리보기. --apply 로 복구)'}`);
  for (const r of demoted) {
    const d = lastDemotion(r.rule_id);
    console.log(`  ${r.rule_id.slice(0, 8)}  [${r.strength}]  ${d ? `${d.at.slice(0, 10)} 정밀도 ${Math.round(d.precision * 100)}% (판정 ${d.judged}건, 이전 모드 ${d?.prev_mode ?? 'block'}${d?.reason ? `, 사유 ${d.reason}` : ''})` : ''}  ${r.policy.slice(0, 60)}`);
    if (apply) {
      r.enforce_mode = d?.prev_mode ?? 'block';
      saveRule(r);
      writeRuleEpoch(r.rule_id); // 이 룰의 과거 판정만 기준에서 제외 — 다른 룰의 정밀도 기록은 그대로
    }
  }
  if (apply) console.log('✓ 복구 완료 — 복구한 룰의 이전 판정만 정밀도 기준에서 제외됩니다(다른 룰 기록은 유지).');
}

/**
 * R9: explicit 교정 룰 병합은 자동으로 적용하지 않는다 — 제안만 쌓이고, 여기서 목록을 보고 --apply 로 확인한다.
 * (적용 후에도 `forgen rule unmerge <id>` 로 원본 복구 가능.)
 */
export async function handleMergeExplicit(args: string[]): Promise<void> {
  const applyIdx = args.indexOf('--apply');
  const apply = applyIdx >= 0;
  // `--apply <id...>`: 미리보기에 표시된 제안 ID 만 적용한다 (ID 없는 --apply 는 거부 — 처음 보는 제안을 통째로 적용하지 않는다).
  const ids = apply ? args.slice(applyIdx + 1).filter((a) => !a.startsWith('--')) : [];
  const { runCorrectionClustering, MERGE_PROPOSALS_PATH } = await import('./correction-cluster-runner.js');
  const { loadAllRules } = await import('../store/rule-store.js');
  // 최신 제안을 보려면 먼저 제안 모드로 한 번 계산한다(변경 없음).
  await runCorrectionClustering();
  const fs = await import('node:fs');
  let proposals: Array<{ id?: string; members: string[]; representative_policy: string; strength: string }> = [];
  try { proposals = JSON.parse(fs.readFileSync(MERGE_PROPOSALS_PATH, 'utf-8')).proposals ?? []; } catch { /* none */ }
  if (proposals.length === 0) { console.log('병합 제안이 없습니다.'); return; }
  const byId = new Map(loadAllRules().map((r) => [r.rule_id, r]));
  console.log(`explicit 룰 병합 제안 ${proposals.length}건${apply ? '' : ' (미리보기. 적용: forgen rule merge-explicit --apply <제안ID...>)'}`);
  proposals.forEach((p) => {
    console.log(`  [${p.id ?? '?'}] → ${p.strength}: ${p.representative_policy.slice(0, 80)}`);
    for (const id of p.members) console.log(`       - ${id.slice(0, 8)} ${byId.get(id)?.policy.slice(0, 70) ?? ''}`);
  });
  if (!apply) return;
  if (ids.length === 0) { console.log('✗ 적용할 제안 ID 를 지정하세요: forgen rule merge-explicit --apply <제안ID...> (위 목록의 [ ] 안 값)'); process.exitCode = 1; return; }
  // 룰이 바뀌면 ID 가 달라진다 → 미리보기 때와 달라졌으면 하나도 적용하지 않고 중단.
  const fresh = new Set(proposals.map((p) => p.id));
  const stale = ids.filter((id) => !fresh.has(id));
  if (stale.length > 0) { console.log(`✗ 중단: 제안 ${stale.join(', ')} 이(가) 현재 룰 상태와 맞지 않습니다(룰이 바뀌었거나 ID 오타). 미리보기를 다시 확인하세요. 아무것도 적용하지 않았습니다.`); process.exitCode = 1; return; }
  const merges = await runCorrectionClustering({ confirmed: true, only: ids });
  console.log(`✓ ${merges.length}건 병합. 되돌리기: forgen rule unmerge <id>`);
}
