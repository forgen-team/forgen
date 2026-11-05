. /m/lib.sh
nvm use 22 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1
cat > /tmp/seed.json <<'J'
{"model":"opus","permissions":{"allow":["Bash(ls:*)"]},
 "statusLine":{"type":"command","command":"bash ~/my-status.sh"},
 "enabledPlugins":{"oh-my-claudecode@omc":true,"claude-hud@claude-hud":true},
 "hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"/opt/omc/keyword-detector.sh"}]}],
          "Stop":[{"matcher":"","hooks":[{"type":"command","command":"echo user-stop"}]}]},
 "env":{"MY_VAR":"1"}}
J
seed(){ rm -rf ~/.claude ~/.claude.json ~/.forgen; mkdir -p ~/.claude/plugins; cp /tmp/seed.json ~/.claude/settings.json; echo '{"mcpServers":{"other":{"command":"echo"}},"userID":"u1"}' > ~/.claude.json; }
chk(){ python3 - "$1" <<'P'
import json,os,sys
s=json.load(open(os.path.expanduser('~/.claude/settings.json')));c=json.load(open(os.path.expanduser('~/.claude.json')))
def n(ev): return [x['command'][-50:] for g in s['hooks'].get(ev,[]) for x in g['hooks']]
fg=lambda cmds:[x for x in cmds if 'forgen' in x]
print(f"[{sys.argv[1]}] model={s.get('model')} perms={s.get('permissions')} env={s.get('env')} statusLine={s.get('statusLine',{}).get('command','')[:60]} plugins={list(s.get('enabledPlugins',{}))}")
print("   user hooks kept: omc-ups=", any('omc' in x for x in n('UserPromptSubmit')), " user-stop=", any('user-stop' in x for x in n('Stop')), " total forgen hooks=", sum(len(fg(n(e))) for e in s['hooks']), " mcp=",list(c.get('mcpServers',{})), "userID=",c.get('userID'))
P
}
seed; chmod 444 ~/.claude/settings.json
forgen install claude >/tmp/o 2>&1; echo "rc=$? bytes=$(wc -c </tmp/o)"; cat /tmp/o|head -5
python3 /m/probe.py after-ro-install | head -3; grep -c forgen ~/.claude/settings.json; ls ~/.claude/commands 2>&1|head -2
