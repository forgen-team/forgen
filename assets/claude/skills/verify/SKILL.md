---
name: verify
description: Confirm a code change actually works using real execution evidence — run the project's own build, type-check, lint and tests, exercise the change itself, and report a confirmed / refuted / unverified verdict. Use right before committing a code change, or when asked to verify that something works.
---

<!-- forgen-managed -->

# verify — prove the change works before it is committed

"Saying it is done and proving it is done are different things."

This is the forgen default verification recipe. Claude Code runs a skill named `verify` right before
commits that touch code (docs-only and tests-only commits are skipped).

## 0. Prefer the repository's own recipe

If this repository documents how to verify changes — its own `.claude/skills/verify/SKILL.md`, or
verification/test commands in `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md` or the README — follow that
recipe first. It knows the project better than this generic one. Use the steps below for whatever it
does not cover, and keep the evidence rules in step 3 either way.

## 1. Scope the change

- `git status --short` and `git diff --stat` (staged and unstaged) to see what is about to be committed.
- State in one sentence what the change is supposed to do. That sentence is the claim you are verifying.

## 2. Run the project's real checks

Find the commands the project actually uses (`package.json` scripts, `Makefile`, `justfile`,
`pyproject.toml`, `Cargo.toml`, `go.mod`, CI workflow files) and run the ones relevant to the change:

1. build / compile
2. type-check
3. lint
4. tests — the tests covering the changed code first, then the full suite when it is reasonably fast

Keep it proportional: a one-line fix needs its targeted test and a build, not a 20-minute end-to-end run.
Say which checks you skipped and why.

## 3. Evidence rules

- Only output from commands you ran **now** counts. "It should pass" and results quoted from earlier
  in the session are not evidence.
- A passing test that mocks or stubs the unit you changed does not show the change works. Look for,
  or add, a check that executes the real code path.
- Exercise the change itself where feasible: run the CLI command, call the endpoint, load the page,
  import and call the function. A green test suite that never touches the new behaviour is not enough.
- Do not attach confidence percentages you did not measure.

## 4. Verdict

Report exactly one of:

- **confirmed** — the commands ran and their output supports the claim. Quote each command and the
  1–3 lines of output that matter.
- **refuted** — something failed or the behaviour is wrong. Do **not** commit. Show the failing output,
  fix the problem, then run this skill again.
- **unverified** — you could not run what was needed (missing dependency, no test covers it, needs
  credentials). Say precisely what could not be checked and ask before committing; never round
  unverified up to confirmed.

## 5. Riskier changes

For changes that touch persistence, authentication, money, concurrency, or public interfaces, hand the
claim to a fresh verifier sub-agent (`forgen-verify` or `ch-verifier` when available) and ask it to try
to break the claim rather than confirm it. Include its verdict in your report.
