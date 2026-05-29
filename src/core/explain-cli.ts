/**
 * forgen explain — explain the most recent block in detail.
 *
 * Shows: what rule fired, why, what Claude said, and how to resolve.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';

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
  message_preview?: string;
  pattern_preview?: string;
  tool?: string;
  session_id?: string;
}

function readViolations(): ViolationEntry[] {
  const p = path.join(STATE_DIR, 'enforcement', 'violations.jsonl');
  if (!fs.existsSync(p)) return [];
  const out: ViolationEntry[] = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

function readAcknowledgments(): Array<{ at?: string; session_id?: string }> {
  const p = path.join(STATE_DIR, 'enforcement', 'acknowledgments.jsonl');
  if (!fs.existsSync(p)) return [];
  const out: Array<{ at?: string; session_id?: string }> = [];
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
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
  const violations = readViolations();

  if (violations.length === 0) {
    console.log(`\n  ${C.green}No blocks recorded.${C.reset} forgen hasn't blocked Claude yet.\n`);
    return;
  }

  const count = Math.min(Number(args[0]) || 1, 5);
  const targets = violations.slice(-count);

  const acks = readAcknowledgments();

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
    console.log('');
    console.log(`  ${C.dim}To suppress this rule: forgen suppress-rule ${ruleId}${C.reset}`);
    console.log(`  ${C.dim}To bypass one turn:    set FORGEN_USER_CONFIRMED=1${C.reset}`);
  }
  console.log('');
}
