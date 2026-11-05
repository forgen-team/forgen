. /m/lib.sh
nvm use 22 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1; forgen install codex >/dev/null 2>&1
S=~/.codex/forgen-hook; cat $S | cut -c1-200; md5sum ~/.codex/hooks.json
nvm use 24 >/dev/null; npm i -g /m/new.tgz 2>&1 | grep -i "shim"; echo "--- after 24"; cat $S | grep -i "node\|forgen" | cut -c1-200|head -5; md5sum ~/.codex/hooks.json
nvm uninstall 22 >/dev/null 2>&1; echo '{"hook_event_name":"UserPromptSubmit","prompt":"hi","session_id":"s","cwd":"/tmp"}' | env -i PATH=/usr/bin:/bin HOME=$HOME sh $S hooks/context-guard.js; echo "shim rc=$? (PATH 에 node 없음, 22삭제)"
echo '{}' | sh $S hooks/context-guard.js; echo "shim rc=$? (nvm24 PATH)"
