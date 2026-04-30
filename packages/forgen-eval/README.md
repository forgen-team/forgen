# forgen-eval

Testbed for measuring forgen's behavioral-change identity (γ/β/δ/ε/ζ/φ/ψ 7-axis).

**Status**: v0.4.3-alpha (scaffolding). Real testbed PASS gate (φ ≤ 5%) target deferred to v0.5.0.

## Why this exists

claude-mem and forgen overlap on memory but differ on enforcement. This testbed measures what *only forgen* produces: rule extraction → hook block → persistent behavior change. claude-mem's own evals use SWE-bench (code correctness) — forgen-eval measures behavior change over time. Complementary, not competing.

See `docs/plans/2026-04-28-forgen-testbed-proof-spec.md` for the full spec and ADR-004/005/006 for design decisions.

## Architecture

```
5 arms × 7 metrics × 2 tracks (DEV / PUBLIC) × 2 tiers (smoke / full)

Arms:    vanilla | forgen-only | claude-mem-only | forgen+mem | gstack-only
Metrics: γ_slope (behavior change over time)
         β_likert (persona fit)
         δ_block (Mech-A enforcement)
         ε_inject (Mech-B self-check)
         ζ_persistence (anti-decay after N=50 sessions)
         φ_false_positive ★ master gate (≤ 5%)
         ψ_synergy ★ Full mode value (> 0)
Judges:  DEV — Sonnet 4.6 + Qwen 72B + Llama 70B (Fleiss' κ ≥ 0.8)
         PUBLIC — Qwen 72B + Llama 70B (Cohen's κ ≥ 0.7)
```

## Reproducing PUBLIC track

External users can fork this package and run:

```bash
# Prerequisites
node --version    # ≥ 18
bun --version     # ≥ 1.0 (claude-mem worker requires Bun)
ollama --version  # for Qwen + Llama local judges

# Install
pnpm install

# Smoke test (~10 min, ~$0 marginal cost)
pnpm smoke

# Full run (~hours, requires GPU for local judges)
pnpm full
```

Results match within ±5% of published numbers when same dataset commit hash is used.

## Pass Gate (release blocker)

Hard fails (any one):
- φ > 5% (false-positive rate)
- ψ ≤ 0 (no synergy in Full mode)
- κ_DEV < 0.8 or κ_PUBLIC < 0.7
- discard rate > 10%

Pass (all required):
- γ Cohen's d ≥ 0.8
- β paired diff ≥ +0.5 likert
- δ ≥ 90%, ε ≥ 85%, ζ ≥ 85%
- ψ > 0 (stretch ≥ 1)

See ADR-006 for full statistical methodology.

## License

MIT (forgen-eval itself). Note: `claude-mem` is AGPL-3.0 and used here only as a dev-time CLI invoked via `child_process` — not bundled into forgen distribution. See ADR-005 amendment 2026-04-28 for license-safe boundary.
