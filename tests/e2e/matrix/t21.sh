# 로그인 상태 전 과정: 설치 → 교정 → 다음 세션 → 안전 → 추출 → 회수 → 내보내기. /m/new.tgz, /secrets 필요. 비용 발생.
. /m/lib.sh
nvm use 22 >/dev/null; mkdir -p ~/.claude; cp /secrets/.credentials.json ~/.claude/; chmod 600 ~/.claude/.credentials.json
mkdir -p ~/app && cd ~/app && git init -q . && git config user.email t@t && git config user.name t; mkdir build; echo x > build/a; echo SECRET=1 > .env
ask(){ timeout 170 claude -p "$1" --model ${2:-sonnet} --output-format stream-json --verbose ${3:+--resume "$3"} ${4:+--allowedTools "$4"} </dev/null 2>/dev/null > /tmp/o.jsonl; python3 - <<'P'
import json
ini=None;res='';tools=[]
for l in open('/tmp/o.jsonl'):
    try:d=json.loads(l)
    except:continue
    if d.get('subtype')=='init': ini=d
    if d.get('type')=='result': res=d.get('result') or ''
    if d.get('type')=='assistant':
        for c in d['message']['content']:
            if c.get('type')=='tool_use': tools.append(c['name'].replace('mcp__forgen-compound__','mcp:'))
print('  sid',(ini or {}).get('session_id','?')[:8],'forgen-mcp',[m['status'] for m in (ini or {}).get('mcp_servers',[]) if 'forgen' in m['name']],'tools',tools[:5])
print('  답:',res.replace('\n',' / ')[:230])
open('/tmp/sid','w').write((ini or {}).get('session_id',''))
P
}
rules(){ python3 - <<'P'
import json,glob,os
for f in glob.glob(os.path.expanduser('~/.forgen/me/rules/*.json')):
    r=json.load(open(f)); print('  rule',r['scope'],r['status'],r['strength'],r['policy'][:60])
P
}
echo "### 1 설치"; npm i -g /m/new.tgz >/dev/null 2>&1; forgen --version; forgen doctor 2>&1 | grep -E "✗|ready|failed" | cut -c1-120; claude plugin list 2>&1 | grep -ci "failed"
echo "### 2 교정 기록"; ask "사용자 교정: 앞으로 모든 답변의 맨 끝에 [CHK-77] 을 붙여라. correction-record 도구로 kind=avoid-this, target='답변 끝 표식 누락', axis_hint=null 로 기록하고 한 줄로 답해." sonnet "" "mcp__forgen-compound__correction-record"; rules
echo "### 3 다음 세션"; sleep 5; ask "2 더하기 2는?"; ask "What is 2+3? Reply in one word." haiku; rules
echo "### 4 안전: hook"; for c in 'rm -rf build' 'rm -r -f src' 'rm -rf ~/docs' 'ls -la' 'git push --force origin main' 'rm -rf /etc/x'; do printf '  %-30s' "$c"; printf '{"session_id":"z","cwd":"%s","tool_name":"Bash","tool_input":{"command":"%s"},"hook_event_name":"PreToolUse"}' "$PWD" "$c" | ~/.forgen/bin/forgen-run hooks/pre-tool-use.js | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('hookSpecificOutput',{}).get('permissionDecision','allow'))"; done
git add .env; printf '  %-30s' ".env 스테이징 후 커밋"; printf '{"session_id":"z","cwd":"%s","tool_name":"Bash","tool_input":{"command":"git commit -m x"},"hook_event_name":"PreToolUse"}' "$PWD" | ~/.forgen/bin/forgen-run hooks/pre-tool-use.js | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('hookSpecificOutput',{}).get('permissionDecision','allow'))"; git reset -q
echo "### 5 안전: 실제 모델"; ask "Bash 로 rm -rf build 를 실행해." sonnet "" "Bash"; ls build >/dev/null 2>&1 && echo "  build 남아있음" || echo "  build 삭제됨"
echo "### 6 추출 (실제 Haiku)"; ask "우리 서비스가 NFS 볼륨 위 SQLite 에서 간헐적으로 'database is locked' 를 내. 원인을 짧게 설명해." sonnet; SID=$(cat /tmp/sid)
ask "원인은 NFS 의 파일 락 불안정과 WAL 모드 비호환이었어. 해결: DB 를 로컬 디스크로 옮기고 NFS 에는 백업만 둔다. 기억해 둘 만한 교훈을 정리해." sonnet "$SID"
ask "맞아. 그리고 busy_timeout 은 근본 해결이 아니었어. WAL 은 NFS 에서 쓰면 안 된다는 점도 넣어." sonnet "$SID"
ask "재발 방지 체크리스트를 3줄로." sonnet "$SID"; ask "마이그레이션 순서도 3줄로." sonnet "$SID"
for i in $(seq 1 24); do [ -s ~/.forgen/state/extraction-events.jsonl ] && grep -q '"ok"' ~/.forgen/state/extraction-events.jsonl && break; sleep 5; done
python3 - <<'P'
import json,os
p=os.path.expanduser('~/.forgen/state/extraction-events.jsonl')
for l in (open(p) if os.path.exists(p) else []):
    d=json.loads(l); print('  ev',d.get('kind',''),d.get('phase',''),d.get('outcome',''),d.get('ok',''),d.get('ms',''),d.get('extractedSolutions',''),str(d.get('skipped',''))[:80],str(d.get('reason',''))[:80])
P
ls ~/.forgen/me/solutions 2>/dev/null | head -8; forgen status 2>/dev/null | sed -n 3,12p | cut -c1-100
echo "### 7 회수"; printf '{"prompt":"NFS 위 SQLite 가 database is locked 나는데 어떻게 하지","session_id":"r1","cwd":"%s","hook_event_name":"UserPromptSubmit"}' "$PWD" | ~/.forgen/bin/forgen-run hooks/solution-injector.js | cut -c1-300; echo
ask "새 서비스도 NFS 볼륨에 SQLite 를 올리려는데 괜찮아? 두 줄로." sonnet
echo "### 8 내보내기"; forgen way 2>/dev/null | head -12 | cut -c1-100; forgen way export --target agents-md --out ~/out --force 2>&1 | tail -2 | cut -c1-120; ls -R ~/out | head -8; grep -c "CHK-77" ~/out/AGENTS.md
forgen way export --target skill --out ~/out2 --force 2>&1 | tail -1 | cut -c1-120; forgen way draft skill "SQLite 운영 점검" --out ~/out3 --force 2>&1 | tail -2 | cut -c1-120; find ~/out3 -name SKILL.md | head -1 | xargs -r head -24 | cut -c1-120
[ -d /r ] && cp -r ~/out/. /r/ 2>/dev/null
rm -f ~/.claude/.credentials.json
