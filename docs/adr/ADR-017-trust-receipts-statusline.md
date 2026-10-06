# ADR-017: 신뢰 영수증 — 차단 영수증·오탐 되먹임 · 룰 병합 · 적용 룰 가시화 · statusline 재설계(컨텍스트/한도/소진 예측)

**Status**: Accepted (2026-10-06) — 오너 결정: ① 차단 판정은 사용자가 안 누를 것이므로 **자동 판정**으로 ② rm-rf 예외는 "뭔 소린지 모르겠다" → 아래 §6-2 평문 설명과 기본값(scratchpad 예외 적용)으로 진행 ③ 프로필 4축 score는 **즉시 구현**. Fable critic 1라운드(REJECT, SEV-1 4건·SEV-2 7건) 반영본.
**Reversibility**: Type 2 (가역 — 로그 스키마 추가·status/statusline 출력 변경·룰 병합은 superseded 링크로 복원 가능)
**관련**: ADR-001 (Mech-A/B/C), ADR-002 (lifecycle T1~T5, T3 bypass), ADR-010 (수렴 대응 — "학습을 증명한다"; **본 ADR의 D4/D5는 ADR-010 §2b "usage/limit 표시 철수"를 부분 supersede** — 근거 변화: Claude Code가 statusline stdin으로 한도·컨텍스트를 직접 제공), ADR-013 (채굴 룰 advisory-only·캡 30 — 본 ADR D3는 이 불변식을 유지), ADR-016 (Codex 룰 주입 상한)
**출발점**: 오너 발언 (2026-10-06) — "교정, 차단 이런 건 좋은데 뭔가 잘 체감이 안 되는 것 같다", "status가 너무 불친절하다 — 세션 리밋이나 컨텍스트 사용 퍼센트가 안 보인다", "지금 추세면 언제 다 쓸지 예정도 보여줬으면"

---

## 1. Context — 실측 (2026-10-06, 실 `~/.forgen` 상태, 코드 대조)

### 1.1 체감이 안 되는 이유는 기능 부재가 아니라 "보이지 않음 + 보이는 것이 틀림"

`forgen status` 헤드라인과 그 출처를 대조했다.

| status 표시 | 실제 | 출처 |
|---|---|---|
| Blocks 108 (7d), 8% acknowledged | **78건(72%)은 vitest가 실 `~/.forgen`에 남긴 `rm -rf /` 프로브** (session_id `default`). 실 차단은 30건 | `state/enforcement/violations.jsonl` — `message_preview:"rm -rf /"` 78건 전부 session `default`, 날짜가 릴리스 작업일(10-01, 10-02)과 일치. 원인은 `tests/hook-pipeline.test.ts:36-42` — `dist/hooks/pre-tool-use.js`를 **실 `HOME`으로 spawn**(`env: {...process.env, HOME}`)하고 입력에 `session_id`가 없어 `pre-tool-use.ts:395`의 `?? 'default'` 폴백으로 기록. (critic 재검증: `vi.mock('node:os')`로 homedir을 바꾸는 in-process 테스트는 오염시키지 않음 — mock 홈에 L1 룰이 없어 기록 자체가 안 생김) |
| Bypass 179 — "user overrides" | **실 사용자 우회 0건** (`FORGEN_USER_CONFIRMED=1` 기록 전체 기간 0). 179건 전부 자연어 휴리스틱 오탐: 룰 policy에서 뽑은 단어 "먼저"(238), "Team"(230+197+197), "1번/2번"(85), "Fable"(42)이 Bash 출력/파일 본문에 등장하면 "우회"로 기록. 전체 기간 상위 4개 rule_id 중 2개(197건씩)는 **룰 파일이 없고**, 7일 기준 상위 4개는 2개 `removed`·2개 active (critic 재확인) | `src/engine/lifecycle/bypass-detector.ts` (policy 자연어 → 패턴 추출), `src/hooks/post-tool-use.ts:393-397`, `src/core/stats-cli.ts:222` (Write/Edit만 제외, Bash는 raw) |
| Recall 25 / Surfaced 0 / Referenced 0 | 7일 Recall 773 중 **351건(43%)은 vitest 픽스처 오염**. 실 hook recall 354건 중 후보 있는 건 49건, 최고 0.268. Surfaced은 5개월간 `works-with-typescript @0.27` 3회뿐 | §1.5a |
| Active rules 45 | 30개가 2026-10-02 하루에 생성된 채굴 룰(ADR-013 캡 30 정확히 도달). 그중 "Fable 조기 투입" 13건, "웹검색 먼저" 7건, "병렬 에이전트 허용" 6건 — **같은 교정의 문장 변형** | `src/store/evidence-store.ts:255-257` — render_key = `axis.` + LLM이 생성한 target 문자열 30자 slug → 의미 동일성 없음. `src/engine/correction-cluster-runner.ts:122` — 클러스터링은 `explicit_correction`만 대상, `behavior_inference`는 제외 |
| 교정 450건, 4축 score 전부 0.50, Last reclass never | 라벨 오기 — 명시 교정은 247건. 247번 말했는데 프로필 상위 축이 한 번도 안 움직임 (facet은 움직임). **갱신 코드가 미구현** | §1.5b |

### 1.2 실 차단 30건의 내역 (7d, session `default` 제외)

| 건수 | 룰 | 판정 |
|---|---|---|
| 14 | `L1-no-rm-rf-unconfirmed` (Mech-A PreToolUse deny) | 리터럴 `/tmp` 1, 변수 경로(`$S` 등, 같은 명령에서 `/tmp/claude-*` 대입) 7, heredoc 내부 5, `~/.cache/onemotion-probe` 1(정탐). 13건은 룰 letter상 정탐·가치상 오탐. 빌트인 위험패턴의 `/tmp` 예외(`pre-tool-use.ts:98`)는 리터럴 전제라 변수 경로엔 무력 |
| 7 | "답변은 한국어로" (Mech-B Stop) ×2 룰 — 하나는 `suppressed` 중복 | 한 룰이 두 개로 존재 |
| 4 | `builtin:dangerous-response-pattern` | 표본 1건 확인: macOS npm 오류를 *설명하는* 평문 응답을 차단 — 오탐 |
| 4 | "청크마다 critic 리뷰" (Mech-A Stop) | 미확인 |
| 2 | `builtin:conclusion-ratio` | 미확인 |

→ **차단 표면의 신뢰 = precision인데, 지금은 precision을 잴 수단이 없다.** `violations.jsonl`은 `message_preview` 120자만 남기고, "어느 패턴이 어디에 매칭됐는지"와 "사용자가 이 차단을 맞다고 보는지"를 기록할 자리가 없다. Acknowledgment는 block→retract→pass 루프 관측(`stop-guard.ts:366`)이지 사용자 판정이 아니다.

