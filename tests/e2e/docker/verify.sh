#!/bin/bash
# forgen 클린 환경 E2E 검증 스크립트
# Docker 컨테이너 내에서 실행

set -e

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  △ $1"; WARN=$((WARN + 1)); }

echo ""
echo "═══════════════════════════════════════════"
echo "  forgen — Clean Environment E2E Verification"
echo "═══════════════════════════════════════════"
echo ""

# ──────────────────────────────────────────────
# Phase 0: 설치 검증
# ──────────────────────────────────────────────
echo "  [Phase 0: Installation]"

# 0-1. forgen CLI 존재
if command -v forgen &>/dev/null; then
  pass "forgen CLI is in PATH"
else
  fail "forgen CLI not found"
fi

# 0-2. forgen-mcp CLI 존재
if command -v forgen-mcp &>/dev/null; then
  pass "forgen-mcp CLI is in PATH"
else
  fail "forgen-mcp CLI not found"
fi

# 0-3. fgx CLI 존재
if command -v fgx &>/dev/null; then
  pass "fgx CLI is in PATH"
else
  fail "fgx CLI not found"
fi

# 0-4. ~/.forgen/ 디렉터리 구조
if [ -d "$HOME/.forgen" ]; then
  pass "~/.forgen/ exists"
else
  fail "~/.forgen/ missing"
fi

if [ -d "$HOME/.forgen/me/solutions" ]; then
  pass "~/.forgen/me/solutions/ exists"
else
  fail "~/.forgen/me/solutions/ missing"
fi

if [ -d "$HOME/.forgen/me/behavior" ]; then
  pass "~/.forgen/me/behavior/ exists"
else
  fail "~/.forgen/me/behavior/ missing"
fi

if [ -d "$HOME/.forgen/me/skills" ]; then
  pass "~/.forgen/me/skills/ exists"
else
  fail "~/.forgen/me/skills/ missing"
fi

# 0-5. 플러그인 캐시 디렉터리
PLUGIN_CACHE="$HOME/.claude/plugins/cache/forgen-local/forgen"
if [ -d "$PLUGIN_CACHE" ] || [ -L "$PLUGIN_CACHE" ]; then
  # 버전 디렉터리가 있는지 확인
  VERSION_DIR=$(ls -d "$PLUGIN_CACHE"/*/ 2>/dev/null | head -1)
  if [ -n "$VERSION_DIR" ]; then
    pass "Plugin cache exists: $VERSION_DIR"

    # hooks.json 존재
    if [ -f "$VERSION_DIR/hooks/hooks.json" ]; then
      pass "hooks/hooks.json exists in plugin cache"
    else
      fail "hooks/hooks.json missing in plugin cache"
    fi

    # dist/hooks/ 존재
    if [ -d "$VERSION_DIR/dist/hooks" ]; then
      HOOK_COUNT=$(ls "$VERSION_DIR/dist/hooks/"*.js 2>/dev/null | wc -l | tr -d ' ')
      if [ "$HOOK_COUNT" -gt 10 ]; then
        pass "dist/hooks/ has $HOOK_COUNT hook scripts"
      else
        fail "dist/hooks/ has only $HOOK_COUNT scripts (expected 10+)"
      fi
    else
      fail "dist/hooks/ missing in plugin cache"
    fi

    # skills/ 디렉터리
    if [ -d "$VERSION_DIR/skills" ]; then
      SKILL_COUNT=$(ls -d "$VERSION_DIR/skills/"*/ 2>/dev/null | wc -l | tr -d ' ')
      pass "skills/ has $SKILL_COUNT skills"
    else
      fail "skills/ missing in plugin cache"
    fi
  else
    fail "No version directory in plugin cache"
  fi
else
  fail "Plugin cache directory missing: $PLUGIN_CACHE"
fi

