. /m/lib.sh
nvm use 22 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1; forgen install claude >/dev/null 2>&1
find ~ -type f -not -path '*/.nvm/*' -not -path '*/.npm/*' | sort > /tmp/before.txt; cp ~/.claude/settings.json /tmp/s.before
mkdir -p ~/proj && cd ~/proj && git init -q .
echo "=== forgen -p hi (미로그인 claude)"; timeout 60 forgen -p "say hi" 2>&1 | cut -c1-200 | head -20; echo "rc=$?"
find ~ -type f -not -path '*/.nvm/*' -not -path '*/.npm/*' | sort > /tmp/after.txt
echo "=== new files"; diff /tmp/before.txt /tmp/after.txt | grep '^>' | grep -v "/skills/forgen-\|me/solutions" | head -60
echo "=== settings diff"; diff <(python3 -m json.tool /tmp/s.before) <(python3 -m json.tool ~/.claude/settings.json) | head -30
echo "=== proj"; ls -la ~/proj
