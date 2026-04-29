# forgen-eval — testbed runner image
#
# Scope: container builds the package and runs unit tests (γ/β/δ/ε/ζ/φ/ψ formula correctness).
# The full smoke testbed (live judges + claude-mem) requires Ollama + Bun + GPU on the host
# and is intentionally out of scope for this image — see docker-compose.yml for that path.

# ---------- Stage 1: build ----------
FROM node:22.11-bookworm-slim AS build

WORKDIR /forgen-eval

# Standalone install — bypasses parent forgen postinstall + ensures rolldown native bindings install
COPY packages/forgen-eval/package.json ./

# Strip claude-mem devDep + peerDep before install (claude-mem is 120MB and not needed for unit tests;
# peerDep can't resolve without parent forgen workspace)
RUN node -e "const p=require('./package.json'); delete p.devDependencies['claude-mem']; delete p.peerDependencies; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2));"

RUN npm install --omit=optional=false

# Copy sources
COPY packages/forgen-eval/tsconfig.json ./
COPY packages/forgen-eval/src ./src
COPY packages/forgen-eval/tests ./tests
COPY packages/forgen-eval/vitest.config.ts ./

# Type-check + unit tests (live evidence, no mocks)
RUN npx tsc --noEmit -p tsconfig.json
RUN npx vitest run --no-coverage

# ---------- Stage 2: runtime ----------
FROM node:22.11-bookworm-slim AS runtime

# Non-root user
RUN groupadd -r forgen && useradd -r -g forgen -d /home/forgen -m forgen

RUN mkdir -p /app/forgen-eval && chown -R forgen:forgen /app
WORKDIR /app/forgen-eval

COPY --from=build --chown=forgen:forgen /forgen-eval ./

USER forgen

# Default: run unit tests (treat as in-container smoke). Override CMD for actual smoke runner.
CMD ["npx", "vitest", "run", "--no-coverage"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1
