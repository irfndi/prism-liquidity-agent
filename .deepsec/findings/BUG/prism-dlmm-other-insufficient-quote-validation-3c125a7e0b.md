# [BUG] Freshly-fetched Jupiter quote skips mint/amount echo validation before wallet signs swap

**File:** [`engine/adapter-service.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/adapter-service.ts#L1150-L1198) (lines 1150, 1153, 1078, 1198)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** low  •  **Slug:** `other-insufficient-quote-validation`

## Owners

**Suggested assignee:** `irfandi@users.noreply.github.com` _(via last-committer)_

## Finding

In swapUSDCForToken (L1126-1215) the quote-validation gate is `if (prefetchedQuote && !quoteMatchesRequest(quoteData, USDC_MINT, outputMint, amountAtomic))`. When no prefetched quote is supplied, quoteData comes from quoteSwapUSDCForToken (L1037-1086), which only checks that `routePlan` is a non-empty array and does NOT verify the returned quote echoes the requested inputMint/outputMint/inAmount. The wallet then signs the Jupiter-built swap transaction (L1198 `swapTx.sign(activeWallet)`) derived from that unvalidated quote. This is inconsistent with the token->token path: quoteSwapToken (L1090-1124) always calls quoteMatchesRequest, and swapToken re-validates before signing. The practical exploitability is limited because (a) the quote is fetched from the hardcoded HTTPS host api.jup.ag with the correct mints/amount already in the request URL, and (b) the opaque base64 swap transaction is trusted from Jupiter on every path regardless of quote validation, so a compromised/MITM Jupiter could return a malicious transaction either way. Still, the asymmetry means the USDC->token entry path (used for AUTO_SWAP_ENTRY top-ups and gas swaps) loses a defense-in-depth check that the fee-conversion path deliberately keeps.

## Recommendation

Call quoteMatchesRequest(quoteData, USDC_MINT, outputMint, amountAtomic) unconditionally in swapUSDCForToken (drop the `prefetchedQuote &&` guard) so freshly-fetched quotes are validated identically to prefetched ones and to the swapToken path.

## Recent committers (`git log`)

- irfandi marsya <irfandi@users.noreply.github.com> (2026-07-20)
- irfandi marsya <join.mantap@gmail.com> (2026-07-19)
