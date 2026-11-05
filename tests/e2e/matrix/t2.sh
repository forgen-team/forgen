. /m/lib.sh
nvm use 22 >/dev/null; npm i -g /m/new.tgz 2>&1 | grep -v "^$" | cut -c1-200
echo "=== forgen install claude"; SNAPN=0 ; forgen install claude 2>&1 | cut -c1-220 | head -40
echo "=== after install"; SNAPN=200 snap | grep -v "/skills/forgen-\|me/solutions"
echo "=== plugin cache"; find ~/.claude/plugins -maxdepth 5 | head -20; ls -la ~/.claude/plugins/cache/*/* 2>/dev/null|head
echo "=== commands/agents"; ls ~/.claude/commands ~/.claude/agents 2>&1 | head
echo "=== claude plugin list"; claude plugin list 2>&1 | head -10
echo "=== claude mcp list"; timeout 60 claude mcp list 2>&1 | head -10
