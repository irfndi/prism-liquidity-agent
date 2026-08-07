import { Effect, Layer, Context } from "effect";
import { Hono } from "hono";

// Environment bindings interface
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  BACKUPS: R2Bucket;
  TELEMETRY_ARCHIVE?: R2Bucket;
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
const MAX_ERROR_TYPE_LENGTH = 128;
const MAX_STACK_TRACE_LENGTH = 8192;

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
class DbService extends Context.Service<DbService, { readonly db: D1Database }>()("DbService") {}

class CacheService extends Context.Service<
  CacheService,
  { readonly cache: KVNamespace }
>()("CacheService") {}

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
    Effect.catch(() => Effect.succeed({} as T)),
  );
}

const cacheGet = (cache: KVNamespace, key: string) => Effect.tryPromise(() => cache.get(key));

const cachePut = (
  cache: KVNamespace,
  key: string,
  value: string,
  options?: KVNamespacePutOptions,
) => Effect.tryPromise(() => cache.put(key, value, options));

// Atomic per-key rate-limit counter on D1. KV's get→check→put is a TOCTOU
// race under concurrency; this increments in one statement and returns the
// post-increment count, so a burst cannot all pass the check. Returns true
// when the request is within the limit (count <= max), false when exceeded.
// The one-hour window is anchored at the last ACCEPTED request: accepted
// increments refresh updated_at, rejected increments leave it untouched, so
// hammering rejected requests cannot slide the window forward. Counts reset
// one hour after the last accepted increment (mirroring the old KV
// expirationTtl: 3600), and the table is created idempotently on first use so
// the counter works even before the migration has been applied (e.g. test
// databases).
const rateLimitHit = (
  db: D1Database,
  key: string,
  max: number,
): Effect.Effect<boolean, unknown> =>
  Effect.tryPromise(async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS rate_limits (
           key TEXT PRIMARY KEY,
           count INTEGER NOT NULL DEFAULT 0,
           updated_at INTEGER NOT NULL DEFAULT (unixepoch())
         )`,
      )
      .run();
    const { results } = await db
      .prepare(
        `INSERT INTO rate_limits (key, count, updated_at) VALUES (?, 1, unixepoch())
         ON CONFLICT (key) DO UPDATE SET
           count = CASE
             WHEN updated_at < unixepoch() - 3600 THEN 1
             ELSE count + 1
           END,
           updated_at = CASE
             WHEN updated_at < unixepoch() - 3600 THEN unixepoch()
             WHEN count < ? THEN unixepoch()
             ELSE updated_at
           END
         RETURNING count`,
      )
      .bind(key, max)
      .all<{ count: number }>();
    const count = results[0]?.count ?? 1;
    return count <= max;
  });

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

interface NormalizedErrorReport {
  readonly id: string;
  readonly agentId: string;
  readonly errorType: string;
  readonly message: string;
  readonly prismVersion: string;
  readonly stackTrace: string | null;
  readonly platform: string | null;
  readonly severity: string;
  readonly isRecoverable: number;
  readonly fingerprint: string;
}

class TelemetryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryValidationError";
  }
}

function normalizeErrorReport(
  report: {
    readonly id?: string;
    readonly agentId?: string;
    readonly errorType?: string;
    readonly category?: string;
    readonly message?: string;
    readonly stackTrace?: string;
    readonly stack?: string;
    readonly prismVersion?: string;
    readonly platform?: string;
    readonly severity?: string;
    readonly isRecoverable?: number;
  },
  batchVersion?: string,
): Effect.Effect<NormalizedErrorReport, Error> {
  return Effect.gen(function* () {
    const errorType = report.errorType ?? report.category;
    const prismVersion = report.prismVersion ?? batchVersion ?? "unknown";
    if (!report.id || !errorType || !report.message || !prismVersion) {
      return yield* Effect.fail(
        new TelemetryValidationError("Each report requires id, message, and error type/version"),
      );
    }
    if (report.message.length > MAX_ERROR_MESSAGE_LENGTH) {
      return yield* Effect.fail(
        new TelemetryValidationError(`message exceeds ${MAX_ERROR_MESSAGE_LENGTH} characters`),
      );
    }
    if (errorType.length > MAX_ERROR_TYPE_LENGTH) {
      return yield* Effect.fail(
        new TelemetryValidationError(`error type exceeds ${MAX_ERROR_TYPE_LENGTH} characters`),
      );
    }
    const rawStack = report.stackTrace ?? report.stack ?? null;
    const fingerprint = yield* hashKey(`${errorType}:${report.message.trim().toLowerCase()}`).pipe(
      Effect.mapError(() => new Error("Unable to fingerprint error report")),
    );
    return {
      id: report.id,
      agentId: report.agentId ?? "engine",
      errorType,
      message: report.message,
      prismVersion,
      stackTrace: rawStack === null ? null : rawStack.slice(0, MAX_STACK_TRACE_LENGTH),
      platform: report.platform ?? null,
      severity: report.severity ?? "error",
      isRecoverable: report.isRecoverable ? 1 : 0,
      fingerprint,
    };
  });
}

function archiveErrorReports(
  archive: R2Bucket | undefined,
  userId: string,
  reports: ReadonlyArray<NormalizedErrorReport>,
): Effect.Effect<number, never> {
  if (!archive) return Effect.succeed(0);
  const uniqueReports = [
    ...new Map(reports.map((report) => [report.fingerprint, report])).values(),
  ];
  return Effect.forEach(
    uniqueReports,
    (report) => {
      const key = `telemetry/errors/${userId}/${report.fingerprint}.json`;
      return Effect.tryPromise({
        try: () =>
          archive.put(key, JSON.stringify({ ...report, archivedAt: new Date().toISOString() }), {
            httpMetadata: { contentType: "application/json" },
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.map(() => 1),
        Effect.catch((cause) => {
          console.error("[Telemetry] Failed to archive error summary", {
            key,
            error: causeMessage(cause),
          });
          return Effect.succeed(0);
        }),
        Effect.timeout("5 seconds"),
        Effect.catch(() => Effect.succeed(0)),
      );
    },
    { concurrency: 4 },
  ).pipe(
    Effect.map((results) => results.reduce((sum, count) => sum + count, 0)),
    Effect.catch(() => Effect.succeed(0)),
  );
}
function upsertErrorReports(
  db: D1Database,
  archive: R2Bucket | undefined,
  userId: string,
  reports: ReadonlyArray<NormalizedErrorReport>,
): Effect.Effect<
  { readonly inserted: number; readonly duplicates: number; readonly archived: number },
  unknown
> {
  const STATEMENTS_PER_REPORT = 3;
  // Receipts exist only to deduplicate the client retry window; older rows can
  // never be re-sent by a retrying client, so prune them opportunistically on
  // every report write to keep the table bounded (the received_at index exists
  // for exactly this cleanup).
  const RECEIPT_RETENTION_DAYS = 7;
  return Effect.gen(function* () {
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `DELETE FROM error_report_receipts
           WHERE received_at < datetime('now', ?)`,
        )
        .bind(`-${RECEIPT_RETENTION_DAYS} days`),
    ];
    for (const report of reports) {
      // Server-derived row id scoped to the user so a client-supplied report id
      // can never collide across users on the error_logs primary key. The id
      // is a hash of the full userId + fingerprint so two users sharing a
      // truncated id prefix cannot collide. The client report id is preserved
      // in last_report_id and the receipts row.
      const rowId = `err-${(yield* hashKey(`${userId}:${report.fingerprint}`)).slice(0, 64)}`;
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO error_report_receipts (user_id, report_id)
             VALUES (?, ?)`,
          )
          .bind(userId, report.id),
        db
          .prepare(
            `INSERT INTO error_logs
              (id, user_id, agent_id, error_type, message, stack_trace, prism_version, platform, severity, is_recoverable, fingerprint, first_seen_at, last_seen_at, occurrence_count, last_report_id)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, ?
             WHERE EXISTS (
               SELECT 1 FROM error_report_receipts
               WHERE user_id = ? AND report_id = ? AND summary_applied = 0
             )
             ORDER BY true
             ON CONFLICT(user_id, fingerprint) DO UPDATE SET
               agent_id = excluded.agent_id,
               error_type = excluded.error_type,
               message = excluded.message,
               stack_trace = excluded.stack_trace,
               prism_version = excluded.prism_version,
               platform = excluded.platform,
               severity = excluded.severity,
               is_recoverable = excluded.is_recoverable,
               last_seen_at = CURRENT_TIMESTAMP,
               occurrence_count = error_logs.occurrence_count + 1,
               last_report_id = excluded.last_report_id
             WHERE EXISTS (
               SELECT 1 FROM error_report_receipts
               WHERE user_id = ? AND report_id = ? AND summary_applied = 0
             )`,
          )
          .bind(
            rowId,
            userId,
            report.agentId,
            report.errorType,
            report.message,
            report.stackTrace,
            report.prismVersion,
            report.platform,
            report.severity,
            report.isRecoverable,
            report.fingerprint,
            report.id,
            userId,
            report.id,
            userId,
            report.id,
          ),
        db
          .prepare(
            `UPDATE error_report_receipts
             SET summary_applied = 1
             WHERE user_id = ? AND report_id = ? AND summary_applied = 0`,
          )
          .bind(userId, report.id),
      );
    }
    const results = yield* Effect.tryPromise(() => db.batch(statements));
    const appliedReports = reports.filter((_report, index) => {
      const changes = results[1 + index * STATEMENTS_PER_REPORT]?.meta.changes;
      return typeof changes === "number" && changes > 0;
    });
    const inserted = appliedReports.length;
    const archived = yield* archiveErrorReports(archive, userId, appliedReports);
    return { inserted, duplicates: reports.length - inserted, archived };
  });
}