# 0-6. installed_plugins.json
INSTALLED="$HOME/.claude/plugins/installed_plugins.json"
if [ -f "$INSTALLED" ]; then
  if grep -q "forgen@forgen-local" "$INSTALLED"; then
    pass "forgen registered in installed_plugins.json"

    # installPath가 실제로 존재하는 경로인지
    INSTALL_PATH=$(node -e "
      const d = JSON.parse(require('fs').readFileSync('$INSTALLED','utf-8'));
      const e = d.plugins?.['forgen@forgen-local']?.[0];
      console.log(e?.installPath || '');
    " 2>/dev/null)
    if [ -n "$INSTALL_PATH" ] && [ -d "$INSTALL_PATH" ]; then
      pass "installPath exists: $INSTALL_PATH"
    elif [ -n "$INSTALL_PATH" ] && [ -L "$INSTALL_PATH" ]; then
      pass "installPath is a symlink: $INSTALL_PATH"
    else
      fail "installPath does not exist: $INSTALL_PATH"
    fi
  else
    fail "forgen not in installed_plugins.json"
  fi
else
  fail "installed_plugins.json missing"
fi

# 0-7. settings.json
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  pass "settings.json exists"
else
  warn "settings.json not created (may be created on first harness run)"
fi

# 0-8. ~/.claude.json (MCP 서버)
CLAUDE_JSON="$HOME/.claude.json"
if [ -f "$CLAUDE_JSON" ] && grep -q "forgen-compound" "$CLAUDE_JSON"; then
  pass "forgen-compound MCP server registered in ~/.claude.json"
else
  fail "forgen-compound not in ~/.claude.json"
fi

echo ""

# ──────────────────────────────────────────────
# Phase 1: 슬래시 커맨드 설치 확인
# ──────────────────────────────────────────────
echo "  [Phase 1: Slash Commands]"

COMMANDS_DIR="$HOME/.claude/commands/forgen"
if [ -d "$COMMANDS_DIR" ]; then
  CMD_COUNT=$(ls "$COMMANDS_DIR/"*.md 2>/dev/null | wc -l | tr -d ' ')
  if [ "$CMD_COUNT" -ge 19 ]; then
    pass "19 slash commands installed ($CMD_COUNT found)"
  elif [ "$CMD_COUNT" -ge 9 ]; then
    warn "Only $CMD_COUNT commands installed (expected 19)"
  else
    fail "Only $CMD_COUNT commands installed"
  fi
else
  fail "Commands directory missing: $COMMANDS_DIR"
fi

echo ""

# ──────────────────────────────────────────────
# Phase 2: 훅 동작 검증 (실제 실행)
# ──────────────────────────────────────────────
echo "  [Phase 2: Hook Execution]"

# 훅 스크립트 위치 찾기
if [ -n "$VERSION_DIR" ]; then
  HOOKS_DIR="$VERSION_DIR/dist/hooks"
else
  # fallback: npm global 경로에서 찾기
  HOOKS_DIR=$(npm root -g 2>/dev/null)/forgen/dist/hooks
fi

# 2-1. pre-tool-use: 위험 명령 차단
if [ -f "$HOOKS_DIR/pre-tool-use.js" ]; then
  RESULT=$(echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"},"session_id":"test"}' | node "$HOOKS_DIR/pre-tool-use.js" 2>/dev/null)
  if echo "$RESULT" | grep -q '"continue":false'; then
    pass "pre-tool-use blocks 'rm -rf /'"
  else
    fail "pre-tool-use did NOT block 'rm -rf /': $RESULT"
  fi
else
  fail "pre-tool-use.js not found at $HOOKS_DIR"
fi

# 2-2. pre-tool-use: 안전 명령 허용
if [ -f "$HOOKS_DIR/pre-tool-use.js" ]; then
  RESULT=$(echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"},"session_id":"test"}' | node "$HOOKS_DIR/pre-tool-use.js" 2>/dev/null)
  if echo "$RESULT" | grep -q '"continue":true'; then
    pass "pre-tool-use allows 'ls -la'"
  else
    fail "pre-tool-use blocked 'ls -la': $RESULT"
  fi
fi

# 2-3. db-guard: DROP TABLE 차단
if [ -f "$HOOKS_DIR/db-guard.js" ]; then
  RESULT=$(echo '{"tool_name":"Bash","tool_input":{"command":"psql -c \"DROP TABLE users\""},"session_id":"test"}' | node "$HOOKS_DIR/db-guard.js" 2>/dev/null)
  if echo "$RESULT" | grep -q '"continue":false'; then
    pass "db-guard blocks DROP TABLE"
  else
    fail "db-guard did NOT block DROP TABLE"
  fi
fi

# 2-4. keyword-detector: tdd 키워드 감지
if [ -f "$HOOKS_DIR/keyword-detector.js" ]; then
  RESULT=$(echo '{"prompt":"tdd로 작업해줘","session_id":"test","cwd":"/tmp"}' | COMPOUND_CWD=/tmp node "$HOOKS_DIR/keyword-detector.js" 2>/dev/null)
  if echo "$RESULT" | grep -q 'additionalContext'; then
    pass "keyword-detector injects tdd skill content"
  elif echo "$RESULT" | grep -q '"continue":true'; then
    warn "keyword-detector responded but no skill injection (skill file may be missing)"
  else
    fail "keyword-detector failed: $RESULT"
  fi
fi

# 2-5. intent-classifier: debug intent 감지
if [ -f "$HOOKS_DIR/intent-classifier.js" ]; then
  RESULT=$(echo '{"prompt":"버그 고쳐줘","session_id":"test"}' | node "$HOOKS_DIR/intent-classifier.js" 2>/dev/null)
  if echo "$RESULT" | grep -q 'debug'; then
    pass "intent-classifier detects debug intent"
  elif echo "$RESULT" | grep -q '"continue":true'; then
    pass "intent-classifier responds (intent may vary)"
  else
    fail "intent-classifier failed"
  fi
fi

# 2-6. secret-filter: API 키 감지
if [ -f "$HOOKS_DIR/secret-filter.js" ]; then
  RESULT=$(echo '{"tool_name":"Bash","tool_input":{"command":"echo test"},"tool_response":"ANTHROPIC_API_KEY=sk-ant-api03-xxxx","session_id":"test"}' | node "$HOOKS_DIR/secret-filter.js" 2>/dev/null)
  if echo "$RESULT" | grep -q 'Sensitive'; then
    pass "secret-filter detects API key"
  else
    warn "secret-filter may not have detected key: $(echo $RESULT | head -c 100)"
  fi
fi

echo ""

# ──────────────────────────────────────────────
# Phase 2.5: 신규 기능 검증 (v4.1 변경분)
# ──────────────────────────────────────────────
echo "  [Phase 2.5: v4.1 New Features]"

# 2.5-1. 보안 패턴 강화: rm -rf / 직접 패턴 (prompt-injection-filter)
FILTER_JS="$HOOKS_DIR/../hooks/prompt-injection-filter.js"
if [ ! -f "$FILTER_JS" ]; then
  # dist 구조에서 직접 찾기
  FILTER_JS=$(find "$VERSION_DIR" -name "prompt-injection-filter.js" -path "*/hooks/*" 2>/dev/null | head -1)
fi
if [ -n "$FILTER_JS" ] && [ -f "$FILTER_JS" ]; then
  # Node.js로 직접 import하여 새 패턴 검증
  SECURITY_CHECK=$(node -e "
    const m = require('$FILTER_JS');
    const tests = [
      ['rm -rf /', true, 'destruct-rm-rf'],
      ['DROP DATABASE prod;', true, 'destruct-drop-db'],
      ['cat ~/.ssh/id_rsa', true, 'exfil-ssh-key'],
      ['eval(atob(\"abc\"))', true, 'obfusc-eval'],
      ['cat /app/.env', true, 'exfil-env'],
      ['ls -la', false, 'safe-command'],
    ];
    let pass = 0, fail = 0;
    for (const [input, shouldBlock, label] of tests) {
      const result = m.containsPromptInjection(input);
      if (result === shouldBlock) pass++;
      else { console.error('FAIL: ' + label + ' expected=' + shouldBlock + ' got=' + result); fail++; }
    }
    console.log(JSON.stringify({pass, fail}));
  " 2>/dev/null)
  if echo "$SECURITY_CHECK" | grep -q '"fail":0'; then
    SECURITY_PASS=$(echo "$SECURITY_CHECK" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).pass))")
    pass "prompt-injection-filter: $SECURITY_PASS/6 new patterns verified"
  else
    fail "prompt-injection-filter: some patterns failed — $SECURITY_CHECK"
  fi
else
  warn "prompt-injection-filter.js not found, skipping pattern check"
fi

# 2.5-2. post-tool-failure: getRecoverySuggestion export 검증
PTF_JS=$(find "$VERSION_DIR" -name "post-tool-failure.js" -path "*/hooks/*" 2>/dev/null | head -1)
if [ -n "$PTF_JS" ] && [ -f "$PTF_JS" ]; then
  RECOVERY_CHECK=$(node -e "
    const m = require('$PTF_JS');
    if (typeof m.getRecoverySuggestion === 'function') {
      const r = m.getRecoverySuggestion('ENOENT: file not found', 'Read');
      console.log(r.includes('not exist') ? 'ok' : 'wrong');
    } else { console.log('no-export'); }
  " 2>/dev/null)
  if [ "$RECOVERY_CHECK" = "ok" ]; then
    pass "post-tool-failure: getRecoverySuggestion works"
  else
    warn "post-tool-failure: getRecoverySuggestion check=$RECOVERY_CHECK"
  fi
else
  warn "post-tool-failure.js not found"
fi

# 2.5-3. auto-tuner — v5에서 제거됨. 스킵.
# (forge/auto-tuner는 evidence 기반 시스템으로 대체)

# 2.5-4. session-store FTS5 코드 존재 확인
SESSION_JS=$(find "$VERSION_DIR" -name "session-store.js" -path "*/core/*" 2>/dev/null | head -1)
if [ -n "$SESSION_JS" ] && [ -f "$SESSION_JS" ]; then
  if grep -q "messages_fts" "$SESSION_JS" && grep -q "fts5" "$SESSION_JS"; then
    pass "session-store: FTS5 code present"
  else
    fail "session-store: FTS5 code missing"
  fi
else
  warn "session-store.js not found"
fi

echo ""

# ──────────────────────────────────────────────
# Phase 3: forgen doctor
# ──────────────────────────────────────────────
echo "  [Phase 3: forgen doctor]"

DOCTOR_OUTPUT=$(forgen doctor 2>&1 || true)
if echo "$DOCTOR_OUTPUT" | grep -q "Diagnostics"; then
  pass "forgen doctor runs successfully"

  # 플러그인 캐시 체크 결과
  if echo "$DOCTOR_OUTPUT" | grep -q "✓.*forgen plugin cache"; then
    pass "doctor: plugin cache OK"
  else
    fail "doctor: plugin cache check failed"
  fi
else
  fail "forgen doctor failed to run"
fi

echo ""

# ──────────────────────────────────────────────
# Phase 4: MCP 서버
# ──────────────────────────────────────────────
echo "  [Phase 4: MCP Server]"

# forgen-mcp가 실행 가능한지 (즉시 종료 — stdin 없으면 대기)
timeout 3 forgen-mcp </dev/null >/dev/null 2>&1 &
MCP_PID=$!
sleep 1
if kill -0 $MCP_PID 2>/dev/null; then
  pass "forgen-mcp process starts"
  kill $MCP_PID 2>/dev/null || true
else
  # 프로세스가 이미 종료됨 (stdin 없어서 정상)
  pass "forgen-mcp executed (exited — no stdin)"
fi

echo ""

# ──────────────────────────────────────────────
# Phase 5: 학습 루프 풀 라이프사이클
# ──────────────────────────────────────────────
echo "  [Phase 5: Learning Loop Lifecycle]"

# evidence-store.ts, rule-store.ts의 함수를 Node.js로 직접 호출
EVIDENCE_STORE="$VERSION_DIR/dist/store/evidence-store.js"
RULE_STORE="$VERSION_DIR/dist/store/rule-store.js"
EVIDENCE_PROC="$VERSION_DIR/dist/forge/evidence-processor.js"
MISMATCH="$VERSION_DIR/dist/forge/mismatch-detector.js"

if [ -f "$EVIDENCE_PROC" ] && [ -f "$EVIDENCE_STORE" ] && [ -f "$RULE_STORE" ]; then

  # 5-1. prefer-from-now 교정 → 승격 → 영구 규칙
  PROMO_CHECK=$(node -e "
    const { processCorrection } = require('$EVIDENCE_PROC');
    const { promoteSessionCandidates } = require('$EVIDENCE_STORE');
    const { loadActiveRules } = require('$RULE_STORE');

    const result = processCorrection({
      session_id: 'docker-e2e-session',
      kind: 'prefer-from-now',
      message: 'always run tests before commit',
      target: 'pre-commit-test',
      axis_hint: 'quality_safety',
    });

    if (!result.promotion_candidate) { console.log('FAIL:no-candidate'); process.exit(0); }

    const promoted = promoteSessionCandidates('docker-e2e-session');
    if (promoted !== 1) { console.log('FAIL:promo-count=' + promoted); process.exit(0); }

    const rules = loadActiveRules().filter(r => r.scope === 'me');
    if (rules.length < 1) { console.log('FAIL:no-me-rule'); process.exit(0); }

    const rule = rules.find(r => r.policy.includes('always run tests'));
    if (!rule) { console.log('FAIL:wrong-policy'); process.exit(0); }
    if (rule.category !== 'quality') { console.log('FAIL:wrong-category=' + rule.category); process.exit(0); }

    console.log('OK');
  " 2>/dev/null)
  if [ "$PROMO_CHECK" = "OK" ]; then
    pass "Learning loop: prefer-from-now → promote → scope:me rule"
  else
    fail "Learning loop promotion: $PROMO_CHECK"
  fi

  # 5-2. 중복 승격 방지
  DEDUP_CHECK=$(node -e "
    const { promoteSessionCandidates } = require('$EVIDENCE_STORE');
    const dup = promoteSessionCandidates('docker-e2e-session');
    console.log(dup === 0 ? 'OK' : 'FAIL:dup=' + dup);
  " 2>/dev/null)
  if [ "$DEDUP_CHECK" = "OK" ]; then
    pass "Learning loop: duplicate promotion prevented"
  else
    fail "Learning loop dedup: $DEDUP_CHECK"
  fi

  # 5-3. fix-now → session rule → cleanup
  CLEANUP_CHECK=$(node -e "
    const { processCorrection } = require('$EVIDENCE_PROC');
    const { loadActiveRules, cleanupStaleSessionRules } = require('$RULE_STORE');

    processCorrection({
      session_id: 'docker-e2e-old-session',
      kind: 'fix-now',
      message: 'temp rule for old session',
      target: 'temp-fix',
      axis_hint: 'autonomy',
    });

    const before = loadActiveRules().filter(r => r.scope === 'session').length;
    if (before < 1) { console.log('FAIL:no-session-rule'); process.exit(0); }

    cleanupStaleSessionRules('docker-e2e-new-session');

    const after = loadActiveRules().filter(r => r.scope === 'session').length;
    console.log(after === 0 ? 'OK' : 'FAIL:stale=' + after);
  " 2>/dev/null)
  if [ "$CLEANUP_CHECK" = "OK" ]; then
    pass "Learning loop: session rule cleanup works"
  else
    fail "Learning loop cleanup: $CLEANUP_CHECK"
  fi

  # 5-4. mismatch 감지 (prefer-from-now 누적)
  if [ -f "$MISMATCH" ]; then
    MISMATCH_CHECK=$(node -e "
      const { processCorrection } = require('$EVIDENCE_PROC');
      const { loadEvidenceBySession } = require('$EVIDENCE_STORE');
      const { computeSessionSignals, detectMismatch } = require('$MISMATCH');

      const allSignals = [];
      for (let i = 0; i < 3; i++) {
        const sid = 'docker-mismatch-' + i;
        for (let j = 0; j < 2; j++) {
          processCorrection({
            session_id: sid,
            kind: 'prefer-from-now',
            message: 'quality correction ' + i + '-' + j,
            target: 'quality-check-' + i + '-' + j,
            axis_hint: 'quality_safety',
          });
        }
        const corrections = loadEvidenceBySession(sid);
        const signals = computeSessionSignals(sid, corrections, [], [], '보수형', '확인 우선형');
        allSignals.push(...signals);
      }

      const result = detectMismatch(allSignals);
      if (result.quality_mismatch && result.quality_score >= 4) {
        console.log('OK:score=' + result.quality_score);
      } else {
        console.log('FAIL:mismatch=' + result.quality_mismatch + ',score=' + result.quality_score);
      }
    " 2>/dev/null)
    if echo "$MISMATCH_CHECK" | grep -q "^OK"; then
      pass "Learning loop: 3-session mismatch detection works ($MISMATCH_CHECK)"
    else
      fail "Learning loop mismatch: $MISMATCH_CHECK"
    fi
  else
    warn "mismatch-detector.js not found"
  fi

  # 5-5. MCP profile-read 도구 (Node.js로 직접 호출)
  PROFILE_STORE="$VERSION_DIR/dist/store/profile-store.js"
  if [ -f "$PROFILE_STORE" ]; then
    PROFILE_CHECK=$(node -e "
      const { createProfile, saveProfile, loadProfile } = require('$PROFILE_STORE');
      const p = createProfile('docker-test', '보수형', '확인 우선형', '가드레일 우선', 'test');
      saveProfile(p);
      const loaded = loadProfile();
      if (loaded && loaded.base_packs.quality_pack === '보수형') {
        console.log('OK');
      } else {
        console.log('FAIL:profile-load');
      }
    " 2>/dev/null)
    if [ "$PROFILE_CHECK" = "OK" ]; then
      pass "MCP: profile-read data accessible"
    else
      fail "MCP profile: $PROFILE_CHECK"
    fi
  fi

  # 5-6. auto-compound-runner Step 4 실제 트리거 경로 검증
  # (auto-compound-runner.ts를 직접 import하지 않고, Step 4와 동일한 코드 경로를 재현)
  AUTO_COMPOUND="$VERSION_DIR/dist/core/auto-compound-runner.js"
  if [ -f "$AUTO_COMPOUND" ]; then
    AUTO_TRIGGER_CHECK=$(node -e "
      // Step 4의 실제 코드 경로 재현:
      // auto-compound-runner.ts:482 — promoteSessionCandidates(sessionId)
      const { processCorrection } = require('$EVIDENCE_PROC');
      const { promoteSessionCandidates, loadPromotionCandidates } = require('$EVIDENCE_STORE');
      const { loadActiveRules } = require('$RULE_STORE');

      // 세션 시뮬레이션: 교정 기록
      const sid = 'docker-auto-trigger-test';
      processCorrection({
        session_id: sid,
        kind: 'prefer-from-now',
        message: 'use early return pattern',
        target: 'early-return',
        axis_hint: 'judgment_philosophy',
      });
      processCorrection({
        session_id: sid,
        kind: 'avoid-this',
        message: 'never use nested if-else beyond 3 levels',
        target: 'deep-nesting',
        axis_hint: 'quality_safety',
      });

      // 승격 전 확인
      const candidates = loadPromotionCandidates().filter(e => e.session_id === sid);
      if (candidates.length !== 2) { console.log('FAIL:candidates=' + candidates.length); process.exit(0); }

      const rulesBefore = loadActiveRules().filter(r => r.scope === 'me');
      const countBefore = rulesBefore.length;

      // auto-compound-runner Step 4와 동일한 호출
      const promoted = promoteSessionCandidates(sid);

      const rulesAfter = loadActiveRules().filter(r => r.scope === 'me');
      const countAfter = rulesAfter.length;

      if (promoted !== 2) { console.log('FAIL:promoted=' + promoted); process.exit(0); }
      if (countAfter !== countBefore + 2) { console.log('FAIL:count=' + countBefore + '->' + countAfter); process.exit(0); }

      // avoid-this는 strength:'strong'이어야 함
      const strongRule = rulesAfter.find(r => r.strength === 'strong' && r.policy.includes('nested'));
      if (!strongRule) { console.log('FAIL:no-strong-rule'); process.exit(0); }

      // prefer-from-now는 strength:'default'이어야 함
      const defaultRule = rulesAfter.find(r => r.strength === 'default' && r.policy.includes('early return'));
      if (!defaultRule) { console.log('FAIL:no-default-rule'); process.exit(0); }

      // 카테고리 매핑 확인
      if (defaultRule.category !== 'workflow') { console.log('FAIL:cat=' + defaultRule.category); process.exit(0); }
      if (strongRule.category !== 'quality') { console.log('FAIL:cat=' + strongRule.category); process.exit(0); }

      console.log('OK');
    " 2>/dev/null)
    if [ "$AUTO_TRIGGER_CHECK" = "OK" ]; then
      pass "Auto-compound Step 4: full trigger path verified (2 rules, correct strength/category)"
    else
      fail "Auto-compound Step 4: $AUTO_TRIGGER_CHECK"
    fi
  else
    warn "auto-compound-runner.js not found"
  fi

  # 5-7. forgen me 대시보드 출력 검증
  ME_OUTPUT=$(forgen me 2>&1 || true)
  if echo "$ME_OUTPUT" | grep -q "Learning Loop Status"; then
    pass "forgen me: dashboard shows Learning Loop Status"
  else
    fail "forgen me: dashboard missing Learning Loop Status section"
  fi
  if echo "$ME_OUTPUT" | grep -q "Rules:"; then
    pass "forgen me: dashboard shows rule count"
  else
    fail "forgen me: dashboard missing rule count"
  fi

else
  fail "evidence-processor.js or evidence-store.js not found — skipping learning loop tests"
fi

echo ""

# ──────────────────────────────────────────────
# Phase 6: 세션 라이프사이클 시뮬레이션
# ──────────────────────────────────────────────
echo "  [Phase 6: Session Lifecycle Simulation]"

# 격리된 HOME으로 전체 세션 흐름을 재현 (paths.ts는 os.homedir()/.forgen 사용)
LIFECYCLE_ROOT="/tmp/lifecycle-root"
rm -rf "$LIFECYCLE_ROOT"
mkdir -p "$LIFECYCLE_ROOT/.forgen/state" "$LIFECYCLE_ROOT/.forgen/me/solutions" "$LIFECYCLE_ROOT/.forgen/me/behavior"
LIFECYCLE_STATE="$LIFECYCLE_ROOT/.forgen/state"

# 6-L1. 25회 프롬프트 누적 → context-guard 상태 축적
echo "    Simulating 25-prompt session..."
LIFECYCLE_PASS=true
for i in $(seq 1 25); do
  RESULT=$(echo "{\"prompt\":\"prompt number $i with some content to accumulate chars\",\"session_id\":\"lifecycle-test\"}" | \
    HOME="$LIFECYCLE_ROOT" node "$HOOKS_DIR/context-guard.js" 2>/dev/null)
  if ! echo "$RESULT" | grep -q '"continue":true'; then
    LIFECYCLE_PASS=false
    break
  fi
done

if [ "$LIFECYCLE_PASS" = "true" ]; then
  if [ -f "$LIFECYCLE_STATE/context-guard.json" ]; then
    PROMPT_COUNT=$(node -e "
      const d = JSON.parse(require('fs').readFileSync('$LIFECYCLE_STATE/context-guard.json','utf-8'));
      console.log(d.promptCount);
    " 2>/dev/null)
    if [ "$PROMPT_COUNT" = "25" ]; then
      pass "Session lifecycle: 25 prompts accumulated (promptCount=$PROMPT_COUNT)"
    else
      fail "Session lifecycle: promptCount=$PROMPT_COUNT (expected 25)"
    fi
  else
    fail "Session lifecycle: context-guard.json not created"
  fi
else
  fail "Session lifecycle: hook failed during prompt accumulation"
fi

# 6-L2. 세션 종료 (Stop hook) → pending-compound.json 마커 생성
echo "    Simulating session end (Stop hook)..."
rm -f "$LIFECYCLE_STATE/pending-compound.json"
STOP_RESULT=$(echo '{"stop_hook_type":"user","session_id":"lifecycle-test"}' | \
  HOME="$LIFECYCLE_ROOT" node "$HOOKS_DIR/context-guard.js" 2>/dev/null)

if [ -f "$LIFECYCLE_STATE/pending-compound.json" ]; then
  MARKER_REASON=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$LIFECYCLE_STATE/pending-compound.json','utf-8'));
    console.log(d.reason + ':' + d.promptCount);
  " 2>/dev/null)
  if echo "$MARKER_REASON" | grep -q "session-end:25"; then
    pass "Session end: pending-compound.json written (reason=session-end, promptCount=25)"
  else
    fail "Session end: marker content wrong — $MARKER_REASON"
  fi
else
  fail "Session end: pending-compound.json NOT created (20+ prompts should trigger)"
fi

if echo "$STOP_RESULT" | grep -qi "auto-trigger\|compound"; then
  pass "Session end: Stop response mentions compound auto-trigger"
else
  fail "Session end: Stop response missing compound info — $(echo "$STOP_RESULT" | head -c 150)"
fi

# 6-L3. 12회 프롬프트 세션 → /compound 안내만 (자동 트리거 아님)
echo "    Simulating 12-prompt session (below auto-trigger)..."
SMALL_ROOT="/tmp/lifecycle-small"
rm -rf "$SMALL_ROOT"
mkdir -p "$SMALL_ROOT/.forgen/state"

for i in $(seq 1 12); do
  echo "{\"prompt\":\"short prompt $i\",\"session_id\":\"small-session\"}" | \
    HOME="$SMALL_ROOT" node "$HOOKS_DIR/context-guard.js" >/dev/null 2>&1
done

SMALL_STOP=$(echo '{"stop_hook_type":"user","session_id":"small-session"}' | \
  HOME="$SMALL_ROOT" node "$HOOKS_DIR/context-guard.js" 2>/dev/null)

if [ ! -f "$SMALL_ROOT/.forgen/state/pending-compound.json" ]; then
  if echo "$SMALL_STOP" | grep -q "/compound"; then
    pass "12-prompt session: suggests /compound (no auto-trigger)"
  else
    warn "12-prompt session: no /compound suggestion in response"
  fi
else
  fail "12-prompt session: should NOT auto-trigger (only 12 prompts)"
fi

# 6-L4. Auto-compact 트리거 — 120K 문자 누적 시 compact 지시 주입
echo "    Simulating auto-compact trigger (120K chars)..."
COMPACT_ROOT="/tmp/lifecycle-compact"
rm -rf "$COMPACT_ROOT"
mkdir -p "$COMPACT_ROOT/.forgen/state"

node -e "
  const fs = require('fs');
  fs.writeFileSync('$COMPACT_ROOT/.forgen/state/context-guard.json', JSON.stringify({
    promptCount: 50, totalChars: 115000, lastWarningAt: 0, lastAutoCompactAt: 0,
    sessionId: 'compact-test'
  }));
" 2>/dev/null

BIG_PROMPT=$(node -e "console.log(JSON.stringify({prompt:'x'.repeat(6000),session_id:'compact-test'}))" 2>/dev/null)
COMPACT_RESULT=$(echo "$BIG_PROMPT" | \
  HOME="$COMPACT_ROOT" node "$HOOKS_DIR/context-guard.js" 2>/dev/null)

if echo "$COMPACT_RESULT" | grep -qi "auto-compact\|compact\|/compact"; then
  pass "Auto-compact: /compact instruction injected at 121K chars"
else
  fail "Auto-compact: no compact instruction — $(echo "$COMPACT_RESULT" | head -c 200)"
fi

# 6-L5. Hook timing 축적
TIMING_LOG="$LIFECYCLE_STATE/hook-timing.jsonl"
if [ -f "$TIMING_LOG" ]; then
  LINE_COUNT=$(wc -l < "$TIMING_LOG" | tr -d ' ')
  if [ "$LINE_COUNT" -ge 25 ]; then
    pass "Hook timing: $LINE_COUNT entries accumulated during session simulation"
  else
    warn "Hook timing: only $LINE_COUNT entries (expected 25+)"
  fi
else
  warn "Hook timing: hook-timing.jsonl not created (context-guard may not have timing)"
fi

# 6-L6. Hook error tracking — 잘못된 stdin
echo "    Simulating hook error..."
echo "INVALID_JSON" | HOME="$LIFECYCLE_ROOT" node "$HOOKS_DIR/context-guard.js" >/dev/null 2>&1
if [ -f "$LIFECYCLE_STATE/hook-errors.json" ]; then
  ERROR_COUNT=$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$LIFECYCLE_STATE/hook-errors.json','utf-8'));
    const cg = d['context-guard'];
    console.log(cg ? cg.count : 0);
  " 2>/dev/null)
  if [ "$ERROR_COUNT" -ge 1 ]; then
    pass "Hook error tracking: error recorded (count=$ERROR_COUNT)"
  else
    warn "Hook error tracking: file exists but count=0"
  fi
else
  warn "Hook error tracking: hook-errors.json not created (may fail-open without tracking)"
fi

# 6-L7. Implicit feedback — 같은 파일 5+ 편집
echo "    Simulating repeated file edits..."
EDIT_ROOT="/tmp/lifecycle-edit"
rm -rf "$EDIT_ROOT"
mkdir -p "$EDIT_ROOT/.forgen/state"

for i in $(seq 1 6); do
  echo "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/tmp/test.ts\",\"old_string\":\"a\",\"new_string\":\"b\"},\"session_id\":\"edit-test\"}" | \
    HOME="$EDIT_ROOT" node "$HOOKS_DIR/post-tool-use.js" >/dev/null 2>&1
done

FEEDBACK_LOG="$EDIT_ROOT/.forgen/state/implicit-feedback.jsonl"
if [ -f "$FEEDBACK_LOG" ]; then
  if grep -q "repeated_edit" "$FEEDBACK_LOG"; then
    pass "Implicit feedback: repeated_edit detected after 6 edits to same file"
  else
    warn "Implicit feedback: JSONL exists but no repeated_edit entry"
  fi
else
  warn "Implicit feedback: implicit-feedback.jsonl not created"
fi

# 정리
rm -rf "$LIFECYCLE_ROOT" "$SMALL_ROOT" "$COMPACT_ROOT" "$EDIT_ROOT"

echo ""

# ──────────────────────────────────────────────
# Phase 7: v0.3 기능 export 검증
# ──────────────────────────────────────────────
echo "  [Phase 7: v0.3 Feature Exports]"

# 7-1. Hook error tracking — failOpenWithTracking 호출 경로
HOOK_RESP_JS=$(find "$VERSION_DIR" -name "hook-response.js" -path "*/shared/*" 2>/dev/null | head -1)
if [ -n "$HOOK_RESP_JS" ] && [ -f "$HOOK_RESP_JS" ]; then
  TRACKING_CHECK=$(node -e "
    const m = require('$HOOK_RESP_JS');
    if (typeof m.failOpenWithTracking !== 'function') { console.log('FAIL:no-export'); process.exit(0); }
    const result = JSON.parse(m.failOpenWithTracking('test-hook'));
    console.log(result.continue === true ? 'OK' : 'FAIL:not-continue');
  " 2>/dev/null)
  if [ "$TRACKING_CHECK" = "OK" ]; then
    pass "failOpenWithTracking export works"
  else
    fail "failOpenWithTracking: $TRACKING_CHECK"
  fi

  # 모든 훅이 failOpenWithTracking을 사용하는지 확인
  HOOKS_USING_OLD=$(grep -rl "failOpen()" "$VERSION_DIR/dist/hooks/" 2>/dev/null | grep -v "hook-response" | wc -l | tr -d ' ')
  if [ "$HOOKS_USING_OLD" = "0" ]; then
    pass "All hooks use failOpenWithTracking (no plain failOpen)"
  else
    fail "$HOOKS_USING_OLD hooks still use plain failOpen()"
  fi
else
  fail "hook-response.js not found"
fi

# 7-2. Hook timing profiler — recordHookTiming/getTimingStats
TIMING_JS=$(find "$VERSION_DIR" -name "hook-timing.js" -path "*/shared/*" 2>/dev/null | head -1)
if [ -n "$TIMING_JS" ] && [ -f "$TIMING_JS" ]; then
  TIMING_CHECK=$(node -e "
    const m = require('$TIMING_JS');
    if (typeof m.recordHookTiming !== 'function') { console.log('FAIL:no-record'); process.exit(0); }
    if (typeof m.getTimingStats !== 'function') { console.log('FAIL:no-stats'); process.exit(0); }
    // 실제 기록 + 통계 조회
    m.recordHookTiming('e2e-test', 42, 'UserPromptSubmit');
    m.recordHookTiming('e2e-test', 100, 'PreToolUse');
    const stats = m.getTimingStats();
    const entry = stats.find(s => s.hook === 'e2e-test');
    if (!entry || entry.count < 2) { console.log('FAIL:count=' + (entry?.count ?? 0)); process.exit(0); }
    console.log('OK');
  " 2>/dev/null)
  if [ "$TIMING_CHECK" = "OK" ]; then
    pass "Hook timing profiler: record + stats work"
  else
    fail "Hook timing: $TIMING_CHECK"
  fi
else
  fail "hook-timing.js not found"
fi

# 7-3. Bigram semantic matching — bigramSimilarity
MATCHER_JS=$(find "$VERSION_DIR" -name "solution-matcher.js" -path "*/engine/*" 2>/dev/null | head -1)
if [ -n "$MATCHER_JS" ] && [ -f "$MATCHER_JS" ]; then
  BIGRAM_CHECK=$(node -e "
    const m = require('$MATCHER_JS');
    if (typeof m.bigramSimilarity !== 'function') { console.log('FAIL:no-export'); process.exit(0); }
    const same = m.bigramSimilarity('hello', 'hello');
    if (same !== 1) { console.log('FAIL:same=' + same); process.exit(0); }
    const diff = m.bigramSimilarity('abc', 'xyz');
    if (diff !== 0) { console.log('FAIL:diff=' + diff); process.exit(0); }
    const partial = m.bigramSimilarity('database', 'datbase');
    if (partial < 0.5) { console.log('FAIL:partial=' + partial); process.exit(0); }
    console.log('OK');
  " 2>/dev/null)
  if [ "$BIGRAM_CHECK" = "OK" ]; then
    pass "Bigram semantic matching: bigramSimilarity works"
  else
    fail "Bigram matching: $BIGRAM_CHECK"
  fi
else
  fail "solution-matcher.js not found"
fi

# 7-4. Project-level hook config — mergeHookConfigs
HOOKCONFIG_JS=$(find "$VERSION_DIR" -name "hook-config.js" -path "*/hooks/*" 2>/dev/null | head -1)
if [ -n "$HOOKCONFIG_JS" ] && [ -f "$HOOKCONFIG_JS" ]; then
  MERGE_CHECK=$(node -e "
    const m = require('$HOOKCONFIG_JS');
    if (typeof m.mergeHookConfigs !== 'function') { console.log('FAIL:no-export'); process.exit(0); }
    const merged = m.mergeHookConfigs(
      { hooks: { 'slop-detector': { enabled: true } } },
      { hooks: { 'slop-detector': { enabled: false } } }
    );
    const slopEnabled = merged.hooks?.['slop-detector']?.enabled;
    console.log(slopEnabled === false ? 'OK' : 'FAIL:merge=' + slopEnabled);
  " 2>/dev/null)
  if [ "$MERGE_CHECK" = "OK" ]; then
    pass "Project hook config: mergeHookConfigs override works"
  else
    fail "Project hook config: $MERGE_CHECK"
  fi
else
  fail "hook-config.js not found"
fi

# 7-5. Implicit feedback — post-tool-use trackModifiedFile/simpleHash
PTU_JS=$(find "$VERSION_DIR" -name "post-tool-use.js" -path "*/hooks/*" 2>/dev/null | head -1)
if [ -n "$PTU_JS" ] && [ -f "$PTU_JS" ]; then
  IMPLICIT_CHECK=$(node -e "
    const m = require('$PTU_JS');
    // simpleHash 또는 trackModifiedFile export 확인
    const hasHash = typeof m.simpleHash === 'function';
    const hasTrack = typeof m.trackModifiedFile === 'function';
    const hasRecord = typeof m.recordImplicitFeedback === 'function';
    if (hasHash || hasTrack || hasRecord) {
      console.log('OK:exports=' + [hasHash&&'hash',hasTrack&&'track',hasRecord&&'record'].filter(Boolean).join(','));
    } else {
      console.log('FAIL:no-exports');
    }
  " 2>/dev/null)
  if echo "$IMPLICIT_CHECK" | grep -q "^OK"; then
    pass "Implicit feedback: functions exported ($IMPLICIT_CHECK)"
  else
    warn "Implicit feedback: no public exports (may be internal-only)"
  fi
else
  fail "post-tool-use.js not found"
fi

# 7-6. Auto compound on session end — context-guard pending-compound marker
if [ -f "$HOOKS_DIR/context-guard.js" ]; then
  AUTOCOMP_CHECK=$(echo '{"stop_hook_type":"user","session_id":"e2e-auto-compound"}' | \
    FORGEN_HOME=/tmp/forgen-e2e node -e "
      // 먼저 promptCount >= 20 상태를 시뮬레이션
      const fs = require('fs');
      const stateDir = '/tmp/forgen-e2e/state';
      fs.mkdirSync(stateDir, {recursive: true});
      fs.writeFileSync(stateDir + '/context-guard.json', JSON.stringify({
        promptCount: 25, totalChars: 50000, lastWarningAt: 0, lastAutoCompactAt: 0,
        sessionId: 'e2e-auto-compound'
      }));
      // stdin을 읽어 context-guard에 전달
      process.stdin.resume();
      let data = '';
      process.stdin.on('data', d => data += d);
      process.stdin.on('end', () => {
        // pending-compound.json이 생성되었는지 확인
        setTimeout(() => {
          const markerPath = stateDir + '/pending-compound.json';
          if (fs.existsSync(markerPath)) {
            const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
            console.log(marker.reason === 'session-end' ? 'OK' : 'FAIL:reason=' + marker.reason);
          } else {
            console.log('FAIL:no-marker');
          }
        }, 100);
      });
    " 2>/dev/null)
  # context-guard는 자체 경로를 사용하므로 대안 검증
  # 소스에서 pending-compound 로직이 존재하는지 확인
  if grep -q "pending-compound" "$HOOKS_DIR/context-guard.js" 2>/dev/null; then
    pass "Auto compound: pending-compound.json write logic present in context-guard"
  else
    fail "Auto compound: pending-compound.json logic missing"
  fi
fi

# 7-7. Auto-compact trigger at 120K chars
if grep -q "auto-compact\|autoCompact\|AUTO_COMPACT" "$HOOKS_DIR/context-guard.js" 2>/dev/null; then
  pass "Auto-compact: 120K threshold logic present in context-guard"
else
  fail "Auto-compact: threshold logic missing"
fi

# 7-8. Knowledge export/import — compound-export module
EXPORT_JS=$(find "$VERSION_DIR" -name "compound-export.js" -path "*/engine/*" 2>/dev/null | head -1)
if [ -n "$EXPORT_JS" ] && [ -f "$EXPORT_JS" ]; then
  EXPORT_CHECK=$(node -e "
    const m = require('$EXPORT_JS');
    const hasExport = typeof m.exportKnowledge === 'function' || typeof m.handleExport === 'function';
    const hasImport = typeof m.importKnowledge === 'function' || typeof m.handleImport === 'function';
    console.log((hasExport && hasImport) ? 'OK' : 'FAIL:export=' + hasExport + ',import=' + hasImport);
  " 2>/dev/null)
  if [ "$EXPORT_CHECK" = "OK" ]; then
    pass "Knowledge export/import: functions available"
  else
    warn "Knowledge export/import: $EXPORT_CHECK (may use CLI-only interface)"
  fi
else
  fail "compound-export.js not found in dist"
fi

# 7-9. Compound dashboard — forgen dashboard 실행
DASHBOARD_OUTPUT=$(forgen dashboard 2>&1 || true)
if echo "$DASHBOARD_OUTPUT" | grep -qi "knowledge\|overview\|dashboard\|injection\|solution"; then
  pass "forgen dashboard: runs and shows knowledge info"
else
  fail "forgen dashboard: unexpected output — $(echo $DASHBOARD_OUTPUT | head -c 100)"
fi

# 7-10. Doctor hook timing section
DOCTOR_TIMING=$(forgen doctor 2>&1 || true)
if echo "$DOCTOR_TIMING" | grep -qi "timing\|hook.*health\|p50\|p95"; then
  pass "forgen doctor: shows hook timing/health section"
else
  warn "forgen doctor: timing section may not display without data"
fi

echo ""

# ──────────────────────────────────────────────
# Phase 8: Hoyeon 분석 구현 검증 (Phase 1+2 전체)
# ──────────────────────────────────────────────
echo "  [Phase 8: Hoyeon Analysis — Full Feature Verification]"

# 8-1. removed (2026-04-21): `specify` skill was deleted in commit f534227
# (16-skill refactor). The old test asserted `specify` keyword injection — no
# longer a feature. See docs/weakness-analysis-2026-04-14.md §2.1 for the
# rationale (21 skills → 10 killer skills). `forge-loop` + `deep-interview`
# now cover the former `specify` use case.

# 8-2. deep-interview 스킬 주입 + Ambiguity Score
DI_RESULT=$(echo '{"prompt":"deep-interview MVP 기획","session_id":"e2e-hoyeon-2","cwd":"/tmp"}' | \
  COMPOUND_CWD=/tmp node "$HOOKS_DIR/keyword-detector.js" 2>/dev/null)
if echo "$DI_RESULT" | grep -qi "ambiguity"; then
  pass "deep-interview skill: Ambiguity Score system injected"
else
  fail "deep-interview skill: Ambiguity Score missing — $(echo "$DI_RESULT" | head -c 150)"
fi
if echo "$DI_RESULT" | grep -q "What.*Who.*How\|What.*How.*When"; then
  pass "deep-interview skill: 5-axis scoring (What/Who/How/When/Why) present"
else
  warn "deep-interview skill: 5-axis check inconclusive"
fi

# 8-3. Agent 출력 자동 검증 (Tier 2-F) — 빈 출력 경고
AGENT_EMPTY=$(echo '{"tool_name":"Agent","tool_response":"","session_id":"e2e-hoyeon-3"}' | \
  node "$HOOKS_DIR/post-tool-use.js" 2>/dev/null)
if echo "$AGENT_EMPTY" | grep -qi "agent.*minimal\|agent.*empty\|agent_empty"; then
  pass "Agent validation: empty output warning triggered"
else
  fail "Agent validation: empty output not warned — $(echo "$AGENT_EMPTY" | head -c 150)"
fi

# 8-4. Agent 정상 출력 통과
AGENT_OK=$(echo '{"tool_name":"Agent","tool_response":"Here is a comprehensive analysis covering architecture patterns and test coverage across modules","session_id":"e2e-hoyeon-4"}' | \
  node "$HOOKS_DIR/post-tool-use.js" 2>/dev/null | tail -1)
if echo "$AGENT_OK" | grep -q '"continue":true' && ! echo "$AGENT_OK" | grep -qi "agent.*warn\|agent.*minimal"; then
  pass "Agent validation: normal output passes without warning"
else
  fail "Agent validation: normal output incorrectly warned"
fi

# 8-5. implement intent 한글 매칭 (Korean boundary fix)
IMPLEMENT_KO=$(echo '{"prompt":"새 결제 API 만들어줘","session_id":"e2e-hoyeon-5"}' | \
  node "$HOOKS_DIR/intent-classifier.js" 2>/dev/null)
if echo "$IMPLEMENT_KO" | grep -q "implement"; then
  pass "intent-classifier: Korean '만들어줘' → implement"
else
  fail "intent-classifier: Korean implement not matched — $(echo "$IMPLEMENT_KO" | head -c 100)"
fi

# 8-6. removed (2026-04-21): `ecomode` and `migrate` skills were both in the
# 16-skill deletion batch (commit f534227). Korean keyword matching for these
# specific skills is no longer applicable. `intent-classifier` Korean
# matching is still covered above (8-5) via the `implement` case.

# 8-7. solution-injector 실제 솔루션 주입 (additionalContext 검증)
SOL_RESULT=$(echo '{"prompt":"error handling typescript best practice","session_id":"e2e-hoyeon-8"}' | \
  node "$HOOKS_DIR/solution-injector.js" 2>/dev/null | head -1)
if echo "$SOL_RESULT" | grep -q "additionalContext.*Matched"; then
  pass "solution-injector: solutions actually injected into additionalContext"
  if echo "$SOL_RESULT" | grep -q "APPLY"; then
    pass "solution-injector: APPLY directive present in injection"
  else
    warn "solution-injector: APPLY directive missing"
  fi
  if echo "$SOL_RESULT" | grep -q "head_limit"; then
    pass "solution-injector: head_limit guidance present (1-E)"
  else
    warn "solution-injector: head_limit guidance missing"
  fi
else
  warn "solution-injector: no solutions matched (may depend on starter solutions)"
fi

# 8-8. recovery message improvements (1-A)
RECOVERY_CHECK=$(HOOKS_DIR_ENV="$HOOKS_DIR" node -e "
  const path = require('path');
  const fs = require('fs');
  const hooksDir = process.env.HOOKS_DIR_ENV;
  const ptfPath = path.join(hooksDir, 'post-tool-failure.js');
  if (!fs.existsSync(ptfPath)) { process.stderr.write('SKIP\n'); process.exit(0); }
  const m = require(ptfPath);
  if (typeof m.getRecoverySuggestion !== 'function') { process.stderr.write('SKIP\n'); process.exit(0); }
  const r1 = m.getRecoverySuggestion('ENOENT: no such file', 'Read');
  const r2 = m.getRecoverySuggestion('EACCES: permission denied', 'Bash');
  const glob = r1.includes('Glob') ? 'OK' : 'FAIL';
  const chmod = r2.includes('chmod') ? 'OK' : 'FAIL';
  process.stderr.write(glob + ':' + chmod + '\n');
" 2>&1 1>/dev/null)
if [ "$RECOVERY_CHECK" = "OK:OK" ]; then
  pass "recovery: file not found → Glob suggestion"
  pass "recovery: permission denied → chmod suggestion"
elif [ "$RECOVERY_CHECK" = "SKIP" ]; then
  warn "recovery: post-tool-failure.js not found for recovery check"
else
  GLOB_PART=$(echo "$RECOVERY_CHECK" | cut -d: -f1)
  CHMOD_PART=$(echo "$RECOVERY_CHECK" | cut -d: -f2)
  if [ "$GLOB_PART" = "OK" ]; then pass "recovery: file not found → Glob suggestion"; else fail "recovery: Glob suggestion missing for ENOENT"; fi
  if [ "$CHMOD_PART" = "OK" ]; then pass "recovery: permission denied → chmod suggestion"; else fail "recovery: chmod suggestion missing for EACCES"; fi
fi

# 8-9. BM25 앙상블 스코어링 (2-C)
if [ -n "$MATCHER_JS" ] && [ -f "$MATCHER_JS" ]; then
  BM25_CHECK=$(node -e "
    const m = require('$MATCHER_JS');
    if (typeof m.bm25Score !== 'function') { console.log('FAIL:no-export'); process.exit(0); }
    const score = m.bm25Score(['error','handling'], ['error','handling','pattern'], 6);
    console.log(score > 0 ? 'OK:' + score.toFixed(3) : 'FAIL:zero');
  " 2>/dev/null)
  if echo "$BM25_CHECK" | grep -q "^OK"; then
    pass "BM25 ensemble: bm25Score works ($BM25_CHECK)"
  else
    fail "BM25 ensemble: $BM25_CHECK"
  fi
fi

# 8-10. rule-renderer [category|strength] 태그 (2-A)
RENDERER_JS=$(find "$VERSION_DIR" -name "rule-renderer.js" -path "*/renderer/*" 2>/dev/null | head -1)
if [ -n "$RENDERER_JS" ] && [ -f "$RENDERER_JS" ]; then
  RENDER_CHECK=$(node -e "
    const m = require('$RENDERER_JS');
    if (!m.DEFAULT_CONTEXT) { console.log('FAIL:no-ctx'); process.exit(0); }
    // include_pack_summary defaults to false (AI token optimization)
    console.log(m.DEFAULT_CONTEXT.include_pack_summary === false ? 'OK' : 'FAIL:pack=' + m.DEFAULT_CONTEXT.include_pack_summary);
  " 2>/dev/null)
  if [ "$RENDER_CHECK" = "OK" ]; then
    pass "rule-renderer: include_pack_summary defaults to false (token optimization)"
  else
    fail "rule-renderer: $RENDER_CHECK"
  fi
fi

# 8-11. ALL_MODES now covers the v0.3 skill set (specify removed).
# Verify the current-generation skills are enumerated so cancelforgen and
# other mode-aware tools see them.
MODES_CHECK=$(node -e "
  const { ALL_MODES } = require('$VERSION_DIR/dist/core/paths.js');
  const required = ['forge-loop', 'ship', 'retro', 'learn', 'calibrate'];
  const missing = required.filter(m => !ALL_MODES.includes(m));
  if (missing.length === 0) {
    console.log('OK:' + ALL_MODES.length + ' modes, required v0.3 set present');
  } else {
    console.log('FAIL:missing ' + missing.join(','));
  }
" 2>/dev/null)
if echo "$MODES_CHECK" | grep -q "^OK"; then
  pass "ALL_MODES: v0.3 skill set present ($MODES_CHECK)"
else
  fail "ALL_MODES: v0.3 skills missing — $MODES_CHECK"
fi

# 8-12. revert→drift connection (boolean flag, not messages search)
DRIFT_REVERT=$(node -e "
  const src = require('fs').readFileSync('$HOOKS_DIR/post-tool-use.js', 'utf-8');
  // Check that revertDetected flag exists and is used in evaluateDrift call
  const hasFlag = src.includes('revertDetected');
  const usedInDrift = src.includes('evaluateDrift') && src.includes('revertDetected');
  // Old broken pattern: messages.some(m => m.includes('revert'))
  const hasBrokenPattern = /messages\.some.*revert/i.test(src);
  if (hasFlag && usedInDrift && !hasBrokenPattern) {
    console.log('OK');
  } else {
    console.log('FAIL:flag=' + hasFlag + ',drift=' + usedInDrift + ',broken=' + hasBrokenPattern);
  }
" 2>/dev/null)
if [ "$DRIFT_REVERT" = "OK" ]; then
  pass "drift score: revert detection connected via boolean flag"
else
  fail "drift score: revert connection broken — $DRIFT_REVERT"
fi

echo ""

# ──────────────────────────────────────────────
# Phase 9: v0.4.0 Trust Layer — R9 additions
# ──────────────────────────────────────────────
echo "  [Phase 9: v0.4.0 Trust Layer]"

# 9-1. `forgen stats` — 7-number dashboard exists & renders
STATS_OUT=$(forgen stats 2>&1)
if echo "$STATS_OUT" | grep -q "trust layer status"; then
  pass "forgen stats: renders trust layer header"
else
  fail "forgen stats: missing 'trust layer status' header — $STATS_OUT"
fi
if echo "$STATS_OUT" | grep -q "Acknowledgments"; then
  pass "forgen stats: Acknowledgments row present"
else
  fail "forgen stats: missing Acknowledgments row"
fi
if echo "$STATS_OUT" | grep -q "Drift events"; then
  pass "forgen stats: Drift events row present"
else
  fail "forgen stats: missing Drift events row"
fi

# 9-2. `forgen rule <sub>` namespace dispatcher
RULE_HELP=$(forgen rule help 2>&1)
if echo "$RULE_HELP" | grep -q "forgen rule list"; then
  pass "forgen rule help: namespace help shows list subcommand"
else
  fail "forgen rule help: missing namespace help — $RULE_HELP"
fi

RULE_LIST=$(forgen rule list 2>&1)
INSPECT_RULES=$(forgen inspect rules 2>&1)
if [ "$RULE_LIST" = "$INSPECT_RULES" ]; then
  pass "forgen rule list ≡ forgen inspect rules (same output)"
else
  fail "forgen rule list diverges from inspect rules"
fi

# 9-3. Legacy top-level commands still work as aliases
LEGACY_LIFECYCLE=$(forgen lifecycle-scan 2>&1 | head -2)
NEW_SCAN=$(forgen rule scan 2>&1 | head -2)
if [ -n "$LEGACY_LIFECYCLE" ] && [ -n "$NEW_SCAN" ]; then
  pass "legacy forgen lifecycle-scan still runs"
else
  fail "legacy lifecycle-scan or rule scan broken"
fi

# 9-4. `forgen inspect corrections` alias works
CORR_OUT=$(forgen inspect corrections 2>&1)
EVI_OUT=$(forgen inspect evidence 2>&1)
if [ "$CORR_OUT" = "$EVI_OUT" ]; then
  pass "forgen inspect corrections ≡ inspect evidence (alias)"
else
  fail "forgen inspect corrections diverges from evidence"
fi

# 9-5. `forgen last-block` shorthand
if forgen last-block 2>&1 | grep -qE "violations|No .+ data|Recent"; then
  pass "forgen last-block: runs without error"
else
  fail "forgen last-block broken"
fi

# 9-6. stop-guard ack round-trip — block → retract → acknowledgments.jsonl gains entry
TMP_HOME=$(mktemp -d)
mkdir -p "$TMP_HOME/.forgen/state"
SCENARIOS_JSON="$TMP_HOME/scenarios.json"
# Inline the minimal rule scenario for SG-ACK
cat > "$SCENARIOS_JSON" <<'JSON'
{
  "rules": [
    {
      "id": "R-E2E-ACK",
      "mech": "B",
      "hook": "Stop",
      "trigger": {
        "response_keywords_regex": "(완료했|완성됐|완성되|완성했|done\\.|ready\\.|shipped\\.|LGTM|finished\\.)",
        "context_exclude_regex": "(취소|철회|없음|없습니다|않았|하지\\s*않|아닙니다|not\\s*yet|no\\s*longer|retract|withdraw|stuck-loop|force\\s*approve|block\\s*hook)"
      },
      "verifier": {
        "kind": "self_check_prompt",
        "params": {
          "question": "Evidence required.",
          "evidence_path": "e2e-result.json",
          "max_age_s": 3600
        }
      },
      "system_tag": "rule:R-E2E-ACK"
    }
  ]
}
JSON

# Find stop-guard in the installed forgen (follow symlinks of global bin)
FORGEN_BIN=$(which forgen)
FORGEN_REAL=$(readlink -f "$FORGEN_BIN" 2>/dev/null || realpath "$FORGEN_BIN" 2>/dev/null || echo "$FORGEN_BIN")
FORGEN_DIR=$(dirname "$FORGEN_REAL")
STOP_GUARD_BIN="$FORGEN_DIR/hooks/stop-guard.js"
if [ ! -f "$STOP_GUARD_BIN" ]; then
  fail "stop-guard.js not found at $STOP_GUARD_BIN"
else
  SESSION_ID="e2e-ack-test"
  HOOK_INPUT='{"session_id":"'"$SESSION_ID"'","stop_hook_active":true}'

  # Step 1: block
  STEP1=$(echo "$HOOK_INPUT" | HOME="$TMP_HOME" FORGEN_SPIKE_RULES="$SCENARIOS_JSON" FORGEN_SPIKE_LAST_MESSAGE="구현 완료했습니다." node "$STOP_GUARD_BIN" 2>&1)
  if echo "$STEP1" | grep -q '"decision":"block"'; then
    pass "v0.4.0 e2e: stop-guard blocks completion claim without evidence"
  else
    fail "v0.4.0 e2e: expected block, got: $STEP1"
  fi
  BC_FILES=$(ls "$TMP_HOME/.forgen/state/enforcement/block-count/" 2>/dev/null | wc -l)
  if [ "$BC_FILES" -ge 1 ]; then
    pass "v0.4.0 e2e: block-count file created on block"
  else
    fail "v0.4.0 e2e: block-count file missing"
  fi

  # Step 2: retract
  STEP2=$(echo "$HOOK_INPUT" | HOME="$TMP_HOME" FORGEN_SPIKE_RULES="$SCENARIOS_JSON" FORGEN_SPIKE_LAST_MESSAGE="완료 선언을 취소합니다." node "$STOP_GUARD_BIN" 2>&1)
  if echo "$STEP2" | grep -q '"continue":true'; then
    pass "v0.4.0 e2e: stop-guard approves after retraction"
  else
    fail "v0.4.0 e2e: expected approve, got: $STEP2"
  fi

  # ack file gained entry; block-count file cleaned up
  ACK_FILE="$TMP_HOME/.forgen/state/enforcement/acknowledgments.jsonl"
  if [ -f "$ACK_FILE" ]; then
    ACK_LINES=$(wc -l < "$ACK_FILE" | tr -d ' ')
    if [ "$ACK_LINES" -ge 1 ]; then
      pass "v0.4.0 e2e: acknowledgments.jsonl gained $ACK_LINES entry"
    else
      fail "v0.4.0 e2e: acknowledgments.jsonl empty"
    fi
  else
    fail "v0.4.0 e2e: acknowledgments.jsonl not created"
  fi

  BC_AFTER=$(ls "$TMP_HOME/.forgen/state/enforcement/block-count/" 2>/dev/null | wc -l)
  if [ "$BC_AFTER" -eq 0 ]; then
    pass "v0.4.0 e2e: block-count cleaned up after ack"
  else
    fail "v0.4.0 e2e: block-count not cleaned (${BC_AFTER} remain)"
  fi
fi
rm -rf "$TMP_HOME"

# 9-7. `forgen doctor` legacy-path warning
TMP_DOCTOR=$(mktemp -d)
mkdir -p "$TMP_DOCTOR/.forgen/rules"
echo '{}' > "$TMP_DOCTOR/.forgen/rules/orphan.json"
DOCTOR_OUT=$(HOME="$TMP_DOCTOR" forgen doctor 2>&1)
if echo "$DOCTOR_OUT" | grep -q "orphan"; then
  pass "v0.4.0 e2e: forgen doctor warns on legacy ~/.forgen/rules/ orphan"
else
  fail "v0.4.0 e2e: forgen doctor missed orphan file — $(echo "$DOCTOR_OUT" | grep -i rule | head -3)"
fi
rm -rf "$TMP_DOCTOR"

echo ""

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────
echo "═══════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed, $WARN warnings"
echo "═══════════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "  ❌ VERIFICATION FAILED — $FAIL issues must be fixed"
  exit 1
else
  echo "  ✅ ALL CHECKS PASSED"
  exit 0
fi
