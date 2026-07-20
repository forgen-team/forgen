# Vector/Semantic Memory — Feasibility Verdict + Plan

> Probe: design-probe (team). Scope: OSS gap #3 (oss-comparison-2026-07-20.md §5 row 3) — semantic/vector
> memory to complement the TF-IDF/BM25/bigram ensemble. Hard constraint: local-only, $0, no GPU.
> All numbers below are measured on this machine (2026-07-20), not estimated.

## Verdict: **DEFER vectors. Do the Korean-morphology lexical fix instead.**

The corpus is **18 solutions**. At this scale (and even at the stated N≤200 ceiling the code is designed
around) embeddings cannot pay for their footprint, and the recall gap that *is* measurable is a Korean
verbal-morphology tokenization bug — a $0 lexical fix, not a semantic-similarity problem. Vectors would
add ~300MB of native runtime and a per-prompt cold-start that blows the injection-latency budget, in
direct conflict with forgen's local-only/$0/no-GPU principle, to solve a problem the corpus doesn't have yet.

---

## 1. Current-state recall audit

**Corpus size (the number that decides everything): 18 active solution `.md` files.**
- `~/.forgen/me/solutions/` = 5, `~/.forgen/packs/witems/solutions/` = 13. Heavily Korean titles/tags.

**match-eval-log.jsonl analysis** (2371 rows: 1662 hook, 709 mcp):
- Empty candidate set: **1429 rows (60.3%)**. Of all rows, 998 (42.1%) are empty *despite* a substantive
  query (rawQueryLen > 40).
- Non-empty (942 rows) top-relevance distribution: median 0.539, p25 0.146, p75 0.967. **28% of non-empty
  results have top relevance < 0.15** (barely-there matches).
- Korean-bearing queries: 1810, empty rate **54.6%**. English-only: 535, empty rate 77.2%.

**Honesty caveat — empty ≠ miss.** With only 18 possible targets, most prompts *genuinely* have no relevant
solution; a high empty rate is expected and is NOT proof of a recall gap. There is no labeled ground-truth
miss-set in the log (no field records "a relevant solution existed but ranked low"). So the 60% empty rate
**cannot** be attributed to lexical-vs-semantic recall. Vectors are not justified by this number.

**The one attributable gap I could prove** is not semantic — it's Korean verbal-ending stemming (§3).

## 2. Option probe (measured; nothing installed globally)

| Option | Size / infra cost | Verdict for forgen |
|---|---|---|
| **transformers.js** `@huggingface/transformers@4.2.0` | 9.5MB npm pkg, but backend **`onnxruntime-node` = 270MB unpacked** native binaries; + model download (all-MiniLM-L6-v2 ~23MB int8 / ~90MB fp32) at runtime | **Disqualified on footprint.** ~300MB native + model fetch violates local-only/$0/lightweight principle regardless of latency. Cold-start (native load + model init) is 100s of ms — fatal for a per-prompt hook (budget §3). |
| `@xenova/transformers@2.17.2` (wasm) | 46MB pkg (bundles wasm), slower CPU inference | Smaller than onnx path but still 46MB + model; wasm inference slower. Same conclusion. |
| **sqlite-vec@0.1.9** | 4KB npm metadata (loadable extension, per-platform binary fetched) | Index infra is cheap and fine — but it solves storage, not the embedding-cost problem. Irrelevant until embeddings are justified. |
| **hnswlib-node@3.0.0** | 196KB, native addon (needs node-gyp compile) | Same: index-only. Adds a compile step. Not the bottleneck. |
| **(c) Korean-aware lexical improvement** | $0, no dependency, in-budget | **This is the actual cheap win.** See §3. |
| (d) lazy/offline embeddings | defers cold-start off the hook path | Viable *architecture* if vectors were ever justified — but they aren't at N=18. Fold into the trigger plan (§4). |

## 3. The real gap: Korean verbal-morphology stemming (cheap, $0, in-budget)

The query-side tokenizer (`matchSolutions` → `extractTags` → `stripKoSuffix`, src/engine/solution-format.ts)
strips **particles and a few endings only** (`을/를/는/하는/한다/합니다`…). It deliberately does NOT strip
conversational **verbal conjugations**, and the code comment (solution-format.ts:475-476) already says these
belong in a *matching-only* `KO_VERBAL_SUFFIXES` list — but that list (term-matcher.ts:62) is
`['중','시']` and is wired only into **negative-attribution**, never into the query/injection path.

