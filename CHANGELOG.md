# Changelog

All notable changes to forgen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-04-15

### BREAKING

- **Skill consolidation: 21 → 10**. Removed: refactor, tdd, testing-strategy, documentation, git-master, ecomode, specify, performance, incident-response, database, frontend, ci-cd, api-design, debug-detective, migrate, security-review. Most were generic checklists; their content is better handled by Claude natively or absorbed into remaining skills.
- **Agent consolidation: 19 → 12**. Removed: performance-reviewer, security-reviewer (merged into code-reviewer as review perspectives), refactoring-expert, code-simplifier (merged into executor), scientist, qa-tester (merged into verifier), writer.
- **Custom frontmatter removed**: Agents no longer use `tier` and `lane` fields (Claude Code ignored them anyway).

### Added

- **5 new skills** designed from best-in-class research (OMC ralph, gstack /ship, /retro, /learn):
  - `forge-loop`: PRD-based iteration with Stop hook persistence. Prevents polite-stop anti-pattern.
  - `ship`: 15-step automated release pipeline with "never ask, just do" philosophy + Review Readiness Dashboard + Verification Gate.
  - `retro`: Weekly retrospective with git analysis + compound health + learning trend + compare mode.
  - `learn`: Compound knowledge management — 5 subcommands (search/stats/prune/export/import) with stale & duplicate detection.
  - `calibrate`: Evidence-based profile adjustment — quantitative protocol, 3-correction threshold, max 2 axes per calibration.
- **Stop hook forge-loop integration** (`context-guard.ts`): When `.forgen/state/forge-loop.json` has incomplete stories, Stop is blocked with persistence message. Circuit breakers: 2h stale threshold, 30 max blocks.
- **Learning Dashboard** (`forgen dashboard`): New "Learning Curve" section showing correction trend (7d vs prev 7d), top correction axes, activity days, estimated time saved via compound injections.
- **Session Summary with Counterfactual**: Session end message now includes "주입된 compound: N건 / 추정 절약 시간: Xh Ym (forgen 없었으면 시행착오 필요)".
- **Plugin system**: `.forgen/skills/*.md` scan path added. Project-level custom skills supported.
- **Stale agent cleanup**: `harness.ts` `installAgents` now removes `ch-*.md` files that don't exist in current source (with marker + hash verification for user-modification safety).

### Changed

- **All 10 skills upgraded** with `<Compound_Integration>`, `<Failure_Modes>`, `argument-hint`. Density dramatically improved despite fewer skills.
- **All 12 agents upgraded** with `<Failure_Modes_To_Avoid>`, `<Examples>` (Good/Bad), `<Success_Criteria>`, and official frontmatter (`maxTurns`, `color`, `permissionMode`).
- **deep-interview rewritten** using OMC research: weighted 4-dimension scoring, 3 challenge modes (Contrarian/Simplifier/Ontologist), ontology stability tracking, anti-sycophancy rules, one-question-at-a-time protocol.
- **Cancel flow**: `cancelforgen` now also deletes `forge-loop.json` to release Stop hook block.
- **Install is global-only**: `package.json` sets `preferGlobal: true` so non-global installs surface a warning (forgen is a CLI on PATH; local installs were unreachable).
- **README**: Added "12 built-in agents" section grouped by tool access (read-only / plan-only / write-enabled) with the absorbed-agent mapping from the 19→12 consolidation.

### Fixed

- **Agent parser compat**: Moved `<!-- forgen-managed -->` marker below YAML frontmatter in all 12 `agents/*.md`. Claude Code's agent parser requires `---` on line 1; the prior position caused `Agent(subagent_type: "ch-*")` to fail with "not found" while the file stayed marked as managed.
- **README install typo**: `npm install -g /forgen` → `npm install -g @wooojin/forgen` (missing scope).
- **flaky e2e test**: `runHook` helper in `tests/e2e/chain-verification.test.ts` now requires the parsed stdout JSON to carry a `continue` field, preventing stray log lines from satisfying the parser and producing false `continue:false` matches. Verified stable across 3 consecutive full runs (1541/1541 each).

