#!/bin/bash
# forgen — First Block Demo
#
# Simulates the new-user experience: install → first block → retry → success.
# Uses the actual stop-guard hook binary (dist/hooks/stop-guard.js) to show
# real forgen behavior without requiring a live Claude Code session.
#
# Usage:
#   bash docs/demo/first-block-demo.sh
#   asciinema rec --command 'bash docs/demo/first-block-demo.sh' first-block.cast
#
# Prerequisites: npm run build (dist/ must exist)
# Expected duration: ~40 seconds at natural reading pace.

set -e
cd "$(dirname "$0")/../.."

# Sandbox HOME — does NOT touch the viewer's real ~/.forgen
SANDBOX=$(mktemp -d -t forgen-firstblock-XXX)
trap '/bin/rm -fr "$SANDBOX"' EXIT

# Colors + pauses for readability
c_dim="\033[2m"
c_reset="\033[0m"
c_green="\033[32m"
c_red="\033[31m"
c_blue="\033[36m"
c_yellow="\033[33m"
c_bold="\033[1m"
pause() { sleep "${1:-1.5}"; }

echo ""
echo -e "${c_blue}${c_bold}═══ forgen — Your First Block (demo) ═══${c_reset}"
echo ""
pause 1

# ── Step 1: Setup ──
echo -e "${c_yellow}Step 1: Install${c_reset}"
echo -e "${c_dim}  \$ npm install -g @wooojin/forgen${c_reset}"
echo -e "${c_dim}  \$ forgen install claude${c_reset}"
echo -e "${c_dim}  \$ forgen                    # onboarding: 4 questions${c_reset}"
echo ""
echo -e "  ${c_green}✓${c_reset} Hooks registered. Profile created."
pause 2

# ── Step 2: User asks Claude to refactor ──
echo ""
echo -e "${c_yellow}Step 2: You ask Claude to refactor${c_reset}"
pause 1
echo -e "  ${c_bold}You:${c_reset} Refactor the main entry point to use async/await."
echo -e "       When done, tell me your confidence level out of 100."
pause 2

# ── Step 3: Claude responds with unsupported score ──
echo ""
echo -e "${c_yellow}Step 3: Claude responds with a confidence score${c_reset}"
pause 1
echo -e "  ${c_bold}Claude:${c_reset} \"Refactoring complete. Confidence: ${c_bold}92/100${c_reset}.\""
echo -e "          ${c_dim}(no tests were run, no build was executed)${c_reset}"
pause 2

# ── Step 4: forgen blocks ──
echo ""
echo -e "${c_red}${c_bold}Step 4: forgen's stop-guard fires${c_reset}"
pause 1

# Run the actual stop-guard hook
export HOME="$SANDBOX"
export FORGEN_CWD="$PWD"
export FORGEN_SPIKE_RULES="$SANDBOX/no-spike.json"
echo '{"rules":[]}' > "$FORGEN_SPIKE_RULES"

MSG='{"session_id":"demo","hook_event_name":"Stop","stop_hook_active":true,"last_assistant_message":"Refactoring complete. I'\''ve updated the main entry point to use async/await patterns throughout. Confidence: 92/100."}'

RESULT=$(echo "$MSG" | node dist/hooks/stop-guard.js 2>/dev/null || echo '{"result":"error"}')
DECISION=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('decision','approve'))" 2>/dev/null || echo "approve")

if [ "$DECISION" = "block" ]; then
  REASON=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('reason','(no reason)')[:200])" 2>/dev/null || echo "(blocked)")
  echo -e "  ${c_red}✗ BLOCKED${c_reset}"
  echo ""
  echo -e "  ${c_dim}[forgen:stop-guard/builtin:self-score-inflation]${c_reset}"
  echo -e "  ${c_dim}${REASON}${c_reset}"
else
  echo -e "  ${c_green}✓ approved${c_reset} (stop-guard did not fire — hook may need 'stop_hook_active':true)"
fi
pause 3

# ── Step 5: Claude retries with evidence ──
echo ""
echo -e "${c_yellow}Step 5: Claude reads the block reason and retries${c_reset}"
pause 1
echo -e "  ${c_bold}Claude:${c_reset} \"I claimed 92/100 without evidence. Let me run the tests.\""
echo ""
echo -e "  ${c_dim}  \$ npm test${c_reset}"
echo -e "  ${c_dim}  47 passed / 0 failed${c_reset}"
echo ""
echo -e "  ${c_bold}Claude:${c_reset} \"All 47 tests pass. Refactoring complete.\""
pause 2

# ── Step 6: forgen approves ──
echo ""
echo -e "${c_green}Step 6: forgen approves (evidence present)${c_reset}"
echo -e "  ${c_green}✓ approved${c_reset}"
pause 1

echo ""
echo -e "${c_blue}${c_bold}═══ That's your first block. ═══${c_reset}"
echo -e "${c_dim}Zero extra API cost. Same session turn. Claude learned from the block.${c_reset}"
echo ""
echo -e "${c_dim}Next steps:${c_reset}"
echo -e "${c_dim}  forgen doctor --quick       # verify setup${c_reset}"
echo -e "${c_dim}  forgen compound --rule       # add custom rules${c_reset}"
echo -e "${c_dim}  forgen stats                 # see your accumulation${c_reset}"
echo ""