// Helper to generate referral codes. Referral codes can grant bonuses, so use
// a CSPRNG (not Math.random) to prevent prediction/forgery.
function generateReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const randBytes = new Uint8Array(8);
  crypto.getRandomValues(randBytes);
  let code = "";
  for (let i = 0; i < 8; i++) {
    const byte = randBytes[i];
    if (byte !== undefined) code += chars[byte % chars.length];
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
      Effect.catch((summaryError: unknown) =>
        Effect.tryPromise(() =>
          db
            .prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)")
            .bind(userId, action, detailsJson)
            .run(),
        ).pipe(
          Effect.catch((fallbackError: unknown) =>
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
  }).pipe(Effect.catch(() => Effect.void));
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
    Effect.catch((err) =>
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
    Effect.catch(() => Effect.succeed(null)),
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
          .prepare("INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)")
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

// Agent status (called by the Telegram bot). Query KV for the latest engine
// status reported by the live agent runtime. Returns the stored status when
// fresh (within the KV TTL, approximately 2× the scan interval); falls back
// to not_running when no recent heartbeat exists or when KV is unavailable.
const AGENT_STATUS_CACHE_TTL_SEC = 30 * 60; // 30 minutes

const agentStatusHandler = (db: D1Database, cache: KVNamespace, telegramId: string) =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
      db.prepare("SELECT id FROM users WHERE telegram_id = ?").bind(telegramId).first(),
    );

    if (!result) {
      return yield* Effect.fail(new Error("User not found"));
    }

    const userId = typeof result.id === "string" ? result.id : null;
    if (!userId) {
      return { status: "not_running", positions: 0, pnl: 0 };
    }

    // Try KV first for the latest engine heartbeat.
    const cached = yield* Effect.tryPromise(() => cache.get(`agent_status:${userId}`)).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );

    if (cached) {
      try {
        const parsed = JSON.parse(cached) as {
          status: string;
          positions: number;
          pnl: number;
          reportedAt: number;
        };
        return {
          status: parsed.status,
          positions: parsed.positions,
          pnl: parsed.pnl,
        };
      } catch {
        // Malformed JSON — fall through to not_running.
      }
    }

    return { status: "not_running", positions: 0, pnl: 0 };
  });

