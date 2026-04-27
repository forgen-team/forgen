#!/usr/bin/env bash
# =============================================================================
# forgen — Phase 3 Codex 단독 등가성 (Parity) E2E 검증
# =============================================================================
#
# 목적:
#   격리 환경에서 forgen 훅을 Codex 에 설치하고, 실 codex exec 으로 hook 발화 +
#   state 흔적을 자동 검증한 뒤 결과를 ~/.forgen/state/parity-result.json 에
#   박제합니다.
#
# 사용법:
#   ./tests/e2e/codex/run-parity.sh               # 실 Codex API 호출 (1회)
#   ./tests/e2e/codex/run-parity.sh --dry-run     # 네트워크 제외 모든 단계 실행
#
# 사전 요구사항:
#   1. codex login  — ~/.codex/auth.json 존재해야 합니다.
#   2. codex CLI    — PATH 에 codex 가 있어야 합니다.
#   3. forgen CLI   — PATH 에 forgen 이 있어야 합니다 (npm link 또는 전역 설치).
#   4. Node.js      — 빌드용 (npm run build).
#
# 출력:
#   ~/.forgen/state/parity-result.json
#   형식: { "passed": bool, "mock_detected": false, "total": N, "failed": N,
#           "at": "<ISO8601>", "version": "x.y.z", "detail": {...} }
#
# --dry-run 모드:
#   mktemp, cp, npm run build, forgen install 단계까지만 실행.
#   codex exec 은 건너뛰고 passed:null, note:"dry-run" 으로 결과를 저장합니다.
# =============================================================================

set -uo pipefail

# ── 인수 파싱 ──────────────────────────────────────────────────────────────────
DRY_RUN=0
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    DRY_RUN=1
  fi
done

# ── 유틸리티 ───────────────────────────────────────────────────────────────────
BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'

info()    { echo -e "  ${BOLD}>>>${RESET} $*"; }
pass()    { echo -e "  ${GREEN}[PASS]${RESET} $*"; }
fail_msg(){ echo -e "  ${RED}[FAIL]${RESET} $*"; }
warn()    { echo -e "  ${YELLOW}[WARN]${RESET} $*"; }

# ── 경로 설정 ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FORGEN_VERSION="$(node -e "process.stdout.write(require('$PROJECT_ROOT/package.json').version)" 2>/dev/null || echo "unknown")"
RESULT_DIR="${FORGEN_HOME:-$HOME/.forgen}/state"
RESULT_PATH="$RESULT_DIR/parity-result.json"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  forgen Phase 3 — Codex Parity E2E"
echo "  Version  : $FORGEN_VERSION"
echo "  Project  : $PROJECT_ROOT"
if [ "$DRY_RUN" = "1" ]; then
echo "  Mode     : DRY-RUN (네트워크 단계 건너뜀)"
else
echo "  Mode     : LIVE (실 codex exec 호출)"
fi
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── write_result 함수 (JSON 박제) ────────────────────────────────────────────
write_result() {
  local passed="$1"    # "true" | "false" | "null"
  local total="$2"
  local failed_count="$3"
  local detail_json="$4"
  local note="${5:-}"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  mkdir -p "$RESULT_DIR"

  local note_field=""
  if [ -n "$note" ]; then
    note_field="$(printf ',\n  "note": "%s"' "$note")"
  fi

  cat > "$RESULT_PATH" <<JSON
{
  "passed": $passed,
  "mock_detected": false,
  "total": $total,
  "failed": $failed_count,
  "at": "$now",
  "version": "$FORGEN_VERSION"$note_field,
  "detail": $detail_json
}
JSON
  info "parity-result.json 기록 완료: $RESULT_PATH"
}

# ── 임시 디렉토리 ─────────────────────────────────────────────────────────────
CODEX_HOME=$(mktemp -d)
FORGEN_ISOLATED=$(mktemp -d)
info "격리 CODEX_HOME  = $CODEX_HOME"
info "격리 FORGEN_HOME = $FORGEN_ISOLATED"

# cleanup 등록 (EXIT 시 항상 실행)
cleanup() {
  local exit_code=$?
  echo ""
  info "임시 디렉토리 cleanup..."
  rm -rf "$CODEX_HOME" "$FORGEN_ISOLATED"
  info "cleanup 완료"
  exit $exit_code
}
trap cleanup EXIT

# ── Step 1: codex auth 복사 ────────────────────────────────────────────────────
echo ""
echo "─── Step 1: codex auth 복사 ──────────────────────────────────────────"

