#!/bin/bash
# v0.4.6 — codex 다중 시나리오 audit. 새 bug 안 나올 때까지 반복.
set -uo pipefail

PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
header() { echo ""; echo "── $1 ──"; }

forgen install codex 2>&1 | tail -2 | sed 's/^/    /'

# ── 시나리오 1: 텍스트 응답만 ──
header "Scenario 1: text-only (no tool)"
echo "" | timeout 60 codex exec -s danger-full-access --skip-git-repo-check "Reply with the word 'pong'" 2>&1 | tail -3 | sed 's/^/    /'

# ── 시나리오 2: Bash 도구 ──
header "Scenario 2: Bash echo"
echo "" | timeout 60 codex exec -s danger-full-access --skip-git-repo-check "Run: echo audit-bash-1" 2>&1 | tail -3 | sed 's/^/    /'

# ── 시나리오 3: 파일 read ──
header "Scenario 3: file read"
echo "" | timeout 60 codex exec -s danger-full-access --skip-git-repo-check "Read /workspace/test-project/package.json and report its keys" 2>&1 | tail -3 | sed 's/^/    /'

# ── 시나리오 4: 멀티 Bash ──
header "Scenario 4: multi-Bash"
echo "" | timeout 60 codex exec -s danger-full-access --skip-git-repo-check "Run two commands: 'pwd' and 'ls /workspace'" 2>&1 | tail -3 | sed 's/^/    /'

# ── 검증 ──
echo ""
echo "═══════ INVARIANT CHECKS ═══════"

# Inv 1: hook-timing.jsonl exists + valid JSON
if [ -f ~/.forgen/state/hook-timing.jsonl ]; then
  TOTAL=$(wc -l < ~/.forgen/state/hook-timing.jsonl | tr -d ' ')
  # Use jq for proper validation instead of grep
  VALID=$(jq -c . ~/.forgen/state/hook-timing.jsonl 2>/dev/null | wc -l | tr -d ' ')
  if [ "$VALID" = "$TOTAL" ] && [ "$TOTAL" -gt 5 ]; then
    pass "hook-timing.jsonl: $TOTAL entries, all valid JSON"
  else
    fail "hook-timing.jsonl: $TOTAL entries, valid=$VALID"
  fi

  # Inv 1a: no timeout tail (#11 fix)
  TIMEOUTS=$(jq -c 'select(.ms >= 1900)' ~/.forgen/state/hook-timing.jsonl 2>/dev/null | wc -l)
  [ "$TIMEOUTS" = "0" ] && pass "no 2003ms timeout tail across $TOTAL entries (#11 verified)" || fail "$TIMEOUTS timeout entries (#11 broken)"

  # Inv 1b: pre-tool-use entries — should match Bash invocations (≥1 expected)
  PRE_COUNT=$(jq -c 'select(.hook == "pre-tool-use")' ~/.forgen/state/hook-timing.jsonl 2>/dev/null | wc -l)
  [ "$PRE_COUNT" -ge 2 ] && pass "pre-tool-use entries: $PRE_COUNT (≥2 expected from Bash scenarios)" || fail "pre-tool-use $PRE_COUNT (expected ≥2)"

  # Inv 1c: post-tool-use entries
  POST_COUNT=$(jq -c 'select(.hook == "post-tool-use")' ~/.forgen/state/hook-timing.jsonl 2>/dev/null | wc -l)
  [ "$POST_COUNT" -ge 2 ] && pass "post-tool-use entries: $POST_COUNT" || fail "post-tool-use $POST_COUNT"
else
  fail "hook-timing.jsonl missing entirely"
fi

# Inv 2: prompt-history.jsonl per scenario
if [ -f ~/.forgen/state/prompt-history.jsonl ]; then
  PROMPT_COUNT=$(wc -l < ~/.forgen/state/prompt-history.jsonl)
  [ "$PROMPT_COUNT" -ge 4 ] && pass "prompt-history: $PROMPT_COUNT entries (≥4 expected)" || fail "prompt-history $PROMPT_COUNT (expected ≥4)"

  # Schema check
  SCHEMA_BAD=$(jq -c 'select(.timestamp == null or .sessionId == null or .prompt == null)' ~/.forgen/state/prompt-history.jsonl 2>/dev/null | wc -l)
  [ "$SCHEMA_BAD" = "0" ] && pass "prompt-history schema valid (timestamp/sessionId/prompt all present)" || fail "$SCHEMA_BAD entries with missing fields"
else
  fail "prompt-history.jsonl missing"
