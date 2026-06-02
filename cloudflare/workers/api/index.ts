import { Effect, Layer, Context } from "effect";
import { Hono } from "hono";
import { handle } from "hono/cloudflare-workers";

// Environment bindings interface
interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  BACKUPS: R2Bucket;
  MEMORY: VectorizeIndex;
  FEE_WALLET_ADDRESS: string;
  TELEGRAM_BOT_TOKEN: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
}

// Services
class DbService extends Context.Tag("DbService")<
  DbService,
  { readonly db: D1Database }
>() {}

class CacheService extends Context.Tag("CacheService")<
  CacheService,
  { readonly cache: KVNamespace }
>() {}

// Service implementations
const DbLive = (db: D1Database) =>
  Layer.succeed(DbService, { db });

const CacheLive = (cache: KVNamespace) =>
  Layer.succeed(CacheService, { cache });

// Helper to generate IDs
const generateId = () => {
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  return `${Date.now()}-${Array.from(randomBytes).map(b => b.toString(36).padStart(2, '0')).join('')}`;
};

// Helper to hash API keys
const hashKey = async (key: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
};

// Register handler
const registerHandler = (db: D1Database) =>
  Effect.gen(function* () {
    const userId = generateId();
    const apiKey = `sk-prism-${generateId()}`;
    const keyHash = yield* Effect.promise(() => hashKey(apiKey));

    yield* Effect.promise(() =>
      db
        .prepare("INSERT INTO users (id, tier) VALUES (?, ?)")
        .bind(userId, "free")
        .run(),
    );

    yield* Effect.promise(() =>
      db
        .prepare("INSERT INTO api_keys (key_hash, user_id) VALUES (?, ?)")
        .bind(keyHash, userId)
        .run(),
    );

    return { userId, apiKey };
  });

// Login handler
const loginHandler = (db: D1Database, apiKey: string) =>
  Effect.gen(function* () {
    const keyHash = yield* Effect.promise(() => hashKey(apiKey));

    const result = yield* Effect.promise(() =>
      db
        .prepare(
          `SELECT u.id, u.tier, u.telegram_id, u.created_at
           FROM users u
           JOIN api_keys ak ON u.id = ak.user_id
           WHERE ak.key_hash = ?`,
        )
        .bind(keyHash)
        .first(),
    );

    if (!result) {
      yield* Effect.fail(new Error("Invalid API key"));
    }

    // Update last_used_at
    yield* Effect.promise(() =>
      db
        .prepare("UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_hash = ?")
        .bind(keyHash)
        .run(),
    );

    return result;
  });

// Whoami handler
const whoamiHandler = (db: D1Database, userId: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() =>
      db
        .prepare("SELECT id, tier, telegram_id, created_at FROM users WHERE id = ?")
        .bind(userId)
        .first(),
    );

    if (!result) {
      yield* Effect.fail(new Error("User not found"));
    }

    return result;
  });