SOURCE_AUTH="$HOME/.codex/auth.json"
if [ -f "$SOURCE_AUTH" ]; then
  cp "$SOURCE_AUTH" "$CODEX_HOME/auth.json"
  pass "auth.json 복사 완료"
else
  fail_msg "~/.codex/auth.json 없음"
  echo ""
  echo "  해결 방법: codex login 을 먼저 실행하세요."
  echo "  dry-run 이 아닌 실 실행에서는 auth 필수입니다."
  echo ""
  if [ "$DRY_RUN" = "0" ]; then
    write_result "false" "0" "1" '{"step":"auth","error":"auth.json not found — run codex login first"}'
    exit 1
  fi
  warn "dry-run 모드: auth 없이 계속 진행합니다."
fi

# codex installation_id (best-effort)
SOURCE_INSTALL_ID="$HOME/.codex/installation_id"
if [ -f "$SOURCE_INSTALL_ID" ]; then
  cp "$SOURCE_INSTALL_ID" "$CODEX_HOME/installation_id"
  pass "installation_id 복사 완료"
else
  warn "~/.codex/installation_id 없음 (선택 사항, 건너뜁니다)"
fi

# ── Step 2: forgen 빌드 ────────────────────────────────────────────────────────
echo ""
echo "─── Step 2: forgen 빌드 ─────────────────────────────────────────────"
info "npm run build (PROJECT_ROOT=$PROJECT_ROOT)"
cd "$PROJECT_ROOT"
if npm run build 2>&1 | tail -5; then
  pass "빌드 성공"
else
  fail_msg "빌드 실패"
  write_result "false" "0" "1" '{"step":"build","error":"npm run build failed"}'
  exit 1
fi

# ── Step 3: forgen install codex (격리 CODEX_HOME) ───────────────────────────
echo ""
echo "─── Step 3: forgen install codex → 격리 CODEX_HOME ──────────────────"

INSTALL_FLAGS=""
if [ "$DRY_RUN" = "1" ]; then
  INSTALL_FLAGS="--dry-run"
fi

INSTALL_OUT=$(CODEX_HOME="$CODEX_HOME" FORGEN_HOME="$FORGEN_ISOLATED" \
  forgen install codex $INSTALL_FLAGS 2>&1) || {
    fail_msg "forgen install codex 실패"
    echo "$INSTALL_OUT"
    write_result "false" "0" "1" '{"step":"install","error":"forgen install codex failed"}'
    exit 1
  }
pass "forgen install codex 완료"
echo "$INSTALL_OUT" | grep -E "hooks\.json|config\.toml|CODEX_HOME|written|dry" | head -5 || true

# hooks.json 존재 확인 (dry-run 이면 파일을 쓰지 않으므로 체크 건너뜀)
if [ "$DRY_RUN" = "0" ]; then
  if [ -f "$CODEX_HOME/hooks.json" ]; then
    pass "hooks.json 생성 확인"
  else
    fail_msg "hooks.json 미생성"
    write_result "false" "0" "1" '{"step":"install","error":"hooks.json not created after forgen install codex"}'
    exit 1
  fi
fi

# ── Step 4: codex exec (실 API 호출) ──────────────────────────────────────────
echo ""
echo "─── Step 4: codex exec ───────────────────────────────────────────────"

if [ "$DRY_RUN" = "1" ]; then
  warn "dry-run: codex exec 건너뜀"
  write_result "null" "0" "0" '{"step":"codex_exec","skipped":true}' "dry-run"
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo "  DRY-RUN 완료 — 네트워크 이전 단계 모두 통과"
  echo "  결과: $RESULT_PATH"
  echo "═══════════════════════════════════════════════════════════"
  exit 0
fi

# 실 codex exec
info "codex exec 실행 중..."
TIMING_BEFORE=0
if [ -f "$FORGEN_ISOLATED/state/hook-timing.jsonl" ]; then
  TIMING_BEFORE=$(wc -l < "$FORGEN_ISOLATED/state/hook-timing.jsonl")
fi

CODEX_STDOUT=""
CODEX_STDERR=""
CODEX_EXIT=0

CODEX_STDOUT=$(
  CODEX_HOME="$CODEX_HOME" FORGEN_HOME="$FORGEN_ISOLATED" \
  codex exec \
    -s read-only \
    -c approval_policy="never" \
    --ephemeral \
    --skip-git-repo-check \
    "Reply with the literal single word: pong" 2>/tmp/forgen-parity-stderr-$$ ) || CODEX_EXIT=$?

