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
seed; forgen install claude >/dev/null 2>&1; mkdir -p ~/proj; cd ~/proj; echo MYCLAUDE > CLAUDE.md
echo "### 3. uninstall --force"; forgen uninstall --force 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -v "^$" | cut -c1-160 | tail -12
chk after-uninstall
echo "--- 잔재(Forgen 관련)"; find ~/.claude ~/.forgen ~/proj \( -type f -o -type l \) 2>/dev/null | grep -i -v "\.git/" | grep -i "forgen\|ch-\|rules\|backup\|cache\|installed_plugins\|claude.json" | grep -v "~/.forgen/me/solutions" | grep -v "/.forgen/me/" | head -25
ls ~/.forgen; grep -c forgen ~/.claude/settings.json; cat ~/proj/CLAUDE.md; cat ~/.claude/plugins/installed_plugins.json
echo "### 5. 읽기 전용 settings.json"; seed; chmod 444 ~/.claude/settings.json; chmod 555 ~/.claude; npm i -g /m/new.tgz 2>&1 | grep -i "forgen\]"; forgen install claude 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -v "^$" | head -10; chmod 755 ~/.claude; chmod 644 ~/.claude/settings.json
echo "### 6. HOME 읽기전용"; seed; chmod 555 ~; npm i -g /m/new.tgz 2>&1 | grep -i "forgen\]\|error" | head -3; forgen status 2>&1 | head -5; chmod 755 ~
