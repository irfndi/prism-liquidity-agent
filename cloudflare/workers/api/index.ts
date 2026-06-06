import { Effect, Layer, Context } from "effect";
import { Hono } from "hono";

// Environment bindings interface
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  BACKUPS: R2Bucket;
  MEMORY: VectorizeIndex;
  FEE_WALLET_ADDRESS: string;
  TELEGRAM_BOT_TOKEN: string;
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  ADMIN_API_KEY?: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

const MAX_ERROR_MESSAGE_LENGTH = 4096;

const VALID_INSTALL_EVENTS = new Set(["install", "setup", "dev_start", "register"]);

// Services
class DbService extends Context.Tag("DbService")<DbService, { readonly db: D1Database }>() {}

class CacheService extends Context.Tag("CacheService")<
  CacheService,
  { readonly cache: KVNamespace }
>() {}

// Service implementations
const DbLive = (db: D1Database) => Layer.succeed(DbService, { db });

const CacheLive = (cache: KVNamespace) => Layer.succeed(CacheService, { cache });

// Helper to generate IDs
const generateId = () => {
  const randomBytes = new Uint8Array(8);
  crypto.getRandomValues(randomBytes);
  return `${Date.now()}-${Array.from(randomBytes)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")}`;
};

// Helper to hash API keys
const hashKey = async (key: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
};

// Helper to generate referral codes
function generateReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Tier configuration - must match engine/revenue-service.ts
const TIERS: Record<string, { platformFeeRate: number }> = {
  free: { platformFeeRate: 0 },
  pro: { platformFeeRate: 0.05 },
  fund: { platformFeeRate: 0.10 },
};