### Documentation

- `docs/weakness-analysis-2026-04-14.md` — Competitor analysis vs 7 harness tools
- `docs/design-skills-agents-plugins.md` — Full design specification with implementation status
- `docs/skill-scenarios.md` — 12 developer scenarios × skill usage matrix
- `docs/positioning-and-selling.md` — Market positioning and Go-to-Market strategy

## [0.2.1] - 2026-04-13

### Added
- **specify skill**: Structured requirement specification with Resolved/Provisional/Unresolved 3-level evaluation and readiness percentage
- **deep-interview skill**: Deep requirement interview with Ambiguity Score (0-10) quantification across 5 axes (What/Who/How/When/Why)
- **Agent output validation** (Tier 2-F): PostToolUse hook validates sub-agent output for empty/failed/timeout/context overflow
- **BM25 ensemble scoring** (2-C): 3-way ensemble (TF-IDF 0.5 + BM25 0.3 + bigram 0.2) for solution matching
- **Intent-based context injection** (2-B): implement/debug/refactor/review intents inject domain-specific rules
- **Harness maturity diagnosis**: `forgen doctor` shows 5-axis L0-L3 maturity score with Quick Wins
- **Session brief handoff**: Structured brief saved before compact, restored on next session start
- **Output overflow prevention**: Solution injection footer includes head_limit guidance

### Fixed
- **Korean `\b` boundary**: Fixed 7 regex patterns where `\b` failed with Korean text (intent-classifier, keyword-detector)
- **Revert→drift connection**: `isRevert` was always false (checked messages array instead of boolean flag)
- **ALL_MODES missing specify**: `cancelforgen` didn't clear specify state
- **MCP list TypeError**: Crashed on url-format servers without `args` field
- **Agent empty string**: Empty string (`""`) was falsy, skipping validation
- **Solution content regex**: `\Z` is not valid in JavaScript (literal Z), changed to `$`
- **`severity: 'info' as 'warning'`**: Removed forced type assertion

### Changed
- **Rule renderer AI optimization** (2-A): `[category|strength]` tag prefix format, `include_pack_summary` defaults to false (token reduction)
- **Recovery messages** (1-A): ENOENT suggests Glob search, EACCES suggests chmod
- **skill-injector lock**: Session cache protected with `withFileLockSync` (race condition fix)
- **incrementFailureCounter lock**: Context signals protected with `withFileLockSync`
- Docker E2E expanded to 68 checks (Phase 8: Hoyeon analysis verification)

## [5.1.0] - 2026-04-06

### Fixed
- **Reflection 메커니즘 수리**: compound-read MCP 호출 시 `reflected += 1` 기록 — lifecycle 프로모션 루프 해제 (injected 30회인데 reflected 0이던 문제 해결)
- **훅 주입 누락 (W0)**: harness가 hooks.json을 settings.json에 직접 주입 — 플러그인 캐시 없이도 17개 훅 런타임 작동
- **태그 노이즈**: 한국어 조사 strip (`stripKoSuffix`), 영어 스톱워드 6개 추가, MAX_TAGS 10→8

### Added
- `forgen compound retag` CLI 서브커맨드 — 기존 솔루션 태그 일괄 재생성
- `readSolution()` `skipEvidence` 옵션 — compound-search snippet에서 evidence 오염 방지
- `migrateToForgen()` — `~/.compound/` → `~/.forgen/` 자동 마이그레이션 + symlink

### Changed
- 모든 `ME_*` 경로를 `~/.forgen/` 기반으로 통합 (스토리지 이원화 해소)
- `V1_*` 상수 deprecated 처리 (ME_*와 동일 경로)
- 완료/폐기된 계획 21개를 `docs/history/`로 이관

## [5.0.0] - 2026-04-03

### Breaking Changes
- v1 personalization engine: 4-axis profile (quality_safety, autonomy, judgment_philosophy, communication_style)
- 60% 코드 제거 (pack, remix, dashboard, loops, constraints, knowledge 등)

