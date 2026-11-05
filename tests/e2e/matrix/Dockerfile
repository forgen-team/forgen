FROM node:22-bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq tmux curl git ca-certificates procps python3 jq cron >/dev/null 2>&1; \
    npm i -g @anthropic-ai/claude-code >/dev/null 2>&1; claude --version
RUN useradd -m -s /bin/bash dev
USER dev
ENV NVM_DIR=/home/dev/.nvm
RUN curl -fsSo- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null 2>&1; . $NVM_DIR/nvm.sh && nvm install 22 >/dev/null 2>&1 && nvm install 24 >/dev/null 2>&1 && nvm install 20 >/dev/null 2>&1 && nvm ls --no-colors | head
