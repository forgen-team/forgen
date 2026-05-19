#!/usr/bin/env bash
# build-agents-md.sh
#
# Claude SKILL.md (frontmatter + body) 를 Codex AGENTS.md 형식으로 변환.
#
# 사용법:
#   ./adapters/build-agents-md.sh react fe-build > /path/to/project/AGENTS.md
#   ./adapters/build-agents-md.sh vue fe-review
#
# 동작:
#   1. skills/<stack>/<skill>/SKILL.md 읽음
#   2. YAML frontmatter (name, description) 떼어내고 본문만 추출
#   3. AGENTS.md 표준 헤더로 감싸고 stdout 출력
#
# Codex CLI 는 프로젝트 루트의 AGENTS.md 를 자동으로 읽음 (또는 ~/.codex/AGENTS.md 전역).
# Claude Code 는 SKILL.md 를 직접 사용 (skill loader 가 frontmatter 인식).

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <stack> <skill>" >&2
  echo "  stack: react | vue" >&2
  echo "  skill: fe-build | fe-review | fe-perf" >&2
  exit 1
fi

STACK="$1"
SKILL="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_FILE="$ROOT/skills/$STACK/$SKILL/SKILL.md"

if [[ ! -f "$SKILL_FILE" ]]; then
  echo "Error: $SKILL_FILE not found" >&2
  exit 2
fi

# frontmatter 파싱: 첫 --- 부터 두번째 --- 사이가 YAML
NAME=$(awk '/^---$/{c++; next} c==1 && /^name:/ {sub(/^name:[[:space:]]*/,""); print; exit}' "$SKILL_FILE")
DESC=$(awk '/^---$/{c++; next} c==1 && /^description:/ {sub(/^description:[[:space:]]*/,""); print; exit}' "$SKILL_FILE")

# 본문: 두번째 --- 이후
BODY=$(awk '/^---$/{c++; next} c>=2 {print}' "$SKILL_FILE")

cat <<EOF
# ${NAME:-$SKILL}

> ${DESC:-FE engineering guide for $STACK}
>
> Generated from \`skills/$STACK/$SKILL/SKILL.md\` on $(date +%Y-%m-%d).
> Source of truth: ${FE_GUIDE_SOURCE:-fe-guide (OSS skill bundle — set FE_GUIDE_SOURCE to override)}

## When to apply

When working on $STACK code in this repository, follow the guidance below.
You can also load the principles via:

- \`principles/common.md\` — framework-neutral rules
- \`principles/$STACK.md\` — $STACK-specific rules

---

$BODY
EOF