### 1.3 룰이 모델에 도달하는 경로와 "적용" 관측 불가

- 룰은 `generateClaudeRuleFiles()`(`src/core/config-injector.ts:415`)가 `.claude/rules/v1-rules.md`로 렌더한 **정적 파일**로 매 세션 컨텍스트에 상주. Codex는 SessionStart 주입(ADR-014, 15k자 상한 — ADR-016 실 문제 1).
- 따라서 "이 턴에 어떤 룰이 적용됐는가"는 현재 어디에도 기록되지 않는다. Stop에서 Mech-A/B 평가(`stop-guard.ts:303`)가 돌지만 **위반만** `recordViolation`, 통과는 무기록.
- 중복 13건이 그대로 렌더되어 매 세션 모델이 같은 문장을 13번 읽는다 → 컨텍스트 낭비 + 사용자가 `--rules`를 열면 "학습"이 아니라 "복붙"으로 보임.

### 1.4 statusline — 원하는 정보는 버리고, 보이는 정보는 틀림

`forgen statusline`(`src/core/statusline-cli.ts`) 실 출력 4줄:

```
Fable  |  ~/workspace/forgen  |  git:(main)
0 CLAUDE.md  |  45 rules  |  0 MCPs  |  30 hooks
✦ · recall 26 · surfaced 0 · 교정 +7(7d) · ROI↓ 0 · 차단 108(7d)
🔥0  🟡0  🥶5  💀0  🌱5
```

- 소스 주석 그대로: `Line 2: (TODO: context/usage — stdin spec 미확인으로 생략)`. Claude Code가 stdin으로 주는 `context_window.*`, `rate_limits.*`, `cost.*`를 **한 필드도 읽지 않는다** (`StdinPayload` 타입에 `session_id/model/workspace`만 선언).
- `0 MCPs`: `countMcps`(`:95-99`)가 `settings.json.mcpServers`만 센다. 실 MCP는 `~/.claude.json` 2개 + 플러그인 8개. `0 CLAUDE.md`는 정의상(cwd 깊이 2) 맞지만 글로벌 `~/.claude/CLAUDE.md`·rules를 세지 않아 사용자 인식과 어긋남.
- 3~4줄은 운영자 지표. surfaced 0 / hot 0을 매 턴 사용자 눈앞에 광고.
- 5초 파일 캐시(`CACHE_TTL_MS`). 흐름(`:239-254`): stdin을 먼저 읽어 세션별 모델을 기록한 **뒤** 캐시 판정 → D5 샘플 기록도 같은 자리에 두면 된다. 단 **캐시 파일이 전역 단일**(`:24-26`)이라 다중 세션에서 세션 A의 값이 5초 내 세션 B에 출력된다 — 컨텍스트 %를 넣는 순간 실제 오표시가 된다.

Claude Code statusline stdin 공식 필드 (code.claude.com/docs/en/statusline, 2026-10 확인):

| 용도 | 필드 | 비고 |
|---|---|---|
| 컨텍스트 | `context_window.used_percentage`, `remaining_percentage`, `context_window_size`, `current_usage.{input_tokens,cache_read_input_tokens,...}` | 1M 모델은 size로 구분 |
| 5시간 한도 | `rate_limits.five_hour.{used_percentage, resets_at}` | Pro/Max, 첫 응답 후 |
| 주간 한도 | `rate_limits.seven_day.{used_percentage, resets_at}` | 동일 |
| 지출 한도 | `rate_limits.spend_limit.{used_percentage, used_usd, limit_usd, period}` | 게이트웨이 한정 (v2.1.284+) |
| 비용 | `cost.{total_cost_usd, total_duration_ms, total_lines_added, total_lines_removed}` | 클라이언트 추정 |
| 플래그 | `exceeds_200k_tokens` | 고정 임계 |
| 갱신 | assistant 메시지마다 · `/compact` 후 · `resets_at` 도달 시 · `refreshInterval`(≥1s) | 300ms 디바운스 |

### 1.5 surfaced 0 · 프로필 reclass 부재 — 원인 조사 (Fable 디버거 2건, 읽기 전용, 격리 FORGEN_HOME dry-run)

**1.5a surfaced 0 — 게이트 버그 아님. 지식 베이스와 프롬프트의 교집합 부재 + 측정 오염.** (확신도 0.9)

- 주입 게이트는 `relevance ≥ 0.2`(cold-start) **AND** (`identifier ≥ 1` OR `태그 ≥ 2`) — `src/hooks/solution-injector.ts:588-604`. 오늘 실 프롬프트 9건 중 후보가 나온 4건은 전부 공통태그 1개("code"/"도구") 매칭, relevance 0.147~0.173 → 두 조건 모두 탈락. 7일 실 hook recall 354건 중 후보 있는 건 49건, 최고 0.268, 0.3 이상 0건.
- **반대 증거**: 같은 솔루션 10개로 격리 dry-run 했을 때 솔루션 태그와 겹치는 합성 프롬프트 3건은 0.24~0.42로 전부 주입 통과 → 파이프라인 정상.
- 원인은 (i) 라이브 솔루션 6개(retired 4는 인덱스 제외, `solution-index.ts:193-196`)의 태그가 추출 당시 문서 어휘(플러그인/rules/settings/json)라 오늘 주제(status-bar, codex 설치)와 겹칠 길이 없고, (ii) 회화체 한국어 프롬프트에서 `extractTags`(`solution-format.ts:535-558`)가 "같아", "왜냐면", "시켜보자" 같은 잔여물로 8칸을 채운다.
- **threshold는 레버가 아니다**: 0.2→0.15로 내려도 2차 게이트(tag≥2)에서 동일 탈락, 2차 게이트를 풀면 2026-04-21 감사의 'code' 단일 매칭 오염이 복귀.
- **측정 오염(버그)**: "7일 Recalls 773" 중 351건은 vitest 픽스처(react-hook, sol-0, vitest-mock-pattern…)가 `FORGEN_HOME` 격리 없이 프로덕션 `match-eval-log.jsonl`에 기록된 것 (`tests/mcp/solution-reader.test.ts`, `tests/plugin-coexistence.test.ts`). `stats-cli.ts:143`은 후보 0건·테스트 쿼리까지 "Recall hits"로 센다. "25회 recall에 0 surfaced"라는 그림 자체가 부풀려진 것.
- 기각된 가설: candidate 상태 제외(오히려 1.3배 가산, `solution-matcher.ts:89-97`), ROI 강등(`roi-demotions.json` 빈 객체), quarantine/private-filter, 세션 버짓 조기 return, retired 희석.
- **레버**: ① 테스트 격리(D1과 같은 뿌리 — §2 원칙 2) + Recall 집계를 `source=hook && candidates>0`만 "hit", 전체는 "attempts"로 분리 ② 쿼리 측 맥락 신호(cwd·최근 편집 파일·도구명)를 `extractTags` 입력에 합침 ③ 지식 베이스 규모·태그 품질 — 이 ADR 범위 밖(별도 결정).

