/**
 * 문장이 활성 룰과 상반되는가. 라이프사이클 T5(한글 부정 표지 + 부정된 동작이 반대편에 긍정으로 등장)를 그대로 재사용한다.
 * T5 는 같은 category·scope 인 쌍만 보므로, 후보를 각 룰의 category·scope 로 복제해 비교한다.
 */
import { detect, NEGATION_RE } from '../engine/lifecycle/trigger-t5-conflict.js';
import type { Rule } from '../store/types.js';

/** T5 의 부정 표지에 "말고·거부·없이" 같은 변형을 더한 극성 판정. 같은 극성이면 상반이 아니다(같은 입장의 다른 표현). */
const EXT_NEG = /말고|거부|없이|막지|않고|않는|않음|아니|못하/;
const isNeg = (t: string) => NEGATION_RE.test(t) || EXT_NEG.test(t);

export function conflictingRule(text: string, rules: Rule[]): Rule | null {
  for (const r of rules) {
    if (r.status !== 'active' || isNeg(r.policy) === isNeg(text)) continue;
    const cand: Rule = { ...r, rule_id: '__candidate__', policy: text };
    if (detect({ rules: [r, cand], ts: 0 }).length) return r;
  }
  return null;
}
