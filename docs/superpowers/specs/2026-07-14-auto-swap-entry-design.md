# Auto-Swap USDC to Pool Tokens on Entry

## Status

Design approved; awaiting implementation plan.

## Context

In Prism v0.0.32, live entry into a Meteora DLMM position requires the wallet to already hold both of the pool's tokens in a roughly 50/50 USD split. `adapter.enterPosition` computes the required amounts, checks balances, and fails with:

> `Insufficient token balance: ... Wallet must hold both pool tokens before live entry.`

This means a user who wants the agent to enter a new pool must manually acquire the pool tokens beforehand. Jupiter swap integration already exists in the codebase, but it is currently used only to swap `USDC -> SOL` for gas top-ups (`adapter.swapUSDCForSOL`).

## Goal

Add an opt-in feature that, before a live `ENTER`, automatically swaps USDC into any missing pool token amounts so the wallet is ready for `enterPosition`.

## Decisions

| Topic | Decision |
|-------|----------|
| Base token | USDC only. |
| Opt-in vs default | Opt-in via config (`AUTO_SWAP_ENTRY=true`). Default `false`. |
| Swap strategy | Two separate swaps: `USDC -> tokenX` and `USDC -> tokenY` for the 50/50 USD split. |
| Slippage | 50 bps, hardcoded (matches existing Jupiter gas swap and DLMM defaults). |
| Paper trading | No change; paper mode continues to simulate entry without real swaps. |
| Architecture | New encapsulated `EntryPrepService` that prepares tokens before `adapter.enterPosition` is called. |

## Architecture

```text
┌─────────────┐      ┌─────────────────────┐      ┌─────────────────┐
│  program.ts │─────▶│  EntryPrepService   │─────▶│  AdapterService │
│  live ENTER │      │  prepareEntryTokens │      │  (prices/balances│
│             │      │                     │      │   + Jupiter swap)│
└─────────────┘      └─────────────────────┘      └─────────────────┘
                              │
                              ▼
                       ┌─────────────┐
                       │ ConfigService│
                       │ autoSwapEntry│
                       └─────────────┘
```

### New / changed files

| File | Change |
|------|--------|
| `engine/services.ts` | Add `EntryPrepService` tag and API type. |
| `engine/entry-prep-service.ts` | New service implementation. |
| `engine/errors.ts` | Add `EntryPrepError` with specific error cases. |
| `engine/config-service.ts` | Add `autoSwapEntry: boolean` from `AUTO_SWAP_ENTRY`, default `false`. |
| `engine/program.ts` | In live `ENTER`, call `prepareEntryTokens` after SOL gas top-up and before `enterPosition`. |
| `bench/entry-prep.test.ts` | New unit tests with mocked adapter/fetch. |

## Service API

```typescript
// engine/services.ts
export interface EntryPrepApi {
  readonly prepareEntryTokens: (
    poolAddress: string,
    positionSizeUsd: number,
  ) => Effect.Effect<void, EntryPrepError>;
}

export class EntryPrepService extends Context.Tag("EntryPrepService")<
  EntryPrepService,
  EntryPrepApi
>() {}
```

## Data Flow

1. `program.ts` decides to `ENTER` a pool live.
2. Existing SOL gas top-up runs (`adapter.swapUSDCForSOL`).
3. `entryPrep.prepareEntryTokens(poolAddress, decision.positionSizeUsd)` is called.
4. Inside `EntryPrepService`:
   1. Fetch pool state (`tokenX`, `tokenY`, decimals, active bin).
   2. Fetch token prices for `tokenX` and `tokenY` via adapter.
   3. Compute required amounts: `positionSizeUsd / 2` worth of each token.
   4. Read wallet balances for both tokens (and native SOL if one leg is SOL).
   5. If `autoSwapEntry` is `false`, return immediately. `enterPosition` will fail later if tokens are missing, preserving today's behavior.
   6. If `autoSwapEntry` is `true`:
      - For each leg where `balance < required`, compute deficit in token units.
      - Skip legs where `deficit <= 0`.
      - Call Jupiter `/swap/v1/quote?inputMint=USDC&outputMint=<token>&amount=<deficit>&slippageBps=50&asLegacyTransaction=true`.
      - Call Jupiter `/swap/v1/swap` to get a signed transaction.
      - Sign with the active wallet and send via `sendRawTransaction`.
      - Confirm the transaction and invalidate balance caches.
   7. Re-read balances. If either leg is still insufficient, fail with `INSUFFICIENT_BALANCE_AFTER_SWAP`.