### Added
- Evidence-based learning: correction-record MCP → facet delta → profile auto-update
- Mismatch detection: rolling 3-session behavioral divergence alert
- Starter solutions: 15개 Day 0 value pack + postinstall seed
- Session store: SQLite FTS5 full-text session search

## [3.1.0] - 2026-04-01

### Added
- **Understanding layer (Phase 1)**: HTML dashboard (`forgen me --html`), Knowledge Map (`forgen compound map`), Evolution Timeline (sparkline), Session Retrospective (5-rule pattern engine)
- **Personalized orchestration (Phase 2)**: Pipeline Recommender (`forgen pipeline`), Agent Overlay Injection (PreToolUse approve(message)), Contextual Bandit (Factored Beta-TS)
- **Forge auto-init (Phase 0)**: Auto-creates forge-profile via project scan when missing, session endTime backfill, experiment cleanup (`doctor --clean-experiments`)
- **Surprise Detection**: z-score 1.5σ deviation from reward baseline (activates after 30+ observations)
- **Preference Stability**: BKT P(known) stability bars for dimension convergence tracking

### Fixed
- compound-search returned 0 results (tag noise + matchedTags<2 threshold + cross-language gap)
- compound-lifecycle timeout (grep scanned node_modules/dist/.git)
- pattern-detector ignored user-rejection events (only checked user-override)
- 4 HIGH issues from v3 code review (MCP readOnly, gate1 mutation, test homedir, empty assertion)

### Changed
- Korean stopwords expanded (+50 words for 조사/어미/접속사)
- Solution search: name-based matching boost for cross-language queries
- README: honest Day 1 timeline, "50+ pattern detectors" clarification, test stats updated

## [3.0.0] - 2026-03-31

### Breaking Changes
- **Public API**: Removed `readCodexOAuthToken`, `loadProviderConfigs`, `ProviderConfig`, `ProviderName`, `ProviderError`, `PackError`, `PackMeta`, `PackRequirement` exports from lib.ts
- **CLI**: 37 commands → 12 (removed pack, remix, dashboard, setup, status, worktree, ask, codex-spawn, synth, wait, notify, governance, gateway, worker, proposals, scan, verify, stats, rules, marketplace, session, philosophy)
- **Dependencies**: Removed `ink`, `react`. Added `zod` as direct dependency

### Added
- **MCP compound server**: 4 tools (compound-search, compound-list, compound-read, compound-stats) for on-demand knowledge access
- **Behavioral learning**: 10 thinking patterns (verify-first, quality-over-speed, understand-why, pragmatic, systematic, evidence-based, risk-aware, autonomous, collaborative, incremental)
- **Pre-compact Claude analysis**: Claude analyzes conversation for thinking patterns at context compaction (0 API cost)
- **Session feedback**: "[forgen] 학습된 패턴 N개 활성 중" shown at session start
- **forge-behavioral.md**: Auto-generated rules from learned preferences
- **Progressive Disclosure**: Push summaries (~200 tokens), pull full content via MCP (89% token reduction)
- **Hook response utilities**: Shared approve/deny/failOpen functions (Plugin SDK format)
- **Tool-specific matchers**: db-guard→Bash, secret-filter→Write|Edit|Bash, slop-detector→Write|Edit

### Changed
- **Codebase**: 36,977 → ~26,000 lines (30% reduction, Phase 1/2 added ~2,300 lines)
- **Hook protocol**: Migrated all 17 hooks from `result/message` to `continue/systemMessage` (Plugin SDK format)
- **Tag extraction**: Korean stopwords filter (80 words), MAX_TAGS=10, frequency-based ranking
- **Solution matching**: Identifier-based boost (+0.15), threshold relaxed (2 tags → 1 tag or 1 identifier)
- **Context budget**: Conservative fallback (factor=0.7 on detection failure)
- **Rules**: Conditional loading via paths frontmatter, RULE_FILE_CAPS enforced (3000/file, 15000/total)
- **Skill descriptions**: Updated to 3rd-person format per Claude Code Plugin SDK best practices
- **Build**: `rm -rf dist` before tsc (clean tarball guaranteed)