**1.5b 프로필 4축 score 0.50 고정 · reclass never — 갱신 코드 경로 자체가 미구현.** (확신도 0.95)

- `axes.<axis>.score`는 `createProfile()`에서 0.5 리터럴로 한 번 세팅(`src/store/profile-store.ts:36-39`)된 뒤 **src 전체에서 다시 쓰는 코드가 없다.** `last_reclassification_at`도 같은 함수에서 null(`:52`)로 초기화된 뒤 쓰는 코드 없음. git 이력상 두 필드를 건드린 커밋은 v0.1.0 초기 커밋과 stats 표시 추가뿐 — "재분류"는 스키마·표시만 있고 산출 로직이 구현된 적이 없다.
- `profile-store.ts:120-122` 주석의 집계 공식 `confidence × facet_avg + (1-confidence) × neutral_anchor`는 구현체 없음. `meta-reclassifier.ts`는 이름과 달리 룰 enforce_via mech 승강급 전용(ADR-002)이며 profile을 읽지도 쓰지도 않는다.
- 450건 evidence가 하는 일: (1) `bumpAxisConfidence`(`:131-144`, 호출지 `src/forge/evidence-processor.ts:51-54`)로 confidence만 +0.02/+0.04 → 실데이터 0.53~0.65가 그 흔적 (2) auto-compound가 Haiku `profile_delta`로 facet을 직접 갱신(`src/core/auto-compound-runner.ts:681-731`, `saveProfile` 우회 raw write) → facet만 움직이는 이유 (3) 룰 승급·mismatch 추천. **score로 환산되는 단계가 없다.** `applyFacetDelta`(`evidence-processor.ts:94-126`)는 호출지 0인 dead export.
- `calibrate` 스킬(`skills/calibrate/SKILL.md:143-146`)은 Claude 세션이 수동 편집하는 설계, 산식 없음, 실행 흔적(calibration-log) 없음.
- **라벨 오기**: "Evidence: 450 corrections"(`src/core/inspect-cli.ts:64`)는 전체 evidence 수. 실제 `explicit_correction`은 **247건**(behavior_observation 189, session_summary 14). 7일 "21건"도 전체 기준(explicit은 7건). §1.1 표의 "교정 450건"은 이 라벨을 그대로 옮긴 것이므로 정정: **명시 교정 247건**.
- 기각: 트리거 미배선(호출될 함수 자체가 없음), 임계값, evidence 필터, 파일 불일치(모든 코드가 `ME_DIR/forge-profile.json` 사용, 루트 `~/.forgen/forge-profile.json`은 4/13 legacy 미사용), 예외 삼킴, 구버전 바이너리(설치본 0.5.9 = HEAD).
- **레버 (이 ADR 범위 내 결정)**: score 재계산 함수를 profile-store에 두고 `bumpAxisConfidence`·auto-compound facet 갱신 직후 호출 + `last_reclassification_at` 기록. 전제 조건 두 가지가 **오너 결정 항목**(§6-6): (i) facet→score 극성 정의(어느 facet이 + 방향인지 스펙 부재) (ii) auto-compound의 raw write를 `saveProfile`로 통합(동시 쓰기 시 bump 덮임). 공식이 합의되기 전까지는 **status에서 4축 score 줄을 숨기고 facet과 confidence만 표시**한다 — 출처 없는 0.50을 매 세션 보여주는 것이 §2 원칙 1 위반.

### 1.6 외부 맥락 (수렴)

Claude Code auto memory(v2.1.59, 2026-02~ 기본 on)가 교정을 알아서 흡수한다. "기억한다"는 더 이상 wedge가 아니다(ADR-010). 남는 wedge는 **기억했음을 증명하고, 가드가 정확함을 증명하는 것**. cross-session δ(0.71/0.50, forgen-cross-session-delta)는 실재하지만 사용자는 그 순간을 못 본다 — 이 ADR은 그 순간을 보이게 하는 것이다.

---

## 2. 결정 원칙 (D0~D5 공통)

1. **출처 없는 숫자는 표시하지 않는다.** status/statusline의 모든 수치는 한 번의 명령으로 개별 영수증(로그 라인)까지 내려갈 수 있어야 한다. 내려갈 수 없는 수치(현 Bypass)는 삭제한다.
2. **테스트·eval은 실 상태를 오염시킬 수 없다.** session_id `default`(= 훅이 session_id 없이 호출됨)는 통계에서 제외하고, 테스트 하네스는 `FORGEN_HOME`을 강제 격리한다.
3. **"적용됨"과 "관련됨"과 "검사 통과"를 구분해 표기한다.** 관측 못 하는 것을 관측한 것처럼 쓰지 않는다.
4. **사용자용 1줄, forgen용 1줄.** statusline은 2줄. 운영자 지표는 `forgen status`로 내린다.
5. **예측치는 근거가 부족하면 숨긴다.** 틀린 예측 하나가 맞는 예측 열 개를 무효화한다.

---

## 3. Decisions

### D0 — 차단·안내 메시지에 원 교정을 인용 (가장 싼 체감, 즉시)

**무엇을**
- Mech-A/B 차단 메시지(`block_message`)와 룰 렌더(`v1-rules.md`, Codex 주입 블록)에 **룰의 출처 교정 날짜·종류(·문장)**를 붙인다. **정직성 정정(critic D0)**: evidence.summary 는 correction-record 를 호출한 *모델이 쓴 문장*이고 실데이터 12/12 에서 rule.policy 와 동일하며, `raw_payload` 에 사용자 원문 필드는 **없었다**. 따라서 (i) 지금 데이터로는 `[forgen] 이 룰의 출처 — 2026-09-30 교정 기록 (avoid-this)` 처럼 날짜·종류만 표기하고 policy 와 같은 문장은 중복 인용하지 않는다 (ii) correction-record 도구에 `user_quote`(사용자 발화 원문, `<private>` 필터 후) 를 추가해 **앞으로 기록되는 교정부터** `… 당신의 말: "…"` 로 인용한다 (iii) 인용문은 한 줄·꺾쇠/백틱/제어문자 제거·90자 제한으로 sanitize 한다.
- 차단 시 Claude에게 보이는 메시지에도 같은 인용을 넣어, 사용자가 차단 사유를 읽을 때 "내가 그렇게 말했지"를 바로 확인한다.
- critic 지적: 이 한 줄이 체감의 큰 부분을 가장 싸게 만든다. 이 안의 **최소형에 포함**한다.

