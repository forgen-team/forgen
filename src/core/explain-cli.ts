/**
 * forgen explain — explain the most recent block in detail.
 *
 * Shows: what rule fired, why, what Claude said, and how to resolve.
 */

import * as path from 'node:path';
import { STATE_DIR } from './paths.js';
import { readJsonlWindow, ROTATED_KEEP_DAYS, isRealBlock, effectiveVerdicts, readReceipt } from '../engine/lifecycle/signals.js';

const isTTY = process.stdout.isTTY;
const C = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
};

interface ViolationEntry {
  at?: string;
  rule_id?: string;
  rule?: string;
  guard?: string;
  source?: string;
  kind?: string;
  reason?: string;
  reason_preview?: string;
  violation_id?: string;
  matched?: string;
  message_preview?: string;
  pattern_preview?: string;
  tool?: string;
  session_id?: string;
}

function readViolations(): ViolationEntry[] {
  return readJsonlWindow<ViolationEntry>(path.join(STATE_DIR, 'enforcement', 'violations.jsonl'), ROTATED_KEEP_DAYS);
}

function readAcknowledgments(): Array<{ at?: string; session_id?: string }> {
  return readJsonlWindow<{ at?: string; session_id?: string }>(path.join(STATE_DIR, 'enforcement', 'acknowledgments.jsonl'), ROTATED_KEEP_DAYS);
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' });
  } catch {
    return iso;
  }
}

export async function handleExplain(args: string[]): Promise<void> {
  // ADR-017 D1: `--blocks` 는 실세션의 실제 차단만 보여준다(테스트 유래 'default' 세션·
  // advise(correction)·명시 우회 제외). 원시 로그는 `forgen inspect`.
  const violations = readViolations().filter((v) => isRealBlock(v as { kind?: unknown; session_id?: unknown }));

  if (violations.length === 0) {
    console.log(`\n  ${C.green}No blocks recorded.${C.reset} forgen hasn't blocked Claude yet.\n`);
    return;
  }

  const count = Math.min(Number(args[0]) || 1, 5);
  const targets = violations.slice(-count);

  const acks = readAcknowledgments();
  const verdicts = effectiveVerdicts();

  for (const v of targets) {
    const ruleId = v.rule_id ?? v.rule ?? v.guard ?? 'unknown';
    const source = v.source ?? 'unknown';
    const kind = v.kind ?? 'block';
    const when = v.at ? formatTime(v.at) : 'unknown time';
    const reason = v.reason ?? v.reason_preview ?? v.message_preview ?? v.pattern_preview ?? '(no reason recorded)';

    // Check if this block was acknowledged
    const blockTime = v.at ? new Date(v.at).getTime() : 0;
    const wasAcked = acks.some(a => {
      if (!a.at) return false;
      const ackTime = new Date(a.at).getTime();
      return ackTime > blockTime && ackTime - blockTime < 300_000; // within 5 min
    });

    console.log('');
    console.log(`  ${C.red}${C.bold}BLOCK${C.reset}  ${C.dim}${when}${C.reset}`);
    console.log(`  ${C.cyan}Rule:${C.reset}    ${ruleId}`);
    console.log(`  ${C.cyan}Source:${C.reset}  ${source} (${kind})`);
    if (v.tool) {
      console.log(`  ${C.cyan}Tool:${C.reset}    ${v.tool}`);
    }
    console.log(`  ${C.cyan}Reason:${C.reset}`);
    for (const line of reason.split('\n').slice(0, 5)) {
      console.log(`    ${C.dim}${line}${C.reset}`);
    }
    console.log(`  ${C.cyan}Resolved:${C.reset} ${wasAcked ? `${C.green}Yes — Claude retracted and resubmitted with evidence${C.reset}` : `${C.yellow}No acknowledgment found${C.reset}`}`);
    // ADR-017 D1 영수증: id · 매칭 프래그먼트 · 판정 · 전문 발췌(24h 내)
    const vid = typeof v.violation_id === 'string' ? v.violation_id : '';
    if (vid) {
      const verdict = verdicts.get(vid);
      const vLabel = !verdict ? `${C.yellow}unjudged${C.reset}`
        : verdict.verdict === 'correct' ? `${C.green}correct (정탐)${C.reset} by ${verdict.by}`
        : verdict.verdict === 'false_positive' ? `${C.red}false_positive (오탐)${C.reset} by ${verdict.by}`
        : `${C.yellow}unsure${C.reset} by ${verdict.by}`;
      console.log(`  ${C.cyan}Receipt:${C.reset} ${vid.slice(0, 8)}  verdict: ${vLabel}${verdict?.reason ? ` — ${C.dim}${verdict.reason.slice(0, 100)}${C.reset}` : ''}`);
      if (typeof v.matched === 'string' && v.matched) console.log(`  ${C.cyan}Matched:${C.reset} ${C.dim}${v.matched.slice(0, 140)}${C.reset}`);
      const receipt = readReceipt(vid);
      if (receipt) {
        console.log(`  ${C.cyan}Context:${C.reset}`);
        const m = typeof v.matched === 'string' ? v.matched.replace(/…$/, '').slice(0, 40) : '';
        const lines = receipt.split('\n');
        let at = m ? lines.findIndex((l) => l.includes(m)) : -1;
        if (at < 0) at = 0;
        for (const line of lines.slice(Math.max(0, at - 1), at + 2)) console.log(`    ${C.dim}${line.slice(0, 160)}${C.reset}`);
      }
      console.log(`  ${C.dim}Judge:   forgen block ${vid.slice(0, 8)} --ok | --fp${C.reset}`);
    }
    console.log('');
    console.log(`  ${C.dim}To suppress this rule: forgen suppress-rule ${ruleId}${C.reset}`);
    console.log(`  ${C.dim}To bypass one turn:    set FORGEN_USER_CONFIRMED=1${C.reset}`);
  }
  console.log('');
}
