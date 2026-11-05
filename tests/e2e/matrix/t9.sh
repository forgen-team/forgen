. /m/lib.sh
nvm use 22 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1; forgen install claude >/dev/null 2>&1
mkdir -p ~/proj; cd ~/proj
CL=$(which claude)
nvm use 24 >/dev/null; python3 /m/hooks_live.py B-nvm24-switch
nvm use 20 >/dev/null; python3 /m/hooks_live.py C-nvm20
echo "-- D PATH 에 node 없음"; PATH=/usr/bin:/bin $CL --version 2>&1|head -1; PATH=/usr/bin:/bin python3 /m/hooks_live.py D-no-node-in-PATH
PATH=/usr/bin:/bin $CL mcp list 2>&1 | tail -2
nvm use 24 >/dev/null; nvm uninstall 22 >/dev/null 2>&1
python3 /m/hooks_live.py F-22-deleted
echo "-- F mcp"; claude mcp list 2>&1 | tail -3 | cut -c1-200
