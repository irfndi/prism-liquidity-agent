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
  ADMIN_API_KEY?: string;
  // Shared secret the Telegram bot worker presents as X-Bot-Api-Secret for
  // telegram_id-keyed endpoints. Unset means those endpoints fail closed.
  BOT_API_SECRET?: string;
  // Base URL of the telegram-bot worker used to push alert deliveries
  // (POST {TELEGRAM_BOT_URL}/internal/deliver-alert). Unset disables push.
  TELEGRAM_BOT_URL?: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  // Compare over max length (no early return) so the loop — and therefore the
  // comparison duration — does not depend on where the strings differ or on the
  // secret's length. Out-of-range indices read 0, not NaN.
  const maxLen = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= ca ^ cb;
  }
  return mismatch === 0;
}

// Telegram-bot shared-secret check. Fails closed: an unset server secret
// rejects everything, and comparison is constant-time.
function isBotAuthorized(env: Env, headerSecret: string | undefined): boolean {
  if (!env.BOT_API_SECRET || !headerSecret) return false;
  return constantTimeEqual(headerSecret, env.BOT_API_SECRET);
}

const MAX_ERROR_MESSAGE_LENGTH = 4096;

const VALID_INSTALL_EVENTS = new Set(["install", "setup", "dev_start", "register"]);
const AUDIT_ACTIONS = new Set(["register", "telegram_link", "wallet_sync"]);

function causeMessage(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    if ("error" in cause) return causeMessage((cause as { error: unknown }).error);
    if ("cause" in cause) return causeMessage((cause as { cause: unknown }).cause);
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

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

// API keys are bearer credentials: 20 CSPRNG bytes (~160 bits), no timestamp
// component, so they cannot be predicted from registration time.
const generateApiKey = () => {
  const randomBytes = new Uint8Array(20);
  crypto.getRandomValues(randomBytes);
  return `sk-prism-${Array.from(randomBytes)
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("")}`;
};

function readJsonBody<T>(request: { json: () => Promise<unknown> }): Effect.Effect<T, never> {
  return Effect.tryPromise({
    try: () => request.json(),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((body) => body as T),
    Effect.catchAll(() => Effect.succeed({} as T)),
  );
}

const cacheGet = (cache: KVNamespace, key: string) => Effect.tryPromise(() => cache.get(key));

const cachePut = (
  cache: KVNamespace,
  key: string,
  value: string,
  options?: KVNamespacePutOptions,
) => Effect.tryPromise(() => cache.put(key, value, options));

// Helper to hash API keys
const hashKey = (key: string): Effect.Effect<string, unknown> =>
  Effect.tryPromise(() => {
    const encoder = new TextEncoder();
    const data = encoder.encode(key);
    return crypto.subtle.digest("SHA-256", data);
  }).pipe(
    Effect.map((hashBuffer) => {
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    }),
  );

// Helper to generate referral codes
function generateReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Audit logging helper
function logAudit(
  db: D1Database,
  userId: string,
  action: string,
  details?: Record<string, unknown>,
): Effect.Effect<void, never> {
  if (!AUDIT_ACTIONS.has(action)) return Effect.void;
  return Effect.gen(function* () {
    const detailsJson = details ? JSON.stringify(details) : null;
    const eventKey = (yield* hashKey(`${action}:${detailsJson ?? ""}`)).slice(0, 32);
    const summaryWrite = Effect.tryPromise(() =>
      db
        .prepare(
          `INSERT INTO audit_event_summary
            (user_id, action, event_key, details, first_seen_at, last_seen_at, occurrence_count)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
           ON CONFLICT(user_id, action, event_key) DO UPDATE SET
             details = excluded.details,
             last_seen_at = CURRENT_TIMESTAMP,
             occurrence_count = audit_event_summary.occurrence_count + 1`,
        )
        .bind(userId, action, eventKey, detailsJson)
        .run(),
    ).pipe(
      Effect.catchAll((summaryError: unknown) =>
        Effect.tryPromise(() =>
          db
            .prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)")
            .bind(userId, action, detailsJson)
            .run(),
        ).pipe(
          Effect.catchAll((fallbackError: unknown) =>
            Effect.sync(() =>
              console.error("[Audit] Failed to log audit entry:", summaryError, fallbackError),
            ),
          ),
          Effect.asVoid,
        ),
      ),
      Effect.asVoid,
    );
    yield* summaryWrite;
  }).pipe(Effect.catchAll(() => Effect.void));
}

// Helper to create a free subscription (used by both registration paths)
function createFreeSubscription(db: D1Database, userId: string): Effect.Effect<void, never> {
  return Effect.tryPromise(() =>
    db
      .prepare(
        "INSERT INTO subscriptions (id, user_id, tier, period_start, period_end) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        generateId(),
        userId,
        "free",
        new Date().toISOString(),
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      )
      .run(),
  ).pipe(
    Effect.catchAll((err) =>
      Effect.sync(() =>
        console.error("[Subscription] Failed to create free subscription for user:", userId, err),
      ),
    ),
    Effect.asVoid,
  );
}

// Tier configuration - must match engine/revenue-service.ts
const TIERS: Record<string, { platformFeeRate: number }> = {
  free: { platformFeeRate: 0 },
  pro: { platformFeeRate: 0.05 },
  fund: { platformFeeRate: 0.1 },
};

// Register handler
const registerHandler = (db: D1Database) =>
  Effect.gen(function* () {
    const userId = generateId();
    const apiKey = generateApiKey();
    const keyHash = yield* hashKey(apiKey);

    yield* Effect.tryPromise(() =>
      db.prepare("INSERT INTO users (id, tier) VALUES (?, ?)").bind(userId, "free").run(),
    );

    yield* Effect.tryPromise(() =>
      db
        .prepare("INSERT INTO api_keys (key_hash, user_id) VALUES (?, ?)")
        .bind(keyHash, userId)
        .run(),
    );

    yield* createFreeSubscription(db, userId);

    return { userId, apiKey };
  });

// Login handler
const loginHandler = (db: D1Database, apiKey: string) =>
  Effect.gen(function* () {
    const keyHash = yield* hashKey(apiKey);

    const result = yield* Effect.tryPromise(() =>
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
    yield* Effect.tryPromise(() =>
      db
        .prepare("UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_hash = ?")
        .bind(keyHash)
        .run(),
    );

    return result;
  });

interface AuthenticatedUser {
  readonly id: string;
  readonly tier: string;
}

function authenticateUser(
  db: D1Database,
  apiKey: string | undefined,
): Effect.Effect<AuthenticatedUser | null, never> {
  if (!apiKey) return Effect.succeed(null);
  return loginHandler(db, apiKey).pipe(
    Effect.map((result) => {
      if (!result || typeof result !== "object") return null;
      const row = result as { id?: unknown; tier?: unknown };
      if (typeof row.id !== "string") return null;
      return { id: row.id, tier: typeof row.tier === "string" ? row.tier : "free" };
    }),
    Effect.catchAll(() => Effect.succeed(null)),
  );
}

// Whoami handler
const whoamiHandler = (db: D1Database, userId: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
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

// Link Telegram start handler. Codes carry 64 bits of CSPRNG entropy and a
// unixepoch expiry; requesting a new code burns the user's outstanding ones.
const linkTelegramStartHandler = (db: D1Database, userId: string) =>
  Effect.gen(function* () {
    const randomBytes = new Uint8Array(8);
    crypto.getRandomValues(randomBytes);
    const code = `LINK-${Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()}`;
    const expiresAtEpoch = Math.floor(Date.now() / 1000) + 10 * 60; // 10 minutes

    // Invalidate-then-create must be atomic: a failed second statement would
    // otherwise leave the user with no valid link code. D1 batch is a single
    // transaction.
    yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(
            `UPDATE telegram_link_codes
             SET used_at = CURRENT_TIMESTAMP
             WHERE user_id = ? AND used_at IS NULL`,
          )
          .bind(userId),
        db
          .prepare(
            "INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)",
          )
          .bind(code, userId, expiresAtEpoch),
      ]),
    );

    // expiresAt stays an ISO string in the API response — the CLI parses it
    // with new Date() to display the remaining time.
    return { code, expiresAt: new Date(expiresAtEpoch * 1000).toISOString() };
  });

