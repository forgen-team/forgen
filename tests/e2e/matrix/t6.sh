. /m/lib.sh
FROM=${FROM:-0.6.3}
nvm use 22 >/dev/null; mkdir -p ~/proj; cd ~/proj
npm i -g /m/wooojin-forgen-$FROM.tgz 2>&1 | grep -i "forgen\]" | head -5
echo "### $FROM 신규설치 postinstall 직후"; SNAPN=0 snap | grep -v "^---"; ls -la ~/.claude/plugins/cache/*/* 2>&1 | tail -3
echo "### $FROM forgen install claude"; forgen install claude 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -i "plugin\|hooks\|MCP\|error\|unknown" | head
python3 /m/probe.py "$FROM-installed"
echo "### settings snapshot($FROM)"; cp ~/.claude/settings.json /tmp/s.$FROM; cp ~/.claude.json /tmp/c.$FROM
echo "### upgrade -> 0.6.8 (같은 node)"; npm i -g /m/new.tgz 2>&1 | grep -i "forgen\]\|error" | head
python3 /m/probe.py "$FROM->0.6.8"
python3 - <<'P'
import json,os,glob
h=os.path.expanduser('~')
s=json.load(open(h+'/.claude/settings.json'));cmds=[x['command'] for v in s['hooks'].values() for g in v for x in g['hooks']]
import collections
print('hook cmds',len(cmds),'unique',len(set(cmds)),'dup',[c[-60:] for c,n in collections.Counter(cmds).items() if n>1])
print('plugin enabled',s.get('enabledPlugins'))
print(json.load(open(h+'/.claude/plugins/installed_plugins.json')))
print(json.load(open(h+'/.claude.json'))['mcpServers'])
P
ls -la ~/.claude/plugins/cache/*/*; ls ~/.claude/commands/forgen | wc -l
claude plugin list 2>&1 | sed -n 3,7p
