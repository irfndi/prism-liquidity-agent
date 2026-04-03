# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json tsup.config.ts ./
COPY src ./src

RUN bun run build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Non-root user
RUN addgroup -g 1001 -S agent && adduser -u 1001 -S agent -G agent

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Logs directory writable by agent user
RUN mkdir -p /app/logs && chown -R agent:agent /app/logs

USER agent

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "process.exit(0)"

CMD ["node", "dist/main.js"]

