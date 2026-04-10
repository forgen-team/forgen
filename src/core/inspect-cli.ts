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
import { loadRecentEvidence } from '../store/evidence-store.js';
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
    console.log('\n' + inspect.renderProfile(profile) + '\n');

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

    return;
  }

  if (sub === 'rules') {
    const rules = loadAllRules();
    console.log('\n' + inspect.renderRules(rules) + '\n');
    return;
  }

  if (sub === 'evidence') {
    const evidence = loadRecentEvidence(20);
    console.log('\n' + inspect.renderEvidence(evidence) + '\n');
    return;
  }

  if (sub === 'session') {
    const sessions = loadRecentSessions(1);
    if (sessions.length === 0) {
      console.log('\n  No session state found.\n');
      return;
    }
    console.log('\n' + inspect.renderSession(sessions[0]) + '\n');
    return;
  }

  console.log(`  Usage:
    forgen inspect profile   — 현재 profile 상태
    forgen inspect rules     — active/suppressed 규칙 목록
    forgen inspect evidence  — 최근 evidence 목록
    forgen inspect session   — 현재/최근 세션 상태`);
}
