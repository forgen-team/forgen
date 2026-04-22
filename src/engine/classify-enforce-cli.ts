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