// Link Telegram start handler
const linkTelegramStartHandler = (db: D1Database, userId: string) =>
  Effect.gen(function* () {
    const randomBytes = new Uint8Array(4);
    crypto.getRandomValues(randomBytes);
    const code = `LINK-${Array.from(randomBytes).map(b => b.toString(36).padStart(2, '0')).join('').toUpperCase().slice(0, 6)}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

    yield* Effect.promise(() =>
      db
        .prepare(
          "INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)",
        )
        .bind(code, userId, expiresAt)
        .run(),
    );

    return { code, expiresAt };
  });

// Health check
const healthHandler = () =>
  Effect.succeed({ status: "ok", timestamp: new Date().toISOString() });

// Main app
const app = new Hono<{ Bindings: Env }>();

// Middleware to extract and validate API key
app.use("/v1/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (match) {
      c.set("apiKey", match[1]);
    }
  }
  await next();
});

// Routes
app.get("/health", async (c) => {
  const result = await Effect.runPromise(healthHandler());
  return c.json(result);
});

app.post("/v1/register", async (c) => {
  const { DB, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";
  const body = await c.req.json<{ telegram_id?: string }>().catch(() => ({}));

  try {
    // Rate limiting: max 5 registrations per IP per hour
    const rateKey = `rate_limit:register:${clientIp}`;
    const rateData = await CACHE.get(rateKey);
    const count = rateData ? parseInt(rateData, 10) : 0;

    if (count >= 5) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }

    const result = await Effect.runPromise(registerHandler(DB));

    // Increment rate limit counter
    await CACHE.put(rateKey, String(count + 1), { expirationTtl: 3600 });

    // If telegram_id provided, validate and link immediately
    if (body.telegram_id) {
      if (!/^\d+$/.test(body.telegram_id)) {
        return c.json({ error: "Invalid telegram_id format. Must be numeric." }, 400);
      }
      await DB.prepare("UPDATE users SET telegram_id = ? WHERE id = ?")
        .bind(body.telegram_id, result.userId)
        .run();
    }

    return c.json({
      user_id: result.userId,
      api_key: result.apiKey,
      tier: "free",
    });
  } catch (error) {
    return c.json({ error: "Registration failed" }, 500);
  }
});

app.post("/v1/login", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  try {
    const result = await Effect.runPromise(loginHandler(DB, apiKey));
    return c.json(result);
  } catch {
    return c.json({ error: "Invalid API key" }, 401);
  }
});

app.get("/v1/whoami", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  try {
    const loginResult = await Effect.runPromise(loginHandler(DB, apiKey));
    const userResult = await Effect.runPromise(
      whoamiHandler(DB, loginResult.id as string),
    );
    return c.json(userResult);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
});

app.post("/v1/link-telegram/start", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  try {
    const loginResult = await Effect.runPromise(loginHandler(DB, apiKey));
    const result = await Effect.runPromise(
      linkTelegramStartHandler(DB, loginResult.id as string),
    );
    return c.json(result);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
});

app.post("/v1/link-telegram/confirm", async (c) => {
  const { DB } = c.env;
  const body = await c.req.json<{ code: string; telegram_id: string }>();

  if (!body.code || !body.telegram_id) {
    return c.json({ error: "Code and telegram_id required" }, 400);
  }

  if (!/^\d+$/.test(body.telegram_id)) {
    return c.json({ error: "Invalid telegram_id format. Must be numeric." }, 400);
  }

  try {
    // Atomic update: mark code as used only if not already used and not expired
    const updateResult = await DB.prepare(
      `UPDATE telegram_link_codes
       SET used_at = CURRENT_TIMESTAMP
       WHERE code = ?
         AND used_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP`,
    )
      .bind(body.code)
      .run();

    if (!updateResult.success || updateResult.meta.changes === 0) {
      // Check why it failed
      const codeResult = await DB.prepare(
        `SELECT used_at, expires_at
         FROM telegram_link_codes
         WHERE code = ?`,
      )
        .bind(body.code)
        .first();

      if (!codeResult) {
        return c.json({ error: "Invalid code" }, 400);
      }

      if (codeResult.used_at) {
        return c.json({ error: "Code already used" }, 400);
      }

      if (new Date(codeResult.expires_at as string) < new Date()) {
        return c.json({ error: "Code expired" }, 400);
      }

      return c.json({ error: "Linking failed" }, 500);
    }

    // Get user_id from the code
    const codeResult = await DB.prepare(
      `SELECT user_id FROM telegram_link_codes WHERE code = ?`,
    )
      .bind(body.code)
      .first();

    // Link telegram
    await DB.prepare("UPDATE users SET telegram_id = ? WHERE id = ?")
      .bind(body.telegram_id, codeResult?.user_id)
      .run();

    return c.json({ success: true, user_id: codeResult?.user_id });
  } catch {
    return c.json({ error: "Linking failed" }, 500);
  }
});

app.post("/v1/issue", async (c) => {
  const { GITHUB_TOKEN, GITHUB_REPO } = c.env;
  const body = await c.req.json<{ title: string; body: string }>();

  if (!body.title) {
    return c.json({ error: "Title required" }, 400);
  }

  const repo = GITHUB_REPO || "irfndi/prism-dlmm";

  try {
    // Create GitHub issue
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github.v3+json",
        },
        body: JSON.stringify({
          title: body.title,
          body: body.body || "",
          labels: ["user-reported"],
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const issue = await response.json();
    return c.json({ issue_number: issue.number, url: issue.html_url });
  } catch {
    return c.json({ error: "Failed to create issue" }, 500);
  }
});

// Export handler for Cloudflare Workers
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handle(app)(request, env, ctx);
  },
};
