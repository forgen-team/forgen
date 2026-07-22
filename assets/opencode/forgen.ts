/**
 * forgen — OpenCode plugin (W3-3 P1). install-opencode 가
 * ~/.config/opencode/plugins/forgen.ts 로 배포한다.
 *
 * OpenCode `tool.execute.before` 를 forgen 결정적 가드로 브릿지한다:
 *   - {tool, args} 를 `forgen opencode-guard` 에 async 로 넘겨 판정을 받고,
 *   - block 이면 throw → OpenCode 가 도구 실행을 차단.
 *
 * 얇은 shim 이라 번역/가드 로직은 forgen 이 소유(drift-free). 이벤트루프를 막지 않도록
 * **async** execFile 사용. forgen 미설치/오류는 fail-open(도구 안 막음)하되 stderr 로 남긴다.
 */
import { execFile } from "node:child_process"

export const forgen = async () => ({
  "tool.execute.before": async (
    input: { tool?: string },
    output: { args?: Record<string, unknown> },
  ) => {
    const decision = await new Promise<{ block?: boolean; reason?: string }>((resolve) => {
      const child = execFile(
        "forgen",
        ["opencode-guard"],
        { timeout: 8000, encoding: "utf-8" },
        (err, stdout) => {
          if (stdout) {
            try {
              resolve(JSON.parse(stdout))
              return
            } catch {
              /* fall through */
            }
          }
          if (err) console.error("[forgen] opencode-guard 호출 실패(fail-open):", err.message)
          resolve({ block: false })
        },
      )
      child.stdin?.end(JSON.stringify({ tool: input?.tool, args: output?.args }))
    })
    if (decision.block) throw new Error(decision.reason || "[forgen] blocked by guard")
  },
})

export default forgen
