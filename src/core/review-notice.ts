/**
 * 세션 시작 검토 대기 안내 (2026-11 재설계 D7).
 * 검토 대기(flagged) 룰이 3개 이상이면 사용자 화면(systemMessage)에 한 줄 — 하루 1회만.
 * 모델 컨텍스트에는 넣지 않는다(모델이 매 세션 사용자에게 재촉하지 않게).
 * 0.6.12 부터 T5 는 flag 하지 않으므로 남은 flagged 는 교정·반복 차단·우회 원인이다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';
import { loadActiveRules } from '../store/rule-store.js';
import { pendingReview } from '../engine/solution-review.js';

export const REVIEW_NOTICE_MIN = 3;
const DAY = 86_400_000;
const statePath = (): string => path.join(STATE_DIR, 'review-notice.json');

export function takeReviewNotice(now: number = Date.now()): string | null {
  try {
    const last = (JSON.parse(fs.readFileSync(statePath(), 'utf-8')) as { at?: number }).at ?? 0;
    if (now - last < DAY) return null;
  } catch { /* 기록 없음 */ }
  const n = loadActiveRules().filter((r) => r.lifecycle?.phase === 'flagged').length;
  // 0.8.0 K2: 재관측된 솔루션 승인 대기도 같은 안내 한 줄에 합친다(승인함은 하나, 하루 1회).
  let s = 0;
  try { s = pendingReview().length; } catch { /* 솔루션 폴더 문제는 무시 */ }
  const parts: string[] = [];
  if (n >= REVIEW_NOTICE_MIN) parts.push(`검토 대기 룰 ${n}개 — forgen rule review`);
  if (s >= REVIEW_NOTICE_MIN) parts.push(`승인 대기 솔루션 ${s}개 — forgen compound review`);
  if (!parts.length) return null;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ at: now, count: n, solutions: s }));
  } catch { /* 기록 실패해도 안내는 한다 */ }
  return `[forgen] ${parts.join(' · ')}`;
}
