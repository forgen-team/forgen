#!/bin/bash
# V10: 여러 Linux 베이스에서 verify.sh 를 돌려 forgen v0.4.0 의 호환성 실측.
# 각 베이스마다 동일 verify.sh (77 check) 를 돌려 같은 결과가 나와야 ship.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "=== forgen multi-distro e2e ==="
echo "Project: $PROJECT_ROOT"
echo ""

cd "$PROJECT_ROOT"
echo ">>> Building forgen..."
npm run build >/dev/null

echo ">>> Packing forgen..."
TARBALL=$(npm pack --pack-destination "$SCRIPT_DIR" 2>&1 | tail -1)
echo "    Packed: $TARBALL"
echo ""

DISTROS=("slim:Dockerfile" "alpine:Dockerfile.alpine" "ubuntu:Dockerfile.ubuntu")
FINAL_FAIL=0

for entry in "${DISTROS[@]}"; do
  name="${entry%%:*}"
  file="${entry##*:}"
  echo "─────────────────────────────────────"
  echo ">>> [$name] build image from $file..."
  docker build -t "forgen-e2e-$name" -f "$SCRIPT_DIR/$file" "$SCRIPT_DIR" >/dev/null

  echo ">>> [$name] run verify.sh..."
  OUTPUT=$(docker run --rm "forgen-e2e-$name" 2>&1 || true)
  RESULTS=$(echo "$OUTPUT" | grep -E "Results:" | tail -1)
  if [[ "$RESULTS" =~ Results:\ ([0-9]+)\ passed,\ ([0-9]+)\ failed,\ ([0-9]+)\ warnings ]]; then
    PASS="${BASH_REMATCH[1]}"
    FAIL="${BASH_REMATCH[2]}"
    WARN="${BASH_REMATCH[3]}"
    if [ "$FAIL" -eq 0 ]; then
      echo "    [$name] ✓ $PASS passed, $FAIL failed, $WARN warnings"
    else
      echo "    [$name] ✗ $PASS passed, $FAIL failed, $WARN warnings"
      FINAL_FAIL=1
      # Print failed lines for debugging
      echo "$OUTPUT" | grep -E "^\s*✗" | head -20 | sed "s/^/    [$name]  /"
    fi
  else
    echo "    [$name] ✗ could not parse Results line"
    echo "$OUTPUT" | tail -20 | sed "s/^/    [$name]  /"
    FINAL_FAIL=1
  fi
  echo ""
done

# Cleanup tarball
rm -f "$SCRIPT_DIR"/*forgen*.tgz

if [ "$FINAL_FAIL" -eq 0 ]; then
  echo "✅ ALL DISTROS PASSED"
  exit 0
else
  echo "❌ one or more distros failed"
  exit 1
fi