### D1 — 차단 영수증 + 오탐 되먹임 (precision 가시화)

**무엇을**
- `violations.jsonl` 스키마 확장(추가 필드만, 기존 리더 호환): `matched`(매칭 패턴/프래그먼트와 오프셋), `target_kind`(`command|response|file`), `target_hash`(전문 sha256 앞 16자 — 전문은 저장하지 않음; 민감정보 회피), `verdict`(`null|correct|false_positive`), `verdict_at`.
- 전문은 `state/enforcement/receipts/<violation_id>.txt`에 **24시간 TTL**로만 보관 (영수증 열람용). TTL 후 hash만 남음. **저장 전에 secret-filter의 마스킹 규칙을 통과**시킨다 — 차단 대상이 비밀키인 경우 영수증이 그 키를 평문 보관하면 안 된다.
- `forgen status --blocks [N]`을 영수증 뷰로: 룰·매칭 프래그먼트·전후 문맥 3줄·출처 세션. 각 항목에 `forgen block <id> --ok | --fp` 로 판정. 판정은 `verdict`에 기록.
- **자동 판정 (오너 결정 2026-10-06: "안 누를 것 같다, 자동으로")**: 차단 직후 background로 Haiku 심판을 띄운다 — auto-compound와 같은 `execHost` 경로·같은 consent 플래그(ADR-012 `compound-consent`)·같은 `FORGEN_NESTED_RUN` 재귀 가드. 입력은 영수증(룰 policy + 원 교정 문장 + 매칭 프래그먼트 + 전후 3줄, secret 마스킹 후), 출력은 `{verdict: correct|false_positive|unsure, reason}`. `unsure`는 미판정으로 남긴다. 사용자 `forgen block <id> --ok|--fp`는 자동 판정을 **덮어쓴다**(사람 > 모델, `verdict_by` 필드로 구분).
  - 안전장치: 하드 룰(`L1-*`)과 빌트인 `dangerous-response-pattern`은 자동 판정으로 **advise 강등되지 않는다** — precision만 표시하고 강등은 사용자 판정이 있을 때만. 비용 상한: 세션당 10건, 일 30건(실측 7d 실 차단 30건이면 주 30회 Haiku ≈ 무시 가능). 심판 실패·타임아웃은 미판정.
  - precision = correct / (correct + false_positive), 미판정 제외. `forgen status`에 룰별 precision·판정 출처(auto/user)·미판정 수 표시. 7d precision < 0.5 이고 판정 ≥ 5인 룰은 자동으로 `advise`(기록만, block 안 함)로 강등하고 사용자에게 알림. 복귀는 사용자 명시(`forgen rule <id> --enforce`).
- **Bypass 지표 삭제.** `bypass-detector`(자연어 휴리스틱) 기록 경로를 끄고(`post-tool-use.ts:393-397`), T3(`trigger-t3-bypass`)의 입력을 사용자 명시 우회 기록으로 교체. 단 **현행 `kind:'correction'`은 쓸 수 없다** — 그 채널에는 이미 메타가드 advise 87건(fact-vs-agreement 86·self-score 1)이 섞여 있어 kind만 보면 "사용자 우회"로 둔갑한다(critic). `FORGEN_USER_CONFIRMED` 우회는 **`kind:'bypass_confirmed'`를 신설**해 기록하고(`pre-tool-use.ts:447-456`, `stop-guard.ts:579-587` 두 지점), T3는 그것만 센다. 기존 `bypass.jsonl`은 삭제하지 않고 읽지 않는다(역사 보존).
- session_id `default`·`unknown`·빈 값(`stop-guard.ts:540` 폴백) 이벤트는 모든 집계에서 제외하고 status 에 "Excluded N" 으로 가시화(원칙 1). **한계(critic)**: 값 기반 필터라 eval/probe 하네스가 쓰는 임의 id(`forgen-eval-*`, `repro-*` 등 전체 기간 41건, 현재 30d 창엔 0건)는 걸러지지 않는다 — eval 러너는 `FORGEN_HOME` 격리로 돌리는 것이 전제(forgen-cross-session-delta 교훈과 동일). 이벤트 제외 기준은(원천: `pre-tool-use.ts:395` 등 `?? 'default'` 폴백; Codex 훅은 thread id를 session_id로 넘기므로(`src/host/codex-hook-alive.ts:33-38`) 실 세션이 제외되지 않음). 재발 차단은 **dist 훅을 spawn하는 테스트 전수**(dist 훅 spawn형 테스트 **20개 파일** 전수 — `rm -rf /` 프로브는 8개 파일, 샌드박스는 `e2e/claude-integration`뿐)에 `HOME: mkdtemp` 강제 — `tests/e2e/claude-integration.test.ts:46-53`에 이미 있는 패턴. **vitest `globalSetup`에서 `FORGEN_HOME` 전역 강제는 하지 않는다**: `paths.ts:21`이 env를 homedir mock보다 우선하므로 `homedir: () =>`를 mock하는 테스트 78개가 깨지고, globalSetup env는 워커에 전파되지도 않는다 (critic 지적).
- 같은 뿌리의 오염 2건도 같은 커밋에서: `match-eval-log.jsonl`에 픽스처를 쓰는 `tests/mcp/solution-reader.test.ts`·`tests/plugin-coexistence.test.ts` 격리(§1.5a).
- `L1-no-rm-rf-unconfirmed` 오탐 축소. **리터럴 `/tmp` 예외만으로는 14건 중 1건만 해결된다** (critic 전수 확인: 리터럴 `/tmp/...` 1, `rm -rf $S`·`"$T"`·`$S/v1dbg` 류 변수 경로 7, heredoc 안 묻힘 5, `~/.cache/...` 정탐 1). 제안: 패턴 매칭 전에 **같은 명령 안의 직전 대입**(`S=/tmp/...; rm -rf $S`)을 한 단계만 치환해 리터럴로 환원한 뒤 `/tmp`·`$TMPDIR`·`/var/folders`·Claude scratchpad(`/tmp/claude-*`) 접두를 예외. 예상 해결 ≤8/14, 나머지(heredoc·홈 하위)는 영수증 판정으로 남긴다. 사용자 하드 룰이므로 **예외 추가 자체가 오너 승인 항목** (§6-1).

