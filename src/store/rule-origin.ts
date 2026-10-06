/**
 * Rule origin — "이 룰은 언제 어떤 교정에서 생겼는가" (ADR-017 D0)
 *
 * 체감의 가장 싼 레버: 차단 메시지와 룰 렌더에 룰의 출처 교정(날짜·종류·문장)을 붙인다.
 * explicit_correction 룰만 대상 — 채굴 룰(behavior_inference)은 사용자가 한 말이 아니므로
 * 인용하지 않는다(ADR-013 provenance 차등).
 *
 * 정직성 (critic D0 SEV-2-a): evidence.summary 는 correction-record 를 호출한 **모델이 쓴 문장**이고
 * 실데이터 12/12 에서 rule.policy 와 동일하다. 그래서
 *   - raw_payload.user_quote (사용자 발화 원문, 2026-10-06 부터 저장) 가 있을 때만 "당신의 말" 로 인용하고
 *   - 없으면 "교정 기록 YYYY-MM-DD (kind)" 만 표기한다. summary 가 policy 와 같으면 인용문을 생략한다
 *     (같은 문장을 두 번 보여주는 중복 방지).
 *
 * 비용: evidence 파일 1개를 safeReadJSON 으로 직접 읽는다 — evidence-store 모듈 그래프(lifecycle·
 * classifier 등 18모듈)를 끌어오지 않는다 (critic SEV-2-b). 모든 경로 fail-open(null).
 */

import * as path from 'node:path';
import { ME_BEHAVIOR } from '../core/paths.js';
import { safeReadJSON } from '../hooks/shared/atomic-write.js';
import type { Evidence, Rule } from './types.js';

export interface RuleOrigin {
  /** YYYY-MM-DD (evidence timestamp 기준). */
  date: string;
  /** correction-record kind: fix-now | prefer-from-now | avoid-this (없으면 undefined). */
  kind?: string;
  /** 인용할 문장. 사용자 원문(user_quote)이 있으면 그것, 없고 summary 가 policy 와 다르면 summary, 같으면 ''. */
  quote: string;
  /** quote 의 출처 — 'user'(발화 원문) | 'summary'(모델 요약) | 'none'. */
  quoteSource: 'user' | 'summary' | 'none';
}

export const MAX_QUOTE = 90;

/** 한 줄·안전한 인용문: 공백 정규화, 제어문자·꺾쇠·백틱 제거, 길이 제한 (critic SEV-2-c). */
export function sanitizeQuote(raw: string): string {
  // 제어문자(0x00-0x1f, 0x7f)는 문자 코드로 걸러낸다 — 정규식 리터럴의 제어문자 escape 는 biome 이 금지.
  const noCtrl = Array.from(raw, (ch) => { const c = ch.charCodeAt(0); return c < 0x20 || c === 0x7f ? ' ' : ch; }).join('');
  const oneLine = noCtrl
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return oneLine.length > MAX_QUOTE ? `${oneLine.slice(0, MAX_QUOTE - 1)}…` : oneLine;
}

type OriginRule = Pick<Rule, 'source' | 'evidence_refs'> & { policy?: string };

function readEvidence(id: string): Evidence | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null; // 경로 인젝션 방지
  return safeReadJSON<Evidence | null>(path.join(ME_BEHAVIOR, `${id}.json`), null);
}

export function ruleOrigin(rule: OriginRule): RuleOrigin | null {
  try {
    if (rule.source !== 'explicit_correction') return null;
    // 가장 최근 교정 — append 순이 아니라 timestamp 로 고른다 (클러스터링으로 refs 가 늘면 순서 보장 없음).
    let best: Evidence | null = null;
    for (const id of rule.evidence_refs ?? []) {
      const ev = readEvidence(id);
      if (ev?.type !== 'explicit_correction' || typeof ev.timestamp !== 'string') continue;
      if (!best || ev.timestamp > best.timestamp) best = ev;
    }
    if (!best) return null;
    const date = best.timestamp.slice(0, 10);
    if (!date) return null;
    const kind = typeof best.raw_payload?.kind === 'string' ? best.raw_payload.kind : undefined;
    const userQuote = typeof best.raw_payload?.user_quote === 'string' ? sanitizeQuote(best.raw_payload.user_quote) : '';
    if (userQuote) return { date, kind, quote: userQuote, quoteSource: 'user' };
    const summary = typeof best.summary === 'string' ? sanitizeQuote(best.summary) : '';
    const policy = typeof rule.policy === 'string' ? sanitizeQuote(rule.policy) : '';
    if (summary && summary !== policy) return { date, kind, quote: summary, quoteSource: 'summary' };
    return { date, kind, quote: '', quoteSource: 'none' };
  } catch {
    return null;
  }
}

/** 차단/안내 메시지용 한 줄. 출처가 없으면 ''. */
export function originLine(rule: OriginRule): string {
  const o = ruleOrigin(rule);
  if (!o) return '';
  const kind = o.kind ? ` (${o.kind})` : '';
  if (o.quoteSource === 'user') return `[forgen] 이 룰의 출처 — ${o.date} 당신의 말${kind}: "${o.quote}"`;
  if (o.quoteSource === 'summary') return `[forgen] 이 룰의 출처 — ${o.date} 교정 기록${kind}: "${o.quote}"`;
  return `[forgen] 이 룰의 출처 — ${o.date} 교정 기록${kind}`;
}

/** 룰 렌더(v1-rules.md 등)용 짧은 꼬리표. 토큰 절감을 위해 날짜만. 출처 없으면 ''. */
export function originTag(rule: OriginRule): string {
  const o = ruleOrigin(rule);
  return o ? ` (교정 ${o.date})` : '';
}
