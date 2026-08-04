# ADR-013: 교정 포착 개선 — correction-aware retroactive mining

**Status**: Accepted (2026-08-04) — 구현 완료, adversarial critic 2라운드 통과.
**Reversibility**: Type 2 (가역 — 프롬프트/배선/게이트, 롤백 용이)
**관련**: ADR-012(auto-compound 동의), [[forgen-cross-session-delta]]
**근거**: 3-에이전트 병렬 조사(signal/convo/assets) 실측 종합, 2026-08-04.

## Context

forgen 학습의 입력 = "사용자 교정 포착". 포착 채널 ①(실시간 correction-record, 내 판단)이
**퍼지**하다("표현이 사람마다 다름"). 이 퍼지함을 개선할 수 있는가?

**병렬 조사 3건이 독립적으로 수렴한 실측:**

1. **agent-signal — implicit-feedback 텔레메트리는 틀린 신호공간**: 실교정 15건 vs implicit 신호
   3600건 → precision **<0.15%**. revert는 15건 중 **0건** 선행. 근본원인: 실교정이 전부
   **판단/접근 레벨**("mock으로 완료선언 마", "프로덕션 확인 먼저")이라 edit-count/revert에
   지문을 안 남김. → **implicit-feedback → 룰 배선 금지.** (부수: drift-score.ts:101 hardcap
   cooldown 부재 = drift_critical 이 세션길이 카운터, 별도 버그.)

2. **agent-convo — prompt-time regex 탐지는 노이즈**: 실교정 ~40% 부정어, ~60% soft/긍정형.
   최고가치 룰(critic-review)="돌려봐" = 어휘신호 0. next-turn 위치 판별력 0(에이전트 세션은
   사용자 턴 ~100%가 assistant 직후). 결정론 nudge precision 25~50%, 다시/말고/빼(흔한 담화어)가
   최다 FP. → **강제 분류기 금지.** 유일 leverage = **retroactive LLM 패스가 사용자 턴을
   assistant before/after 액션 맥락과 함께 재독** → 긍정형·counterfactual 교정까지 포착.

3. **agent-assets — 학습기계 완비, 다리만 없음**: Pipeline A(교정→evidence→promote→cluster→
   enforce_via)는 완전 배선. implicit-feedback + **②의 session_summary corrections 둘 다 DEAD END**
   (수집/로깅되나 룰 안 됨). roi-demotion 상태머신 = 노이즈 채널 필터 템플릿.

**crux (코드 확인)**: ADR-012로 켠 ②(Haiku)가 `corrections`를 뽑지만 — (a) 프롬프트가 명시
마커만 찾고(runner:588 "명시 교정만"), (b) `type:'session_summary'`로 저장(runner:612)돼
`promoteSessionCandidates`(evidence-store:174, `explicit_correction`만)가 **절대 승급 안 함**.
**②를 켜도 그게 찾은 교정조차 룰이 안 되는 두 번째 데드엔드.**

## Alternatives + Trade-off Matrix

| 기준 | 가중 | A 현상유지 | B prompt-time nudge | **C retroactive mining** | D B+C |
|---|---|---|---|---|---|
| 포착 recall 개선 | 30% | ★ | ★★ | ★★★★ | ★★★★ |
| precision(노이즈 억제) | 25% | ★★★★★ | ★★ | ★★★★ (ROI필터) | ★★★ |
| 재사용(기존 자산) | 20% | ★★★★★ | ★★★ | ★★★★★ | ★★★ |
| 구현 복잡도(낮을수록↑) | 15% | ★★★★★ | ★★★★ | ★★★ | ★★ |
| egress/비용 | 10% | ★★★★★ | ★★★★★ | ★★★ (② 이미 on) | ★★★ |
| **가중합(5)** | 100% | **2.90** | **2.60** | **3.95** | **3.15** |

- **B(prompt-time)**: 조사가 25~50% precision + 최고가치 교정 놓침으로 실증 반박 → 최하.
- **C(retroactive mining)**: ②가 이미 on(ADR-012)이라 신규 egress 없음. 조사 3건 공통 권고.

## Decision — C: correction-aware retroactive mining

② Haiku 패스를 **교정-인지**로 개선하고, 그 결과를 **완비된 Pipeline A에 배선**한다.

1. **추출 프롬프트 개선** (runner user/learning prompt): 명시 마커 너머 —
   긍정형("돌려봐"), counterfactual("도커에서 했어야"), soft("안해도 될 것 같아") 교정까지,
   **직전 assistant 액션 대비 사용자가 방향을 튼 지점**을 근거로 회수. 각 교정을
   `{kind: prefer-from-now|avoid-this, target, axis_hint, policy≥20자}`로 emit.
2. **승급 배선** (crux 수정): 뽑힌 교정을 `type:'session_summary'`(데드엔드) 대신
   **`type:'explicit_correction'` 승급가능 Evidence**로 emit(agent-assets 스키마) →
   기존 promoteSessionCandidates → correction-clustering → enforce-classifier 자동 인계.
3. **노이즈/안전 방어** (adversarial critic 2라운드로 강화 — data-level invariant):
   - **advisory-only**: 채굴 룰은 `classify()`가 `source==='behavior_inference'`면 빈
     enforce_via 반환 → promote·`classify-enforce --apply`·applyProposal 어느 경로로도
     **Mech-A 차단을 얻지 못함**(환각 교정이 영구 차단 룰 되는 위험 근절).
   - **provenance 차등**: source=behavior_inference, strength 절대 strong 아님, confidence 0.55.
   - **캡**: run 당 최대 3개 채굴, 라이브 총량 상한 30.
   - **네임스페이스 분리**: render_key "auto:" prefix → 실시간 교정과 절대 충돌/억제 안 함.
   - **출력 sanitize**: 채굴 policy/target 을 containsPromptInjection 통과.
   - **은퇴**: 생성나이 TTL(21일) 초과 시 removed(early-return 앞에서 실행 → 조용한 세션도
     강제). roi-demotion 은 solution 전용이라 룰엔 미적용임을 실측 확인 → 자체 은퇴 신설.

**독립 후속(별 PR)**: drift-score.ts:101 hardcap cooldown 게이트 추가(신호 오염 버그 수정).

## Consequences

**긍정**: (a) ①이 놓친 60%(긍정형/soft/counterfactual)를 사후 회수 — 사용자 우려 직접 해소.
(b) 신규 infra 0(② 재사용) + 학습기계 재사용(재구축 없음). (c) ROI 필터로 채굴 노이즈 자동 정정.
(d) 두 데드엔드(session_summary corrections) 중 하나를 살림.

**부정/리스크**: (a) LLM 채굴은 FP 있음 → provenance 차등 + ROI 강등으로 방어(강제 아님).
(b) ② off 사용자는 미적용(설계상 — 동의 필요). (c) 채굴 교정이 실교정보다 약해 초기 반영 느림 —
   반복 관측 시 clustering이 strength 승격(N≥2). (d) implicit-feedback은 **의도적으로 미사용**
   (조사가 틀린 신호공간으로 판정) — 재검토는 신호 재정의 후.

## Open Questions

1. 채굴 confidence 초기값 / ROI 강등 임계 — 실측 후 튜닝.
2. B(prompt-time nudge)를 값싼 보완으로 추가할지 — C 실측 후 결정(현재는 제외).
3. drift_critical 버그 수정 후 그 신호가 다른 용도(세션 품질)로 유효한지 재평가.
