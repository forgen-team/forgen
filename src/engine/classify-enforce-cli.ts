/**
 * CLI handler for `forgen classify-enforce [--apply] [--force]`.
 *
 * 기본: dry-run — 각 rule 의 제안만 출력. 변경 없음.
 * --apply: 제안을 rule 파일에 저장 (enforce_via 미설정 rule 만).
 * --force: enforce_via 가 이미 있어도 덮어쓴다.
 */

import { loadAllRules, saveRule } from '../store/rule-store.js';
import { classifyAll, applyProposal } from './enforce-classifier.js';

export async function handleClassifyEnforce(args: string[]): Promise<void> {
  if (args.includes('--stop-only')) { await handleRetuneStop(args.includes('--apply')); return; }
  const apply = args.includes('--apply');
  const force = args.includes('--force');

  const rules = loadAllRules();
  if (rules.length === 0) {
    console.log('\n  No rules in ~/.forgen/me/rules. Nothing to classify.\n');
    return;
  }

  const proposals = classifyAll(rules);
  let saved = 0;
  let skipped = 0;
  let alreadySet = 0;

  console.log(`\n  Enforce Classifier — ${rules.length} rule(s) scanned\n`);
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const rule = rules[i];
    const marker = p.current_enforce_via ? '↻' : '+';
    console.log(`  ${marker} ${p.rule_id.slice(0, 8)}  "${p.trigger_preview}"`);
    console.log(`     strength=${rule.strength}  status=${rule.status}`);
    for (const spec of p.proposed) {
      const vparts: string[] = [spec.verifier?.kind ?? 'none'];
      if (spec.drift_key) vparts.push(`drift_key=${spec.drift_key}`);
      console.log(`     → Mech-${spec.mech} @ ${spec.hook}  verifier=${vparts.join(' ')}`);
    }
    for (const reason of p.reasoning) {
      console.log(`       · ${reason}`);
    }

    if (apply) {
      if (p.current_enforce_via && p.current_enforce_via.length > 0 && !force) {
        alreadySet += 1;
        console.log('       (skipped — enforce_via already set; use --force to overwrite)');
      } else {
        const updated = applyProposal(rule, p, { force });
        saveRule(updated);
        saved += 1;
        console.log('       (saved)');
      }
    } else {
      skipped += 1;
    }
    console.log('');
  }

  if (apply) {
    console.log(`  Summary: saved=${saved}  already-set=${alreadySet}  total=${rules.length}\n`);
  } else {
    console.log(`  Summary: ${skipped} proposal(s) previewed.  Run with --apply to save.\n`);
  }
}


/**
 * `forgen rule classify --stop-only [--apply]` (2026-10-07) — Stop 훅을 가진 활성 룰의 **Stop 설정만** 현재 분류기로
 * 다시 굽는다(다른 훅 설정·강도·본문 불변). 기본 dry-run 으로 룰별 발동 조건 종류와 판정 방식 변화를 보여준다.
 */
async function handleRetuneStop(apply: boolean): Promise<void> {
  const { loadActiveRules, projectRuleOverridePath } = await import('../store/rule-store.js');
  const fs = await import('node:fs');
  const { chooseStopTrigger, retuneStopSpecs } = await import('./enforce-classifier.js');
  const rules = loadActiveRules().filter((r) => (r.enforce_via ?? []).some((s) => s.hook === 'Stop'));
  console.log(`\n  Stop 룰 재조정 — ${rules.length}개 (${apply ? 'APPLY' : 'dry-run'})\n`);
  let changed = 0;
  const changes = new Map(retuneStopSpecs(rules).map((c) => [c.rule.rule_id, c.newStop]));
  for (const rule of rules) {
    const oldStop = (rule.enforce_via ?? []).filter((s) => s.hook === 'Stop');
    const newStop = changes.get(rule.rule_id) ?? oldStop;
    const kept = (rule.enforce_via ?? []).filter((s) => s.hook !== 'Stop');
    const same = !changes.has(rule.rule_id);
    const kind = chooseStopTrigger(rule.policy).kind;
    console.log(`  ${same ? '=' : '↻'} ${rule.rule_id.slice(0, 8)} [${kind}] ${oldStop.map((s) => s.verifier?.kind).join(',')} → ${newStop.map((s) => s.verifier?.kind).join(',')}  "${rule.policy.slice(0, 50)}"`);
    if (!same) changed += 1;
    if (apply && !same) saveRule({ ...rule, enforce_via: [...kept, ...newStop] });
    // 프로젝트 룰(<cwd>/.forgen/rules)이 같은 id 를 덮어쓰면 사용자 파일만 고쳐선 효과가 없다 — 그 파일의 Stop 설정도 갱신.
    const proj = projectRuleOverridePath(rule.rule_id);
    if (proj && !same) {
      console.log(`     ↳ 프로젝트 룰 파일이 이 룰을 덮어씀: ${proj}${apply ? ' — 함께 갱신(커밋 필요)' : ''}`);
      if (apply) {
        const pr = JSON.parse(fs.readFileSync(proj, 'utf-8')) as typeof rule;
        pr.enforce_via = [...(pr.enforce_via ?? []).filter((s) => s.hook !== 'Stop'), ...newStop];
        fs.writeFileSync(proj, `${JSON.stringify(pr, null, 2)}\n`);
      }
    }
  }
  console.log(`\n  변경 ${changed}개${apply ? ' 저장됨' : ' (적용: --apply)'}\n`);
}
