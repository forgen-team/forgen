# Multi-Harness Adapter Architecture Plan — OSS Gap #4

> **P1 진행 상태 (2026-07-22, W3-3 착수)**: **P1 파운데이션 착지.** `HostId += 'opencode'` +
> `capabilities-opencode.ts`(정직 매트릭스, **docs-level** — codex 의 source-level 과 구분) +
> registry 등록 + 17 컴파일 사이트 정직 충전(projection/binding 은 **fail-loud 스텁**,
> host-runtime/mismatch 는 실값·host-agnostic) + host-detect(XDG `~/.config/opencode`) +
> install-orchestrator "detected, install pending" 안내. **OpenCode = 선언·감지되나 아직
> 설치·실행 불가.** 전체 vitest green + 신규 capability-matrix 불변 테스트.
> **남은 P1 (후속 세션)**: (1) in-process plugin 슬림 `.opencode/plugins/forgen.ts`(§5 blocker 1,
> 최대 델타), (2) `install-opencode`, (3) opencode projection 실구현(스텁 대체), (4) plugin-return
> parity 바인딩(parity corpus 편입), (5) headless `opencode` CLI δ smoke(§4.3). 매트릭스 status 는
> 슬림 착지 시 docs-level→source-level 로 승격.


> Author: design-probe (team research). Date: 2026-07-20.
> Scope: `reports/competitive/oss-comparison-2026-07-20.md` §5 row 4 — multi-harness expansion (forgen 2 → target 4).
> Method: read-only source audit of `src/host/`, `src/core/`, `src/hooks/`, `packages/forgen-eval/` + primary-source web probes of OpenCode plugin docs, Cursor v3.11 hooks docs, ECC cross-harness architecture doc, claude-mem `--ide`. No product code changed.

---

## TL;DR

forgen is *not* actually starting from a Claude-coupled monolith. It already has a real adapter boundary — `TrustLayerIntent` (7 intents) + `HostCapabilities` (declarative per-host matrix with compile-time completeness enforcement) + `projection.ts` (host-native hook output → canonical Claude schema) + `parity-harness.ts` (projection-equivalence eval). **Codex was cheap because Codex's `hooks.json` is a near-clone of Claude's hook schema — the projection is nearly identity.**

The two named targets break that assumption in opposite ways:

- **Cursor** keeps the *shape* (subprocess + stdin-JSON + allow/deny/ask, `.cursor/hooks.json`) so the projection layer reuses almost directly — but **structurally lacks the surfaces forgen's differentiation needs**: no completion-block (`stop` hook is informational), no dynamic context injection (`beforeSubmitPrompt` output is silently stripped in v3.11). Cursor can host forgen's *surviving* moat (deterministic guards + MCP + static rules) but not the δ-injection moat, and δ is **not measurable** on an IDE-bound harness.
- **OpenCode** breaks the *shape* (in-process TypeScript plugin API, not subprocess-stdin) so it needs a new binding shim — but **preserves more capability**: block *any* tool (`tool.execute.before` throw), event-stream compound capture, partial dynamic injection, and a **headless CLI that forgen-eval can already drive** (the eval runs Ollama through forgen hooks today) so δ-per-harness is feasible.

**Recommendation: OpenCode first, then Cursor** — sequenced by moat-honesty, not by effort. OpenCode is the only new target where forgen can *measure* the thing ADR-010 says is the whole point. Cursor follows as an explicit "guard + MCP + static-rules" adapter published with **no δ claim** (honest-fail-path).

---

## 1. Current-state audit — the adapter boundary already exists

### 1.1 The interface layer (this is the moat abstraction, and it's good)