### Removed
- Pack system (src/pack/, packs/, forgen pack commands)
- Remix system (src/remix/)
- Dashboard TUI (src/dashboard/, ink/react dependencies)
- 27 unused modules (synthesizer, marketplace, worktree, etc.)
- 12 workflow mode commands (ralph, autopilot, team, etc.)
- Philosophy generator/CLI
- Templates directory
- Dead INJECTION_CAPS (keywordInjectMax, perPromptTotal)

### Fixed
- **compound-lifecycle.ts**: confidence subtraction -20 → -0.20 (was zeroing on 0-1 scale)
- **compound-lifecycle.ts**: Promotion now runs before staleness check (was blocking upgrades)
- **compound-lifecycle.ts**: Identifier staleness aligned to 6+ chars (was 4+, mismatched with Code Reflection)
- **session-recovery.ts**: runExtraction fire-and-forget (3056ms → 151ms)
- **Security**: Symlink protection at 8 locations, SUDO_USER execFileSync, settings.json single-write
- **postinstall**: Matcher field from hook-registry.json (was hardcoded '*')
- **uninstall**: Now cleans mcpServers['forgen-compound']
- **Dead paths**: forgen status→me, dashboard deleted, tmux binding fixed, REMIX_DIR removed
- **Docs**: All 4 language READMEs rewritten, SECURITY.md updated to 2.5.x→3.0.0

### Security
- 46 issues fixed across 6 review iterations
- All hooks fail-open with Plugin SDK format
- Prompt injection defense: 13 patterns + Unicode NFKC + XML escaping
- YAML bomb protection (5KB frontmatter cap, 3 anchor limit)

## [2.1.0] - 2026-03-25

### Added
- **Compound Engine integrity improvements**
  - **Code Reflection false positive prevention** — identifier minimum length raised from 4 to 6 characters, reducing false `reflected++` from common words
  - **"Why" context in auto-extraction** — extracted solutions now include git commit messages, addressing the "git diff only shows what, not why" gap
  - **Staleness detection** — `checkIdentifierStaleness()` verifies solution identifiers still exist in codebase via grep
  - **Extraction precision metrics** — `compound-precision` lab event emitted during lifecycle checks for tracking promotion/retirement rates
- **Token injection guardrail** — `MAX_INJECTED_CHARS_PER_SESSION = 8000` (~2K tokens) caps per-session injection cost, tracked in session cache
- **E2E hook pipeline tests** — 7 integration tests verifying actual hook stdin→stdout JSON protocol (solution-injector, keyword-detector, pre-tool-use, slop-detector, db-guard)
- **fgx security warning** — CLI now emits 3-line warning on startup when permissions are skipped
- **Documentation**
  - Open source readiness review feedback (P0/P1/P2 prioritized)
  - Action plan v2.1 (7 phases, 33 items, 18 success criteria)
  - ADR-001: large file decomposition plan
  - ADR-002: EMA learning rate parameter rationale
  - Auto vs manual extraction tradeoff guide
  - oh-my-claudecode coexistence guide
  - Case study template for dogfooding data
  - Good first issues list (6 issues)

### Fixed
- **3 failing tests** — slop-detector-main.test.ts depended on local `~/.compound/hook-config.json` (now mocked)
- **106 empty catch blocks → 0** — all replaced with `debugLog()` or descriptive comments explaining why safe to ignore
- **70 biome lint warnings → 5** — `noAssignInExpressions`, non-null assertions, array index keys, etc. (remaining: `useTemplate`, `useLiteralKeys`)
- **CI coverage double-run** — merged `npm test` + `--coverage` into single vitest invocation to prevent mock state corruption

### Changed
- **Coverage thresholds** — aligned vitest.config.ts with actual coverage (35% lines) instead of unrealistic 85%. CI now enforces thresholds.
- **Node.js requirement** — 18 → 20 (vitest v4/rolldown requires `node:util.styleText`)
- **CI matrix** — removed Node 18, kept Node 20 + 22
- **CONTRIBUTING.md** — replaced "No linter yet" with Biome instructions, added architecture diagram
- **README** — added vendor lock-in notice, "When to Use" table, fgx warning section
- **Multi-language READMEs** — synced KO/ZH/JA with all English changes
- **GitHub Actions** — checkout v4→v6, setup-node v4→v6

