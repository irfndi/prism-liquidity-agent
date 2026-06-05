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

# Non-root user
RUN groupadd -g 1001 agent && useradd -u 1001 -g agent -s /bin/sh -m agent

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Logs directory writable by agent user
RUN mkdir -p /app/logs && chown -R agent:agent /app/logs

USER agent

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD bun -e "process.exit(0)"

CMD ["bun", "dist/index.mjs"]
