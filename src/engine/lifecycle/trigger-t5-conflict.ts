/**
 * T5 — 규칙 충돌 (conflict_detected).
 *
 * 트리거 조건:
 *   같은 category 인 rule pair 중, policy 자연어가 상반 (negation + 공통 키워드 ≥ 2).
 *
 * auto-merge 안 함. conflict_refs 플래그만 설정 → 사용자 수동 해소.
 */

import type { Rule } from '../../store/types.js';
import type { LifecycleEvent } from './types.js';

const NEGATION_RE = /\b(없|금지|마라|말라|하지\s*않|don'?t|never|not\s+|no\s+|avoid)\b/i;

function tokens(policy: string): Set<string> {
  return new Set(
    policy
      .toLowerCase()
      .replace(/[.,;:!?()[\]{}"'`~]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );
}

function sharedTokens(a: Set<string>, b: Set<string>, min: number): boolean {
  let count = 0;
  for (const t of a) if (b.has(t)) { count += 1; if (count >= min) return true; }
  return false;
}

export interface T5Input {
  rules: Rule[];
  min_shared_tokens?: number;
  ts?: number;
}

export function detect(input: T5Input): LifecycleEvent[] {
  const minShared = input.min_shared_tokens ?? 2;
  const ts = input.ts ?? Date.now();
  const events: LifecycleEvent[] = [];
  const reported = new Set<string>(); // 'a|b' 쌍 중복 방지

  const active = input.rules.filter((r) => r.status === 'active');
  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    const aTokens = tokens(a.policy);
    const aNeg = NEGATION_RE.test(a.policy);
    for (let j = i + 1; j < active.length; j++) {
      const b = active[j];
      if (a.category !== b.category) continue;
      const bTokens = tokens(b.policy);
      const bNeg = NEGATION_RE.test(b.policy);
      if (aNeg === bNeg) continue; // 같은 어조 — 충돌 아님
      if (!sharedTokens(aTokens, bTokens, minShared)) continue;

      const key = [a.rule_id, b.rule_id].sort().join('|');
      if (reported.has(key)) continue;
      reported.add(key);

      events.push({
        kind: 't5_conflict_detected',
        rule_id: a.rule_id,
        evidence: {
          source: 'rule-pairing',
          refs: [a.rule_id, b.rule_id],
        },
        suggested_action: 'flag',
        ts,
      });
      events.push({
        kind: 't5_conflict_detected',
        rule_id: b.rule_id,
        evidence: {
          source: 'rule-pairing',
          refs: [a.rule_id, b.rule_id],
        },
        suggested_action: 'flag',
        ts,
      });
    }
  }
  return events;
}