| Component | File | Role |
|---|---|---|
| Intent enum | `src/core/trust-layer-intent.ts` | 7 `TrustLayerIntent` values — the *portable contract* of what forgen guarantees on a host. |
| Capability declaration | `src/host/capabilities-{claude,codex}.ts` | Per-host `Record<TrustLayerIntent, {status, expression, mitigation?, source}>`. status ∈ supported\|partial\|unsupported. |
| Registry + self-check | `src/host/capabilities-registry.ts` | Compile-time `Record<TrustLayerIntent,_>` + runtime `assertCapabilitiesComplete` — **adding a host that omits any intent fails the build.** |
| Projection | `src/host/projection.ts` | `ProjectToClaudeEvent = (raw, input) => HookEventOutput`. Normalizes host-native hook output → canonical Claude schema. Core knows *only* Claude semantics; projection absorbs host specifics. |
| Binary entry | `src/host/codex-adapter.ts` | Subprocess shim: harness spawns this, it spawns the forgen delegate hook, reads stdout, calls `projectCodexToClaude`. |
| Parity eval | `src/host/parity-harness.ts` | 10-scenario corpus asserting both hosts project to semantically-equal canonical output. This is the ψ/δ-per-harness *scaffolding* (but see §4 — it tests projection equivalence, not model behavior). |
| Detection | `src/core/host-detect.ts` | binary-on-PATH + `~/.{host}/` + (codex) `auth.json`. |
| Install dispatch | `src/host/install-orchestrator.ts` → `install-{claude,codex}.ts` | Per-host install target. |
| Runtime exec | `src/host/{host-runtime,exec-host}.ts` | `RuntimeHost` exec abstraction (timeouts, arg quoting). |

**The extension mechanism is already type-driven and elegant:** widen `HostId` union → `Record<TrustLayerIntent>` (capabilities) and `Record<HostId>` (projections) force you to declare all 7 intents + a projection for the new host, or the compiler stops you.

### 1.2 Capability × harness matrix (current two hosts)

Mapping the 8 product capabilities the task named onto the 7 intents, as forgen binds them today:

| Product capability | Intent(s) | Claude surface | Codex surface | Coupling to Claude specifics |
|---|---|---|---|---|
| Static rule injection | (rendering, not an intent) | `.claude/rules/*` + settings.json | `AGENTS.md` managed block | Low — text files. Codex already diverges cleanly. |
| Dynamic context inject (compound recall, forge-loop state) | inject-context, forge-loop-state-inject | SessionStart/UserPromptSubmit `additionalContext` | same schema (identical) | Medium — assumes an `additionalContext` hook contract. |
| Completion guard (2nd-layer hard block) | block-completion | Stop hook `decision:"block"`+`reason` | Stop `decision:"block"` (Codex re-injects reason) | **High** — assumes a blocking Stop hook. |
| Tool-use guard | block-tool-use | PreToolUse `permissionDecision:"deny"` | same | Medium — assumes a pre-tool deny contract. |
| Secret filter | secret-filter | PreToolUse guard (+ opt. PostToolUse redact) | PreToolUse guard; post-redact *partial* (MCP-only) | Medium; Codex already declares `partial`. |
| Statusline | (none) | settings.json `statusLine.command` | **unsupported** (no surface) | **High + Claude-only** — `src/core/statusline-cli.ts` reads Claude statusLine stdin. |
| Compound extraction | self-evidence-record + transcript | transcript JSONL → FTS (`src/core/spawn.ts`) | per-runtime transcript path | Medium — needs a transcript source per host. |
| MCP knowledge tools | (server registration) | `~/.claude.json` `mcpServers` | `config.toml` `[mcp_servers]` | Low — every MCP host supports this. |

### 1.3 Where the coupling actually lives

Two real coupling hotspots, not a monolith:

1. **`prepareHarness` if-ladder** (`src/core/harness.ts:447-479`): a hard `if (runtime==='claude'){ settings + agents + rules + slash } else if (runtime==='codex'){ reconcile hooks }`. This is the ad-hoc dispatch that a `HostBinding` interface should replace.
2. **Scattered union literals**: `'claude' | 'codex'` is *defined* canonically in 3 places (`trust-layer-intent.ts:35` `HostId`, `types.ts:112` `RuntimeHost`, `store/host-mismatch.ts:18`) but **re-typed inline in ~17 more sites** (`exec-host.ts`, `invoke-agent.ts`, `evidence-store.ts`, `usage-telemetry.ts`, `profile-store.ts`, `auto-compound-runner.ts`, `context-guard.ts`, …). These must be centralized to one imported `HostId` before widening, or each becomes a manual edit. (~11 files also branch on `runtime === 'codex'`.)

