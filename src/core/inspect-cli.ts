/**
 * Forgen v1 — Inspect CLI
 *
 * forgen inspect profile|rules|evidence|session
 * Authoritative: docs/plans/2026-04-03-forgen-rule-renderer-spec.md §6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadProfile } from '../store/profile-store.js';
import { loadAllRules, loadActiveRules } from '../store/rule-store.js';
import { loadRecentEvidence, loadAllEvidence } from '../store/evidence-store.js';
import { loadRecentSessions } from '../store/session-state-store.js';
import * as inspect from '../renderer/inspect-renderer.js';
import { ME_BEHAVIOR, ME_SOLUTIONS, STATE_DIR } from './paths.js';
import { safeReadJSON } from '../hooks/shared/atomic-write.js';

export async function handleInspect(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'profile') {
    const profile = loadProfile();
    if (!profile) {
      console.log('\n  No v1 profile found. Run onboarding first.\n');
      return;
    }
    console.log(`\n${inspect.renderProfile(profile)}\n`);

    // ── Learning Loop Status ──
    const activeRules = loadActiveRules();
    const rulesByScope = {
      me: activeRules.filter(r => r.scope === 'me').length,
      session: activeRules.filter(r => r.scope === 'session').length,
    };

    const evidenceCount = (() => {
      if (!fs.existsSync(ME_BEHAVIOR)) return 0;
      return fs.readdirSync(ME_BEHAVIOR).filter(f => f.endsWith('.json')).length;
    })();

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentEvidence = loadRecentEvidence(100);
    const recentCount = recentEvidence.filter(e => e.timestamp >= sevenDaysAgo).length;

    const solutionCount = (() => {
      if (!fs.existsSync(ME_SOLUTIONS)) return 0;
      return fs.readdirSync(ME_SOLUTIONS).filter(f => f.endsWith('.md')).length;
    })();

    const lastExtractionData = safeReadJSON<{ timestamp?: string; date?: string } | null>(
      path.join(STATE_DIR, 'last-extraction.json'), null,
    );
    const lastExtractionTs = lastExtractionData?.timestamp ?? lastExtractionData?.date;
    const lastExtractionLabel = (() => {
      if (!lastExtractionTs) return 'never';
      const d = new Date(lastExtractionTs);
      const diffDays = Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
      const dateStr = d.toISOString().slice(0, 10);
      return diffDays === 0 ? `${dateStr} (today)` : `${dateStr} (${diffDays} day${diffDays > 1 ? 's' : ''} ago)`;
    })();

    console.log('── Learning Loop Status ──');
    console.log(`Rules:      ${activeRules.length} active (${rulesByScope.me} me, ${rulesByScope.session} session)`);
    console.log(`Evidence:   ${evidenceCount} corrections (last 7 days: ${recentCount})`);
    console.log(`Compound:   ${solutionCount} solutions`);
    console.log(`Last extraction: ${lastExtractionLabel}`);
    console.log('');

    // ── Recent Corrections ──
    const corrections = recentEvidence
      .filter(e => e.type === 'explicit_correction')
      .slice(0, 3);

    if (corrections.length > 0) {
      console.log('── Recent Corrections ──');
      for (const ev of corrections) {
        const kind = (ev.raw_payload as Record<string, unknown>)?.kind as string | undefined;
        const axis = ev.axis_refs[0] ?? 'general';
        const dateStr = ev.timestamp.slice(0, 10);
        console.log(`• [${axis}] ${ev.summary} (${kind ?? 'correction'}, ${dateStr})`);
      }
      console.log('');
    }

    // ── Receipts: correction → rule → inject ── (v0.4.10)
    // "내가 forgen 으로 무엇을 얻었나" 한 화면. correction 이 만들어낸 rule 의 lifecycle 을
    // 묶어 표시 — 주입(inject_count), 마지막 주입 시각, host 분포.
    await renderReceipts();

    return;
  }

  if (sub === 'rules') {
    const rules = loadAllRules();
    console.log(`\n${inspect.renderRules(rules)}\n`);
    return;
  }

  // R9-IA2: user-facing name is "corrections"; "evidence" kept as back-compat alias.
  if (sub === 'corrections' || sub === 'evidence') {
    const evidence = loadRecentEvidence(20);
    console.log(`\n${inspect.renderEvidence(evidence)}\n`);
    return;
  }

  if (sub === 'session') {
    const sessions = loadRecentSessions(1);
    if (sessions.length === 0) {
      console.log('\n  No session state found.\n');
      return;
    }
    console.log(`\n${inspect.renderSession(sessions[0])}\n`);
    return;
  }

  // R5-G1: 2AM 디버깅용 jsonl tail — violations/bypass/drift
  if (sub === 'violations' || sub === 'bypass' || sub === 'drift') {
    const limit = Number(args[args.indexOf('--last') + 1]) || 20;
    const fileMap: Record<string, string> = {
      violations: 'violations.jsonl',
      bypass: 'bypass.jsonl',
      drift: 'drift.jsonl',
    };
    const p = path.join(STATE_DIR, 'enforcement', fileMap[sub]);
    if (!fs.existsSync(p)) {
      console.log(`\n  No ${sub} data (${p} not found).\n`);
      return;
    }
    const lines = fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
    const tail = lines.slice(-limit);
    console.log(`\n  ${sub} (last ${tail.length} of ${lines.length}):`);

    // rule_id별 집계
    const byRule = new Map<string, number>();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const rid = entry.rule_id ?? 'unknown';
        byRule.set(rid, (byRule.get(rid) ?? 0) + 1);
      } catch { /* skip malformed */ }
    }
    if (byRule.size > 0) {
      console.log('  Aggregate (rule_id → count):');
      for (const [rid, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
        console.log(`    ${rid.slice(0, 24).padEnd(24)} ${count}`);
      }
    }

    // R7-U3: rule_id 전체 표시 + kind + source 분리 + resolve hint footer.
    console.log('\n  Recent (time — rule_id — kind@source — preview):');
    for (const line of tail) {
      try {
        const e = JSON.parse(line);
        const when = (e.at ?? '').slice(0, 19);
        const rid = (e.rule_id ?? '-').slice(0, 24); // 8자→24자 (prefix match 가능 길이)
        const kind = (e.kind ?? '-');
        const source = (e.source ?? '-');
        const preview = (e.message_preview ?? e.reason_preview ?? e.pattern_preview ?? '').slice(0, 60);
        console.log(`    ${when}  ${rid.padEnd(24)}  ${String(kind).padEnd(10)}@${String(source).padEnd(14)}  ${preview}`);
      } catch { /* skip */ }
    }
    console.log('');
    // R7-U3 footer: resolve hint
    console.log('  Resolve:');
    console.log('    Disable a rule:   forgen suppress-rule <rule_id>');
    console.log('    Re-enable:        forgen activate-rule <rule_id>');
    console.log('    Temp bypass turn: set FORGEN_USER_CONFIRMED=1 (audited)');
    console.log('');
    return;
  }

  console.log(`  Usage:
    forgen inspect profile               — 현재 profile 상태
    forgen inspect rules                 — active/suppressed 규칙 목록
    forgen inspect corrections           — 최근 corrections / behavior 기록 (alias: evidence)
    forgen inspect session               — 현재/최근 세션 상태
    forgen inspect violations [--last N] — 최근 block 기록
    forgen inspect bypass     [--last N] — 사용자 우회 기록
    forgen inspect drift      [--last N] — stuck-loop force-approve 기록`);
}