// Engine status report (called by the engine itself via its API key).
// Stores the engine's live state in KV so the Telegram bot can query it.
const agentStatusReportHandler = (db: D1Database, cache: KVNamespace, apiKey: string) =>
  Effect.gen(function* () {
    const loginResult = yield* loginHandler(db, apiKey);
    const userId = (loginResult as { id: string }).id;

    return {
      userId,
      storeStatus: (status: string, positions: number, pnl: number) =>
        Effect.tryPromise(() =>
          cache.put(
            `agent_status:${userId}`,
            JSON.stringify({ status, positions, pnl, reportedAt: Date.now() }),
            { expirationTtl: AGENT_STATUS_CACHE_TTL_SEC },
          ),
        ).pipe(
          Effect.catch((err) =>
            Effect.sync(() =>
              console.error("agent-status KV write failed", {
                userId,
                err: String(err),
              }),
            ),
          ),
        ),
    };
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
    }).pipe(Effect.catch(() => Effect.succeed({})))) as { telegram_id?: string };
    const rateKey = `rate_limit:register:${clientIp}`;
    const withinLimit = yield* rateLimitHit(DB, rateKey, 5);
    if (!withinLimit) {
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
      Effect.catch(() => Effect.succeed(c.json({ error: "Registration failed" }, 500))),
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
  const withinLimit = await Effect.runPromise(
    rateLimitHit(DB, rateKey, LINK_CONFIRM_RATE_LIMIT_PER_HOUR),
  );
  if (!withinLimit) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

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

    const userId = typeof codeRow.user_id === "string" ? codeRow.user_id : null;
    if (!userId) return c.json({ error: "Linking failed" }, 500);

    // Atomic link: claim the code AND bind the telegram_id in ONE D1 batch
    // (a single transaction). Claim-then-link used to be separate statements;
    // a transient D1 failure between them burnt the code without linking the
    // account, stranding the user with a dead code (observed in production:
    // the bot's second confirm hit 500 mid-link and the code was unusable).
    // In one batch, a failure rolls BOTH statements back and the code stays
    // usable; a lost claim race (concurrent confirm) surfaces as "already used".
    const linkBatch = yield* Effect.tryPromise(() =>
      DB.batch([
        DB.prepare(
          `UPDATE telegram_link_codes
           SET used_at = CURRENT_TIMESTAMP
           WHERE code = ? AND used_at IS NULL`,
        ).bind(body.code),
        DB.prepare("UPDATE users SET telegram_id = ? WHERE id = ?").bind(body.telegram_id, userId),
      ]),
    );
    const [claimResult, linkResult] = linkBatch;
    if (!claimResult?.success || claimResult.meta.changes === 0) {
      return c.json({ error: "Code already used" }, 400);
    }
    if (!linkResult?.success || linkResult.meta.changes === 0) {
      return c.json({ error: "Linking failed" }, 500);
    }

    yield* logAudit(DB, userId, "telegram_link", { telegram_id: body.telegram_id });

    return c.json({ success: true, user_id: userId });
  });

  return Effect.runPromise(
    linking.pipe(Effect.catch(() => Effect.succeed(c.json({ error: "Linking failed" }, 500)))),
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
  const withinLimit = await Effect.runPromise(rateLimitHit(DB, rateKey, 5));
  if (!withinLimit) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

  const registration = Effect.gen(function* () {
    const result = yield* registerTelegramHandler(DB, telegramId, body.first_name ?? "");
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
  const { DB, CACHE } = c.env;
  if (!isBotAuthorized(c.env, c.req.header("X-Bot-Api-Secret"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = await Effect.runPromise(readJsonBody<{ telegram_id?: string }>(c.req));

  if (!body.telegram_id) {
    return c.json({ error: "telegram_id required" }, 400);
  }

  return Effect.runPromise(
    agentStatusHandler(DB, CACHE, body.telegram_id).pipe(
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

// Engine status report endpoint — called periodically by the running engine to
// report its live state (running, positions, P&L). Authenticated via Bearer
// API key. Stored in KV with a 30-minute TTL; the bot-facing /v1/agent-status
// endpoint reads it to serve the Telegram /status command.
app.post("/v1/agent-status/report", async (c) => {
  const { DB, CACHE } = c.env;
  const apiKey = c.get("apiKey") as string;
  if (!apiKey) {
    return c.json({ error: "API key required" }, 401);
  }

  const body = await Effect.runPromise(
    readJsonBody<{ status?: string; positions?: number; pnl?: number }>(c.req),
  );

  if (body.status !== "running" && body.status !== "stopped") {
    return c.json({ error: "status must be 'running' or 'stopped'" }, 400);
  }
  if (
    typeof body.positions !== "number" ||
    !Number.isFinite(body.positions) ||
    body.positions < 0
  ) {
    return c.json({ error: "positions must be a non-negative number" }, 400);
  }
  const positions = Math.floor(body.positions);
  if (typeof body.pnl !== "number" || !Number.isFinite(body.pnl)) {
    return c.json({ error: "pnl must be a finite number" }, 400);
  }
  const pnl = body.pnl;

  return Effect.runPromise(
    Effect.gen(function* () {
      const handler = yield* agentStatusReportHandler(DB, CACHE, apiKey).pipe(
        Effect.catch(() => Effect.fail(new Error("Authentication failed"))),
      );
      yield* handler.storeStatus(body.status!, positions, pnl);
      return c.json({ ok: true });
    }).pipe(
      Effect.match({
        onFailure: (cause) => {
          const message = causeMessage(cause);
          return c.json({ error: message }, 401);
        },
        onSuccess: (response) => response,
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

  const withinLimit = await Effect.runPromise(
    rateLimitHit(DB, `rate_limit:feedback:${clientIp}`, 10),
  );
  if (!withinLimit) return c.json({ error: "Rate limit exceeded. Try again later." }, 429);

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
    return c.json(result);
  });

  return Effect.runPromise(
    issue.pipe(
      Effect.catch(() => Effect.succeed(c.json({ error: "Failed to store issue" }, 500))),
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
  // The id is client-supplied and used as the PK in the shared feedback table.
  // Namespace it with the authenticated user so a client can never collide
  // with (or overwrite) another user's row while keeping per-user idempotency.
  const feedbackId = `${user.id}:${body.id}`;
  const feedbackAgentId = body.agentId;
  const feedbackCategory = body.category;
  const feedbackSeverity = body.severity;
  const feedbackSummary = body.summary;
  const feedbackHash = body.hash;

  const withinLimit = await Effect.runPromise(
    rateLimitHit(DB, `rate_limit:feedback:${clientIp}`, 10),
  );
  if (!withinLimit) return c.json({ error: "Rate limit exceeded. Try again later." }, 429);

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

    return c.json(result);
  });

  return Effect.runPromise(
    feedback.pipe(
      Effect.catch(() => Effect.succeed(c.json({ error: "Failed to store feedback" }, 500))),
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
      Effect.catch(() => Effect.succeed(c.json({ error: "Failed to fetch feedback" }, 500))),
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
      Effect.catch(() => Effect.succeed(c.json({ error: "Failed to fetch audit events" }, 500))),
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
  const withinLimit = await Effect.runPromise(
    rateLimitHit(DB, `rate_limit:error_report:${clientIp}`, 100),
  );
  if (!withinLimit) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

  const report = normalizeErrorReport(body).pipe(
    Effect.flatMap((normalized) =>
      upsertErrorReports(DB, c.env.TELEMETRY_ARCHIVE, user.id, [normalized]).pipe(
        Effect.map((result) => c.json({ id: normalized.id, archived: result.archived > 0 })),
      ),
    ),
  );

  return Effect.runPromise(
    report.pipe(
      Effect.catch((cause) => {
        console.error("[Telemetry] Failed to store error report", causeMessage(cause));
        return Effect.succeed(
          cause instanceof TelemetryValidationError
            ? c.json({ error: cause.message }, 400)
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
  const withinLimit = await Effect.runPromise(
    rateLimitHit(DB, `rate_limit:error_batch:${clientIp}`, 50),
  );
  if (!withinLimit) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

  const batch = Effect.gen(function* () {
    const validReports: NormalizedErrorReport[] = [];
    const rejected: Array<{ id: string; error: string }> = [];
    for (const report of reports) {
      const outcome = yield* Effect.result(
        normalizeErrorReport(report, body.version).pipe(
          Effect.mapError(
            (error) =>
              new TelemetryValidationError(`${error.message} (${report.id ?? "missing id"})`),
          ),
        ),
      );
      if (outcome._tag === "Failure") {
        rejected.push({ id: report.id ?? "missing id", error: outcome.failure.message });
        continue;
      }
      validReports.push(outcome.success);
    }
    if (validReports.length === 0 && rejected.length > 0) {
      return c.json({ error: "No valid reports", rejected }, 400);
    }
    const result = yield* upsertErrorReports(DB, c.env.TELEMETRY_ARCHIVE, user.id, validReports);
    return c.json({ ...result, rejected });
  });

  return Effect.runPromise(
    batch.pipe(
      Effect.catch((cause) => {
        console.error("[Telemetry] Failed to store error batch", causeMessage(cause));
        return Effect.succeed(
          cause instanceof TelemetryValidationError
            ? c.json({ error: cause.message }, 400)
            : c.json({ error: "Failed to store error reports" }, 500),
        );
      }),
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
      `SELECT error_type, SUM(occurrence_count) as count, COUNT(*) as signatures,
               MIN(first_seen_at) as first_seen_at, MAX(last_seen_at) as last_seen_at
        FROM error_logs
        WHERE first_seen_at >= datetime('now', '-1 day')
        GROUP BY error_type
       ORDER BY count DESC`,
    ).all(),
  ).pipe(
    Effect.map((result) => c.json({ stats: result.results ?? [] })),
    Effect.catch(() => Effect.succeed(c.json({ error: "Failed to fetch stats" }, 500))),
  );

  return Effect.runPromise(stats);
});

// ── Proactive Telegram alerts (Wave 5) ──────────────────────────────────────
// Engine POSTs alert events with its API key. Every alert is persisted
// (delivered_at NULL). Delivery is handled by the telegram-bot worker POLLING
// D1 via its /internal/flush-alerts endpoint, triggered by an external GitHub
// Actions cron: Cloudflare rejects API->bot worker->worker fetches over the
// same workers.dev zone (error 1042) and the alchemy beta has no scheduled-
// trigger support for workers. The API only stores; the cron marks delivered_at.

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
  const withinLimit = await Effect.runPromise(
    rateLimitHit(DB, `rate_limit:alerts:${user.id}`, ALERT_RATE_LIMIT_PER_HOUR),
  );
  if (!withinLimit) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

  const alertType = body.type;
  const alertSeverity = body.severity;
  const alertMessage = body.message;

  const storeAlert = Effect.gen(function* () {
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

    // Delivery happens via the bot's /internal/flush-alerts poll (GitHub
    // Actions cron), not here: Cloudflare rejects API->bot worker->worker
    // fetches over the same workers.dev zone (error 1042). delivered:false
    // until the cron marks delivered_at.
    return c.json({ id, delivered: false });
  });

  return Effect.runPromise(
    storeAlert.pipe(
      Effect.catch(() => Effect.succeed(c.json({ error: "Failed to store alert" }, 500))),
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
    config.pipe(Effect.catch(() => Effect.succeed(c.json({ error: "Unauthorized" }, 401)))),
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
  const withinLimit = await Effect.runPromise(
    rateLimitHit(DB, `rate_limit:install_ping:${clientIp}`, 100),
  );
  if (!withinLimit) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
  }

  const id = generateId();
  const ping = Effect.tryPromise(() =>
    DB.prepare(
      `INSERT INTO install_event_summary
         (install_id, event, version, channel, platform, user_id, first_seen_at, last_seen_at, occurrence_count)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
       ON CONFLICT(install_id, event) DO UPDATE SET
         version = COALESCE(excluded.version, install_event_summary.version),
         channel = COALESCE(excluded.channel, install_event_summary.channel),
         platform = COALESCE(excluded.platform, install_event_summary.platform),
         user_id = COALESCE(excluded.user_id, install_event_summary.user_id),
         last_seen_at = CURRENT_TIMESTAMP,
         occurrence_count = install_event_summary.occurrence_count + 1`,
    )
      .bind(
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
    Effect.catch(() => Effect.succeed(c.json({ error: "Internal server error" }, 500))),
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
      Effect.catch(() => Effect.succeed(c.json({ error: "Failed to get referral code" }, 500))),
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
      Effect.catch(() => Effect.succeed(c.json({ error: "Failed to apply referral" }, 500))),
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
      Effect.catch(() => Effect.succeed(c.json({ error: "Failed to get referral stats" }, 500))),
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
      Effect.catch(() =>
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

  const authentication = await Effect.runPromise(loginHandler(DB, apiKey).pipe(Effect.result));
  if (authentication._tag === "Failure") {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const authenticatedUser = authentication.success as { id: string; tier?: string };
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

  const withinLimit = await Effect.runPromise(
    rateLimitHit(DB, `rate_limit:revenue_log:${clientIp}`, 200),
  );
  if (!withinLimit) {
    return c.json({ error: "Rate limit exceeded. Try again later." }, 429);
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
      Effect.catch(() =>
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
