#!/bin/bash
# forgen v0.4.0 Mech-B demo — hook-level simulation of "block → evidence → approve".
#
# This script simulates what happens inside a real Claude Code session when
# forgen's Stop hook fires. It doesn't require a live Claude session — we
# feed fake "Stop hook input" JSON directly to the compiled hook script and
# show the actual hook response.
#
# Usage:
#   bash docs/demo/mech-b-demo.sh         # runs live, prints to terminal
#   asciinema rec --command 'bash docs/demo/mech-b-demo.sh' demo.cast
#
# Expected duration: ~25 seconds at natural reading pace.

set -e
cd "$(dirname "$0")/../.."

# Sandbox HOME so this demo doesn't touch the viewer's real ~/.forgen
SANDBOX=$(mktemp -d -t forgen-demo-XXX)
trap '/bin/rm -fr "$SANDBOX"' EXIT

# Nice-to-have: color + pauses so a human can read along.
c_dim="\033[2m"
c_reset="\033[0m"
c_green="\033[32m"
c_red="\033[31m"
c_blue="\033[36m"
pause() { sleep "${1:-1.5}"; }

# -------------------------------------------------------------------------
echo ""
echo -e "${c_blue}═══ forgen v0.4.0 — The Trust Layer in action ═══${c_reset}"
echo ""
pause 1

echo -e "${c_dim}# This is an L1 rule forgen ships as dogfood:${c_reset}"
pause 0.5
cat .forgen/rules/L1-e2e-before-done.json | python3 -m json.tool | head -14
pause 2.5

echo ""
echo -e "${c_dim}# It says: 'no \"done\" claim without fresh Docker e2e evidence'.${c_reset}"
echo ""
pause 1.5

# -------------------------------------------------------------------------
echo -e "${c_blue}Turn 1 — Claude just said \"구현 완료했습니다.\" ${c_reset}"
echo -e "${c_dim}# forgen's Stop hook reads Claude's last message:${c_reset}"
pause 1.5

export HOME="$SANDBOX"
export FORGEN_CWD="$PWD"
export FORGEN_SPIKE_RULES="$SANDBOX/no-spike.json"
echo '{"rules":[]}' > "$FORGEN_SPIKE_RULES"

MSG='{"session_id":"demo","hook_event_name":"Stop","stop_hook_active":true,"last_assistant_message":"구현 완료했습니다."}'

echo -e "${c_dim}\$ echo '<Stop hook input>' | node dist/hooks/stop-guard.js${c_reset}"
pause 1

RESPONSE=$(echo "$MSG" | node dist/hooks/stop-guard.js)
printf '%s\n' "$RESPONSE" | python3 -m json.tool
pause 3

echo ""
echo -e "${c_dim}# decision=block. Claude sees this 'reason' as input on the next turn.${c_reset}"
echo -e "${c_dim}# Same session, same prompt budget — zero extra API calls.${c_reset}"
echo ""
pause 2

# -------------------------------------------------------------------------
echo -e "${c_blue}Turn 2 — Claude (in real Claude Code) would retract and run e2e:${c_reset}"
pause 1.5

echo -e "${c_dim}\$ bash tests/e2e/docker/run-test.sh  # 63 checks, real Docker suite${c_reset}"
pause 1

# Simulate — we don't actually run Docker here (takes minutes). We just write
# the evidence file the rule expects.
mkdir -p "$SANDBOX/.forgen/state"
cat > "$SANDBOX/.forgen/state/e2e-result.json" <<EVIDENCE
{
  "passed": true,
  "total": 63,
  "failed": 0,
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EVIDENCE

echo -e "${c_green}  Results: 63 passed, 0 failed, 6 warnings${c_reset}"
echo -e "${c_green}  ✅ ALL CHECKS PASSED${c_reset}"
pause 2

# -------------------------------------------------------------------------
echo ""
echo -e "${c_blue}Turn 3 — Claude re-submits \"구현 완료했습니다.\":${c_reset}"
pause 1

RESPONSE2=$(echo "$MSG" | node dist/hooks/stop-guard.js)
printf '%s\n' "$RESPONSE2"
pause 2

echo ""
echo -e "${c_dim}# Evidence is fresh → rule passes → Claude proceeds. User trust preserved.${c_reset}"
echo ""
pause 2

# -------------------------------------------------------------------------
echo -e "${c_blue}Audit trail: forgen last-block${c_reset}"
pause 0.8

FORGEN_DISABLE_PROJECT_RULES=1 node dist/cli.js last-block 2>/dev/null | tail -10
pause 3

echo ""
echo -e "${c_dim}# That's it. Rule, block, evidence, unblock, audit — at \$0 extra API.${c_reset}"
echo ""