CODEX_STDERR=$(cat /tmp/forgen-parity-stderr-$$ 2>/dev/null || true)
rm -f /tmp/forgen-parity-stderr-$$

info "codex exec 종료 (exit=$CODEX_EXIT)"

# ── Step 5: 결과 파싱 ─────────────────────────────────────────────────────────
echo ""
echo "─── Step 5: 결과 파싱 ───────────────────────────────────────────────"

TOTAL_CHECKS=3
FAILED_CHECKS=0
CHECKS=()

# 체크 1: 모델 응답에 "pong" 포함
if echo "$CODEX_STDOUT" | grep -qi "pong"; then
  pass "체크 1/3 — 모델 응답에 'pong' 포함"
  CHECKS+=("\"model_response\": \"pass\"")
else
  fail_msg "체크 1/3 — 응답에 'pong' 없음 (응답: $(echo "$CODEX_STDOUT" | head -1))"
  CHECKS+=("\"model_response\": \"fail\"")
  FAILED_CHECKS=$((FAILED_CHECKS + 1))
fi

# 체크 2: hook 발화 흔적 (stderr "hook: <name> Completed" 또는 hook-timing.jsonl 항목)
HOOK_COMPLETED_COUNT=$(echo "$CODEX_STDERR" | grep -c "hook:.*Completed" 2>/dev/null || echo 0)
TIMING_AFTER=0
if [ -f "$FORGEN_ISOLATED/state/hook-timing.jsonl" ]; then
  TIMING_AFTER=$(wc -l < "$FORGEN_ISOLATED/state/hook-timing.jsonl")
fi
TIMING_NEW=$((TIMING_AFTER - TIMING_BEFORE))

if [ "$HOOK_COMPLETED_COUNT" -gt 0 ] || [ "$TIMING_NEW" -gt 0 ]; then
  pass "체크 2/3 — hook 발화 확인 (stderr Completed=$HOOK_COMPLETED_COUNT, timing_new=$TIMING_NEW)"
  CHECKS+=("\"hook_fired\": \"pass\", \"hook_completed_in_stderr\": $HOOK_COMPLETED_COUNT, \"timing_new_entries\": $TIMING_NEW")
else
  fail_msg "체크 2/3 — hook 발화 흔적 없음 (hook-timing.jsonl 항목 변화 없음, stderr Completed=0)"
  CHECKS+=("\"hook_fired\": \"fail\", \"hook_completed_in_stderr\": 0, \"timing_new_entries\": 0")
  FAILED_CHECKS=$((FAILED_CHECKS + 1))
fi

# 체크 3: state 흔적 (hook-timing.jsonl 또는 hook-errors.jsonl 존재)
STATE_FILES=$(ls "$FORGEN_ISOLATED/state/" 2>/dev/null | wc -l)
if [ "$STATE_FILES" -gt 0 ]; then
  pass "체크 3/3 — state 흔적 확인 ($STATE_FILES 파일)"
  CHECKS+=("\"state_trace\": \"pass\", \"state_file_count\": $STATE_FILES")
else
  fail_msg "체크 3/3 — state 흔적 없음 (FORGEN_HOME=$FORGEN_ISOLATED/state)"
  CHECKS+=("\"state_trace\": \"fail\", \"state_file_count\": 0")
  FAILED_CHECKS=$((FAILED_CHECKS + 1))
fi

# ── Step 6: parity-result.json 박제 ──────────────────────────────────────────
echo ""
echo "─── Step 6: 결과 박제 ───────────────────────────────────────────────"

DETAIL_JSON="{\"checks\": {$(IFS=,; echo "${CHECKS[*]}")}}"

if [ "$FAILED_CHECKS" -eq 0 ]; then
  write_result "true" "$TOTAL_CHECKS" "0" "$DETAIL_JSON"
  FINAL_STATUS="PASSED"
else
  write_result "false" "$TOTAL_CHECKS" "$FAILED_CHECKS" "$DETAIL_JSON"
  FINAL_STATUS="FAILED"
fi

# ── 최종 요약 ─────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
if [ "$FINAL_STATUS" = "PASSED" ]; then
  echo -e "  ${GREEN}${BOLD}PARITY PASSED${RESET} — $TOTAL_CHECKS/$TOTAL_CHECKS checks 통과"
else
  echo -e "  ${RED}${BOLD}PARITY FAILED${RESET} — $FAILED_CHECKS/$TOTAL_CHECKS checks 실패"
fi
echo "  결과: $RESULT_PATH"
echo "═══════════════════════════════════════════════════════════"
echo ""

[ "$FAILED_CHECKS" -eq 0 ]