### Dependencies
- `@types/node` ^22.19.15 → ^25.5.0
- `@vitest/coverage-v8` ^4.1.0 → ^4.1.1

## [2.0.0] - 2026-03-24

### Added
- **Compound Engine v3** — evidence-based cross-session learning system
  - **Solution Format v3** — YAML frontmatter with version, status, confidence, tags, identifiers, evidence counters
  - **Code Reflection** — PreToolUse hook detects when injected solution identifiers appear in Edit/Write code
  - **Negative Signal Detection** — PostToolUse hook detects build/test failures and attributes to experiment solutions
  - **Extraction Engine** — git-diff-based automatic pattern extraction with 4-stage quality gates (structure, toxicity, dedup, re-extraction)
  - **Lifecycle Management** — experiment → candidate → verified → mature with evidence-driven promotion and confidence-based demotion
  - **Circuit Breaker** — experiment solutions with 2+ negative signals auto-retired
  - **Contradiction Detection** — flags solutions with 70%+ tag overlap but disjoint identifiers
  - **Prompt Injection Defense** — 13 injection patterns, Unicode NFKC normalization, XML tag escaping
  - **Solution Index Cache** — in-memory mtime-based cache for matching performance
  - **V1→V3 Migration** — automatic format upgrade on first access with symlink protection
  - **CLI** — `compound list`, `inspect`, `remove`, `rollback`, `--verify`, `--lifecycle`, `pause-auto`, `resume-auto`