**대안**
- A1 (최소형): 집계에서 `default` 제외 + Bypass 삭제만. 영수증·판정 없음. → 숫자는 정직해지지만 precision은 여전히 못 잼.
- A2 (이 안): 영수증 + 사용자 판정 + precision 강등.
- A3 (이상형 → **채택**, 오너 결정): A2 + Haiku 자동 판정. 오판 위험은 하드 룰 강등 제외 + 사용자 덮어쓰기로 봉합.

### D2 — 적용 룰 가시화 ("저번에 말한 게 지금 먹었다"의 순간)

**무엇을**
- **턴 단위 룰 관련도**: UserPromptSubmit에서 프롬프트를 룰 `trigger`/policy와 매칭(solution-matcher와 같은 term 매칭 재사용, 임계 보수적). 결과를 `state/turn-rules-<session>.json`에 기록 — statusline이 읽음. 표기는 "**관련 룰 N**"(적용 아님).
- **Stop 검사 통과 기록**: `stop-guard`가 **실제 평가한** Mech-A/B 룰의 통과를 **별도 파일 `state/enforcement/checks.jsonl`**에 기록한다. `violations.jsonl`에 `kind:'pass'`를 넣지 않는다 — critic 확인: T2 집계(`signals.ts:100-104`, `:118-121`)·`--blocks`(`explain-cli.ts:70-85`, `kind ?? 'block'`)·watch·inspect·lifecycle-cli 전부 kind 필터가 없어 통과가 위반으로 집계·표시된다. (기존 결함: `kind:'correction'`도 지금 T2에 위반으로 세어진다 → **선행 버그픽스**로 분리, 1단계.)
  - 표기는 세 상태를 구분: **평가됨·통과 / 위반 / 해당 없음(트리거 불일치로 미평가)**. `evaluateStop`(`stop-guard.ts:303-312`)은 첫 위반에서 return 하므로 그 뒤 룰은 "미평가"로 기록. 정직 표기: Stop 훅을 가진 활성 룰은 45개 중 **6개**뿐이라 "검사 N 통과"의 N은 작다 — 체감의 주력은 관련 룰·원 교정 연결이다.
- **영수증 연결**: 관련 룰 N을 클릭/명령으로 열면 각 룰의 **원 교정 문장과 날짜**("2026-09-29 '분석할 때마다 페이블로 작업해'")가 보인다. 이것이 체감의 핵심 — 룰이 아니라 *내가 한 말*이 보여야 한다.
- 모델 인용 태그(`<forgen-applied>`)는 **이번에 하지 않는다**(§5).

**대안**
- B1 (최소형): Stop 통과 기록만. → "검사 N 통과"는 Mech-A/B 가진 룰(현 45개 중 소수)에만 해당, 대부분 룰은 영원히 안 보임.
- B2 (이 안): 관련도 + 통과 기록 + 원 교정 연결.
- B3 (이상형): 모델에 인용 태그 요구 → "적용 N" 정확 표기. → 토큰 비용 매 턴, 모델 순응 미측정, 인용 누락 시 오히려 신뢰 하락. forgen-eval로 순응률 측정 후 재검토.

### D3 — 룰 병합 (채굴 룰끼리만 · explicit과는 링크만)

**무엇을**
- 병합은 **채굴 룰(`behavior_inference`)끼리만**. explicit 룰로의 흡수는 하지 않는다 — critic 지적대로 흡수하면 ADR-013 불변식 두 개가 깨진다: (i) 합산된 `evidence_refs`가 `strengthForConfidence(laplaceConfidence(N))`(`evidence-store.ts:283-289`, `correction-clustering.ts:83-87`, N≥2→strong) 경로로 **환각 교정 1건이 explicit 룰을 strong으로 올릴 수 있고**, (ii) "auto: 네임스페이스는 실시간 교정과 절대 충돌/억제 안 함"(ADR-013 §D 67행)에 반한다.
- 채굴 룰이 explicit 룰과 같은 개념이면 **`related_to` 링크만** 걸고 렌더에서 숨긴다(explicit 쪽에 "채굴 관측 N회" 표시 — `evidence_refs`에는 합산하지 않음, strength 불변). 사용자에게는 "당신이 9/29에 말한 룰을 이후 세션에서 N번 더 관측" 으로 보인다 — 체감 목적은 그대로 달성.
- 채굴끼리 병합 결과의 strength는 `default` 고정(ADR-013). 병합 룰의 TTL은 **가장 오래된 원본의 `created_at`** 기준(재채굴로 TTL 연장 금지 — `evidence-store.ts` 기존 carry-forward 원칙과 동일).
- 생성 시 **사전 중복 검사**: `promoteSessionCandidates`에서 render_key 조회 앞에 의미 매칭(현 클러스터링 term 매칭 재사용). 채굴끼리 매칭 → 기존 채굴 룰 `evidence_refs`에 추가; explicit과 매칭 → 새 룰 안 만들고 `related_to` 관측 카운트만 증가.
- **캡 재정의**: ADR-013의 "라이브 총량 30"을 **개념(클러스터) 수 30**으로 — 지금처럼 30→8로 줄이면 여유 22가 run당 3개씩 같은 변형으로 재증식한다(critic).
- 1회성 정리: 현재 채굴 30개 → 채굴끼리 병합 + explicit 동개념은 링크·숨김. 예상 렌더 노출 30 → ≤5. 원본은 `superseded` + `clustered_into`, `forgen rules unmerge`로 복원.
- 렌더 축소 효과는 `v1-rules.md` 글자 수와 Codex 주입 블록 바이트(ADR-016 10KB 스필 임계)로 측정해 기록.

**대안**
- C1 (최소형): 1회성 수동 병합만. → 다음 채굴에서 재발.
- C2 (이 안): 생성 시 중복 검사 + 채굴끼리 주기 병합 + explicit 링크 + 개념 캡.
- C3 (이상형): 임베딩 기반 의미 동일성. → 외부 의존/비용. term 매칭 실패 사례가 측정되면 재검토.
- (기각) 채굴→explicit 흡수: ADR-013 위반.

### D4 — statusline 2줄 재설계

