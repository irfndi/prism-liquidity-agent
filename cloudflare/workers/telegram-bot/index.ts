import { Effect, Layer, Context } from "effect";
import { Hono } from "hono";

// Environment bindings interface
interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  API_BASE_URL: string;
  // Service binding to the API worker (preferred path for bot->API calls).
  // Cloudflare forbids worker->worker fetches over the same-zone
  // workers.dev hostname (error 1042); the binding is the sanctioned
  // transport. Absent in local dev/older deploys -> hostname fallback.
  API_SERVICE?: Fetcher;
  // Shared secret presented as X-Bot-Api-Secret on bot->API calls. The API
  // rejects telegram_id-keyed endpoints without it (fail closed).
  BOT_API_SECRET?: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  // Constant-length comparison: the loop count depends only on the longer string,
  // never on where the strings differ, so timing does not leak the secret.
  const maxLen = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= ca ^ cb;
  }
  return mismatch === 0;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Services
class DbService extends Context.Service<DbService, { readonly db: D1Database }>()("DbService") {}

const DbLive = (db: D1Database) => Layer.succeed(DbService, { db });

// Types
interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: "private" | "group" | "supergroup" | "channel";
    };
    text?: string;
    date: number;
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
      first_name: string;
      username?: string;
    };
    data: string;
  };
}

function readJsonBody<T>(request: { json: () => Promise<unknown> }): Effect.Effect<T, never> {
  return Effect.tryPromise(() => request.json()).pipe(
    Effect.map((body) => body as T),
    Effect.catch(() => Effect.succeed({} as T)),
  );
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (typeof value !== "object" || value === null) return false;
  const message = (value as { message?: unknown }).message;
  if (message === undefined) return true;
  if (typeof message !== "object" || message === null) return false;
  const candidate = message as {
    chat?: { id?: unknown };
    from?: { id?: unknown; first_name?: unknown };
  };
  return (
    typeof candidate.chat?.id === "number" &&
    typeof candidate.from?.id === "number" &&
    typeof candidate.from?.first_name === "string"
  );
}

function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Effect.Effect<void, never> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      }),
    );
    if (!response.ok) {
      const errorBody = yield* Effect.tryPromise(() => response.text());
      yield* Effect.sync(() =>
        console.error(
          `Telegram sendMessage failed: ${response.status} ${response.statusText}`,
          errorBody,
        ),
      );
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => console.error("Telegram sendMessage failed", error)),
    ),
    Effect.asVoid,
  );
}

function callPrismApi(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  botApiSecret?: string,
  fetcher?: Fetcher,
): Effect.Effect<{ ok: boolean; data?: unknown; error?: string }, never> {
  return Effect.gen(function* () {
    const init = {
      method: "POST" as const,
      headers: {
        "Content-Type": "application/json",
        ...(botApiSecret ? { "X-Bot-Api-Secret": botApiSecret } : {}),
      },
      body: JSON.stringify(body),
    };
    // The service binding is the only worker->worker transport Cloudflare
    // allows: same-zone workers.dev hostname fetches are rejected with
    // error 1042 (proven live via the bot's own subrequest). The hostname
    // fallback exists only for local dev / deploys that predate the binding.
    const response = yield* Effect.tryPromise(() =>
      fetcher
        ? fetcher.fetch(new Request(`${baseUrl}${path}`, init))
        : fetch(`${baseUrl}${path}`, init),
    );
    if (!response.ok) {
      // Prefer the API's own error message ("Code expired", "Too many
      // attempts") over the bare status line ("404 Not Found" / "500
      // Internal Server Error"), which tells the user nothing actionable.
      const statusText = `${response.status} ${response.statusText}`;
      const apiError = yield* Effect.tryPromise(() => response.text()).pipe(
        Effect.map((text) => {
          try {
            const parsed = JSON.parse(text) as { error?: unknown };
            return typeof parsed.error === "string" ? parsed.error : null;
          } catch {
            return null;
          }
        }),
        Effect.orElseSucceed(() => null),
      );
      return {
        ok: false,
        error: `Prism API error: ${apiError ?? statusText}`,
      };
    }
    const data = yield* Effect.tryPromise(() => response.json()).pipe(
      Effect.map((body) => body as Record<string, unknown>),
    );
    return { ok: true, data };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    ),
  );
}

