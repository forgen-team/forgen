#!/bin/bash
# 10-round flakiness probe — independent containers, fresh state each run.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SUMMARY=/tmp/forgen-10x-summary.txt
> "$SUMMARY"

echo "Round,Pass,Fail,HookEntries,MaxPreToolMs,Anomaly" >> "$SUMMARY"

TOTAL_PASS=0
TOTAL_FAIL=0
FIRST_FAIL_ROUND=""

for i in $(seq 1 10); do
  echo ""
  echo "════════════ ROUND $i ════════════"
  CODEX_AUTH=$(mktemp -d /tmp/forgen-codex-r${i}-XXXX)
  cp ~/.codex/auth.json "$CODEX_AUTH/" 2>/dev/null
  cp ~/.codex/config.toml "$CODEX_AUTH/" 2>/dev/null
  STATE_DIR=$(mktemp -d /tmp/forgen-state-r${i}-XXXX)

  OUTPUT_FILE=/tmp/forgen-10x-round-${i}.log
  docker run --rm \
    -v "$CODEX_AUTH:/home/node/.codex" \
    -v "$STATE_DIR:/home/node/.forgen" \
    -v "$SCRIPT_DIR/codex-audit.sh:/workspace/codex-audit.sh:ro" \
    --entrypoint sh \
    forgen-v046-e2e -c 'bash /workspace/codex-audit.sh' > "$OUTPUT_FILE" 2>&1

  # Parse results
  PASS=$(grep -E "^\s+✓" "$OUTPUT_FILE" | wc -l | tr -d ' ')
  FAIL=$(grep -E "^\s+✗" "$OUTPUT_FILE" | wc -l | tr -d ' ')

  # Side-effect telemetry from STATE_DIR
  HOOK_ENTRIES=$(wc -l < "$STATE_DIR/state/hook-timing.jsonl" 2>/dev/null | tr -d ' ' || echo 0)
  MAX_PRE_MS=$(jq -c 'select(.hook == "pre-tool-use") | .ms' "$STATE_DIR/state/hook-timing.jsonl" 2>/dev/null | sort -n | tail -1 || echo "n/a")

  # Anomaly: any timeout, any rt=claude, any duplicate session count, etc.
  ANOMALY=""
  if [ "$FAIL" != "0" ]; then
    ANOMALY="${ANOMALY}fails:$FAIL;"
  fi
  TIMEOUTS=$(jq -c 'select(.ms >= 1900)' "$STATE_DIR/state/hook-timing.jsonl" 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  if [ "$TIMEOUTS" != "0" ]; then
    ANOMALY="${ANOMALY}timeouts:$TIMEOUTS;"
  fi
  CLAUDE_LEAK=$(jq -c 'select(.rt == "claude")' "$STATE_DIR/state/usage-telemetry.jsonl" 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  if [ "$CLAUDE_LEAK" != "0" ]; then
    ANOMALY="${ANOMALY}rt_leak:$CLAUDE_LEAK;"
  fi
  [ -z "$ANOMALY" ] && ANOMALY="none"

  echo "Round $i: pass=$PASS fail=$FAIL hook_entries=$HOOK_ENTRIES max_pre_ms=$MAX_PRE_MS anomaly=$ANOMALY"
  echo "$i,$PASS,$FAIL,$HOOK_ENTRIES,$MAX_PRE_MS,$ANOMALY" >> "$SUMMARY"

  TOTAL_PASS=$((TOTAL_PASS + PASS))
  TOTAL_FAIL=$((TOTAL_FAIL + FAIL))
  if [ "$FAIL" != "0" ] && [ -z "$FIRST_FAIL_ROUND" ]; then
    FIRST_FAIL_ROUND="$i"
  fi

  # Cleanup intermediates aggressively
  rm -rf "$CODEX_AUTH"
done

echo ""
echo "════════════ FINAL ════════════"
echo "Total pass: $TOTAL_PASS, total fail: $TOTAL_FAIL"
[ -n "$FIRST_FAIL_ROUND" ] && echo "First failure: round $FIRST_FAIL_ROUND"
echo ""
echo "Per-round summary:"
cat "$SUMMARY"
