FROM node:22-slim

# git 설치 (postinstall에서 git 사용)
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Claude Code CLI 설치
RUN npm i -g @anthropic-ai/claude-code@latest 2>/dev/null || echo "Claude CLI install skipped (may need auth)"

# 작업 디렉터리
WORKDIR /workspace

# forgen 패키지 복사 (npm pack으로 생성한 tarball)
COPY *forgen*.tgz /tmp/forgen.tgz

# 글로벌 설치 — 실제 사용자 환경과 동일
RUN npm i -g /tmp/forgen.tgz

# P1-6b (2026-04-28): postinstall 이 신규 사용자에겐 자동 host 인젝션 안 함 (사용자
# 의도 보장 — Claude bias 제거). E2E 검증은 *명시 forgen install* 후 시나리오를 가정.
# 실 사용자는 npm install -g forgen 후 forgen install [claude|codex|both] 실행.
RUN forgen install claude

# 테스트 스크립트 복사
COPY verify.sh /workspace/verify.sh
RUN chmod +x /workspace/verify.sh

# 테스트 프로젝트 초기화
RUN mkdir -p /workspace/test-project && \
    cd /workspace/test-project && \
    git init && \
    npm init -y && \
    echo '{}' > tsconfig.json

WORKDIR /workspace/test-project

ENTRYPOINT ["/workspace/verify.sh"]
