# ── Stage 1: Build ─────────────────────────────────────────────────────────
FROM oven/bun:1.2-slim AS builder

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY tsconfig.json tsdown.config.ts ./
COPY engine ./engine
COPY cli ./cli
COPY ops ./ops

RUN bun run build

# ── Stage 2: Runtime ───────────────────────────────────────────────────────
FROM oven/bun:1.2-slim AS runtime

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

# Logs directory writable by agent user
RUN mkdir -p /app/logs && chown -R agent:agent /app/logs

USER agent

# Bun-based healthcheck: the runtime image only ships Bun (no node).
# We use a side-effect-free fs probe to verify the bundled dist is in
# place. Importing /app/dist/index.mjs would start the agent
# (Effect.never), so we cannot use it as a probe.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD bun -e "import('fs').then(({existsSync}) => process.exit(existsSync('/app/dist/index.mjs') ? 0 : 1))"

CMD ["bun", "dist/index.mjs"]
