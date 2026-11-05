/**
 * 러너 프로세스 테스트용 `claude` 실행 파일 대역. PATH 맨 앞에 두어 러너가 실제 spawn 하는 경계(CLI)만 대신한다.
 * 러너·큐·락·훅 코드는 전부 실물이고, 이 대역은 Haiku 응답과 로그인 상태만 제어한다. 실제 Haiku 확인은 별도 수동 실행으로 했다.
 *   FAKE_STATE/loggedin 파일이 있으면 로그인 상태, FAKE_STATE/calls.log 에 호출 종류를 한 줄씩 남긴다.
 *   FAKE_REJECT="--opt ..." 이 인자에 있으면 `unknown option` 으로 실패, FAKE_FAIL_PHASE=<phase> 는 그 단계만 로그인 오류,
 *   FAKE_SLEEP=<초> 는 응답 전 대기(동시 실행 재현).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPT = `#!/bin/bash
S="\${FAKE_STATE:?}"
if [ "$1" = "auth" ]; then
  echo "auth" >> "$S/auth.log"
  if [ -f "$S/loggedin" ]; then echo '{"loggedIn":true}'; exit 0; else echo '{"loggedIn":false}'; exit 1; fi
fi
args="$*"
for o in $FAKE_REJECT; do
  case " $args " in *" $o "*) echo "reject $o" >> "$S/calls.log"; echo "error: unknown option '$o'" >&2; exit 1;; esac
done
input=$(cat)
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
kind=learning
case "$input" in *"forgen compound --solution"*) kind=solution;; *"작업 습관"*) kind=behavior;; esac
echo "$kind" >> "$S/calls.log"
if [ "$kind" = "$FAKE_FAIL_PHASE" ]; then echo "Please run /login" >&2; exit 1; fi
case $kind in
  solution) echo 'forgen compound --solution "fake-process-title" "이 상황에서는 이렇게 한다. 근거와 주의를 포함한 충분히 긴 본문입니다. 테스트 전용 솔루션" "테스트 조건"';;
  behavior) echo "- [워크플로우] 테스트 먼저 작성하고 구현한 뒤 리팩토링하는 순서로 일한다 (관찰 근거)";;
  learning) echo '{"corrections":[],"observations":[],"pack_direction":null,"profile_delta":{}}';;
esac
`;

export function installFakeClaude(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  const p = path.join(binDir, 'claude');
  fs.writeFileSync(p, SCRIPT, { mode: 0o755 });
}

export function readCalls(stateDir: string): string[] {
  try { return fs.readFileSync(path.join(stateDir, 'calls.log'), 'utf-8').split('\n').filter(Boolean); } catch { return []; }
}
