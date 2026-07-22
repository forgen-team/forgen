/**
 * private-filter — <private> 캡처 제외 태그 (Wave 2 W2-5, feature-audit 2026-07-21).
 *
 * 사용자가 응답/교정/코드에 민감 내용을 담을 때, 그 범위를 compound 추출·correction
 * 캡처·solution 저장·세션 인덱싱에서 제외한다. secret-filter(비밀키 커밋 차단)와는
 * 별개 축 — 이건 "학습 코퍼스에 넣지 말라"는 사용자 의도 마킹이다. $0-로컬·프라이버시
 * 우선 도구에 정합하며, 캡처 신뢰도를 높인다(사용자가 안심하고 교정할 수 있음).
 *
 * 마커 (claude-mem <private> 대응 + 편의 라인 마커):
 *   1. 블록:  <private> … </private>   (다중 라인, 대소문자 무시, 속성/공백 허용)
 *   2. 라인:  // forgen:private        (해당 라인 전체 제외)
 *             # forgen:private          (동일, 해시 주석 스타일)
 *             /* forgen:private          (동일, 블록주석 시작 스타일)
 *
 * fail-closed 원칙 (프라이버시 필터의 핵심): 사용자가 닫는 태그를 잊거나 오타를
 * 내는 것이 가장 흔한 실수다. 미닫힘 <private> 는 *조용히 누출*하지 않고 EOF 까지
 * private 로 취급한다(fail-closed). 중첩은 depth 카운팅으로 바깥까지 제거한다.
 *
 * 제외는 *조용히* 하지 않는다 — 호출측이 hadPrivate 로 로그/공지할 수 있게 반환한다.
 */

/** 여는 태그: 속성/공백 허용 (<private>, <private >, <private foo="x">). */
const PRIVATE_OPEN_RE = /<private(?:\s[^>]*)?>/i;
/** 닫는 태그: 공백 허용 (</private>, </private >). */
const PRIVATE_CLOSE_RE = /<\/private\s*>/i;
/** 라인 마커: //, #, /* 주석 스타일 + forgen:private. 해당 라인 전체 제거. */
const PRIVATE_LINE_RE = /^.*(?:\/\/|#|\/\*)\s*forgen:private.*$/gim;

export interface StripPrivateResult {
  /** private 범위를 제거한 텍스트. */
  cleaned: string;
  /** 제거된 private 범위가 하나라도 있었는지 (조용한 제외 방지 — 호출측 공지용). */
  hadPrivate: boolean;
}

/**
 * <private> 블록 범위를 fail-closed 로 제거한다.
 *   - 닫힌 블록: 여는~닫는 태그 사이 제거 (중첩은 depth 카운팅).
 *   - 미닫힘 블록: 여는 태그부터 EOF 까지 제거 (닫기를 잊은 사용자 보호).
 */
function stripBlocks(text: string): StripPrivateResult {
  let hadPrivate = false;
  let result = '';
  let i = 0;

  while (i < text.length) {
    const rest = text.slice(i);
    const open = rest.match(PRIVATE_OPEN_RE);
    if (!open || open.index === undefined) {
      result += rest;
      break;
    }
    const openAbs = i + open.index;
    // 여는 태그 앞 텍스트는 유지
    result += text.slice(i, openAbs);
    hadPrivate = true;

    // 여는 태그 뒤부터 nesting 을 고려해 매칭 닫는 태그를 찾는다.
    let depth = 1;
    let j = openAbs + open[0].length;
    while (j < text.length && depth > 0) {
      const tail = text.slice(j);
      const nextOpen = tail.match(PRIVATE_OPEN_RE);
      const nextClose = tail.match(PRIVATE_CLOSE_RE);
      const openIdx = nextOpen?.index ?? Infinity;
      const closeIdx = nextClose?.index ?? Infinity;

      if (openIdx === Infinity && closeIdx === Infinity) {
        // 닫는 태그 없음 → fail-closed: EOF 까지 private 취급.
        j = text.length;
        depth = 0;
        break;
      }
      if (openIdx < closeIdx) {
        depth++;
        j += openIdx + (nextOpen![0].length);
      } else {
        depth--;
        j += closeIdx + (nextClose![0].length);
      }
    }
    // depth>0 로 루프 종료 = EOF 도달(미닫힘) → 이미 j=text.length. 블록 전체 건너뜀.
    i = j;
  }

  return { cleaned: result, hadPrivate };
}

/**
 * <private> 블록 및 라인 마커 범위를 제거한다.
 * 완전히 private 이면 cleaned 는 (공백만 남아) '' 에 가깝다 — isFullyPrivate 로 판정.
 */
export function stripPrivate(text: string): StripPrivateResult {
  if (!text) return { cleaned: text ?? '', hadPrivate: false };

  const blocks = stripBlocks(text);
  let hadPrivate = blocks.hadPrivate;
  const cleaned = blocks.cleaned.replace(PRIVATE_LINE_RE, () => {
    hadPrivate = true;
    return '';
  });
  return { cleaned, hadPrivate };
}

/**
 * 캡처 대상이 *통째로* private 인지 — private 제거 후 의미 있는 내용이 남지 않으면 true.
 * (공백/개행만 남는 경우 포함) → 호출측은 저장 자체를 skip.
 */
export function isFullyPrivate(text: string): boolean {
  if (!text) return false; // 빈 입력은 private 이 아니라 그냥 없음
  const { cleaned, hadPrivate } = stripPrivate(text);
  return hadPrivate && cleaned.trim().length === 0;
}
