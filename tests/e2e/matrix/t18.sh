. /m/lib.sh
nvm use 22 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1
forgen install codex 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -v "^$" | cut -c1-200 | head -14
ls ~/.codex ~/.codex/hooks 2>&1 | head -20
H=~/.codex/hooks.json; md5sum $H 2>/dev/null; cat ~/.forgen/bin/* 2>/dev/null | head -5; find ~/.codex -name "*shim*" | head
sha1sum $(find ~/.codex -name "*shim*" | head -1) 2>/dev/null
python3 -c "
import json;d=json.load(open('$HOME/.codex/hooks.json'));print(sorted({h['command'][:90] for v in d['hooks'].values() for g in v for h in g['hooks']})[:2], sum(len(g['hooks']) for v in d['hooks'].values() for g in v))" 2>&1|cut -c1-300
S=$(find ~/.codex -name "*shim*" | head -1); echo "-- node 22 삭제 + 24 로 전환 후 npm i -g (nvm 전환 재설치)"; nvm use 24 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1; md5sum $H; sha1sum $S; grep -o "v2[0-9.]*" $S | sort -u
forgen install codex >/dev/null 2>&1; forgen install codex 2>&1|tail -1; md5sum $H
