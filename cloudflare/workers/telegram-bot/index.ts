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
class DbService extends Context.Tag("DbService")<
  DbService,
  { readonly db: D1Database }
>() {}

const DbLive = (db: D1Database) =>
  Layer.succeed(DbService, { db });

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

// Helper to send Telegram message
async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    console.error(
      `Telegram sendMessage failed: ${response.status} ${response.statusText}`,
      errorBody,
    );
  }
}

// Helper to call Prism API
async function callPrismApi(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `Prism API error: ${response.status} ${response.statusText}`,
      };
    }
    const data = (await response.json()) as { ok?: boolean; result?: unknown; error?: string };
    if (data.ok && data.result !== undefined) {
      return { ok: true, data: data.result };
    }
    return { ok: false, error: data.error ?? "Unknown error" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// Handle /start command
async function handleStart(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: string,
  firstName: string,
): Promise<void> {
  await sendMessage(
    botToken,
    chatId,
    `Welcome to Prism, ${firstName}!\n\n` +
      `To get started, register with:\n` +
      `<code>prism register</code>\n\n` +
      `Or link your existing account with /link`,
  );
}

// Handle /link command
async function handleLink(
  botToken: string,
  chatId: number,
): Promise<void> {
  await sendMessage(
    botToken,
    chatId,
    `To link your Telegram account:\n\n` +
      `1. Run <code>prism link-telegram</code> on your machine\n` +
      `2. Send the 6-character code here\n\n` +
      `The code expires in 10 minutes.`,
  );
}

// Handle /register command
async function handleRegister(
  apiBaseUrl: string,
  botToken: string,
  chatId: number,
  telegramId: string,
  firstName: string,
): Promise<void> {
  const result = await callPrismApi(apiBaseUrl, "/v1/register-telegram", {
    telegram_id: telegramId,
    first_name: firstName,
  });

  if (result.ok && result.data) {
    const data = result.data as { api_key: string; user_id: string };
    await sendMessage(
      botToken,
      chatId,
      `Registration successful!\n\n` +
        `User ID: <code>${data.user_id}</code>\n` +
        `API Key: <code>${data.api_key}</code>\n\n` +
        `Save your API key securely. Use it with:\n` +
        `<code>prism login ${data.api_key.slice(0, 8)}...</code>`,
    );
  } else {
    await sendMessage(
      botToken,
      chatId,
      `Registration failed: ${result.error ?? "Unknown error"}`,
    );
  }
}

// Handle /help command
async function handleHelp(botToken: string, chatId: number): Promise<void> {
  await sendMessage(
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
async function handleWhoami(
  apiBaseUrl: string,
  botToken: string,
  chatId: number,
  telegramId: string,
): Promise<void> {
  const result = await callPrismApi(apiBaseUrl, "/v1/whoami", {
    telegram_id: telegramId,
  });

  if (result.ok && result.data) {
    const data = result.data as { user_id: string; tier: string };
    await sendMessage(
      botToken,
      chatId,
      `Account Info:\n\n` +
        `User ID: <code>${data.user_id}</code>\n` +
        `Tier: ${data.tier}`,
    );
  } else {
    await sendMessage(
      botToken,
      chatId,
      `Not registered. Use /register to create an account.`,
    );
  }
}

// Handle /status command
async function handleStatus(
  apiBaseUrl: string,
  botToken: string,
  chatId: number,
  telegramId: string,
): Promise<void> {
  const result = await callPrismApi(apiBaseUrl, "/v1/agent-status", {
    telegram_id: telegramId,
  });

  if (result.ok && result.data) {
    const data = result.data as { status: string; positions: number; pnl: number };
    await sendMessage(
      botToken,
      chatId,
      `Agent Status:\n\n` +
        `Status: ${data.status}\n` +
        `Active Positions: ${data.positions}\n` +
        `P&L: $${data.pnl.toFixed(2)}`,
    );
  } else {
    await sendMessage(
      botToken,
      chatId,
      `Agent not running or not linked.`,
    );
  }
}

// Process incoming Telegram update
async function processUpdate(
  db: D1Database,
  env: Env,
  update: TelegramUpdate,
): Promise<void> {
  if (!update.message) return;

  const message = update.message;
  const chatId = message.chat.id;
  const text = message.text ?? "";
  const telegramId = String(message.from.id);
  const firstName = message.from.first_name;

  // Handle commands
  if (text.startsWith("/")) {
    const command = text.split(" ")[0]?.toLowerCase() ?? "";

    switch (command) {
      case "/start":
        await handleStart(db, env.TELEGRAM_BOT_TOKEN, chatId, telegramId, firstName);
        break;
      case "/register":
        await handleRegister(env.API_BASE_URL, env.TELEGRAM_BOT_TOKEN, chatId, telegramId, firstName);
        break;
      case "/link":
        await handleLink(env.TELEGRAM_BOT_TOKEN, chatId);
        break;
      case "/help":
        await handleHelp(env.TELEGRAM_BOT_TOKEN, chatId);
        break;
      case "/whoami":
        await handleWhoami(env.API_BASE_URL, env.TELEGRAM_BOT_TOKEN, chatId, telegramId);
        break;
      case "/status":
        await handleStatus(env.API_BASE_URL, env.TELEGRAM_BOT_TOKEN, chatId, telegramId);
        break;
      default:
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Unknown command. Try /help");
    }
  } else if (/^[A-Z0-9]{6}$/i.test(text.trim())) {
    // Handle 6-character link code
    const code = text.trim().toUpperCase();
    const result = await callPrismApi(env.API_BASE_URL, "/v1/link-telegram/confirm", {
      code,
      telegram_id: telegramId,
    });

    if (result.ok) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Account linked successfully!");
    } else {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Link failed: ${result.error ?? "Invalid or expired code"}`);
    }
  }
}

// Health check
const healthHandler = () =>
  Effect.succeed({ status: "ok", timestamp: new Date().toISOString() });

// Main app
const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const result = await Effect.runPromise(
    healthHandler().pipe(Effect.provide(DbLive(c.env.DB))),
  );
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

  const update = (await c.req.json()) as TelegramUpdate;
  await processUpdate(c.env.DB, c.env, update);
  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,
};