Neither is architectural rot — both are mechanical. The statusline is the only genuinely Claude-only capability, and it's already effectively Claude-only (Codex declares no surface).

---

## 2. Target harness surface probe (July 2026)

### 2.1 Cursor (v3.11, July 2026)

- **Hook config**: `.cursor/hooks.json` (project) / `~/.cursor/hooks.json` / `/etc/cursor/hooks.json`. Hooks are **subprocess commands receiving stdin JSON, replying allow/deny/ask** — same shape as Claude/Codex.
- **6 hooks**: `beforeSubmitPrompt` (record-only), `beforeShellExecution` (allow/deny/ask), `beforeMCPExecution` (allow/deny/ask), `beforeReadFile` (allow/deny content to LLM), `afterFileEdit` (informational), `stop` (fires on completed/aborted/error — **informational, cannot block**).
- **Two hard limits**:
  - `beforeSubmitPrompt` output is **silently ignored** — "Cursor doesn't respect any output json here currently … such as stopping the task or adding context." → **no dynamic context injection.**
  - `stop` cannot prevent completion; and community reports say `stop`/`afterAgentResponse` may not fire reliably in cloud agents. → **no completion guard.**
- **Static rules**: `.cursor/rules` (MDC files) — the injection fallback.
- **MCP**: supported (`.cursor/mcp.json` + Team MCP Distribution in v3.11).

