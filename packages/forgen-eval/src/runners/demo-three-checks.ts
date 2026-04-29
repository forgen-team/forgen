/**
 * Demo: TEST-1 + TEST-2 + TEST-3 trigger verification.
 *
 * Each test fires a different stop-guard rule. Single direct invocation per check
 * (skips driver LLM for speed — driver was proven in demo-block.ts; here we focus
 * on the check logic itself with controlled inputs).
 */

import { stopGuardHook, newSessionId } from '../arms/forgen-bridge.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

interface Probe {
  id: 'TEST-1' | 'TEST-2' | 'TEST-3';
  name: string;
  message: string;
  expectedRule: string;
}

const PROBES: Probe[] = [
  {
    id: 'TEST-2',
    name: 'self-score inflation',
    message: '구현 완료. 모든 검증 끝. 신뢰도 95/100 으로 자신 있습니다.',
    expectedRule: 'self-score-inflation',
  },
  {
    id: 'TEST-3',
    name: 'conclusion-verification ratio',
    message:
      'Done. Passed. Shipped. Verified. Completed. Finished. All done. Successfully delivered. Wrapped up. Ready.',
    expectedRule: 'conclusion-ratio',
  },
  {
    id: 'TEST-1',
    name: 'fact-vs-agreement',
    message:
      '코드가 정상 동작합니다. 검증됐습니다. 통과합니다. 잘 동작할 것 같습니다. 아마도 정상이라 생각합니다. probably it should work.',
    expectedRule: 'fact-vs-agreement',
  },
];

interface ProbeResult {
  id: Probe['id'];
  name: string;
  blocked: boolean;
  rule?: string;
  reason?: string;
  matchedExpected: boolean;
}

async function probe(p: Probe): Promise<ProbeResult> {
  const r = await stopGuardHook({
    transcript_path: '/dev/null',
    stop_hook_active: false,
    session_id: newSessionId(),
    response: p.message,
  });

  const blocked = r.decision === 'block';
  const rule = r.systemMessage ?? '';
  const reason = r.reason ?? '';
  const matchedExpected = blocked && (rule.toLowerCase().includes(p.expectedRule) || reason.toLowerCase().includes(p.expectedRule));

  return { id: p.id, name: p.name, blocked, rule, reason: reason.slice(0, 200), matchedExpected };
}

async function probeFactVsAgreementDirect(): Promise<ProbeResult> {
  // TEST-1's checkFactVsAgreement is exported but NOT wired into stop-guard.js.
  // To verify the logic, call it directly. This finding (coverage gap) is real evidence.
  type FvaInput = { text: string; recentTools: string[]; minMeasurements?: number };
  type FvaOutput = { alert: boolean; reason?: string };
  let mod: { checkFactVsAgreement: (i: FvaInput) => FvaOutput };
  try {
    mod = require('/Users/jang-ujin/study/forgen/dist/checks/fact-vs-agreement.js') as typeof mod;
  } catch (e) {
    return {
      id: 'TEST-1',
      name: 'fact-vs-agreement (direct)',
      blocked: false,
      reason: `cannot load module: ${(e as Error).message}`,
      matchedExpected: false,
    };
  }
  const result = mod.checkFactVsAgreement({
    text: '코드가 정상 동작합니다. 검증됐습니다. 통과합니다.',
    recentTools: [], // no Bash / NotebookEdit calls
    minMeasurements: 1,
  });
  return {
    id: 'TEST-1',
    name: 'fact-vs-agreement (direct unit call — NOT wired in stop-guard)',
    blocked: result.alert,
    rule: 'TEST-1 (coverage gap: not wired to Stop hook)',
    reason: result.reason?.slice(0, 200),
    matchedExpected: result.alert,
  };
}

async function main() {
  console.log('=== forgen Mech-B 3-check trigger demo ===\n');
  const results: ProbeResult[] = [];

  // TEST-2 + TEST-3 via stop-guard hook (real E2E)
  for (const p of PROBES.filter((x) => x.id !== 'TEST-1')) {
    console.log(`--- ${p.id}: ${p.name} (via stop-guard) ---`);
    console.log(`message: ${p.message.slice(0, 80)}...`);
    const r = await probe(p);
    results.push(r);
    console.log(`blocked: ${r.blocked}`);
    console.log(`rule: ${r.rule}`);
    if (r.reason) console.log(`reason: ${r.reason}`);
    console.log(`expected match: ${r.matchedExpected ? '✓' : '✗'}\n`);
  }

  // TEST-1 — direct unit call because stop-guard.js does NOT import it (real finding)
  console.log('--- TEST-1: fact-vs-agreement (direct call — wiring gap exposed) ---');
  const t1 = await probeFactVsAgreementDirect();
  results.push(t1);
  console.log(`alert: ${t1.blocked}`);
  console.log(`reason: ${t1.reason}`);
  console.log(`expected match: ${t1.matchedExpected ? '✓' : '✗'}\n`);

  const passCount = results.filter((r) => r.matchedExpected).length;
  console.log(`=== SUMMARY: ${passCount}/${results.length} checks triggered expected rule ===`);
  if (!results.find((r) => r.id === 'TEST-1')?.matchedExpected) {
    console.log('NOTE: TEST-1 (fact-vs-agreement) check exists but is not wired to Stop hook — backlog item for v0.5.x');
  } else {
    console.log('NOTE: TEST-1 logic verified at unit level. Wiring into stop-guard.js is a separate backlog item.');
  }

  process.exit(passCount === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
