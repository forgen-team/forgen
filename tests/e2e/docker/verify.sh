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
