# Claude Audit Brief for `forgen`

## Purpose

Use this document as a read-only audit prompt for Claude or another independent reviewer.

The goal is not to agree with the suspected findings. The goal is to verify, partially verify, or reject each claim using direct source evidence.

## Repository

`/Users/jang-ujin/study/forgen`

## Work mode

- Work read-only.
- Do not edit files.
- Do not run destructive commands.
- Prefer direct source inspection over assumptions.
- For every finding, provide exact `file:line` evidence.
- If a suspected finding is wrong, say `not confirmed` and explain why.
- If a suspected finding is partially true, say exactly which part is true and which part is overstated.
- Prioritize correctness over breadth.

## Project context

This repository appears to be a harness around Claude and AI coding workflows.

The critical surfaces are:

- Claude global settings mutation
- Hook behavior and permission decisions
- Trust, autopilot, and bypass policy
- Session transcript attribution
- Lifecycle and session recovery
- Install and uninstall behavior
- Persistence stores under concurrent hook execution

## Audit task

Independently verify or challenge the suspected findings below.

For each item, return:

1. Status: `confirmed`, `partially confirmed`, or `not confirmed`
2. Evidence: exact file and line references
3. Impact: concrete failure mode
4. Minimal fix
5. Tests that should be added

## Suspected findings

### 1. Settings lock may overwrite a live lock

Check:

- `src/core/settings-lock.ts`
- Does `acquireLock()` detect an existing live PID but still write the current PID to the lock file?
- Does release verify ownership?
- Could concurrent settings mutation corrupt or lose user Claude settings?

### 2. Settings JSON parse failure may cause data loss

Check:

- `src/core/settings-injector.ts`
- `scripts/postinstall.js`
- If Claude `settings.json` is malformed, do the readers fall back to `{}`?
- Can later writes replace the user's existing settings with a minimal generated object?
- Is backup or restore behavior sufficient to prevent this?

### 3. Effective trust may silently escalate to runtime bypass

Check:

- `src/preset/preset-manager.ts`
- `src/core/spawn.ts`
- `src/fgx.ts`
- `src/core/settings-injector.ts`
- If user profile wants a more restrictive trust level, can runtime config or flags like `dangerously-skip-permissions` effectively override it?
- Is the user warned?
- Is there audit logging or explicit per-session opt-in?

### 4. Permission handler may approve tools that comments imply should ask or pass through

Check:

- `src/hooks/permission-handler.ts`
- What do `approve()`, `approveWithWarning()`, `deny()`, and `ask()` mean in this hook protocol?
- In non-autopilot mode, does the hook return approval for tools that should use Claude's default permission flow?
- In autopilot mode, are `Bash`, `Write`, `Edit`, `MultiEdit`, etc. approved with warning rather than requiring confirmation?
- Is the naming of `ALWAYS_CONFIRM_TOOLS` consistent with actual behavior?

### 5. Session recovery may have code injection via `node -e`

Check:

- `src/hooks/session-recovery.ts`
- Look for `spawn(process.execPath, ['--input-type=module', '-e', ...])` or similar.
- Is `sessionId` interpolated into JavaScript source code?
- Can `sessionId` originate from hook stdin or another untrusted runtime payload?
- Would quoting with `'${sessionId}'` be unsafe?
- What is the minimal safer replacement? Examples: argv-based runner, dedicated script file, or `JSON.stringify`.

### 6. Legacy cutover may back up legacy profile but not remove or migrate original

Check:

- `src/core/legacy-detector.ts`
- `src/core/v1-bootstrap.ts`
- `src/store/profile-store.ts`
- `tests/core/legacy-detector.test.ts`
- Does `runLegacyCutover()` only create a backup?
- After that, can `profileExists()` still return true?
- Does `loadProfile()` validate schema, or can legacy-shaped JSON be treated as a v1 profile?
- Do tests actually assert removal or migration, or only backup existence?

### 7. Uninstall may not remove settings that install injects

Check:

- `src/core/settings-injector.ts`
- `src/core/uninstall.ts`
- What `statusLine.command` is installed? Is it `forgen me`?
- What `statusLine.command` does uninstall remove? Is it only `forgen status`?
- What env keys are installed? Are `FORGEN_*` keys added?
- Does uninstall only remove `COMPOUND_*` keys?
- Are hooks removed by ownership marker or by fragile string matching?

### 8. Transcript attribution may pick the wrong concurrent session

Check:

- `src/core/spawn.ts`
- How does the code locate the transcript after Claude exits?
- Does it choose the newest file by mtime under a cwd-derived transcript directory?
- What happens if two sessions run concurrently in the same cwd?
- Is cwd path sanitization consistent with Claude's actual transcript path encoding?
- Does the code read the entire transcript into memory?

### 9. Solution outcomes may perform read-modify-write without locking

Check:

- `src/engine/solution-outcomes.ts`
- Compare with safer locking or atomic helpers elsewhere, such as:
- `src/hooks/shared/file-lock.ts`
- `src/hooks/shared/atomic-write.ts`
- `src/engine/solution-index.ts`
- `src/engine/solution-writer.ts`
- Are pending, outcome, and correction writes protected by a file lock?
- Are writes atomic?
- Could parallel hooks lose or duplicate outcome records?

### 10. Postinstall mutates user Claude settings directly

Check:

- `package.json`
- `scripts/postinstall.js`
- Does `postinstall` run automatically on install?
- Does it read or write user Claude settings?
- Does it use the same settings lock, backup, and atomic write path as runtime settings injection?
- Is explicit user consent required before global settings mutation?
- What is the safer installation model?

## Claims that need nuance

Do not overstate these points:

- Do not claim all stores are unsafe if some stores already use locks or atomic writes.
- Do not claim `solution-index` or `solution-writer` are naive if they already use locking or hardening.
- Do not claim `readStdinJSON()` returning `null` is always P0. Assess each caller's fail-open or fail-closed behavior.
- Do not rely on non-existent docs files. Verify file existence before citing docs.

## Desired output format

```markdown
## Executive summary

Briefly list the highest-risk confirmed issues.

## Findings

### P0/P1/P2: Short title

Status:
Evidence:
Impact:
Minimal fix:
Tests:

## Claims not confirmed or corrected

List any suspected findings that were wrong, overstated, or need nuance.

## Recommended fix order

Give a practical order for implementation.
```

## Optional Claude CLI invocation

If Claude CLI is authenticated and available, one possible read-only invocation is:

```bash
claude -p \
  --bare \
  --no-session-persistence \
  --effort high \
  --max-budget-usd 3 \
  --allowedTools Read,Grep,Glob \
  --disallowedTools Bash,Write,Edit,MultiEdit,NotebookEdit \
  --permission-mode default \
  "$(cat docs/claude-audit-brief.md)"
```

