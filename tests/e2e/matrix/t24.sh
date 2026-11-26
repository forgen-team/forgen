. /m/lib.sh
FAILS=0
ok(){ if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; FAILS=$((FAILS+1)); fi; }
# 0.9.1 #11 설치 전에 먼저 보기: forgen 미설치·~/.forgen 없음·대화 기록만 있는 깨끗한 컨테이너에서
# `npx -y <tgz> audit --since 30d` 가 ~/.claude 를 하나도 바꾸지 않고(실행 전후 해시), 훅을 등록하지 않고,
# ~/.forgen 에는 결과 폴더(audit/)만 남기고, 그 경로를 말한다. 로컬 빌드(/m/new.tgz)를 npx 로 실행.
nvm use 22 >/dev/null
TGZ=${TGZ:-/m/new.tgz}
mkdir -p ~/proj ~/.claude/projects/-home-dev-proj && cd ~/proj && git init -q
printf -- '- 답변은 한국어로 한다\n- `scripts/old-deploy.sh` 로 배포한다\n' > ~/.claude/CLAUDE.md
printf -- '- 배포 전에 반드시 테스트를 돌린다\n' > ~/proj/CLAUDE.md
echo '{"theme":"dark"}' > ~/.claude/settings.json
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
for i in 1 2 3; do
  { echo "{\"type\":\"user\",\"cwd\":\"$HOME/proj\",\"timestamp\":\"$NOW\",\"message\":{\"role\":\"user\",\"content\":\"배포 스크립트 고쳐줘\"}}"
    echo "{\"type\":\"assistant\",\"cwd\":\"$HOME/proj\",\"timestamp\":\"$NOW\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"영어로 답합니다\"}]}}"
    echo "{\"type\":\"user\",\"cwd\":\"$HOME/proj\",\"timestamp\":\"$NOW\",\"message\":{\"role\":\"user\",\"content\":\"한국어로 답하라고 했잖아\"}}"; } > ~/.claude/projects/-home-dev-proj/s$i.jsonl
done
h(){ (cd ~ && find .claude -type f -o -type l | sort | while read f; do echo "$f $(sha256sum "$f" | cut -c1-16)"; done) | sha256sum | cut -c1-16; }
H0=$(h); echo "before ~/.claude $H0"; L0=$(cd ~ && find .claude -type f | sort | xargs sha256sum 2>/dev/null)
ok "no-forgen-home-before" '[ ! -e ~/.forgen ]'
ok "forgen-not-installed" '! command -v forgen >/dev/null'
echo "### 1. npx audit --since 30d --no-model"
OUT=$(npx -y --package=$TGZ forgen audit --since 30d --no-model --no-open 2>&1); echo "$OUT" | sed 's/^/  | /' | head -60
H1=$(h); echo "after ~/.claude $H1"
ok "claude-dir-unchanged" '[ "$H0" = "$H1" ]'
ok "settings-no-hooks" '! grep -q hooks ~/.claude/settings.json'
ok "forgen-home-only-audit" '[ "$(ls -A ~/.forgen)" = "audit" ]'
ok "says-result-path" 'echo "$OUT" | grep -q "~/.forgen/audit/"'
ok "first-screen" 'echo "$OUT" | grep -q "요약\|Summary"'
ok "still-not-installed" '! command -v forgen >/dev/null'
echo "### 2. --share (숫자와 유형만)"
SH=$(npx -y --package=$TGZ forgen audit --since 30d --no-model --no-open --share 2>&1); echo "$SH" | sed 's/^/  | /'
ok "share-no-paths" '! echo "$SH" | sed "/자세히(나만 보기)/d" | grep -q "/home/\|proj"'
ok "share-unchanged-claude" '[ "$(h)" = "$H0" ]'
echo "### 3. 모델 판정 경로(claude CLI 인증 없음 — 판정 실패는 결과에 적히고 ~/.claude 는 그대로여야)"
M=$(npx -y --package=$TGZ forgen audit --since 30d --no-open </dev/null 2>&1); echo "$M" | sed 's/^/  | /' | head -12
# 모델을 켜면 forgen 이 부르는 claude CLI 가 자기 상태 파일(backups/·plugins/store/·statsig/ 등)을 쓴다 — forgen 이 쓰는 것은 없어야 한다
CH=$(diff <(echo "$L0") <(cd ~ && find .claude -type f | sort | xargs sha256sum 2>/dev/null) | grep '^[<>]' | awk '{print $3}' | sort -u)
echo "changed under ~/.claude (claude CLI): $CH"
ok "model-path-only-claude-cli-state" '[ -z "$(echo "$CH" | grep -v -e "^.claude/backups/" -e "^.claude/plugins/store/" -e "^.claude/statsig/" -e "^.claude/todos/" -e "^.claude/shell-snapshots/" -e "^$")" ]'
ok "model-path-settings-memory-untouched" '! grep -q hooks ~/.claude/settings.json && [ "$(cd ~ && sha256sum .claude/CLAUDE.md .claude/settings.json | sha256sum)" = "$(echo "$L0" | grep -e " .claude/CLAUDE.md$" -e " .claude/settings.json$" | sha256sum)" ]' 
ok "model-path-forgen-home-only-audit" '[ "$(ls -A ~/.forgen)" = "audit" ]'
echo "~/.forgen tree:"; find ~/.forgen -maxdepth 2 | sort | head -20
echo "FAILS=$FAILS"
