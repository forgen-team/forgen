/**
 * 룰 복구 수단.
 *   forgen rule revive <id|prefix> [--reason "..."]  비활성·보관 룰을 영구 활성 룰로 되살린다
 *   forgen rule snapshot                             룰·교정·솔루션 스냅샷
 *   forgen rule restore <이름> --yes                  스냅샷으로 되돌림(직전 상태를 먼저 스냅샷)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORGEN_HOME, ME_DIR, ME_RULES, ME_RULES_ARCHIVE } from '../core/paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import { withStatusChange } from '../store/rule-lifecycle.js';
import { saveRule } from '../store/rule-store.js';
import type { Rule } from '../store/types.js';

const SNAPSHOT_ROOT = path.join(FORGEN_HOME, 'backups');
const SNAPSHOT_DIRS = ['rules', 'rules-archive', 'behavior', 'solutions'];

function candidates(prefix: string): Array<{ file: string; rule: Rule; archived: boolean }> {
  const out: Array<{ file: string; rule: Rule; archived: boolean }> = [];
  for (const [dir, archived] of [[ME_RULES, false], [ME_RULES_ARCHIVE, true]] as const) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || !name.startsWith(prefix)) continue;
      const file = path.join(dir, name);
      const rule = safeReadJSON<Rule | null>(file, null);
      if (rule) out.push({ file, rule, archived });
    }
  }
  return out;
}

export function reviveRule(prefix: string, reason: string): Rule {
  const found = candidates(prefix);
  if (found.length === 0) throw new Error(`no rule matching "${prefix}" in rules or rules-archive`);
  if (found.length > 1) throw new Error(`ambiguous prefix "${prefix}": ${found.map((f) => f.rule.rule_id).join(', ')}`);
  const { file, rule, archived } = found[0];
  // 오너가 되살린 룰은 오너의 룰이다. 채굴 출처로 두면 TTL 로 다음 sweep 에 다시 은퇴한다.
  const revived: Rule = {
    ...withStatusChange(rule, 'active', reason, 'cli'),
    scope: 'me',
    source: 'explicit_correction',
    clustered_into: undefined,
    lifecycle: rule.lifecycle ? { ...rule.lifecycle, phase: 'active', superseded_by: undefined, merged_into: undefined } : rule.lifecycle,
  };
  delete revived.session_id;
  // 옛 분류기는 본문에 없는 증거 파일(e2e-result.json)을 게이트로 붙였다. 그대로 되살리면 모든 완료 보고가 막힌다.
  const specs = revived.enforce_via?.filter((spec) => {
    if (spec.verifier?.kind !== 'artifact_check') return true;
    const artifact = String(spec.verifier.params?.path ?? '');
    return artifact.length > 0 && revived.policy.includes(path.basename(artifact));
  });
  if (specs) revived.enforce_via = specs;
  saveRule(revived);
  if (archived) fs.rmSync(file, { force: true });
  return revived;
}

export function createSnapshot(label = 'manual', nowIso = new Date().toISOString()): string {
  const name = `rules-${nowIso.replace(/[:.]/g, '-')}-${label}`;
  const target = path.join(SNAPSHOT_ROOT, name);
  fs.mkdirSync(target, { recursive: true });
  for (const d of SNAPSHOT_DIRS) {
    const src = path.join(ME_DIR, d);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(target, d), { recursive: true });
  }
  atomicWriteJSON(path.join(target, 'snapshot.json'), { created_at: nowIso, label, dirs: SNAPSHOT_DIRS });
  return name;
}

export function restoreSnapshot(name: string): { safety: string } {
  if (name !== path.basename(name)) throw new Error('invalid snapshot name');
  const source = path.join(SNAPSHOT_ROOT, name);
  if (!fs.existsSync(path.join(source, 'snapshot.json'))) throw new Error(`snapshot not found: ${name}`);
  const safety = createSnapshot('pre-restore');
  // 전부 복사에 성공한 뒤에 바꾼다. 스냅샷에 없는 폴더는 건드리지 않는다.
  const staged: Array<[string, string]> = [];
  for (const d of SNAPSHOT_DIRS) {
    const src = path.join(source, d);
    if (!fs.existsSync(src)) continue;
    const stage = path.join(ME_DIR, `.restore-${d}`);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.cpSync(src, stage, { recursive: true, filter: (f) => !f.endsWith('.lock') });
    staged.push([stage, path.join(ME_DIR, d)]);
  }
  for (const [stage, dest] of staged) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(stage, dest);
  }
  return { safety };
}

function fail(message: string): never {
  console.error(`✗ [forgen] ${message}`);
  process.exit(1);
}

export function handleRuleRevive(args: string[]): void {
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : undefined;
  const prefix = args.find((a, i) => !a.startsWith('--') && (reasonIdx < 0 || i !== reasonIdx + 1));
  if (!prefix) fail('usage: forgen rule revive <rule_id|prefix> [--reason "..."]');
  try {
    const clusteredInto = candidates(prefix)[0]?.rule.clustered_into;
    const rule = reviveRule(prefix, `user: revive${reason ? ` — ${reason}` : ''}`);
    console.log(`✓ [forgen] revived ${rule.rule_id} (scope=me, strength=${rule.strength})`);
    if (clusteredInto) console.log(`  참고: ${clusteredInto} 룰에 병합돼 있던 룰입니다. 같은 뜻이 중복되면 그쪽을 정리하세요.`);
    console.log(`  ${rule.policy.slice(0, 100)}`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

export function handleRuleSnapshot(): void {
  console.log(`✓ [forgen] snapshot ${createSnapshot()}`);
  console.log('  restore: forgen rule restore <이름> --yes');
}

export function handleRuleRestore(args: string[]): void {
  const name = args.find((a) => !a.startsWith('--'));
  if (!name) {
    const list = fs.existsSync(SNAPSHOT_ROOT) ? fs.readdirSync(SNAPSHOT_ROOT).filter((n) => n.startsWith('rules-')).sort() : [];
    console.log(list.length ? list.join('\n') : '(no snapshots)');
    return;
  }
  if (!args.includes('--yes')) fail(`현재 룰·교정·솔루션을 ${name} 로 덮어씁니다. 진행하려면 --yes 를 붙이세요.`);
  try {
    const { safety } = restoreSnapshot(name);
    console.log(`✓ [forgen] restored ${name}. 직전 상태: ${safety}`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}
