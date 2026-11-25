. /m/lib.sh
# G6 (0.8.0): 깨끗한 컨테이너에서 0.7.2 → 0.8.0 → 0.7.2 → 0.8.0. 실데이터 복사본(/data, 읽기 전용)으로.
nvm use 22 >/dev/null
act(){ forgen rule list --json 2>/dev/null | jq '[.rules[]|select(.status=="active")]|length'; }
blk(){ echo "{\"session_id\":\"$1\",\"cwd\":\"$2\",\"source\":\"startup\",\"hook_event_name\":\"SessionStart\"}" | node "$(npm root -g)/@wooojin/forgen/dist/hooks/session-recovery.js" 2>/dev/null | jq -r '.hookSpecificOutput.additionalContext // ""'; }
echo "### 1. 0.7.2 설치 + 실데이터 복사"
npm i -g @wooojin/forgen@0.7.2 >/dev/null 2>&1; forgen --version; forgen install claude >/dev/null 2>&1
mkdir -p ~/.forgen && cp -a /data/me ~/.forgen/ && cp /data/config.json ~/.forgen/ 2>/dev/null
echo "active=$(act)"; python3 /m/hooks_live.py v072 2>&1 | cut -c1-200
B=$(blk g6a "$HOME"); echo "0.7.2 home block chars=${#B} project-index=$(echo "$B" | grep -c '## Project Rules')"
echo "### 2. 0.8.0 으로 업그레이드"
npm i -g /m/new.tgz >/dev/null 2>&1; forgen --version
echo "active=$(act)"; python3 /m/hooks_live.py v080 2>&1 | cut -c1-200
B=$(blk g6b "$HOME"); echo "0.8.0 home block chars=${#B} project-index=$(echo "$B" | grep -c '## Project Rules') omitted=$(echo "$B" | grep -o '[0-9]* lower-priority rules' )"
forgen doctor 2>&1 | grep -E "✗|프로젝트 키" | head -5; echo "doctor rc=${PIPESTATUS[0]}"
forgen rule classify-projects --from-sessions --no-llm 2>&1 | head -2
forgen compound relabel 2>&1 | sed -n 2p
echo "--- 새 필드가 든 데이터 만들기"
mkdir -p ~/ws/notes ~/ws/repo-x/.git
forgen project add prodx ~/ws/repo-x ~/ws/notes --alias repo-x 2>&1 | tail -1
forgen compound --solution g6-new-solution "격리 컨테이너에서 업그레이드와 되돌리기를 실제로 돌려 본 뒤에만 배포한다. 이유는 실데이터 손상을 막기 위해서다." --source auto --session g6s1 --quote-kind user --quote "업그레이드 되돌리기 실제로 돌려" >/dev/null 2>&1
SOL=~/.forgen/me/solutions/g6-new-solution.md; grep -cE "statusSince|evidenceSessions|grounding" $SOL
R=$(ls ~/.forgen/me/rules/*.json | head -1); RID=$(jq -r .rule_id $R); jq '.scope_state="unresolved" | del(.projects)' $R > /tmp/r.json && cp /tmp/r.json $R
echo "### 3. 0.7.2 로 되돌리기"
npm i -g @wooojin/forgen@0.7.2 >/dev/null 2>&1; forgen --version
echo "active=$(act)"; python3 /m/hooks_live.py v072-back 2>&1 | cut -c1-200
forgen rule suppress ${RID:0:8} >/dev/null 2>&1; forgen rule activate ${RID:0:8} >/dev/null 2>&1
echo "0.7.2 re-save keeps scope_state: $(jq -r '.scope_state // "LOST"' $R)"
forgen compound --lifecycle --apply >/dev/null 2>&1; echo "0.7.2 lifecycle keeps new solution fields: $(grep -cE 'statusSince|evidenceSessions|grounding' $SOL)"
echo "### 4. 다시 0.8.0"
npm i -g /m/new.tgz >/dev/null 2>&1; forgen --version; echo "active=$(act)"; python3 /m/hooks_live.py v080-again 2>&1 | cut -c1-200
forgen compound review 2>&1 | head -2
