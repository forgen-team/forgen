/**
 * forgen block <id|prefix> --ok | --fp [--reason "..."]  (ADR-017 D1)
 * 사용자 판정 — 자동(Haiku) 판정을 덮어쓴다. id 는 violation_id 전체 또는 앞 8자 이상 prefix.
 */
import { readViolationsWindow, ROTATED_KEEP_DAYS, setVerdict, readReceipt, effectiveVerdicts } from '../engine/lifecycle/signals.js';

export async function handleBlock(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'));
  const ok = args.includes('--ok');
  const fp = args.includes('--fp');
  const reasonIdx = args.indexOf('--reason');
  const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : undefined;
  if (!id || (!ok && !fp) || (ok && fp)) {
    console.log('usage: forgen block <violation_id|prefix> --ok | --fp [--reason "..."]');
    console.log('       --ok  이 차단은 맞다(정탐)   --fp  이 차단은 틀렸다(오탐). 자동 판정을 덮어씁니다.');
    return;
  }
  if (!/^[A-Za-z0-9-]{8,}$/.test(id)) { console.log(`invalid id: ${id}`); return; }
  const all = readViolationsWindow(ROTATED_KEEP_DAYS);
  const matches = all.filter((v) => typeof v.violation_id === 'string' && v.violation_id.startsWith(id));
  if (matches.length === 0) { console.log(`no block with id ${id}. See: forgen status --blocks 5`); return; }
  const ids = new Set(matches.map((v) => v.violation_id));
  if (ids.size > 1) { console.log(`ambiguous prefix ${id} → ${[...ids].join(', ')}`); return; }
  const v = matches[matches.length - 1];
  const prev = effectiveVerdicts().get(v.violation_id as string);
  setVerdict({ violation_id: v.violation_id as string, rule_id: v.rule_id, verdict: ok ? 'correct' : 'false_positive', by: 'user', reason });
  console.log(`✓ [forgen] ${v.violation_id} (${v.rule_id}) → ${ok ? 'correct (정탐)' : 'false_positive (오탐)'} by user${prev ? ` (이전: ${prev.verdict} by ${prev.by})` : ''}`);
  const receipt = readReceipt(v.violation_id as string);
  if (receipt) console.log(`  receipt: ${receipt.split('\n')[0].slice(0, 100)}${receipt.length > 100 ? '…' : ''}`);
}
