# forgen-eval — Release Evaluation Checklist

## Automated (CI)

These checks run automatically via `.github/workflows/forgen-eval.yml`:

1. **Unit tests** — metric math correctness (γ/β/δ/ε/ζ/φ/ψ)
2. **Dataset version check** — pinned dataset commit resolves
3. **Baseline regression check** — existing report integrity + ψ bounds
4. **Phi gate** — CI width and metric sanity on latest report

## Manual (pre-release)

Run the full testbed manually before each version bump:

### Prerequisites

- Claude Code or Codex CLI authenticated
- API_DEV track (subscription-based, no API key needed)

### Steps

```bash
cd packages/forgen-eval

# 1. Build
npm run build

# 2. Run smoke testbed (N=10, ~5 min)
npm run smoke

# 3. Check report
ls reports/psi-stat/  # newest file is the result
```

### Pass criteria (7-axis)

| Metric | Gate | Threshold |
|--------|------|-----------|
| **φ (phi)** | HARD FAIL | Wilson 95% CI upper ≤ 0.05 |
| **δ (delta)** | Soft | Mean within 2σ of historical |
| **γ (gamma)** | Info | Direction positive preferred |
| **β (beta)** | Info | Direction positive preferred |
| **ε (epsilon)** | Info | Inject rate reported |
| **ζ (zeta)** | Info | Persistence rate reported |
| **ψ (psi)** | Info | ≈ 0 expected (forgen-only recommended) |

### Snapshotting new baselines

After a legitimate improvement changes metrics:

1. Run the smoke testbed (N=10 minimum, N=33 preferred)
2. Commit the new report JSON to `packages/forgen-eval/reports/psi-stat/`
3. Update this checklist if thresholds change

### Metric computation sources

- φ: `src/metrics/phi.ts` — Wilson score interval
- δ/ε/ζ: `src/metrics/delta-epsilon-zeta.ts` — block/inject/persistence rates
- γ: `src/metrics/gamma.ts` — correction-adherence slope
- β: `src/metrics/beta.ts` — behavioral-alignment score
- ψ: `src/metrics/psi.ts` — synergy (full - max(forgen, mem))

See [ADR-006](../../docs/adr/ADR-006-pass-gate-metric-methodology.md) for methodology.