// Register handler
const registerHandler = (db: D1Database) =>
  Effect.gen(function* () {
    const userId = generateId();
    const apiKey = `sk-prism-${generateId()}`;
    const keyHash = yield* Effect.promise(() => hashKey(apiKey));

    yield* Effect.promise(() =>
      db.prepare("INSERT INTO users (id, tier) VALUES (?, ?)").bind(userId, "free").run(),
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
    const code = `LINK-${Array.from(randomBytes)
      .map((b) => b.toString(36).padStart(2, "0"))
      .join("")
      .toUpperCase()
      .slice(0, 6)}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

    yield* Effect.promise(() =>
      db
        .prepare("INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(code, userId, expiresAt)
        .run(),
    );

    return { code, expiresAt };
  });

// Health check
const healthHandler = () => Effect.succeed({ status: "ok", timestamp: new Date().toISOString() });

// Register via Telegram (called by the Telegram bot)
const registerTelegramHandler = (db: D1Database, telegramId: string, firstName: string) =>
  Effect.gen(function* () {
    if (!/^\d+$/.test(telegramId)) {
      return yield* Effect.fail(new Error("Invalid telegram_id format. Must be numeric."));
    }

    const existing = yield* Effect.promise(() =>
      db
        .prepare("SELECT id, tier, telegram_id FROM users WHERE telegram_id = ?")
        .bind(telegramId)
        .first(),
    );

    if (existing) {
      return yield* Effect.fail(new Error("Telegram account already registered"));
    }

    const userId = generateId();
    const apiKey = `sk-prism-${generateId()}`;
    const keyHash = yield* Effect.promise(() => hashKey(apiKey));

    yield* Effect.promise(() =>
      db
        .prepare("INSERT INTO users (id, tier, telegram_id) VALUES (?, ?, ?)")
        .bind(userId, "free", telegramId)
        .run(),
    );

    yield* Effect.promise(() =>
      db
        .prepare("INSERT INTO api_keys (key_hash, user_id) VALUES (?, ?)")
        .bind(keyHash, userId)
        .run(),
    );

    return { user_id: userId, api_key: apiKey, first_name: firstName };
  });

// Agent status (called by the Telegram bot). Placeholder until the live agent
// runtime exposes telemetry; real numbers can replace this later.
const agentStatusHandler = (db: D1Database, telegramId: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() =>
      db.prepare("SELECT id FROM users WHERE telegram_id = ?").bind(telegramId).first(),
    );

    if (!result) {
      return yield* Effect.fail(new Error("User not found"));
    }

    return { status: "not_running", positions: 0, pnl: 0 };
  });

// Main app
const app = new Hono<{ Bindings: Env; Variables: { apiKey: string } }>();

// Middleware to extract and validate API key
app.use("/v1/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    if (match && match[1]) {
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
  const body = (await c.req.json().catch(() => ({}))) as { telegram_id?: string };

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
      whoamiHandler(DB, (loginResult as { id: string }).id),
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
      linkTelegramStartHandler(DB, (loginResult as { id: string }).id),
    );
    return c.json(result);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
});

app.post("/v1/link-telegram/confirm", async (c) => {
  const { DB } = c.env;
  const body = (await c.req.json().catch(() => ({}))) as { code: string; telegram_id: string };

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
    const codeResult = await DB.prepare(`SELECT user_id FROM telegram_link_codes WHERE code = ?`)
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

app.post("/v1/whoami-telegram", async (c) => {
  const { DB } = c.env;
  const body = (await c.req.json().catch(() => ({}))) as { telegram_id?: string };

  if (!body.telegram_id) {
    return c.json({ error: "telegram_id required" }, 400);
  }
  if (!/^\d+$/.test(body.telegram_id)) {
    return c.json({ error: "Invalid telegram_id format. Must be numeric." }, 400);
  }

  const result = await c.env.DB.prepare(
    "SELECT id, tier, telegram_id, created_at FROM users WHERE telegram_id = ?",
  )
    .bind(body.telegram_id)
    .first();

  if (!result) {
    return c.json({ error: "User not found" }, 404);
  }
  return c.json({
    user_id: result.id,
    tier: result.tier,
    telegram_id: result.telegram_id,
    created_at: result.created_at,
  });
});

app.post("/v1/register-telegram", async (c) => {
  const { DB, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";
  const body = (await c.req.json().catch(() => ({}))) as {
    telegram_id?: string;
    first_name?: string;
  };

  if (!body.telegram_id) {
    return c.json({ error: "telegram_id required" }, 400);
  }

  // Same 5/hour/IP rate limit as /v1/register.
  const rateKey = `rate_limit:register_telegram:${clientIp}`;
  const rateData = await CACHE.get(rateKey);
  const count = rateData ? parseInt(rateData, 10) : 0;
  if (count >= 5) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

  try {
    const result = await Effect.runPromise(
      registerTelegramHandler(DB, body.telegram_id, body.first_name ?? ""),
    );
    await CACHE.put(rateKey, String(count + 1), { expirationTtl: 3600 });
    return c.json({
      user_id: result.user_id,
      api_key: result.api_key,
      tier: "free",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Registration failed";
    const status = message.includes("already registered") ? 409 : 400;
    return c.json({ error: message }, status);
  }
});

app.post("/v1/agent-status", async (c) => {
  const { DB } = c.env;
  const body = (await c.req.json().catch(() => ({}))) as { telegram_id?: string };

  if (!body.telegram_id) {
    return c.json({ error: "telegram_id required" }, 400);
  }

  try {
    const result = await Effect.runPromise(agentStatusHandler(DB, body.telegram_id));
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Status unavailable";
    const status = message.includes("not found") ? 404 : 500;
    return c.json({ error: message }, status);
  }
});

app.post("/v1/issue", async (c) => {
  const { GITHUB_TOKEN, GITHUB_REPO, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";

  const body = (await c.req.json().catch(() => ({}))) as { title: string; body: string };

  if (!body.title) {
    return c.json({ error: "Title required" }, 400);
  }

  // Rate limit: 10 issues per IP per hour.
  // NOTE: Cloudflare KV is eventually consistent, so a burst of concurrent
  // requests from the same IP can briefly exceed this limit (N-1 extra for
  // N concurrent arrivals). This is acceptable for an abuse-prevention
  // ceiling on issue filing, not a security-critical control. For strict
  // limits, use Durable Objects or a D1 transaction.
  // CACHE is null-checked so the handler still works in environments where
  // the KV binding is intentionally not provisioned.
  if (CACHE) {
    const rateKey = `rate_limit:issue:${clientIp}`;
    const current = await CACHE.get(rateKey);
    const count = current ? parseInt(current, 10) : 0;
    if (count >= 10) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }
  }

  const repo = GITHUB_REPO || "irfndi/prism-liquidity-agent";

  try {
    // Create GitHub issue
    const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
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
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status}`);
    }

    // Only consume the rate-limit slot on successful GitHub creation.
    // A failed API call (network error, 5xx, auth failure) does not burn
    // the user's budget.
    if (CACHE) {
      const rateKey = `rate_limit:issue:${clientIp}`;
      const current = await CACHE.get(rateKey);
      const count = current ? parseInt(current, 10) : 0;
      await CACHE.put(rateKey, String(count + 1), { expirationTtl: 3600 });
    }

    const issue = (await response.json()) as { number?: number; html_url?: string };
    return c.json({ issue_number: issue.number, url: issue.html_url });
  } catch {
    return c.json({ error: "Failed to create issue" }, 500);
  }
});

