import { Command } from "commander";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  bearerFrom,
  prune,
  route,
  tokenMatches,
  UNAUTHORIZED,
  type FeedOptions,
  type FeedReply,
  type FeedState,
} from "../engine/copy-signal-feed.js";

interface ServeOptions {
  readonly port?: string;
  readonly host?: string;
  readonly retentionHours?: string;
  readonly maxEntries?: string;
  readonly staleMs?: string;
}

const DEFAULT_RETENTION_HOURS = 24;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_STALE_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    request.on("error", (cause: Error) => reject(cause));
  });
}

function send(response: ServerResponse, reply: FeedReply): void {
  const payload = JSON.stringify(reply.body);
  response.writeHead(reply.status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The copy-signal feed server.
 *
 * Replaces the unversioned `prism-copy-signals` worker whose source lived in a
 * deleted directory (issue #250). Shipped in the CLI bundle, so every release
 * distributes the producer together with the consumer.
 */
export const copyFeedCommand = new Command("copy-feed")
  .description("Serve the copy-trading signal feed consumed by COPY_SIGNALS_ENDPOINT")
  .option("--port <n>", "Listen port", "8787")
  .option("--host <addr>", "Bind address", "127.0.0.1")
  .option(
    "--retention-hours <n>",
    "Drop observations older than this",
    String(DEFAULT_RETENTION_HOURS),
  )
  .option("--max-entries <n>", "Keep at most this many observations", String(DEFAULT_MAX_ENTRIES))
  .option("--stale-ms <n>", "Health reports stale above this age", String(DEFAULT_STALE_MS))
  .action((options: ServeOptions) => {
    const token = process.env.COPY_SIGNALS_TOKEN ?? "";
    if (token.length === 0) {
      // Fail closed at startup: serving an open feed is never the intended state.
      console.error(
        "copy-feed: COPY_SIGNALS_TOKEN is required — refusing to serve an unauthenticated signal feed",
      );
      process.exitCode = 1;
      return;
    }
    const feed: FeedOptions = {
      token,
      retentionMs: positiveNumber(options.retentionHours, DEFAULT_RETENTION_HOURS) * 3_600_000,
      maxEntries: Math.max(1, positiveNumber(options.maxEntries, DEFAULT_MAX_ENTRIES)),
      staleMs: positiveNumber(options.staleMs, DEFAULT_STALE_MS),
      now: () => Date.now(),
    };
    const state: FeedState = { observations: [] };
    const port = Math.max(1, positiveNumber(options.port, 8787));
    const host = options.host ?? "127.0.0.1";

    const server = createServer((request, response) => {
      const presented = bearerFrom(request.headers.authorization ?? null);
      if (!tokenMatches(presented, feed.token)) {
        send(response, UNAUTHORIZED);
        return;
      }
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method !== "POST") {
        send(response, route(state, feed, { method: request.method ?? "GET", path, body: "" }));
        return;
      }
      void readBody(request)
        .then((body) => send(response, route(state, feed, { method: "POST", path, body })))
        .catch((error: Error) => {
          send(response, { status: 400, body: { ok: false, reason: error.message } });
        });
    });

    server.listen(port, host, () => {
      console.log(
        `copy-feed listening on http://${host}:${port} (retention ${feed.retentionMs / 3_600_000}h)`,
      );
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        state.observations = prune(
          state.observations,
          Date.now(),
          feed.retentionMs,
          feed.maxEntries,
        );
        server.close(() => process.exit(0));
      });
    }
  });