// Handle /start command
function handleStart(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: string,
  firstName: string,
): Effect.Effect<void, never> {
  return sendMessage(
    botToken,
    chatId,
    `Welcome to Prism, ${escapeHtml(firstName)}!\n\n` +
      `To get started, register with:\n` +
      `<code>prism register</code>\n\n` +
      `Or link your existing account with /link`,
  );
}

// Handle /link command
function handleLink(botToken: string, chatId: number): Effect.Effect<void, never> {
  return sendMessage(
    botToken,
    chatId,
    `To link your Telegram account:\n\n` +
      `1. Run <code>prism link-telegram</code> on your machine\n` +
      `2. Send the 6-character code here\n\n` +
      `The code expires in 10 minutes.`,
  );
}

// Handle /register command
function handleRegister(
  apiBaseUrl: string,
  botToken: string,
  chatId: number,
  telegramId: string,
  firstName: string,
  botApiSecret?: string,
  fetcher?: Fetcher,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const result = yield* callPrismApi(
      apiBaseUrl,
      "/v1/register-telegram",
      {
        telegram_id: telegramId,
        first_name: firstName,
      },
      botApiSecret,
      fetcher,
    );

    if (result.ok && result.data) {
      const data = result.data as { api_key: string; user_id: string };
      yield* sendMessage(
        botToken,
        chatId,
        `Registration successful!\n\n` +
          `User ID: <code>${escapeHtml(data.user_id)}</code>\n` +
          `API Key: <code>${escapeHtml(data.api_key)}</code>\n\n` +
          `Save your API key securely. Use it with:\n` +
          `<code>prism login ${escapeHtml(data.api_key.slice(0, 8))}...</code>`,
      );
    } else {
      yield* sendMessage(
        botToken,
        chatId,
        `Registration failed: ${escapeHtml(result.error ?? "Unknown error")}`,
      );
    }
  });
}

function handleHelp(botToken: string, chatId: number): Effect.Effect<void, never> {
  return sendMessage(
    botToken,
    chatId,
    `Prism Bot Commands:\n\n` +
      `/start - Welcome message\n` +
      `/register - Create a new Prism account\n` +
      `/link - Link existing account\n` +
      `/whoami - Show your account info\n` +
      `/status - Check agent status\n` +
      `/alerts on|off - Toggle proactive alerts\n` +
      `/help - Show this help\n\n` +
      `For more info: https://github.com/irfndi/prism-liquidity-agent`,
  );
}

// Handle /whoami command
function handleWhoami(
  apiBaseUrl: string,
  botToken: string,
  chatId: number,
  telegramId: string,
  botApiSecret?: string,
  fetcher?: Fetcher,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const result = yield* callPrismApi(
      apiBaseUrl,
      "/v1/whoami-telegram",
      {
        telegram_id: telegramId,
      },
      botApiSecret,
      fetcher,
    );

    if (result.ok && result.data) {
      const data = result.data as { user_id: string; tier: string };
      yield* sendMessage(
        botToken,
        chatId,
        `Account Info:\n\n` +
          `User ID: <code>${escapeHtml(data.user_id)}</code>\n` +
          `Tier: ${escapeHtml(data.tier)}`,
      );
    } else {
      yield* sendMessage(botToken, chatId, `Not registered. Use /register to create an account.`);
    }
  });
}

function handleStatus(
  apiBaseUrl: string,
  botToken: string,
  chatId: number,
  telegramId: string,
  botApiSecret?: string,
  fetcher?: Fetcher,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const result = yield* callPrismApi(
      apiBaseUrl,
      "/v1/agent-status",
      {
        telegram_id: telegramId,
      },
      botApiSecret,
      fetcher,
    );

    if (result.ok && result.data) {
      const data = result.data as { status: string; positions: number; pnl: number };
      yield* sendMessage(
        botToken,
        chatId,
        `Agent Status:\n\n` +
          `Status: ${escapeHtml(data.status)}\n` +
          `Active Positions: ${data.positions}\n` +
          `P&L: $${escapeHtml(data.pnl.toFixed(2))}`,
      );
    } else {
      yield* sendMessage(botToken, chatId, `Agent not running or not linked.`);
    }
  });
}

