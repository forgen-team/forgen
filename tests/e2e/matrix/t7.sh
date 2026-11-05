. /m/lib.sh
nvm use 24 >/dev/null; npm -v
npm i -g /m/new.tgz 2>&1 | cut -c1-250
echo "--- postinstall ran? settings:"; cat ~/.claude/settings.json 2>&1 | head -5; ls ~/.claude/skills 2>&1 | head -3; which forgen
