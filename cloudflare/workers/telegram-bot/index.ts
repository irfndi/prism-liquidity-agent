import { Effect, Layer, Context } from "effect";
import { Hono } from "hono";

// Environment bindings interface
interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  API_BASE_URL: string;
}

// Services
class DbService extends Context.Tag("DbService")<DbService, { readonly db: D1Database }>() {}

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
    Effect.catchAll(() => Effect.succeed({} as T)),
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
    Effect.catchAll((error) =>
      Effect.sync(() => console.error("Telegram sendMessage failed", error)),
    ),
    Effect.asVoid,
  );
}

function callPrismApi(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Effect.Effect<{ ok: boolean; data?: unknown; error?: string }, never> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok) {
      return {
        ok: false,
        error: `Prism API error: ${response.status} ${response.statusText}`,
      };
    }
    const data = yield* Effect.tryPromise(() => response.json()).pipe(
      Effect.map((body) => body as { ok?: boolean; result?: unknown; error?: string }),
    );
    if (data.ok && data.result !== undefined) return { ok: true, data: data.result };
    return { ok: false, error: data.error ?? "Unknown error" };
  }).pipe(
    Effect.catchAll((error) =>
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
    `Welcome to Prism, ${firstName}!\n\n` +
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
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const result = yield* callPrismApi(apiBaseUrl, "/v1/register-telegram", {
      telegram_id: telegramId,
      first_name: firstName,
    });

    if (result.ok && result.data) {
      const data = result.data as { api_key: string; user_id: string };
      yield* sendMessage(
        botToken,
        chatId,
        `Registration successful!\n\n` +
          `User ID: <code>${data.user_id}</code>\n` +
          `API Key: <code>${data.api_key}</code>\n\n` +
          `Save your API key securely. Use it with:\n` +
          `<code>prism login ${data.api_key.slice(0, 8)}...</code>`,
      );
    } else {
      yield* sendMessage(
        botToken,
        chatId,
        `Registration failed: ${result.error ?? "Unknown error"}`,
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
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const result = yield* callPrismApi(apiBaseUrl, "/v1/whoami-telegram", {
      telegram_id: telegramId,
    });

    if (result.ok && result.data) {
      const data = result.data as { user_id: string; tier: string };
      yield* sendMessage(
        botToken,
        chatId,
        `Account Info:\n\n` + `User ID: <code>${data.user_id}</code>\n` + `Tier: ${data.tier}`,
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
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const result = yield* callPrismApi(apiBaseUrl, "/v1/agent-status", {
      telegram_id: telegramId,
    });

    if (result.ok && result.data) {
      const data = result.data as { status: string; positions: number; pnl: number };
      yield* sendMessage(
        botToken,
        chatId,
        `Agent Status:\n\n` +
          `Status: ${data.status}\n` +
          `Active Positions: ${data.positions}\n` +
          `P&L: $${data.pnl.toFixed(2)}`,
      );
    } else {
      yield* sendMessage(botToken, chatId, `Agent not running or not linked.`);
    }
  });
}

// Process incoming Telegram update
function processUpdate(
  db: D1Database,
  env: Env,
  update: TelegramUpdate,
): Effect.Effect<void, never> {
  if (!update.message) return Effect.void;

  const message = update.message;
  const chatId = message.chat.id;
  const text = message.text ?? "";
  const telegramId = String(message.from.id);
  const firstName = message.from.first_name;

  // Handle commands. Telegram appends "@botusername" in group chats (e.g. "/start@prism_agent_bot").
  return Effect.gen(function* () {
    if (text.startsWith("/")) {
      const rawCommand = text.split(" ")[0] ?? "";
      const command = rawCommand.split("@")[0]?.toLowerCase() ?? "";

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
          );
          break;
        case "/link":
          yield* handleLink(env.TELEGRAM_BOT_TOKEN, chatId);
          break;
        case "/help":
          yield* handleHelp(env.TELEGRAM_BOT_TOKEN, chatId);
          break;
        case "/whoami":
          yield* handleWhoami(env.API_BASE_URL, env.TELEGRAM_BOT_TOKEN, chatId, telegramId);
          break;
        case "/status":
          yield* handleStatus(env.API_BASE_URL, env.TELEGRAM_BOT_TOKEN, chatId, telegramId);
          break;
        default:
          yield* sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Unknown command. Try /help");
      }
    } else if (/^LINK-[A-Z0-9]{6}$/i.test(text.trim()) || /^[A-Z0-9]{6}$/i.test(text.trim())) {
      const rawCode = text.trim().toUpperCase();
      const code = rawCode.startsWith("LINK-") ? rawCode : `LINK-${rawCode}`;
      const result = yield* callPrismApi(env.API_BASE_URL, "/v1/link-telegram/confirm", {
        code,
        telegram_id: telegramId,
      });

      if (result.ok) {
        yield* sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Account linked successfully!");
      } else {
        yield* sendMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `Link failed: ${result.error ?? "Invalid or expired code"}`,
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
  // Optional: verify webhook secret
  if (c.env.TELEGRAM_WEBHOOK_SECRET) {
    const headerSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (headerSecret !== c.env.TELEGRAM_WEBHOOK_SECRET) {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  return await Effect.runPromise(
    Effect.gen(function* () {
      const update = yield* readJsonBody<TelegramUpdate>(c.req);
      yield* processUpdate(c.env.DB, c.env, update);
      return c.json({ ok: true });
    }),
  );
});

export default {
  fetch: app.fetch,
};
