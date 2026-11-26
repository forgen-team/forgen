. /m/lib.sh
FAILS=0
ok(){ if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; FAILS=$((FAILS+1)); fi; }
# 0.9.2 업그레이드 경로 리허설(docs/plans/2026-11-26-v0.9.2-upgrade-fixes.md): 깨끗한 컨테이너에서
# 공개본 OLD(기본 0.9.1) 설치 → 실데이터 복사본(/data, 읽기 전용 — HOME 통째) → audit --no-model · 가짜 판정기로 audit recurrence --limit 50
# · fix --kind plugin-off --apply → 이 빌드(/new.tgz)로 업그레이드 → 끈 스킬이 그대로 꺼져 있는지(Claude), Codex 스킬은 정상 설치인지,
# 감사 첫 화면에 옛 판정 경고 → recurrence 다시 → 경고 사라짐.
# MODE: postinstall(npm i -g) | ignore(npm i -g --ignore-scripts → 세션 시작 훅의 보완 설치) | repair(--ignore-scripts → forgen doctor --repair)
# 출력 전문은 /out/<MODE>/ 에.
# LEDGER: keep(실데이터 원장 그대로 — 0.9.0 때 끈 스킬 16개가 원장에 '적용'으로 남아 0.9.1 이 다시 깐 실서버 상태) |
#         strip(원장에서 plugin-off 스킬 적용을 빼고 시작 — 0.9.1 의 fix 가 새로 끄는 경우)
OLD=${OLD:-0.9.1}; MODE=${MODE:-postinstall}; LEDGER=${LEDGER:-strip}
O=/out/$MODE-$LEDGER; mkdir -p $O
nvm use 22 >/dev/null
hk(){ node "$(npm root -g)/@wooojin/forgen/dist/hooks/$1.js"; }
NOTE='이전 판정 방식으로 잰 값'
skills(){ ls "$1" 2>/dev/null | grep '^forgen-' | sort; }

echo "### 0. 실데이터 복사본 + ~/.codex(Codex 스킬도 깔리게) + 가짜 판정기"
cp -a /data/. ~/ && rm -rf ~/bin
SRC=$(grep -rhoE '/tmp/claude-[^"]*/v091copy\.[A-Za-z0-9]+' ~/.forgen/audit/fix/ledger.jsonl | head -1)
echo "옛 절대경로 $SRC → $HOME"; grep -rlF "$SRC" ~/.forgen ~/.claude 2>/dev/null | xargs -r sed -i "s#$SRC#$HOME#g"
if [ "$LEDGER" = strip ]; then
  L=~/.forgen/audit/fix/ledger.jsonl; for id in $(jq -r 'select(.kind=="plugin-off" and .event=="apply") | .id' $L | sort -u); do
    b=$(jq -r --arg id $id 'select(.id==$id and .event=="apply") | .backup' $L | tail -1)
    jq -e '.entries[] | select(.isDir and (.path|test("/skills/forgen-")))' $b/backup.json >/dev/null 2>&1 && grep -v "\"id\":\"$id\"" $L > $L.t && mv $L.t $L
  done
  echo "원장에서 뺀 뒤 plugin-off 적용 $(grep -c '"kind":"plugin-off"' $L)줄 남음(명령 폴더 등)"
fi
mkdir -p ~/.codex ~/fakebin
cat > ~/fakebin/claude <<'JS'
#!/usr/bin/env node
// 가짜 판정기: 교정 = 사용자 말에 고치라는 낱말이 있으면 · 쌍 = 교정 요지와 기억이 4글자 이상 낱말을 공유하면 yes
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const blocks = input.split(/^### /m).slice(1).map((b) => { const nl = b.indexOf('\n'); return { id: b.slice(0, nl).trim(), body: b.slice(nl + 1) }; });
  const isPair = input.includes('이미 지시하고 있었나') || input.includes('나중 기억은 이 교정이');
  const out = blocks.map((b) => {
    if (isPair) {
      const a = (/^교정: (.*)$/m.exec(b.body) || [])[1] || '';
      const m = (/^(?:나중 )?기억: (.*)$/m.exec(b.body) || [])[1] || '';
      const wa = new Set(a.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));
      const hit = m.split(/[^\p{L}\p{N}]+/u).some((w) => w.length >= 4 && wa.has(w));
      return JSON.stringify({ id: b.id, answer: hit ? 'yes' : 'no' });
    }
    const u = (/^USER: (.*)$/m.exec(b.body) || [])[1] || '';
    const c = /(하지 ?마|말고|아니라|잖아|다시 해|왜 )/.test(u);
    return JSON.stringify({ id: b.id, correction: c, gist: c ? u.slice(0, 60) : '', task_specific: false });
  });
  process.stdout.write(out.join('\n') + '\n');
});
JS
chmod +x ~/fakebin/claude; export PATH=~/fakebin:$PATH
echo "claude → $(command -v claude)"
ok "fake-judge-first" '[ "$(command -v claude)" = "$HOME/fakebin/claude" ]'

