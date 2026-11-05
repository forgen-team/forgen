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

/**
 * R10: 이전 정규식 `\b(없|금지|마라…)\b` 는 한글에서 영원히 매칭되지 않았다 — JS 의 \b 는 ASCII 단어 경계라
 * 한글 글자 사이/옆에는 경계가 없다. 한글 부정 표지는 경계 없이, 영문만 \b 를 쓴다.
 * 한글: 금지, 마라/말라, 말 것, 하지 말, 하지 않, 않는다/않는, 안 된다/안된다, 불가, 못 한다/못한다.
 */
// 한글은 경계가 없어 부분 문자열 오탐이 생긴다: 마라톤/마라탕, 불가피/불가분, 단독 '않는'(지 않는 만 부정 표지).
export const NEGATION_RE = /(금지|마라(?!톤|탕|샹)|말라|말\s*것|말것|하지\s*말|지\s*않(?:는|도록)|하지\s*않|안\s*된다|안\s*됨|불가(?!피|분|침|결|사의|항력)|못\s*한다|하면\s*안)|\b(don'?t|do\s+not|never|not|avoid|must\s+not|forbidden|prohibited)\b/i;

/** 한글 어미·조사를 벗겨 어간만 남긴다: 실행하라/실행하지/실행해라 → 실행. 영문은 소문자 그대로. */
const HANGUL_SUFFIX_RE = /(하십시오|하세요|합니다|한다|하라|하지|하는|하게|하며|하고|하기|해라|해서|해야|할|함|하여|으로|에서|에게|까지|부터|처럼|보다|은|는|이|가|을|를|에|의|로|와|과|도|만)$/;
function stem(w: string): string {
  if (!/[가-힣]/.test(w)) return w;
  let cur = w;
  for (let i = 0; i < 2; i++) {
    const next = cur.replace(HANGUL_SUFFIX_RE, '');
    if (next.length < 2 || next === cur) break;
    cur = next;
  }
  return cur;
}

/** 모든 룰에 흔한 상투어는 공유 토큰 근거에서 제외 — 상반 판정이 우연한 겹침으로 나지 않게. */
const STOP_STEMS = new Set(['사용자', '작업', '진행', '필요', '반드시', '항상', '그리고', '때문', '경우', '대한', '위해', '있는', '없는', '것']);

/** 정책 문장이 부정(금지/하지 마) 어조인가. 클러스터링의 극성 가드도 같은 판정을 쓴다. */
export function hasNegation(policy: string): boolean {
  return NEGATION_RE.test(policy);
}

function tokens(policy: string): Set<string> {
  return new Set(
    policy
      .toLowerCase()
      .replace(/[.,;:!?()[\]{}"'`~]/g, ' ')
      .split(/\s+/)
      .map(stem)
      // 한글 어간은 2음절부터 의미 단위(실행, 배포), 영문/숫자는 3자 이상
      .filter((w) => (/[가-힣]/.test(w) ? w.length >= 2 : w.length >= 3) && !STOP_STEMS.has(w) && !NEGATION_RE.test(w))
  );
}

/**
 * 부정 표지 근처(앞뒤 2어절)의 어간 = "무엇을 하지 말라는가". 한글은 동사가 앞에(실행하지 마라),
 * 영문은 뒤에(don't deploy) 오므로 양쪽을 본다.
 * 상반 판정은 이 집합이 반대편 룰 본문에 **긍정 어조로** 등장할 때만 한다 — 어간 2개 겹침만으로는
 * "검증 필수 … 판단 금지" 같은 같은 원칙의 두 표현을 모순으로 오탐한다(한글 부정 탐지를 고친 뒤 실측).
 */
function negatedActions(policy: string): Set<string> {
  // 아포스트로피는 유지한다("don't" 가 "don t" 로 쪼개지면 부정 표지를 잃는다).
  const text = policy.toLowerCase().replace(/[.,;:!?()[\]{}"`~]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text.split(' ').filter(Boolean);
  const out = new Set<string>();
  const re = new RegExp(NEGATION_RE.source, 'gi');
  for (const m of text.matchAll(re)) {
    const wi = text.slice(0, m.index ?? 0).split(' ').length - 1;
    const wEnd = wi + m[0].split(' ').length - 1;
    for (let k = Math.max(0, wi - 2); k <= Math.min(words.length - 1, wEnd + 2); k++) {
      const st = stem(words[k].replace(/'/g, ''));
      if (NEGATION_RE.test(words[k])) continue;
      if ((/[가-힣]/.test(st) ? st.length >= 2 : st.length >= 3) && !STOP_STEMS.has(st) && !['말', '것'].includes(st)) out.add(st);
    }
  }
  return out;
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

  // M/T5 fix: 짧은 policy 는 토큰 overlap 이 우연히 발생하기 쉬우므로 20자 이상만.
  // scope 도 같아야 — session-scoped 임시 규칙과 me-scope 영구 규칙이 서로 충돌로 잡히면 노이즈.
  const active = input.rules.filter((r) => r.status === 'active' && r.policy.length >= 20);
  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    const aTokens = tokens(a.policy);
    const aNeg = NEGATION_RE.test(a.policy);
    for (let j = i + 1; j < active.length; j++) {
      const b = active[j];
      if (a.category !== b.category) continue;
      if (a.scope !== b.scope) continue; // M/T5: scope 불일치 시 pair 아님
      const bTokens = tokens(b.policy);
      const bNeg = NEGATION_RE.test(b.policy);
      if (aNeg === bNeg) continue; // 같은 어조 — 충돌 아님
      if (!sharedTokens(aTokens, bTokens, minShared)) continue;
      // 부정된 동작이 반대편 룰의 (긍정) 본문에 실제로 나와야 상반이다.
      const negated = negatedActions(aNeg ? a.policy : b.policy);
      const otherTokens = aNeg ? bTokens : aTokens;
      if (![...negated].some((t) => otherTokens.has(t))) continue;

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