**무엇을**
```
Fable · ~/workspace/forgen(main*) · ctx 42%/1M · 5h 63% → 15:40 소진 (리셋 16:20) · 7d 21% 여유 · $1.23
관련 룰 3 · 검사 4 통과 · 차단 1 (판정?) · 학습 0
```
- 1줄(사용자): 모델 · 경로/브랜치 · 컨텍스트 %(창 크기 표기, 1M이면 `/1M`) · 5h/7d 한도와 소진 예측(D5) · 비용. 색: 한도 ≥80% 노랑, ≥95% 빨강. `exceeds_200k_tokens`면 ctx 옆 `⚠200k`.
- 2줄(forgen): D2의 관련 룰/검사 통과, 이 세션 차단 수와 미판정 표시(`(판정?)` = D1 영수증 대기), surfaced 수. 운영자 지표(recall, ROI↓, 이모지 분포)는 `forgen status`에 이미 있으므로 statusline 에서 **삭제**. CLAUDE.md/MCP/hook 카운트는 어느 뷰로도 옮기지 않고 **삭제**(MCP 카운트는 틀린 값이었고, 나머지는 요청이 없었다 — critic 정정: "옮겼다"는 사실이 아니었음). `rate_limits.spend_limit`(게이트웨이 전용)은 **지원하지 않음**.
- `StdinPayload`에 공식 필드 타입 추가. 캐시(critic 2라운드): 1줄(사용자)은 **매 호출 렌더**(ctx% 가 메시지마다 바뀌어 지문 캐시는 무력), 2줄(forgen, computeStats ~150ms)만 **세션별 15초 TTL 캐시**(`statusline-cache-<session_id>.txt`). 전역 단일 캐시는 다중 세션에서 남의 컨텍스트 %를 보여주므로 폐기, 구 `statusline-cache.txt` 도 state-gc 가 정리. 샘플 기록(D5)은 매 호출. **라이브 전제 정정(critic)**: `settings.json` 의 `statusLine.command` 는 `forgen statusline` = 글로벌 npm 패키지 → ship(글로벌 재설치) 전까지 statusline 은 구버전이 돈다(훅만 워크스페이스 dist). 실세션 관측은 ship 후 수행.
- ADR-010 §2b가 남긴 `buildUsageLine` "native /usage로 이동" 1회 공지(`:164-178`)는 제거 — 본 ADR이 그 결정을 부분 supersede.
- 데이터 없을 때(API 키 사용자 등 `rate_limits` 부재): 해당 세그먼트 생략, 자리 채우기 금지.

**대안**
- S1 (최소형): 현 4줄 유지 + 1줄에 ctx/한도만 추가. → 틀린 카운트·운영자 지표가 그대로 남아 신뢰 하락 지속.
- S2 (이 안): 2줄 재설계.
- S3 (이상형): claude-hud처럼 설정 가능한 세그먼트 시스템. → 지금 필요 없음. 2줄 고정 후 요청이 쌓이면.

### D5 — 한도 소진 예측

**무엇을**
- statusline 호출마다 `{t, five_hour.used, five_hour.resets_at, seven_day.used, seven_day.resets_at}`를 `state/rate-limit-samples.jsonl`에 append (계정 단위 한도라 세션 혼합 무방; 7일 TTL 로테이션).
- 기울기 (critic SEV-1 반영): 지수이동평균은 폐기 — 계단형(API 응답 시점 점프)·불균일 간격 데이터에서 27배 과대 추정(30분 정체 후 20초 +1% → 54%/h 경보). **창 안 양끝점 기울기** `(used_last − used_first)/(t_last − t_first)` 로 교체(시간 가중, 점프 순서 무관). 창별 최소 시간 폭 5h 15분 / 7d 2시간, 창 내 총 증가 < 1%p(양자화 잡음)면 숨김. 표시 게이트: **현재 페이로드에 그 창이 수치로 있을 때만** 출력 — 파일 샘플은 기울기 전용(리셋 순간 CC 가 창을 drop 하고 재실행하므로, 파일만 보면 리셋 전 최고치가 뜬다). `resets_at` 경과 창 숨김. **창 리셋 조건**(공식 문서 2026-10-06 확인: five_hour는 `resets_at`을 가진 창, 지나면 창 객체가 사라졌다 재등장하고 초기엔 `used_percentage`가 null일 수 있음): `resets_at` 변화 · 창 객체 부재→재등장 · 사용률 하락 · `used_percentage` null → 이전 샘플 폐기, null 샘플은 기록하지 않음.
- 기록은 **한 줄 단일 `appendFileSync`**로, 읽기는 파싱 실패 라인 무시(`signals.ts:44-57` `readJsonlSafe` 패턴) — Claude Code가 statusline 스크립트를 중간에 취소하면(공식: "cancels the in-flight script") 잘린 줄이 생긴다.
- 갱신은 이벤트 구동(assistant 메시지마다)이라 **유휴 중엔 샘플이 안 쌓인다** — `refreshInterval`(≥1s) 설정을 forgen install이 넣을지는 오너 결정(§6-7). 넣지 않으면 유휴 복귀 직후 예측이 숨겨지는 것이 정상 동작.
- 출력: 예상 100% 도달 시각 `T_exhaust`. `T_exhaust < resets_at`면 "→ HH:MM 소진 (리셋 HH:MM)" 노랑/빨강, 아니면 "여유 (리셋 시 예상 N%)".
- **숨김 조건**: 창 내 샘플 < 3, 또는 창 내 시간 간격 < 5분, 또는 기울기 ≤ 0. 이때는 사용률만 표시.
- 컨텍스트: 세션별 턴당 증가량 EMA → "~N턴 남음"(컴팩션 임계는 Claude Code 자동 컴팩션 기본값 기준, 설정 가능). 샘플 < 3이면 숨김.

**대안**
- P1 (최소형): 예측 없이 사용률 + 리셋 시각만. → 오너 요청 미충족.
- P2 (이 안): 선형 기울기 + 숨김 조건.
- P3 (이상형): 시간대별 사용 패턴 학습. → 데이터가 쌓인 뒤(≥2주) 재검토.

---

## 4. 가중 트레이드오프 매트릭스

최소형에는 D0(원 교정 인용)을 포함한다 — critic 지적대로 D0 없는 최소형은 이 안을 고르기 위해 일부러 약하게 짠 것이었다.

