/**
 * forgen template — evidence-gate-audit
 *
 * forgen 철학을 dynamic-workflow 로 인코딩: 대상을 여러 각도로 감사(find)하고,
 * 각 발견을 forgen-verify 에이전트로 **실제 실행 증거** 기반 반박 검증한 뒤,
 * confirmed 만 보고한다. "찾았다"가 아니라 "증명됐다"만 남긴다.
 *
 * 사용:
 *   /evidence-gate-audit            (대상=src/, 기본 차원)
 *   args 로 { target, dimensions } 전달 가능.
 *
 * 저장 위치: ~/.claude/workflows/ (forgen workflows install 로 복사됨).
 */
export const meta = {
  name: 'evidence-gate-audit',
  description: 'forgen evidence-gated audit — find issues across dimensions, then confirm each with REAL execution evidence (forgen-verify), report only what is proven',
  phases: [
    { title: 'Find', detail: 'fan out finders across dimensions' },
    { title: 'Verify', detail: 'forgen-verify confirms each finding with real execution' },
  ],
}

const target = (args && args.target) || 'src/'
const DIMENSIONS = (args && args.dimensions) || [
  { key: 'correctness', prompt: `Audit ${target} for correctness bugs (logic errors, wrong conditions, off-by-one, unhandled nulls).` },
  { key: 'error-paths', prompt: `Audit ${target} for missing/empty error handling and swallowed exceptions.` },
  { key: 'concurrency', prompt: `Audit ${target} for race conditions and unguarded shared-state read-modify-write.` },
  { key: 'security', prompt: `Audit ${target} for injection, path traversal, secret leakage, and unsafe input handling.` },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          claim: { type: 'string', description: 'the concrete, testable claim that this is a real issue' },
          repro: { type: 'string', description: 'how to reproduce/verify it (command or steps)' },
        },
        required: ['title', 'file', 'claim'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unverified'] },
    evidence: { type: 'string', description: 'actual executed command + key output' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
}

// pipeline: 각 차원의 find 가 끝나는 즉시 그 발견들을 forgen-verify 로 검증.
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(`${d.prompt}\nReturn each issue as a concrete, testable claim with a repro.`, {
    label: `find:${d.key}`, phase: 'Find', schema: FINDINGS_SCHEMA,
  }),
  (found, d) => parallel((found?.findings || []).map((f) => () =>
    agent(
      `Adversarially verify this audit finding with REAL execution evidence (no mock). ` +
      `If you cannot reproduce it, return unverified. Default to refuted when uncertain.\n\n` +
      `Claim: ${f.claim}\nLocation: ${f.file}${f.line ? ':' + f.line : ''}\nRepro: ${f.repro || '(none given — derive one)'}`,
      { label: `verify:${d.key}:${f.file}`, phase: 'Verify', agentType: 'forgen-verify', schema: VERDICT_SCHEMA },
    ).then((v) => ({ ...f, dimension: d.key, ...v })),
  )),
)

const all = results.flat().filter(Boolean)
const confirmed = all.filter((f) => f.verdict === 'confirmed')
const unverified = all.filter((f) => f.verdict === 'unverified')

log(`evidence-gate-audit: ${all.length} findings → ${confirmed.length} confirmed, ${unverified.length} unverified (dropped: refuted)`)

return {
  target,
  confirmed,
  unverified, // surfaced separately — NOT silently dropped (no-silent-caps)
  summary: `${confirmed.length} proven issues in ${target}. ${unverified.length} could not be verified.`,
}