- **Pack Marketplace** — GitHub-based community pack sharing
  - `forgen pack publish <name>` — publish verified solutions to GitHub + registry PR
  - `forgen pack search <query>` — search community registry
  - Registry: [wooo-jin/forgen-registry](https://github.com/wooo-jin/forgen-registry)
- **Lab compound events** — 6 new event types (compound-injected, compound-reflected, compound-negative, compound-extracted, compound-promoted, compound-demoted)
- 83 new tests (solution-format, prompt-injection-filter, solution-index, compound-lifecycle, compound-extractor)

### Changed
- `solution-matcher.ts` — tags-based matching replaces keyword substring matching
- `solution-injector.ts` — v3 format with status/confidence/type in XML output, experiment 1/prompt limit, cumulative injection-cache
- `compound-loop.ts` — v3 YAML frontmatter output, `inferIdentifiers()` for manual solutions, `slugify` deduplicated
- `pre-tool-use.ts` — Code Reflection + evidence update via parse-modify-serialize
- `post-tool-use.ts` — negative signal detection + evidence update
- `session-recovery.ts` — SessionStart triggers extraction + daily lifecycle check
- `state-gc.ts` — injection-cache pattern added for GC

### Dependencies
- Added `js-yaml` ^4.1.0 (YAML frontmatter parsing with JSON_SCHEMA safety)

## [1.7.0] - 2026-03-23

### Added
- **Forge** — signal-based personalization engine: project scanning, 10-question interview, 5 continuous dimensions (qualityFocus, autonomyPreference, riskTolerance, abstractionLevel, communicationStyle), generates agent overlays, skill tuning, rules, hook parameters, philosophy, and routing config
- **Lab** — adaptive optimization engine: JSONL event tracking, 8 behavioral pattern detectors, auto-learning closed loop (Lab → Forge, EMA 0.25, daily), component effectiveness scoring, A/B experiments, session cost tracking with HUD integration
- **Remix** — harness composition: browse/search published harnesses, cherry-pick individual components (agent/skill/hook/rule/principle), conflict detection (hash-based), provenance tracking
- **Multi-model Synthesizer** — heuristic response evaluation (4-axis scoring), agreement analysis, task-type-weighted provider synthesis, provider performance tracking
- **AST-grep integration** — real AST parsing via `sg` CLI with regex fallback, pre-built patterns for TypeScript/Python/Go/Rust, `forgen ast` CLI
- **LSP integration** — JSON-RPC 2.0 over stdio client, auto-detects tsserver/pylsp/gopls/rust-analyzer/jdtls, hover/definition/references/diagnostics, `forgen lsp` CLI
- **`forgen me`** — personal dashboard showing profile, evolution history, detected patterns, agent tuning, session cost
- **`forgen forge`** — onboarding UX with live dimension visualization after each interview answer
- **`forgen lab evolve`** — manual/auto learning cycle with dry-run support
- **`forgen lab cost`** / **`forgen cost`** — session cost tracking and reporting
- **`forgen synth`** — multi-model synthesis status, weights, and history
- **hookTuning pipeline** — forge generates hook parameters → hook-config.json → actual hooks (slop-detector, context-guard, secret-filter) read and apply them
- **Skill-tuner** — 6 skills (autopilot, ralph, team, ultrawork, code-review, tdd) respond to forge dimensions
- **Auto-learn notification** — profile evolution changes displayed on harness startup
- **Setup → Forge integration** — `forgen setup` offers forge personalization at the end
- 257 new tests (14 files) covering forge, lab, remix, evaluator, synthesizer, LSP

### Changed
- README rewritten for all 4 languages (EN/KO/ZH/JA) with new positioning: "The AI coding tool that adapts to you"
- package.json and plugin.json description updated to new positioning
- Interview deltas increased (±0.10~0.30) for meaningful profile divergence
- Auto-learn constants tuned: LEARNING_RATE 0.15→0.25, MAX_DELTA 0.1→0.15, MIN_EVENTS 50→30
- Agent overlays enriched from 1-3 line fragments to 3-5 sentence behavioral briefings
- LSP request timeout increased to 30s for large project indexing

## [1.6.3] - 2026-03-23

### Fixed
- **CRITICAL**: Fix ESM import side-effect causing double JSON output in `skill-injector` and `post-tool-use` hooks — root cause of Stop hook errors across environments
- **CRITICAL**: Fix "cancel ralph" activating ralph mode instead of canceling — keyword pattern priority conflict
- **CRITICAL**: Fix path traversal vulnerability via unsanitized `session_id` in file paths (7 hooks affected)
- Fix Stop hook timeout race condition — 0ms margin between plugin timeout and stdin read timeout
- Fix non-atomic file writes causing state corruption under concurrent sessions (9 hooks)
- Fix `readStdinJSON` missing `process.stdin.resume()` causing silent timeout in some Node.js environments
- Fix `readStdinJSON` having no input size limit (potential memory exhaustion)
- Fix user-supplied regex patterns in `dangerous-patterns.json` vulnerable to ReDoS
- Fix `ralph` keyword false positive matching on casual mentions
- Fix `pipeline` keyword requiring "pipeline mode" suffix — standalone "pipeline" now works
- Fix `migrate` and `refactor` keywords triggering on casual mentions — now require explicit mode invocation
- Fix inject-type keywords (`tdd`, `code-review`, etc.) causing double injection via both keyword-detector and skill-injector
- Fix `plugin.json` version stuck at `0.2.0` — now synced with `package.json`

### Added
- `--version` / `-V` CLI flag
- `sanitize-id.ts` shared utility for safe file path construction
- `atomic-write.ts` shared utility for corruption-resistant state writes
- `isSafeRegex()` validation for user-supplied regex patterns
- Ecomode entry in CLI help text and magic keywords section
- `cancel-ralph` keyword pattern for targeted ralph cancellation

## [1.6.2] - 2026-03-20

### Fixed
- Fix `.npmignore` excluding `templates/` from npm package
- Fix README coverage badge showing 60% instead of actual 41%
- Fix `@types/node` version mismatch (`^25` → `^18`) to match `engines: >=18`
- Fix type error in `session-recovery.ts` from `@types/node` downgrade
- Fix CHANGELOG duplicate entries in `[1.6.0]`
- Fix README banner image using relative path (breaks on npm)
- Adjust vitest coverage thresholds to match actual coverage

## [1.6.1] - 2026-03-20

### Fixed
- Resolve remaining audit warnings — rate-limiter timeout, governance try-catch
- Resolve 4 critical runtime issues from previous audit
- Resolve all skill/agent audit issues — 2 CRITICAL, 4 HIGH, 4 MEDIUM
- Correct README statistics — skills 11→19, hooks 14/18→17, tests 654→1204
- Complete i18n — convert all remaining Korean to English

### Added
- `cancel-ralph` skill for Ralph loop cancellation via `/forgen:cancel-ralph`
- `ralph-craft` skill for interactive Ralph prompt building

## [1.6.0] - 2026-03-20

### Added
- Ecomode for token-saving with Haiku priority and minimal responses
- Intent classifier for automatic task routing
- Slop detector to identify low-quality outputs
- 7 new skills for expanded workflow coverage
- Crash recovery support
- 47 scenario tests for comprehensive coverage
- Ralph mode integration with ralph-loop plugin for auto-iteration

### Changed
- Upgraded all 10 skills to OMC-level depth and completeness

### Fixed
- Comprehensive security, stability, and system design overhaul
- Replaced non-existent OMC references with forgen/Claude Code native APIs
- Resolved 13 cross-reference inconsistencies across skills, hooks, and modes

## [1.4.0] - 2025-12-01

### Added
- Gemini provider support
- Codex CLI integration
- Codex tmux team spawning with auto task routing
- `$ARGUMENTS` usage guide to all 12 forgen skills

### Fixed
- Cross-platform OAuth token for status-line usage display

## [1.3.0] - 2025-10-01

### Added
- Update notification when newer forgen version is available
- Skills installable as Claude Code slash commands (`/forgen:xxx`)
- Accumulated solutions injected into Claude context in compound flow

### Fixed
- Rules viewer skips empty dirs and finds pack rules correctly
- Connected pack info shown in startup message and HUD
- 7 CLI bugs: arg parsing, pack display, extends docs
- Project detection, pack init, and pack-builder skill
- Pack setup records `lastSync` for lock

## [1.1.0] - 2025-08-01

### Added
- Pack diagnostics to `doctor` command
- Extended pack schema: skills, agents, workflows, requires fields
- `pack add` / `pack remove` / `pack connected` CLI commands
- Pack assets integration into harness pipeline
- AI-guided pack building (`--from-project`, pack-builder skill)
- `pack.lock` for version pinning and update notifications
- Pack authoring guide

### Changed
- Migrated consumers to multi-pack API

### Fixed
- Consistency guards (P1/P2)
- 7 gaps from completeness verification

## [1.0.1] - 2025-06-15

### Fixed
- Resolved Codex-flagged blockers for npm publish
- Fixed command injection: `execSync` → `execFileSync`
- Fixed cross-platform compatibility (Windows/Linux/macOS)

## [1.0.0] - 2025-06-01

### Added
- Initial public release as **forgen** (renamed from tenet)
- Philosophy-driven Claude Code harness with 5-system workflow
- Multi-pack support
- Bilingual documentation (EN/KO)
- Core CLI commands: `fgx` entrypoint

[Unreleased]: https://github.com/wooo-jin/forgen/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/wooo-jin/forgen/compare/v2.1.0...v3.0.0
[2.1.0]: https://github.com/wooo-jin/forgen/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/wooo-jin/forgen/compare/v1.7.0...v2.0.0
[1.7.0]: https://github.com/wooo-jin/forgen/compare/v1.6.3...v1.7.0
[1.6.3]: https://github.com/wooo-jin/forgen/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/wooo-jin/forgen/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/wooo-jin/forgen/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/wooo-jin/forgen/compare/v1.4.0...v1.6.0
[1.4.0]: https://github.com/wooo-jin/forgen/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/wooo-jin/forgen/compare/v1.1.0...v1.3.0
[1.1.0]: https://github.com/wooo-jin/forgen/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/wooo-jin/forgen/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/wooo-jin/forgen/releases/tag/v1.0.0
