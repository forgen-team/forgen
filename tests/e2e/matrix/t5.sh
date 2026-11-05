. /m/lib.sh
nvm use 22 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1; forgen install claude >/dev/null 2>&1
mkdir -p ~/proj; cd ~/proj
echo "### doctor (정상 상태)"; forgen doctor 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-160 | head -40
nvm use 24 >/dev/null; nvm uninstall 22 >/dev/null 2>&1
echo "### F: 22 삭제 후 claude mcp list"; claude mcp list 2>&1 | tail -3
echo "### F: forgen 명령 자체"; which forgen; forgen doctor 2>&1 | head -3
echo "### F: claude 직접 세션 로드 시 (미로그인이라 hook 미기동) — settings hooks 존재"; 