// Health check
const healthHandler = () => Effect.succeed({ status: "ok", timestamp: new Date().toISOString() });

// Register via Telegram (called by the Telegram bot)
const registerTelegramHandler = (db: D1Database, telegramId: string, firstName: string) =>
  Effect.gen(function* () {
    if (!/^\d+$/.test(telegramId)) {
      return yield* Effect.fail(new Error("Invalid telegram_id format. Must be numeric."));
    }

    const existing = yield* Effect.tryPromise(() =>
      db
        .prepare("SELECT id, tier, telegram_id FROM users WHERE telegram_id = ?")
        .bind(telegramId)
        .first(),
    );

    if (existing) {
      return yield* Effect.fail(new Error("Telegram account already registered"));
    }

    const userId = generateId();
    const apiKey = generateApiKey();
    const keyHash = yield* hashKey(apiKey);

    yield* Effect.tryPromise(() =>
      db
        .prepare("INSERT INTO users (id, tier, telegram_id) VALUES (?, ?, ?)")
        .bind(userId, "free", telegramId)
        .run(),
    );

    yield* Effect.tryPromise(() =>
      db
        .prepare("INSERT INTO api_keys (key_hash, user_id) VALUES (?, ?)")
        .bind(keyHash, userId)
        .run(),
    );

    yield* createFreeSubscription(db, userId);

    return { user_id: userId, api_key: apiKey, first_name: firstName };
  });

// Agent status (called by the Telegram bot). Placeholder until the live agent
// runtime exposes telemetry; real numbers can replace this later.
const agentStatusHandler = (db: D1Database, telegramId: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
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
  const registration = Effect.gen(function* () {
    const body = (yield* Effect.tryPromise({
      try: () => c.req.json(),
      catch: (cause) => cause,
    }).pipe(Effect.catchAll(() => Effect.succeed({})))) as { telegram_id?: string };
    const rateKey = `rate_limit:register:${clientIp}`;
    const rateData = yield* Effect.tryPromise(() => CACHE.get(rateKey));
    const parsed = rateData ? parseInt(rateData, 10) : 0;
    const count = Number.isNaN(parsed) ? 0 : parsed;

    if (count >= 5) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }

    // Binding a telegram_id to a fresh account is a bot-only flow — without the
    // shared secret anyone could squat arbitrary Telegram identities. Verify the
    // secret AND telegram_id format BEFORE creating the account so a bad request
    // leaves no orphaned user.
    if (body.telegram_id) {
      if (!isBotAuthorized(c.env, c.req.header("X-Bot-Api-Secret"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      if (!/^\d+$/.test(body.telegram_id)) {
        return c.json({ error: "Invalid telegram_id format. Must be numeric." }, 400);
      }
    }

    const result = yield* registerHandler(DB);
    yield* Effect.tryPromise(() => CACHE.put(rateKey, String(count + 1), { expirationTtl: 3600 }));

    if (body.telegram_id) {
      yield* Effect.tryPromise(() =>
        DB.prepare("UPDATE users SET telegram_id = ? WHERE id = ?")
          .bind(body.telegram_id, result.userId)
          .run(),
      );
    }

    yield* logAudit(DB, result.userId, "register", { tier: "free" });
    return c.json({ user_id: result.userId, api_key: result.apiKey, tier: "free" });
  });

  return Effect.runPromise(
    registration.pipe(
      Effect.catchAll(() => Effect.succeed(c.json({ error: "Registration failed" }, 500))),
    ),
  );
});

app.post("/v1/login", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  return Effect.runPromise(
    loginHandler(DB, apiKey).pipe(
      Effect.match({
        onFailure: () => c.json({ error: "Invalid API key" }, 401),
        onSuccess: (result) => c.json(result),
      }),
    ),
  );
});

app.get("/v1/whoami", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  return Effect.runPromise(
    Effect.gen(function* () {
      const loginResult = yield* loginHandler(DB, apiKey);
      return yield* whoamiHandler(DB, (loginResult as { id: string }).id);
    }).pipe(
      Effect.match({
        onFailure: () => c.json({ error: "Unauthorized" }, 401),
        onSuccess: (result) => c.json(result),
      }),
    ),
  );
});

app.post("/v1/link-telegram/start", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  return Effect.runPromise(
    Effect.gen(function* () {
      const loginResult = yield* loginHandler(DB, apiKey);
      return yield* linkTelegramStartHandler(DB, (loginResult as { id: string }).id);
    }).pipe(
      Effect.match({
        onFailure: () => c.json({ error: "Unauthorized" }, 401),
        onSuccess: (result) => c.json(result),
      }),
    ),
  );
});

const LINK_CONFIRM_RATE_LIMIT_PER_HOUR = 10;
const LINK_CODE_MAX_ATTEMPTS = 5;

app.post("/v1/link-telegram/confirm", async (c) => {
  const { DB, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";
  const body = await Effect.runPromise(readJsonBody<{ code: string; telegram_id: string }>(c.req));

  if (!body.code || !body.telegram_id) {
    return c.json({ error: "Code and telegram_id required" }, 400);
  }

  if (!/^\d+$/.test(body.telegram_id)) {
    return c.json({ error: "Invalid telegram_id format. Must be numeric." }, 400);
  }

  // Brute-force defense: every attempt counts against the per-IP budget,
  // not just successful ones, so guessing codes is capped at 10/hour.
  const rateKey = `rate_limit:link_confirm:${clientIp}`;
  const rateData = await Effect.runPromise(cacheGet(CACHE, rateKey));
  const parsed = rateData ? parseInt(rateData, 10) : 0;
  const rateCount = Number.isNaN(parsed) ? 0 : parsed;
  if (rateCount >= LINK_CONFIRM_RATE_LIMIT_PER_HOUR) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }
  await Effect.runPromise(cachePut(CACHE, rateKey, String(rateCount + 1), { expirationTtl: 3600 }));

  const linking = Effect.gen(function* () {
    const codeRow = yield* Effect.tryPromise(() =>
      DB.prepare(
        `SELECT user_id, expires_at, used_at, attempts
         FROM telegram_link_codes
         WHERE code = ?`,
      )
        .bind(body.code)
        .first(),
    );

    if (!codeRow) return c.json({ error: "Invalid code" }, 400);

    // 5-strike burn: a code that absorbs too many confirm attempts is dead.
    const attempts = typeof codeRow.attempts === "number" ? codeRow.attempts : 0;
    if (attempts >= LINK_CODE_MAX_ATTEMPTS) {
      return c.json({ error: "Too many attempts for this code" }, 429);
    }
    yield* Effect.tryPromise(() =>
      DB.prepare("UPDATE telegram_link_codes SET attempts = attempts + 1 WHERE code = ?")
        .bind(body.code)
        .run(),
    );

    if (codeRow.used_at) return c.json({ error: "Code already used" }, 400);
    const expiresAt = typeof codeRow.expires_at === "number" ? codeRow.expires_at : 0;
    if (expiresAt <= Math.floor(Date.now() / 1000)) {
      return c.json({ error: "Code expired" }, 400);
    }

    const updateResult = yield* Effect.tryPromise(() =>
      DB.prepare(
        `UPDATE telegram_link_codes
         SET used_at = CURRENT_TIMESTAMP
         WHERE code = ? AND used_at IS NULL`,
      )
        .bind(body.code)
        .run(),
    );

    if (!updateResult.success || updateResult.meta.changes === 0) {
      return c.json({ error: "Code already used" }, 400);
    }

    const userId = typeof codeRow.user_id === "string" ? codeRow.user_id : null;
    if (!userId) return c.json({ error: "Linking failed" }, 500);

    yield* Effect.tryPromise(() =>
      DB.prepare("UPDATE users SET telegram_id = ? WHERE id = ?")
        .bind(body.telegram_id, userId)
        .run(),
    );
    yield* logAudit(DB, userId, "telegram_link", { telegram_id: body.telegram_id });

    return c.json({ success: true, user_id: userId });
  });

  return Effect.runPromise(
    linking.pipe(Effect.catchAll(() => Effect.succeed(c.json({ error: "Linking failed" }, 500)))),
  );
});

