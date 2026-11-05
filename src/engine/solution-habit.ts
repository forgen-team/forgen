/**
 * 습관 로그 판정. `works-with-typescript` 류는 "주로 TypeScript 코드를 작성합니다" 한 줄뿐이라 다른 작업에 재사용할
 * 지식이 아니고, 흔한 단어 때문에 주입 매치의 상당 부분을 차지했다(실측 31%). 솔루션이 아니라 behavior 로 취급한다.
 *
 * 판정 (extractedBy: auto 이고, 아래 둘 중 하나):
 *  - 이름이 제거된 추출기 접두사 (works-with-, writes-, edits-, uses-, prefers-) 이고 본문이 짧다(<=120자)
 *  - Context 가 "Detected from N … operations" (추출기가 남긴 표지)
 */
import { parseSolutionV3 } from './solution-format.js';

const HABIT_NAME_RE = /^(works-with|writes|edits|uses|prefers)-/;
const HABIT_CONTEXT_RE = /^Detected from \d+ [a-z ]*operations?/i;

export function isHabitLog(name: string, rawContent: string): boolean {
  const parsed = parseSolutionV3(rawContent);
  if (!parsed) return false;
  // 자동 생성 표식(extractedBy: auto)이 없으면 사용자가 쓴 솔루션이다. 이름·길이가 비슷해도 습관 로그로 취급하지 않는다.
  if (parsed.frontmatter.extractedBy !== 'auto') return false;
  if (HABIT_CONTEXT_RE.test(parsed.context.trim())) return true;
  return HABIT_NAME_RE.test(name) && parsed.content.trim().length <= 120;
}
