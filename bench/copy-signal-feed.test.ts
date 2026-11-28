/**
 * E2E: the copy-signal feed's auth + health contract (issue #250).
 *
 * The failure this prevents is not "the server crashes" — it is "the server is
 * up, answers 200, and the consumer silently applies nothing". So the test
 * serves the REAL routing function over a real socket and asserts on what the
 * ENGINE sees: `engine/copy-trading-signals.ts` parses the bytes the feed
 * produces.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  bearerFrom,
  evaluateHealth,
  prune,
  route,
  tokenMatches,
  UNAUTHORIZED,
  validateObservation,
  type CopySignalObservation,
  type FeedOptions,
  type FeedReply,
  type FeedState,
} from "../engine/copy-signal-feed.js";
import { parseCopySignalPayload } from "../engine/copy-trading-signals.js";

const TOKEN = "feed-token-0123456789";
const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const POOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYsLVL9zYtAWWM";

function observation(overrides: Partial<CopySignalObservation> = {}): CopySignalObservation {
  return {
    wallet: WALLET,
    poolAddress: POOL,
    action: "ENTER",
    confidence: 0.8,
    observedAt: Date.now(),
    ...overrides,
  };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

/**
 * The production routing over a real port. Only the socket plumbing is local —
 * auth, routing, validation and state all come from `engine/copy-signal-feed`.
 */
function startFeed(options: Partial<FeedOptions> = {}): Promise<string> {
  const feed: FeedOptions = {
    token: TOKEN,
    retentionMs: 3_600_000,
    maxEntries: 500,
    staleMs: 60_000,
    now: () => Date.now(),
    ...options,
  };
  const state: FeedState = { observations: [] };
  const server = createServer((request, response) => {
    const reply = (status: number, body: FeedReply["body"]): void => {
      const payload = JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(payload);
    };
    if (!tokenMatches(bearerFrom(request.headers.authorization ?? null), feed.token)) {
      return reply(UNAUTHORIZED.status, UNAUTHORIZED.body);
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method !== "POST") {
      const outcome = route(state, feed, { method: request.method ?? "GET", path, body: "" });
      return reply(outcome.status, outcome.body);
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const outcome = route(state, feed, {
        method: "POST",
        path,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      return reply(outcome.status, outcome.body);
    });
    return undefined;
  });
  servers.push(server);
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: a listening TCP server always reports an AddressInfo object
      // carrying the bound port.
      const address = server.address() as AddressInfo;
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe("copy-signal feed", () => {
  it("rejects every unauthenticated route, including health", async () => {
    const base = await startFeed();
    for (const path of ["/health", "/signals"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(401);
    }
    const post = await fetch(`${base}/signals`, {
      method: "POST",
      body: JSON.stringify(observation()),
    });
    expect(post.status).toBe(401);
  });

  it("rejects a wrong token of the same length, and never accepts an empty expected token", () => {
    const wrong = TOKEN.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    expect(wrong).toHaveLength(TOKEN.length);
    expect(tokenMatches(wrong, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(null, TOKEN)).toBe(false);
    // The fail-closed case the CLI refuses to start with.
    expect(tokenMatches("", "")).toBe(false);
  });

  it("hands the engine a payload it can parse", async () => {
    const base = await startFeed();
    const posted = await fetch(`${base}/signals`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(observation()),
    });
    expect(posted.status).toBe(202);

    const fetched = await fetch(`${base}/signals`, { headers: auth });
    expect(fetched.status).toBe(200);
    // The consumer's OWN parser is the contract — not a test-local shape.
    const parsed = parseCopySignalPayload(await fetched.json());
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ wallet: WALLET, poolAddress: POOL, action: "ENTER" });
  });

  it("health is honest about an empty feed and a stale one", async () => {
    const base = await startFeed({ staleMs: 1_000 });
    const empty = await fetch(`${base}/health`, { headers: auth });
    // SAFETY: the feed's /health body is HealthVerdict by construction.
    const emptyVerdict = (await empty.json()) as { ok: boolean; reason: string };
    // A 200 must not be read as "the feed is producing".
    expect(emptyVerdict.ok).toBe(false);
    expect(emptyVerdict.reason).toContain("empty");

    await fetch(`${base}/signals`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(observation()),
    });
    const fresh = await fetch(`${base}/health`, { headers: auth });
    // SAFETY: the feed's /health body is HealthVerdict by construction.
    expect(((await fresh.json()) as { ok: boolean }).ok).toBe(true);

    const stale = evaluateHealth(
      [observation({ observedAt: Date.now() - 60_000 })],
      Date.now(),
      1_000,
    );
    expect(stale.ok).toBe(false);
    expect(stale.reason).toContain("stale");
  });

  it("rejects an off-contract observation instead of coercing it", async () => {
    const base = await startFeed();
    const badBodies = [
      { ...observation(), wallet: "not-a-key" },
      { ...observation(), poolAddress: "" },
      { ...observation(), action: "EXIT" },
      { ...observation(), confidence: 1.5 },
      { ...observation(), observedAt: 0 },
      { ...observation(), confidence: "0.8" },
    ];
    for (const body of badBodies) {
      const response = await fetch(`${base}/signals`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    // Nothing off-contract reached the feed.
    const fetched = await fetch(`${base}/signals`, { headers: auth });
    expect(parseCopySignalPayload(await fetched.json())).toHaveLength(0);
    expect(validateObservation(JSON.stringify({ ...observation(), action: "EXIT" })).ok).toBe(
      false,
    );
  });

  it("prunes by retention so a stopped producer cannot serve ancient signals", () => {
    const now = 1_800_000_000_000;
    const kept = prune(
      [observation({ observedAt: now - 10_000 }), observation({ observedAt: now - 2 * 3_600_000 })],
      now,
      3_600_000,
      500,
    );
    expect(kept).toHaveLength(1);
    expect(
      prune(
        [
          observation({ observedAt: now }),
          observation({ observedAt: now }),
          observation({ observedAt: now }),
        ],
        now,
        3_600_000,
        2,
      ),
    ).toHaveLength(2);
  });
});