// Handle `/alerts on|off` — toggles proactive alert delivery for the linked account.
function handleAlerts(
  apiBaseUrl: string,
  botToken: string,
  chatId: number,
  telegramId: string,
  args: string,
  botApiSecret?: string,
  fetcher?: Fetcher,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const arg = args.trim().toLowerCase();
    if (arg !== "on" && arg !== "off") {
      yield* sendMessage(
        botToken,
        chatId,
        `Usage: <code>/alerts on</code> or <code>/alerts off</code>\n\n` +
          `When enabled, Prism pushes position alerts (out-of-range, exits, risk rejections, fee milestones) to this chat.`,
      );
      return;
    }
    const enabled = arg === "on";
    const result = yield* callPrismApi(
      apiBaseUrl,
      "/v1/alerts/preferences",
      { telegram_id: telegramId, enabled },
      botApiSecret,
      fetcher,
    );
    if (result.ok) {
      yield* sendMessage(
        botToken,
        chatId,
        enabled
          ? `Alerts enabled. Prism will notify you here about position events.`
          : `Alerts disabled. Alerts are still logged but will not be pushed here.`,
      );
    } else {
      yield* sendMessage(
        botToken,
        chatId,
        `Could not update alert preferences: ${escapeHtml(result.error ?? "unknown error")}. ` +
          `Make sure your account is linked with /link.`,
      );
    }
  });
}

// Commands that return credentials or account data are private-chat only —
// in groups the reply (and any API key) would be visible to every member.
const PRIVATE_ONLY_COMMANDS = new Set(["/register", "/whoami", "/status", "/link", "/alerts"]);

// Process incoming Telegram update
function processUpdate(
  db: D1Database,
  env: Env,
  update: TelegramUpdate,
): Effect.Effect<void, never> {
  if (!isTelegramUpdate(update) || !update.message) return Effect.void;

  const message = update.message;
  const chatId = message.chat.id;
  const isPrivateChat = message.chat.type === "private";
  const text = message.text ?? "";
  const telegramId = String(message.from.id);
  const firstName = message.from.first_name;

  // Handle commands. Telegram appends "@botusername" in group chats (e.g. "/start@prism_agent_bot").
  return Effect.gen(function* () {
    if (text.startsWith("/")) {
      const rawCommand = text.split(" ")[0] ?? "";
      const command = rawCommand.split("@")[0]?.toLowerCase() ?? "";

      if (!isPrivateChat && PRIVATE_ONLY_COMMANDS.has(command)) {
        yield* sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `For your security, ${command} is only available in a private chat with this bot. ` +
            `Please open a direct message and try again.`,
        );
        return;
      }

      switch (command) {
        case "/start":
          yield* handleStart(db, env.TELEGRAM_BOT_TOKEN, chatId, telegramId, firstName);
          break;
        case "/register":
          yield* handleRegister(
            env.API_BASE_URL,
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            telegramId,
            firstName,
            env.BOT_API_SECRET,
            env.API_SERVICE,
          );
          break;
        case "/link":
          yield* handleLink(env.TELEGRAM_BOT_TOKEN, chatId);
          break;
        case "/help":
          yield* handleHelp(env.TELEGRAM_BOT_TOKEN, chatId);
          break;
        case "/whoami":
          yield* handleWhoami(
            env.API_BASE_URL,
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            telegramId,
            env.BOT_API_SECRET,
            env.API_SERVICE,
          );
          break;
        case "/status":
          yield* handleStatus(
            env.API_BASE_URL,
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            telegramId,
            env.BOT_API_SECRET,
            env.API_SERVICE,
          );
          break;
        case "/alerts":
          yield* handleAlerts(
            env.API_BASE_URL,
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            telegramId,
            text.slice(rawCommand.length),
            env.BOT_API_SECRET,
            env.API_SERVICE,
          );
          break;
        default:
          yield* sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Unknown command. Try /help");
      }
    } else if (
      /^LINK-[A-Z0-9]{6,16}$/i.test(text.trim()) ||
      /^[A-Z0-9]{6,16}$/i.test(text.trim())
    ) {
      if (!isPrivateChat) {
        // A link code is a credential: confirming in a group would let any
        // member hijack the link first.
        yield* sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `Link codes must be sent in a private chat with this bot for your security.`,
        );
        return;
      }
      const rawCode = text.trim().toUpperCase();
      const code = rawCode.startsWith("LINK-") ? rawCode : `LINK-${rawCode}`;
      const result = yield* callPrismApi(
        env.API_BASE_URL,
        "/v1/link-telegram/confirm",
        {
          code,
          telegram_id: telegramId,
        },
        env.BOT_API_SECRET,
        env.API_SERVICE,
      );

      if (result.ok) {
        yield* sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Account linked successfully!");
      } else {
        yield* sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `Link failed: ${escapeHtml(result.error ?? "Invalid or expired code")}`,
        );
      }
    }
  });
}