Sources: [Cursor hooks deep-dive (GitButler)](https://blog.gitbutler.com/cursor-hooks-deep-dive), [TrueFoundry Cursor Hooks API](https://www.truefoundry.com/docs/platform/cursor-hooks), [Cursor v3.11 changelog](https://cursor.com/changelog), [MintMCP Cursor hook governance](https://www.mintmcp.com/blog/mcp-governance-cursor-hooks).

### 2.2 OpenCode

- **Plugin system**: TS/JS modules in `.opencode/plugins/` or `~/.config/opencode/plugins/`, or npm packages in `opencode.jsonc`. **In-process modules** (loaded, not spawned) returning a hooks object — *not* subprocess-stdin.
- **25+ events**, relevant ones: `tool.execute.before` / `tool.execute.after`, `session.created` / `session.idle` / `session.compacted`, `experimental.session.compacting`, `permission.asked` / `permission.replied`, `message.updated`, `tui.prompt.append` / `tui.toast.show`.
- **Blocking**: `tool.execute.before` can **throw to block any tool** (docs' own example blocks `.env` reads) — stronger than Cursor (all tools, not just shell/MCP/read).
- **Completion**: `session.idle` fires but docs do **not** document a way to prevent completion / force another turn → completion-block unknown→treat as unsupported (advise via `tui.toast.show`).
- **Context injection**: via `experimental.session.compacting` (modify `output.context`/`output.prompt`) and `tui.prompt.append` / `session.created` — works but on experimental/less-stable surfaces → **partial**.
- **MCP**: `opencode.jsonc` MCP server definitions, started on demand.
- **Compound capture**: `message.updated` / `session.*` event stream — live, richer than file-transcript polling.

Sources: [OpenCode plugins docs](https://opencode.ai/docs/plugins/), [OpenCode plugin dev guide (Lushbinary)](https://lushbinary.com/blog/opencode-plugin-development-custom-tools-hooks-guide/), [Does OpenCode support hooks? (DEV)](https://dev.to/einarcesar/does-opencode-support-hooks-a-complete-guide-to-extensibility-k3p).

### 2.3 How competitors abstract this

- **ECC** (`docs/architecture/cross-harness.md`): "reusable workflow layer" vs harnesses as "execution surfaces." Portable core in `skills/*/SKILL.md`, `rules/`, `AGENTS.md`, `hooks/hooks.json`, `.mcp.json`. Per-harness adapters: Claude=native plugin; Codex=`.codex-plugin/plugin.json` instruction-backed hooks; **OpenCode=plugin/event adapter layer**; **Cursor=`.cursor/` translated rules/hooks/skills**; Gemini=install-only, "no full parity." Explicit doctrine: *"Adapters should stay thin."* Formal support matrix lives in `docs/architecture/harness-adapter-compliance.md`. Codex enforcement is **instruction-driven, not native** — i.e. ECC also concedes hard enforcement doesn't port; it renders *translated surfaces* and relies on advisory compliance off Claude. A `ecc2/` Rust control-plane is early alpha. Sources: [ECC cross-harness.md](https://github.com/affaan-m/ECC/blob/main/docs/architecture/cross-harness.md), [ECC repo](https://github.com/affaan-m/ecc).
- **claude-mem** `--ide`: `npx claude-mem install --ide opencode|antigravity`. Its multi-harness story is *easy because it only does context-injection + MCP* — both of which nearly every harness supports. Antigravity parity = "hooks + dual MCP registration + GEMINI.md/rules-file injection." **This is the tell: injection + MCP port trivially; enforcement is what doesn't.** Source: [claude-mem repo](https://github.com/thedotmack/claude-mem).

---

## 3. Gap analysis — what ports, what degrades, what's impossible

### 3.1 Honest capability × harness matrix (proposed publish target)

| Capability (intent) | Claude | Codex | **Cursor** | **OpenCode** |
|---|:--:|:--:|:--:|:--:|
| MCP knowledge tools | ✅ | ✅ | ✅ `mcp.json` | ✅ `opencode.jsonc` |
| Static rule injection | ✅ | ✅ `AGENTS.md` | ✅ `.cursor/rules` | ✅ `AGENTS.md`/`.opencode` |
| Tool-use guard (block-tool-use) | ✅ | ✅ | ⚠️ shell+MCP+read only | ✅ all tools (`throw`) |
| Secret filter | ✅ | ⚠️ post-redact partial | ✅ pre-side (shell/read/MCP) | ✅ pre + post |
| Dynamic context inject (δ surface) | ✅ | ✅ | ❌ stripped → static fallback | ⚠️ experimental surface |
| Completion guard (block-completion) | ✅ | ✅ | ❌ informational stop | ❌ no force-continue (advise) |
| Compound extraction | ✅ transcript | ✅ transcript | ⚠️ IDE chat store (unknown reader) | ✅ event stream |
| Statusline | ✅ | ❌ | ❌ (toast only) | ❌ (toast only) |

✅ supported · ⚠️ partial/degraded · ❌ unsupported (advise-only or fallback)

### 3.2 Reading the matrix against ADR-010

- **Ports cleanly to all 4**: MCP tools + static rules. This is the claude-mem-parity floor — forgen reaches it trivially and should ship it first inside each adapter.
- **Ports as real enforcement**: tool-use + secret guards. Per the competitive report §4/§6, forgen's *surviving* enforcement moat is exactly "deterministic secret/db guard," **not** completion-blocking. That surviving moat **does translate** — fully to OpenCode, partially to Cursor (shell/MCP/read, not Edit/Write pre-block).
- **Degrades — and it's the important one**: dynamic context injection is where ADR-010 says δ lives ("δ가 사는 곳: injection 품질"). It's **dead on Cursor** (v3.11 strips it — fallback is re-rendering `.cursor/rules` at session boot, i.e. static-ish) and **experimental on OpenCode**. So the δ-bearing moat is *harness-degraded on Cursor specifically*.
- **Impossible (honest)**: completion guard on both. Neither Cursor's `stop` nor OpenCode's `session.idle` can force continuation. Per ADR-010 F1 (opus-4.8 blocks=0, moat already moved off completion-blocking), the honest answer is **advise-mode** — surface a message, don't claim a hard block. This is not a regression vs forgen's real 2026 posture; it's the same per-model-advise reality extended to a per-harness axis (extend §5 F3 `model→{block|advise|off}` to `(model,harness)→policy`).
- **Statusline**: Claude-only, stays Claude-only. Don't invest.

---

## 4. Plan

### 4.1 Adapter architecture (extract, don't rebuild)

The boundary exists; the work is (a) centralize the union, (b) formalize the ad-hoc install dispatch into a `HostBinding` interface, (c) support **two binding shapes** under it.

```
src/host/
  adapter-contract.ts        # NEW: HostBinding interface (see below)
  adapter-registry.ts        # widen capabilities-registry to also hold bindings
  projection.ts              # unchanged contract; add per-host bindings
  adapters/
    claude/    { capabilities.ts, install.ts, binding.ts }   # move existing
    codex/     { capabilities.ts, install.ts, binding.ts, adapter.ts }  # move existing
    cursor/    { capabilities.ts, install.ts, binding.ts }   # NEW (subprocess shape)
    opencode/  { capabilities.ts, install.ts, plugin/forgen.ts, projection-binding.ts }  # NEW (in-process shape)
```

```ts
interface HostBinding {
  id: HostId;
  detect(): HostAvailability;
  capabilities: HostCapabilities;
  install(opts): InstallResult;      // writes host-native surfaces
  prepareSession(ctx): void;         // replaces the harness.ts if-ladder branch
  projection: ProjectToClaudeEvent;  // host-native → canonical Claude schema
  shape: 'subprocess-hook' | 'in-process-plugin';
}
```

- **`subprocess-hook`** (Claude, Codex, **Cursor**): harness spawns a forgen hook binary with stdin JSON; `projection.ts` normalizes stdout → canonical schema. Cursor reuses `codex-adapter.ts` almost verbatim (different config file, same shape).
- **`in-process-plugin`** (**OpenCode**): forgen ships `.opencode/plugins/forgen.ts` that `spawnSync`s the **same** forgen hook binaries, then translates canonical output → OpenCode semantics (throw-to-block / return object). The projection core is reused; only the *binding* (how the harness reaches forgen) is new. **This shim is the single biggest new-code delta in the whole effort.**

### 4.2 Phased rollout

| Phase | Scope | Effort | Gate |
|---|---|---|---|
| **P0 — Extract** | Centralize `HostId` (kill ~17 inline unions → one import); add `HostBinding` contract + registry; refactor `harness.ts` if-ladder → dispatch. No new harness. | **S (~3–5d)** | Existing Docker e2e stays green (no behavior change). |
| **P1 — OpenCode** | in-process plugin shim + `projection-binding` for throw/return semantics + `install-opencode` (`.opencode/plugins/forgen.ts`, `opencode.jsonc` MCP, `AGENTS.md`) + `capabilities-opencode` (block-completion=unsupported/advise, block-tool-use=supported, inject-context=partial). Parity scenarios from plugin-return shape. **δ smoke via headless `opencode` CLI in forgen-eval.** | **M–L (~2–3wk)** | Parity corpus passes + δ smoke run recorded. |
| **P2 — Cursor** | Reuse subprocess projection; `install-cursor` writes `.cursor/hooks.json` + `.cursor/rules` + `.cursor/mcp.json`; `capabilities-cursor` (block-completion=unsupported, inject-context=unsupported/static-fallback, block-tool-use=partial, secret-filter=supported). Parity from `hooks.json` schema (like Codex §18). | **M (~1–1.5wk)** | Parity passes; published **without δ claim**. |
| **P3 — Calibrate + publish** | Extend §5 F3 guard profiles to `(model,harness)→{block\|advise\|off}`; publish the §3.1 honest matrix in README with per-harness measurement status. | **S (after P1 data)** | R2-style data or explicit "unmeasured" label. |

**Why OpenCode before Cursor** (moat-honesty over effort): Cursor is cheaper (subprocess shape reuses projection directly) but on Cursor forgen's headline differentiation is *structurally absent or unmeasurable* — no dynamic injection (δ surface stripped), no completion guard, and δ can't be run on an IDE. Shipping Cursor first means shipping "forgen-lite" (guards + MCP + rules ≈ claude-mem parity) and calling multi-harness done, which contradicts ADR-010's "measure or don't claim." OpenCode is architecturally further but is the **only** new target where the moat both survives more intact *and* is measurable (headless CLI; the eval already drives Ollama through forgen hooks and pairs with external CLIs). Do the harder, honest one first; let Cursor be the fast-follow that's explicitly scoped and labeled.

### 4.3 Measurement story (can we run ψ/δ per harness?)

Two distinct measurements — keep them separate in any published claim:

1. **Projection parity** (`parity-harness.ts`): schema-derivable for **Cursor** (subprocess JSON — author scenarios from `.cursor/hooks.json` exactly as Codex was authored from its schema §18). For **OpenCode**, author a plugin-return parity binding (throw ≙ deny, returned context ≙ additionalContext). **Feasible for both.**
2. **Behavioral δ** (does forgen actually lift coding outcomes on that harness — `packages/forgen-eval/`): needs the harness's hook surface *active* during a driven run. The eval already drives a non-Claude local model (Ollama qwen2.5:14b, `arms/driver-llm.ts` + `demo-five-arms`) through real forgen hooks and real external CLIs (claude-mem). **OpenCode has a headless CLI → δ-per-harness is feasible.** **Cursor is IDE-bound → δ is NOT feasibly measurable** (July 2026; no stable headless agent CLI for eval beyond cloud agents). Publish Cursor as "projection-parity verified, δ n/a" — consistent with the honest-fail-path discipline.

---

## 5. Key blockers (ranked)

1. **OpenCode's in-process plugin model ≠ forgen's subprocess hook infra.** Needs a TS plugin shim that bridges into forgen's existing hook binaries + throw/return translation. Biggest single new-code delta; everything else reuses `projection.ts`.
2. **No completion guard on either target.** forgen's 2nd-layer hard block (`stop-guard.ts`) does not translate. Honest answer = advise-mode. Aligns with ADR-010 F1 (blocks=0 on frontier) — do **not** market "hard enforcement" on Cursor/OpenCode.
3. **Cursor v3.11 kills the δ surface.** `beforeSubmitPrompt` injection silently stripped + `stop` unreliable in cloud agents + IDE-bound (δ unmeasurable). Cursor is a "guard + MCP + static-rules" harness only; scope and label it as such.
4. **Union scattered inline in ~17 sites.** Centralize `HostId` before widening (P0). Mechanical but must precede everything.
5. **Per-harness δ only feasible for OpenCode.** Publishing a per-harness effect table means accepting Cursor stays δ-unmeasured. Extend F3 guard profiles to a `(model,harness)` axis so the per-harness *policy* (block/advise/off) is principled even where the *effect* is unmeasured.

---

## Appendix — files read (audit trail)

`src/core/trust-layer-intent.ts`, `src/host/capabilities-{registry,claude,codex}.ts`, `src/host/{projection,codex-adapter,parity-harness,install-orchestrator}.ts`, `src/host/install-codex.ts` (structure), `src/core/{harness,host-detect,host-runtime}.ts`, `src/core/statusline-cli.ts` (refs), `packages/forgen-eval/src/` (driver/judge structure), `docs/adr/ADR-010-platform-convergence-v0.5.0.md`, `reports/competitive/oss-comparison-2026-07-20.md`. Web: OpenCode plugins docs, Cursor v3.11 hooks (GitButler/TrueFoundry/changelog/MintMCP), ECC `docs/architecture/cross-harness.md`, claude-mem repo.
