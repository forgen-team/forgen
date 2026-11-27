/**
 * forgen audit inputs — 사람 발화 분류기(결정적 규칙, 모델 호출 없음).
 *
 * A0 기준값(witems-workspace docs/plans/2026-11-27-A0-baseline.md §1)의 분류기 v2(`cls.py`)를 옮겼다.
 * 오너 판정(§7-0)으로 두 가지를 바꿨다: 재설명 규칙은 버리고, 우선순위 첫 일치 대신 **다중 분류**(한 발화에 여러 유형).
 * 같은 규칙의 첫 일치(primary)도 함께 내서 A0 숫자와 견줄 수 있게 한다.
 * 길이는 Python 과 같게 코드 포인트 수로 센다.
 */

export const INPUT_TYPES = ['nudge', 'lang', 'done', 'proxy', 'defect'] as const;
export type InputType = (typeof INPUT_TYPES)[number];
export type InputLabel = InputType | 'other';
/** 단순 입력 = 재촉·언어·완료 확인·조작 대행 (결함 보고는 단순 입력이 아님) */
export const SIMPLE_TYPES: ReadonlySet<InputType> = new Set(['nudge', 'lang', 'done', 'proxy']);
/** 첫 일치 순서(A0 v2 에서 재설명만 뺌) */
const PRIORITY: InputType[] = ['lang', 'proxy', 'nudge', 'done', 'defect'];

const LANG = /한글로|한국어로|한글 ?로|영어(로)? ?(쓰지|말고|하지)|한국말/;
const PROXY = /^(로[그긍]\S*\s?(했|함|됐)|승인 ?(했|함)|눌렀|이미 승인|했어|지금 눌렀|연결 ?(했|됐)|허용 ?했|(답|담)변? ?(왔|옴)|켰어|설치 ?했|재시작 ?했|토큰|지금 (맥|크롬))/;
const PROXY_SHORT = /했어[.!]?$|했음$/;
const NUD_TOK = /ㅇㅇ|ㅇㅋ|오케이|ㄱ+|고고|다시|이어서|이어|계속|진행해?|해|ok|OK|응|네|그래|좋아|[ .,!?~]/g;
const NUD_ANY = /ㄱㄱ|이어서|계속 ?(해|진행)|진행해|고고/;
const NUD_Q = /하고 ?있(어|는)|하는 ?중|돌고 ?있|얼마나 ?(걸|남)|아직 ?(도 )?(하|돌|안)|어디까지/;
const NUD_STALL = /멈췄|왜 멈|멈추면/;
const DONE = /(남은 ?(거|것|작업|일)|다 ?(했|끝|완료)|끝났|완료(여|야|된|했|인)|확실히 끝|빠진 ?거|누락|(배포|머지|반영) ?(안 ?)?(됐|된|했|돼|되))/;
const DONE_Q = /[?여야지나냐까]\s*$|\?/;
const DEFECT = /깨진|깨지|깨져|깨짐|이상해|이상한|(?<!이해가 )(?<!이해 )안 ?(돼|되)|안 ?나|안 ?보|안 ?열|에러|오류|버그|틀렸|잘못|뭐냐|실패|느려|왜 .{0,25}(안|못)|다 확인한 거|전체 검수|작동 ?안|동작 ?안|문제가 (있|생)|빈공간|너무 (작|크|좁|넓|많|적)|안 ?맞|어긋|겹치|잘려|잘리|짤리|튀어|밀려|삐뚤|끊겼|끊김|끊어졌/;

export function norm(t: string): string { return t.replace(/\s+/g, ' ').trim(); }
export function cpLen(s: string): number { let n = 0; for (const _ of s) n++; return n; }
export function cpSlice(s: string, end: number): string {
  if (s.length <= end) return s; // UTF-16 길이가 end 이하면 코드 포인트도 end 이하
  return Array.from(s).slice(0, end).join('');
}

/** 규칙마다 따로 본다(다중 분류). 맞는 유형이 없으면 빈 배열 = 그 외. */
export function classifyMulti(text: string): InputType[] {
  const s = norm(text);
  const L = cpLen(s);
  const head = cpSlice(s, 200);
  const hit = new Set<InputType>();
  if (L <= 80 && LANG.test(s)) hit.add('lang');
  if ((L <= 45 && PROXY.test(s)) || (L <= 14 && PROXY_SHORT.test(s))) hit.add('proxy');
  if ((L <= 30 && NUD_ANY.test(s) && cpLen(s.replace(NUD_TOK, '')) <= 3) || (L <= 40 && NUD_Q.test(s)) || (L <= 120 && NUD_STALL.test(s))) hit.add('nudge');
  if (L <= 90 && DONE.test(s) && DONE_Q.test(s)) hit.add('done');
  if (L <= 400 && DEFECT.test(head)) hit.add('defect');
  return PRIORITY.filter((t) => hit.has(t));
}

/** A0 v2 와 같은 첫 일치(재설명 제외) — 비교용 */
export function primaryOf(labels: InputType[]): InputLabel { return labels[0] ?? 'other'; }

