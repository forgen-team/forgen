#!/bin/bash
# v0.4.6 — clean container e2e for both Claude + Codex hooks
set -uo pipefail

PASS=0; FAIL=0; WARN=0
pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  △ $1"; WARN=$((WARN + 1)); }

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  forgen v0.4.6 — CLEAN CONTAINER E2E (claude + codex)"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── Phase 0: 환경 ──
echo "[Phase 0: Environment]"
command -v claude >/dev/null && pass "claude CLI" || { fail "claude CLI missing"; exit 1; }
command -v codex >/dev/null && pass "codex CLI" || { fail "codex CLI missing"; exit 1; }
command -v forgen >/dev/null && pass "forgen CLI" || { fail "forgen CLI missing"; exit 1; }
[ -f ~/.claude.json ] && pass "Claude OAuth mounted" || { fail "Claude auth missing"; exit 1; }
[ -f ~/.codex/auth.json ] && pass "Codex auth mounted" || { fail "Codex auth missing"; exit 1; }

# ── Phase 1: forgen install both ──
echo ""
echo "[Phase 1: forgen install (separate codex + claude — wizard hangs on 'both')]"
forgen install codex 2>&1 | tail -3 | sed 's/^/    /'
forgen install claude 2>&1 | tail -3 | sed 's/^/    /'
[ -f ~/.codex/hooks.json ] && pass "~/.codex/hooks.json created" || warn "codex hooks.json absent"
[ -f ~/.claude/settings.json ] || [ -f ~/.claude.json ] && pass "Claude settings present" || warn "Claude settings absent"

# Detect forgen install path inside global node_modules
FORGEN_PKG=$(npm root -g)/@wooojin/forgen
[ -d "$FORGEN_PKG/dist/hooks" ] && pass "forgen dist/hooks installed" || { fail "forgen dist missing"; exit 1; }

# ── Phase 2: pre-snapshot ──
echo ""
echo "[Phase 2: Pre-snapshot of ~/.forgen/state]"
mkdir -p ~/.forgen/state
PRE_HOOK_TIMING=$(wc -l < ~/.forgen/state/hook-timing.jsonl 2>/dev/null || echo 0)
PRE_PROMPT_HIST=$(wc -l < ~/.forgen/state/prompt-history.jsonl 2>/dev/null || echo 0)
PRE_PERMS=$(ls ~/.forgen/state/permissions-*.jsonl 2>/dev/null | wc -l)
PRE_USAGE=$(wc -l < ~/.forgen/state/usage-telemetry.jsonl 2>/dev/null || echo 0)
echo "  hook-timing: $PRE_HOOK_TIMING lines"
echo "  prompt-history: $PRE_PROMPT_HIST lines"
echo "  permissions files: $PRE_PERMS"
echo "  usage-telemetry: $PRE_USAGE lines"

# ── Phase 3: Real claude exec ──
echo ""
echo "[Phase 3: Real claude exec]"
CLAUDE_PROMPT="Echo the string 'forgen-v046-claude-test' and exit"
echo "  Prompt: $CLAUDE_PROMPT"
echo "" | timeout 90 claude -p "$CLAUDE_PROMPT" --dangerously-skip-permissions 2>&1 | tail -3 | sed 's/^/    /'

POST1_HOOK_TIMING=$(wc -l < ~/.forgen/state/hook-timing.jsonl 2>/dev/null || echo 0)
POST1_PROMPT_HIST=$(wc -l < ~/.forgen/state/prompt-history.jsonl 2>/dev/null || echo 0)
POST1_PERMS=$(ls ~/.forgen/state/permissions-*.jsonl 2>/dev/null | wc -l)
POST1_USAGE=$(wc -l < ~/.forgen/state/usage-telemetry.jsonl 2>/dev/null || echo 0)

[ "$POST1_HOOK_TIMING" -gt "$PRE_HOOK_TIMING" ] && pass "claude: hook-timing grew (+$((POST1_HOOK_TIMING - PRE_HOOK_TIMING)))" || fail "claude: hook-timing unchanged"
[ "$POST1_PROMPT_HIST" -gt "$PRE_PROMPT_HIST" ] && pass "claude: prompt-history grew (+$((POST1_PROMPT_HIST - PRE_PROMPT_HIST)))" || fail "claude: prompt-history unchanged"
[ "$POST1_PERMS" -gt "$PRE_PERMS" ] && pass "claude: permissions file created" || warn "claude: no new permissions file"
[ "$POST1_USAGE" -gt "$PRE_USAGE" ] && pass "claude: usage-telemetry grew (+$((POST1_USAGE - PRE_USAGE)))" || fail "claude: usage-telemetry unchanged (PostToolUse hook 미발화?)"

# ── Phase 4: Real codex exec ──
echo ""
echo "[Phase 4: Real codex exec]"
CODEX_PROMPT="Echo the string 'forgen-v046-codex-test' and exit"
echo "  Prompt: $CODEX_PROMPT"
echo "" | timeout 90 codex exec --skip-git-repo-check "$CODEX_PROMPT" 2>&1 | tail -3 | sed 's/^/    /'

