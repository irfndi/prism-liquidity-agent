# ── Stage 1: Build ─────────────────────────────────────────────────────────
FROM oven/bun:canary-slim AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY tsconfig.json tsdown.config.ts ./
COPY engine ./engine
COPY cli ./cli
COPY ops ./ops
COPY types ./types

RUN bun run build

# ── Stage 2: Runtime ───────────────────────────────────────────────────────
FROM oven/bun:canary-slim AS runtime

WORKDIR /app

# sqlite-vec ships glibc-only binaries; Debian slim provides a libsqlite3
# compiled with SQLITE_ENABLE_LOAD_EXTENSION so the vec0 module can load.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libsqlite3-0 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Non-root user (Debian slim uses --system, not Alpine -S/-G flags)
RUN groupadd --system --gid 1001 agent \
  && useradd  --system --uid 1001 --gid agent --no-create-home --shell /sbin/nologin agent

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Data directory writable by agent user (db, logs, credentials). The engine's
# paths resolve from PRISM_DATA_DIR / PRISM_CONFIG_DIR / SQLITE_DB_PATH; the
# agent user has no home dir (--no-create-home), so /app/data is the anchor.
RUN mkdir -p /app/data && chown -R agent:agent /app/data

ENV PRISM_DATA_DIR=/app/data \
    PRISM_CONFIG_DIR=/app/data \
    SQLITE_DB_PATH=/app/data/prism.db

USER agent

# Bun-based healthcheck: the runtime image only ships Bun (no node).
# We use a side-effect-free fs probe to verify the bundled dist is in
# place. Importing /app/dist/index.mjs would start the agent
# (Effect.never), so we cannot use it as a probe.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD bun -e "import('fs').then(({existsSync}) => process.exit(existsSync('/app/dist/index.mjs') ? 0 : 1))"

CMD ["bun", "dist/index.mjs"]