5. `adapter.enterPosition` runs with the wallet now holding both tokens.

## Error Handling

New `EntryPrepError` cases:

| Code | When |
|------|------|
| `PRICE_UNAVAILABLE` | Could not fetch token prices for one or both pool tokens. |
| `SWAP_QUOTE_FAILED` | Jupiter quote request failed or returned no route. |
| `SWAP_TRANSACTION_FAILED` | Jupiter swap build/send/confirm failed. |
| `INSUFFICIENT_BALANCE_AFTER_SWAP` | Swaps completed but balances are still too low. |
| `NO_WALLET` | No wallet configured (defensive, should be caught earlier). |

At the `program.ts` call site, failures are caught and logged; the `ENTER` decision is recorded as not executed with the error message, consistent with existing live-entry error handling. Swap failures do not crash the scan cycle.

## Configuration

```typescript
// engine/config-service.ts
readonly autoSwapEntry: boolean; // AUTO_SWAP_ENTRY, default false
```

No additional env vars for v1. Slippage is hardcoded at 50 bps to match the existing Jupiter gas swap.

## Effect-TS Patterns

- `EntryPrepService` is a `Context.Tag` service.
- Implementation returns a `Layer` built from `AdapterService` and `ConfigService` dependencies.
- All side effects (fetch, RPC send, cache invalidation) stay inside `Effect.gen`.
- Errors are typed as `EntryPrepError` and propagated; `program.ts` decides how to handle them.

## Testing

`bench/entry-prep.test.ts` covers:

1. **Sufficient balances:** `prepareEntryTokens` does nothing and succeeds when both token balances are already enough.
2. **Auto-swap disabled:** with `autoSwapEntry=false`, no swap is attempted even if balances are short.
3. **Auto-swap one missing leg:** with `autoSwapEntry=true`, a Jupiter `USDC -> tokenX` swap is triggered when `tokenX` is short.
4. **Auto-swap both missing legs:** two separate Jupiter swaps are triggered.
5. **Swap leaves balance insufficient:** returns `INSUFFICIENT_BALANCE_AFTER_SWAP` if mocked swap does not fully cover the deficit.
6. **Price unavailable:** returns `PRICE_UNAVAILABLE` when adapter prices are missing.

Tests mock:
- `AdapterService` for pool state, prices, balances, and `swapUSDCForSOL`.
- `fetch` for Jupiter quote/swap responses.
- `ConfigService` for `autoSwapEntry`.

## Risks & Open Questions

- **Non-atomic:** Swap and entry are separate transactions. Price movement between them could leave the wallet with the wrong ratio. v1 accepts this risk; an atomic bundle is a future enhancement.
- **SOL leg:** If one pool token is SOL (wrapped or native), the swap must output WSOL and the balance check must account for the gas reserve. The implementation must reuse the existing `GAS_RESERVE_LAMPORTS` logic from `adapter-service.ts`.
- **USDC balance:** If the wallet lacks enough USDC, the swap will fail. The error message should be clear.
- **Jupiter API key:** Reuses existing `JUPITER_API_KEY` env var handling.

## Future Enhancements

- Atomic bundle: combine Jupiter swap instructions and DLMM `initializePositionAndAddLiquidityByStrategy` into a single Versioned Transaction.
- Configurable slippage: add `AUTO_SWAP_SLIPPAGE_BPS` if users need more control.
- Single-sided deposit: avoid swapping both legs by using DLMM's single-token liquidity provision when supported.
