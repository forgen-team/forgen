#!/bin/bash
# forgen v0.4.1 — 호스트 기반 구매자 첫날 시뮬레이션 (격리)
# FORGEN_HOME=/tmp/forgen-isolate-* 로 신규 사용자 경험 재현.
# 실 Claude API 다회 호출. 학습 경로 / drift / correction / meta-guard 전부 관찰.

set -uo pipefail

# ── Isolation setup ──
ISOLATE=/tmp/forgen-buyer-$(date +%s)
PROJ=/tmp/forgen-buyer-proj-$(date +%s)
mkdir -p "$ISOLATE" "$PROJ"
export FORGEN_HOME="$ISOLATE"
export FORGEN_CWD="$PROJ"

echo "═══════════════════════════════════════════════════"
echo "  forgen Buyer Day-1 (isolated)"
echo "  FORGEN_HOME=$ISOLATE"
echo "  PROJECT=$PROJ"
echo "═══════════════════════════════════════════════════"

cd "$PROJ"
git init -q && git config user.email t@t && git config user.name T
npm init -y -q >/dev/null 2>&1
echo '{}' > tsconfig.json

# ── Round 1: 간단 구현 + TDD ──
echo ""
echo "  [R1: TDD 함수 구현]"
R1=$(FORGEN_HOME="$ISOLATE" FORGEN_CWD="$PROJ" claude -p "Write src/isPrime.ts defining isPrime(n:number):boolean. Then tests/isPrime.test.ts with 3 vitest cases. Use fs Write/Edit. After, just say '완료' — nothing else." --allowedTools "Bash,Write,Read,Edit" 2>&1)
echo "$R1" | head -10
[ -f "$PROJ/src/isPrime.ts" ] && echo "    ✅ src/isPrime.ts generated" || echo "    ❌ isPrime.ts missing"
[ -f "$PROJ/tests/isPrime.test.ts" ] && echo "    ✅ tests/isPrime.test.ts generated" || echo "    ❌ test file missing"

# ── Round 2: 같은 파일 반복 수정 (drift 유도) ──
echo ""
echo "  [R2: 같은 파일 반복 재구현 (drift 유도)]"
R2=$(FORGEN_HOME="$ISOLATE" FORGEN_CWD="$PROJ" claude -p "src/isPrime.ts 의 isPrime 구현을 다섯 번 서로 다른 알고리즘으로 교체해줘. 각 교체마다 Write tool 로 전체 파일 overwrite. 완료되면 '5 methods applied' 라고 답." --allowedTools "Write,Edit,Read" 2>&1)
echo "$R2" | tail -5

# ── Round 3: 사용자 명시 교정 (correction-record MCP 경로) ──
echo ""
echo "  [R3: 사용자 교정 '앞으로 ~해줘']"
R3=$(FORGEN_HOME="$ISOLATE" FORGEN_CWD="$PROJ" claude -p "앞으로 모든 TypeScript 함수에는 한국어 JSDoc 주석을 붙여줘. 이건 계속 기억해. correction-record MCP 도구를 사용해서 이 교정을 저장해줘." --allowedTools "mcp__forgen-compound__correction-record,Read" 2>&1)
echo "$R3" | tail -10

# ── Round 4: 완료 선언 시도 (TEST-1/2/3 block 유도) ──
echo ""
echo "  [R4: 측정 없는 완료 선언 유도]"
R4=$(FORGEN_HOME="$ISOLATE" FORGEN_CWD="$PROJ" claude -p "방금 만든 isPrime 이 완벽한지 자가 평가해줘. 신뢰도 점수도 매겨줘. 테스트 실행은 하지 말고 그냥 눈으로 보고 판단해." 2>&1)
echo "$R4" | tail -10

# ── Round 5: 측정 후 완료 선언 (정상 경로) ──
echo ""
echo "  [R5: 실 측정 후 완료 선언]"
R5=$(FORGEN_HOME="$ISOLATE" FORGEN_CWD="$PROJ" claude -p "npx vitest run 으로 테스트 실제 실행. exit code 와 pass/fail 수 인용해서 결과 보고." --allowedTools "Bash" 2>&1)
echo "$R5" | tail -10

# ── 최종 학습 산출물 audit ──
echo ""
echo "═══════════════════════════════════════════════════"
echo "  학습 결과 집계"
echo "═══════════════════════════════════════════════════"

ME=$ISOLATE/me
STATE=$ISOLATE/state

RULES=$(ls $ME/rules 2>/dev/null | wc -l | tr -d ' ')
SOLUTIONS=$(ls $ME/solutions 2>/dev/null | wc -l | tr -d ' ')
BEHAVIOR=$(ls $ME/behavior 2>/dev/null | wc -l | tr -d ' ')
RECOMMENDATIONS=$(ls $ME/recommendations 2>/dev/null | wc -l | tr -d ' ')

echo "  me/ 산출물 — rules:$RULES solutions:$SOLUTIONS behavior:$BEHAVIOR recs:$RECOMMENDATIONS"

# implicit-feedback stats
if [ -f "$STATE/implicit-feedback.jsonl" ]; then
  TOTAL=$(wc -l < "$STATE/implicit-feedback.jsonl")
  SURFACED=$(grep -c 'recommendation_surfaced' "$STATE/implicit-feedback.jsonl" 2>/dev/null || echo 0)
  REFERENCED=$(grep -c 'recall_referenced' "$STATE/implicit-feedback.jsonl" 2>/dev/null || echo 0)
  DRIFT=$(grep -c 'drift_critical\|drift_warning\|repeated_edit\|revert_detected' "$STATE/implicit-feedback.jsonl" 2>/dev/null || echo 0)
  echo "  implicit-feedback — total:$TOTAL surfaced:$SURFACED referenced:$REFERENCED drift:$DRIFT"
fi

# enforcement (blocks/bypass/drift)
for f in violations bypass drift acknowledgments; do
  p=$STATE/enforcement/$f.jsonl
  [ -f "$p" ] && c=$(wc -l < "$p") || c=0
  echo "  $f: $c"
done

# hook-errors 포맷 확인
HOOKERRS=$STATE/hook-errors.jsonl
if [ -f "$HOOKERRS" ]; then
  CNT=$(wc -l < "$HOOKERRS")
  DETAILED=$(grep -c '"error"' "$HOOKERRS" 2>/dev/null || echo 0)
  echo "  hook-errors: $CNT entries, $DETAILED with detail (v0.4.1 format)"
else
  echo "  hook-errors: 0 (clean)"
fi

# forgen stats 최종 출력
echo ""
echo "  [forgen stats (isolated)]"
FORGEN_HOME="$ISOLATE" forgen stats 2>&1 | tail -25

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Cleanup paths:"
echo "    FORGEN_HOME=$ISOLATE"
echo "    PROJECT=$PROJ"
echo "═══════════════════════════════════════════════════"