POST2_HOOK_TIMING=$(wc -l < ~/.forgen/state/hook-timing.jsonl 2>/dev/null || echo 0)
POST2_PROMPT_HIST=$(wc -l < ~/.forgen/state/prompt-history.jsonl 2>/dev/null || echo 0)
POST2_PERMS=$(ls ~/.forgen/state/permissions-*.jsonl 2>/dev/null | wc -l)
POST2_USAGE=$(wc -l < ~/.forgen/state/usage-telemetry.jsonl 2>/dev/null || echo 0)

[ "$POST2_HOOK_TIMING" -gt "$POST1_HOOK_TIMING" ] && pass "codex: hook-timing grew (+$((POST2_HOOK_TIMING - POST1_HOOK_TIMING)))" || fail "codex: hook-timing unchanged"
[ "$POST2_PROMPT_HIST" -gt "$POST1_PROMPT_HIST" ] && pass "codex: prompt-history grew (+$((POST2_PROMPT_HIST - POST1_PROMPT_HIST)))" || fail "codex: prompt-history unchanged"
[ "$POST2_PERMS" -gt "$POST1_PERMS" ] && pass "codex: permissions-<codex-id>.jsonl created (gap fix verified)" || warn "codex: no new permissions file (PreToolUse supplement 미작동?)"
[ "$POST2_USAGE" -gt "$POST1_USAGE" ] && pass "codex: usage-telemetry grew (+$((POST2_USAGE - POST1_USAGE)))" || fail "codex: usage-telemetry unchanged"

# ── Phase 5: pre-tool-use latency 회귀 검증 (#11) ──
echo ""
echo "[Phase 5: pre-tool-use latency (#11 INITIAL_WAIT_MS fix)]"
LATENCIES=$(tail -50 ~/.forgen/state/hook-timing.jsonl | jq -c 'select(.hook == "pre-tool-use") | .ms' 2>/dev/null)
if [ -z "$LATENCIES" ]; then
  warn "No pre-tool-use entries to measure"
else
  COUNT=$(echo "$LATENCIES" | wc -l)
  TIMEOUT_HITS=$(echo "$LATENCIES" | awk '$1 >= 1900' | wc -l)
  MAX=$(echo "$LATENCIES" | sort -n | tail -1)
  echo "  $COUNT entries, max=${MAX}ms, timeout hits (≥1900ms)=$TIMEOUT_HITS"
  if [ "$TIMEOUT_HITS" = "0" ]; then
    pass "pre-tool-use no 2003ms tail (#11 fix verified)"
  else
    fail "pre-tool-use $TIMEOUT_HITS/$COUNT entries hit timeout"
  fi
fi

# ── Phase 6: secret redaction in prompt-history ──
echo ""
echo "[Phase 6: prompt-history secret redaction]"
TEST_SESSION="docker-secret-test-$$"
echo "{\"prompt\":\"test ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789test\",\"session_id\":\"$TEST_SESSION\"}" | \
  node "$FORGEN_PKG/dist/hooks/context-guard.js" >/dev/null 2>&1 || true
LAST_ENTRY=$(tail -1 ~/.forgen/state/prompt-history.jsonl 2>/dev/null)
if echo "$LAST_ENTRY" | grep -q "REDACTED:GitHub Token"; then
  pass "GitHub Token redacted in prompt-history"
else
  fail "GitHub Token NOT redacted (entry: $(echo "$LAST_ENTRY" | head -c 100)...)"
fi

# ── Phase 7: rate-limit detector (synthetic) ──
echo ""
echo "[Phase 7: rate-limit detector (synthetic Stop event)]"
rm -f ~/.forgen/state/pending-resume.json
SYNTH_INPUT='{"stop_hook_type":"end_turn","session_id":"rate-test","error":"5-hour limit reached. Resets in 4h 12m"}'
echo "$SYNTH_INPUT" | node "$FORGEN_PKG/dist/hooks/context-guard.js" >/dev/null 2>&1 || true
if [ -f ~/.forgen/state/pending-resume.json ]; then
  REASON=$(jq -r '.reason' ~/.forgen/state/pending-resume.json)
  RESET=$(jq -r '.resetAt' ~/.forgen/state/pending-resume.json)
  if [ "$REASON" = "rate-limit" ] && [ "$RESET" != "null" ]; then
    pass "rate-limit marker created (reason=rate-limit, resetAt=$RESET)"
  else
    fail "marker malformed: reason=$REASON, resetAt=$RESET"
  fi
else
  fail "pending-resume.json not created from synthetic Stop"
fi

# ── 결과 ──
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed, $WARN warnings"
echo "═══════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  echo "  ❌ FAILURES DETECTED"
  exit 1
else
  echo "  ✅ ALL CRITICAL CHECKS PASSED"
  exit 0
fi