// ── 어시스턴트 응답 ──

/** 언어 누수용: 코드 블록·인라인 코드·URL·경로를 지운 뒤 한글/영문 알파벳 수. Python `\w`(유니코드)와 같게 \p{L}\p{N}_ */
const STRIP = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|(?:\/[\p{L}\p{N}_.\-@]+){2,}/gu;
export function hangulStats(text: string): { hangul: number; alpha: number; isJson: boolean } {
  const st = text.trim();
  let isJson = false;
  if (st[0] === '{' || st[0] === '[') { try { JSON.parse(st); isJson = true; } catch { /* JSON 아님 */ } }
  const z = text.replace(STRIP, '');
  return { hangul: (z.match(/[가-힣]/g) ?? []).length, alpha: (z.match(/[A-Za-z]/g) ?? []).length, isJson };
}
/** 저한글: 한글/(한글+영문) < 0.3. 20자 미만·JSON 은 판정 대상이 아님(null) */
export function lowHangul(s: { hangul: number; alpha: number; isJson: boolean }): boolean | null {
  if (s.isJson || s.hangul + s.alpha < 20) return null;
  return s.hangul / (s.hangul + s.alpha) < 0.3;
}

/** M2 완료 보고(턴 마지막 text 블록, 150자 이상) — A0 §1 */
export const DONE_CLAIM = /(완료(했|됐|되었|하였|입니다|됨)|마쳤|마무리(했|됐)|배포(했|됐|되었)|머지(했|됐|되었)|끝났|끝냈|반영(했|됐|되었))/;
export const DONE_CLAIM_MIN = 150;
/** A0 §3 의 거친 대용("직접 발견·결함" 문구) — 연속성 비교용으로만 */
export const SELF_A0 = /(직접 (확인|발견)|발견했|찾아(서|내)|놓쳤|제가 .{0,10}(틀|잘못)|리뷰에서 .{0,20}(지적|발견)|결함)/;
/**
 * "Claude 가 완료 전에 스스로 찾은 결함" [근사] — 완료 보고 턴 안의 어시스턴트 text 블록 중
 * 발견 동사와 결함 명사가 한 줄 안에서 가까이 붙은 블록(또는 결함 명사 + 고침 동사).
 */
export const SELF_FOUND = [
  /(발견|찾았|찾아냈|드러났|확인해 ?보니|확인하니).{0,40}(버그|결함|오류|문제|회귀|누락|잘못|틀린|틀렸|어긋|깨)/,
  /(버그|결함|오류|회귀|누락|잘못된|틀린|문제(가|를|점)).{0,30}(발견|찾았|찾아냈|고쳤|수정했|바로잡|잡았)/,
  /\b(found|caught|spotted|discovered)\b.{0,40}\b(bug|issue|regression|problem|mistake|error)s?\b/i,
  /\b(bug|regression)s?\b.{0,30}\b(fixed|found|caught)\b/i,
];
export function isSelfFound(text: string): boolean { return SELF_FOUND.some((r) => r.test(text)); }

/**
 * M3 [실측]: 보고 관문이 완료 보고에 요구하는 "판단할 것" 라벨 줄. 라벨 뒤(같은 줄, 비었으면 다음 비지 않은 줄)가 "없음"이면 'none'.
 * 라벨이 없으면 null.
 */
const DECISION_LABEL = /판단할\s*것/;
export function decisionLabel(text: string): 'item' | 'none' | null {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => DECISION_LABEL.test(l));
  if (i < 0) return null;
  let body = lines[i].replace(/^.*?판단할\s*것/, '').replace(/^[\s:：*_#|)\]\-—–]+/, '').trim();
  if (!body) body = (lines.slice(i + 1).find((l) => l.trim()) ?? '').trim();
  body = body.replace(/^[\s\-*•·>|]+/, '').replace(/[*_`]/g, '').trim();
  return /^없(음|습니다|다)([.\s(|]|$)/.test(body) ? 'none' : 'item';
}

/** M3 예전 키워드 근사(연속성 비교용): 턴 마지막 보고에 "판단/결정할 것" 류 문구가 있었나 */
export const DECISION_ITEM = /(판단|결정)\s*(해야|하실|해 ?주실|할|이 필요한|필요)\s*(것|일|사항|항목|부분)|decision needed|for you to decide/i;
/** 그 다음 사람 발화가 추천을 뒤집거나 고쳤나 / 받아들였나 */
const OVERTURN = /(아니|아냐|말고|대신|반대로|다른 (걸|것|방법|안)|하지 ?마|안 ?할래|별로|그건 (안|아닌))/;
const ACCEPT = /(추천|권장|제안)\s*(대로|안으로|한 대로)|그대로|^(ㅇㅇ|ㅇㅋ|오케이|좋아|응|네|ok|ㄱㄱ)/i;
export function decisionReply(text: string): 'overturn' | 'accept' | 'unclear' {
  const s = norm(text);
  if (OVERTURN.test(s)) return 'overturn';
  if (ACCEPT.test(s)) return 'accept';
  return 'unclear';
}