**Proven by simulation** (query-path stripping reproduced in Node):
```
검증해줘   → 검증해줘     (should → 검증  = validation family)
구현해보자 → 구현해보자   (should → 구현)
최적화하자 → 최적화하자   (should → 최적화 = performance family)
배포하면   → 배포하면     (should → 배포  = deploy family)
```
These never reach the `term-normalizer` canonical families, so a query like "이거 검증해줘" cannot pull the
`validation`/`검증` solution family even though the mapping exists. The log's 222 distinct long-Korean tokens
are dominated by exactly these conjugated forms. This is a lexical bug with a lexical fix.

*Bounded* expected gain: a subset of those 222 tokens map to real canonical roots (validation/deploy/
performance/refactor/test); the rest are conversational (`가족끼리`, `같은거지`) that map to nothing. I will
**not** claim a precise recall-% — there's no ground-truth set — but the fix is provably correct-direction,
zero-cost, and independently testable against `ROUND3_BASELINE` + bilingual spot-checks.

## 4. Injection-latency budget

Measured from `hook-timing.jsonl` (610 rows). The matcher runs inside **`solution-injector`** (UserPromptSubmit):
- **solution-injector: median 24ms, p95 33ms, max 55ms.** (context-guard p95 37ms, keyword-detector p95 30ms
  run in the same UserPromptSubmit turn.) session-recovery is the slow hook at 142ms median but is unrelated.

**Hard budget for any semantic layer: it must keep solution-injector p95 under ~50ms.** An embedding call
cannot: onnxruntime-node cold-start (native module load + model init) alone is 100s of ms on first prompt of
a session, and even warm single-thread CPU MiniLM inference (~15-40ms) + index search is borderline against a
24ms baseline. A per-prompt hook is the worst possible place for it. This alone rules out synchronous embeddings.

## 5. Recommended path

**Do now (cheap lexical win):** add matching-only Korean verbal-suffix stripping to the query path.
- Files: `src/engine/solution-format.ts` (extend a matching-only suffix pass — keep `stripKoSuffix`
  extraction-conservative to avoid breaking 한자어 nouns, per its own comment), reusing/growing the existing
  `KO_VERBAL_SUFFIXES` concept from `term-matcher.ts` as the single source of truth. Candidate suffixes:
  `해줘/해봐/해보자/해보면/하자/하면/해서/해야/했어/할까/하는게/하는거/한거` etc., applied only when the
  stripped stem ≥ 2 chars.
- Interface: query-time only (do not change index representation → no index rebuild, no `ROUND3_BASELINE`
  re-measure of the corpus side).
- Test: extend `tests/term-normalizer.test.ts` / matcher-eval bilingual spot-checks with the proven cases
  above; assert `ROUND3_BASELINE` (English) does not regress.
- Guard: none needed — pure-lexical, fail-safe (unknown tokens pass through unchanged). No feature flag,
  no model, no offline build.
- Risk: over-stripping a 한자어 noun into a false root → mitigated by the ≥2-char floor and keeping the
  aggressive list matching-only (never at extraction time).

**Defer vectors until BOTH triggers hold:**
1. **> 200 active solutions** (the N the code already treats as its ceiling), AND
2. a **labeled miss-set** shows > 15% of queries have a known-relevant solution ranked outside top-5
   *after* the Korean-stemming fix ships (i.e. a residual gap that is genuinely semantic, not morphological).

When triggered, the only footprint-compatible design is **offline/lazy embeddings**: build the vector index
via an explicit `forgen index build` command (off the hook path), store vectors in sqlite-vec, and at query
time do a lexical-first pass with an optional vector re-rank that is **skipped entirely when the model/index
is absent** (fallback = today's ensemble). Never embed synchronously inside UserPromptSubmit.

---

**One-line**: N=18 makes vectors premature and their 300MB/cold-start cost violates the $0/local principle;
the only proven recall gap is Korean verbal-morphology stemming — fix that lexically now, gate vectors behind
>200 solutions + a measured residual semantic-miss rate.
