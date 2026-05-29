/**
 * forgen template — compound-extract
 *
 * 변경분(diff)/세션 작업에서 **재사용 가능한 판단 기준**을 추출한다. forgen 의
 * compound 원칙을 인코딩: "무엇을 만들었는가"(구현 기록)가 아니라 "이런 상황에서는
 * 이렇게 한다"(적용 조건 + 판단 근거 + 주의사항)로 프레이밍하고, 코드를 읽으면 알 수
 * 있는 것은 버린다. 여러 후보를 뽑은 뒤 중복을 병합하고, 각 후보가 정말 일반화
 * 가능한지(코드-자명하지 않은지) 비판 에이전트로 거른다.
 *
 * 사용:
 *   /compound-extract              (대상=git diff HEAD~1)
 *   args 로 { range } 전달 가능 (예: "main...HEAD").
 *
 * 저장 위치: ~/.claude/workflows/ (forgen workflows install 로 복사됨).
 */
export const meta = {
  name: 'compound-extract',
  description: 'forgen compound extraction — mine reusable JUDGMENT CRITERIA (not implementation logs) from a diff, dedupe, and keep only what is not code-self-evident',
  phases: [
    { title: 'Mine', detail: 'extract candidate patterns from the diff' },
    { title: 'Filter', detail: 'critic drops code-self-evident / non-generalizable candidates' },
  ],
}

const range = (args && args.range) || 'HEAD~1'

const CANDIDATES_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'situation-framed, NO concrete component/function names' },
          condition: { type: 'string', description: 'when this applies' },
          rationale: { type: 'string', description: 'why — the judgment basis' },
          caution: { type: 'string', description: 'pitfalls / when NOT to apply' },
        },
        required: ['title', 'condition', 'rationale'],
      },
    },
  },
  required: ['candidates'],
}

const KEEP_SCHEMA = {
  type: 'object',
  properties: {
    keep: { type: 'boolean' },
    reason: { type: 'string', description: 'why kept or dropped (code-self-evident? not generalizable?)' },
    refinedTitle: { type: 'string' },
  },
  required: ['keep', 'reason'],
}

// 1) Mine — 여러 각도에서 후보 추출 (diff 를 직접 읽고).
const angles = [
  'debugging/디버깅에서 얻은 교훈 (재발 방지 판단 기준)',
  '설계/구조 결정의 근거 (왜 이 접근을 택했는가)',
  '함정/주의사항 (이 상황에서 흔히 틀리는 것)',
]
const mined = await parallel(angles.map((angle) => () =>
  agent(
    `\`git diff ${range}\` 를 읽고, "${angle}" 관점에서 재사용 가능한 판단 기준을 추출하라.\n` +
    `중요: 제목에 구체 컴포넌트/함수명 금지. "무엇을 만들었나"가 아니라 "이런 상황엔 이렇게 한다"로.\n` +
    `코드를 읽으면 바로 알 수 있는 사실은 후보에서 제외.`,
    { label: `mine`, phase: 'Mine', schema: CANDIDATES_SCHEMA },
  )))

const candidates = mined.filter(Boolean).flatMap((m) => m.candidates || [])

// 2) Filter — 각 후보를 비판 에이전트가 평가: 코드-자명하거나 일반화 불가면 drop.
const judged = await parallel(candidates.map((c) => () =>
  agent(
    `이 compound 후보가 저장할 가치가 있는가? 기준: (a) 코드를 읽으면 알 수 있는 건 ` +
    `drop, (b) 한 번 쓰고 말 1회성도 drop, (c) 적용 조건+판단 근거가 일반화 가능하면 keep.\n\n` +
    `제목: ${c.title}\n조건: ${c.condition}\n근거: ${c.rationale}\n주의: ${c.caution || '(없음)'}`,
    { label: `filter`, phase: 'Filter', agentType: 'ch-critic', schema: KEEP_SCHEMA },
  ).then((j) => ({ ...c, ...j }))))

const kept = judged.filter(Boolean).filter((c) => c.keep)
log(`compound-extract: ${candidates.length} candidates → ${kept.length} kept (dropped ${candidates.length - kept.length} as code-self-evident / one-off)`)

return {
  range,
  kept: kept.map((c) => ({
    title: c.refinedTitle || c.title,
    condition: c.condition,
    rationale: c.rationale,
    caution: c.caution,
  })),
  note: 'Review with `forgen compound` and save the ones worth accumulating.',
}