app.post("/v1/whoami-telegram", async (c) => {
  const { DB } = c.env;
  if (!isBotAuthorized(c.env, c.req.header("X-Bot-Api-Secret"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = await Effect.runPromise(readJsonBody<{ telegram_id?: string }>(c.req));

  if (!body.telegram_id) {
    return c.json({ error: "telegram_id required" }, 400);
  }
  if (!/^\d+$/.test(body.telegram_id)) {
    return c.json({ error: "Invalid telegram_id format. Must be numeric." }, 400);
  }

  return Effect.runPromise(
    Effect.tryPromise(() =>
      c.env.DB.prepare("SELECT id, tier, telegram_id, created_at FROM users WHERE telegram_id = ?")
        .bind(body.telegram_id)
        .first(),
    ).pipe(
      Effect.match({
        onFailure: () => c.json({ error: "Failed to fetch user" }, 500),
        onSuccess: (result) =>
          result
            ? c.json({
                user_id: result.id,
                tier: result.tier,
                telegram_id: result.telegram_id,
                created_at: result.created_at,
              })
            : c.json({ error: "User not found" }, 404),
      }),
    ),
  );
});

app.post("/v1/register-telegram", async (c) => {
  const { DB, CACHE } = c.env;
  if (!isBotAuthorized(c.env, c.req.header("X-Bot-Api-Secret"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";
  const body = await Effect.runPromise(
    readJsonBody<{ telegram_id?: string; first_name?: string }>(c.req),
  );

  if (!body.telegram_id) {
    return c.json({ error: "telegram_id required" }, 400);
  }
  const telegramId = body.telegram_id;

  // Same 5/hour/IP rate limit as /v1/register.
  const rateKey = `rate_limit:register_telegram:${clientIp}`;
  const rateData = await Effect.runPromise(cacheGet(CACHE, rateKey));
  const parsed = rateData ? parseInt(rateData, 10) : 0;
  const count = Number.isNaN(parsed) ? 0 : parsed;
  if (count >= 5) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

  const registration = Effect.gen(function* () {
    const result = yield* registerTelegramHandler(DB, telegramId, body.first_name ?? "");
    yield* Effect.tryPromise(() => CACHE.put(rateKey, String(count + 1), { expirationTtl: 3600 }));
    yield* logAudit(DB, result.user_id, "register", { tier: "free", source: "telegram" });
    return c.json({
      user_id: result.user_id,
      api_key: result.api_key,
      tier: "free",
    });
  });

  return Effect.runPromise(
    registration.pipe(
      Effect.match({
        onFailure: (cause) => {
          const message = causeMessage(cause);
          if (message.includes("already registered")) {
            return c.json({ error: message }, 409);
          }
          if (message.includes("Invalid telegram_id format")) {
            return c.json({ error: message }, 400);
          }
          return c.json({ error: "Registration failed" }, 500);
        },
        onSuccess: (response) => response,
      }),
    ),
  );
});

app.post("/v1/agent-status", async (c) => {
  const { DB } = c.env;
  if (!isBotAuthorized(c.env, c.req.header("X-Bot-Api-Secret"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = await Effect.runPromise(readJsonBody<{ telegram_id?: string }>(c.req));

  if (!body.telegram_id) {
    return c.json({ error: "telegram_id required" }, 400);
  }

  return Effect.runPromise(
    agentStatusHandler(DB, body.telegram_id).pipe(
      Effect.match({
        onFailure: (cause) => {
          const message = causeMessage(cause);
          return message.includes("not found")
            ? c.json({ error: "User not found" }, 404)
            : c.json({ error: "Status unavailable" }, 500);
        },
        onSuccess: (result) => c.json(result),
      }),
    ),
  );
});

const VALID_FEEDBACK_CATEGORIES = new Set(["friction", "suggestion", "observation", "praise"]);
const VALID_FEEDBACK_SEVERITIES = new Set(["low", "medium", "high"]);

interface FeedbackContextPayload {
  prismVersion?: string;
  platform?: string;
  installMethod?: string;
  runtime?: string;
}

interface FeedbackStoreInput {
  id: string;
  userId: string;
  agentId: string;
  category: string;
  severity: string;
  summary: string;
  details?: string | undefined;
  relatedFiles?: string[] | undefined;
  context: FeedbackContextPayload;
  hash: string;
  reportedAt: number;
}

const storeFeedback = (
  db: D1Database,
  input: FeedbackStoreInput,
): Effect.Effect<{ id: string; duplicate: boolean }, unknown> =>
  Effect.gen(function* () {
    const existing = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `SELECT id FROM feedback
           WHERE user_id = ? AND agent_id = ? AND hash = ?
           ORDER BY reported_at DESC LIMIT 1`,
        )
        .bind(input.userId, input.agentId, input.hash)
        .first(),
    );
    if (existing && typeof existing.id === "string") {
      return { id: existing.id, duplicate: true };
    }

    yield* Effect.tryPromise(() =>
      db
        .prepare(
          `INSERT INTO feedback (
            id, user_id, agent_id, category, severity, summary, details, related_files,
            context_json, prism_version, platform, install_method, runtime,
            hash, reported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.id,
          input.userId,
          input.agentId,
          input.category,
          input.severity,
          input.summary,
          input.details ?? null,
          input.relatedFiles ? JSON.stringify(input.relatedFiles) : null,
          JSON.stringify(input.context),
          input.context.prismVersion ?? null,
          input.context.platform ?? null,
          input.context.installMethod ?? null,
          input.context.runtime ?? null,
          input.hash,
          input.reportedAt,
        )
        .run(),
    );

    return { id: input.id, duplicate: false };
  });

app.post("/v1/issue", async (c) => {
  const { DB, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";
  const user = await Effect.runPromise(authenticateUser(DB, c.get("apiKey") as string | undefined));
  if (!user) return c.json({ error: "API key required" }, 401);

  const body = await Effect.runPromise(
    readJsonBody<{
      title?: string;
      body?: string;
      agentId?: string;
      context?: FeedbackContextPayload;
    }>(c.req),
  );
  if (!body.title || typeof body.title !== "string") {
    return c.json({ error: "Title required" }, 400);
  }
  const title = body.title;

  if (CACHE) {
    const rateKey = `rate_limit:feedback:${clientIp}`;
    const current = await Effect.runPromise(cacheGet(CACHE, rateKey));
    const count = current ? parseInt(current, 10) : 0;
    if (count >= 10) return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

  const issue = Effect.gen(function* () {
    const details = body.body ?? "";
    const hash = (yield* hashKey(`issue:${title}:${details}`)).slice(0, 16);
    const result = yield* storeFeedback(DB, {
      id: generateId(),
      userId: user.id,
      agentId: body.agentId ?? "cli",
      category: "friction",
      severity: "high",
      summary: title,
      details,
      context: body.context ?? {},
      hash,
      reportedAt: Date.now(),
    });
    if (CACHE && !result.duplicate) {
      const rateKey = `rate_limit:feedback:${clientIp}`;
      const current = yield* Effect.tryPromise(() => CACHE.get(rateKey));
      const count = current ? parseInt(current, 10) : 0;
      yield* Effect.tryPromise(() =>
        CACHE.put(rateKey, String(count + 1), { expirationTtl: 3600 }),
      );
    }
    return c.json(result);
  });

  return Effect.runPromise(
    issue.pipe(
      Effect.catchAll(() => Effect.succeed(c.json({ error: "Failed to store issue" }, 500))),
    ),
  );
});

app.post("/v1/feedback", async (c) => {
  const { DB, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";
  const user = await Effect.runPromise(authenticateUser(DB, c.get("apiKey") as string | undefined));
  if (!user) return c.json({ error: "API key required" }, 401);

  const body = await Effect.runPromise(
    readJsonBody<{
      id?: string;
      agentId?: string;
      category?: string;
      severity?: string;
      summary?: string;
      details?: string;
      relatedFiles?: string[];
      context?: FeedbackContextPayload;
      hash?: string;
      reportedAt?: number;
    }>(c.req),
  );

  if (!body.id || typeof body.id !== "string") {
    return c.json({ error: "id is required" }, 400);
  }
  if (!body.agentId || typeof body.agentId !== "string") {
    return c.json({ error: "agentId is required" }, 400);
  }
  if (!body.category || !VALID_FEEDBACK_CATEGORIES.has(body.category)) {
    return c.json(
      { error: "category must be one of: friction, suggestion, observation, praise" },
      400,
    );
  }
  if (!body.severity || !VALID_FEEDBACK_SEVERITIES.has(body.severity)) {
    return c.json({ error: "severity must be one of: low, medium, high" }, 400);
  }
  if (!body.summary || typeof body.summary !== "string") {
    return c.json({ error: "summary is required" }, 400);
  }
  if (!body.hash || typeof body.hash !== "string") {
    return c.json({ error: "hash is required" }, 400);
  }
  const feedbackId = body.id;
  const feedbackAgentId = body.agentId;
  const feedbackCategory = body.category;
  const feedbackSeverity = body.severity;
  const feedbackSummary = body.summary;
  const feedbackHash = body.hash;

  if (CACHE) {
    const rateKey = `rate_limit:feedback:${clientIp}`;
    const rateData = await Effect.runPromise(cacheGet(CACHE, rateKey));
    const parsed = rateData ? parseInt(rateData, 10) : 0;
    const count = Number.isNaN(parsed) ? 0 : parsed;
    if (count >= 10) return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

  const feedback = Effect.gen(function* () {
    const result = yield* storeFeedback(DB, {
      id: feedbackId,
      userId: user.id,
      agentId: feedbackAgentId,
      category: feedbackCategory,
      severity: feedbackSeverity,
      summary: feedbackSummary,
      details: body.details,
      relatedFiles: body.relatedFiles,
      context: body.context ?? {},
      hash: feedbackHash,
      reportedAt: body.reportedAt ?? Date.now(),
    });

    if (CACHE && !result.duplicate) {
      const rateKey = `rate_limit:feedback:${clientIp}`;
      const rateData = yield* Effect.tryPromise(() => CACHE.get(rateKey));
      const parsed = rateData ? parseInt(rateData, 10) : 0;
      const count = Number.isNaN(parsed) ? 0 : parsed;
      yield* Effect.tryPromise(() =>
        CACHE.put(rateKey, String(count + 1), { expirationTtl: 3600 }),
      );
    }
    return c.json(result);
  });

  return Effect.runPromise(
    feedback.pipe(
      Effect.catchAll(() => Effect.succeed(c.json({ error: "Failed to store feedback" }, 500))),
    ),
  );
});

app.get("/v1/feedback", async (c) => {
  const { DB } = c.env;

  const authHeader = c.req.header("Authorization");
  const match = authHeader?.match(/^Bearer\s+(.+)$/);
  const token = match?.[1];

  if (!token || !c.env.ADMIN_API_KEY || !constantTimeEqual(token, c.env.ADMIN_API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const category = c.req.query("category");
  const agentId = c.req.query("agentId");
  const rawLimit = c.req.query("limit");
  let limit = rawLimit ? Number.parseInt(rawLimit, 10) : 50;
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  const query = Effect.gen(function* () {
    let sql = "SELECT * FROM feedback WHERE 1=1";
    const params: (string | number)[] = [];

    if (category) {
      sql += " AND category = ?";
      params.push(category);
    }
    if (agentId) {
      sql += " AND agent_id = ?";
      params.push(agentId);
    }
    sql += " ORDER BY reported_at DESC LIMIT ?";
    params.push(limit);

    const result = yield* Effect.tryPromise(() =>
      DB.prepare(sql)
        .bind(...params)
        .all(),
    );
    return c.json({ feedback: result.results ?? [] });
  });

  return Effect.runPromise(
    query.pipe(
      Effect.catchAll(() => Effect.succeed(c.json({ error: "Failed to fetch feedback" }, 500))),
    ),
  );
});

app.get("/v1/audit", async (c) => {
  const { DB } = c.env;
  const authHeader = c.req.header("Authorization");
  const match = authHeader?.match(/^Bearer\s+(.+)$/);
  const token = match?.[1];
  if (!token || !c.env.ADMIN_API_KEY || !constantTimeEqual(token, c.env.ADMIN_API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const userId = c.req.query("userId");
  const action = c.req.query("action");
  const rawLimit = c.req.query("limit");
  let limit = rawLimit ? Number.parseInt(rawLimit, 10) : 100;
  if (!Number.isFinite(limit) || limit < 1) limit = 100;
  if (limit > 500) limit = 500;

  const query = Effect.gen(function* () {
    let sql = "SELECT * FROM audit_event_summary WHERE 1=1";
    const params: (string | number)[] = [];
    if (userId) {
      sql += " AND user_id = ?";
      params.push(userId);
    }
    if (action) {
      sql += " AND action = ?";
      params.push(action);
    }
    sql += " ORDER BY last_seen_at DESC LIMIT ?";
    params.push(limit);
    const result = yield* Effect.tryPromise(() =>
      DB.prepare(sql)
        .bind(...params)
        .all(),
    );
    return c.json({ events: result.results ?? [] });
  });

  return Effect.runPromise(
    query.pipe(
      Effect.catchAll(() => Effect.succeed(c.json({ error: "Failed to fetch audit events" }, 500))),
    ),
  );
});

app.post("/v1/errors/report", async (c) => {
  const { DB, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";
  const user = await Effect.runPromise(authenticateUser(DB, c.get("apiKey") as string | undefined));
  if (!user) return c.json({ error: "API key required" }, 401);

  const body = await Effect.runPromise(
    readJsonBody<{
      id?: string;
      agentId?: string;
      errorType?: string;
      message?: string;
      stackTrace?: string;
      prismVersion?: string;
      platform?: string;
      severity?: string;
      isRecoverable?: number;
    }>(c.req),
  );

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
    const rateData = await Effect.runPromise(cacheGet(CACHE, rateKey));
    const parsed = rateData ? parseInt(rateData, 10) : 0;
    const count = Number.isNaN(parsed) ? 0 : parsed;
    if (count >= 100) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }
    await Effect.runPromise(cachePut(CACHE, rateKey, String(count + 1), { expirationTtl: 3600 }));
  }

  const report = Effect.gen(function* () {
    const severity = body.severity ?? "error";
    const isRecoverable = body.isRecoverable ? 1 : 0;

    yield* Effect.tryPromise(() =>
      DB.prepare(
        `INSERT INTO error_logs (user_id, id, agent_id, error_type, message, stack_trace, prism_version, platform, severity, is_recoverable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          user.id,
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
        .run(),
    );

    return c.json({ id: body.id });
  });

  return Effect.runPromise(
    report.pipe(
      Effect.catchAll((cause) => {
        const message = causeMessage(cause);
        return Effect.succeed(
          message.includes("UNIQUE constraint")
            ? c.json({ id: body.id })
            : c.json({ error: "Failed to store error report" }, 500),
        );
      }),
    ),
  );
});

app.post("/v1/errors/batch", async (c) => {
  const { DB, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";
  const user = await Effect.runPromise(authenticateUser(DB, c.get("apiKey") as string | undefined));
  if (!user) return c.json({ error: "API key required" }, 401);

  const body = await Effect.runPromise(
    readJsonBody<{
      app?: string;
      version?: string;
      reports?: Array<{
        id?: string;
        agentId?: string;
        errorType?: string;
        category?: string;
        message?: string;
        stackTrace?: string;
        stack?: string;
        prismVersion?: string;
        platform?: string;
        severity?: string;
        isRecoverable?: number;
      }>;
    }>(c.req),
  );

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
    const rateData = await Effect.runPromise(cacheGet(CACHE, rateKey));
    const parsed = rateData ? parseInt(rateData, 10) : 0;
    const count = Number.isNaN(parsed) ? 0 : parsed;
    if (count >= 50) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }
    await Effect.runPromise(cachePut(CACHE, rateKey, String(count + 1), { expirationTtl: 3600 }));
  }

  // Validate all reports — accept both engine format (category, stack, version top-level)
  // and direct API format (errorType, stackTrace, prismVersion per-report)
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
    const errorType = r.errorType ?? r.category;
    const prismVersion = r.prismVersion ?? body.version ?? "unknown";
    const stackTrace = r.stackTrace ?? r.stack ?? null;
    const agentId = r.agentId ?? "engine";

    if (!r.id || !errorType || !r.message || !prismVersion) {
      return c.json(
        {
          error:
            "Each report requires id, message, and either errorType/category with prismVersion/version",
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
      agentId,
      errorType,
      message: r.message,
      prismVersion,
      stackTrace,
      platform: r.platform ?? null,
      severity: r.severity ?? "error",
      isRecoverable: r.isRecoverable ? 1 : 0,
    });
  }

  const batch = Effect.gen(function* () {
    const stmt = DB.prepare(
      `INSERT OR IGNORE INTO error_logs (user_id, id, agent_id, error_type, message, stack_trace, prism_version, platform, severity, is_recoverable)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const batchStatements = validReports.map((r) =>
      stmt.bind(
        user.id,
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

    const results = yield* Effect.tryPromise(() => DB.batch(batchStatements));
    const inserted = results.reduce(
      (sum, r) => sum + (typeof r.meta.changes === "number" ? r.meta.changes : 0),
      0,
    );
    const duplicates = validReports.length - inserted;

    return c.json({ inserted, duplicates });
  });

  return Effect.runPromise(
    batch.pipe(
      Effect.catchAll(() =>
        Effect.succeed(c.json({ error: "Failed to store error reports" }, 500)),
      ),
    ),
  );
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

  const stats = Effect.tryPromise(() =>
    DB.prepare(
      `SELECT error_type, COUNT(*) as count
       FROM error_logs
       WHERE created_at >= datetime('now', '-1 day')
       GROUP BY error_type
       ORDER BY count DESC`,
    ).all(),
  ).pipe(
    Effect.map((result) => c.json({ stats: result.results ?? [] })),
    Effect.catchAll(() => Effect.succeed(c.json({ error: "Failed to fetch stats" }, 500))),
  );

  return Effect.runPromise(stats);
});

// ── Proactive Telegram alerts (Wave 5) ──────────────────────────────────────
// Engine POSTs alert events with its API key. Every alert is persisted first
// (delivered_at NULL), then pushed to the telegram-bot worker, which is the
// only component that can reach the Telegram API. Push is best-effort: the
// row stays auditable even when delivery is skipped or fails.

const VALID_ALERT_TYPES = new Set([
  "position_out_of_range",
  "range_warning",
  "exit_executed",
  "risk_rejection",
  "fee_milestone",
  "stablecoin_depeg",
  "liquidity_drain",
  "il_dominance",
]);
const VALID_ALERT_SEVERITIES = new Set(["info", "warning", "critical"]);
const MAX_ALERT_MESSAGE_LENGTH = 1000;
const MAX_ALERT_DATA_LENGTH = 4096;
const ALERT_RATE_LIMIT_PER_HOUR = 60;
const ALERT_FORWARD_TIMEOUT_MS = 5000;

app.post("/v1/alerts", async (c) => {
  const { DB, CACHE } = c.env;
  const user = await Effect.runPromise(authenticateUser(DB, c.get("apiKey") as string | undefined));
  if (!user) return c.json({ error: "API key required" }, 401);

  const body = await Effect.runPromise(
    readJsonBody<{
      type?: string;
      poolAddress?: string;
      severity?: string;
      message?: string;
      data?: unknown;
    }>(c.req),
  );

  if (!body.type || !VALID_ALERT_TYPES.has(body.type)) {
    return c.json(
      { error: `type must be one of: ${Array.from(VALID_ALERT_TYPES).join(", ")}` },
      400,
    );
  }
  if (!body.severity || !VALID_ALERT_SEVERITIES.has(body.severity)) {
    return c.json({ error: "severity must be one of: info, warning, critical" }, 400);
  }
  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "message is required" }, 400);
  }
  if (body.message.length > MAX_ALERT_MESSAGE_LENGTH) {
    return c.json({ error: `message exceeds ${MAX_ALERT_MESSAGE_LENGTH} characters` }, 400);
  }
  if (
    body.poolAddress !== undefined &&
    (typeof body.poolAddress !== "string" || body.poolAddress.length > 64)
  ) {
    return c.json({ error: "poolAddress must be a string of at most 64 characters" }, 400);
  }
  let dataJson: string | null = null;
  if (body.data !== undefined && body.data !== null) {
    if (typeof body.data !== "object" || Array.isArray(body.data)) {
      return c.json({ error: "data must be a JSON object" }, 400);
    }
    dataJson = JSON.stringify(body.data);
    if (dataJson.length > MAX_ALERT_DATA_LENGTH) {
      return c.json({ error: `data exceeds ${MAX_ALERT_DATA_LENGTH} characters` }, 400);
    }
  }

  // Per-user (not per-IP) cap: an engine bug must not spam a user's Telegram.
  if (CACHE) {
    const rateKey = `rate_limit:alerts:${user.id}`;
    const rateData = await Effect.runPromise(cacheGet(CACHE, rateKey));
    const parsed = rateData ? parseInt(rateData, 10) : 0;
    const count = Number.isNaN(parsed) ? 0 : parsed;
    if (count >= ALERT_RATE_LIMIT_PER_HOUR) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }
    await Effect.runPromise(cachePut(CACHE, rateKey, String(count + 1), { expirationTtl: 3600 }));
  }

  const alertType = body.type;
  const alertSeverity = body.severity;
  const alertMessage = body.message;
  const botUrl = c.env.TELEGRAM_BOT_URL;
  const botSecret = c.env.BOT_API_SECRET;

  const storeAndForward = Effect.gen(function* () {
    const id = generateId();
    yield* Effect.tryPromise(() =>
      DB.prepare(
        `INSERT INTO alerts (id, user_id, type, pool_address, severity, message, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          user.id,
          alertType,
          body.poolAddress ?? null,
          alertSeverity,
          alertMessage,
          dataJson,
        )
        .run(),
    );

    const userRow = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT telegram_id, alerts_enabled FROM users WHERE id = ?")
        .bind(user.id)
        .first(),
    );
    const telegramId =
      userRow && typeof userRow.telegram_id === "string" && userRow.telegram_id.length > 0
        ? userRow.telegram_id
        : null;
    const alertsEnabled = !userRow || userRow.alerts_enabled !== 0;

    let delivered = false;
    if (telegramId && alertsEnabled && botUrl && botSecret) {
      const forward = yield* Effect.tryPromise(() =>
        fetch(`${botUrl}/internal/deliver-alert`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Bot-Api-Secret": botSecret,
          },
          body: JSON.stringify({
            alert_id: id,
            telegram_id: telegramId,
            type: alertType,
            severity: alertSeverity,
            message: alertMessage,
            pool_address: body.poolAddress ?? null,
            data: body.data ?? null,
          }),
          signal: AbortSignal.timeout(ALERT_FORWARD_TIMEOUT_MS),
        }),
      ).pipe(Effect.catchAll(() => Effect.succeed(null)));

      if (forward?.ok) {
        delivered = true;
        yield* Effect.tryPromise(() =>
          DB.prepare("UPDATE alerts SET delivered_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(id)
            .run(),
        ).pipe(Effect.catchAll(() => Effect.succeed(null)));
      } else {
        console.error(
          "[Alerts] telegram-bot forward failed",
          forward ? `status ${forward.status}` : "network error",
        );
      }
    }

    return c.json({ id, delivered });
  });

  return Effect.runPromise(
    storeAndForward.pipe(
      Effect.catchAll(() => Effect.succeed(c.json({ error: "Failed to store alert" }, 500))),
    ),
  );
});

// Bot-authenticated preference toggle backing the `/alerts on|off` command.
app.post("/v1/alerts/preferences", async (c) => {
  const { DB } = c.env;
  if (!isBotAuthorized(c.env, c.req.header("X-Bot-Api-Secret"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = await Effect.runPromise(
    readJsonBody<{ telegram_id?: string; enabled?: unknown }>(c.req),
  );

  if (!body.telegram_id || !/^\d+$/.test(body.telegram_id)) {
    return c.json({ error: "telegram_id required (numeric)" }, 400);
  }
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  const enabled = body.enabled;
  const telegramId = body.telegram_id;

  return Effect.runPromise(
    Effect.tryPromise(() =>
      DB.prepare("UPDATE users SET alerts_enabled = ? WHERE telegram_id = ?")
        .bind(enabled ? 1 : 0, telegramId)
        .run(),
    ).pipe(
      Effect.match({
        onFailure: () => c.json({ error: "Failed to update preferences" }, 500),
        onSuccess: (result) =>
          result.meta.changes === 0
            ? c.json({ error: "User not found" }, 404)
            : c.json({ success: true, alerts_enabled: enabled }),
      }),
    ),
  );
});

// ── Fee Wallet ───────────────────────────────────────────────────────────────

const SOLANA_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

app.get("/v1/fee-wallet", async (c) => {
  const { CACHE } = c.env;

  if (CACHE) {
    const kvAddress = await Effect.runPromise(cacheGet(CACHE, "fee_wallet_address"));
    if (kvAddress) {
      return c.json({ address: kvAddress, source: "kv" });
    }
  }

  if (c.env.FEE_WALLET_ADDRESS) {
    return c.json({ address: c.env.FEE_WALLET_ADDRESS, source: "secret" });
  }

  return c.json({ error: "No fee wallet configured" }, 404);
});

app.put("/v1/fee-wallet", async (c) => {
  const authHeader = c.req.header("Authorization");
  const match = authHeader?.match(/^Bearer\s+(.+)$/);
  const token = match?.[1];

  if (!token || !c.env.ADMIN_API_KEY || !constantTimeEqual(token, c.env.ADMIN_API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await Effect.runPromise(readJsonBody<{ address?: string }>(c.req));

  if (!body.address || typeof body.address !== "string") {
    return c.json({ error: "address is required" }, 400);
  }

  if (!SOLANA_BASE58_RE.test(body.address)) {
    return c.json({ error: "Invalid Solana address (must be base58, 32-44 chars)" }, 400);
  }

  const { CACHE } = c.env;
  if (!CACHE) {
    return c.json({ error: "KV not available" }, 500);
  }

  await Effect.runPromise(cachePut(CACHE, "fee_wallet_address", body.address));
  return c.json({ address: body.address, updated: true });
});

app.get("/v1/config", async (c) => {
  const { DB, CACHE } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  const config = Effect.gen(function* () {
    const loginResult = yield* loginHandler(DB, apiKey);
    const tier = (loginResult as { tier?: string }).tier ?? "free";
    const kvAddress = CACHE
      ? yield* Effect.tryPromise(() => CACHE.get("fee_wallet_address"))
      : null;
    const feeWalletAddress = kvAddress ?? c.env.FEE_WALLET_ADDRESS ?? null;

    return c.json({
      tier,
      platformFeeRate: TIERS[tier]?.platformFeeRate ?? 0,
      revenueShareEnabled: true,
      revenueShareOperatorPct: 0,
      feeWalletAddress,
      configVersion: 1,
    });
  });

  return Effect.runPromise(
    config.pipe(Effect.catchAll(() => Effect.succeed(c.json({ error: "Unauthorized" }, 401)))),
  );
});

// ── Install Telemetry ───────────────────────────────────────────────────────
// Privacy: install_id is a random UUID generated client-side; no PII.

app.post("/v1/installs/ping", async (c) => {
  const { DB, CACHE } = c.env;
  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";

  const body = await Effect.runPromise(
    readJsonBody<{
      installId?: string;
      event?: string;
      version?: string;
      channel?: string;
      platform?: string;
      userId?: string;
    }>(c.req),
  );

  if (
    typeof body.installId !== "string" ||
    body.installId.length < 8 ||
    body.installId.length > 128
  ) {
    return c.json({ error: "installId is required and must be 8-128 chars" }, 400);
  }
  if (!body.event || !VALID_INSTALL_EVENTS.has(body.event)) {
    return c.json(
      {
        error: `event is required and must be one of: ${Array.from(VALID_INSTALL_EVENTS).join(", ")}`,
      },
      400,
    );
  }

  const user =
    body.event === "install"
      ? null
      : await Effect.runPromise(authenticateUser(DB, c.get("apiKey") as string | undefined));
  if (body.event !== "install" && !user) {
    return c.json({ error: "API key required for registered telemetry" }, 401);
  }

  // Rate limit: 100 pings per IP per hour (same as error reports).
  if (CACHE) {
    const rateKey = `rate_limit:install_ping:${clientIp}`;
    const rateData = await Effect.runPromise(cacheGet(CACHE, rateKey));
    const parsed = rateData ? parseInt(rateData, 10) : 0;
    const count = Number.isNaN(parsed) ? 0 : parsed;
    if (count >= 100) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }
    await Effect.runPromise(cachePut(CACHE, rateKey, String(count + 1), { expirationTtl: 3600 }));
  }

  const id = generateId();
  const ping = Effect.tryPromise(() =>
    DB.prepare(
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
        user?.id ?? null,
      )
      .run(),
  ).pipe(
    Effect.map(() => c.json({ id })),
    Effect.catchAll(() => Effect.succeed(c.json({ error: "Internal server error" }, 500))),
  );

  return Effect.runPromise(ping);
});

app.get("/v1/referral/code", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  const referral = Effect.gen(function* () {
    const loginResult = yield* loginHandler(DB, apiKey);
    const userId = (loginResult as { id: string }).id;

    let result = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT code FROM referral_codes WHERE user_id = ?").bind(userId).first(),
    );

    if (!result) {
      const code = generateReferralCode();
      yield* Effect.tryPromise(() =>
        DB.prepare("INSERT INTO referral_codes (code, user_id) VALUES (?, ?)")
          .bind(code, userId)
          .run(),
      );
      result = { code };
    }

    const countResult = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT COUNT(*) as count FROM referrals WHERE referrer_user_id = ?")
        .bind(userId)
        .first(),
    );

    return c.json({ code: result.code, referralCount: countResult?.count ?? 0 });
  });

  return Effect.runPromise(
    referral.pipe(
      Effect.catchAll(() => Effect.succeed(c.json({ error: "Failed to get referral code" }, 500))),
    ),
  );
});

app.post("/v1/referral/apply", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;
  const body = await Effect.runPromise(readJsonBody<{ code?: string }>(c.req));

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  if (!body.code) {
    return c.json({ error: "Code required" }, 400);
  }

  const referral = Effect.gen(function* () {
    const loginResult = yield* loginHandler(DB, apiKey);
    const userId = (loginResult as { id: string }).id;
    const codeResult = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT user_id FROM referral_codes WHERE code = ?").bind(body.code).first(),
    );

    if (!codeResult) return c.json({ error: "Invalid referral code" }, 400);
    if (codeResult.user_id === userId) return c.json({ error: "Cannot refer yourself" }, 400);

    const existing = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT id FROM referrals WHERE referee_user_id = ?").bind(userId).first(),
    );
    if (existing) return c.json({ error: "Already referred" }, 400);

    yield* Effect.tryPromise(() =>
      DB.prepare(
        "INSERT INTO referrals (id, referrer_user_id, referee_user_id, referral_code) VALUES (?, ?, ?, ?)",
      )
        .bind(generateId(), codeResult.user_id, userId, body.code)
        .run(),
    );
    yield* Effect.tryPromise(() =>
      DB.prepare("INSERT INTO user_credits (id, user_id, amount, reason) VALUES (?, ?, ?, ?)")
        .bind(generateId(), codeResult.user_id, 5, "referral_bonus")
        .run(),
    );
    yield* Effect.tryPromise(() =>
      DB.prepare("INSERT INTO user_credits (id, user_id, amount, reason) VALUES (?, ?, ?, ?)")
        .bind(generateId(), userId, 10, "referee_bonus")
        .run(),
    );

    const countResult = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT COUNT(*) as count FROM referrals WHERE referrer_user_id = ?")
        .bind(codeResult.user_id)
        .first(),
    );
    const referralCount = countResult?.count ?? 0;
    const milestoneBonus = referralCount === 5 ? 25 : referralCount === 10 ? 50 : 0;
    if (milestoneBonus > 0) {
      yield* Effect.tryPromise(() =>
        DB.prepare("INSERT INTO user_credits (id, user_id, amount, reason) VALUES (?, ?, ?, ?)")
          .bind(generateId(), codeResult.user_id, milestoneBonus, `milestone_${referralCount}`)
          .run(),
      );
    }

    return c.json({ success: true, credits: 10 });
  });

  return Effect.runPromise(
    referral.pipe(
      Effect.catchAll(() => Effect.succeed(c.json({ error: "Failed to apply referral" }, 500))),
    ),
  );
});

app.get("/v1/referral/stats", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  const stats = Effect.gen(function* () {
    const loginResult = yield* loginHandler(DB, apiKey);
    const userId = (loginResult as { id: string }).id;
    const countResult = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT COUNT(*) as count FROM referrals WHERE referrer_user_id = ?")
        .bind(userId)
        .first(),
    );
    const creditsResult = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM user_credits WHERE user_id = ?")
        .bind(userId)
        .first(),
    );
    const referralCount = (countResult as { count?: number })?.count ?? 0;
    const milestone =
      referralCount >= 10
        ? "10 referrals - $50 bonus!"
        : referralCount >= 5
          ? "5 referrals - $25 bonus!"
          : null;

    return c.json({
      referralCount,
      credits: (creditsResult as { total?: number })?.total ?? 0,
      milestone,
    });
  });

  return Effect.runPromise(
    stats.pipe(
      Effect.catchAll(() => Effect.succeed(c.json({ error: "Failed to get referral stats" }, 500))),
    ),
  );
});

