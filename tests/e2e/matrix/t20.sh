# 업그레이드 복구: 공개된 옛 버전 → 새 패키지. /m/old.tgz, /m/new.tgz 필요. 이미지에 cron 필요.
. /m/lib.sh
nvm use 22 >/dev/null; mkdir -p ~/proj/.git; cd ~/proj
stop(){ echo '{"session_id":"u","cwd":"'$HOME/proj'","last_assistant_message":"구현 완료했습니다."}' | node "$(npm root -g)/@wooojin/forgen/dist/hooks/stop-guard.js" | tail -1 | cut -c1-110; }
seed(){ python3 - <<'P'
import json,os
h=os.path.expanduser('~/.forgen/me');os.makedirs(h+'/rules',exist_ok=True);os.makedirs(h+'/behavior',exist_ok=True)
base=dict(category='workflow',scope='me',trigger='t',strength='default',source='explicit_correction',status='active',created_at='2026-01-01T00:00:00Z',updated_at='2026-01-01T00:00:00Z')
gate=[dict(mech='A',hook='Stop',trigger_keywords_regex='완료',verifier=dict(kind='artifact_check',params=dict(path='.forgen/state/e2e-result.json',max_age_s=3600)))]
for rid,o in {'11111111-stale':dict(policy='프로덕션 환경을 먼저 확인',evidence_refs=[],enforce_via=gate),'22222222-off':dict(policy='꺼진 교정',status='suppressed',evidence_refs=['bbbb2222'])}.items():
  json.dump(dict(base,rule_id=rid,render_key='w.'+rid,**o),open(f'{h}/rules/{rid}.json','w'))
for eid,t in {'aaaa1111':'룰이 사라진 교정','bbbb2222':'꺼진 교정'}.items():
  json.dump(dict(evidence_id=eid,type='explicit_correction',session_id='s',timestamp='2026-05-01T00:00:00.000Z',source_component='Hooks',summary=t,axis_refs=[],candidate_rule_refs=[],confidence=0.9,raw_payload=dict(kind='avoid-this',target='x')),open(f'{h}/behavior/{eid}.json','w'))
P
}
case "$1" in
upgrade)
  npm i -g /m/old.tgz >/dev/null 2>&1; forgen --version; forgen install claude >/dev/null 2>&1
  (crontab -l 2>/dev/null; echo '0 6 * * * /usr/bin/true # my-job') | crontab -
  forgen compound sweep --install-cron | head -1; seed
  echo "### 옛 버전: stale 게이트"; stop
  echo "### 옛 cron"; crontab -l | grep sweep | cut -c1-150
  echo "### 업그레이드"; npm i -g /m/new.tgz 2>&1 | grep -E "\[forgen\]" | cut -c1-120; forgen --version
  echo "### 새 cron"; crontab -l | cut -c1-150
  echo "### 새 버전: stale 게이트"; stop
  echo "### doctor 안내"; forgen doctor 2>&1 | grep "남지 못한" | cut -c1-110
  echo "### 복구 미리보기"; forgen rule recover 2>/dev/null | cut -c1-90
  forgen rule recover --apply aaaa --project proj 2>/dev/null | cut -c1-90; forgen rule recover --apply bbbb 2>/dev/null | cut -c1-90; forgen rule recover 2>/dev/null
  echo "### 주입"; echo '{"session_id":"u2","cwd":"'$HOME/proj'","hook_event_name":"SessionStart","source":"startup"}' | ~/.forgen/bin/forgen-run hooks/session-recovery.js | python3 -c "import json,sys;c=json.load(sys.stdin)['hookSpecificOutput']['additionalContext'];print(len(c),'사라진' in c,'꺼진' in c)"
  echo "### node 교체 후 cron 명령 실제 실행"; nvm use 24 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1; nvm uninstall 22 >/dev/null 2>&1
  C=$(crontab -l | grep sweep | sed -E 's/^([^ ]+ ){5}//; s/ #.*//'); env -i HOME=$HOME PATH=/usr/bin:/bin sh -c "$C"; echo "rc=$?"; tail -2 ~/.forgen/state/compound-sweep.log | cut -c1-130
  forgen doctor 2>&1 | grep -E "✗|Summary|ready|failed" | cut -c1-110 ;;
noscripts)
  npm i -g --ignore-scripts /m/new.tgz >/dev/null 2>&1; forgen --version; ls ~/.claude/settings.json ~/.forgen/bin/forgen-run 2>&1 | cut -c1-90
  echo "### 스크립트 없이 첫 명령"; forgen status 2>&1 | head -6 | cut -c1-110; forgen doctor 2>&1 | grep -E "✗|Summary|ready|failed|install" | head -8 | cut -c1-120 ;;
noscripts-upgrade)
  npm i -g /m/old.tgz >/dev/null 2>&1; forgen install claude >/dev/null 2>&1; forgen compound sweep --install-cron | head -1
  npm i -g --ignore-scripts /m/new.tgz >/dev/null 2>&1; forgen --version
  echo "### hook 경로"; python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.claude/settings.json')));c=[x['command'] for v in d['hooks'].values() for g in v for x in g['hooks']];print(len(c),c[0][:110])"
  crontab -l | grep sweep | cut -c1-130; forgen doctor 2>&1 | grep -E "✗|Summary|ready|failed" | head -8 | cut -c1-120
  echo "### doctor 안내대로 설치"; forgen install claude >/dev/null 2>&1
  crontab -l | grep sweep | cut -c1-130; forgen doctor 2>&1 | grep -E "✗|Summary|ready|failed|남지 못한" | head -8 | cut -c1-120 ;;
forgen-home)
  # FORGEN_HOME 사용자: 업그레이드가 실제 cron 을 건드리지 않고, 기존 sweep 도 계속 돈다.
  export FORGEN_HOME=$HOME/custom-fg; mkdir -p $FORGEN_HOME/state
  npm i -g /m/old.tgz >/dev/null 2>&1; forgen compound sweep --install-cron >/dev/null; A=$(crontab -l | md5sum)
  npm i -g /m/new.tgz >/dev/null 2>&1; forgen --version; [ "$A" = "$(crontab -l | md5sum)" ] && echo "cron 불변" || echo "cron 변경됨"
  C=$(crontab -l | grep sweep | sed -E 's/^([^ ]+ ){5}//; s/ #.*//'); env -i HOME=$HOME PATH=/usr/bin:/bin sh -c "$C"; echo "rc=$?" ;;
custom-line)
  # 사용자가 고친 라인과 @hourly 는 깨지지 않는다.
  npm i -g /m/old.tgz >/dev/null 2>&1
  OLD=$(npm root -g)/@wooojin/forgen/dist/cli.js; NODE=$(which node)
  printf "@hourly '%s' '%s' compound sweep --prune-removed >> '%s/s.log' 2>&1 # forgen-compound-sweep (ADR-011)\n0 6 * * * /usr/bin/true # my-job\n" "$NODE" "$OLD" "$HOME" | crontab -
  npm i -g /m/new.tgz >/dev/null 2>&1; crontab -l | cut -c1-140
  printf "17 * * * * /my/wrapper.sh # forgen-compound-sweep (ADR-011)\n" | crontab -; forgen install claude >/dev/null 2>&1; crontab -l | cut -c1-100 ;;
fresh)
  npm i -g /m/new.tgz 2>&1 | grep -E "\[forgen\]" | cut -c1-110; forgen --version; crontab -l 2>&1 | head -2
  forgen rule recover 2>/dev/null; forgen doctor 2>&1 | grep -E "✗|Summary|ready|failed" | head | cut -c1-110 ;;
esac
