. /m/lib.sh
nvm use 22 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1; forgen install claude >/dev/null 2>&1
echo "### HOME 비표준(공백·한글) — 설치 → hook 실제 기동"
export HOME="/tmp/내 홈 dir"; mkdir -p "$HOME"; forgen install claude 2>&1 | grep -c "Install completed"
mkdir -p "$HOME/p"; cd "$HOME/p"; python3 /m/hooks_live.py home-space-korean; claude mcp list 2>&1 | tail -2 | cut -c1-200
echo "### tmux 안에서 wrapper"; export HOME=/home/dev; mkdir -p ~/tm; cd ~/tm; git init -q .
tmux new-session -d -s t "forgen -p hi > /tmp/tm.out 2>&1; echo done >> /tmp/tm.out"; sleep 12; sed 's/\x1b\[[0-9;]*m//g' /tmp/tm.out | grep -v "^$\|█" | head -5; tmux list-keys 2>/dev/null | grep -ci forgen
echo "### 공존: stdout 이 JSON 아닌 타 플러그인 hook + JSON additionalContext hook"
python3 - <<'P'
import json,os
p=os.path.expanduser('~/.claude/settings.json');s=json.load(open(p))
s['hooks']['UserPromptSubmit'].insert(0,{"hooks":[{"type":"command","command":"echo 'plain text from other plugin'"}]})
s['hooks']['UserPromptSubmit'].insert(0,{"hooks":[{"type":"command","command":"echo '{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"OTHER-CTX\"}}'"}]})
s['hooks']['SessionStart'].insert(0,{"hooks":[{"type":"command","command":"echo '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"OTHER-SS\"}}'"}]})
json.dump(s,open(p,'w'))
P
cd ~/tm; python3 /m/hooks_live.py coexist