// Health check
const healthHandler = () => Effect.succeed({ status: "ok", timestamp: new Date().toISOString() });

// Main app
const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const result = await Effect.runPromise(healthHandler().pipe(Effect.provide(DbLive(c.env.DB))));
  return c.json(result);
});

app.post("/webhook", async (c) => {
  // Fail closed: an unset TELEGRAM_WEBHOOK_SECRET rejects every webhook POST.
  const webhookSecret = c.env.TELEGRAM_WEBHOOK_SECRET;
  const headerSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  if (!webhookSecret || !headerSecret || !constantTimeEqual(headerSecret, webhookSecret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return await Effect.runPromise(
    Effect.gen(function* () {
      const update = yield* readJsonBody<TelegramUpdate>(c.req);
      yield* processUpdate(c.env.DB, c.env, update).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => console.error("processUpdate failed", cause)),
        ),
      );
      return c.json({ ok: true });
    }),
  );
});

// ── Internal alert delivery (API worker → bot → Telegram) ───────────────────
// Authenticated with the same BOT_API_SECRET shared secret (fail closed), so
// only the API worker can push. All engine/pool-controlled text is escaped
// before going into a parse_mode: HTML message.

const ALERT_SEVERITY_EMOJI: Record<string, string> = {
  critical: "\u{1F6A8}",
  warning: "⚠️",
  info: "ℹ️",
};

const ALERT_TYPE_LABEL: Record<string, string> = {
  position_out_of_range: "Position out of range",
  range_warning: "Range warning",
  exit_executed: "EXIT executed",
  risk_rejection: "Risk gate rejection",
  fee_milestone: "Fee milestone",
  stablecoin_depeg: "Stablecoin Depeg",
  liquidity_drain: "Liquidity Drain",
  il_dominance: "IL Dominance",
};

const ALERT_DELIVER_SEVERITIES = new Set(["info", "warning", "critical"]);
const MAX_DELIVER_MESSAGE_LENGTH = 1000;

interface DeliverAlertBody {
  alert_id?: unknown;
  telegram_id?: unknown;
  type?: unknown;
  severity?: unknown;
  message?: unknown;
  pool_address?: unknown;
  data?: unknown;
}

function shortenAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

// Shared alert formatting for BOTH the push endpoint (/internal/deliver-alert)
// and the poll endpoint (/internal/flush-alerts): severity emoji + bold type
// label + optional shortened pool address + message, all escapeHtml'd before
// being interpolated into a parse_mode: HTML message.
function formatAlertLines(
  type: unknown,
  severity: string,
  message: string,
  poolAddress: string | null,
): string[] {
  const typeLabel = typeof type === "string" ? (ALERT_TYPE_LABEL[type] ?? "Alert") : "Alert";
  const emoji = ALERT_SEVERITY_EMOJI[severity] ?? ALERT_SEVERITY_EMOJI.info;
  const lines = [`${emoji} <b>${escapeHtml(typeLabel)}</b>`];
  if (poolAddress) {
    lines.push(`Pool: <code>${escapeHtml(shortenAddress(poolAddress))}</code>`);
  }
  lines.push(escapeHtml(message));
  return lines;
}

function deliverTelegramMessage(
  botToken: string,
  chatId: number,
  text: string,
): Effect.Effect<boolean, never> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      }),
    );
    if (!response.ok) {
      yield* Effect.tryPromise(() => response.text()).pipe(
        Effect.flatMap((errorBody) =>
          Effect.sync(() => console.error(`Alert delivery failed: ${response.status}`, errorBody)),
        ),
        Effect.catch(() => Effect.void),
      );
      return false;
    }
    return true;
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => console.error("Alert delivery failed", error)).pipe(Effect.as(false)),
    ),
  );
}

