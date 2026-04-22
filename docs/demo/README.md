# forgen v0.4.0 Trust Layer — 30-second demo

**What you'll see**: Claude claims "done" → forgen blocks with a rule you wrote → Claude retracts, runs Docker e2e, re-submits → forgen approves. **Zero extra API calls** — all one turn budget.

## Watch

- [Asciinema cast](mech-b-block-unblock.cast) (3.8 KB, 27 seconds)

**Play locally**:

```bash
asciinema play docs/demo/mech-b-block-unblock.cast
```

**Re-record** (if you want to tweak pacing or scenarios):

```bash
asciinema rec --command 'bash docs/demo/mech-b-demo.sh' docs/demo/mech-b-block-unblock.cast
```

**Run the demo live** (no recording — just watch it happen in your terminal):

```bash
bash docs/demo/mech-b-demo.sh
```

## What's real, what's simulated

| Step | Real / simulated |
|------|------------------|
| Rule file loaded from `.forgen/rules/L1-e2e-before-done.json` | **Real** — this is the committed dogfood rule |
| `stop-guard.js` invoked with Stop hook input JSON | **Real** — actual compiled hook, actual Stop hook contract |
| First call returns `decision:"block"` with reason | **Real** — byte-for-byte identical to what Claude Code sees |
| Docker e2e 63/63 output | **Simulated echo** — actual Docker run is ~2 min so the demo writes the evidence file directly; for the full e2e run see `tests/e2e/docker/run-test.sh` |
| Second call returns approve | **Real** — same hook, fresh evidence → rule passes |
| `forgen last-block` output | **Real** — reads actual violations.jsonl |

## Why this demo exists

Up to v0.3.x, forgen's pitch was personalization. v0.4.0 adds a Trust Layer: Claude's Stop hook gets blocked when its completion claim lacks evidence, and Claude reads the block `reason` as next-turn input. The whole loop happens inside one normal response budget — **no extra API calls**.

That behavior is hard to convey in prose. This demo is the purple-cow artifact: one 30-second clip that demonstrates the end-to-end mechanism. Based on A1 spike empirical result (10/10 scenarios, $1.74 total — see [docs/spike/mech-b-a1-verification-report.md](../spike/mech-b-a1-verification-report.md)).

## Share it

The `.cast` file can be:
- Played in any terminal via `asciinema play`
- Uploaded to asciinema.org for embeddable player
- Converted to GIF via [agg](https://github.com/asciinema/agg) for inline README use
- Converted to SVG via [svg-term-cli](https://github.com/marionebl/svg-term-cli)