echo "### 1. 공개본 $OLD 설치"
npm i -g @wooojin/forgen@$OLD > $O/01-install-$OLD.txt 2>&1; forgen --version | tee -a $O/01-install-$OLD.txt
skills ~/.claude/skills > $O/02-skills-claude-after-$OLD.txt; skills ~/.codex/skills > $O/02-skills-codex-after-$OLD.txt
echo "Claude forgen 스킬 $(wc -l < $O/02-skills-claude-after-$OLD.txt) · Codex $(wc -l < $O/02-skills-codex-after-$OLD.txt)"
ok "old-installs-claude-skills" '[ $(wc -l < $O/02-skills-claude-after-$OLD.txt) -ge 10 ]'
ok "old-installs-codex-skills" '[ $(wc -l < $O/02-skills-codex-after-$OLD.txt) -ge 10 ]'

echo "### 2. $OLD 로 감사·재생(가짜 판정기, 표본)·스킬 끄기"
forgen audit --no-model --no-open > $O/03-audit-$OLD.txt 2>&1
forgen audit recurrence --limit 50 > $O/04-recurrence-limit50-$OLD.txt 2>&1
forgen fix --kind plugin-off --apply > $O/05-fix-plugin-off-$OLD.txt 2>&1
skills ~/.claude/skills > $O/06-skills-claude-after-fix.txt
comm -23 $O/02-skills-claude-after-$OLD.txt $O/06-skills-claude-after-fix.txt > $O/06-turned-off.txt
N=$(wc -l < $O/06-turned-off.txt); echo "끈 스킬 $N개: $(tr '\n' ' ' < $O/06-turned-off.txt)"
[ "$LEDGER" = strip ] && ok "fix-turned-off-some" '[ $N -ge 1 ]'
grep "$NOTE" $O/03-audit-$OLD.txt >/dev/null && echo "(참고: $OLD 첫 화면에 경고 있음)" || echo "(참고: $OLD 첫 화면은 경고 없이 옛 값을 보여 줌)"

echo "### 3. 이 빌드로 업그레이드 ($MODE)"
case $MODE in
  # npm 7+ 는 설치 스크립트 출력을 숨긴다 — 알림 줄을 남기려고 --foreground-scripts(스크립트 실행 자체는 같음)
  postinstall) npm i -g --foreground-scripts /new.tgz > $O/07-upgrade.txt 2>&1 ;;
  ignore)
    npm i -g --ignore-scripts /new.tgz > $O/07-upgrade.txt 2>&1
    skills ~/.claude/skills > $O/07b-skills-claude-before-hook.txt
    echo "{\"session_id\":\"t25\",\"cwd\":\"$HOME\",\"source\":\"startup\",\"hook_event_name\":\"SessionStart\"}" | hk session-recovery > $O/07c-session-start-hook.json 2>$O/07c-session-start-hook.err
    for i in $(seq 1 90); do [ "$(cat ~/.forgen/state/installed-version 2>/dev/null)" = "$(node -p "require('$(npm root -g)/@wooojin/forgen/package.json').version")" ] && break; sleep 1; done
    sleep 2; cp ~/.forgen/state/self-setup.log $O/07d-self-setup.log 2>/dev/null ;;
  repair)
    npm i -g --ignore-scripts /new.tgz > $O/07-upgrade.txt 2>&1
    forgen doctor --repair > $O/07e-doctor-repair.txt 2>&1 ;;
