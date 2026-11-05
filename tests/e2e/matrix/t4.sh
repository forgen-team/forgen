. /m/lib.sh
P=/usr/bin:/bin
nvm use 22 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1; forgen install claude >/dev/null 2>&1
mkdir -p ~/proj; cd ~/proj
V22=$NVM_DIR/versions/node/v22.23.4/bin
echo "### A 설치 직후(nvm22 활성)"; python3 /m/probe.py A-nvm22
echo "### B nvm24 로 전환(재설치 없음, 22 유지)"; nvm use 24 >/dev/null; python3 /m/probe.py B-nvm24-no-reinstall; claude mcp list 2>&1 | tail -2
echo "### C nvm20(엔진 미달)로 전환"; nvm use 20 >/dev/null; python3 /m/probe.py C-nvm20; claude mcp list 2>&1 | tail -2
echo "### D PATH 에 node 없음(GUI)"; python3 /m/probe.py D-nonode /usr/bin:/bin
echo "### E 시스템 node(/usr/local/bin)만 PATH"; python3 /m/probe.py E-system /usr/local/bin:/usr/bin:/bin
echo "### F nvm22 삭제 후(24 활성)"; nvm use 24 >/dev/null; nvm uninstall 22 >/dev/null 2>&1; ls $NVM_DIR/versions/node; python3 /m/probe.py F-22deleted-nvm24; claude mcp list 2>&1 | tail -2
echo "### F2 같은 상태, statusline 출력"; sh -c "$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/settings.json')))['statusLine']['command'])")" </dev/null 2>&1 | head -3
echo "### G nvm24 에서 재설치(npm i -g)"; npm i -g /m/new.tgz 2>&1 | tail -3; python3 /m/probe.py G-reinstall-24; claude mcp list 2>&1 | tail -2
python3 - <<'P'
import json,os;s=json.load(open(os.path.expanduser('~/.claude/settings.json')));print('hook sample',s['hooks']['Stop'][0]['hooks'][0]['command'][:200]); print(json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers'])
P