| 기준 | 가중 | 최소형 (D0 + A1/B1/C1/S1/P1) | **이 안 (D0 + A2/B2/C2/S2/P2)** | 이상형 (A3/B3/C3/S3/P3) | 점수 근거 |
|---|---|---|---|---|---|
| 체감 — "내 말이 먹었다"가 보이는가 | 30% | ★★★ | ★★★★ | ★★★★★ | 최소형도 D0로 차단 순간엔 보임. 이 안은 차단 없는 턴에서도(관련 룰·원 교정) 보임. 이상형은 "적용 N" 정확 표기 |
| 숫자의 정직성 (출처 추적 가능) | 25% | ★★★ | ★★★★★ | ★★★★ | 최소형은 default 제외·Bypass 삭제로 틀린 숫자는 없어지나 precision 없음. 이상형은 LLM 판정이 출처를 흐림 |
| 오탐 되먹임이 가드를 실제로 개선하는가 | 15% | ★ | ★★★ | ★★★★ | 최소형 없음. 이 안은 사용자 판정 의존(미판정 리스크 → ★3). 이상형은 자동 판정으로 커버리지↑ |
| 구현 비용·위험 (Type 2 유지) | 15% | ★★★★★ | ★★★ | ★ | 이 안은 스키마 추가·캐시 분리·테스트 20파일 수정. 이상형은 임베딩·LLM 비용 |
| 토큰·런타임 비용 (매 턴) | 15% | ★★★★★ | ★★★★ | ★★ | 이 안은 UserPromptSubmit term 매칭 1회 추가(solution-matcher와 동급, ~ms). 이상형은 매 턴 인용 토큰 |
| **가중 합** | 100% | 3.4 | **4.0** | 3.4 |  |

최소형과 이상형이 동점이고 이 안과의 차이가 0.6이다. **차이를 만드는 것은 정직성과 되먹임**이며, 오너가 "판정은 안 누를 것 같다"고 판단하면 최소형이 맞다 (§6-2).

## 5. 하지 않는 것 (정직 표기)

- 모델 인용 태그로 "적용 N" 표기 (B3) — 순응률 미측정.
- `bypass.jsonl` 삭제 — 읽지 않을 뿐 보존.
- statusline 세그먼트 설정 시스템 (S3).
- 채굴 룰이 explicit 룰을 바꾸는 병합 — ADR-013 불변식.
- ADR-016 Codex 15k자 스필 자체의 수정 — D3의 부수 효과만 측정.

---

## 6. 오너 결정 필요 항목

1. **(결정됨 — 기본값 적용)** 평문으로: "확인 없이 폴더 통째로 지우지 마라"는 오너의 하드 룰인데, 지난주 실 차단 14건 중 13건은 Claude가 **자기 임시 작업 폴더**(`/tmp/claude-*/scratchpad`)를 지우려다 막힌 것이다. 오너 파일이 아니므로 막을 가치가 없다. 기본값: **Claude 임시 폴더 삭제는 확인 없이 허용**(같은 명령 안에서 `S=/tmp/...; rm -rf $S`처럼 변수로 쓴 경우까지 한 단계 치환해 인식). 홈 하위·프로젝트 경로 삭제는 지금처럼 계속 막는다. 나머지 애매한 건(heredoc 안 등)은 자동 판정에 맡긴다.
2. precision < 0.5 자동 강등의 임계(0.5)와 최소 판정 수(5). 하드 룰(L1-*)은 강등 대상에서 제외할지.
3. statusline 1줄 구성 확정 (§D4 예시). 비용(`$`) 표시 여부.
4. 소진 예측 숨김 조건(샘플 3, 간격 5분)과 색 임계(80/95%).
5. D3 1회성 병합을 오너가 결과를 보고 승인할지(dry-run 출력 → 승인 → 적용), 자동으로 할지.
6. `refreshInterval`을 forgen install이 statusLine 설정에 넣을지(유휴 중 소진 예측 갱신 vs 1초마다 프로세스 spawn).
7. **(결정됨)** 판정은 자동(Haiku). 사용자 판정은 선택적 덮어쓰기.
8. **(결정됨 — 즉시 구현)** 프로필 4축 score 공식. 새 스펙 없이 기존 facet 카탈로그(`src/preset/facet-catalog.ts`, 출처 `docs/plans/2026-04-03-forgen-facet-catalog.md`)에서 도출: 각 축의 양 끝 팩 centroid를 0과 1로 두고(품질 보수형→속도형, 자율성 확인우선형→자율실행형, 판단 최소변경형→구조적접근형, 커뮤니케이션 간결형→상세형 — `onboarding.ts:56-78`의 score→pack 방향과 동일), 현재 facet 벡터를 그 선분에 **투영**한 t(0~1 clamp)를 facet 위치로 삼는다. 최종 `score = confidence × t + (1 − confidence) × 0.5` (`profile-store.ts:120-122` 주석의 공식 그대로, neutral_anchor 0.5). `bumpAxisConfidence`와 auto-compound facet 갱신 직후 재계산하고 `last_reclassification_at`을 기록. auto-compound의 raw write는 `saveProfile` 경유로 통합. 표시: score 옆에 축 방향 라벨(예: `자율성 0.78 → 자율 실행형 쪽`).
   - 나머지 미결 항목 기본값: §6-3 D4 예시 구성 그대로(비용 표시 포함), §6-4 제안값 그대로, §6-5 병합은 dry-run 출력 후 **자동 적용**(오너 "자동으로"), §6-6 `refreshInterval`은 넣지 않음(유휴 중 프로세스 spawn 회피; `resets_at` 도달 시 자동 갱신으로 충분).

---

## 7. 검증 계획 (완료 선언 조건)

- D0: 격리 환경에서 explicit 룰 차단 → 메시지에 원 교정 문장·날짜 인용 확인(스냅샷).
- D1: 격리 `FORGEN_HOME`에서 실 훅 차단 → `forgen status --blocks` 영수증에 매칭 프래그먼트 표시 → `--fp` 판정 → status precision 반영 → 임계 미달 룰 advise 강등. 영수증에 가짜 AWS 키를 넣어 마스킹 확인. **spawn형 테스트 20파일 전수 점검 후** vitest 전체 실행 → 실 `violations.jsonl`·`match-eval-log.jsonl` 라인 수 **0 증가**(전/후 `wc -l`). `bypass_confirmed` 신설 후 T3가 advise 87건을 세지 않음(단위 테스트).
- D2: 실세션에서 "한국어로 답해" 룰이 관련 룰로 잡히고, Stop 통과가 `checks.jsonl`에 기록되며 `violations.jsonl`은 변하지 않음. **explain/inspect/watch/lifecycle 출력 스냅샷**이 전/후 동일. 선행 버그픽스(T2 kind 필터)는 `correction` 87건을 제외한 집계로 회귀 테스트.
- D3: dry-run 병합 결과(30 → N) 출력, unmerge 왕복 테스트, `v1-rules.md` 글자 수 전/후.
- D4/D5: 공식 샘플 페이로드로 2줄 렌더 스냅샷 테스트(`rate_limits` 부재·null·창 재등장 케이스 포함); 샘플 jsonl에 합성 시계열·잘린 줄 주입 → 소진 시각·숨김 조건·파싱 내성 단위 테스트; **두 세션 동시 호출**에서 캐시가 섞이지 않음(세션별 파일); 실세션 1시간 statusline 관측 기록.
- 체감 KPI(2주 후 `forgen status`에 표시): 미판정 차단 비율, 룰별 precision, 관련 룰 ≥1인 턴 비율, statusline 소진 예측 적중(예측 vs 실제 리셋 전 100% 도달 여부).

