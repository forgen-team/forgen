#!/usr/bin/env node
/**
 * scripts/self-gate-runtime.cjs — ADR-003 런타임 smoke.
 *
 * dist/hooks/*.js 를 spawn 하여 fake stdin 으로 호출, 기대 응답 JSON 이 리턴되는지
 * 확인한다. Claude Code 구동 없이 — hook 로직 자체의 self-consistency 를 증명.
 *
 * 시나리오 (ADR-003 §scripts/self-gate-runtime.cjs + A1 spike 산출물):
 *   SG-S1: 완료 선언 + 증거 없음 → stop-guard 가 decision:block
 *   SG-S2: retraction → stop-guard approve
 *   SG-S3: 일반 진행 메시지 → stop-guard approve
 *   SG-S4: shipped keyword → stop-guard block
 *   SG-S5: 한글 '완성되었습니다' → stop-guard block
 *   SG-S6: 테스트 맥락 vi.mock → stop-guard approve (exclude)
 *
 * 각 시나리오는 일시 HOME 으로 격리 — dev 의 실제 ~/.forgen 에 영향 없음.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const STOP_GUARD = path.join(REPO_ROOT, 'dist', 'hooks', 'stop-guard.js');
const SCENARIOS = path.join(REPO_ROOT, 'tests', 'spike', 'mech-b-inject', 'scenarios.json');

if (!fs.existsSync(STOP_GUARD)) {
  console.error(`[self-gate-runtime] stop-guard.js missing: ${STOP_GUARD}. Run npm run build first.`);
  process.exit(2);
}
if (!fs.existsSync(SCENARIOS)) {
  console.error(`[self-gate-runtime] scenarios.json missing: ${SCENARIOS}`);
  process.exit(2);
}

function makeSandboxHome() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-self-gate-'));
  return p;
}

function runStopGuard(lastMessage, sandbox) {
  return spawnSync('node', [STOP_GUARD], {
    input: JSON.stringify({ session_id: `self-gate-${process.pid}`, stop_hook_active: true }),
    env: {
      ...process.env,
      HOME: sandbox,
      FORGEN_SPIKE_RULES: SCENARIOS,
      FORGEN_SPIKE_LAST_MESSAGE: lastMessage,
    },
    encoding: 'utf-8',
    timeout: 10000,
  });
}

const scenarios = [
  { id: 'SG-S1', lastMessage: '구현 완료했습니다.',                       expect: 'block' },
  { id: 'SG-S2', lastMessage: '완료 선언을 취소합니다. 증거 없음.',        expect: 'approve' },
  { id: 'SG-S3', lastMessage: '작업 진행 중입니다.',                       expect: 'approve' },
  { id: 'SG-S4', lastMessage: 'shipped.',                                  expect: 'block' },
  { id: 'SG-S5', lastMessage: '기능 구현이 완성되었습니다.',               expect: 'block' },
  { id: 'SG-S6', lastMessage: '테스트에서 vi.mock 쓴 건 맞지만 dry-run 으로 동작 검증했습니다.', expect: 'approve' },
];

const failures = [];
for (const sc of scenarios) {
  const sandbox = makeSandboxHome();
  try {
    const proc = runStopGuard(sc.lastMessage, sandbox);
    if (proc.status !== 0) {
      failures.push({ id: sc.id, detail: `exit=${proc.status} stderr=${(proc.stderr ?? '').slice(0, 120)}` });
      continue;
    }
    const lastLine = proc.stdout.trim().split('\n').filter(Boolean).pop();
    const out = JSON.parse(lastLine);
    if (sc.expect === 'block') {
      if (out.decision !== 'block') {
        failures.push({ id: sc.id, detail: `expected decision:block, got ${JSON.stringify(out)}` });
      } else if (!out.reason) {
        failures.push({ id: sc.id, detail: `block but no reason` });
      }
    } else if (sc.expect === 'approve') {
      if (out.decision === 'block') {
        failures.push({ id: sc.id, detail: `expected approve, got block: ${String(out.reason ?? '').slice(0, 60)}` });
      } else if (out.continue !== true) {
        failures.push({ id: sc.id, detail: `expected continue:true, got ${JSON.stringify(out)}` });
      }
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

if (failures.length === 0) {
  console.log(`  [self-gate-runtime] ✓ ${scenarios.length}/${scenarios.length} hook scenarios passed`);
  process.exit(0);
}

console.error(`\n  [self-gate-runtime] ✗ ${failures.length}/${scenarios.length} failure(s):\n`);
for (const f of failures) {
  console.error(`    [${f.id}] ${f.detail}`);
}
process.exit(1);
