# 공용: 컨테이너 안에서 source. 사용: . /m/lib.sh
export NVM_DIR=/home/dev/.nvm; . $NVM_DIR/nvm.sh >/dev/null
snap(){ # 산출물 스냅샷
 echo "--- tree(~/.claude ~/.forgen ~/.claude.json ~/.codex)"
 find ~/.claude ~/.forgen ~/.codex -maxdepth 3 \( -type f -o -type l \) 2>/dev/null | grep -v -e '/plugins/cache/.*/.*/.*/' | sort | head -${SNAPN:-80}
 for f in ~/.claude/settings.json ~/.claude.json; do [ -f $f ] && python3 - $f <<'P'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception as e: print(sys.argv[1],'INVALID',e); sys.exit()
h=d.get('hooks',{}); print(sys.argv[1],'keys',list(d.keys()))
if h: print(' hooks events',{k:len(v) for k,v in h.items()}, 'cmds', sum(len(x.get('hooks',[])) for v in h.values() for x in v))
for k in ('enabledPlugins','statusLine','mcpServers','extraKnownMarketplaces'): 
  if k in d: print(' ',k,json.dumps(d[k])[:300])
P
 done
}
