# ADR-019: Haiku 추출 기본 ON + 수집·추출 경로 재설계 (ADR-012 D 대체)

**Status**: Accepted (2026-11-04)
**Supersedes**: ADR-012 의 "Haiku opt-in(default off)" 결정 (결정론 경로 항상 ON 은 유지)
**Reversibility**: Type 2 (기본값 한 줄, config/env 로 끔)
**관련**: docs/plans/2026-11-04-reliability-decisions.md D2·D3·D4·D9, ADR-011, ADR-012, ADR-013

## Context

ADR-012 는 Haiku 추출을 opt-in 으로 두었다. 감사(2026-11-04)에서 확인된 사실:

- 동의를 켠 사용자가 사실상 없어 솔루션 추출 경로가 죽어 있었다. 켜진 환경에서도 입력이 망가져 있었다:
  123MB 세션에서 실제 사용자 발화 438개 중 2개만 요약에 들었고, 요약은 `/clear`·caveat·스킬 본문으로 채워졌으며,
  추출된 3개 솔루션은 모두 세션 첫 프롬프트 복사였다.
- 교정→룰 승급이 "사용자 메시지 10개 이상 + 요약 200자 이상 + Haiku + 인젝션 검사"를 다 통과해야 실행됐다.
  짧은 세션·Haiku 불가 환경에서는 교정이 룰이 되지 않았다.
- 타임아웃·호출 실패는 흔적 없이 사라졌다(재시도·기록 없음).
- `sessions.db` 는 래퍼 경로에서만, 그것도 실제 스키마(`message.content`)를 못 읽어 메시지 0건으로 기록됐다.

## Decision

1. **Haiku 추출 기본 ON.** 우선순위: `FORGEN_NO_AUTO_COMPOUND=1`(강제 off) > `FORGEN_AUTO_COMPOUND=1` >
   `config.json.autoCompoundHaiku` (명시 false 존중) > 기본값 true.
2. **"몰래 보내지 않는다"는 안내로 지킨다.** 최초 1회 SessionStart 에서 사용자 화면(systemMessage)에
   무엇이 전송되는지(대화 요약, 비밀키 마스킹, `<private>` 제외, 내 계정의 Haiku)와 끄는 법을 보인다.
   `forgen status`·`forgen doctor` 가 상태를 항상 표시한다.
3. **호출 불가(claude 없음·미로그인)는 사유를 보인다.** `claude auth status`(모델 호출 없음)로 판정,
   status 와 세션 시작(하루 1회)에 사유 표시. 결정론 경로(승급·인덱싱)는 계속 동작.
4. **승급은 모든 게이트 앞.** 러너가 가장 먼저 `promoteSessionCandidates`(멱등)를 실행하고,
   트리거(Stop·SessionEnd·SessionStart 복구·래퍼 종료)의 메시지 수 게이트를 없앴다. 재실행 판정은
   "마지막 러너 실행 이후 transcript 가 자랐는가"(세션별 크기 기록).
5. **추출 입력 재설계(D3).** 주입 텍스트 제외, 남긴 길이로 예산, 교정 발화와 직전 어시스턴트 발화·세션 끝 20% 우선,
   스트림 읽기(메모리 상수), 세션별 바이트 커서로 증분.
6. **실패 복구(D4).** 호출 실패·타임아웃은 비밀 마스킹된 요약째 `state/extraction-queue.json` 에 보관, 다음 러너
   실행에서 재시도(시도 3회, 백오프 10분/1시간/6시간, 러너당 1건, 20건/7일 상한). 호출별 소요·사유를
   `extraction-events.jsonl` 에 기록. 중첩 호출은 `--tools "" --strict-mcp-config --setting-sources "" --disable-slash-commands
   --no-session-persistence` 로 플러그인·hook·MCP·도구를 끌어오지 않는다.
7. **세션 기록(D9).** sessions.db 인덱싱을 러너로 이동(증분·멱등, Claude·Codex 스키마 공통). 직접 실행도 기록된다.

## Consequences

- 기본 설치 사용자의 세션 요약이 (마스킹 후) Anthropic 으로 나간다. 같은 신뢰경계(대화가 이미 가는 곳)이며
  쿼터는 사용자 계정에서 소량(호출당 약 $0.001~0.003) 소모된다. 안내와 끄는 법이 최초 세션에 보인다.
- 짧은 세션마다 러너가 뜬다(승급·인덱싱은 값싼 로컬 작업). Haiku 는 새 구간이 충분할 때만 호출한다
  (Stop: 새 사용자 발화 3개 이상 또는 교정 후보 존재, SessionEnd/복구: 항상).
- `forgen compound consent off` 가 기존 사용자가 명시적으로 껐을 때와 같은 효과다. 이전에 명시 false 를
  저장한 사용자는 그대로 꺼진 채 유지된다.

## Rejected

- 설치 시 확인 프롬프트(opt-in 유지): ADR-012 가 이미 실패한 방식. 비대화형 설치(npm 전역)에서는 응답을 받을 수 없다.
- 안내 없는 기본 ON: 투명성 요구를 어긴다.
