# prism-dlmm

## What this codebase does

Autonomous Solana DLMM liquidity agent (Meteora). Scans pools on interval, makes ENTER/EXIT/REBALANCE/HOLD decisions via rule-based strategy + risk gates, executes paper or live on-chain trades. Stack: Bun + TypeScript strict + Effect-TS services + @meteora-ag/dlmm SDK + Helius RPC. Cloudflare Workers (Hono) for user accounts, API keys, Telegram bot alerts. SQLite + sqlite-vec for local persistence.

## Auth shape

- `readPrismApiKey()` — reads API key from `~/.config/prism/credentials.json` (0o600 perms), used for all cloud API auth
- `isBotAuthorized(env, header)` — constant-time shared-secret check (`BOT_API_SECRET`) between API and Telegram bot workers
- `constantTimeEqual(a, b)` — XOR-based constant-time string comparison (api + bot workers)
- `TELEGRAM_WEBHOOK_SECRET` — fail-closed webhook validation on bot worker; rejects all POSTs when unset
- `WALLET_PRIVATE_KEY` — optional Solana keypair for live trading; adapter `hasWallet()` gates all live execution

## Threat model

1. **Wallet key theft** — `WALLET_PRIVATE_KEY` in .env or memory; controls real SOL/tokens. Highest impact.
2. **API key compromise** — `credentials.json` API key grants access to user account, feedback, error reporting, alerts.
3. **Unauthorized Telegram binding** — squatting a user's telegram_id to receive their alerts/credentials.
4. **Malicious pool interaction** — entering a rug/scam pool that drains LP position via freeze authority or blacklist.
5. **Rate-limit bypass on cloud API** — brute-forcing link codes or spamming endpoints via corrupt KV values.

## Project-specific patterns to flag

- **Effect-TS error swallowing**: `Effect.catchAll(() => Effect.void)` is used intentionally for fail-open telemetry/alerts but must NEVER wrap live-execution paths. Flag any `.catchAll(() => void)` near `sendRawTransaction`, `sign()`, or `savePosition`.
- **BigInt precision**: SDK returns `BN` values. `Number(bn.toString())` silently loses precision above `Number.MAX_SAFE_INTEGER`. Must use `stringifySafe` from `engine/bigint-json.ts`.
- **Blockhash freshness**: Every live tx path must call `getLatestBlockhash()` and set `tx.feePayer` + `tx.recentBlockhash` before `tx.sign()`. Pattern established in adapter-service.ts.
- **Depeg detection guard**: `depeg-liquidity-detector.ts` only evaluates stable/stable pairs — `pool.currentPrice` is a pair exchange rate, not a USD oracle. Volatile/stable pairs would false-positive without the `stablecoinMints.length === 2` guard.
- **Config validation**: `validatedNumber` clamps + warns. `ENTRY_RANGE_HALF_WIDTH_BINS` uses `Math.floor()`. Booleans use `Effect.orElseSucceed` (not `Config.withDefault`) to handle invalid values.

## Known false-positives

- `engine/adapter-service.ts` contains ONE intentional `as any` (line ~80, parsed mint account data) — documented in AGENTS.md.
- `bench/` test files use `vi.mock` and partial stubs — not production code, intentionally loose typing.
- `packages/autogpt-prism/` and `packages/langchain-prism/` are Python plugin skeletons — not part of the Bun build, stub implementations.
- `mcp-server/` is a separate Node subproject with its own tsconfig — different strictness settings.
- Alert delivery is intentionally fire-and-forget (`Effect.catchAll` → log + swallow) — by design, never blocks scan cycles.