esac
forgen --version | tee -a $O/07-upgrade.txt
ok "upgraded" '[ "$(forgen --version | grep -o "[0-9]*\.[0-9]*\.[0-9]*" | head -1)" != "$OLD" ]'
ok "installed-version-marker-new" '[ "$(cat ~/.forgen/state/installed-version)" != "$OLD" ]'
skills ~/.claude/skills > $O/08-skills-claude-after-upgrade.txt; skills ~/.codex/skills > $O/08-skills-codex-after-upgrade.txt
cp ~/.forgen/state/disabled-skills.json $O/08-disabled-skills.json 2>/dev/null
echo "업그레이드 뒤 Claude forgen 스킬 $(wc -l < $O/08-skills-claude-after-upgrade.txt) · Codex $(wc -l < $O/08-skills-codex-after-upgrade.txt)"
ok "claude-turned-off-stay-off" '[ -z "$(comm -12 $O/06-turned-off.txt $O/08-skills-claude-after-upgrade.txt)" ]'
# 기록 = 이번에 끈 것 + 실데이터 원장에 남아 있던 0.9.0 때 끈 것(이전) — 기록에 없는 스킬은 그대로 깔려 있어야 한다
jq -r '.skills|keys[]' $O/08-disabled-skills.json 2>/dev/null | sed 's/^claude://' | sort > $O/08-recorded.txt
echo "기록된 끈 스킬 $(wc -l < $O/08-recorded.txt)개(이번 fix $N개 + 원장 이전분)"
ok "claude-unrecorded-still-installed" '[ "$(comm -23 $O/02-skills-claude-after-$OLD.txt $O/08-recorded.txt)" = "$(cat $O/08-skills-claude-after-upgrade.txt)" ]'
ok "codex-skills-installed-unchanged" '[ "$(cat $O/02-skills-codex-after-$OLD.txt)" = "$(cat $O/08-skills-codex-after-upgrade.txt)" ]'
ok "record-has-turned-off" 'for s in $(cat $O/06-turned-off.txt); do jq -e --arg k "claude:$s" ".skills[\$k].fixId" $O/08-disabled-skills.json >/dev/null || exit 1; done'
ok "record-claude-only" '[ "$(jq -r ".skills|keys[]" $O/08-disabled-skills.json | grep -vc "^claude:")" = 0 ]'
case $MODE in
  postinstall) ok "notice-in-upgrade-output" 'grep -q "끈 스킬 [0-9]*개는 그대로 둠" $O/07-upgrade.txt' ;;
  ignore) ok "skills-off-before-hook" '[ -z "$(comm -12 $O/06-turned-off.txt $O/07b-skills-claude-before-hook.txt)" ]'
          ok "notice-in-self-setup-log" 'grep -q "끈 스킬 [0-9]*개는 그대로 둠" $O/07d-self-setup.log' ;;
  repair) ok "notice-in-doctor-repair" 'grep -q "끈 스킬 [0-9]*개는 그대로 둠" $O/07e-doctor-repair.txt' ;;
esac
# 다시 설치(forgen install claude)해도 그대로
forgen install claude > $O/09-install-claude-again.txt 2>&1
ok "install-claude-again-stays-off" '[ -z "$(comm -12 $O/06-turned-off.txt <(skills ~/.claude/skills))" ]'

echo "### 4. 첫 화면: 옛 판정 경고 → 다시 재면 사라짐"
forgen audit --no-model --no-open > $O/10-audit-after-upgrade.txt 2>&1
ok "stale-warning-shown" 'grep -q "$NOTE" $O/10-audit-after-upgrade.txt'
forgen audit recurrence > $O/11-recurrence-full-after-upgrade.txt 2>&1
forgen audit --no-model --no-open > $O/12-audit-after-remeasure.txt 2>&1
ok "stale-warning-gone" '! grep -q "$NOTE" $O/12-audit-after-remeasure.txt'
ok "range-shown-after-remeasure" 'grep -q "같은 말 다시 하기" $O/12-audit-after-remeasure.txt'

echo "### 5. 되돌리기는 그 스킬만 다시 켠다"
ID=$(jq -r '.skills|to_entries[0].value.fixId' $O/08-disabled-skills.json); S=$(jq -r '.skills|to_entries[0].key' $O/08-disabled-skills.json | sed 's/^claude://')
forgen fix --undo $ID > $O/13-fix-undo.txt 2>&1
ok "undo-restores-skill" '[ -d ~/.claude/skills/$S ]'
forgen install claude > $O/14-install-claude-after-undo.txt 2>&1
ok "after-undo-install-keeps-it-on" '[ -e ~/.claude/skills/$S/SKILL.md ]'
ok "undo-clears-record" '! jq -e --arg k "claude:$S" ".skills[\$k]" ~/.forgen/state/disabled-skills.json >/dev/null'
echo "FAILS=$FAILS" | tee $O/99-verdict.txt
