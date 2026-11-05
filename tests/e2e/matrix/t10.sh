. /m/lib.sh
nvm use 22 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1; forgen install claude >/dev/null 2>&1
mkdir -p ~/proj; cd ~/proj
echo "-- D PATH 에 node 없음 (GUI 흉내)"; CLAUDE_BIN=/usr/local/bin/claude PATH=/usr/bin:/bin python3 /m/hooks_live.py D-no-node 2>&1 | cut -c1-300
echo "-- D mcp list"; PATH=/usr/bin:/bin /usr/local/bin/claude mcp list 2>&1 | cut -c1-250 | tail -4
nvm use 24 >/dev/null; nvm uninstall 22 >/dev/null 2>&1
echo "-- F mcp list full"; claude mcp list 2>&1 | cut -c1-250