fi

# Inv 3: usage-telemetry rt field correctness
if [ -f ~/.forgen/state/usage-telemetry.jsonl ]; then
  USAGE_COUNT=$(wc -l < ~/.forgen/state/usage-telemetry.jsonl)
  CLAUDE_RT=$(jq -c 'select(.rt == "claude")' ~/.forgen/state/usage-telemetry.jsonl 2>/dev/null | wc -l)
  CODEX_RT=$(jq -c 'select(.rt == "codex")' ~/.forgen/state/usage-telemetry.jsonl 2>/dev/null | wc -l)
  echo "  usage-telemetry: $USAGE_COUNT total, claude=$CLAUDE_RT, codex=$CODEX_RT"
  [ "$CLAUDE_RT" = "0" ] && pass "all usage entries rt=codex (no leak from claude default)" || fail "$CLAUDE_RT usage entries with rt=claude in pure codex run (#17 broken)"
  [ "$CODEX_RT" -ge 2 ] && pass "codex usage count ≥2" || fail "codex usage count $CODEX_RT (expected ≥2)"
else
  fail "usage-telemetry.jsonl missing"
fi

# Inv 4: permissions-<codex-id>.jsonl per session (only tool-using sessions get a file).
# Scenario 1 은 텍스트 응답만 → 권한 파일 미생성이 정상. Scenarios 2-4 (도구 사용) 만 카운트.
PERMS_FILES=$(ls ~/.forgen/state/permissions-*.jsonl 2>/dev/null | wc -l | tr -d ' ')
[ "$PERMS_FILES" -ge 3 ] && pass "permissions files: $PERMS_FILES (≥3 tool-using sessions)" || fail "permissions files $PERMS_FILES (expected ≥3 from 3 tool scenarios)"

# Schema check across all permissions files
ALL_PERMS_VALID=true
for f in ~/.forgen/state/permissions-*.jsonl; do
  BAD=$(jq -c 'select(.tool == null or .decision == null or .source == null)' "$f" 2>/dev/null | wc -l)
  [ "$BAD" = "0" ] || ALL_PERMS_VALID=false
done
$ALL_PERMS_VALID && pass "all permissions entries schema valid" || fail "some permissions entries missing fields"

# Inv 5: source field consistency
SUPPLEMENT_COUNT=$(cat ~/.forgen/state/permissions-*.jsonl 2>/dev/null | jq -c 'select(.source == "pre-tool-use")' | wc -l)
[ "$SUPPLEMENT_COUNT" -ge 2 ] && pass "source:'pre-tool-use' supplement entries: $SUPPLEMENT_COUNT (≥2)" || fail "supplement count $SUPPLEMENT_COUNT (#9 broken)"

# Inv 6: rate-limit detector synthetic
header "Rate-limit synthetic check"
rm -f ~/.forgen/state/pending-resume.json
SYNTH='{"stop_hook_type":"end_turn","session_id":"audit-rl","error":"weekly limit reached. Reset on 2026-05-21T00:00:00Z"}'
HOOK="$(npm root -g)/@wooojin/forgen/dist/hooks/context-guard.js"
echo "$SYNTH" | node "$HOOK" >/dev/null 2>&1
if [ -f ~/.forgen/state/pending-resume.json ]; then
  RESET=$(jq -r '.resetAt' ~/.forgen/state/pending-resume.json)
  REASON=$(jq -r '.reason' ~/.forgen/state/pending-resume.json)
  RUNTIME=$(jq -r '.runtime' ~/.forgen/state/pending-resume.json)
  if [ "$REASON" = "rate-limit" ] && [ "$RESET" = "2026-05-21T00:00:00.000Z" ]; then
    pass "rate-limit marker: reason=$REASON, resetAt=$RESET, runtime=$RUNTIME"
  else
    fail "marker malformed: reason=$REASON, resetAt=$RESET, runtime=$RUNTIME"
  fi
  rm -f ~/.forgen/state/pending-resume.json
else
  fail "rate-limit marker not created"
fi

# Inv 7: secret redaction (real prompt content scan)
header "Secret leak scan (full prompt-history)"
LEAK=$(grep -E "ghp_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9]{20,}" ~/.forgen/state/prompt-history.jsonl 2>/dev/null || true)
if [ -z "$LEAK" ]; then
  pass "no secret patterns in prompt-history (after redaction)"
else
  fail "SECRET LEAK: $LEAK"
fi

echo ""
echo "═══════ RESULT ═══════"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] && exit 0 || exit 1
