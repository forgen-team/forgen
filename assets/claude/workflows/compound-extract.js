/**
 * forgen template — compound-extract
 *
 * 변경분(diff)/세션 작업에서 **재사용 가능한 판단 기준**을 추출한다. forgen 의
 * compound 원칙을 인코딩: "무엇을 만들었는가"(구현 기록)가 아니라 "이런 상황에서는
 * 이렇게 한다"(적용 조건 + 판단 근거 + 주의사항)로 프레이밍하고, 코드를 읽으면 알 수
 * 있는 것은 버린다. 여러 후보를 뽑은 뒤 중복을 병합하고, 각 후보가 정말 일반화
 * 가능한지(코드-자명하지 않은지) 비판 에이전트로 거른다.
 *
 * compound 연동(ADR-009 §3, 양방향):
 *   - Recall: 추출 전 forgen-compound MCP `compound-search` 로 기존 패턴을 회수해
 *     critic 이 중복(Q5)을 drop 하도록 한다.
 *   - Ingest: `args.persist === true` 일 때만 keep 된 후보를 `forgen compound
 *     --solution` 으로 store 에 적재. 기본값은 적재하지 않고 review 용으로 반환한다
 *     (forgen 의 human-review 규율 존중 — 품질 게이트 우회 금지).
 *
 * 사용:
 *   /compound-extract                         (대상=git diff HEAD~1, 적재 안 함)
 *   args 로 { range, persist } 전달 가능 (persist:true → 자동 적재).
 *
 * 저장 위치: ~/.claude/workflows/ (forgen workflows install 로 복사됨).
 */
export const meta = {
  name: 'compound-extract',
  description: 'forgen compound extraction — recall existing patterns, mine reusable JUDGMENT CRITERIA from a diff, dedupe via critic, and optionally persist (args.persist) to the compound store',
  phases: [
    { title: 'Recall', detail: 'compound-search existing patterns to dedupe against' },
    { title: 'Mine', detail: 'extract candidate patterns from the diff' },
    { title: 'Filter', detail: 'critic drops code-self-evident / duplicate / non-generalizable candidates' },
    { title: 'Ingest', detail: 'persist kept candidates (only when args.persist)' },
  ],
}

const range = (args && args.range) || 'HEAD~1'
const persist = !!(args && args.persist)

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

// 0) Recall — 기존 compound 패턴 회수 (dedup 근거). MCP 없으면 빈 컨텍스트.
const existing = await agent(
  `Use the forgen-compound MCP tool \`compound-search\` (via ToolSearch if needed) with a query derived ` +
  `from \`git diff ${range} --stat\` (key topics/domains). Return a concise list of EXISTING compound ` +
  `solution titles + one-line gist each. If unavailable or none, reply exactly: (no existing compound knowledge).`,
  { label: 'recall:existing', phase: 'Recall' },
)
const existingContext = existing && !/no existing compound knowledge/i.test(existing)
  ? `\n\n이미 store 에 있는 패턴(중복이면 drop):\n${existing}`
  : ''

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
    `drop, (b) 한 번 쓰고 말 1회성도 drop, (c) 이미 store 에 있는 것과 중복이면 drop, ` +
    `(d) 적용 조건+판단 근거가 일반화 가능하고 신규면 keep.\n\n` +
    `제목: ${c.title}\n조건: ${c.condition}\n근거: ${c.rationale}\n주의: ${c.caution || '(없음)'}${existingContext}`,
    { label: `filter`, phase: 'Filter', agentType: 'ch-critic', schema: KEEP_SCHEMA },
  ).then((j) => ({ ...c, ...j }))))

const kept = judged.filter(Boolean).filter((c) => c.keep).map((c) => ({
  title: c.refinedTitle || c.title,
  condition: c.condition,
  rationale: c.rationale,
  caution: c.caution,
}))
log(`compound-extract: ${candidates.length} candidates → ${kept.length} kept (dropped ${candidates.length - kept.length} as code-self-evident / duplicate / one-off)`)

// 3) Ingest (ADR-009 §3, opt-in) — keep 된 후보를 store 에 적재. args.persist 일 때만.
//    품질 게이트(Filter critic)를 이미 통과한 것만 들어오므로 우회가 아니다.
let persisted = 0
if (persist && kept.length) {
  const results = await parallel(kept.map((c) => () =>
    agent(
      `Persist this compound solution to forgen's store by running EXACTLY this shell command via Bash ` +
      `(escape quotes safely): forgen compound --solution "<title>" "<content>". \n` +
      `title: ${c.title}\n` +
      `content (조건/근거/주의를 한 본문으로): 조건: ${c.condition} | 근거: ${c.rationale} | 주의: ${c.caution || '없음'}\n` +
      `Run it, then reply "saved" if exit 0, else reply the error.`,
      { label: `ingest:${c.title.slice(0, 24)}`, phase: 'Ingest' },
    ).then((r) => (/saved/i.test(r || '') ? 1 : 0))))
  persisted = results.reduce((a, b) => a + (b || 0), 0)
  log(`compound-extract: persisted ${persisted}/${kept.length} via \`forgen compound --solution\``)
}

return {
  range,
  kept,
  persisted: persist ? persisted : 0,
  note: persist
    ? `Persisted ${persisted}/${kept.length} to the compound store. Verify with \`forgen compound list\`.`
    : 'Not persisted (default). Re-run with args { persist: true } to auto-save, or review with `forgen compound`.',
}