app.post("/internal/deliver-alert", async (c) => {
  // Fail closed, mirroring the webhook secret check: unset secret rejects all.
  const botSecret = c.env.BOT_API_SECRET;
  const headerSecret = c.req.header("X-Bot-Api-Secret");
  if (!botSecret || !headerSecret || !constantTimeEqual(headerSecret, botSecret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await Effect.runPromise(readJsonBody<DeliverAlertBody>(c.req));

  if (typeof body.telegram_id !== "string" || !/^\d+$/.test(body.telegram_id)) {
    return c.json({ error: "telegram_id required (numeric string)" }, 400);
  }
  if (typeof body.severity !== "string" || !ALERT_DELIVER_SEVERITIES.has(body.severity)) {
    return c.json({ error: "severity must be one of: info, warning, critical" }, 400);
  }
  if (typeof body.message !== "string" || body.message.length === 0) {
    return c.json({ error: "message is required" }, 400);
  }
  if (body.message.length > MAX_DELIVER_MESSAGE_LENGTH) {
    return c.json({ error: `message exceeds ${MAX_DELIVER_MESSAGE_LENGTH} characters` }, 400);
  }
  const poolAddress =
    typeof body.pool_address === "string" && body.pool_address.length > 0
      ? body.pool_address.slice(0, 64)
      : null;
  const lines = formatAlertLines(body.type, body.severity, body.message, poolAddress);

  const delivered = await Effect.runPromise(
    deliverTelegramMessage(c.env.TELEGRAM_BOT_TOKEN, Number(body.telegram_id), lines.join("\n")),
  );
  return delivered
    ? c.json({ ok: true, delivered: true })
    : c.json({ error: "Telegram delivery failed" }, 502);
});

// ── Internal alert delivery poll (D1 → bot → Telegram) ──────────────────────
// Cloudflare rejects worker->worker fetches over the same workers.dev zone with
// error 1042, so the API worker can no longer push alerts here. Instead the bot
// POLLS D1 for undelivered rows; an external GitHub Actions cron (no worker
// scheduled-trigger support on the alchemy beta) triggers this endpoint on a
// fixed cadence. Same BOT_API_SECRET gate as /internal/deliver-alert (fail
// closed). A row at FLUSH_ABANDON_ATTEMPTS is dropped from future flushes so a
// permanently undeliverable alert is never retried forever. One bad row must
// not abort the batch: every row runs under Effect.catch and is counted.

const FLUSH_BATCH_LIMIT = 10;
const FLUSH_ABANDON_ATTEMPTS = 5;
// A claim older than this (ms) is considered interrupted (the flush that made
// it crashed) and is reclaimed as pending on the next flush. Flushes run on a
// 5-minute cron and a single flush takes seconds, so 5 minutes is a wide,
// safe window: it never reclaims a genuinely in-flight claim.
const CLAIM_RECLAIM_MS = 5 * 60 * 1000;

app.post("/internal/flush-alerts", async (c) => {
  const botSecret = c.env.BOT_API_SECRET;
  const headerSecret = c.req.header("X-Bot-Api-Secret");
  if (!botSecret || !headerSecret || !constantTimeEqual(headerSecret, botSecret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      // Reclaim stale claims first: a flush that crashed after its claim
      // UPDATE would otherwise leave rows stuck at delivered_at = 'claim:...'
      // forever (later flushes only select delivered_at IS NULL). The claim
      // token embeds the claim time, so any claim older than the reclaim
      // window is treated as interrupted and pushed back to pending with an
      // extra delivery_attempt (so repeated claim-crash cycles eventually hit
      // the abandoned threshold).
      yield* Effect.tryPromise(() =>
        c.env.DB.prepare(
          `UPDATE alerts
           SET delivered_at = NULL, delivery_attempts = delivery_attempts + 1
           WHERE delivered_at LIKE 'claim:%'
             AND CAST(substr(delivered_at, 7) AS INTEGER) < ?`,
        )
          .bind(Date.now() - CLAIM_RECLAIM_MS)
          .all(),
      );

      // Atomic claim: a single UPDATE marks the batch as claimed by storing a
      // unique claim token in delivered_at, so two concurrent flushes cannot
      // both select (and therefore both deliver) the same rows. The pending
      // and abandoned queries both filter on delivered_at IS NULL, so in-flight
      // claims are invisible to every other flush. A row is released back to
      // pending (delivered_at = NULL) on delivery failure.
      const claimToken = `claim:${Date.now()}:${crypto.randomUUID()}`;
      yield* Effect.tryPromise(() =>
        c.env.DB.prepare(
          `UPDATE alerts
           SET delivered_at = ?
           WHERE id IN (
             SELECT a.id
             FROM alerts a
             JOIN users u ON a.user_id = u.id
             WHERE a.delivered_at IS NULL
               AND a.delivery_attempts < ?
               AND u.telegram_id IS NOT NULL
               AND u.alerts_enabled != 0
             ORDER BY a.created_at ASC
             LIMIT ?
           )`,
        )
          .bind(claimToken, FLUSH_ABANDON_ATTEMPTS, FLUSH_BATCH_LIMIT)
          .all(),
      );

      // Resolve the claimed rows' telegram targets. The claim token is unique
      // to this flush, so only rows this flush owns are returned.
      const rows = yield* Effect.tryPromise(() =>
        c.env.DB.prepare(
          `SELECT a.id, a.type, a.severity, a.message, a.pool_address, u.telegram_id
           FROM alerts a
           JOIN users u ON a.user_id = u.id
           WHERE a.delivered_at = ?`,
        )
          .bind(claimToken)
          .all(),
      );

      let checked = 0;
      let delivered = 0;
      let failed = 0;

      for (const raw of rows.results) {
        const id = typeof raw.id === "string" ? raw.id : null;
        const severity = typeof raw.severity === "string" ? raw.severity : "info";
        const message = typeof raw.message === "string" ? raw.message : "";
        const poolAddress =
          typeof raw.pool_address === "string" && raw.pool_address.length > 0
            ? raw.pool_address
            : null;
        const telegramId =
          typeof raw.telegram_id === "string" && /^\d+$/.test(raw.telegram_id)
            ? raw.telegram_id
            : null;

        checked += 1;
        const outcome = yield* Effect.gen(function* () {
          if (id === null || telegramId === null) return "failed" as const;
          const lines = formatAlertLines(raw.type, severity, message, poolAddress);
          const ok = yield* deliverTelegramMessage(
            c.env.TELEGRAM_BOT_TOKEN,
            Number(telegramId),
            lines.join("\n"),
          );
          if (ok) {
            yield* Effect.tryPromise(() =>
              c.env.DB.prepare("UPDATE alerts SET delivered_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(id)
                .run(),
            );
            return "delivered" as const;
          }
          // Release the claim so the row is retried on a later flush.
          yield* Effect.tryPromise(() =>
            c.env.DB.prepare(
              "UPDATE alerts SET delivered_at = NULL, delivery_attempts = delivery_attempts + 1 WHERE id = ?",
            )
              .bind(id)
              .run(),
          );
          return "failed" as const;
        }).pipe(Effect.catch(() => Effect.succeed("failed" as const)));

        if (outcome === "delivered") {
          delivered += 1;
        } else {
          failed += 1;
        }
      }

      const abandonedRow = (yield* Effect.tryPromise(() =>
        c.env.DB.prepare(
          `SELECT COUNT(*) as n
           FROM alerts a
           JOIN users u ON a.user_id = u.id
           WHERE a.delivered_at IS NULL
             AND a.delivery_attempts >= ?
             AND u.telegram_id IS NOT NULL
             AND u.alerts_enabled != 0`,
        )
          .bind(FLUSH_ABANDON_ATTEMPTS)
          .first(),
      )) as { n?: unknown } | null;
      const abandoned = abandonedRow && typeof abandonedRow.n === "number" ? abandonedRow.n : 0;

      return { ok: true, checked, delivered, failed, abandoned };
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => console.error("Alert flush failed", error)).pipe(
          Effect.as({ ok: false, checked: 0, delivered: 0, failed: 0, abandoned: 0 }),
        ),
      ),
    ),
  );

  return c.json(result);
});

export default {
  fetch: app.fetch,
};