---

## 7b. 구현 진행 (2026-10-06, 브랜치 feat/adr-017-trust-receipts)

| 항목 | 상태 | 커밋/비고 |
|---|---|---|
| 프로필 score 공식 + reclass 스탬프 + 라벨 정정 | 완료 | 9e6ee17 — critic 반영(스탬프 불변식, locale 라벨, hasOwn) |
| D0 출처 인용 | 완료 | 4e46a31 — critic 반영: summary 는 모델 문장이라 날짜·kind 만, `user_quote` 신설, sanitize, 동적 import |
| D1 1단계 집계 정직화·테스트 격리 | 완료 | 4e46a31 — Blocks 108→33, Bypass 179→0, Recall hits/attempts/mcp 분리, Excluded 가시화, 전체 suite 실행 시 실 로그 증가 0 |
| D4/D5 statusline 2줄 + 소진 예측 | 구현 완료, critic 2라운드 PASS(SEV-1 3건 해소) + r2 지적 2건 반영(압축을 append 앞으로·10MB 회전 백스톱, 모델 캐시 FORGEN_HOME 존중). 2줄 캐시 15초라 '이 세션 차단'은 최대 15초 지연(수용) | REJECT(SEV-1 3건: 비라이브·stale 샘플 표시·EMA 과대) → 양끝점 기울기·표시 게이트·2줄 캐시 분리·압축 가드로 수정. 실세션 관측은 ship 후 |
| D1 2단계 영수증·자동 판정·precision·scratchpad 예외 | 구현 완료, critic 대기 | violation_id·matched·target_hash·receipts/(24h, secret 마스킹 — 로그의 matched/preview 도 마스킹)·verdicts.jsonl(user>auto)·`forgen block <id> --ok/--fp`·Haiku 심판(consent·캡·unsure)·advise 강등(하드/builtin 제외)·`isTempOnlyRm`(같은 명령 변수 1단계 치환, 보수적)·checks.jsonl 통과 기록 |
| D2 관련 룰 | 구현 완료 | `rule-relevance`(임계: 일반 용어 2개 또는 식별자급 1개 — 영문 ≥6자/**한글 ≥3음절**(지시의 '6자'는 한글에 비현실적이라 조정), 공통어 제외) + `turn-rules-<session>.json`(프롬프트 해시만, 원문 저장 안 함, 주입 0바이트) + statusline "관련 룰 N" + `status --turn`(원 교정 연결). 실측: "한국어로 답해줘"→1(응답 언어 룰), "fgx --codex"→0, "병렬 에이전트로 설계 검증해"→16(D3 병합 전 중복). 성능 warm 4.4ms/룰 100개. Stop 검사 통과는 `checks.jsonl`(D1 커밋) |
| D3 채굴 룰 병합 | 구현 완료 | 격리 복사본 실측 **채굴 30 → 7**(병합 18, explicit 링크 9), 활성 45 → 22, 멱등, unmerge 왕복. explicit evidence_refs/strength 불변(ADR-013 유지), `mined_observations` 로 관측 수 표시. 판단: 클러스터링은 **category 경계 유지**(무시하면 전이 연결로 10+19 두 덩어리로 섞임 — ADR 예상 ≤5 는 미달, 7). τ=0.3 에서 오탐 링크 1건(어휘 "사용자가 명시적으로" 중복) — dry-run 기본이라 오너가 걸러냄; explicit 링크 τ 상향(0.4)은 후속 결정. 실 적용(`rules merge-mined --apply`)은 ship 후 오너 확인 하에 |

## 8. 구현 순서 (합의 후)

0. **프로필 score 공식 구현 + reclass 기록 + 라벨 정정** — 오너 "빨리". 반나절.
0'. D0 원 교정 인용 — 반나절. 가장 싼 체감.
1. D1 집계 정직화(default/unknown 제외·Bypass 삭제·`bypass_confirmed`·T2 kind 필터 선행 픽스·spawn 테스트 20파일 격리) — 1일. status 숫자가 맞아진다.
2. D4+D5 statusline — 1일. 오너 체감 가장 빠름.
3. D1 영수증·자동 판정(Haiku)·precision — 2일.
4. D3 병합 — 1일 + 오너 승인.
5. D2 관련 룰·통과 기록 — 1일.
6. §1.5 후속: (a) 테스트 격리(match-eval-log 오염 2개 테스트)와 Recall hit/attempts 분리 — 1단계에 합류 (b) inspect-cli 라벨 "corrections" → explicit만 집계 — 1단계에 합류 (c) 4축 score 줄 숨김 — 1단계에 합류 (d) score 공식 구현은 §6-8 결정 후 별도.

각 단계 완료 시 fresh-context critic 리뷰 후 다음 단계(오너 룰).

---

## 9. 장기 리스크와 측정 부채 (critic 지적, 범위 밖은 백로그)

| 항목 | 영향 | 처리 |
|---|---|---|
| 통과 기록이 `violations.jsonl`에 섞이면 사후 분리 불가 | 높음 | D2에서 별 파일로 확정 (Type 2 유지) |
| 채굴→explicit 흡수 시 ADR-013 보장 소실 | 높음 | D3에서 기각 |
| ADR-010 철수 결정의 암묵 번복이 선례화 | 중 | 헤더에 부분 supersede 명시 |
| `rotateIfBig`(10MB 단순 rename) 이후 explain/stats가 로테이션 파일을 못 읽음 — 기존 결함, 기록 증가로 더 자주 노출 | 중 | 백로그 (D2 `checks.jsonl`은 자체 7일 TTL로 10MB에 안 닿게 설계) |
| L1 룰 `lifecycle.violation_count:0`인데 실 위반 92건 — lifecycle 카운터 미갱신 (ADR-002 T2 측정 부채) | 중 | 백로그 — D1 집계 정직화와 같은 뿌리, 별도 ADR 또는 ADR-002 보정 |
| `kind:'correction'`이 T2 위반으로 집계되는 기존 결함 | 중 | §8-1 선행 픽스 |