app.get("/v1/subscription/status", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  const subscription = Effect.gen(function* () {
    const loginResult = yield* loginHandler(DB, apiKey);
    const userId = (loginResult as { id: string }).id;
    const userResult = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT tier FROM users WHERE id = ?").bind(userId).first(),
    );
    const tier = (userResult as { tier?: string })?.tier ?? "free";

    const subResult = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT id FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
        .bind(userId)
        .first(),
    );
    if (!subResult) {
      yield* Effect.tryPromise(() =>
        DB.prepare(
          "INSERT OR IGNORE INTO subscriptions (id, user_id, tier, period_start, period_end) VALUES (?, ?, ?, ?, ?)",
        )
          .bind(
            generateId(),
            userId,
            tier,
            new Date().toISOString(),
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          )
          .run(),
      );
    }

    const countResult = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT COUNT(*) as count FROM referrals WHERE referrer_user_id = ?")
        .bind(userId)
        .first(),
    );
    const creditsResult = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM user_credits WHERE user_id = ?")
        .bind(userId)
        .first(),
    );
    const tierConfig = TIERS[tier as keyof typeof TIERS];

    return c.json({
      tier,
      walletSol: 0,
      referralCount: (countResult as { count?: number })?.count ?? 0,
      credits: (creditsResult as { total?: number })?.total ?? 0,
      platformFeeRate: tierConfig?.platformFeeRate ?? 0,
    });
  });

  return Effect.runPromise(
    subscription.pipe(
      Effect.catchAll(() =>
        Effect.succeed(c.json({ error: "Failed to get subscription status" }, 500)),
      ),
    ),
  );
});

