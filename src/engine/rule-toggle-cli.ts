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

  saveRule({ ...rule, status: 'suppressed' });
  console.log(`✓ Suppressed rule ${rule.rule_id}`);
  console.log(`  Policy: ${rule.policy.slice(0, 80)}`);
  console.log(`  Re-activate with: forgen activate-rule ${rule.rule_id}`);
}

/**
 * ADR-017 D1: enforce_mode 전환. `advise` = 차단 대신 기록만(precision 자동 강등과 같은 상태),
 * `enforce` = 차단 복귀(자동 강등 해제 — 사용자 명시). 하드 룰은 advise 로 내릴 수 없다.
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
  const prev = rule.enforce_mode ?? 'block';
  rule.enforce_mode = mode;
  saveRule(rule);
  console.log(`✓ [forgen] ${rule.rule_id.slice(0, 8)} enforce_mode: ${prev} → ${mode}${mode === 'block' ? ' (차단 복귀 — 자동 강등 해제)' : ' (기록만, 차단 안 함)'}`);
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

  saveRule({ ...rule, status: 'active' });
  console.log(`✓ Activated rule ${rule.rule_id}`);
  console.log(`  Policy: ${rule.policy.slice(0, 80)}`);
}
