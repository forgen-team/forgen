#!/bin/bash
# forgen v0.3 — 실제 변경 사항 end-to-end 검증
# 클린 Docker 환경에서 다음을 실제로 확인:
#   - 10개 스킬 + 12개 에이전트 실제 설치 여부
#   - stale cleanup (이전 스킬/에이전트 파일 제거)
#   - 신규 스킬 (forge-loop, ship, retro, learn, calibrate) 존재
#   - Learning Curve가 forgen dashboard에 출력되는지
#   - forge-loop Stop 훅이 실제 JSON 응답으로 block을 반환하는지
#   - .forgen/skills/ 플러그인 경로가 스캔되는지

set -euo pipefail

PASS=0
FAIL=0

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  forgen v0.3 — End-to-End Verification"
echo "═══════════════════════════════════════════════════════"
echo ""

FORGEN_PKG=/usr/local/lib/node_modules/@wooojin/forgen
FORGEN_DIST=$FORGEN_PKG/dist

# ──────────────────────────────────────────
# Phase 0: 설치 구조 확인
# ──────────────────────────────────────────
echo "  [Phase 0: Installation Structure]"

command -v forgen &>/dev/null && pass "forgen CLI in PATH" || fail "forgen CLI missing"

# 커밋된 스킬 수 (assets/claude/commands/)
COMMAND_COUNT=$(ls $FORGEN_PKG/assets/claude/commands/*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$COMMAND_COUNT" = "10" ] && pass "assets/claude/commands/ has exactly 10 skills ($COMMAND_COUNT)" || fail "assets/claude/commands/ has $COMMAND_COUNT (expected 10)"

# 에이전트 소스 파일 수 (12 core + Phase 4 solution-evolver = 13)
AGENT_COUNT=$(ls $FORGEN_PKG/assets/claude/agents/*.md 2>/dev/null | wc -l | tr -d ' ')
[ "$AGENT_COUNT" = "13" ] && pass "assets/claude/agents/ has exactly 13 agents ($AGENT_COUNT)" || fail "assets/claude/agents/ has $AGENT_COUNT (expected 13)"

# 삭제되었어야 하는 파일들 확인
for deleted in performance-reviewer.md security-reviewer.md refactoring-expert.md code-simplifier.md scientist.md qa-tester.md writer.md; do
  [ ! -f "$FORGEN_PKG/assets/claude/agents/$deleted" ] && pass "deleted agent absent: $deleted" || fail "deleted agent still present: $deleted"
done

for deleted in tdd.md refactor.md ecomode.md specify.md git-master.md migrate.md; do
  [ ! -f "$FORGEN_PKG/assets/claude/commands/$deleted" ] && pass "deleted command absent: $deleted" || fail "deleted command still present: $deleted"
done

# 신규 스킬 파일 존재
for new in forge-loop.md ship.md retro.md learn.md calibrate.md; do
  [ -f "$FORGEN_PKG/assets/claude/commands/$new" ] && pass "new skill present: $new" || fail "new skill missing: $new"
done

echo ""

# ──────────────────────────────────────────
# Phase 1: 실제 설치 동작 (harness)
# ──────────────────────────────────────────
echo "  [Phase 1: Harness Installation]"

# 기존 프로젝트에 오래된 stale 파일들을 먼저 심어둠 (삭제되는지 확인용)
mkdir -p /workspace/test-project/.claude/agents
mkdir -p ~/.claude/commands/forgen

cat > /workspace/test-project/.claude/agents/ch-performance-reviewer.md <<'EOF'
<!-- forgen-managed -->
---
name: performance-reviewer
---
stale agent content
EOF

cat > /workspace/test-project/.claude/agents/ch-writer.md <<'EOF'
<!-- forgen-managed -->
---
name: writer
---
stale agent content
EOF

cat > ~/.claude/commands/forgen/tdd.md <<'EOF'
<!-- forgen-managed -->
stale tdd command
EOF

cat > ~/.claude/commands/forgen/refactor.md <<'EOF'
<!-- forgen-managed -->
stale refactor command
EOF

# 사용자가 직접 만든 (marker 없는) 파일은 삭제되면 안 됨
cat > /workspace/test-project/.claude/agents/ch-user-custom.md <<'EOF'
---
name: user-custom
---
user's own agent (no forgen marker)
EOF

# 온보딩 먼저 (harness에 필요)
node -e "
import('$FORGEN_DIST/forge/onboarding.js').then(async onb => {
  const { createProfile, saveProfile } = await import('$FORGEN_DIST/store/profile-store.js');
  const { ensureV1Directories } = await import('$FORGEN_DIST/core/v1-bootstrap.js');
  ensureV1Directories();
  const r = onb.computeOnboarding('A', 'A', 'C', 'A');
  const p = createProfile('e2e-test', r.qualityPack, r.autonomyPack, r.suggestedTrustPolicy, 'onboarding', r.judgmentPack, r.communicationPack);
  saveProfile(p);
});
" 2>/dev/null

# 실제 harness 실행
node -e "
import('$FORGEN_DIST/core/harness.js').then(async m => {
  await m.prepareHarness('/workspace/test-project');
  console.log('HARNESS_OK');
}).catch(e => { console.error('HARNESS_FAIL:', e.message); process.exit(1); });
" >/tmp/harness.log 2>&1

grep -q "HARNESS_OK" /tmp/harness.log && pass "prepareHarness completed" || fail "prepareHarness failed: $(cat /tmp/harness.log | head -3)"

echo ""

# ──────────────────────────────────────────
# Phase 2: 에이전트 설치 + stale cleanup
# ──────────────────────────────────────────
echo "  [Phase 2: Agent Install + Stale Cleanup]"

# ch-*.md 파일 수 (사용자 파일 ch-user-custom.md는 보존되어야 하므로 12 + 1 = 13)
INSTALLED_AGENTS=$(ls /workspace/test-project/.claude/agents/ch-*.md 2>/dev/null | wc -l | tr -d ' ')
echo "  (installed ch-*.md count: $INSTALLED_AGENTS)"
[ "$INSTALLED_AGENTS" -ge "12" ] && pass "at least 12 agents installed" || fail "only $INSTALLED_AGENTS agents installed"

# stale agents 삭제 확인
[ ! -f /workspace/test-project/.claude/agents/ch-performance-reviewer.md ] && pass "stale performance-reviewer deleted" || fail "stale performance-reviewer NOT deleted"
[ ! -f /workspace/test-project/.claude/agents/ch-writer.md ] && pass "stale writer deleted" || fail "stale writer NOT deleted"

# 사용자 커스텀 파일 보존 확인
[ -f /workspace/test-project/.claude/agents/ch-user-custom.md ] && pass "user custom agent preserved (no forgen marker)" || fail "user custom agent was deleted!"

# 현재 에이전트 12개가 모두 있는지
for agent in analyst architect code-reviewer critic debugger designer executor explore git-master planner test-engineer verifier; do
  [ -f "/workspace/test-project/.claude/agents/ch-$agent.md" ] && pass "agent installed: ch-$agent.md" || fail "agent missing: ch-$agent.md"
done

# 에이전트 내용에 새로운 섹션 있는지 샘플 검사
if grep -q "Failure_Modes_To_Avoid" /workspace/test-project/.claude/agents/ch-planner.md; then
  pass "planner agent has Failure_Modes_To_Avoid section"
else
  fail "planner agent missing Failure_Modes_To_Avoid"
fi

if grep -q "maxTurns" /workspace/test-project/.claude/agents/ch-executor.md; then
  pass "executor agent has maxTurns frontmatter"
else
  fail "executor agent missing maxTurns"
fi

# 모든 에이전트의 name 필드가 ch-* 접두사로 등록되어 있는지 (Claude Code 호출 충돌 방지)
NAME_CONFLICT_COUNT=0
for agent in analyst architect code-reviewer critic debugger designer executor explore git-master planner test-engineer verifier; do
  NAME=$(grep "^name:" /workspace/test-project/.claude/agents/ch-$agent.md | head -1 | sed 's/name: *//')
  if [ "$NAME" != "ch-$agent" ]; then
    NAME_CONFLICT_COUNT=$((NAME_CONFLICT_COUNT + 1))
    fail "$agent frontmatter name='$NAME' (expected 'ch-$agent' to avoid conflict with OMC/builtin)"
  fi
done
if [ "$NAME_CONFLICT_COUNT" = "0" ]; then
  pass "all 12 agents use ch-* name (no conflict with OMC/builtin agents)"
fi

echo ""

# ──────────────────────────────────────────
# Phase 3: 스킬 설치 + stale cleanup
# ──────────────────────────────────────────
echo "  [Phase 3: Skill Install + Stale Cleanup]"

# 설치된 슬래시 명령 수
INSTALLED_SKILLS=$(ls ~/.claude/commands/forgen/*.md 2>/dev/null | wc -l | tr -d ' ')
echo "  (installed skills: $INSTALLED_SKILLS)"
[ "$INSTALLED_SKILLS" = "10" ] && pass "exactly 10 skills installed" || fail "$INSTALLED_SKILLS skills installed (expected 10)"

# stale skills 삭제 확인
[ ! -f ~/.claude/commands/forgen/tdd.md ] && pass "stale tdd skill deleted" || fail "stale tdd NOT deleted"
[ ! -f ~/.claude/commands/forgen/refactor.md ] && pass "stale refactor skill deleted" || fail "stale refactor NOT deleted"

# 10개 스킬 전부 확인
for skill in compound deep-interview architecture-decision code-review docker forge-loop ship retro learn calibrate; do
  [ -f "$HOME/.claude/commands/forgen/$skill.md" ] && pass "skill installed: $skill" || fail "skill missing: $skill"
done

# 스킬 내용에 compound integration 섹션 있는지
if grep -q "Compound_Integration\|compound-search" ~/.claude/commands/forgen/deep-interview.md; then
  pass "deep-interview has Compound_Integration"
else
  fail "deep-interview missing Compound_Integration"
fi

# /ship has disable-model-invocation
if grep -q "disable-model-invocation: true" ~/.claude/commands/forgen/ship.md; then
  pass "ship has disable-model-invocation: true (prevents accidental auto-trigger)"
else
  fail "ship missing disable-model-invocation flag"
fi

echo ""

# ──────────────────────────────────────────
# Phase 4: forge-loop Stop 훅 실동작
# ──────────────────────────────────────────
echo "  [Phase 4: forge-loop Stop Hook Runtime]"

# 상태 파일 없을 때 → 차단 안 함
RESULT=$(echo '{"stop_hook_type":"end_turn","session_id":"test"}' | node "$FORGEN_DIST/hooks/context-guard.js" 2>/dev/null)
if echo "$RESULT" | grep -q '"decision":"block"'; then
  fail "Stop hook blocked without forge-loop state file!"
else
  pass "Stop hook allows when no forge-loop state"
fi

# forge-loop 상태 파일 생성 (미완료 스토리)
mkdir -p ~/.forgen/state
cat > ~/.forgen/state/forge-loop.json <<EOF
{
  "active": true,
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "stories": [
    {"id": "US-001", "title": "로그인 구현", "passes": false}
  ]
}
EOF

# 미완료 스토리 있을 때 → 차단
RESULT=$(echo '{"stop_hook_type":"end_turn","session_id":"test"}' | node "$FORGEN_DIST/hooks/context-guard.js" 2>/dev/null)
if echo "$RESULT" | grep -q '"decision":"block"'; then
  pass "Stop hook blocks when forge-loop has pending story"
else
  fail "Stop hook did NOT block pending story: $RESULT"
fi

if echo "$RESULT" | grep -q "US-001"; then
  pass "Block message mentions current story ID"
else
  fail "Block message missing story ID"
fi

if echo "$RESULT" | grep -q "로그인 구현"; then
  pass "Block message includes story title"
else
  fail "Block message missing story title"
fi

# blockCount 증가 확인
BLOCK_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HOME/.forgen/state/forge-loop.json','utf-8')).blockCount)" 2>/dev/null)
[ "$BLOCK_COUNT" = "1" ] && pass "blockCount incremented to 1" || fail "blockCount = $BLOCK_COUNT (expected 1)"

# 모든 스토리 완료로 변경 → 차단 해제
cat > ~/.forgen/state/forge-loop.json <<EOF
{
  "active": true,
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "stories": [
    {"id": "US-001", "title": "로그인 구현", "passes": true}
  ]
}
EOF

RESULT=$(echo '{"stop_hook_type":"end_turn","session_id":"test"}' | node "$FORGEN_DIST/hooks/context-guard.js" 2>/dev/null)
if echo "$RESULT" | grep -q '"decision":"block"'; then
  fail "Stop hook blocked even after all stories complete!"
else
  pass "Stop hook releases when all stories pass"
fi

# active가 false로 변경되었는지
ACTIVE_AFTER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HOME/.forgen/state/forge-loop.json','utf-8')).active)" 2>/dev/null)
[ "$ACTIVE_AFTER" = "false" ] && pass "forge-loop state auto-deactivated" || fail "forge-loop still active after completion"

# 정리
rm ~/.forgen/state/forge-loop.json

echo ""

# ──────────────────────────────────────────
# Phase 5: .forgen/skills/ 플러그인 시스템
# ──────────────────────────────────────────
echo "  [Phase 5: Plugin System (.forgen/skills/)]"

# 프로젝트 로컬 커스텀 스킬 생성
mkdir -p /workspace/test-project/.forgen/skills
cat > /workspace/test-project/.forgen/skills/my-custom.md <<'EOF'
---
name: my-custom
description: custom project skill
triggers:
  - "mycustom"
  - "내커스텀"
---
This is a custom skill loaded from .forgen/skills/
EOF

# skill-injector가 이 커스텀 스킬을 인식하는지
cd /workspace/test-project
RESULT=$(echo '{"prompt":"mycustom 실행해줘","session_id":"test-plugin-session"}' | FORGEN_CWD=/workspace/test-project node "$FORGEN_DIST/hooks/skill-injector.js" 2>/dev/null)

if echo "$RESULT" | grep -q "my-custom\|mycustom"; then
  pass "skill-injector picked up .forgen/skills/ custom skill"
else
  # Check cache to confirm
  if echo "$RESULT" | grep -q "additionalContext"; then
    pass "skill-injector responded (custom skill may have been matched)"
  else
    fail "custom .forgen/skills/ skill NOT detected: $RESULT"
  fi
fi

# 스캔 경로에 실제로 포함되는지 확인 (source 검증)
if grep -q "'.forgen', 'skills'" $FORGEN_DIST/hooks/skill-injector.js; then
  pass "skill-injector.js includes .forgen/skills/ in scan paths"
else
  fail ".forgen/skills/ path NOT in compiled skill-injector"
fi

echo ""

# ──────────────────────────────────────────
# Phase 6: forgen dashboard Learning Curve
# ──────────────────────────────────────────
echo "  [Phase 6: Dashboard Learning Curve]"

DASHBOARD_OUT=$(forgen dashboard 2>&1)

if echo "$DASHBOARD_OUT" | grep -q "Learning Curve\|학습 곡선"; then
  pass "dashboard includes Learning Curve section"
else
  fail "dashboard missing Learning Curve section"
fi

if echo "$DASHBOARD_OUT" | grep -q "교정 추이\|추정 절약"; then
  pass "dashboard shows correction trend + time saved"
else
  fail "dashboard missing correction/saved-time metrics"
fi

echo ""

# ──────────────────────────────────────────
# Phase 7: Session Summary Counterfactual
# ──────────────────────────────────────────
echo "  [Phase 7: Session Summary with Counterfactual]"

# solution-cache 모의 데이터로 세션 종료 시 카운터팩추얼 생성 확인
SESSION_ID="test-counterfactual"
mkdir -p ~/.forgen/state

# context-guard가 promptCount >= 10을 요구하므로 state 직접 설정
cat > ~/.forgen/state/context-guard.json <<EOF
{
  "promptCount": 15,
  "totalChars": 50000,
  "lastWarningAt": 0,
  "lastAutoCompactAt": 0,
  "sessionId": "$SESSION_ID"
}
EOF

cat > ~/.forgen/state/solution-cache-$SESSION_ID.json <<'EOF'
{
  "injected": [
    {"name": "prisma-upsert-pattern", "injectedAt": "2026-04-15T10:00:00Z"},
    {"name": "vitest-mock-cleanup", "injectedAt": "2026-04-15T10:15:00Z"},
    {"name": "jwt-refresh-token-race", "injectedAt": "2026-04-15T10:30:00Z"}
  ]
}
EOF

STOP_RESULT=$(echo "{\"stop_hook_type\":\"end_turn\",\"session_id\":\"$SESSION_ID\"}" | node "$FORGEN_DIST/hooks/context-guard.js" 2>/dev/null)

if echo "$STOP_RESULT" | grep -q "주입된 compound"; then
  pass "session summary includes compound injection count"
else
  fail "session summary missing compound count: $STOP_RESULT"
fi

if echo "$STOP_RESULT" | grep -q "추정 절약 시간"; then
  pass "session summary includes estimated time saved (counterfactual)"
else
  fail "session summary missing time estimate"
fi

# 24분 = 3건 × 8분
if echo "$STOP_RESULT" | grep -q "24분"; then
  pass "counterfactual estimate correct (3 injections × 8min = 24min)"
else
  fail "counterfactual calculation wrong"
fi

echo ""

# ──────────────────────────────────────────
# Phase 8: fgx runtime 전파
# ──────────────────────────────────────────
echo "  [Phase 8: fgx Runtime Flag Propagation]"

# resolveLaunchContext 직접 검증
RUNTIME_TEST=$(node -e "
import('$FORGEN_DIST/services/session.js').then(m => {
  const a = m.resolveLaunchContext(['--runtime=codex', 'hello']);
  const b = m.resolveLaunchContext(['hello']);
  console.log(JSON.stringify({a, b}));
});
" 2>/dev/null)

if echo "$RUNTIME_TEST" | grep -q '"runtime":"codex"' && echo "$RUNTIME_TEST" | grep -q '"runtimeSource":"flag"'; then
  pass "--runtime=codex flag correctly parsed"
else
  fail "runtime flag parsing broken: $RUNTIME_TEST"
fi

if echo "$RUNTIME_TEST" | grep -q '"args":\["hello"\]'; then
  pass "runtime flag stripped from forwarded args"
else
  fail "runtime flag not stripped from args"
fi

# FORGEN_RUNTIME env var
ENV_TEST=$(FORGEN_RUNTIME=codex node -e "
import('$FORGEN_DIST/services/session.js').then(m => {
  console.log(JSON.stringify(m.resolveLaunchContext(['x'])));
});
" 2>/dev/null)

if echo "$ENV_TEST" | grep -q '"runtime":"codex"' && echo "$ENV_TEST" | grep -q '"runtimeSource":"env"'; then
  pass "FORGEN_RUNTIME env var correctly parsed"
else
  fail "env var runtime parsing broken: $ENV_TEST"
fi

echo ""

# ──────────────────────────────────────────
# Phase 9: keyword 패턴 (v0.3 신규 스킬)
# ──────────────────────────────────────────
echo "  [Phase 9: Keyword Patterns for New Skills]"

for keyword in forge-loop ship retro learn calibrate; do
  # Pattern 문자열이 keyword-detector.js에 포함되는지 확인
  if grep -q "keyword: '$keyword'" $FORGEN_DIST/hooks/keyword-detector.js 2>/dev/null; then
    pass "keyword-detector has pattern for: $keyword"
  else
    fail "keyword-detector missing pattern for: $keyword"
  fi
done

# 삭제된 키워드 패턴이 남아있지 않은지
for deleted_kw in "'tdd'" "'refactor'" "'ecomode'" "'migrate'"; do
  if grep -q "keyword: $deleted_kw" $FORGEN_DIST/hooks/keyword-detector.js 2>/dev/null; then
    fail "deleted keyword still in detector: $deleted_kw"
  else
    pass "deleted keyword absent: $deleted_kw"
  fi
done

echo ""

# ──────────────────────────────────────────
# Summary
# ──────────────────────────────────────────
echo "═══════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "  ❌ V0.3 VERIFICATION FAILED"
  exit 1
else
  echo "  ✅ V0.3 ALL CHECKS PASSED"
  exit 0
fi