// ── Revenue Tracking ─────────────────────────────────────────────────────────
// Engine reports fee collections; admin dashboard queries aggregated stats.

app.post("/v1/revenue/log", async (c) => {
  const { DB, CACHE } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  const authentication = await Effect.runPromise(loginHandler(DB, apiKey).pipe(Effect.either));
  if (authentication._tag === "Left") {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const authenticatedUser = authentication.right as { id: string; tier?: string };
  const userId = authenticatedUser.id;
  const tier = authenticatedUser.tier ?? "free";

  const clientIp = c.req.header("CF-Connecting-IP") || "unknown";

  const body = await Effect.runPromise(
    readJsonBody<{
      poolAddress?: string;
      positionPubkey?: string;
      feeX?: number;
      feeY?: number;
      platformFeeX?: number;
      platformFeeY?: number;
      operatorFeeX?: number;
      operatorFeeY?: number;
      txSignature?: string;
      feeTransferTxSignature?: string;
      installId?: string;
    }>(c.req),
  );

  if (typeof body.poolAddress !== "string" || body.poolAddress.length === 0) {
    return c.json({ error: "Missing required field: poolAddress (string)" }, 400);
  }

  // Every numeric field must be a finite, non-negative number. Negative or
  // non-finite fees would corrupt revenue accounting.
  const numericFields: Array<readonly [string, number | undefined, boolean]> = [
    ["platformFeeX", body.platformFeeX, true],
    ["platformFeeY", body.platformFeeY, true],
    ["feeX", body.feeX, false],
    ["feeY", body.feeY, false],
    ["operatorFeeX", body.operatorFeeX, false],
    ["operatorFeeY", body.operatorFeeY, false],
  ];
  for (const [name, value, required] of numericFields) {
    if (value === undefined) {
      if (required) {
        return c.json({ error: `Missing required field: ${name} (number)` }, 400);
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return c.json({ error: `Invalid ${name}: must be a finite, non-negative number` }, 400);
    }
  }

  if (CACHE) {
    const rateKey = `rate_limit:revenue_log:${clientIp}`;
    const rateData = await Effect.runPromise(cacheGet(CACHE, rateKey));
    const parsed = rateData ? parseInt(rateData, 10) : 0;
    const count = Number.isNaN(parsed) ? 0 : parsed;
    if (count >= 200) {
      return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
    }
    await Effect.runPromise(cachePut(CACHE, rateKey, String(count + 1), { expirationTtl: 3600 }));
  }

  const revenue = Effect.gen(function* () {
    const id = generateId();
    yield* Effect.tryPromise(() =>
      DB.prepare(
        `INSERT INTO revenue_events (id, pool_address, position_pubkey, fee_x, fee_y, platform_fee_x, platform_fee_y, operator_fee_x, operator_fee_y, tier, user_id, install_id, tx_signature, fee_transfer_tx_signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          body.poolAddress,
          body.positionPubkey ?? null,
          body.feeX ?? 0,
          body.feeY ?? 0,
          body.platformFeeX,
          body.platformFeeY,
          body.operatorFeeX ?? 0,
          body.operatorFeeY ?? 0,
          tier,
          userId,
          body.installId ?? null,
          body.txSignature ?? null,
          body.feeTransferTxSignature ?? null,
        )
        .run(),
    );
    return c.json({ id });
  });

  return Effect.runPromise(
    revenue.pipe(
      Effect.match({
        onFailure: (cause) =>
          causeMessage(cause).includes("Invalid API key")
            ? c.json({ error: "Unauthorized" }, 401)
            : c.json({ error: "Internal server error" }, 500),
        onSuccess: (response) => response,
      }),
    ),
  );
});

app.get("/v1/revenue", async (c) => {
  const { DB } = c.env;

  // Admin auth
  const authHeader = c.req.header("Authorization");
  const match = authHeader?.match(/^Bearer\s+(.+)$/);
  const token = match?.[1];

  if (!token || !c.env.ADMIN_API_KEY || !constantTimeEqual(token, c.env.ADMIN_API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const revenue = Effect.gen(function* () {
    const totalResult = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT COUNT(*) as total FROM revenue_events").first(),
    );
    const tierResult = yield* Effect.tryPromise(() =>
      DB.prepare(
        `SELECT tier, COUNT(*) as count, SUM(platform_fee_x + platform_fee_y) as totalFee
         FROM revenue_events
         GROUP BY tier`,
      ).all(),
    );
    const recentResult = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT * FROM revenue_events ORDER BY created_at DESC LIMIT 20").all(),
    );

    return c.json({
      total: (totalResult as { total?: number })?.total ?? 0,
      byTier: tierResult.results ?? [],
      recent: recentResult.results ?? [],
    });
  });

  return Effect.runPromise(
    revenue.pipe(
      Effect.catchAll(() =>
        Effect.succeed(c.json({ error: "Failed to fetch revenue stats" }, 500)),
      ),
    ),
  );
});

// ── Wallet management ────────────────────────────────────────────────────

app.post("/v1/wallet", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  const body = await Effect.runPromise(readJsonBody<{ pubkey?: string }>(c.req));

  if (!body.pubkey || typeof body.pubkey !== "string") {
    return c.json({ error: "pubkey is required" }, 400);
  }

  // Validate Solana base58 format (32-44 chars)
  if (!SOLANA_BASE58_RE.test(body.pubkey)) {
    return c.json({ error: "Invalid Solana address (must be base58, 32-44 chars)" }, 400);
  }

  const wallet = Effect.gen(function* () {
    const loginResult = yield* loginHandler(DB, apiKey);
    const userId = (loginResult as { id: string }).id;

    yield* Effect.tryPromise(() =>
      DB.batch([
        DB.prepare("DELETE FROM wallets WHERE user_id = ?").bind(userId),
        DB.prepare("INSERT INTO wallets (id, user_id, pubkey) VALUES (?, ?, ?)").bind(
          generateId(),
          userId,
          body.pubkey,
        ),
      ]),
    );
    yield* logAudit(DB, userId, "wallet_sync", { pubkey: body.pubkey });

    return c.json({ success: true, pubkey: body.pubkey });
  });

  return Effect.runPromise(
    wallet.pipe(
      Effect.match({
        onFailure: (cause) => {
          const message = causeMessage(cause);
          return message.includes("Invalid API key") || message.includes("User not found")
            ? c.json({ error: "Unauthorized" }, 401)
            : c.json({ error: "Failed to store wallet" }, 500);
        },
        onSuccess: (response) => response,
      }),
    ),
  );
});

app.get("/v1/wallet", async (c) => {
  const { DB } = c.env;
  const apiKey = c.get("apiKey") as string;

  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  const wallet = Effect.gen(function* () {
    const loginResult = yield* loginHandler(DB, apiKey);
    const userId = (loginResult as { id: string }).id;
    const result = yield* Effect.tryPromise(() =>
      DB.prepare("SELECT pubkey FROM wallets WHERE user_id = ?").bind(userId).first(),
    );

    return result ? c.json({ pubkey: result.pubkey }) : c.json({ error: "No wallet found" }, 404);
  });

  return Effect.runPromise(
    wallet.pipe(
      Effect.match({
        onFailure: (cause) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          return message.includes("Invalid API key") || message.includes("User not found")
            ? c.json({ error: "Unauthorized" }, 401)
            : c.json({ error: "Failed to fetch wallet" }, 500);
        },
        onSuccess: (response) => response,
      }),
    ),
  );
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
};