/**
 * v0.4.10 Receipts: correction → rule → inject 트리플.
 *
 * 사용자 가치 명제("the more you use, the better it knows") 의 receipt.
 * 1) Top-injected rules (실제로 Claude 에 주입된 룰 N회)
 * 2) Recent rule births (correction → 새 룰 생성된 이력)
 * 3) Host 균형 (claude vs codex)
 */
async function renderReceipts(): Promise<void> {
  const rules = loadAllRules();
  const evidence = loadAllEvidence();

  const injected = rules
    .filter((r) => r.lifecycle && (r.lifecycle.inject_count ?? 0) > 0)
    .sort((a, b) => (b.lifecycle?.inject_count ?? 0) - (a.lifecycle?.inject_count ?? 0))
    .slice(0, 5);

  console.log('── Receipts (correction → rule → inject) ──');
  if (injected.length === 0) {
    console.log('  No injected rules yet. Trigger a session to start the loop.');
  } else {
    console.log('  Top injected rules:');
    for (const r of injected) {
      const count = r.lifecycle?.inject_count ?? 0;
      const last = (r.lifecycle?.last_inject_at ?? '').slice(0, 10) || 'never';
      const trigger = (r.trigger ?? '').slice(0, 48);
      console.log(`    ${String(count).padStart(3)}×  [${r.category}] ${trigger} (last ${last})`);
    }
  }

  // Recent rule births: 마지막 7일 내 created_at 인 룰 (T = correction → rule)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentRules = rules
    .filter((r) => new Date(r.created_at).getTime() >= sevenDaysAgo)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 3);
  if (recentRules.length > 0) {
    console.log('  New rules (last 7 days):');
    for (const r of recentRules) {
      const dateStr = r.created_at.slice(0, 10);
      console.log(`    + [${r.category}/${r.strength}] ${(r.trigger ?? '').slice(0, 48)}  (${dateStr})`);
    }
  }

  // Host 균형 — multi-host 가치 명제의 receipt
  const hostCount: Record<string, number> = { claude: 0, codex: 0 };
  for (const e of evidence) {
    const h = (e.host ?? 'claude') as string;
    hostCount[h] = (hostCount[h] ?? 0) + 1;
  }
  const total = hostCount.claude + hostCount.codex;
  if (total > 0) {
    const cpct = Math.round((hostCount.claude / total) * 100);
    const xpct = 100 - cpct;
    console.log(`  Host balance: claude ${cpct}% · codex ${xpct}% (n=${total})`);
  }
  console.log('');
}
