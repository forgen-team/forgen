/**
 * 룰 복구 수단.
 *   forgen rule revive <id|prefix> [--reason "..."]  비활성·보관 룰을 영구 활성 룰로 되살린다
 *   forgen rule recover [--apply <id...>] [--project <키>]  활성 룰로 남지 못한 내 교정을 찾아 복구
 *   forgen rule snapshot                             룰·교정·솔루션 스냅샷
 *   forgen rule restore <이름> --yes                  스냅샷으로 되돌림(직전 상태를 먼저 스냅샷)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORGEN_HOME, ME_DIR, ME_RULES, ME_RULES_ARCHIVE } from '../core/paths.js';
import { atomicWriteJSON, safeReadJSON } from '../hooks/shared/atomic-write.js';
import { withStatusChange } from '../store/rule-lifecycle.js';
import { createRule, saveRule } from '../store/rule-store.js';
import { loadEvidenceByType } from '../store/evidence-store.js';
import type { Evidence, Rule } from '../store/types.js';
import { applyProposal, classify } from './enforce-classifier.js';

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

const normPolicy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 사용자 룰만 읽는다. 실행 위치의 프로젝트 룰에 따라 결과가 달라지면 안 된다. */
function userRules(): Rule[] {
  const out: Rule[] = [];
  for (const dir of [ME_RULES, ME_RULES_ARCHIVE]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const rule = safeReadJSON<Rule | null>(path.join(dir, name), null);
      if (rule?.rule_id && typeof rule.policy === 'string') out.push(rule);
    }
  }
  return out;
}

function offByUser(rule: Rule): boolean {
  const last = rule.status_history?.at(-1);
  return !!last && (last.by === 'cli' || last.reason?.startsWith('user:'));
}

export interface LostCorrection { evidence: Evidence; rule: Rule | null }

/**
 * 사용자가 직접 한 교정 중 활성 룰로 남지 못한 것. 예전 버전의 세션 정리·승급 실패로 사라진 교정을
 * 업그레이드한 사용자가 스스로 찾아 복구할 수 있게 한다. 같은 문장은 최신 1건만.
 * 제외: fix-now(원래 세션 한정), 사용자가 직접 끈 룰, 병합돼 대표 룰이 살아 있는 룰.
 */
export function findLostCorrections(): LostCorrection[] {
  const rules = userRules();
  const byId = new Map(rules.map((r) => [r.rule_id, r]));
  const byEvidence = new Map<string, Rule[]>();
  const byPolicy = new Map<string, Rule[]>();
  const put = (map: Map<string, Rule[]>, key: string, rule: Rule) => { map.set(key, [...(map.get(key) ?? []), rule]); };
  for (const r of rules) {
    put(byPolicy, normPolicy(r.policy), r);
    for (const ref of r.evidence_refs ?? []) put(byEvidence, ref, r);
  }
  const order: Record<string, number> = { suppressed: 0, superseded: 1, removed: 2 };
  const seen = new Set<string>();
  const out: LostCorrection[] = [];
  const evidence = loadEvidenceByType('explicit_correction').sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  for (const ev of evidence) {
    const text = normPolicy(ev.summary ?? '');
    if (!text || seen.has(text)) continue;
    seen.add(text);
    if ((ev.raw_payload as { kind?: string } | undefined)?.kind === 'fix-now') continue;
    const same = [...new Set([...(byEvidence.get(ev.evidence_id) ?? []), ...(byPolicy.get(text) ?? [])])];
    const alive = same.some((r) => r.status === 'active' || offByUser(r) || (r.clustered_into && byId.get(r.clustered_into)?.status === 'active'));
    if (alive) continue;
    same.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    out.push({ evidence: ev, rule: same[0] ?? null });
  }
  return out.sort((a, b) => a.evidence.timestamp.localeCompare(b.evidence.timestamp));
}

export function recoverCorrection(lost: LostCorrection, projects?: string[]): Rule {
  const scoped = projects?.length ? { projects } : {};
  if (lost.rule) {
    const revived = reviveRule(lost.rule.rule_id, 'user: rule recover');
    if (revived.strength === 'hard' || !projects?.length) return revived;
    const next = { ...revived, ...scoped };
    saveRule(next);
    return next;
  }
  const { evidence } = lost;
  const raw = (evidence.raw_payload ?? {}) as { kind?: string; target?: string; axis_hint?: string };
  const axis = raw.axis_hint ?? 'workflow';
  const target = raw.target || evidence.summary.slice(0, 80);
  const created = createRule({
    category: axis === 'quality_safety' ? 'quality' : axis === 'autonomy' ? 'autonomy' : 'workflow',
    scope: 'me',
    trigger: target,
    policy: evidence.summary,
    strength: raw.kind === 'avoid-this' ? 'strong' : 'default',
    source: 'explicit_correction',
    evidence_refs: [evidence.evidence_id],
    render_key: `${axis}.${evidence.evidence_id.slice(0, 8)}`,
    ...scoped,
  });
  let rule = created;
  try { rule = applyProposal(created, classify(created)); } catch { /* 분류 실패해도 룰은 남긴다 */ }
  saveRule(rule);
  return rule;
}

export function handleRuleRecover(args: string[]): void {
  const lost = findLostCorrections();
  const projectIdx = args.indexOf('--project');
  const project = projectIdx >= 0 ? args[projectIdx + 1]?.toLowerCase() : undefined;
  if (projectIdx >= 0 && !project) fail('usage: forgen rule recover [--apply <id...>] [--project <키>]');
  const applyIdx = args.indexOf('--apply');
  if (applyIdx < 0) {
    if (lost.length === 0) { console.log('복구할 교정이 없습니다.'); return; }
    console.log(`활성 룰로 남지 못한 교정 ${lost.length}건 (미리보기)`);
    for (const { evidence, rule } of lost) {
      console.log(`  ${evidence.evidence_id.slice(0, 8)}  ${evidence.timestamp.slice(0, 10)}  ${rule ? rule.status : '룰 없음'}  ${evidence.summary.slice(0, 80)}`);
    }
    console.log('복구: forgen rule recover --apply <id...> [--project <키>]  (--project 를 빼면 전역)');
    return;
  }
  const ids = args.slice(applyIdx + 1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--project');
  if (ids.length === 0) fail('복구할 ID 를 지정하세요. 미리보기: forgen rule recover');
  // ID 가 하나라도 잘못되면 아무것도 바꾸지 않는다. 적용 중 실패한 항목은 알리고 나머지는 계속한다.
  const picked = ids.map((id) => {
    const found = lost.filter((l) => l.evidence.evidence_id.startsWith(id));
    if (found.length !== 1) fail(`"${id}" 와 일치하는 복구 대상이 ${found.length}건입니다. 아무것도 복구하지 않았습니다.`);
    return found[0];
  });
  for (const item of picked) {
    try {
      const rule = recoverCorrection(item, project ? [project] : undefined);
      console.log(`✓ [forgen] 복구 ${rule.rule_id.slice(0, 8)} (${rule.projects?.join(',') ?? '전역'}) ${rule.policy.slice(0, 70)}`);
      if (project && rule.strength === 'hard') console.log('  hard 룰은 프로젝트로 좁힐 수 없어 전역으로 복구했습니다.');
    } catch (e) {
      console.error(`✗ [forgen] ${item.evidence.evidence_id.slice(0, 8)} 복구 실패: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  }
}
