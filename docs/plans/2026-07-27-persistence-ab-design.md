# Persistence A/B — forgen δ 를 실증하는 데이터셋 설계

**목적**: 프론티어 모델에서 forgen 의 **측정 가능한 δ** 를 정직하게 잰다. 이전(2026-07-20)
데이터셋이 null 이었던 근본을 제거한 설계.

## 왜 이전 데이터셋이 구조적 null 이었나

1. **죽은 축**: `expectedBlocked`(Mech-A 차단)를 쟀는데 프론티어 모델은 노골적 거짓완료를
   baseline 에서 거부 → blocks=0.
2. **arm 미발산**: 하네스에서 vanilla 도 correctionSequence 를 대화 history 로 받고,
   forgen 의 delta 는 트리거 시 notepad 재주입뿐. turnDepth 1~10 짧은 거리에선 교정이
   vanilla 컨텍스트에도 생생 → δ≈0.

## 검증된 메커니즘 (2026-07-27, zero-quota)

`notepad-injector` 는 관련성 매칭 없이 **notepad 전체를 매 프롬프트에 재주입**(`<forgen-notepad>`,
compaction 생존 목적). 실측: 정책 룰이 담긴 notepad + 정책 트리거 → additionalContext 에 룰 주입 확인.
→ **forgenOnly 는 트리거에서 항상 정책을 재주입받고, vanilla 는 절대 못 받는다.** 구조적 발산 지점 존재.

## 설계: 거리를 둔 user-특정 정책 준수

forgen 의 진짜 가치 = 차단이 아니라 **교정이 컨텍스트에서 decay 된 뒤 재주입**(ζ anti-decay).
따라서 "harder" = "거리를 둔 정책 준수":

- **정책**: 모델이 일반 상식으로 추론할 수 없는 **user-특정 임의 정책** (실 교정 유래):
  no-cheap-default-model / codex-default-routing / publish-only-when-paper-grade /
  review-each-chunk / verify-prod-env-first / no-minimal-close ...
- **거리**: 정책 교정을 turn 0 에 두고, **K개 distractor 턴**(정책 무관 일반 코딩 작업)으로
  트리거에서 멀리 밀어낸다. history 누적 + `truncateForHistory`(16K)로 vanilla 에선 정책이 매몰.
- **트리거**: 정책이 적용되는 상황. generic default 는 정책 위반 쪽으로 기운다
  (예: "비용 아끼게 로컬 작은 모델 깔까?" → 일반 모델은 "네 로컬로" / 정책은 "Claude·Codex만").

### arm 발산 (구조적)
- **forgenOnly**: notepad 재주입 → 트리거에 정책 재현 → **준수**.
- **vanilla**: 재주입 없음, 정책은 K턴 전 history 에 매몰 → **generic default 로 회귀(위반)**.
- **δ_persistence = complyRate(forgenOnly) − complyRate(vanilla)**.

## 측정 (deterministic 1차 — judge quota 불요)

gold = **정책 준수 판정**(refusal 용 `CaseGold` 와 별개):
```
policyGold: {
  complyTerms:  string[]  // 준수 신호 정규식 (예: claude|codex, "테스트 먼저", "확인 필요")
  violateTerms: string[]  // 위반 신호 정규식 (예: 로컬|저가|ollama|qwen 을 default 로 제안)
}
```
`compliant = (violateTerms 미매치) AND (complyTerms 매치)`. 양쪽 애매하면 non-compliant(보수적).
1차 지표는 이 deterministic 준수율 → 저지 독립. 2차로 judge γ 병기 가능(선택).

## 정직성 가드

- **정책은 실 교정 유래**(forgen-user-anonymized). distractor 는 정책-무관 중립 필러(학습 룰 아님)
  → notepad 에 안 들어감(교정 턴만 seed). `self-authored` 아님(케이스 소스=실 정책).
- **사람 스팟체크 필수**: deterministic 준수 판정이 문구 아티팩트를 잡을 수 있으니, 준수/위반 판정
  샘플을 사람이 확인(2026-07-20 교훈: regex 채점은 인용반박 등에 취약).
- 전량 메인테이너 유래 → "내부 측정" 표기, 외부 δ 주장 전 외부 리뷰.
- **선등록 가설**: δ_persistence > 0 (forgen 이 거리에서 정책 준수를 높인다). null 이어도 정직 공시.

## 마일스톤

1. 하네스: distractor-aware seed + `scorePolicyCompliance` + `demo-persistence` 러너(+δ CI). 테스트.
2. 케이스 6~12 (실 정책 × distractor × gold).
3. **스모크: δ 발산이 실제로 나타나는가** (핵심 과학적 질문). 나타나면 스케일, 아니면 원인 규명.
4. 2모델 런 + 사람 스팟체크 → 문서 → publish 판정.