// ── Error Reporting ──────────────────────────────────────────────────────────
// Privacy-first error telemetry (opt-in, no auth required for ingestion)

app.post("/v1/errors/report", async (c) => {
  const { DB, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";

  const body = (await c.req.json().catch(() => ({}))) as {
    id?: string;
    agentId?: string;
    errorType?: string;
    message?: string;
    stackTrace?: string;
    prismVersion?: string;
    platform?: string;
    severity?: string;
    isRecoverable?: number;
  };

  // Validate required fields
  if (!body.id || !body.agentId || !body.errorType || !body.message || !body.prismVersion) {
    return c.json(
      { error: "Missing required fields: id, agentId, errorType, message, prismVersion" },
      400,
    );
  }
  if (body.message.length > MAX_ERROR_MESSAGE_LENGTH) {
    return c.json({ error: `message exceeds ${MAX_ERROR_MESSAGE_LENGTH} characters` }, 400);
  }

  // Rate limit: 100 reports per IP per hour
  if (CACHE) {
    const rateKey = `rate_limit:error_report:${clientIp}`;
    const rateData = await CACHE.get(rateKey);
    const count = rateData ? parseInt(rateData, 10) : 0;
    if (count >= 100) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }
    await CACHE.put(rateKey, String(count + 1), { expirationTtl: 3600 });
  }

  try {
    const severity = body.severity ?? "error";
    const isRecoverable = body.isRecoverable ? 1 : 0;

    await DB.prepare(
      `INSERT INTO error_logs (id, agent_id, error_type, message, stack_trace, prism_version, platform, severity, is_recoverable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        body.id,
        body.agentId,
        body.errorType,
        body.message,
        body.stackTrace ?? null,
        body.prismVersion,
        body.platform ?? null,
        severity,
        isRecoverable,
      )
      .run();

    return c.json({ id: body.id });
  } catch (err) {
    // Duplicate id is expected (agent retries) — return 200 for idempotency
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint")) {
      return c.json({ id: body.id });
    }
    return c.json({ error: "Failed to store error report" }, 500);
  }
});

app.post("/v1/errors/batch", async (c) => {
  const { DB, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";

  const body = (await c.req.json().catch(() => ({}))) as {
    reports?: Array<{
      id?: string;
      agentId?: string;
      errorType?: string;
      message?: string;
      stackTrace?: string;
      prismVersion?: string;
      platform?: string;
      severity?: string;
      isRecoverable?: number;
    }>;
  };

  const reports = body.reports ?? [];

  if (reports.length === 0) {
    return c.json({ error: "No reports provided" }, 400);
  }

  if (reports.length > 50) {
    return c.json({ error: "Batch size exceeds maximum of 50" }, 400);
  }

  // Rate limit: 50 batches per IP per hour
  if (CACHE) {
    const rateKey = `rate_limit:error_batch:${clientIp}`;
    const rateData = await CACHE.get(rateKey);
    const count = rateData ? parseInt(rateData, 10) : 0;
    if (count >= 50) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }
    await CACHE.put(rateKey, String(count + 1), { expirationTtl: 3600 });
  }

  // Validate all reports
  const validReports: Array<{
    id: string;
    agentId: string;
    errorType: string;
    message: string;
    prismVersion: string;
    stackTrace: string | null;
    platform: string | null;
    severity: string;
    isRecoverable: number;
  }> = [];

  for (const r of reports) {
    if (!r.id || !r.agentId || !r.errorType || !r.message || !r.prismVersion) {
      return c.json(
        {
          error: "Each report requires id, agentId, errorType, message, prismVersion",
          reportId: r.id ?? "(missing id)",
        },
        400,
      );
    }
    if (r.message.length > MAX_ERROR_MESSAGE_LENGTH) {
      return c.json(
        {
          error: `message exceeds ${MAX_ERROR_MESSAGE_LENGTH} characters`,
          reportId: r.id,
        },
        400,
      );
    }
    validReports.push({
      id: r.id,
      agentId: r.agentId,
      errorType: r.errorType,
      message: r.message,
      prismVersion: r.prismVersion,
      stackTrace: r.stackTrace ?? null,
      platform: r.platform ?? null,
      severity: r.severity ?? "error",
      isRecoverable: r.isRecoverable ? 1 : 0,
    });
  }

  try {
    const stmt = DB.prepare(
      `INSERT OR IGNORE INTO error_logs (id, agent_id, error_type, message, stack_trace, prism_version, platform, severity, is_recoverable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const batchStatements = validReports.map((r) =>
      stmt.bind(
        r.id,
        r.agentId,
        r.errorType,
        r.message,
        r.stackTrace,
        r.prismVersion,
        r.platform,
        r.severity,
        r.isRecoverable,
      ),
    );

    const results = await DB.batch(batchStatements);
    const inserted = results.reduce(
      (sum, r) => sum + (typeof r.meta.changes === "number" ? r.meta.changes : 0),
      0,
    );
    const duplicates = validReports.length - inserted;

    return c.json({ inserted, duplicates });
  } catch {
    return c.json({ error: "Failed to store error reports" }, 500);
  }
});

app.get("/v1/errors/stats", async (c) => {
  const { DB } = c.env;

  // Require admin bearer token
  const authHeader = c.req.header("Authorization");
  const match = authHeader?.match(/^Bearer\s+(.+)$/);
  const token = match?.[1];

  if (!token || !c.env.ADMIN_API_KEY || !constantTimeEqual(token, c.env.ADMIN_API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const result = await DB.prepare(
      `SELECT error_type, COUNT(*) as count
       FROM error_logs
       WHERE created_at >= datetime('now', '-1 day')
       GROUP BY error_type
       ORDER BY count DESC`,
    ).all();

    const rows = result.results ?? [];

    return c.json({ stats: rows });
  } catch {
    return c.json({ error: "Failed to fetch stats" }, 500);
  }
});

// ── Install Telemetry ───────────────────────────────────────────────────────
// Privacy: install_id is a random UUID generated client-side; no PII.

app.post("/v1/installs/ping", async (c) => {
  const { DB, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";

  const body = (await c.req.json().catch(() => ({}))) as {
    installId?: string;
    event?: string;
    version?: string;
    channel?: string;
    platform?: string;
    userId?: string;
  };

  if (typeof body.installId !== "string" || body.installId.length < 8 || body.installId.length > 128) {
    return c.json(
      { error: "installId is required and must be 8-128 chars" },
      400,
    );
  }
  if (!body.event || !VALID_INSTALL_EVENTS.has(body.event)) {
    return c.json(
      {
        error: `event is required and must be one of: ${Array.from(VALID_INSTALL_EVENTS).join(", ")}`,
      },
      400,
    );
  }

  // Rate limit: 100 pings per IP per hour (same as error reports).
  if (CACHE) {
    const rateKey = `rate_limit:install_ping:${clientIp}`;
    const rateData = await CACHE.get(rateKey);
    const count = rateData ? parseInt(rateData, 10) : 0;
    if (count >= 100) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }
    await CACHE.put(rateKey, String(count + 1), { expirationTtl: 3600 });
  }

  try {
    const id = generateId();
    await DB.prepare(
      `INSERT INTO installs (id, install_id, event, version, channel, platform, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        body.installId,
        body.event,
        body.version ?? null,
        body.channel ?? null,
        body.platform ?? null,
        body.userId ?? null,
      )
      .run();

    return c.json({ id });
  } catch (err) {
    console.error("Failed to store install ping:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.get("/v1/referral/code", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  try {
    const loginResult = await Effect.runPromise(loginHandler(DB, apiKey));
    const userId = (loginResult as { id: string }).id;

    let result = await DB.prepare("SELECT code FROM referral_codes WHERE user_id = ?")
      .bind(userId)
      .first();

    if (!result) {
      const code = generateReferralCode();
      await DB.prepare("INSERT INTO referral_codes (code, user_id) VALUES (?, ?)")
        .bind(code, userId)
        .run();
      result = { code };
    }

    const countResult = await DB.prepare(
      "SELECT COUNT(*) as count FROM referrals WHERE referrer_user_id = ?",
    )
      .bind(userId)
      .first();

    return c.json({
      code: result.code,
      referralCount: countResult?.count ?? 0,
    });
  } catch {
    return c.json({ error: "Failed to get referral code" }, 500);
  }
});

app.post("/v1/referral/apply", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;
  const body = (await c.req.json().catch(() => ({}))) as { code?: string };

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  if (!body.code) {
    return c.json({ error: "Code required" }, 400);
  }

  try {
    const loginResult = await Effect.runPromise(loginHandler(DB, apiKey));
    const userId = (loginResult as { id: string }).id;

    const codeResult = await DB.prepare("SELECT user_id FROM referral_codes WHERE code = ?")
      .bind(body.code)
      .first();

    if (!codeResult) {
      return c.json({ error: "Invalid referral code" }, 400);
    }

    if (codeResult.user_id === userId) {
      return c.json({ error: "Cannot refer yourself" }, 400);
    }

    const existing = await DB.prepare("SELECT id FROM referrals WHERE referee_user_id = ?")
      .bind(userId)
      .first();

    if (existing) {
      return c.json({ error: "Already referred" }, 400);
    }

    const referralId = generateId();
    await DB.prepare(
      "INSERT INTO referrals (id, referrer_user_id, referee_user_id, referral_code) VALUES (?, ?, ?, ?)",
    )
      .bind(referralId, codeResult.user_id, userId, body.code)
      .run();

    await DB.prepare(
      "INSERT INTO user_credits (id, user_id, amount, reason) VALUES (?, ?, ?, ?)",
    )
      .bind(generateId(), codeResult.user_id, 5, "referral_bonus")
      .run();

    await DB.prepare(
      "INSERT INTO user_credits (id, user_id, amount, reason) VALUES (?, ?, ?, ?)",
    )
      .bind(generateId(), userId, 10, "referee_bonus")
      .run();

    const countResult = await DB.prepare(
      "SELECT COUNT(*) as count FROM referrals WHERE referrer_user_id = ?",
    )
      .bind(codeResult.user_id)
      .first();

    const referralCount = countResult?.count ?? 0;
    let milestoneBonus = 0;

    if (referralCount === 5) milestoneBonus = 25;
    else if (referralCount === 10) milestoneBonus = 50;

    if (milestoneBonus > 0) {
      await DB.prepare(
        "INSERT INTO user_credits (id, user_id, amount, reason) VALUES (?, ?, ?, ?)",
      )
        .bind(generateId(), codeResult.user_id, milestoneBonus, `milestone_${referralCount}`)
        .run();
    }

    return c.json({ success: true, credits: 10 });
  } catch {
    return c.json({ error: "Failed to apply referral" }, 500);
  }
});

app.get("/v1/referral/stats", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  try {
    const loginResult = await Effect.runPromise(loginHandler(DB, apiKey));
    const userId = (loginResult as { id: string }).id;

    const countResult = await DB.prepare(
      "SELECT COUNT(*) as count FROM referrals WHERE referrer_user_id = ?",
    )
      .bind(userId)
      .first();

    const creditsResult = await DB.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM user_credits WHERE user_id = ?",
    )
      .bind(userId)
      .first();

    const referralCount = (countResult as { count?: number })?.count ?? 0;
    let milestone: string | null = null;
    if (referralCount >= 10) milestone = "10 referrals - $50 bonus!";
    else if (referralCount >= 5) milestone = "5 referrals - $25 bonus!";

    return c.json({
      referralCount,
      credits: (creditsResult as { total?: number })?.total ?? 0,
      milestone,
    });
  } catch {
    return c.json({ error: "Failed to get referral stats" }, 500);
  }
});

app.get("/v1/subscription/status", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  try {
    const loginResult = await Effect.runPromise(loginHandler(DB, apiKey));
    const userId = (loginResult as { id: string }).id;

    const userResult = await DB.prepare("SELECT tier FROM users WHERE id = ?")
      .bind(userId)
      .first();

    const tier = (userResult as { tier?: string })?.tier ?? "free";

    const countResult = await DB.prepare(
      "SELECT COUNT(*) as count FROM referrals WHERE referrer_user_id = ?",
    )
      .bind(userId)
      .first();

    const creditsResult = await DB.prepare(
      "SELECT COALESCE(SUM(amount), 0) as total FROM user_credits WHERE user_id = ?",
    )
      .bind(userId)
      .first();

    const tierConfig = TIERS[tier as keyof typeof TIERS];

    return c.json({
      tier,
      walletSol: 0,
      referralCount: (countResult as { count?: number })?.count ?? 0,
      credits: (creditsResult as { total?: number })?.total ?? 0,
      platformFeeRate: tierConfig?.platformFeeRate ?? 0,
    });
  } catch {
    return c.json({ error: "Failed to get subscription status" }, 500);
  }
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
};




