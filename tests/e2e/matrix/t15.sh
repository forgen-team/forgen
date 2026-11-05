. /m/lib.sh
nvm use 22 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1; forgen install claude >/dev/null 2>&1
echo "### a. 경로에 공백·한글 (cwd)"; D="$HOME/내 프로젝트 공백/앱"; mkdir -p "$D"; cd "$D"; git init -q .
python3 /m/hooks_live.py a-space-korean-cwd
forgen -p hi 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -v "^$\|█" | head -4; ls "$D/.claude" 2>&1
echo "### e. 동시 5세션 (같은 cwd) wrapper"; mkdir -p ~/conc; cd ~/conc; git init -q .
cp ~/.claude/settings.json /tmp/s.pre
for i in 1 2 3 4 5; do (forgen -p "hi$i" >/tmp/w$i.log 2>&1 &) ; done; sleep 20
python3 -c "import json,os;s=json.load(open(os.path.expanduser('~/.claude/settings.json')));print('settings valid; env=',s.get('env'),'hooks',sum(len(g['hooks']) for v in s['hooks'].values() for g in v))"
ls ~/.claude/settings.json* ; grep -l "Starting Claude" /tmp/w*.log | wc -l; grep -h -i "error\|EEXIST\|parse\|lock" /tmp/w*.log | head -5
echo "### env 잔존(wrapper 종료 후 claude 직접 실행이 harness 모드로 오인?)"; python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/settings.json'))).get('env'))"
