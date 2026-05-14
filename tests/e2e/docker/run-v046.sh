#!/bin/bash
# v0.4.6 clean-container e2e — claude + codex with mounted credentials
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "=== forgen v0.4.6 Clean-Container E2E ==="
cd "$PROJECT_ROOT"

# 1) Build + pack
echo ">>> Building..."
npm run build >/dev/null
echo ">>> Packing..."
TARBALL=$(npm pack --pack-destination "$SCRIPT_DIR" 2>&1 | tail -1)
echo "    $TARBALL"

# 2) Build image
echo ">>> Building Docker image (forgen-v046-e2e)..."
docker build -q -t forgen-v046-e2e -f "$SCRIPT_DIR/Dockerfile.v046" "$SCRIPT_DIR"

# 3) Run with credentials mounted
echo ""
echo ">>> Running with mounted credentials (read-only)..."
echo ""

docker run --rm \
  -v "$HOME/.claude.json:/root/.claude.json:ro" \
  -v "$HOME/.claude:/root/.claude:ro" \
  -v "$HOME/.codex:/root/.codex" \
  -v "/tmp/forgen-v046-state:/root/.forgen" \
  forgen-v046-e2e

CODE=$?

echo ""
echo ">>> Cleaning up tarball..."
rm -f "$SCRIPT_DIR"/forgen-*.tgz

exit $CODE
