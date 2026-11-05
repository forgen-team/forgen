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
seed; echo "### 1. 기존 설정(타 hook·statusLine·OMC 흉내) + install"; forgen install claude >/dev/null 2>&1; chk after-install
echo "### 2. 2회째 install(멱등)"; forgen install claude >/dev/null 2>&1; chk after-2nd-install
echo "### 2b. 같은 npm i -g 재실행(postinstall)"; npm i -g /m/new.tgz >/dev/null 2>&1; chk after-npm-reinstall
echo "### 3. uninstall"; ls ~/.claude/settings.json.* 2>/dev/null|head; 
mkdir -p ~/proj; cd ~/proj; yes | forgen uninstall 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-160 | head -25
chk after-uninstall
echo "--- 잔재"; find ~/.claude ~/.forgen ~/.claude.json ~/proj -newer /tmp/seed.json \( -type f -o -type l \) 2>/dev/null | grep -v node_modules | head -30; ls ~/.claude/plugins ~/.claude/plugins/cache 2>&1|head; ls ~/.forgen | head
echo "### 4. 잘못된 JSON"; seed; echo '{"hooks": {oops' > ~/.claude/settings.json; npm i -g /m/new.tgz 2>&1 | grep -i "forgen\]"; forgen install claude 2>&1 | sed 's/\x1b\[[0-9;]*m//g'| head -12; cat ~/.claude/settings.json | head -3; ls ~/.claude/
