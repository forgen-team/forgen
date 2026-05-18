#!/usr/bin/env bash
# refresh.sh
#
# 코퍼스 재수집 — 이벤트 기반 (주기 X).
# 코드 컨벤션은 잘 안 바뀐다. 갱신이 필요한 건 다음 이벤트 발생 시:
#
#   1. React 메이저 버전 릴리스 (예: 19 → 20)
#   2. Next.js 메이저 버전 릴리스 (예: 16 → 17)
#   3. Vue/Nuxt 메이저 버전 릴리스
#   4. web.dev Core Web Vitals 변경 (예: 2024 FID → INP 교체)
#   5. WCAG 개정 (2.2 → 3.0 등, W3C 권고 발표)
#   6. Toss FF / Vercel / Google a11y 가이드 큰 개정 (블로그 공지)
#
# 사용법:
#   ./adapters/refresh.sh          # 이벤트 체크리스트 + 각 이벤트별 갱신 절차 출력
#   ./adapters/refresh.sh --check  # 코퍼스 마지막 수집 날짜 확인 (감시용)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCES="$ROOT/sources"

if [[ "${1:-}" == "--check" ]]; then
  echo "코퍼스 마지막 수집 날짜:"
  for dir in "$SOURCES"/*/; do
    name=$(basename "$dir")
    if [[ -f "$dir/INDEX.md" ]]; then
      date=$(grep -m1 -oE 'fetched: *[0-9]{4}-[0-9]{2}-[0-9]{2}' "$dir/INDEX.md" | awk '{print $2}' || echo "unknown")
      count=$(find "$dir" -name "*.md" ! -name "INDEX.md" | wc -l | tr -d ' ')
      printf "  %-12s  fetched=%s  files=%s\n" "$name" "$date" "$count"
    else
      printf "  %-12s  (INDEX.md 없음)\n" "$name"
    fi
  done
  exit 0
fi

cat <<'EOF'
=== fe-guide 코퍼스 갱신 — 이벤트 트리거 ===

코드 컨벤션은 잘 안 바뀐다. 주기 갱신 X, 아래 이벤트 발생 시에만 해당 디렉토리 갱신.

┌─ 이벤트 ────────────────────────┬─ 갱신 대상 ──────────────────┬─ 영향받는 principles ─┐
│ React 메이저 (19→20 등)         │ sources/react/               │ principles/react.md   │
│ Next.js 메이저 (16→17 등)       │ sources/perf/06-09.md        │ principles/react.md   │
│ Vue 메이저 (3→4) / Nuxt 메이저  │ sources/vue/                 │ principles/vue.md     │
│ web.dev Core Web Vitals 변경    │ sources/perf/01-03.md        │ principles/common.md B│
│ WCAG 개정 (2.2→3.0 등)          │ sources/a11y-dx/wcag22-*.md  │ principles/common.md C│
│ Toss FF 신규 챕터 / 큰 개정     │ sources/toss-ff/             │ principles/common.md A│
│ Chrome DevTools 큰 UI 변경      │ sources/a11y-dx/chrome-*.md  │ (스킬 fe-perf 절차)  │
└─────────────────────────────────┴─────────────────────────────┴───────────────────────┘

체크 절차 (이벤트 발생 의심 시):
  1. ./refresh.sh --check        # 마지막 수집 날짜 확인
  2. 위 표에서 해당 행 식별
  3. Claude/Codex 에이전트에 위임 (가장 안정):
       "fe-guide/sources/<dir>/INDEX.md 의 출처들을 최신화해서 같은 형식으로 재저장해줘"
  4. 갱신 후 영향받는 principles/*.md 검토 → 합의 원칙 변경 필요한지 판단
  5. principles 변경 시 PR 로 이력 남김 (사내 합의 문서)

이벤트 모니터링 (선택):
  - React/Next 릴리스: github.com/facebook/react/releases, vercel/next.js/releases (RSS)
  - Vue/Nuxt: github.com/vuejs/core/releases, nuxt/nuxt/releases
  - web.dev/WCAG: web.dev/blog RSS, w3.org/WAI/standards-guidelines/wcag/

권장: 큰 이벤트는 보통 한미국·유럽 컨퍼런스 시즌(React Conf, Next.js Conf, Google I/O)에 발표됨.
     그 직후 1주 안에 --check 한 번 돌리고 위 표 매칭이면 갱신.
EOF
