. /m/lib.sh
FAILS=0
ok(){ if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; FAILS=$((FAILS+1)); fi; }
# G6 (0.9.0 압축·두 층): 깨끗한 컨테이너에서 공개본(OLD, 기본 0.8.3) → 0.9.0(/m/new.tgz) → OLD → 0.9.0.
# 새 파일·필드(state/tier2-index.json, tier2-session-*, work-context 의 tier2_injected·tier2_turn, 세션별 렌더 기록의 tier2 사건,
# 룰의 applies_when)를 옛 버전이 읽어도 세션 시작·프롬프트·도구 훅이 정상이고, 옛 버전이 룰을 다시 써도 새 필드가 남는지.
# 실데이터 복사본(/data, 읽기 전용)으로.
OLD=${OLD:-0.8.3}
nvm use 22 >/dev/null
act(){ forgen rule list --json 2>/dev/null | jq '[.rules[]|select(.status=="active")]|length'; }
hk(){ node "$(npm root -g)/@wooojin/forgen/dist/hooks/$1.js" 2>/dev/null; }
blk(){ echo "{\"session_id\":\"$1\",\"cwd\":\"$2\",\"source\":\"startup\",\"hook_event_name\":\"SessionStart\"}" | hk session-recovery | jq -r '.hookSpecificOutput.additionalContext // ""'; }
prm(){ echo "{\"session_id\":\"$1\",\"cwd\":\"$2\",\"prompt\":\"$3\",\"hook_event_name\":\"UserPromptSubmit\"}" | hk context-guard | jq -r '.continue'; }
pre(){ echo "{\"session_id\":\"$1\",\"cwd\":\"$2\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"$3\"},\"hook_event_name\":\"PreToolUse\"}" | hk pre-tool-use | jq -c '{c:.continue,e:(.hookSpecificOutput.hookEventName // ""),ctx:((.hookSpecificOutput.additionalContext // "")|length)}'; }
echo "### 1. $OLD 설치 + 실데이터 복사"
npm i -g @wooojin/forgen@$OLD >/dev/null 2>&1; forgen --version; forgen install claude >/dev/null 2>&1
mkdir -p ~/.forgen && cp -a /data/me ~/.forgen/ && cp /data/config.json ~/.forgen/ 2>/dev/null
A0=$(act); echo "active=$A0"
B=$(blk g6a "$HOME"); echo "$OLD block chars=${#B}"
echo "### 2. 0.9.0 으로 업그레이드"
has_tiers(){ [ -f "$(npm root -g)/@wooojin/forgen/dist/core/tier2.js" ]; }
npm i -g /m/new.tgz >/dev/null 2>&1; forgen --version; ok "upgrade-installed-new-build" 'has_tiers'
ok "upgrade-keeps-active" '[ "$(act)" = "$A0" ]'
B1=$(blk g6b "$HOME"); echo "0.9.0 block chars=${#B1}"
ok "compact-block-smaller" '[ ${#B1} -lt ${#B} ]'
ok "compact-no-category-prefix" '[ "$(echo "$B1" | grep -c "\[workflow|default")" = 0 ]'
# 두 층 색인: 활성 룰 하나를 자격 통과로 적는다(대화 기록이 없는 컨테이너라 재생 대신 직접) + applies_when 선택 필드
# 0.9.0 안전 룰(enforce_via·Must Not·파괴/비밀 패턴)은 어떤 경로로도 2층에 가지 않으므로, 실데이터 룰을 고르지 않고
# 안전 룰이 아닌 합성 룰을 하나 만든다(기존 룰 하나를 틀로 복사해 강제·범위 필드를 지움).
T=$(ls ~/.forgen/me/rules/*.json | head -1); RID=00000000-0000-4000-8000-00000000g6t2; RID=${RID/g6t2/0623}; R=~/.forgen/me/rules/$RID.json
jq --arg id "$RID" 'del(.enforce_via,.enforce_mode,.projects,.scope_state,.host_copy,.applies_when) | .rule_id=$id | .render_key="g6.tier2.zzq" | .status="active" | .scope="me" | .strength="default" | .source="onboarding" | .category="workflow" | .trigger="zzqtool 배포" | .policy="zzqtool 로 내보낼 때는 카나리 단계부터 확인하고 넘어간다" | .evidence_refs=[] | .created_at="2026-01-01T00:00:00.000Z" | .updated_at="2026-01-01T00:00:00.000Z" | .applies_when={commands:["zzqtool deploy"],words:["zzqtool","deploy","canary"]}' $T > /tmp/r.json && cp /tmp/r.json $R; echo "rule $RID"
A0=$(act)
mkdir -p ~/.forgen/state
jq -n --arg id "$RID" '{version:1,generatedAt:"2026-11-26T00:00:00Z",params:{k:3,turns:3,minFireRate:0.8,maxFreq:0.05},rules:{($id):{qualified:true,reason:"fired",words:["zzqtool","deploy","canary"],topics:["zzqtool"],contexts:1,fired:1}},recur:{}}' > ~/.forgen/state/tier2-index.json
B2=$(blk g6c "$HOME"); ok "tier2-index-line" '[ "$(echo "$B2" | grep -c "## Situational Rules")" = 1 ]'
ok "tier2-session-file" '[ -f ~/.forgen/state/tier2-session-g6c.json ]'
P=$(pre g6c "$HOME" "zzqtool deploy --canary"); echo "pre $P"; ok "tier2-pretool-inject" '[ "$(echo $P | jq -r .e)" = "PreToolUse" ] && [ "$(echo $P | jq .ctx)" -gt 0 ]'
ok "work-context-new-fields" '[ "$(jq -r ".tier2_injected[0]" ~/.forgen/state/work-context-g6c.json)" = "$RID" ]'
ok "render-log-tier2-event" '[ "$(grep -c "\"event\":\"tier2\"" ~/.forgen/state/metrics/session-renders.jsonl)" -ge 1 ]'
echo "### 3. $OLD 로 되돌리기"
npm i -g @wooojin/forgen@$OLD >/dev/null 2>&1; forgen --version; ok "downgrade-installed-old" '! has_tiers'
ok "downgrade-keeps-active" '[ "$(act)" -ge "$A0" ]'
B3=$(blk g6c "$HOME"); ok "old-session-start-ok" '[ ${#B3} -gt 100 ]'
ok "old-block-no-index-line" '[ "$(echo "$B3" | grep -c "Situational Rules")" = 0 ]'
ok "old-prompt-ok" '[ "$(prm g6c "$HOME" "zzqtool deploy canary please")" = "true" ]'
P3=$(pre g6c "$HOME" "zzqtool deploy --canary"); ok "old-pretool-ok" '[ "$(echo $P3 | jq -r .c)" = "true" ]'
forgen rule suppress ${RID:0:8} >/dev/null 2>&1; forgen rule activate ${RID:0:8} >/dev/null 2>&1
ok "old-resave-keeps-applies_when" '[ "$(jq -r ".applies_when.commands[0] // \"LOST\"" $R)" = "zzqtool deploy" ]'
forgen audit --help >/dev/null 2>&1; echo "old audit rc=$?"
echo "### 4. 다시 0.9.0"
npm i -g /m/new.tgz >/dev/null 2>&1; forgen --version; ok "reupgrade-keeps-active" '[ "$(act)" -ge "$A0" ]'
B4=$(blk g6d "$HOME"); ok "reupgrade-tier2-index-line" '[ "$(echo "$B4" | grep -c "## Situational Rules")" = 1 ]'
P4=$(pre g6d "$HOME" "zzqtool deploy --canary"); ok "reupgrade-tier2-inject" '[ "$(echo $P4 | jq .ctx)" -gt 0 ]'
forgen audit tier2 --replay --json 2>/dev/null | jq -c '{rules,candidates,qualified}'
echo "FAILS=$FAILS"; [ "$FAILS" = 0 ]
