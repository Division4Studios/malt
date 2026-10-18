# MALT broker image.
#
# The backend runs TypeScript with Node.js 24's built-in type stripping.
# A separate build stage compiles the dependency-free browser application.
# Only production server dependencies and compiled browser assets enter the
# final image; TypeScript, ESLint and Prettier remain build-time tools.
#
# Layers run from least to most frequently changed: system packages, pinned
# provider CLIs, npm dependencies, then MALT's own source. BuildKit cache
# mounts keep apt and npm downloads between builds without adding them to the
# image, so a source-only change rebuilds only the final copy steps.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS web-build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --ignore-scripts --prefer-offline
COPY web ./web
COPY scripts/build-shell.ts ./scripts/build-shell.ts
RUN npm run build:web

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ENV NODE_ENV=production
WORKDIR /app

# GitHub coordination uses the official gh CLI; authentication is supplied at
# runtime, never baked into the image or persisted in project state.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates jq \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends git gh

# These are native provider executables, isolated from the dependency-free PWA.
# Pin versions; authentication is performed at runtime in a separate credential volume.
ARG CODEX_VERSION=0.162.1
ARG CLAUDE_VERSION=2.1.296
ARG TARGETARCH
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --global --ignore-scripts --prefer-offline @openai/codex@${CODEX_VERSION} \
    && case "$TARGETARCH" in amd64) platform=linux-x64 ;; arm64) platform=linux-arm64 ;; *) exit 1 ;; esac \
    && curl --fail --silent --show-error --retry 3 --max-time 120 \
       "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/manifest.json" -o /tmp/claude-manifest.json \
    && checksum=$(jq -er --arg platform "$platform" '.platforms[$platform].checksum | select(test("^[a-f0-9]{64}$"))' /tmp/claude-manifest.json) \
    && curl --fail --silent --show-error --retry 3 --max-time 180 \
       "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/${platform}/claude" -o /usr/local/bin/claude \
    && echo "$checksum  /usr/local/bin/claude" | sha256sum --check \
    && chmod 755 /usr/local/bin/claude \
    && rm /tmp/claude-manifest.json \
    && codex --version && claude --version

# npm dependencies change more often than the provider CLIs and less often than
# source. --ignore-scripts: no dependency may run install-time code in the image.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --prefer-offline \
    && node --input-type=module -e "await import('node-pty')"

COPY src ./src
COPY resources/factory-skills ./resources/factory-skills
COPY resources/workflows ./resources/workflows
COPY web ./web
COPY --from=web-build /app/web/dist ./web/dist

# The commit this image was built from, reported on /health; pass it with
# MALT_SOURCE_REVISION=$(git rev-parse HEAD) docker compose build.
ARG MALT_SOURCE_REVISION=
ENV MALT_SOURCE_REVISION=${MALT_SOURCE_REVISION}

# /data holds the project's configuration, identities and SQLite state; it is
# bind-mounted from the broker-home folder. Workspaces have a separate host
# bind mount so their .malt data is written into each actual project.
RUN mkdir /data && chown node:node /data
USER node
ENV DISABLE_AUTOUPDATER=1
EXPOSE 4317 4318
VOLUME ["/data"]
CMD ["node", "src/docker-runtime.ts"]
