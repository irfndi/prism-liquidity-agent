//! prismd — paper-first Rust host (Phase 3 stub).
//!
//! Owns process lifecycle, config, scan-loop ticks, SQLite reads, and the
//! call points where Bend kernels + Jev soft consult plug in. TS engine
//! remains source of truth until parity is green; this binary only SHADOWS.

use std::env;
use std::path::Path;
use std::thread;
use std::time::Duration;

// ponytail: single-file host; inline modules only, split into files when a second consumer exists.

/// Absolute bands mirrored from the TS evolution clamps (live-blocker class).
pub const FEE_IL_MIN: f64 = 0.3;
pub const FEE_IL_MAX: f64 = 3.0;

/// Clamp an evolved `min_fee_il_ratio` into `[0.3, 3.0]`.
/// Mirrors the TS clamp; Bend `LAWS.bend` will enforce the same band.
pub fn clamp_fee_il(v: f64) -> f64 {
    v.clamp(FEE_IL_MIN, FEE_IL_MAX)
}

/// Capital-protection EXIT is never gated — always approved.
/// Jev scores and confidence thresholds MUST NOT veto this path.
pub fn exit_approved() -> bool {
    true
}

/// Native half of the loss-cap shadow: compute the danger signal from the
/// ledger. Mirrors `engine/position-loss-cap.ts` `isPositionLossCapBreached`
/// (mark PnL = current + fees + rewards − deposited ≤ -(deposited ×
/// min(pct,1))); `None` on missing/non-finite/non-positive-deposit inputs
/// (never fires). Disabled at pct ≤ 0, matching TS.
/// Called twice at the tick — live `max_position_loss_pct` and the tighter
/// probe at `max_position_loss_pct / 2.0`, both inlined (no helper).
pub fn loss_cap_danger(
    deposited: Option<f64>,
    current: Option<f64>,
    fees: Option<f64>,
    rewards: Option<f64>,
    max_loss_pct: f64,
) -> Option<bool> {
    if !max_loss_pct.is_finite() || max_loss_pct <= 0.0 {
        return Some(false);
    }
    let (d, c, f, r) = (deposited?, current?, fees?, rewards?);
    if !(d.is_finite() && c.is_finite() && f.is_finite() && r.is_finite()) {
        return None;
    }
    if d <= 0.0 || f < 0.0 || r < 0.0 {
        return None;
    }
    let floor = max_loss_pct.min(1.0);
    Some(c + f + r - d <= -(d * floor))
}

/// HODL benchmark: what the entry capital would be worth undeposited (X leg
/// moves with price ratio, Y leg constant). Mirrors `engine/pnl.ts`
/// `computeHodlValueUsd` (null on non-positive entry price). `None` on
/// missing/non-finite legs too (never fires).
pub fn hodl_value_usd(
    entry_x_usd: Option<f64>,
    entry_y_usd: Option<f64>,
    entry_price_usd: Option<f64>,
    current_price_usd: Option<f64>,
) -> Option<f64> {
    let (x, y, entry, current) = (
        entry_x_usd?,
        entry_y_usd?,
        entry_price_usd?,
        current_price_usd?,
    );
    if !(x.is_finite() && y.is_finite() && entry.is_finite() && current.is_finite()) {
        return None;
    }
    if entry <= 0.0 {
        return None;
    }
    Some(x * (current / entry) + y)
}

/// SHADOW-only IL-dominance trigger: IL exceeds fees by factor and floor.
/// Mirrors `engine/program.ts` `isIlDominant` (ilUsd > 0 && ilUsd >
/// fees × factor && ilUsd > minUsd). Exact comparison, host-native floats
/// (no Bend kernel — F32 compares are uninterpreted axioms per
/// bend/README.md:15-17). `None` on missing/non-finite legs (never fires).
/// DIVERGENCE (documented, shadow-only): TS also gates on protection-enabled,
/// out-of-range, and known entry legs at the computeIlDominance call site —
/// the caller applies those gates, this fn is the pure trigger.
pub fn il_dominant(
    il_usd: Option<f64>,
    fees_claimed_usd: Option<f64>,
    exit_factor: f64,
    min_usd: f64,
) -> Option<bool> {
    if !(exit_factor.is_finite() && min_usd.is_finite()) {
        return None;
    }
    let (il, fees) = (il_usd?, fees_claimed_usd?);
    if !(il.is_finite() && fees.is_finite()) {
        return None;
    }
    Some(il > 0.0 && il > fees * exit_factor && il > min_usd)
}

/// SHADOW-only stop-loss veto: mirrors `checkStopLossGate`'s drawdown
/// comparison (risk-service.ts:176-177) — vetoes when the position's mark
/// drawdown `(current - deposited) / deposited` breaches `-stop_loss_pct`.
/// Exact TS comparison: `lossPct < -pct` with NO disabled arm (pct 0 vetoes
/// any loss; the parser still rejects garbage/negative, absent -> 0.15).
/// Spot (no fees/rewards added — TS uses currentValueUsd only). `None` on
/// missing/non-finite inputs or non-positive deposited → never vetoes;
/// non-finite pct → `None` (fail-closed: the parser rejects it, the fn never
/// invents a verdict from a NaN cap).
/// DIVERGENCE (documented, shadow-only): TS gates on action too — the veto
/// fires only for HOLD/REBALANCE decisions (risk-service.ts:165-175 finds
/// the target position first). The host has no candidate decisions, so
/// `stop_loss_shadow` counts spot-drawdown breaches regardless of action
/// and never vetoes — the breach predicate is exact, the action gate is out
/// of scope until the host admits candidates.
pub fn stop_loss_veto(
    deposited: Option<f64>,
    current: Option<f64>,
    stop_loss_pct: f64,
) -> Option<bool> {
    if !stop_loss_pct.is_finite() {
        return None;
    }
    let (d, c) = (deposited?, current?);
    if !(d.is_finite() && c.is_finite()) {
        return None;
    }
    if d <= 0.0 {
        return None;
    }
    Some((c - d) / d < -stop_loss_pct)
}

/// One pool's stat legs + provenance (waves 97-98). `measured` = the
/// DATAPI tier answered — the ONLY source that may set `known`
/// (`feeIlRatioKnown`/accrual are datapi-only in TS; the gecko overlay
/// leaves farm/verification/freeze null and never counts). Legs survive
/// the overlay; `bin_step` prefers the chain lbPair value (TS's source,
/// adapter-service.ts:3729) with datapi `pool_config` as fallback.
struct PoolStatEntry {
    measured: bool,
    tvl_usd: f64,
    fees_24h_usd: f64,
    bin_step: Option<i64>,
    current_price: Option<f64>,
}

impl PoolStatEntry {
    fn from_datapi(s: datapi::PoolStats, chain_bin_step: Option<i64>) -> Self {
        Self {
            measured: true,
            tvl_usd: s.tvl_usd,
            fees_24h_usd: s.fees_24h_usd,
            bin_step: chain_bin_step.or(s.bin_step),
            current_price: Some(s.current_price),
        }
    }

    fn from_gecko(g: gecko::GeckoStats, chain_bin_step: Option<i64>) -> Self {
        Self {
            measured: false,
            tvl_usd: g.tvl_usd,
            fees_24h_usd: g.fees_24h_usd,
            bin_step: chain_bin_step,
            current_price: g.current_price,
        }
    }
}

/// Fee/IL estimator stack — port of engine/strategy-service.ts (wave 100):
/// constants, IL fraction, concentration, 24h-anchored drift, and the two
/// public entry points. Every constant is the TS literal (MAX 20, ref half
/// width 20, max concentration 10, drift proxy 10/day, min fee-window span
/// 1h, ms/day). Together with the chain-fed `BinArray` these retire the
/// ratio leg's dependency on TS-written `signal_snapshots.fee_il_ratio`.
pub const MAX_FEE_IL_RATIO: f64 = 20.0;
const MS_PER_DAY: f64 = 86_400_000.0;
const CONCENTRATION_REFERENCE_HALF_WIDTH: f64 = 20.0;
const MAX_CONCENTRATION_MULTIPLIER: f64 = 10.0;
pub const BIN_STEP_DRIFT_PROXY_PER_DAY: f64 = 10.0;
pub const MIN_FEE_WINDOW_SPAN_MS: i64 = 3_600_000;

/// TS `PriceDriftContext` (types.ts:243): the fee-window's drift endpoint.
pub struct PriceDrift {
    pub previous_price: f64,
    pub previous_timestamp_ms: i64,
}

/// IL fraction of a full-range LP after price moves by ratio `r`
/// (strategy-service.ts:35): `|2√r/(1+r) − 1|`.
fn impermanent_loss_fraction(price_ratio: f64) -> f64 {
    ((2.0 * price_ratio.sqrt()) / (1.0 + price_ratio) - 1.0).abs()
}

/// TS `computeConcentrationMultiplier` (:44): liquidity-weighted mean
/// distance of stocked bins from the active bin vs a 20-bin reference,
/// clamped to [1, 10]. Empty/unknown bins (TS `reservesKnown: false` or no
/// weight) → 1 — never fabricates amplification.
pub fn concentration_multiplier(bins: &[rpc::BinSlot], active_bin_id: i64) -> f64 {
    let (mut weight_sum, mut distance_sum) = (0.0f64, 0.0f64);
    for b in bins {
        let weight = b.liquidity_supply as f64; // TS Number(bigint): finite for any u128
        if !(weight.is_finite() && weight > 0.0) {
            continue;
        }
        weight_sum += weight;
        distance_sum += weight * (b.bin_id - active_bin_id).abs() as f64;
    }
    if weight_sum <= 0.0 {
        return 1.0;
    }
    let effective_half_width = (distance_sum / weight_sum).max(1.0);
    (CONCENTRATION_REFERENCE_HALF_WIDTH / effective_half_width)
        .clamp(1.0, MAX_CONCENTRATION_MULTIPLIER)
}

/// Port of TS `snapshotPriceDrift` (scan-set.ts:22) — the fee-window ANCHOR:
/// oldest row of the caller's trailing-24h window; `None` on cold start AND
/// when latest−anchor < 1h (the jitter guard that stopped per-cycle
/// whipsawing — both fall through to the binStep proxy). `rows` ascending
/// (oldest first), already windowed by SQL; latest = `rows.last()` (the
/// previous cycle's row — the current tick's row is written AFTER this runs).
pub fn snapshot_price_drift(rows: &[(f64, i64)]) -> Option<(f64, i64)> {
    let anchor = *rows.first()?;
    let latest = rows.last()?;
    if latest.1 - anchor.1 < MIN_FEE_WINDOW_SPAN_MS {
        return None;
    }
    Some(anchor)
}

/// The host's fee-window price history (`prismd_pool_history`, wave 99) is
/// TS's `pool_snapshots` for the drift anchor. Trailing 24h, oldest-first.
/// Fail-open → empty (cold start → binStep proxy).
fn read_pool_price_window(sqlite_path: &str, pool_address: &str, now_ms: i64) -> Vec<(f64, i64)> {
    let conn = match rusqlite::Connection::open_with_flags(
        Path::new(sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] sqlite open {sqlite_path} failed: {e}; price window=[]");
            return Vec::new();
        }
    };
    let cutoff = now_ms.saturating_sub(MS_PER_DAY as i64);
    let mut stmt = match conn.prepare(
        "SELECT current_price, timestamp FROM prismd_pool_history WHERE pool_address = ?1 AND timestamp >= ?2 ORDER BY timestamp ASC",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[prismd] price-window query prep failed: {e}; window=[]");
            return Vec::new();
        }
    };
    // let-bound (not tail-match): the query_map temporary must drop before
    // stmt/conn, or the borrowed MappedRows outlives them (E0597).
    let out: Vec<(f64, i64)> = match stmt.query_map(rusqlite::params![pool_address, cutoff], |r| {
        Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?))
    }) {
        Ok(rows) => rows.flatten().collect(),
        Err(e) => {
            eprintln!("[prismd] price-window query failed: {e}; window=[]");
            Vec::new()
        }
    };
    out
}

/// TS `estimateDailyIlUsd` (:79): drift path measures the fee window's real
/// endpoint move (clamped [0.5, 2], annualized by elapsed cycles, amplified
/// by concentration); no usable drift → the stable binStep proxy (10×binStep
/// bps of assumed daily drift). Conservative upper-bound ranking signal.
pub fn estimate_daily_il_usd(
    tvl_usd: f64,
    current_price: f64,
    timestamp_ms: i64,
    bin_step: i64,
    concentration: f64,
    drift: Option<PriceDrift>,
) -> f64 {
    if let Some(d) = drift.filter(|d| {
        d.previous_price > 0.0 && d.previous_timestamp_ms < timestamp_ms && current_price > 0.0
    }) {
        let ratio = (current_price / d.previous_price).clamp(0.5, 2.0);
        let elapsed_ms = (timestamp_ms - d.previous_timestamp_ms) as f64;
        let cycles_per_day = MS_PER_DAY / elapsed_ms;
        // Grouping mirrors TS exactly (frac × cycles × conc, then × tvl) —
        // IEEE rounding is order-sensitive and the pinned vectors are exact.
        let il_daily_fraction = impermanent_loss_fraction(ratio) * cycles_per_day * concentration;
        return tvl_usd * il_daily_fraction;
    }
    let assumed_daily_drift = (bin_step as f64 / 10_000.0) * BIN_STEP_DRIFT_PROXY_PER_DAY;
    let il_daily_fraction = impermanent_loss_fraction(1.0 + assumed_daily_drift) * concentration;
    tvl_usd * il_daily_fraction
}

/// TS `computeFeeIlRatio` (:187): tvl 0 → 0; no IL → fees>0 ? MAX : 0;
/// else min(fees24h / estimatedDailyIl, MAX=20) — the host's ratio is now
/// COMPUTED (chain bin array + stats + own price history), never read from
/// TS-written `signal_snapshots`.
pub fn compute_fee_il_ratio(
    tvl_usd: f64,
    fees_24h_usd: f64,
    current_price: f64,
    timestamp_ms: i64,
    bin_step: i64,
    concentration: f64,
    drift: Option<PriceDrift>,
) -> f64 {
    if tvl_usd == 0.0 {
        return 0.0;
    }
    let estimated_il_daily_usd = estimate_daily_il_usd(
        tvl_usd,
        current_price,
        timestamp_ms,
        bin_step,
        concentration,
        drift,
    );
    if estimated_il_daily_usd <= 0.0 {
        return if fees_24h_usd > 0.0 {
            MAX_FEE_IL_RATIO
        } else {
            0.0
        };
    }
    (fees_24h_usd / estimated_il_daily_usd).min(MAX_FEE_IL_RATIO)
}

/// SHADOW-only portfolio-drawdown veto: mirrors `checkDrawdownGate`
/// (risk-service.ts:133-154) — ENTER vetoes when unrealized book PnL is
/// negative and `|pnl| / portfolio` exceeds 10% (hardcoded in TS, no config).
/// Exact TS semantics: non-finite portfolio/pnl → veto (fail-closed pause);
/// portfolio <= 0 → no veto (guard); otherwise `pnl < 0 && |pnl|/portfolio >
/// 0.1`. Portfolio comes from `drawdown_portfolio_usd` below (TS uses live
/// portfolioValueUsd — documented in the allocation bullet); pnl sums open
/// spot PnL `current − deposited` per position like `toRiskPosition`
/// (program.ts:1016-1030 — spot-only; NOT the fees-included analytics shape).
/// Missing legs are skipped (a NULL row blanks nothing —
/// one bad row must not veto-or-clear the whole book); non-finite legs →
/// `None` (fail-closed pause); non-positive-deposited legs are skipped (TS
/// `toRiskPosition` maps every open row; the host skips rows it cannot price
pub fn drawdown_veto(legs: &[(Option<f64>, Option<f64>)], portfolio_usd: f64) -> Option<bool> {
    if !portfolio_usd.is_finite() {
        return Some(true);
    }
    if portfolio_usd <= 0.0 {
        return Some(false);
    }
    let mut pnl = 0.0;
    for (d, c) in legs {
        let (Some(d), Some(c)) = (*d, *c) else {
            continue;
        };
        if !(d.is_finite() && c.is_finite()) {
            return None;
        }
        if d <= 0.0 {
            continue;
        }
        pnl += c - d;
    }
    if !pnl.is_finite() {
        return Some(true);
    }
    Some(pnl < 0.0 && pnl.abs() / portfolio_usd > 0.1)
}

/// Drawdown-gate portfolio denominator. `Some(wallet_usd)` is a MEASURED
/// wallet value — native + SPL at skip-unpriced valuation (`wallet_total_usd`,
/// TS `readWalletSnapshot`) — including `Some(0.0)` for an empty wallet or a
/// price outage: both must price as measured, never swap for the configured
/// paper portfolio (a fabricated $10k denominator masks a real drawdown and
/// shrinks any measured one). `None` is a failed lamports read or paper mode —
/// the only case that keeps the config figure. DIVERGENCE from
/// TS's failed-read contract (program.ts:8299): TS retains
/// `lastWalletBalanceUsd` (last-known, reused stale with a one-time warn); the
/// host has no retained figure, so it substitutes `paper_portfolio_usd` —
/// fail-safe direction (a known, bounded denominator, never a fabricated zero),
/// but a real gap until a retained-balance tier lands.
pub fn drawdown_portfolio_usd(
    wallet_value_usd: Option<f64>,
    open_value_usd: f64,
    paper_portfolio_usd: f64,
) -> f64 {
    match wallet_value_usd {
        Some(v) => v + open_value_usd,
        None => paper_portfolio_usd,
    }
}

/// TS `readWalletSnapshot` valuation (adapter-service.ts:2952-2980): native
/// SOL + every SPL holding against ONE price map. An unpriced asset is
/// SKIPPED — fail-closed under-report, never a fallback price — and reported
/// in `skipped` so the tick can warn once per mint (TS
/// `warnUnpricedWalletMintOnce`). Both token programs' rows pass through
/// linearly: a mint held under both programs contributes its two amounts
/// independently (same sum as a merge). Zero amounts cannot occur — the
/// holdings parser drops them.
pub fn wallet_total_usd(
    lamports: u64,
    holdings: &[rpc::Holding],
    prices: &std::collections::HashMap<String, f64>,
) -> (f64, Vec<String>) {
    let mut total = 0.0;
    let mut skipped = Vec::new();
    if lamports > 0 {
        match prices.get(rpc::SOL_MINT) {
            Some(&p) => total += (lamports as f64 / rpc::LAMPORTS_PER_SOL) * p,
            None => skipped.push(rpc::SOL_MINT.to_string()),
        }
    }
    for h in holdings {
        match prices.get(&h.mint) {
            Some(&p) => {
                total += (h.amount_atomic as f64) * p / 10f64.powi(i32::from(h.decimals));
            }
            None => skipped.push(h.mint.clone()),
        }
    }
    (total, skipped)
}

/// Warn once per process per unpriced wallet mint (TS
/// `warnUnpricedWalletMintOnce`): price gaps repeat every tick, the log must
/// not. Lock poisoning silently drops the dedupe — worst case is a repeated
/// line, never a failed tick.
fn warn_unpriced_wallet_mint_once(mint: &str) {
    static WARNED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::LazyLock::new(Default::default);
    if let Ok(mut w) = WARNED.lock() {
        if w.insert(mint.to_string()) {
            eprintln!("[prismd] wallet mint unpriced — skipped fail-closed: {mint}");
        }
    }
}

/// Pure ring push — TS `pushBinHistory` (program.ts:5973-5976): append the
/// newest bin, evict oldest beyond `cap`. Chronological (oldest→newest) is
/// preserved, so drift is simply last − first and windows slice from the end.
pub fn push_bin_history(ring: &mut Vec<i64>, active_id: i64, cap: usize) {
    ring.push(active_id);
    while ring.len() > cap {
        ring.remove(0);
    }
}

/// Process-lifetime host `binHistory` — the TS in-memory `Map<pool, bins>`
/// (program.ts:5937) with the same per-process semantics: a fresh prismd
/// cold-starts empty exactly like a restarted TS engine, never seeded from
/// persisted rows. Mutex poisoning skips one tick's sample, never fails it.
static BIN_HISTORY: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, Vec<i64>>>,
> = std::sync::LazyLock::new(Default::default);

/// Pure twin of the F7 pool-cooldown ENTER gate: ENTER may proceed iff no
/// cooldown row exists for the pool OR now >= cooldown_until. Mirrors
/// `checkEnterCooldownGate` (program.ts:11870-11906): active cooldown →
/// skip ENTER (observational hold here). `None` on missing clock leg →
/// proceed (fail-open).
pub fn pool_cooldown_free(cooldown_until_ms: Option<i64>, now_ms: Option<i64>) -> Option<bool> {
    let until = cooldown_until_ms?;
    let now = now_ms?;
    Some(now >= until)
}
/// Read-only pool cooldowns (`pool_cooldowns`: pool → until + reason).
/// Fail-open → empty (no rows = no pool cooled; missing table on old DBs =
/// empty, never blocks). Same connection pattern as the other readers.
fn read_pool_cooldowns(sqlite_path: &str) -> Vec<(String, i64, String)> {
    let conn = match rusqlite::Connection::open_with_flags(
        Path::new(sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] sqlite open {sqlite_path} failed: {e}; cooldowns=[]");
            return Vec::new();
        }
    };
    let mut stmt =
        match conn.prepare("SELECT pool_address, cooldown_until, reason FROM pool_cooldowns") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[prismd] cooldowns query prep failed: {e}; cooldowns=[]");
                return Vec::new();
            }
        };
    let out: Vec<(String, i64, String)> = match stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
        ))
    }) {
        Ok(rows) => rows.flatten().collect(),
        Err(e) => {
            eprintln!("[prismd] cooldowns query failed: {e}; cooldowns=[]");
            Vec::new()
        }
    };
    out
}
/// Pure twin of gate 7's width arm: a PROPOSED rebalance band is well-formed
/// iff `upper > lower` and `upper - lower <= max_bins`. Mirrors
/// `checkRebalanceRangeGate`'s first two arms (risk-service.ts:264-278) on
/// integer bin ids exactly (no float bins — TS ids are integers);
/// containment needs a live active bin and lives at the tick, not here.
pub fn rebalance_range_invalid(
    lower: Option<i64>,
    upper: Option<i64>,
    max_bins: i64,
) -> Option<bool> {
    let (lo, hi) = (lower?, upper?);
    if hi <= lo {
        return Some(true);
    }
    Some(hi - lo > max_bins)
}
/// Pure twin of the F1 gas-aware rebalance gate: REBALANCE is justified iff
/// `gas_cost_usd <= position_daily_fees_usd * min_days`. Mirrors
/// `evaluateGasGate` (risk-service.ts:721-769): non-finite legs → refuse
/// (fail-closed); non-positive gas → refuse (config must be positive);
/// non-positive daily fees → refuse (zero-fee pools never justify gas).
/// `gas_cost_usd = rebalance_gas_cost_sol * sol_price_usd` is computed by the
/// caller (same product TS forms at program.ts:11497-11498).
/// `None` → never flags (fail-open on unknown); `Some(true)` = gas-justified.
pub fn gas_rebalance_justified(
    gas_cost_usd: Option<f64>,
    position_daily_fees_usd: Option<f64>,
    min_days_of_fees_paid_ahead: f64,
) -> Option<bool> {
    if !min_days_of_fees_paid_ahead.is_finite() {
        return None;
    }
    let (gas, fees) = (gas_cost_usd?, position_daily_fees_usd?);
    if !(gas.is_finite() && fees.is_finite()) {
        return None;
    }
    if gas <= 0.0 || fees <= 0.0 {
        return Some(false);
    }
    Some(gas <= fees * min_days_of_fees_paid_ahead)
}
/// Position share of pool TVL, capped at 100% (0 when unmeasurable).
/// Mirrors `resolvePositionSharePct` (program.ts:4656-4658): tvl or value
/// non-positive → 0; otherwise min(value/tvl, 1). Non-finite → 0.
pub fn position_share_pct(tvl_usd: f64, current_value_usd: f64) -> f64 {
    if !(tvl_usd.is_finite() && current_value_usd.is_finite()) {
        return 0.0;
    }
    if tvl_usd <= 0.0 || current_value_usd <= 0.0 {
        return 0.0;
    }
    (current_value_usd / tvl_usd).min(1.0)
}
/// Pure twin of the F4 OOR recovery gate: HOLD in expectation of recovery
/// iff `prob >= threshold`. Mirrors `estimateRecoveryProbability` +
/// `shouldHoldForRecovery` (strategy-service.ts:678-706): <2 history bins →
/// 0.5 (no signal); zero swing → drift<=0 ? 1 : 0; else mean|Δ| /
/// (mean|Δ| + drift), pinned [0,1]; hold iff >= threshold.
/// `recent_bins` newest-last (matches TS push order); `current_drift_bins`
/// = |active − center| in bins (program.ts:11532-11534). Non-finite legs →
pub fn recovery_hold(
    recent_bins: &[i64],
    current_drift_bins: f64,
    hold_threshold: f64,
) -> Option<bool> {
    if !current_drift_bins.is_finite() || !hold_threshold.is_finite() {
        return None;
    }
    if recent_bins.len() < 2 {
        return Some(0.5 >= hold_threshold);
    }
    let mut sum_abs: i64 = 0;
    for w in recent_bins.windows(2) {
        sum_abs += (w[1] - w[0]).abs();
    }
    let mean_abs = sum_abs as f64 / (recent_bins.len() - 1) as f64;
    if mean_abs <= 0.0 {
        return Some(if current_drift_bins <= 0.0 { 1.0 } else { 0.0 } >= hold_threshold);
    }
    let ratio = mean_abs / (mean_abs + current_drift_bins);
    Some(ratio.clamp(0.0, 1.0) >= hold_threshold)
}
/// Recovery probability alone (same math, no threshold) — logged so the
/// shadow line shows the prob TS compares against the hold threshold.
/// `None` on non-finite drift or <2 bins handled as 0.5 like TS.
pub fn recovery_probability(recent_bins: &[i64], current_drift_bins: f64) -> Option<f64> {
    if !current_drift_bins.is_finite() {
        return None;
    }
    if recent_bins.len() < 2 {
        return Some(0.5);
    }
    let mut sum_abs: i64 = 0;
    for w in recent_bins.windows(2) {
        sum_abs += (w[1] - w[0]).abs();
    }
    let mean_abs = sum_abs as f64 / (recent_bins.len() - 1) as f64;
    if mean_abs <= 0.0 {
        return Some(if current_drift_bins <= 0.0 { 1.0 } else { 0.0 });
    }
    Some((mean_abs / (mean_abs + current_drift_bins)).clamp(0.0, 1.0))
}
/// Pure twin of the agent-REBALANCE min-interval arm: REBALANCE may proceed
/// iff `now - last >= min_ms` OR the OOR grace expired. Mirrors
/// `evaluateAgentRebalanceCapitalGates` first arm (risk-service.ts:665-673):
/// grace bypasses the clock (program.ts:11628/13629). `None` on missing
/// clock leg → never flags (fail-open on unknown); `Some(true)` = cooled.
pub fn rebalance_interval_cooled(
    now_ms: Option<i64>,
    last_rebalance_at_ms: Option<i64>,
    min_interval_ms: i64,
    oor_grace_expired: bool,
) -> Option<bool> {
    if oor_grace_expired {
        return Some(true);
    }
    let (now, last) = (now_ms?, last_rebalance_at_ms?);
    Some(now - last >= min_interval_ms)
}
/// Pure twin of the F6 paper-validation gate: live ENTER needs `days >= min`
/// (or warns when unenforced). Mirrors `evaluatePaperValidation`
/// (risk-service.ts:950-982): paper mode → pass; days>=min → pass;
/// !enforce → warn-pass; else block. Returns (pass, warning): warning is
/// `Some(msg)` only on the warn-pass arm. `None` on missing/non-finite days
/// → never flags (fail-open on unknown).
pub fn paper_validation_pass(
    paper_trading: bool,
    paper_days: Option<f64>,
    min_days: f64,
    enforce: bool,
) -> Option<bool> {
    if paper_trading {
        return Some(true);
    }
    if !min_days.is_finite() {
        return None;
    }
    let days = paper_days?;
    if !days.is_finite() {
        return None;
    }
    if days >= min_days {
        return Some(true);
    }
    if !enforce {
        return Some(true);
    }
    Some(false)
}
/// Pure twin of the F3 fee-compound gate: compound iff net fees clear
/// min + buffer + gas. Mirrors `evaluateCompoundGate`
/// (risk-service.ts:793-838): non-finite legs → refuse (fail-closed);
/// net<=0 → refuse (nothing to compound); savings<=0 → refuse;
/// else approve. `None` → never flags (fail-open on unknown).
/// `Some(true)` = compound-approved.
/// PARKED (unit-tested only, no tick call): the gate needs the per-claim
/// `netFeesUsd` leg (live claim result, program.ts:15218) — `positions`
#[cfg_attr(not(test), allow(dead_code))]
pub fn compound_approved(
    net_fees_usd: Option<f64>,
    min_compound_fees_usd: f64,
    compound_gas_buffer_usd: f64,
    rebalance_gas_cost_usd: f64,
) -> Option<bool> {
    if !(min_compound_fees_usd.is_finite()
        && compound_gas_buffer_usd.is_finite()
        && rebalance_gas_cost_usd.is_finite())
    {
        return None;
    }
    let net = net_fees_usd?;
    if !net.is_finite() {
        return None;
    }
    if net <= 0.0 {
        return Some(false);
    }
    Some(net - (min_compound_fees_usd + compound_gas_buffer_usd + rebalance_gas_cost_usd) > 0.0)
}
/// Pure twin of the volatility-gate EXIT predicate: EXIT iff high-vol AND
/// drifted AND cooled. Mirrors `decidePhase2Exit` vol arm
/// (program.ts:11364-11398): `!isRunner && highVol(stddev>=thr) &&
/// driftPct>0.6 && (cooled||grace)`. Stddev = sample stddev over the
/// chain-fed binHistory ring (same math as `computeBinVolatilityStddev`,
/// strategy-service.ts:299-305); driftPct = |live-active-bin−center| /
/// halfWidth with `vol_bins[0]` = THIS tick's chain sample. Cooled/grace
/// reuse the interval legs with grace-first short-circuit (cooled=None+
/// grace=true fires, matching TS `||`). The wave-91 "expected divergence"
/// (persisted proxy, always one cycle behind) is RESOLVED in wave 95: the
/// host reads live bins through the same in-memory-ring mechanism as TS;
/// the only remaining bar delta is ring AGE (a fresh prismd process
/// cold-starts empty; a recorded TS side ran with a mature ring).
/// `None` on missing/non-finite legs (never flags without inputs).
pub fn vol_exit_fires(
    is_runner: bool,
    stddev: Option<f64>,
    threshold: f64,
    drift_pct: Option<f64>,
    cooled: Option<bool>,
    grace: bool,
) -> Option<bool> {
    if is_runner {
        return Some(false);
    }
    if !threshold.is_finite() {
        return None;
    }
    let (sd, dp) = (stddev?, drift_pct?);
    if !(sd.is_finite() && dp.is_finite()) {
        return None;
    }
    let high = sd >= threshold;
    // TS: (timeSinceRebal >= min || grace) — grace true fires even when the
    // clock leg is unknown. `cooled?` first would wrongly return None.
    let cooled_ok = if grace { true } else { cooled? };
    Some(high && dp > 0.6 && cooled_ok)
}
/// Sample stddev over bin ids (n-1 denominator). Mirrors
/// `computeBinVolatilityStddev` exactly: <2 bins → 0.0.
pub fn bin_volatility_stddev(bins: &[i64]) -> f64 {
    if bins.len() < 2 {
        return 0.0;
    }
    let mean = bins.iter().sum::<i64>() as f64 / bins.len() as f64;
    let var = bins
        .iter()
        .map(|b| (*b as f64 - mean) * (*b as f64 - mean))
        .sum::<f64>()
        / (bins.len() - 1) as f64;
    var.sqrt()
}
/// Pure twin of the entry-shape regime pick: trend → bidask, high-vol chop →
/// spot, calm → curve. Mirrors `recommendStrategy`
/// (strategy-service.ts:483-492): `|drift| >= max(3, 2σ)` → bidask;
/// else `σ >= thr` → spot; else curve (incl. cold start 0/0 → curve).
/// Non-finite legs → curve (matches TS: NaN poisons both comparisons
/// false → falls through to curve). No ENTRY_STRATEGY_TYPE leg on the host —
/// TS `resolveEntryStrategySpec` returns non-auto shapes as-is, so this
/// shadows the `auto` arm only (documented, never acts).
pub fn recommend_entry_strategy(stddev: f64, threshold: f64, net_drift_bins: f64) -> &'static str {
    if !(stddev.is_finite() && threshold.is_finite() && net_drift_bins.is_finite()) {
        return "curve";
    }
    if net_drift_bins.abs() >= 3.0_f64.max(2.0 * stddev) {
        return "bidask";
    }
    if stddev >= threshold {
        return "spot";
    }
    "curve"
}
/// Pure twin of `resolveRangeHalfWidth` (strategy-service.ts:429-467): base
/// tier/binStep + price-coverage floor + sigma-scale clamp. Base 0 → tier
/// 25/20/15; adaptive off / non-finite / σ<=0 → bounded base; else scale by
/// clamp(σ/2, 0.5, 2). Half-cap = min(floor(maxFull/2), 34); floor = min(5,
/// half-cap). Shadow-only, never acts.
pub fn resolve_range_half_width(
    bin_step: Option<i64>,
    configured_base_half_width: i64,
    adaptive_enabled: bool,
    volatility_stddev: f64,
    max_full_range_bins: i64,
    min_price_coverage_pct: f64,
) -> i64 {
    let step = bin_step.unwrap_or(0);
    let base = if configured_base_half_width > 0 {
        configured_base_half_width
    } else if step <= 10 {
        25
    } else if step <= 25 {
        20
    } else {
        15
    };
    let half_cap = (max_full_range_bins.max(1) / 2).clamp(1, 34);
    let effective_min = 5.min(half_cap);
    let coverage_width =
        if min_price_coverage_pct > 0.0 && min_price_coverage_pct.is_finite() && step > 0 {
            let unit = 1.0 + step as f64 / 10_000.0;
            ((1.0 + min_price_coverage_pct / 100.0).ln() / unit.ln()).ceil() as i64
        } else {
            0
        };
    let coverage_floor = if coverage_width > 0 {
        half_cap.min(coverage_width)
    } else {
        0
    };
    let effective_base = base.max(coverage_floor);
    if !adaptive_enabled || !volatility_stddev.is_finite() || volatility_stddev <= 0.0 {
        return half_cap.min(effective_min.max(effective_base));
    }
    let mult = (volatility_stddev / 2.0).clamp(0.5, 2.0);
    half_cap.min(effective_min.max((effective_base as f64 * mult).round() as i64))
}
/// Pure twins of the TA-exhaustion indicators (engine/ta-exhaustion.ts):
/// Wilder RSI(2), Bollinger upper (20, 2sd), MACD(12,26,9) histogram.
/// `None` on short history / non-finite junk (fail-open no-vote, like TS
/// TA_EXHAUSTION_MIN_POINTS floor). Closes newest-first (host order) —
/// each twin reverses to oldest-first internally. Shadow-only.
pub fn ta_rsi2(closes_newest_first: &[f64]) -> Option<f64> {
    if closes_newest_first.len() < 3 {
        return None;
    }
    if !closes_newest_first.iter().all(|v| v.is_finite()) {
        return None;
    }
    let closes: Vec<f64> = closes_newest_first.iter().rev().copied().collect();
    let period = 2usize;
    let (mut gain_sum, mut loss_sum) = (0.0, 0.0);
    for i in 1..=period {
        let diff = closes[i] - closes[i - 1];
        if diff > 0.0 {
            gain_sum += diff;
        } else {
            loss_sum -= diff;
        }
    }
    let (mut avg_gain, mut avg_loss) = (gain_sum / period as f64, loss_sum / period as f64);
    for i in period + 1..closes.len() {
        let diff = closes[i] - closes[i - 1];
        avg_gain = (avg_gain * (period - 1) as f64 + diff.max(0.0)) / period as f64;
        avg_loss = (avg_loss * (period - 1) as f64 + (-diff).max(0.0)) / period as f64;
    }
    if avg_loss == 0.0 {
        return Some(if avg_gain == 0.0 { 50.0 } else { 100.0 });
    }
    if avg_gain == 0.0 {
        return Some(0.0);
    }
    Some(100.0 - 100.0 / (1.0 + avg_gain / avg_loss))
}
/// Bollinger upper over the trailing 20 closes. `None` below 20 / on junk.
pub fn ta_bb_upper(closes_newest_first: &[f64]) -> Option<f64> {
    const N: usize = 20;
    if closes_newest_first.len() < N {
        return None;
    }
    // Newest-first storage → reverse to oldest-first, then take the
    // TRAILING 20 (latest closes), matching TS closes.slice(-n).
    let oldest: Vec<f64> = closes_newest_first.iter().rev().copied().collect();
    let window = &oldest[oldest.len() - N..];
    if !window.iter().all(|v| v.is_finite()) {
        return None;
    }
    let middle = window.iter().sum::<f64>() / N as f64;
    let var = window
        .iter()
        .map(|v| (v - middle) * (v - middle))
        .sum::<f64>()
        / N as f64;
    Some(middle + 2.0 * var.sqrt())
}
fn ta_ema(values: &[f64], period: usize) -> Vec<f64> {
    let mut ema = values[..period].iter().sum::<f64>() / period as f64;
    let mut out = vec![ema];
    let k = 2.0 / (period as f64 + 1.0);
    for v in &values[period..] {
        ema += k * (*v - ema);
        out.push(ema);
    }
    out
}
/// MACD histogram current + previous. `None` below 35 closes / on junk.
/// "First green" = current > 0 with previous <= 0 (checked at the tick).
pub fn ta_macd_hist(closes_newest_first: &[f64]) -> Option<(f64, f64)> {
    if closes_newest_first.len() < 35 {
        return None;
    }
    if !closes_newest_first.iter().all(|v| v.is_finite()) {
        return None;
    }
    let closes: Vec<f64> = closes_newest_first.iter().rev().copied().collect();
    let fast = ta_ema(&closes, 12);
    let slow = ta_ema(&closes, 26);
    let macd: Vec<f64> = slow
        .iter()
        .enumerate()
        .map(|(i, s)| fast[i + 14] - s)
        .collect();
    let signal = ta_ema(&macd, 9);
    let hist: Vec<f64> = signal
        .iter()
        .enumerate()
        .map(|(i, s)| macd[i + 8] - s)
        .collect();
    if hist.len() < 2 {
        return None;
    }
    Some((hist[hist.len() - 1], hist[hist.len() - 2]))
}

/// EP (Evil Panda) Supertrend twins — the entry gate's only indicator.
/// ATR = Wilder-smoothed true range over `period`; bands = midline ±
/// multiplier × ATR, midline = (high+low)/2 proxied by close (the host has
/// no OHLC, only `current_price` — documented proxy, same class as
/// vol_drift). `None` below `period + 1` closes or on junk (fail-open:
/// no signal, never an invented entry).
/// NO TS COUNTERPART: engine grep confirms zero `supertrend` surface, so there is
/// no parity target to mirror (recorded in the plan). Unbaked candidate screen
/// from a bootcamp spec — unit-tested only, no tick call yet (needs the closes
/// read path).
pub fn supertrend_atr(closes_newest_first: &[f64], period: usize) -> Option<f64> {
    if period == 0 || closes_newest_first.len() < period + 1 {
        return None;
    }
    if !closes_newest_first.iter().all(|v| v.is_finite()) {
        return None;
    }
    let closes: Vec<f64> = closes_newest_first.iter().rev().copied().collect();
    // True range proxied by |Δclose| (no high/low series available).
    let mut trs: Vec<f64> = Vec::with_capacity(closes.len() - 1);
    for w in closes.windows(2) {
        trs.push((w[1] - w[0]).abs());
    }
    if trs.len() < period {
        return None;
    }
    // Wilder seed = SMA of the first `period` TRs, then RMA smoothing.
    let mut atr = trs[..period].iter().sum::<f64>() / period as f64;
    for tr in &trs[period..] {
        atr = (atr * (period as f64 - 1.0) + tr) / period as f64;
    }
    Some(atr)
}

/// Supertrend direction over the newest closes: `Some(true)` = price above
/// the upper band (uptrend — EP's "break above" entry signal), `Some(false)`
/// = below the lower band, `None` on short/junk (fail-open no-signal).
/// Closes are NEWEST-FIRST (host order).
///
/// PROXY, not indicator parity (vol_drift class): real Supertrend ratchets
/// its band bar-to-bar, carrying the previous band forward as the new
/// baseline. This reads ONE fixed-offset band — midline = the close
/// `atr_period` bars back, upper/lower = midline ± multiplier × ATR — so it
/// reports "price above a fixed-offset band" rather than tracking a
/// ratcheting support/resistance. Directionally right for EP's
/// dump-harvest entry (it wants a strong rally above a recent band), and it
/// will fire on a sharp rally and stay silent in a slow grind. Documented
/// divergence, never claimed as tick-exact.
/// NO TS COUNTERPART — same as `supertrend_atr`: an unbaked candidate screen,
/// unit-tested only, no tick call yet. When wired it emits a
/// `decision ... supertrend_break_above` tally; nothing emits that today.
pub fn supertrend_break_above(
    closes_newest_first: &[f64],
    atr_period: usize,
    multiplier: f64,
) -> Option<bool> {
    let atr = supertrend_atr(closes_newest_first, atr_period)?;
    if !multiplier.is_finite() || multiplier <= 0.0 {
        return None;
    }
    let last = *closes_newest_first.first()?;
    if !last.is_finite() {
        return None;
    }
    // Midline proxy: the close one period back (rolling center).
    let mid = *closes_newest_first.get(atr_period)?;
    let upper = mid + multiplier * atr;
    let lower = mid - multiplier * atr;
    Some(last > upper && last > lower)
}

/// EP lane admission (screening): the two hard filters the bootcamp
/// specifies for pool selection — volatility score at or above the floor
/// AND base fee at or above the floor. `volatility_score` is the host's
/// bin σ (`bin_volatility_stddev`).
///
/// FAIL-OPEN on absent legs, matching the host's measured-vs-modeled
/// exclusion rule: a PRESENT-but-below-floor leg blocks, an ABSENT leg
/// never does. This direction is forced by the data, not preference —
/// `base_fee_pct` is datapi-response-only and never persisted
/// (`pool_snapshots` has no fee-pct column, only realized
/// `fees_24h_usd`), so a ledger-only read can never supply it. A
/// fail-closed fee leg would make this gate permanently `false` on every
/// real book — a screen that screens nothing. When the datapi read path
/// lands, the fee leg starts voting with no signature change.
/// NO TS COUNTERPART: engine grep confirms no `ep_lane` / `entry_probe` surface;
/// the only real fee-floor config is `launchScanMinBaseFeePct` (config-service.ts:383,
/// consumed by launch-gate.ts). Unbaked candidate screen — unit-tested only, no tick
/// call yet. When wired it emits a `decision ... ep_lane_admits` tally; nothing
/// emits that today.
pub fn ep_lane_admits(
    volatility_score: Option<f64>,
    vol_floor: f64,
    base_fee_pct: Option<f64>,
    fee_floor_pct: f64,
) -> bool {
    if !vol_floor.is_finite() || !fee_floor_pct.is_finite() {
        return false;
    }
    // Present legs vote; absent legs abstain (fail-open).
    if let Some(score) = volatility_score {
        if !score.is_finite() || score < vol_floor {
            return false;
        }
    }
    if let Some(fee) = base_fee_pct {
        if !fee.is_finite() || fee < fee_floor_pct {
            return false;
        }
    }
    true
}

/// EP exit bypass (bootcamp Part 3 + the user's "don't let PnL go negative
/// before TP" rule): fire when the TA-exhaustion confluence is present AND
/// the position is still in profit OR only marginally down — i.e. BEFORE the
/// trailing stop's own threshold would trigger. The bypass exists so a
/// position that has not yet reached the trailing threshold cannot round-trip
/// a winner into a loser on an exhaustion signal.
/// Legs: `ta_exhausted` (proven kernel verdict), `pnl_pct` (mark PnL as a
/// fraction of deposit), `max_drawdown_pct` (the deepest tolerated dip —
/// the user's adjustable SL, default 0.30). Fires iff confluence AND
/// `pnl_pct > -max_drawdown_pct`. `None` on any missing/non-finite leg
/// (fail-open: never fires without a verdict).
/// NO TS COUNTERPART — unbaked candidate screen, unit-tested only, no tick call yet
/// (needs the TA verdict + mark PnL legs, which the host does not read). When wired
/// it emits a `decision ... ep_exit_bypass` tally; nothing emits that today.
pub fn ep_exit_bypass(
    ta_exhausted: Option<bool>,
    pnl_pct: Option<f64>,
    max_drawdown_pct: f64,
) -> Option<bool> {
    if !max_drawdown_pct.is_finite() || max_drawdown_pct <= 0.0 {
        return None;
    }
    let exhausted = ta_exhausted?;
    let pnl = pnl_pct?;
    if !pnl.is_finite() {
        return None;
    }
    Some(exhausted && pnl > -max_drawdown_pct)
}

/// Static `/status` triple for the loopback listener: (code, reason, body).
/// Shape-only parity with the TS status surface (ok/service/mode); live
/// counts ride the per-tick stdout lines, not this socket.
fn status_json_body() -> (&'static str, &'static str, String) {
    (
        "200",
        "OK",
        r#"{"ok":true,"service":"prismd","mode":"shadow"}"#.to_string(),
    )
}
/// Jev soft consult: fail-open. `Err` (or disabled) → `None` = "no opinion",
pub fn jev_soft_gate(enabled: bool, fetched: Result<f64, &str>) -> Option<f64> {
    if !enabled {
        return None;
    }
    fetched.ok()
}

/// Bend subprocess bridge: shells the `bend` CLI against the kernels source
/// embedded at compile time, so the binary needs no on-disk `kernels.bend`
/// at runtime. Mirrors `bench/bend-parity-harness.ts`: write a tiny probe
/// file importing the kernels, run `bend probe.bend`, parse stdout. Every
/// entry point fails OPEN (`Err`/timeout collapses to `None` at the call
/// site) — a missing or slow `bend` binary must never block a tick.
mod bend {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Kernels source embedded at build time (native/bend/kernels.bend).
    const KERNELS_SRC: &str = include_str!("../../bend/kernels.bend");
    const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
    static PROBE_SEQ: AtomicU64 = AtomicU64::new(0);

    fn probe_dir() -> std::io::Result<PathBuf> {
        let seq = PROBE_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("prismd-bend-{}-{seq}", std::process::id()));
        fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// Run a probe expression against the embedded kernels, bounded by
    /// `PROBE_TIMEOUT`. On timeout the spawning thread is abandoned (the
    /// channel receiver stops waiting) rather than blocking the caller —
    /// a hung `bend` process leaks a thread, never a stuck tick.
    fn run_probe(bend_bin: &str, expr: &str, ret: &str) -> Result<String, String> {
        let dir = probe_dir().map_err(|e| format!("tempdir: {e}"))?;
        fs::write(dir.join("kernels.bend"), KERNELS_SRC)
            .map_err(|e| format!("write kernels: {e}"))?;
        fs::write(
            dir.join("probe.bend"),
            format!("import kernels.bend as K\ndef main() -> {ret}:\n  {expr}\n"),
        )
        .map_err(|e| format!("write probe: {e}"))?;

        let spawned_bin = bend_bin.to_string();
        let probe_path = dir.join("probe.bend");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(Command::new(&spawned_bin).arg(&probe_path).output());
        });
        let result = match rx.recv_timeout(PROBE_TIMEOUT) {
            Ok(Ok(out)) if out.status.success() => String::from_utf8(out.stdout)
                .map(|s| s.trim().to_string())
                .map_err(|e| format!("non-utf8 bend output: {e}")),
            Ok(Ok(out)) => Err(format!(
                "bend exited {:?}: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr)
            )),
            Ok(Err(e)) => Err(format!("spawn {bend_bin}: {e}")),
            Err(_) => Err(format!("bend probe exceeded {PROBE_TIMEOUT:?}")),
        };
        let _ = fs::remove_dir_all(&dir);
        result
    }

    /// Run a `Nat`-valued kernel expression, e.g. `K.clamp_thr(1392n, 30n, 300n)`.
    fn run_nat(bend_bin: &str, expr: &str) -> Result<u64, String> {
        let out = run_probe(bend_bin, expr, "Nat")?;
        out.strip_suffix('n')
            .and_then(|d| d.parse::<u64>().ok())
            .ok_or_else(|| format!("unparseable Bend Nat output: {out:?}"))
    }

    /// Run a `Bool`-valued kernel expression, e.g. `K.fee_exit_fires(True{}, True{}, 40n)`.
    fn run_bool(bend_bin: &str, expr: &str) -> Result<bool, String> {
        match run_probe(bend_bin, expr, "Bool")?.as_str() {
            "True{}" => Ok(true),
            "False{}" => Ok(false),
            other => Err(format!("unparseable Bend Bool output: {other:?}")),
        }
    }

    fn bool_lit(b: bool) -> &'static str {
        if b {
            "True{}"
        } else {
            "False{}"
        }
    }

    /// SHADOW-only: does the proven `K.drift_rejects` kernel say the
    /// [drift-gate] rejects a normal-lane ENTER at this drift? Mirrors
    /// `engine/strategy-service.ts` `driftGateRejected` (strict `<`; at-floor
    /// enters) + `engine/program.ts` `driftHardFloorReason` (normal lane only;
    /// runner/launch exempt at call site). Sign/magnitude split keeps Nat
    /// total: `neg=true, mag=m` means -m bins. `None` on any failure or
    /// non-finite/overflowing input; never acted on by this host.
    pub fn drift_rejects(bend_bin: &str, net_drift_bins: f64, floor_bins: f64) -> Option<bool> {
        if !net_drift_bins.is_finite() || !floor_bins.is_finite() {
            return None;
        }
        // TS floors are integers (default -8); round to whole bins so the
        // shadow matches the compared values exactly.
        let drift = net_drift_bins.round();
        let floor = floor_bins.round();
        let neg = drift < 0.0;
        let mag = drift.abs().clamp(0.0, u64::MAX as f64) as u64;
        let floor_mag = floor.abs().clamp(0.0, u64::MAX as f64) as u64;
        let expr = format!("K.drift_rejects({}, {mag}n, {floor_mag}n)", bool_lit(neg));
        match run_bool(bend_bin, &expr) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("[prismd] bend drift_rejects unavailable: {e}");
                None
            }
        }
    }

    /// Clamp an evolved `min_fee_il_ratio` into `[0.3, 3.0]` via the proven
    /// `K.clamp_thr` kernel (`native/bend/kernels.bend`; LAWS `band_runaway` /
    /// `band_cap_twenty` / `band_floor` / `band_passthrough`). Fixed-point
    /// x100 mapping matches `bench/bend-parity-harness.ts`. `None` on any
    /// failure — callers fall back to the host's own `clamp_fee_il`.
    pub fn clamp_fee_il(bend_bin: &str, ratio: f64) -> Option<f64> {
        if !ratio.is_finite() {
            return None;
        }
        let nat = (ratio * 100.0).round().clamp(0.0, u64::MAX as f64) as u64;
        let lo = (super::FEE_IL_MIN * 100.0).round() as u64;
        let hi = (super::FEE_IL_MAX * 100.0).round() as u64;
        match run_nat(bend_bin, &format!("K.clamp_thr({nat}n, {lo}n, {hi}n)")) {
            Ok(n) => Some(n as f64 / 100.0),
            Err(e) => {
                eprintln!("[prismd] bend clamp_fee_il unavailable, using native clamp: {e}");
                None
            }
        }
    }

    /// SHADOW-only: one full `K.evolve_thr` leg (lift target → nudge → band
    /// pin). Mirrors `engine/strategy-service.ts` `evolveThresholds` for a
    /// single threshold leg. `up` = lift direction, `lnum/lden` = lift
    /// fraction, `lo/hi` = absolute band. `None` on any failure or
    /// non-finite input; never acted on by this host.
    #[allow(clippy::too_many_arguments)]
    pub fn evolve_thr(
        bend_bin: &str,
        current: f64,
        up: bool,
        lift_num: f64,
        lift_den: f64,
        max_change_pct: f64,
        lo: f64,
        hi: f64,
    ) -> Option<f64> {
        for v in [current, lift_num, lift_den, max_change_pct, lo, hi] {
            if !v.is_finite() {
                return None;
            }
        }
        if lift_den == 0.0 {
            return None;
        }
        let nat = |v: f64| (v * 100.0).round().clamp(0.0, u64::MAX as f64) as u64;
        let expr = format!(
            "K.evolve_thr({}n, {}, {}n, {}n, {}n, 100n, {}n, {}n)",
            nat(current),
            bool_lit(up),
            nat(lift_num),
            nat(lift_den),
            nat(max_change_pct),
            nat(lo),
            nat(hi)
        );
        match run_nat(bend_bin, &expr) {
            Ok(n) => Some(n as f64 / 100.0),
            Err(e) => {
                eprintln!("[prismd] bend evolve_thr unavailable: {e}");
                None
            }
        }
    }

    /// SHADOW-only: `K.fee_known` — datapi-only measured flag. Mirrors
    /// `computeMetrics` `feeIlRatioKnown: pool.statsSource === "datapi"`.
    /// Pure bool passthrough; the kernel call proves the wiring, the value
    /// is the host's own comparison. `None` only when Bend is unavailable.
    pub fn fee_known(bend_bin: &str, datapi: bool) -> Option<bool> {
        let expr = format!("K.fee_known({})", bool_lit(datapi));
        match run_bool(bend_bin, &expr) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("[prismd] bend fee_known unavailable: {e}");
                None
            }
        }
    }

    /// SHADOW-only: does the proven `K.fee_exit_fires` kernel say the fee/IL
    /// EXIT gate fires for this `(known, mature, ratio)` triple? Mirrors the
    /// core predicate in `engine/program.ts` `checkFeeIlExit` (fee_il_ratio <
    /// 0.5, `feeIlRatioKnown`, position age >= `MIN_YIELD_EXIT_AGE_MS`) —
    /// NOT its hold-bias override, which stays TS-only. `None` on any
    /// failure or non-finite `ratio`; never acted on by this host.
    pub fn fee_exit_fires(bend_bin: &str, known: bool, mature: bool, ratio: f64) -> Option<bool> {
        if !ratio.is_finite() {
            return None;
        }
        let nat = (ratio * 100.0).round().clamp(0.0, u64::MAX as f64) as u64;
        let expr = format!(
            "K.fee_exit_fires({}, {}, {nat}n)",
            bool_lit(known),
            bool_lit(mature)
        );
        match run_bool(bend_bin, &expr) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("[prismd] bend fee_exit_fires unavailable: {e}");
                None
            }
        }
    }

    /// SHADOW-only: does the proven `K.enter_blocked` kernel say the
    /// [fee-il-gate] hard ENTER floor blocks this pool? Mirrors
    /// `engine/program.ts` `feeIlHardFloorReason` (program.ts:4695-4705):
    /// blocks iff IL protection on AND ratio known (datapi-only) AND
    /// ratio < evolved/banded floor. Observational only — this host does
    /// not admit candidates yet.
    pub fn enter_blocked(
        bend_bin: &str,
        il_on: bool,
        known: bool,
        ratio: f64,
        floor: f64,
    ) -> Option<bool> {
        if !ratio.is_finite() || !floor.is_finite() {
            return None;
        }
        let r = (ratio * 100.0).round().clamp(0.0, u64::MAX as f64) as u64;
        let f = (floor * 100.0).round().clamp(0.0, u64::MAX as f64) as u64;
        let expr = format!(
            "K.enter_blocked({}, {}, {r}n, {f}n)",
            bool_lit(il_on),
            bool_lit(known)
        );
        match run_bool(bend_bin, &expr) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("[prismd] bend enter_blocked unavailable: {e}");
                None
            }
        }
    }

    /// SHADOW-only: does the proven `K.capital_exit` kernel fire on this
    /// danger signal? Mirrors the economics-free half of
    /// `engine/position-loss-cap.ts` `isPositionLossCapBreached` (mark PnL ≤
    /// -(deposited × floorPct)): the host computes `danger` natively from the
    /// ledger (deposited/current/claimed, floorPct = min(maxLossPct,1)), the
    /// kernel proves confidence can never veto it (LAWS `capital_exit_free` /
    /// `capital_exit_quiet`). Observational only — never acted on.
    pub fn capital_exit(bend_bin: &str, danger: bool, confidence: f64) -> Option<bool> {
        if !confidence.is_finite() {
            return None;
        }
        let conf = (confidence * 100.0).round().clamp(0.0, u64::MAX as f64) as u64;
        let expr = format!("K.capital_exit({}, {conf}n)", bool_lit(danger));
        match run_bool(bend_bin, &expr) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("[prismd] bend capital_exit unavailable: {e}");
                None
            }
        }
    }

    /// SHADOW-only: does `K.ta_exhausted` say the TA-exhaustion confluence
    /// fires for this `(rsi_overbought, above_bb_upper, macd_first_green)`
    /// triple? Mirrors the thirteenth-wave spec (`engine/ta-exhaustion.ts`
    /// target): RSI(2) overbought AND (close above BB-upper OR first
    /// MACD-green histogram). The TS side computes the three bools from
    /// `pool_snapshots.current_price` history; this wrapper takes them
    /// precomputed, so no F32 indicator math enters the host either. `None`
    /// only when Bend is unavailable; never acted on. Unwired until the TS
    /// side lands (kernel exercised via CLI probes, LAWS pending strategy
    /// review); exercised by `ta_exhausted_truth_table` + bend-parity TA-exhaustion `it` until the tick shadow takes bools.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn ta_exhausted(
        bend_bin: &str,
        rsi_overbought: bool,
        above_bb_upper: bool,
        macd_first_green: bool,
    ) -> Option<bool> {
        let expr = format!(
            "K.ta_exhausted({}, {}, {})",
            bool_lit(rsi_overbought),
            bool_lit(above_bb_upper),
            bool_lit(macd_first_green)
        );
        match run_bool(bend_bin, &expr) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("[prismd] bend ta_exhausted unavailable: {e}");
                None
            }
        }
    }

    /// SHADOW-only: does the proven `K.accrual_allowed` kernel say paper
    /// notional-fee accrual is allowed for this `(paper, onchain, datapi)`
    /// triple? Mirrors `engine/program.ts`'s `accruePaperPositionFees` guard
    /// (`config.paperTrading && pos.positionPubKey == null && pool.statsSource
    /// === "datapi"`, program.ts:10197-10202). Observational only — this host
    /// does not accrue or write anything.
    pub fn accrual_allowed(
        bend_bin: &str,
        paper: bool,
        onchain: bool,
        datapi: bool,
    ) -> Option<bool> {
        let expr = format!(
            "K.accrual_allowed({}, {}, {})",
            bool_lit(paper),
            bool_lit(onchain),
            bool_lit(datapi)
        );
        match run_bool(bend_bin, &expr) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("[prismd] bend accrual_allowed unavailable: {e}");
                None
            }
        }
    }

    /// SHADOW-only: what does `K.exit_order` pick for this `(tp_hit, ta_hit,
    /// loss_hit)` triple? Mirrors the `decidePositionExit` chain shape
    /// (TP-ladder → TA-exhaustion → loss-side → hold/scale-in,
    /// program.ts:10959-10970): 1n TP, 2n TA, 3n loss, 0n none. Takes branch
    /// verdicts precomputed — pure precedence, never wired into
    /// `checkDeterministicExits` (soak-untouched). DRY-RUN wired per-tick
    /// with tp/TA stubbed false + stored loss legs (see tick); full wiring
    /// waits on `ta-exhaustion.ts` for real TA verdicts.
    pub fn exit_order(bend_bin: &str, tp_hit: bool, ta_hit: bool, loss_hit: bool) -> Option<u64> {
        let expr = format!(
            "K.exit_order({}, {}, {})",
            bool_lit(tp_hit),
            bool_lit(ta_hit),
            bool_lit(loss_hit)
        );
        match run_nat(bend_bin, &expr) {
            Ok(n) => Some(n),
            Err(e) => {
                eprintln!("[prismd] bend exit_order unavailable: {e}");
                None
            }
        }
    }

    /// SHADOW-only: does `K.loss_magnitude_fires` say the loss-cap class fires
    /// for this mark-PnL projection? Native twin of
    /// `engine/position-loss-cap.ts` `isPositionLossCapBreached` (mark PnL
    /// = current + fees + rewards − deposited ≤ -(deposited × min(pct,1))) —
    /// the SAME predicate `loss_cap_danger` computes natively; the kernel is
    /// the proven COMPARISON (at-or-below direction) both the live cap and the
    /// tighter-cap probe consult, with the direction pinned by law instead of
    /// by two Rust call sites. The floor magnitude is computed HERE in native
    /// f64 (deposited × min(pct,1)) because Bend's `Nat` is unary — a kernel
    /// `Nat.mul(100000n, 35n)` costs 20-50s per probe (measured); the kernel
    /// owns the comparison, not the arithmetic. USD legs → Nat cents (×100,
    /// round); `pnl_neg` projects `pnl < 0` (magnitude = |pnl|). `None` on
    /// non-finite/negative-floor legs (caller fail-open: the native
    /// `loss_cap_danger` still votes). Observational only — never acted on.
    pub fn loss_magnitude_fires(
        bend_bin: &str,
        pnl_usd: Option<f64>,
        deposited_usd: Option<f64>,
        max_loss_pct: f64,
    ) -> Option<bool> {
        let (pnl, dep) = (pnl_usd?, deposited_usd?);
        if !pnl.is_finite() || !dep.is_finite() || !max_loss_pct.is_finite() {
            return None;
        }
        // Floor computed natively: Bend `Nat` is unary, so multiplying inside
        // the kernel (`Nat.mul(100000n, 35n)`) builds 3.5M successor nodes and
        // a probe takes 20-50s (measured). The kernel owns the proven
        // COMPARISON (at-or-below); arithmetic stays native f64 like
        // `loss_cap_danger` (position-loss-cap.ts:22-40).
        let floor_usd = dep * max_loss_pct.min(1.0);
        if !floor_usd.is_finite() || floor_usd < 0.0 {
            return None;
        }
        let neg = pnl < 0.0;
        let mag = (pnl.abs() * 100.0).round().clamp(0.0, u64::MAX as f64) as u64;
        let floor_cents = (floor_usd * 100.0).round().clamp(0.0, u64::MAX as f64) as u64;
        let expr = format!(
            "K.loss_magnitude_fires({}, {mag}n, {floor_cents}n)",
            bool_lit(neg)
        );
        match run_bool(bend_bin, &expr) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("[prismd] bend loss_magnitude_fires unavailable: {e}");
                None
            }
        }
    }

    /// SHADOW-only: does `K.dust_exit_fires` say the dust-cleanup arm fires?
    /// Mirrors `engine/program.ts` `isDustExit` (program.ts:4384-4386):
    /// threshold > 0 AND real mark STRICTLY below it. `floor_on` projects
    /// `dustExitUsd > 0` (TS `(dustExitUsd ?? 0) > 0`), so a disabled floor
    /// can never fire even with a $0 mark. `None` on non-finite legs
    /// (caller fail-open: dust never blocks). Observational only.
    pub fn dust_exit_fires(
        bend_bin: &str,
        floor_on: bool,
        mark_usd: Option<f64>,
        floor_usd: Option<f64>,
    ) -> Option<bool> {
        let (mark, floor) = (mark_usd?, floor_usd?);
        if !mark.is_finite() || !floor.is_finite() {
            return None;
        }
        let mark_cents = (mark * 100.0).round().clamp(0.0, u64::MAX as f64) as u64;
        let floor_cents = (floor * 100.0).round().clamp(0.0, u64::MAX as f64) as u64;
        let expr = format!(
            "K.dust_exit_fires({}, {mark_cents}n, {floor_cents}n)",
            bool_lit(floor_on)
        );
        match run_bool(bend_bin, &expr) {
            Ok(b) => Some(b),
            Err(e) => {
                eprintln!("[prismd] bend dust_exit_fires unavailable: {e}");
                None
            }
        }
    }
}

/// Env-driven host config. Names mirror `engine/config-service.ts`
/// (TS stays authoritative):
/// - `SCAN_INTERVAL_MS`: default 600_000, fail-closed outside [10_000, 3_600_000].
/// - `SQLITE_DB_PATH` (canonical; legacy `SQLITE_PATH` fallback): default `prism.db`.
/// - `PAPER_PORTFOLIO_USD`: default 10_000, fail-closed below 1.
/// - `HELIUS_API_KEY`, `TYPESAFE_API_KEY` (`TYPESAFEAI_API` legacy alias),
///   `JEV_BASE_URL`, `JEV_MODEL`, `JEV_TIMEOUT_MS`: passthrough only — read
///   from env, never logged; startup reports set/unset at most.
/// - `JEV_ENABLED`, `BEND_BIN` (default `bend`): as before.
///
/// Absent = documented default; present-but-garbage = `Err` (fail-closed:
/// `main` exits non-zero rather than shadowing with a guessed value).
mod config {
    use std::env;

    pub const SCAN_INTERVAL_DEFAULT_MS: u64 = 600_000;
    pub const SCAN_INTERVAL_MIN_MS: u64 = 10_000;
    pub const SCAN_INTERVAL_MAX_MS: u64 = 3_600_000;
    /// Mirrors engine/config-service.ts validatedNumber("AGENT_HTTP_PORT", 0, 0, 65535).
    /// 0 = disabled (matches TS `if (port === 0) return`).
    pub const AGENT_HTTP_PORT_DEFAULT: u16 = 0;
    pub const AGENT_HTTP_PORT_MAX: u32 = 65_535;
    pub const PAPER_PORTFOLIO_DEFAULT_USD: f64 = 10_000.0;
    pub const PAPER_PORTFOLIO_MIN_USD: f64 = 1.0;
    pub const SQLITE_DEFAULT_PATH: &str = "prism.db";
    /// Mirrors engine/config-service.ts validatedNumber("VOLATILITY_LOOKBACK_SNAPSHOTS", 3, 12).
    pub const VOLATILITY_LOOKBACK_DEFAULT: i64 = 12;
    pub const VOLATILITY_LOOKBACK_MIN: i64 = 3;
    /// Mirrors engine/config-service.ts validatedNumber("VOLATILITY_EXIT_STDDEV", 0, 5).
    pub const VOLATILITY_EXIT_DEFAULT_STDDEV: f64 = 5.0;
    pub const VOLATILITY_EXIT_MIN_STDDEV: f64 = 0.0;
    /// Mirrors engine/config-service.ts validatedNumber("OOR_RECOVERY_LOOKBACK_CYCLES", 3, 10).
    pub const OOR_RECOVERY_LOOKBACK_DEFAULT: i64 = 10;
    pub const OOR_RECOVERY_LOOKBACK_MIN: i64 = 3;
    /// Mirrors engine/config-service.ts validatedNumber("OOR_RECOVERY_HOLD_THRESHOLD", 0, 0.6)
    /// + validatedNumber("OOR_RECOVERY_FORCE_REBALANCE_THRESHOLD", 0, 0.2).
    ///   TS clamps out-of-band to min with a warn; host fails closed on
    ///   garbage/non-finite (absent -> fallback).
    /// + validatedNumber("COMPOUND_GAS_BUFFER_USD", 0, 0.05) — same clamp shape.
    ///
    /// PARKED with `compound_approved` (no tick call — needs per-claim leg).
    #[cfg_attr(not(test), allow(dead_code))]
    pub const MIN_COMPOUND_FEES_DEFAULT_USD: f64 = 0.5;
    #[cfg_attr(not(test), allow(dead_code))]
    pub const MIN_COMPOUND_FEES_MIN_USD: f64 = 0.0;
    #[cfg_attr(not(test), allow(dead_code))]
    pub const COMPOUND_GAS_BUFFER_DEFAULT_USD: f64 = 0.05;
    #[cfg_attr(not(test), allow(dead_code))]
    pub const COMPOUND_GAS_BUFFER_MIN_USD: f64 = 0.0;
    pub const OOR_RECOVERY_HOLD_DEFAULT: f64 = 0.6;
    pub const OOR_RECOVERY_HOLD_MIN: f64 = 0.0;
    pub const OOR_RECOVERY_FORCE_DEFAULT: f64 = 0.2;
    pub const OOR_RECOVERY_FORCE_MIN: f64 = 0.0;
    /// + validatedNumber("OOR_GRACE_PERIOD_CYCLES", 0, 3)
    /// + validatedNumber("PAPER_VALIDATION_MIN_DAYS", 0, 7).
    ///   TS clamps out-of-band to min with a warn; host fails closed on
    ///   garbage/non-finite (absent -> fallback).
    pub const MIN_REBALANCE_INTERVAL_DEFAULT_MS: i64 = 86_400_000;
    pub const MIN_REBALANCE_INTERVAL_MIN_MS: i64 = 0;
    pub const OOR_GRACE_PERIOD_DEFAULT_CYCLES: i64 = 3;
    pub const OOR_GRACE_PERIOD_MIN_CYCLES: i64 = 0;
    pub const PAPER_VALIDATION_MIN_DAYS_DEFAULT: f64 = 7.0;
    pub const PAPER_VALIDATION_MIN_DAYS_MIN: f64 = 0.0;
    /// Mirrors engine/config-service.ts validatedNumber("MAX_REBALANCE_RANGE_BINS", 1, 200, 200).
    /// Proposed-rebalance width cap (TS default = max = 200; min 1).
    pub const MAX_REBALANCE_RANGE_DEFAULT_BINS: i64 = 200;
    pub const MAX_REBALANCE_RANGE_MIN_BINS: i64 = 1;
    pub const MAX_REBALANCE_RANGE_MAX_BINS: i64 = 200;
    /// Mirrors engine/config-service.ts validatedNumber("STOP_LOSS_PCT", 0, 0.15).
    /// HOLD/REBALANCE drawdown veto (TS default 0.15; exact comparison has no
    /// disabled arm — pct 0 vetoes any loss).
    pub const STOP_LOSS_DEFAULT_PCT: f64 = 0.15;
    pub const STOP_LOSS_MIN_PCT: f64 = 0.0;
    /// Mirrors engine/config-service.ts validatedNumber("REBALANCE_GAS_COST_SOL", 0, 0.01)
    /// + validatedNumber("SOL_PRICE_USD", 0, 150, 10_000)
    /// + validatedNumber("GAS_AWARE_MIN_DAYS_OF_FEES_PAID_AHEAD", 0, 3).
    ///   TS clamps below-min to min and above-max to max with a warn (absent ->
    ///   fallback); the host fails closed on garbage/non-finite instead.
    pub const REBALANCE_GAS_COST_DEFAULT_SOL: f64 = 0.01;
    pub const REBALANCE_GAS_COST_MIN_SOL: f64 = 0.0;
    pub const SOL_PRICE_DEFAULT_USD: f64 = 150.0;
    pub const SOL_PRICE_MIN_USD: f64 = 0.0;
    pub const SOL_PRICE_MAX_USD: f64 = 10_000.0;
    /// Mirrors `PUBLIC_SOLANA_RPC_URL` (config-service.ts:42) — the fallback
    /// when `SOLANA_RPC_URL` is absent. Live mode should set Helius.
    pub const PUBLIC_SOLANA_RPC_URL: &str = "https://api.mainnet-beta.solana.com";
    pub const GAS_AWARE_MIN_DAYS_DEFAULT: f64 = 3.0;
    pub const GAS_AWARE_MIN_DAYS_MIN: f64 = 0.0;
    /// Mirrors engine/config-service.ts validatedNumber("MAX_POSITION_LOSS_PCT", 0, 0.35, 1).
    /// NOTE: TS clamps to [0,1] with a warn and disables at ≤0; the host fails
    /// closed on garbage/non-finite instead (absent -> 0.35, same fallback).
    pub const MAX_POSITION_LOSS_DEFAULT_PCT: f64 = 0.35;
    pub const MAX_POSITION_LOSS_MAX_PCT: f64 = 1.0;
    /// Mirrors engine/config-service.ts validatedNumber("IL_DOMINANCE_EXIT_FACTOR", 1, 2)
    /// + validatedNumber("IL_DOMINANCE_MIN_USD", 0, 5). TS has no max arm (open
    ///   range above min); the host matches (min-only, fail-closed garbage).
    pub const IL_DOMINANCE_EXIT_FACTOR_DEFAULT: f64 = 2.0;
    pub const IL_DOMINANCE_EXIT_FACTOR_MIN: f64 = 1.0;
    pub const IL_DOMINANCE_MIN_DEFAULT_USD: f64 = 5.0;
    pub const IL_DOMINANCE_MIN_MIN_USD: f64 = 0.0;
    /// Mirrors engine/config-service.ts validatedNumber("DUST_EXIT_USD", 0, 5).
    /// Dust-cleanup EXIT arm (program.ts:4384-4386): real mark STRICTLY below
    /// the threshold and the threshold itself > 0. 0 disables (TS `(x ?? 0) > 0`).
    pub const DUST_EXIT_DEFAULT_USD: f64 = 5.0;
    pub const DUST_EXIT_MIN_USD: f64 = 0.0;
    /// Mirrors validatedNumber("EVOLUTION_INTERVAL", 1, 5, 100) — min closed
    /// outcomes before the evolution shadow consults (TS tryEvolveThresholds
    /// returns early below interval; program.ts:6032-6042).
    pub const EVOLUTION_INTERVAL_DEFAULT: i64 = 5;
    pub const EVOLUTION_INTERVAL_MIN: i64 = 1;
    /// Mirrors validatedNumber("EVOLUTION_MAX_CHANGE_PCT", 0.01, 0.2, 1.0) —
    /// the ±nudge cap per round (TS default 0.2).
    pub const EVOLUTION_MAX_CHANGE_DEFAULT_PCT: f64 = 0.2;
    pub const EVOLUTION_MAX_CHANGE_MIN_PCT: f64 = 0.01;
    pub const EVOLUTION_MAX_CHANGE_MAX_PCT: f64 = 1.0;
    /// Mirrors engine/config-service.ts validatedNumber("MAX_OPEN_POSITIONS", 1, 3).
    /// Portfolio-wide concurrent-position cap (TS default 3; soak unit runs 8).
    pub const MAX_OPEN_POSITIONS_DEFAULT: i64 = 3;
    pub const MAX_OPEN_POSITIONS_MIN: i64 = 1;
    /// Mirrors engine/config-service.ts validatedNumber("MAX_POSITIONS_PER_POOL", 1, 2).
    /// Per-pool concurrent-position cap (TS default 2; legacy single-position = 1).
    pub const MAX_POSITIONS_PER_POOL_DEFAULT: i64 = 2;
    pub const MAX_POSITIONS_PER_POOL_MIN: i64 = 1;
    /// Mirrors engine/config-service.ts REALIZED_PNL_HALT_* — the anti-bleed
    /// breaker: while trailing realized PnL over the last `window` closed
    /// positions nets below `threshold`, pause new ENTERs (EXIT/REBALANCE
    /// stay free). Enabled flag defaults false (fail-open: halt never fires
    /// unless explicitly armed).
    pub const REALIZED_PNL_HALT_WINDOW_DEFAULT: i64 = 100;
    pub const REALIZED_PNL_HALT_WINDOW_MIN: i64 = 1;
    pub const REALIZED_PNL_HALT_THRESHOLD_DEFAULT_USD: f64 = -20.0;
    /// Mirrors engine/config-service.ts validatedNumber("MAX_PER_POOL_ALLOCATION_PCT", 0, 0.4, 1.0).
    /// Per-pool portfolio-share cap: aggregate currentValueUsd on one pool
    /// may not exceed this fraction of the portfolio (TS default 0.4).
    pub const MAX_PER_POOL_ALLOCATION_DEFAULT_PCT: f64 = 0.4;
    pub const MAX_PER_POOL_ALLOCATION_MIN_PCT: f64 = 0.0;
    pub const MAX_PER_POOL_ALLOCATION_MAX_PCT: f64 = 1.0;
    /// Mirrors engine/config-service.ts validatedNumber("MAX_ENTRY_SIZE_USD", ENTRY_SIZE_FLOOR_USD, ENTRY_SIZE_CAP_USD).
    /// Hard USD ceiling per conservative entry (TS default 500, floor 10).
    pub const MAX_ENTRY_SIZE_DEFAULT_USD: f64 = 500.0;
    pub const MAX_ENTRY_SIZE_MIN_USD: f64 = 10.0;
    /// Mirrors engine/config-service.ts validatedNumber("MIN_FEE_IL_RATIO", 0, 1.2, 10).
    /// NOTE: validatedNumber CLAMPS out-of-band values to [min,max] with a
    /// warn (absent/unparseable -> fallback); the host's numeric parsers
    /// fail-closed instead, so garbage MIN_FEE_IL_RATIO exits 2 rather than
    /// shadowing against a guessed floor. Direction is the same: absent=1.2.
    pub const MIN_FEE_IL_RATIO_DEFAULT: f64 = 1.2;
    pub const MIN_FEE_IL_RATIO_MIN: f64 = 0.0;
    pub const MIN_FEE_IL_RATIO_MAX: f64 = 10.0;
    /// Mirrors engine/config-service.ts:1308 validatedNumber("VOLUME_AUTH_THRESHOLD", 0, 0.7, 1) — the
    /// config-seed fallback for the auth evolution leg.
    pub const VOLUME_AUTH_DEFAULT: f64 = 0.7;
    pub const VOLUME_AUTH_MIN: f64 = 0.0;
    pub const VOLUME_AUTH_MAX: f64 = 1.0;
    /// Mirrors engine/config-service.ts:1317 validatedNumber("MIN_BIN_UTILIZATION", 0, 0.3, 1) — the
    /// config-seed fallback for the util evolution leg.
    pub const MIN_BIN_UTIL_DEFAULT: f64 = 0.3;
    pub const MIN_BIN_UTIL_MIN: f64 = 0.0;
    pub const MIN_BIN_UTIL_MAX: f64 = 1.0;
    /// Mirrors engine/config-service.ts:1934 validatedNumber("DISCOVERY_MIN_TVL_USD", 0, 1_000_000)
    /// — the screener/discovery TVL floor (NOT MIN_POOL_TVL_USD). TS clamps
    /// below-min to 0 with a warn; the host fails closed on out-of-band
    /// (house rule, same as VOLUME_AUTH above). Absent = 1,000,000.
    pub const DISCOVERY_MIN_TVL_DEFAULT: f64 = 1_000_000.0;
    pub const DISCOVERY_MIN_TVL_MIN: f64 = 0.0;
    /// Mirrors engine/config-service.ts:1935 validatedNumber("DISCOVERY_MIN_FEE_RATIO", 0, 1.5)
    /// — the annualized fee/TVL floor (`fees24h×365/tvl`) the screener
    /// ranks/filters candidates on. No max arm in TS (open range). Absent = 1.5.
    pub const DISCOVERY_MIN_FEE_RATIO_DEFAULT: f64 = 1.5;
    pub const DISCOVERY_MIN_FEE_RATIO_MIN: f64 = 0.0;
    /// Mirrors engine/config-service.ts:2338-2343 `METEORA_POOLS_URL`
    /// (Config.string + default) — the discovery LIST endpoint. Kept
    /// VERBATIM including empty (TS only defaults on absence; an empty
    /// string makes the fetch fail → discovery falls back, exactly as TS).
    pub const DEFAULT_METEORA_POOLS_URL: &str =
        "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc";
    pub const MIN_YIELD_EXIT_AGE_DEFAULT_MS: i64 = 43_200_000;
    pub const MIN_YIELD_EXIT_AGE_MIN_MS: i64 = 0;
    pub const MIN_YIELD_EXIT_AGE_MAX_MS: i64 = 172_800_000;
    /// Mirrors engine/config-service.ts validatedNumber("MARKET_SCAN_MAX_NEGATIVE_DRIFT_BINS", -100, -8, 0).
    /// NOTE: TS clamps out-of-band to [-100,0] with a warn; the host fails
    /// closed instead (garbage/out-of-band -> exit 2).
    pub const MAX_NEGATIVE_DRIFT_DEFAULT_BINS: f64 = -8.0;
    pub const MAX_NEGATIVE_DRIFT_MIN_BINS: f64 = -100.0;
    pub const MAX_NEGATIVE_DRIFT_MAX_BINS: f64 = 0.0;
    #[derive(Debug)]
    pub struct Config {
        pub sqlite_path: String,
        pub scan_interval_ms: u64,
        pub paper_portfolio_usd: f64,
        pub jev_enabled: bool,
        pub bend_bin: String,
        pub min_yield_exit_age_ms: i64,
        pub paper_trading: bool,
        pub il_protection_enabled: bool,
        pub min_fee_il_ratio: f64,
        pub max_negative_drift_bins: f64,
        pub volatility_lookback_snapshots: i64,
        pub volatility_exit_stddev: f64,
        pub oor_recovery_lookback_cycles: i64,
        pub max_position_loss_pct: f64,
        pub evolution_interval: i64,
        pub evolution_max_change_pct: f64,
        pub volume_auth_threshold: f64,
        pub min_bin_utilization: f64,
        pub enable_pool_discovery: bool,
        pub discovery_min_tvl_usd: f64,
        pub discovery_min_fee_ratio: f64,
        pub meteora_pools_url: String,
        pub max_open_positions: i64,
        pub max_positions_per_pool: i64,
        pub stop_loss_pct: f64,
        pub max_per_pool_allocation_pct: f64,
        pub max_entry_size_usd: f64,
        pub realized_pnl_halt_enabled: bool,
        pub realized_pnl_halt_window: i64,
        pub realized_pnl_halt_threshold_usd: f64,
        pub max_rebalance_range_bins: i64,
        pub rebalance_gas_cost_sol: f64,
        pub sol_price_usd: f64,
        pub gas_aware_min_days: f64,
        pub oor_recovery_hold_threshold: f64,
        pub oor_recovery_force_threshold: f64,
        pub min_rebalance_interval_ms: i64,
        pub oor_grace_period_cycles: i64,
        pub paper_validation_min_days: f64,
        pub paper_validation_enforce: bool,
        pub il_dominance_exit_factor: f64,
        pub il_dominance_min_usd: f64,
        pub dust_exit_usd: f64,
        pub agent_http_port: u16,
        /// Solana JSON-RPC endpoint. Absent → public mainnet-beta (TS's
        /// `PUBLIC_SOLANA_RPC_URL` fallback, config-service.ts:42). Live mode
        /// should set `SOLANA_RPC_URL` (Helius); paper mode never uses it.
        pub solana_rpc_url: String,
        /// Meteora Data API base URL (default `https://dlmm.datapi.meteora.ag`)
        /// — feeds the tick's live statsSource tier; the `--datapi-probe` CLI
        /// reads the same env var directly.
        pub meteora_data_api_url: String,
        /// Days of `prismd_pool_history` rows to keep (host mirror of TS's
        /// `SNAPSHOT_RETENTION_DAYS`, validatedNumber(1, 14): default 14,
        /// min 1). The host prunes on every write — an indexed no-op delete
        /// most ticks — where TS sweeps once per day; same cutoff, less state.
        pub snapshot_retention_days: i64,
        /// GeckoTerminal tier master switch (wave 98; default ON — TS's
        /// `GECKO_TERMINAL_ENABLED !== false`). Off → a datapi miss falls
        /// straight to legs-None (fail-open, no gas verdict).
        pub gecko_terminal_enabled: bool,
        /// GeckoTerminal API base (default `https://api.geckoterminal.com/api/v2`,
        /// TS DEFAULT_BASE_URL). Keyless; paced to 28 req/min in `mod gecko`.
        pub gecko_base_url: String,
        /// Wallet pubkey (base58, 32 bytes). Empty = walletless, exactly like
        /// TS `adapter.hasWallet() === false`: live execution is a no-op and
        /// the wallet balance read is skipped. Validated on load — a junk
        /// address must fail closed at config time, not produce an RPC error
        /// every tick.
        pub wallet_pubkey: String,
        /// Jupiter price API key — sent as `x-api-key` on the primary price
        /// host; empty = keyless (the lite fallback needs no key). Passthrough:
        /// startup reports set/unset, never the value.
        pub jupiter_api_key: String,
        pub ticks: Option<u64>,
    }

    /// Parse-or-default for `SCAN_INTERVAL_MS`; `Err` on garbage/out-of-band.
    pub fn parse_scan_interval_ms(raw: Option<&str>) -> Result<u64, String> {
        let Some(s) = raw else {
            return Ok(SCAN_INTERVAL_DEFAULT_MS);
        };
        let v: u64 = s
            .trim()
            .parse()
            .map_err(|_| format!("SCAN_INTERVAL_MS={s:?} is not a number"))?;
        if (SCAN_INTERVAL_MIN_MS..=SCAN_INTERVAL_MAX_MS).contains(&v) {
            Ok(v)
        } else {
            Err(format!(
                "SCAN_INTERVAL_MS={v} outside [{SCAN_INTERVAL_MIN_MS}, {SCAN_INTERVAL_MAX_MS}]"
            ))
        }
    }

    /// Parse-or-default for `AGENT_HTTP_PORT`; `Err` on garbage/out-of-band.
    /// Absent -> 0 (disabled, matching TS). Only feeds the local status listener.
    pub fn parse_agent_http_port(raw: Option<&str>) -> Result<u16, String> {
        let Some(s) = raw else {
            return Ok(AGENT_HTTP_PORT_DEFAULT);
        };
        let v: u32 = s
            .trim()
            .parse()
            .map_err(|_| format!("AGENT_HTTP_PORT={s:?} is not a number"))?;
        if v <= AGENT_HTTP_PORT_MAX {
            Ok(v as u16)
        } else {
            Err(format!(
                "AGENT_HTTP_PORT={v} outside [0, {AGENT_HTTP_PORT_MAX}]"
            ))
        }
    }
    /// Parse-or-default for `PAPER_PORTFOLIO_USD`; `Err` on garbage or < 1.
    pub fn parse_paper_portfolio_usd(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(PAPER_PORTFOLIO_DEFAULT_USD);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("PAPER_PORTFOLIO_USD={s:?} is not a number"))?;
        if v.is_finite() && v >= PAPER_PORTFOLIO_MIN_USD {
            Ok(v)
        } else {
            Err(format!(
                "PAPER_PORTFOLIO_USD={s:?} must be finite and >= {PAPER_PORTFOLIO_MIN_USD}"
            ))
        }
    }

    /// `PAPER_TRADING`: true unless explicitly set to a recognized false
    /// value. Mirrors `Config.boolean("PAPER_TRADING").pipe(Effect.orElseSucceed(() => true))`
    /// in engine/config-service.ts — paper trading is the fail-safe default;
    /// absent or garbage both resolve to true, matching `orElseSucceed`.
    pub fn parse_paper_trading(raw: Option<&str>) -> bool {
        !matches!(
            raw.map(str::trim).map(str::to_lowercase).as_deref(),
            Some("false") | Some("0") | Some("no")
        )
    }

    /// Canonical `SQLITE_DB_PATH`, legacy `SQLITE_PATH` fallback, else default.
    /// Empty values are skipped (an explicit empty canonical falls to legacy).
    pub fn resolve_sqlite_path(db_path: Option<&str>, legacy: Option<&str>) -> String {
        [db_path, legacy]
            .into_iter()
            .flatten()
            .map(str::trim)
            .find(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| SQLITE_DEFAULT_PATH.into())
    }

    /// `IL_PROTECTION_ENABLED`: true unless explicitly set to a recognized
    /// false value. Mirrors `Config.boolean("IL_PROTECTION_ENABLED").pipe(
    /// Effect.orElseSucceed(() => true))` — protection is the fail-safe
    /// default; absent or garbage both resolve to true.
    pub fn parse_il_protection_enabled(raw: Option<&str>) -> bool {
        !matches!(
            raw.map(str::trim).map(str::to_lowercase).as_deref(),
            Some("false") | Some("0") | Some("no")
        )
    }

    fn flag(k: &str) -> bool {
        matches!(env::var(k).as_deref(), Ok("1") | Ok("true"))
    }
    /// Parse-or-default for `MIN_FEE_IL_RATIO`; `Err` on garbage/out-of-band.
    /// Absent -> 1.2, matching validatedNumber's fallback. NOTE: TS clamps
    /// out-of-band to [0,10] with a warn; this host fails closed instead
    /// (documented at the consts above).
    pub fn parse_min_fee_il_ratio(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(MIN_FEE_IL_RATIO_DEFAULT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MIN_FEE_IL_RATIO={s:?} is not a number"))?;
        if v.is_finite() && (MIN_FEE_IL_RATIO_MIN..=MIN_FEE_IL_RATIO_MAX).contains(&v) {
            Ok(v)
        } else {
            Err(format!(
                "MIN_FEE_IL_RATIO={v} outside [{MIN_FEE_IL_RATIO_MIN}, {MIN_FEE_IL_RATIO_MAX}]"
            ))
        }
    }

    /// Parse-or-default for `MARKET_SCAN_MAX_NEGATIVE_DRIFT_BINS`; `Err` on
    /// garbage/out-of-band. Absent -> -8, matching validatedNumber's
    /// fallback. NOTE: TS clamps to [-100,0]; this host fails closed.
    pub fn parse_max_negative_drift_bins(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(MAX_NEGATIVE_DRIFT_DEFAULT_BINS);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MARKET_SCAN_MAX_NEGATIVE_DRIFT_BINS={s:?} is not a number"))?;
        if v.is_finite() && (MAX_NEGATIVE_DRIFT_MIN_BINS..=MAX_NEGATIVE_DRIFT_MAX_BINS).contains(&v)
        {
            Ok(v)
        } else {
            Err(format!(
                "MARKET_SCAN_MAX_NEGATIVE_DRIFT_BINS={v} outside [{MAX_NEGATIVE_DRIFT_MIN_BINS}, {MAX_NEGATIVE_DRIFT_MAX_BINS}]"
            ))
        }
    }

    /// Parse-or-default for `VOLATILITY_LOOKBACK_SNAPSHOTS` / `OOR_RECOVERY_LOOKBACK_CYCLES`.
    /// Absent -> TS fallback (12 / 10); garbage/below-min -> `Err` (host fails
    /// closed where TS validatedNumber falls back — same direction documented
    /// at the IL-floor consts). Only feeds the drift shadow's ring cap.
    pub fn parse_volatility_lookback(raw: Option<&str>) -> Result<i64, String> {
        let Some(s) = raw else {
            return Ok(VOLATILITY_LOOKBACK_DEFAULT);
        };
        let v: i64 = s
            .trim()
            .parse()
            .map_err(|_| format!("VOLATILITY_LOOKBACK_SNAPSHOTS={s:?} is not a number"))?;
        if v >= VOLATILITY_LOOKBACK_MIN {
            Ok(v)
        } else {
            Err(format!(
                "VOLATILITY_LOOKBACK_SNAPSHOTS={v} below min {VOLATILITY_LOOKBACK_MIN}"
            ))
        }
    }
    /// Parse-or-default for `VOLATILITY_EXIT_STDDEV`. Absent -> TS fallback
    /// 5; garbage/non-finite/below-min -> `Err` (host fails closed where TS
    /// validatedNumber falls back). Only feeds the vol-EXIT shadow.
    pub fn parse_volatility_exit_stddev(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(VOLATILITY_EXIT_DEFAULT_STDDEV);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("VOLATILITY_EXIT_STDDEV={s:?} is not a number"))?;
        if v.is_finite() && v >= VOLATILITY_EXIT_MIN_STDDEV {
            Ok(v)
        } else {
            Err(format!(
                "VOLATILITY_EXIT_STDDEV={v} below min {VOLATILITY_EXIT_MIN_STDDEV}"
            ))
        }
    }

    pub fn parse_oor_recovery_lookback(raw: Option<&str>) -> Result<i64, String> {
        let Some(s) = raw else {
            return Ok(OOR_RECOVERY_LOOKBACK_DEFAULT);
        };
        let v: i64 = s
            .trim()
            .parse()
            .map_err(|_| format!("OOR_RECOVERY_LOOKBACK_CYCLES={s:?} is not a number"))?;
        if v >= OOR_RECOVERY_LOOKBACK_MIN {
            Ok(v)
        } else {
            Err(format!(
                "OOR_RECOVERY_LOOKBACK_CYCLES={v} below min {OOR_RECOVERY_LOOKBACK_MIN}"
            ))
        }
    }
    /// Parse-or-default for `MIN_REBALANCE_INTERVAL_MS` /
    /// `OOR_GRACE_PERIOD_CYCLES` / `PAPER_VALIDATION_MIN_DAYS`. Absent -> TS
    /// fallbacks (86400000 / 3 / 7); garbage/below-min -> `Err`. Only feed
    /// the interval + paper shadows.
    pub fn parse_min_rebalance_interval_ms(raw: Option<&str>) -> Result<i64, String> {
        let Some(s) = raw else {
            return Ok(MIN_REBALANCE_INTERVAL_DEFAULT_MS);
        };
        let v: i64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MIN_REBALANCE_INTERVAL_MS={s:?} is not a number"))?;
        if v >= MIN_REBALANCE_INTERVAL_MIN_MS {
            Ok(v)
        } else {
            Err(format!(
                "MIN_REBALANCE_INTERVAL_MS={v} below min {MIN_REBALANCE_INTERVAL_MIN_MS}"
            ))
        }
    }
    pub fn parse_oor_grace_period_cycles(raw: Option<&str>) -> Result<i64, String> {
        let Some(s) = raw else {
            return Ok(OOR_GRACE_PERIOD_DEFAULT_CYCLES);
        };
        let v: i64 = s
            .trim()
            .parse()
            .map_err(|_| format!("OOR_GRACE_PERIOD_CYCLES={s:?} is not a number"))?;
        if v >= OOR_GRACE_PERIOD_MIN_CYCLES {
            Ok(v)
        } else {
            Err(format!(
                "OOR_GRACE_PERIOD_CYCLES={v} below min {OOR_GRACE_PERIOD_MIN_CYCLES}"
            ))
        }
    }
    pub fn parse_paper_validation_min_days(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(PAPER_VALIDATION_MIN_DAYS_DEFAULT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("PAPER_VALIDATION_MIN_DAYS={s:?} is not a number"))?;
        if v.is_finite() && v >= PAPER_VALIDATION_MIN_DAYS_MIN {
            Ok(v)
        } else {
            Err(format!(
                "PAPER_VALIDATION_MIN_DAYS={v} must be finite and >= {PAPER_VALIDATION_MIN_DAYS_MIN}"
            ))
        }
    }
    /// Parse-or-default for `OOR_RECOVERY_HOLD_THRESHOLD` /
    /// `OOR_RECOVERY_FORCE_REBALANCE_THRESHOLD`. Absent -> TS fallbacks
    /// (0.6 / 0.2); garbage/non-finite/below-min -> `Err`. Only feed the
    /// recovery shadow.
    pub fn parse_oor_recovery_hold(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(OOR_RECOVERY_HOLD_DEFAULT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("OOR_RECOVERY_HOLD_THRESHOLD={s:?} is not a number"))?;
        if v.is_finite() && v >= OOR_RECOVERY_HOLD_MIN {
            Ok(v)
        } else {
            Err(format!(
                "OOR_RECOVERY_HOLD_THRESHOLD={v} must be finite and >= {OOR_RECOVERY_HOLD_MIN}"
            ))
        }
    }
    pub fn parse_oor_recovery_force(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(OOR_RECOVERY_FORCE_DEFAULT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("OOR_RECOVERY_FORCE_REBALANCE_THRESHOLD={s:?} is not a number"))?;
        if v.is_finite() && v >= OOR_RECOVERY_FORCE_MIN {
            Ok(v)
        } else {
            Err(format!(
                "OOR_RECOVERY_FORCE_REBALANCE_THRESHOLD={v} must be finite and >= {OOR_RECOVERY_FORCE_MIN}"
            ))
        }
    }
    /// Parse-or-default for `MIN_COMPOUND_FEES_USD` / `COMPOUND_GAS_BUFFER_USD`.
    /// Absent -> TS fallbacks (0.5 / 0.05); garbage/non-finite/below-min ->
    /// `Err`. PARKED with `compound_approved` (no tick call).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn parse_min_compound_fees_usd(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(MIN_COMPOUND_FEES_DEFAULT_USD);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MIN_COMPOUND_FEES_USD={s:?} is not a number"))?;
        if v.is_finite() && v >= MIN_COMPOUND_FEES_MIN_USD {
            Ok(v)
        } else {
            Err(format!(
                "MIN_COMPOUND_FEES_USD={v} must be finite and >= {MIN_COMPOUND_FEES_MIN_USD}"
            ))
        }
    }
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn parse_compound_gas_buffer_usd(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(COMPOUND_GAS_BUFFER_DEFAULT_USD);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("COMPOUND_GAS_BUFFER_USD={s:?} is not a number"))?;
        if v.is_finite() && v >= COMPOUND_GAS_BUFFER_MIN_USD {
            Ok(v)
        } else {
            Err(format!(
                "COMPOUND_GAS_BUFFER_USD={v} must be finite and >= {COMPOUND_GAS_BUFFER_MIN_USD}"
            ))
        }
    }
    /// Parse-or-default for `MAX_REBALANCE_RANGE_BINS`. Absent -> 200 (TS
    /// fallback = max); garbage/out-of-[1,200] -> `Err`. Only feeds the
    /// band-health shadow's width arm.
    pub fn parse_max_rebalance_range_bins(raw: Option<&str>) -> Result<i64, String> {
        let Some(s) = raw else {
            return Ok(MAX_REBALANCE_RANGE_DEFAULT_BINS);
        };
        let v: i64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MAX_REBALANCE_RANGE_BINS={s:?} is not a number"))?;
        if (MAX_REBALANCE_RANGE_MIN_BINS..=MAX_REBALANCE_RANGE_MAX_BINS).contains(&v) {
            Ok(v)
        } else {
            Err(format!(
                "MAX_REBALANCE_RANGE_BINS={v} outside [{MAX_REBALANCE_RANGE_MIN_BINS}, {MAX_REBALANCE_RANGE_MAX_BINS}]"
            ))
        }
    }
    /// Parse-or-default for `REBALANCE_GAS_COST_SOL` / `SOL_PRICE_USD` /
    /// `GAS_AWARE_MIN_DAYS_OF_FEES_PAID_AHEAD`. Absent -> TS fallbacks
    /// (0.01 / 150 / 3); garbage/non-finite/below-min (or above-max for SOL)
    /// -> `Err`. Only feed the gas shadow.
    pub fn parse_rebalance_gas_cost_sol(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(REBALANCE_GAS_COST_DEFAULT_SOL);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("REBALANCE_GAS_COST_SOL={s:?} is not a number"))?;
        if v.is_finite() && v >= REBALANCE_GAS_COST_MIN_SOL {
            Ok(v)
        } else {
            Err(format!(
                "REBALANCE_GAS_COST_SOL={v} must be finite and >= {REBALANCE_GAS_COST_MIN_SOL}"
            ))
        }
    }
    pub fn parse_sol_price_usd(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(SOL_PRICE_DEFAULT_USD);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("SOL_PRICE_USD={s:?} is not a number"))?;
        if v.is_finite() && (SOL_PRICE_MIN_USD..=SOL_PRICE_MAX_USD).contains(&v) {
            Ok(v)
        } else {
            Err(format!(
                "SOL_PRICE_USD={v} outside [{SOL_PRICE_MIN_USD}, {SOL_PRICE_MAX_USD}]"
            ))
        }
    }
    /// Parse-or-default for `SOLANA_RPC_URL`. Absent or whitespace-only ->
    /// TS's public mainnet-beta fallback. No scheme validation: a wrong URL is
    /// an ops-visible one-line RPC failure, not a silent misroute.
    pub fn parse_solana_rpc_url(raw: Option<&str>) -> String {
        match raw.map(str::trim) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => PUBLIC_SOLANA_RPC_URL.to_string(),
        }
    }

    /// Parse-or-default for `METEORA_DATA_API_URL` (absent or whitespace-only
    /// → the TS default, same shape as the RPC URL). A bad URL surfaces as a
    /// per-pool fetch failure → unknown measured flags, never a config exit.
    pub fn parse_data_api_url(raw: Option<&str>) -> String {
        match raw.map(str::trim) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => crate::datapi::DEFAULT_BASE_URL.to_string(),
        }
    }

    /// Parse-or-default for `SNAPSHOT_RETENTION_DAYS` — mirror of TS
    /// `validatedNumber("SNAPSHOT_RETENTION_DAYS", 1, 14)`: default 14,
    /// reject sub-1 and garbage (host fail-closed convention). No upper
    /// bound — the writer's cutoff saturates, so an oversized value degrades
    /// to pruning NOTHING, never everything (pinned by the writer test).
    pub fn parse_snapshot_retention_days(raw: Option<&str>) -> Result<i64, String> {
        let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
            return Ok(14);
        };
        let v: i64 = s
            .parse()
            .map_err(|_| format!("SNAPSHOT_RETENTION_DAYS={s:?} is not a number"))?;
        if v < 1 {
            return Err(format!("SNAPSHOT_RETENTION_DAYS={v} below min 1"));
        }
        Ok(v)
    }

    /// Parse-or-default for `GECKO_TERMINAL_API_URL` (absent/whitespace →
    /// the TS default `mod gecko::DEFAULT_BASE_URL`, same URL shape).
    pub fn parse_gecko_base_url(raw: Option<&str>) -> String {
        match raw.map(str::trim) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => crate::gecko::DEFAULT_BASE_URL.to_string(),
        }
    }

    /// `GECKO_TERMINAL_ENABLED`: ON unless explicitly set to a recognized
    /// false value — TS's `GECKO_TERMINAL_ENABLED !== false` (default-on
    /// tier); absent/garbage both resolve to true.
    pub fn parse_gecko_enabled(raw: Option<&str>) -> bool {
        !matches!(
            raw.map(str::trim).map(str::to_lowercase).as_deref(),
            Some("false") | Some("0") | Some("no")
        )
    }

    /// Parse-or-default for the wallet pubkey. Absent/empty -> "" = walletless
    /// (TS `hasWallet()` false: live execution no-ops, balance read skipped).
    /// Non-empty MUST be a valid base58 32-byte address — TS fails closed on an
    /// invalid key at load, and a junk address would otherwise produce an RPC
    /// error every single tick. Base58 alphabet excludes 0/O/I/l; the decoded
    /// length must be exactly 32 bytes.
    pub fn parse_wallet_pubkey(raw: Option<&str>) -> Result<String, String> {
        let s = raw.map(str::trim).unwrap_or("");
        if s.is_empty() {
            return Ok(String::new());
        }
        if !is_base58_pubkey(s) {
            return Err(format!(
                "WALLET_PUBKEY={s:?} is not a valid base58 32-byte address"
            ));
        }
        Ok(s.to_string())
    }

    /// Base58 decode + exact 32-byte length check. The alphabet check is the
    /// cheap rejection; the length check is what rules out a well-formed but
    /// wrong-size string (TS's `PublicKey` constructor throws for both).
    fn is_base58_pubkey(s: &str) -> bool {
        const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        if !s.bytes().all(|b| ALPHABET.contains(&b)) {
            return false;
        }
        let mut bytes: Vec<u8> = Vec::with_capacity(64);
        for c in s.bytes() {
            let idx = ALPHABET.iter().position(|&a| a == c).unwrap_or(0) as u32;
            let mut carry = idx;
            for b in bytes.iter_mut() {
                carry += (*b as u32) * 58;
                *b = (carry & 0xff) as u8;
                carry >>= 8;
            }
            while carry > 0 {
                bytes.push((carry & 0xff) as u8);
                carry >>= 8;
            }
        }
        // Leading '1's are leading zero bytes in base58.
        let leading_zeros = s.bytes().take_while(|&b| b == b'1').count();
        bytes.reverse();
        leading_zeros + bytes.len() == 32
    }

    pub fn parse_gas_aware_min_days(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(GAS_AWARE_MIN_DAYS_DEFAULT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("GAS_AWARE_MIN_DAYS_OF_FEES_PAID_AHEAD={s:?} is not a number"))?;
        if v.is_finite() && v >= GAS_AWARE_MIN_DAYS_MIN {
            Ok(v)
        } else {
            Err(format!(
                "GAS_AWARE_MIN_DAYS_OF_FEES_PAID_AHEAD={v} must be finite and >= {GAS_AWARE_MIN_DAYS_MIN}"
            ))
        }
    }

    /// Parse-or-default for `EVOLUTION_INTERVAL` / `EVOLUTION_MAX_CHANGE_PCT`.
    /// Absent -> TS fallbacks (5 / 0.2); garbage/below-min/above-max -> `Err`.
    pub fn parse_evolution_interval(raw: Option<&str>) -> Result<i64, String> {
        let Some(s) = raw else {
            return Ok(EVOLUTION_INTERVAL_DEFAULT);
        };
        let v: i64 = s
            .trim()
            .parse()
            .map_err(|_| format!("EVOLUTION_INTERVAL={s:?} is not a number"))?;
        if v >= EVOLUTION_INTERVAL_MIN {
            Ok(v)
        } else {
            Err(format!(
                "EVOLUTION_INTERVAL={v} below min {EVOLUTION_INTERVAL_MIN}"
            ))
        }
    }

    /// Parse-or-default for `MAX_OPEN_POSITIONS`. Absent -> 3 (TS fallback);
    /// garbage/below-1 -> `Err` (host fails closed where TS validatedNumber
    /// falls back). Only feeds the open-capacity shadow log.
    pub fn parse_max_open_positions(raw: Option<&str>) -> Result<i64, String> {
        let Some(s) = raw else {
            return Ok(MAX_OPEN_POSITIONS_DEFAULT);
        };
        let v: i64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MAX_OPEN_POSITIONS={s:?} is not a number"))?;
        if v >= MAX_OPEN_POSITIONS_MIN {
            Ok(v)
        } else {
            Err(format!(
                "MAX_OPEN_POSITIONS={v} below min {MAX_OPEN_POSITIONS_MIN}"
            ))
        }
    }

    /// Parse-or-default for `MAX_POSITIONS_PER_POOL`. Absent -> 2 (TS
    /// fallback); garbage/below-1 -> `Err` (same fail-closed shape as
    /// `parse_max_open_positions`). Only feeds the pool-capacity shadow log.
    pub fn parse_max_positions_per_pool(raw: Option<&str>) -> Result<i64, String> {
        let Some(s) = raw else {
            return Ok(MAX_POSITIONS_PER_POOL_DEFAULT);
        };
        let v: i64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MAX_POSITIONS_PER_POOL={s:?} is not a number"))?;
        if v >= MAX_POSITIONS_PER_POOL_MIN {
            Ok(v)
        } else {
            Err(format!(
                "MAX_POSITIONS_PER_POOL={v} below min {MAX_POSITIONS_PER_POOL_MIN}"
            ))
        }
    }
    /// Parse-or-default for `MAX_PER_POOL_ALLOCATION_PCT`. Absent -> 0.4 (TS
    /// fallback); garbage/non-finite/out-of-[0,1] -> `Err` (same fail-closed
    /// shape as the other pct parsers). Only feeds the allocation shadow.
    pub fn parse_max_per_pool_allocation_pct(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(MAX_PER_POOL_ALLOCATION_DEFAULT_PCT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MAX_PER_POOL_ALLOCATION_PCT={s:?} is not a number"))?;
        if v.is_finite()
            && (MAX_PER_POOL_ALLOCATION_MIN_PCT..=MAX_PER_POOL_ALLOCATION_MAX_PCT).contains(&v)
        {
            Ok(v)
        } else {
            Err(format!(
                "MAX_PER_POOL_ALLOCATION_PCT={v} outside [{MAX_PER_POOL_ALLOCATION_MIN_PCT}, {MAX_PER_POOL_ALLOCATION_MAX_PCT}]"
            ))
        }
    }
    /// Parse-or-default for `MAX_ENTRY_SIZE_USD`. Absent -> 500 (TS fallback
    /// to ENTRY_SIZE_CAP_USD); garbage/non-finite/below-floor-10 -> `Err`.
    /// Only feeds the allocation shadow's headroom math.
    pub fn parse_max_entry_size_usd(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(MAX_ENTRY_SIZE_DEFAULT_USD);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MAX_ENTRY_SIZE_USD={s:?} is not a number"))?;
        if v.is_finite() && v >= MAX_ENTRY_SIZE_MIN_USD {
            Ok(v)
        } else {
            Err(format!(
                "MAX_ENTRY_SIZE_USD={v} must be finite and >= {MAX_ENTRY_SIZE_MIN_USD}"
            ))
        }
    }
    /// Parse-or-default for `REALIZED_PNL_HALT_WINDOW`. Absent -> 100 (TS
    /// fallback); garbage/below-1 -> `Err`. Only feeds the halt shadow.
    pub fn parse_realized_pnl_halt_window(raw: Option<&str>) -> Result<i64, String> {
        let Some(s) = raw else {
            return Ok(REALIZED_PNL_HALT_WINDOW_DEFAULT);
        };
        let v: i64 = s
            .trim()
            .parse()
            .map_err(|_| format!("REALIZED_PNL_HALT_WINDOW={s:?} is not a number"))?;
        if v >= REALIZED_PNL_HALT_WINDOW_MIN {
            Ok(v)
        } else {
            Err(format!(
                "REALIZED_PNL_HALT_WINDOW={v} below min {REALIZED_PNL_HALT_WINDOW_MIN}"
            ))
        }
    }
    /// Parse-or-default for `REALIZED_PNL_HALT_THRESHOLD_USD`. Absent -> -20
    /// (TS fallback); garbage/non-finite -> `Err`. Any finite value wires
    /// through (TS clamps only the low end at -MAX_SAFE_INTEGER). Only feeds
    /// the halt shadow.
    pub fn parse_realized_pnl_halt_threshold_usd(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(REALIZED_PNL_HALT_THRESHOLD_DEFAULT_USD);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("REALIZED_PNL_HALT_THRESHOLD_USD={s:?} is not a number"))?;
        if v.is_finite() {
            Ok(v)
        } else {
            Err(format!(
                "REALIZED_PNL_HALT_THRESHOLD_USD={s:?} is not finite"
            ))
        }
    }
    /// Parse-or-default for `STOP_LOSS_PCT`. Absent -> 0.15 (TS fallback);
    /// garbage/non-finite/below-0 -> `Err` (same fail-closed shape as the
    /// other pct parsers; exact TS comparison has no disabled arm — pct 0
    /// vetoes any loss). Only feeds the stop-loss shadow.
    pub fn parse_stop_loss_pct(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(STOP_LOSS_DEFAULT_PCT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("STOP_LOSS_PCT={s:?} is not a number"))?;
        if v.is_finite() && v >= STOP_LOSS_MIN_PCT {
            Ok(v)
        } else {
            Err(format!(
                "STOP_LOSS_PCT={v} must be finite and >= {STOP_LOSS_MIN_PCT}"
            ))
        }
    }
    pub fn parse_evolution_max_change_pct(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(EVOLUTION_MAX_CHANGE_DEFAULT_PCT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("EVOLUTION_MAX_CHANGE_PCT={s:?} is not a number"))?;
        if v.is_finite()
            && (EVOLUTION_MAX_CHANGE_MIN_PCT..=EVOLUTION_MAX_CHANGE_MAX_PCT).contains(&v)
        {
            Ok(v)
        } else {
            Err(format!(
                "EVOLUTION_MAX_CHANGE_PCT={v} outside [{EVOLUTION_MAX_CHANGE_MIN_PCT}, {EVOLUTION_MAX_CHANGE_MAX_PCT}]"
            ))
        }
    }
    /// Parse-or-default for `VOLUME_AUTH_THRESHOLD`; `Err` on garbage/out-of-band.
    /// Absent -> 0.7, matching validatedNumber's fallback.
    pub fn parse_volume_auth_threshold(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(VOLUME_AUTH_DEFAULT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("VOLUME_AUTH_THRESHOLD={s:?} is not a number"))?;
        if v.is_finite() && (VOLUME_AUTH_MIN..=VOLUME_AUTH_MAX).contains(&v) {
            Ok(v)
        } else {
            Err(format!(
                "VOLUME_AUTH_THRESHOLD={v} outside [{VOLUME_AUTH_MIN}, {VOLUME_AUTH_MAX}]"
            ))
        }
    }
    /// Parse-or-default for `DISCOVERY_MIN_TVL_USD`; `Err` on garbage/below-min.
    /// Absent -> 1,000,000, matching validatedNumber's fallback. NOTE: TS
    /// clamps a negative to 0 with a warn; the host fails closed instead
    /// (house rule — same substitution as the parsers above). No max arm
    /// (TS: `validatedNumber(name, 0, 1_000_000)`), the host matches.
    pub fn parse_discovery_min_tvl_usd(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(DISCOVERY_MIN_TVL_DEFAULT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("DISCOVERY_MIN_TVL_USD={s:?} is not a number"))?;
        if v.is_finite() && v >= DISCOVERY_MIN_TVL_MIN {
            Ok(v)
        } else {
            Err(format!(
                "DISCOVERY_MIN_TVL_USD={v} outside [{DISCOVERY_MIN_TVL_MIN}, ∞)"
            ))
        }
    }
    /// Parse-or-default for `DISCOVERY_MIN_FEE_RATIO`; `Err` on garbage/below-min.
    /// Absent -> 1.5, matching validatedNumber's fallback; open range above
    /// (TS has no max arm), the host matches.
    pub fn parse_discovery_min_fee_ratio(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(DISCOVERY_MIN_FEE_RATIO_DEFAULT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("DISCOVERY_MIN_FEE_RATIO={s:?} is not a number"))?;
        if v.is_finite() && v >= DISCOVERY_MIN_FEE_RATIO_MIN {
            Ok(v)
        } else {
            Err(format!(
                "DISCOVERY_MIN_FEE_RATIO={v} outside [{DISCOVERY_MIN_FEE_RATIO_MIN}, ∞)"
            ))
        }
    }
    /// `METEORA_POOLS_URL` — verbatim, NO trim/default-on-empty (TS
    /// `Config.string` only substitutes on absence; see the const doc).
    pub fn parse_meteora_pools_url(raw: Option<&str>) -> String {
        raw.map(str::to_string)
            .unwrap_or_else(|| DEFAULT_METEORA_POOLS_URL.to_string())
    }
    /// Parse-or-default for `IL_DOMINANCE_EXIT_FACTOR`; `Err` on garbage/below-min.
    /// Absent -> 2, matching validatedNumber("IL_DOMINANCE_EXIT_FACTOR", 1, 2).
    /// TS has no max arm (open range); the host matches (min-only).
    pub fn parse_il_dominance_factor(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(IL_DOMINANCE_EXIT_FACTOR_DEFAULT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("IL_DOMINANCE_EXIT_FACTOR={s:?} is not a number"))?;
        if v.is_finite() && v >= IL_DOMINANCE_EXIT_FACTOR_MIN {
            Ok(v)
        } else {
            Err(format!(
                "IL_DOMINANCE_EXIT_FACTOR={v} must be finite and >= {IL_DOMINANCE_EXIT_FACTOR_MIN}"
            ))
        }
    }
    /// Parse-or-default for `IL_DOMINANCE_MIN_USD`; `Err` on garbage/below-min.
    /// Absent -> 5, matching validatedNumber("IL_DOMINANCE_MIN_USD", 0, 5).
    pub fn parse_il_dominance_min(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(IL_DOMINANCE_MIN_DEFAULT_USD);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("IL_DOMINANCE_MIN_USD={s:?} is not a number"))?;
        if v.is_finite() && v >= IL_DOMINANCE_MIN_MIN_USD {
            Ok(v)
        } else {
            Err(format!(
                "IL_DOMINANCE_MIN_USD={v} must be finite and >= {IL_DOMINANCE_MIN_MIN_USD}"
            ))
        }
    }
    /// Parse-or-default for `DUST_EXIT_USD`; `Err` on garbage/below-min.
    /// Absent -> 5, matching validatedNumber("DUST_EXIT_USD", 0, 5). Feeds the
    /// dust-cleanup shadow arm only.
    pub fn parse_dust_exit_usd(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(DUST_EXIT_DEFAULT_USD);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("DUST_EXIT_USD={s:?} is not a number"))?;
        if v.is_finite() && v >= DUST_EXIT_MIN_USD {
            Ok(v)
        } else {
            Err(format!(
                "DUST_EXIT_USD={v} must be finite and >= {DUST_EXIT_MIN_USD}"
            ))
        }
    }
    /// Parse-or-default for `MIN_BIN_UTILIZATION`; `Err` on garbage/out-of-band.
    /// Absent -> 0.3, matching validatedNumber's fallback.
    pub fn parse_min_bin_utilization(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(MIN_BIN_UTIL_DEFAULT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MIN_BIN_UTILIZATION={s:?} is not a number"))?;
        if v.is_finite() && (MIN_BIN_UTIL_MIN..=MIN_BIN_UTIL_MAX).contains(&v) {
            Ok(v)
        } else {
            Err(format!(
                "MIN_BIN_UTILIZATION={v} outside [{MIN_BIN_UTIL_MIN}, {MIN_BIN_UTIL_MAX}]"
            ))
        }
    }
    /// non-finite / above 1. Absent -> 0.35, matching validatedNumber's
    /// fallback. NOTE: TS clamps to [0,1] with a warn and disables at ≤0;
    /// the host keeps the disable-at-≤0 semantics (returns the value as-is,
    /// caller treats ≤0 as disabled) but fails closed on garbage instead.
    pub fn parse_max_position_loss_pct(raw: Option<&str>) -> Result<f64, String> {
        let Some(s) = raw else {
            return Ok(MAX_POSITION_LOSS_DEFAULT_PCT);
        };
        let v: f64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MAX_POSITION_LOSS_PCT={s:?} is not a number"))?;
        if v.is_finite() && v <= MAX_POSITION_LOSS_MAX_PCT {
            Ok(v)
        } else {
            Err(format!(
                "MAX_POSITION_LOSS_PCT={v} must be finite and <= {MAX_POSITION_LOSS_MAX_PCT}"
            ))
        }
    }

    pub fn parse_min_yield_exit_age_ms(raw: Option<&str>) -> Result<i64, String> {
        let Some(s) = raw else {
            return Ok(MIN_YIELD_EXIT_AGE_DEFAULT_MS);
        };
        let v: i64 = s
            .trim()
            .parse()
            .map_err(|_| format!("MIN_YIELD_EXIT_AGE_MS={s:?} is not a number"))?;
        if (MIN_YIELD_EXIT_AGE_MIN_MS..=MIN_YIELD_EXIT_AGE_MAX_MS).contains(&v) {
            Ok(v)
        } else {
            Err(format!(
                "MIN_YIELD_EXIT_AGE_MS={v} outside [{MIN_YIELD_EXIT_AGE_MIN_MS}, {MIN_YIELD_EXIT_AGE_MAX_MS}]"
            ))
        }
    }

    impl Config {
        pub fn from_env() -> Result<Self, String> {
            Ok(Config {
                sqlite_path: resolve_sqlite_path(
                    env::var("SQLITE_DB_PATH").ok().as_deref(),
                    env::var("SQLITE_PATH").ok().as_deref(),
                ),
                scan_interval_ms: parse_scan_interval_ms(
                    env::var("SCAN_INTERVAL_MS").ok().as_deref(),
                )?,
                paper_portfolio_usd: parse_paper_portfolio_usd(
                    env::var("PAPER_PORTFOLIO_USD").ok().as_deref(),
                )?,
                jev_enabled: flag("JEV_ENABLED"),
                bend_bin: env::var("BEND_BIN").unwrap_or_else(|_| "bend".into()),
                min_yield_exit_age_ms: parse_min_yield_exit_age_ms(
                    env::var("MIN_YIELD_EXIT_AGE_MS").ok().as_deref(),
                )?,
                paper_trading: parse_paper_trading(env::var("PAPER_TRADING").ok().as_deref()),
                il_protection_enabled: parse_il_protection_enabled(
                    env::var("IL_PROTECTION_ENABLED").ok().as_deref(),
                ),
                min_fee_il_ratio: parse_min_fee_il_ratio(
                    env::var("MIN_FEE_IL_RATIO").ok().as_deref(),
                )?,
                max_negative_drift_bins: parse_max_negative_drift_bins(
                    env::var("MARKET_SCAN_MAX_NEGATIVE_DRIFT_BINS")
                        .ok()
                        .as_deref(),
                )?,
                volatility_lookback_snapshots: parse_volatility_lookback(
                    env::var("VOLATILITY_LOOKBACK_SNAPSHOTS").ok().as_deref(),
                )?,
                volatility_exit_stddev: parse_volatility_exit_stddev(
                    env::var("VOLATILITY_EXIT_STDDEV").ok().as_deref(),
                )?,
                oor_recovery_lookback_cycles: parse_oor_recovery_lookback(
                    env::var("OOR_RECOVERY_LOOKBACK_CYCLES").ok().as_deref(),
                )?,
                max_position_loss_pct: parse_max_position_loss_pct(
                    env::var("MAX_POSITION_LOSS_PCT").ok().as_deref(),
                )?,
                evolution_interval: parse_evolution_interval(
                    env::var("EVOLUTION_INTERVAL").ok().as_deref(),
                )?,
                evolution_max_change_pct: parse_evolution_max_change_pct(
                    env::var("EVOLUTION_MAX_CHANGE_PCT").ok().as_deref(),
                )?,
                volume_auth_threshold: parse_volume_auth_threshold(
                    env::var("VOLUME_AUTH_THRESHOLD").ok().as_deref(),
                )?,
                min_bin_utilization: parse_min_bin_utilization(
                    env::var("MIN_BIN_UTILIZATION").ok().as_deref(),
                )?,
                // House `flag()` accepts "1"|"true"; TS Config.boolean accepts
                // only "true" — equivalent for every shipped .env (all use
                // `true`), same contract as the existing flag() booleans.
                enable_pool_discovery: flag("ENABLE_POOL_DISCOVERY"),
                discovery_min_tvl_usd: parse_discovery_min_tvl_usd(
                    env::var("DISCOVERY_MIN_TVL_USD").ok().as_deref(),
                )?,
                discovery_min_fee_ratio: parse_discovery_min_fee_ratio(
                    env::var("DISCOVERY_MIN_FEE_RATIO").ok().as_deref(),
                )?,
                meteora_pools_url: parse_meteora_pools_url(
                    env::var("METEORA_POOLS_URL").ok().as_deref(),
                ),
                max_open_positions: parse_max_open_positions(
                    env::var("MAX_OPEN_POSITIONS").ok().as_deref(),
                )?,
                max_positions_per_pool: parse_max_positions_per_pool(
                    env::var("MAX_POSITIONS_PER_POOL").ok().as_deref(),
                )?,
                stop_loss_pct: parse_stop_loss_pct(env::var("STOP_LOSS_PCT").ok().as_deref())?,
                max_per_pool_allocation_pct: parse_max_per_pool_allocation_pct(
                    env::var("MAX_PER_POOL_ALLOCATION_PCT").ok().as_deref(),
                )?,
                max_entry_size_usd: parse_max_entry_size_usd(
                    env::var("MAX_ENTRY_SIZE_USD").ok().as_deref(),
                )?,
                realized_pnl_halt_enabled: flag("REALIZED_PNL_HALT_ENABLED"),
                realized_pnl_halt_window: parse_realized_pnl_halt_window(
                    env::var("REALIZED_PNL_HALT_WINDOW").ok().as_deref(),
                )?,
                realized_pnl_halt_threshold_usd: parse_realized_pnl_halt_threshold_usd(
                    env::var("REALIZED_PNL_HALT_THRESHOLD_USD").ok().as_deref(),
                )?,
                max_rebalance_range_bins: parse_max_rebalance_range_bins(
                    env::var("MAX_REBALANCE_RANGE_BINS").ok().as_deref(),
                )?,
                rebalance_gas_cost_sol: parse_rebalance_gas_cost_sol(
                    env::var("REBALANCE_GAS_COST_SOL").ok().as_deref(),
                )?,
                sol_price_usd: parse_sol_price_usd(env::var("SOL_PRICE_USD").ok().as_deref())?,
                solana_rpc_url: parse_solana_rpc_url(env::var("SOLANA_RPC_URL").ok().as_deref()),
                meteora_data_api_url: parse_data_api_url(
                    env::var("METEORA_DATA_API_URL").ok().as_deref(),
                ),
                snapshot_retention_days: parse_snapshot_retention_days(
                    env::var("SNAPSHOT_RETENTION_DAYS").ok().as_deref(),
                )?,
                gecko_terminal_enabled: parse_gecko_enabled(
                    env::var("GECKO_TERMINAL_ENABLED").ok().as_deref(),
                ),
                gecko_base_url: parse_gecko_base_url(
                    env::var("GECKO_TERMINAL_API_URL").ok().as_deref(),
                ),
                wallet_pubkey: parse_wallet_pubkey(env::var("WALLET_PUBKEY").ok().as_deref())?,
                jupiter_api_key: env::var("JUPITER_API_KEY")
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
                gas_aware_min_days: parse_gas_aware_min_days(
                    env::var("GAS_AWARE_MIN_DAYS_OF_FEES_PAID_AHEAD")
                        .ok()
                        .as_deref(),
                )?,
                oor_recovery_hold_threshold: parse_oor_recovery_hold(
                    env::var("OOR_RECOVERY_HOLD_THRESHOLD").ok().as_deref(),
                )?,
                oor_recovery_force_threshold: parse_oor_recovery_force(
                    env::var("OOR_RECOVERY_FORCE_REBALANCE_THRESHOLD")
                        .ok()
                        .as_deref(),
                )?,
                min_rebalance_interval_ms: parse_min_rebalance_interval_ms(
                    env::var("MIN_REBALANCE_INTERVAL_MS").ok().as_deref(),
                )?,
                oor_grace_period_cycles: parse_oor_grace_period_cycles(
                    env::var("OOR_GRACE_PERIOD_CYCLES").ok().as_deref(),
                )?,
                paper_validation_min_days: parse_paper_validation_min_days(
                    env::var("PAPER_VALIDATION_MIN_DAYS").ok().as_deref(),
                )?,
                paper_validation_enforce: flag("PAPER_VALIDATION_ENFORCE"),
                il_dominance_exit_factor: parse_il_dominance_factor(
                    env::var("IL_DOMINANCE_EXIT_FACTOR").ok().as_deref(),
                )?,
                il_dominance_min_usd: parse_il_dominance_min(
                    env::var("IL_DOMINANCE_MIN_USD").ok().as_deref(),
                )?,
                dust_exit_usd: parse_dust_exit_usd(env::var("DUST_EXIT_USD").ok().as_deref())?,
                agent_http_port: parse_agent_http_port(
                    env::var("AGENT_HTTP_PORT").ok().as_deref(),
                )?,
                ticks: None,
            })
        }
    }
}

/// Jev advisory client behind a trait; stub impl only (zero new deps).
///
/// Mirrors `engine/jev-service.ts`: judgments are shadow/advisory, the engine
/// keeps its deterministic fallback, and every failure class
/// (`disabled|error|timeout|rate_limited|invalid`) collapses to `None` =
/// "no opinion". `None` never blocks ENTER and is ignored on the EXIT path
/// (see `exit_approved`). A real HTTP transport (reqwest + rustls) implements
/// this same trait later; the stub keeps paper shadow green now.
mod jev {
    /// Advisory score consult: `Some(score)` in [0,1], or `None` = no opinion.
    pub trait JevClient {
        fn consult(&self, positions: i64) -> Option<f64>;
    }

    /// Unwired transport: always `None` (fail-open). `enabled` only records
    /// intent from `JEV_ENABLED`; even enabled, nothing is fetched yet.
    pub struct StubJev {
        pub enabled: bool,
    }

    impl JevClient for StubJev {
        fn consult(&self, _positions: i64) -> Option<f64> {
            // ponytail: route through the shared gate so stub + future HTTP share fail-open semantics.
            super::jev_soft_gate(self.enabled, Err("jev client not wired"))
        }
    }
}

/// Minimal `KEY=VALUE` loader for `.env` + paper profile env files.
/// Existing env wins (profile file never overrides an exported var).
fn load_env_file(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || !line.contains('=') {
            continue;
        }
        let (k, v) = line.split_once('=').unwrap();
        let (k, v) = (k.trim(), v.trim().trim_matches('"'));
        if !k.is_empty() && env::var_os(k).is_none() {
            unsafe { env::set_var(k, v) };
        }
    }
}

/// Read-only positions count. Fail-open → 0 with a log line (paper shadow only).
fn positions_count(sqlite_path: &str) -> i64 {
    let conn = match rusqlite::Connection::open_with_flags(
        Path::new(sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] sqlite open {sqlite_path} failed: {e}; count=0");
            return 0;
        }
    };
    match conn.query_row("SELECT COUNT(*) FROM positions", [], |r| r.get(0)) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("[prismd] positions count failed: {e}; count=0");
            0
        }
    }
}

/// Read-only OPEN positions count (`closed_at IS NULL`) — the denominator TS
/// enforces MAX_OPEN_POSITIONS against. Fail-open → 0 like `positions_count`
/// (which stays untouched for the existing tick log).
fn open_positions_count(sqlite_path: &str) -> i64 {
    let conn = match rusqlite::Connection::open_with_flags(
        Path::new(sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] sqlite open {sqlite_path} failed: {e}; open=0");
            return 0;
        }
    };
    match conn.query_row(
        "SELECT COUNT(*) FROM positions WHERE closed_at IS NULL",
        [],
        |r| r.get(0),
    ) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("[prismd] open positions count failed: {e}; open=0");
            0
        }
    }
}

/// Read-only per-pool OPEN counts (`closed_at IS NULL` grouped by pool) — the
/// denominator TS enforces MAX_POSITIONS_PER_POOL against. Fail-open → empty
/// (shadow logs nothing per-pool). Same connection pattern as the counters.
fn open_positions_per_pool(sqlite_path: &str) -> Vec<(String, i64)> {
    let conn = match rusqlite::Connection::open_with_flags(
        Path::new(sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] sqlite open {sqlite_path} failed: {e}; per-pool=[]");
            return Vec::new();
        }
    };
    let mut stmt = match conn.prepare(
        "SELECT pool_address, COUNT(*) FROM positions WHERE closed_at IS NULL GROUP BY pool_address",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[prismd] per-pool query prep failed: {e}; per-pool=[]");
            return Vec::new();
        }
    };
    let out: Vec<(String, i64)> =
        match stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
            Ok(rows) => rows.flatten().collect(),
            Err(e) => {
                eprintln!("[prismd] per-pool query failed: {e}; per-pool=[]");
                Vec::new()
            }
        };
    out
}

/// Read-only per-pool OPEN exposure (`SUM(current_value_usd)`, `closed_at IS
/// NULL` grouped by pool) — the numerator TS enforces
/// MAX_PER_POOL_ALLOCATION_PCT against (aggregate currentValueUsd per pool
/// vs portfolio × pct). Fail-open → empty. NULL sums coerce to 0.0.
fn open_exposure_per_pool(sqlite_path: &str) -> Vec<(String, f64)> {
    let conn = match rusqlite::Connection::open_with_flags(
        Path::new(sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] sqlite open {sqlite_path} failed: {e}; exposure=[]");
            return Vec::new();
        }
    };
    let mut stmt = match conn.prepare(
        "SELECT pool_address, COALESCE(SUM(current_value_usd), 0.0) FROM positions WHERE closed_at IS NULL GROUP BY pool_address",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[prismd] exposure query prep failed: {e}; exposure=[]");
            return Vec::new();
        }
    };
    let out: Vec<(String, f64)> =
        match stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))) {
            Ok(rows) => rows.flatten().collect(),
            Err(e) => {
                eprintln!("[prismd] exposure query failed: {e}; exposure=[]");
                Vec::new()
            }
        };
    out
}

/// Native half of the rolling-PnL halt (gate 2a): trailing realized PnL over
/// the last `window` closed positions nets below `threshold` → halt new
/// ENTERs (EXIT/REBALANCE stay free). Mirrors `engine/pnl-halt.ts`
/// `rollingRealizedPnlHalted` (window = max(1, floor(window)); empty history
/// → false, fail-open cold start). Pure on inputs — the tick feeds it rows
/// from `read_closed_realized_pnl` below.
fn rolling_realized_pnl_halted(values: &[Option<f64>], window: i64, threshold_usd: f64) -> bool {
    let w = window.max(1) as usize;
    let known: Vec<f64> = values
        .iter()
        .take(w)
        .filter_map(|v| *v)
        .filter(|v| v.is_finite())
        .collect();
    if known.is_empty() {
        return false;
    }
    known.iter().sum::<f64>() < threshold_usd
}

/// Read-only closed realized PnL, newest-first (matches
/// `getClosedPositions`: `closed_at/paper_exited_at IS NOT NULL` ordered by
/// `COALESCE(closed_at, paper_exited_at) DESC`). Fail-open → empty (= no
/// halt, cold start never freezes). NULL realized → None (filtered by the
/// math like TS filters null/undefined/non-finite).
fn read_closed_realized_pnl(sqlite_path: &str) -> Vec<Option<f64>> {
    let conn = match rusqlite::Connection::open_with_flags(
        Path::new(sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] sqlite open {sqlite_path} failed: {e}; halt-pnl=[]");
            return Vec::new();
        }
    };
    let mut stmt = match conn.prepare(
        "SELECT realized_pnl_usd FROM positions WHERE closed_at IS NOT NULL OR paper_exited_at IS NOT NULL ORDER BY COALESCE(closed_at, paper_exited_at) DESC",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[prismd] halt-pnl query prep failed: {e}; halt-pnl=[]");
            return Vec::new();
        }
    };
    let out: Vec<Option<f64>> = match stmt.query_map([], |r| r.get::<_, Option<f64>>(0)) {
        Ok(rows) => rows.flatten().collect(),
        Err(e) => {
            eprintln!("[prismd] halt-pnl query failed: {e}; halt-pnl=[]");
            Vec::new()
        }
    };
    out
}

/// Live evolution state: current banded floors from `metadata` (TS
/// `getEvolvedThresholds`: `evolved_min_fee_il_ratio` /
/// `evolved_volume_auth_threshold` / `evolved_min_bin_utilization`; absent any
/// row → `None` = fall back to config floors) + closed-outcome count from
/// `signal_snapshots` (TS `getClosedPositionOutcomes`: outcome recorded, any
/// ENTER/HOLD action). Fail-open → `None`/0, matching the TS early-return
/// below `evolutionInterval` (program.ts:6032-6042).
struct EvolveState {
    fee_floor: Option<f64>,
    auth_floor: Option<f64>,
    util_floor: Option<f64>,
    outcome_count: i64,
}

fn read_evolve_state(sqlite_path: &str) -> EvolveState {
    let conn = match rusqlite::Connection::open_with_flags(
        Path::new(sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] sqlite open {sqlite_path} failed: {e}; evolve=none");
            return EvolveState {
                fee_floor: None,
                auth_floor: None,
                util_floor: None,
                outcome_count: 0,
            };
        }
    };
    let meta = |k: &str| -> Option<f64> {
        conn.query_row("SELECT value FROM metadata WHERE key = ?1", [&k], |r| {
            r.get::<_, String>(0)
        })
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
    };
    let outcome_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM signal_snapshots WHERE outcome_recorded_at IS NOT NULL AND outcome_pnl_usd IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    EvolveState {
        fee_floor: meta("evolved_min_fee_il_ratio"),
        auth_floor: meta("evolved_volume_auth_threshold"),
        util_floor: meta("evolved_min_bin_utilization"),
        outcome_count,
    }
}
/// Read-only paper-days accumulator (`metadata.paperTradingDaysAccumulated`,
/// program.ts:5980-6013) — the F6 validation gate's days leg. Fail-open →
/// `None` (missing/unparseable/non-finite → unknown, never flags).
fn read_paper_days(sqlite_path: &str) -> Option<f64> {
    let conn = rusqlite::Connection::open_with_flags(
        Path::new(sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()?;
    let raw: String = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'paperTradingDaysAccumulated'",
            [],
            |r| r.get(0),
        )
        .ok()?;
    let v: f64 = raw.trim().parse().ok()?;
    if v.is_finite() {
        Some(v)
    } else {
        None
    }
}

/// Host-owned ledger writes enabled? Default OFF so a plain
/// `prismd --ticks N` against a live book stays byte-identical (the
/// twin-copy discipline); twin runs opt in. Non-empty value required —
/// `PRISMD_HOST_LEDGER=""` does not silently enable writes. Gates BOTH
/// host-owned writers: `prismd_shadow_log` decision rows and
/// `prismd_pool_history` price rows (wave 99).
fn host_ledger_writes_enabled() -> bool {
    env::var_os("PRISMD_HOST_LEDGER").is_some_and(|v| !v.is_empty())
}

/// Append one tick's per-pool price rows — the host-owned price history the
/// TA-exhaustion window reads (wave 99; until this wave TS wrote
/// `pool_snapshots` for it). Host-owned table, additive, nothing in the TS
/// engine reads it — the wave-88 cutover contract. Gated at the call site by
/// `host_ledger_writes_enabled()`; fail-open like the shadow seam (a history
/// that cannot write never fails the tick). Pools without a price this tick
/// are simply absent — the window tolerates gaps like any cold start.
/// Bounded by `retention_days` (TS SNAPSHOT_RETENTION_DAYS, default 14):
/// every write also prunes rows older than the cutoff — an indexed no-op on
/// most ticks, where TS sweeps once per day; same retention, less state.
fn write_pool_history(sqlite_path: &str, rows: &[(String, f64)], retention_days: i64) {
    let conn = match rusqlite::Connection::open(Path::new(sqlite_path)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] pool-history open failed: {e} (dropped)");
            return;
        }
    };
    if let Err(e) = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS prismd_pool_history (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             pool_address TEXT NOT NULL,
             timestamp INTEGER NOT NULL,
             current_price REAL NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_prismd_pool_history_pool_ts
             ON prismd_pool_history(pool_address, timestamp);",
    ) {
        eprintln!("[prismd] pool-history create failed: {e} (dropped)");
        return;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut stmt = match conn.prepare(
        "INSERT INTO prismd_pool_history (pool_address, timestamp, current_price) VALUES (?1, ?2, ?3)",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[prismd] pool-history prepare failed: {e} (dropped)");
            return;
        }
    };
    let mut warned = false;
    for (pool, price) in rows {
        if let Err(e) = stmt.execute(rusqlite::params![pool, now_ms, price]) {
            if !warned {
                eprintln!("[prismd] pool-history insert failed: {e} (remaining rows dropped)");
                warned = true;
            }
        }
    }
    // Retention sweep: TS prunes pool_snapshots once per day; the host
    // prunes on every write — indexed, a no-op on healthy ticks, no
    // bookkeeping state to go stale (advisory-bounded mirror).
    let cutoff = now_ms.saturating_sub(retention_days.max(1).saturating_mul(86_400_000));
    if let Err(e) = conn.execute(
        "DELETE FROM prismd_pool_history WHERE timestamp < ?1",
        rusqlite::params![cutoff],
    ) {
        eprintln!("[prismd] pool-history prune failed: {e} (rows age one more day)");
    }
}

/// WRITE SEAM (first non-shadow host capability): persist one shadow
/// observation row so a `prismd` run leaves an auditable trace without
/// touching any TS-owned table. Table is host-owned (`prismd_shadow_log`),
/// created on demand, and NOTHING in the TS engine reads it — the cutover
/// contract is that the host may accumulate its own ledger before it is
/// allowed to write TS tables. Shadow-only: the tick calls this with its
/// own computed verdicts; it never gates an ENTER/EXIT.
/// Fail-open: any error is logged once and dropped (a shadow that cannot
/// write must never fail the tick).
fn write_shadow_observation(sqlite_path: &str, tick: u64, decision: &str) {
    let conn = match rusqlite::Connection::open(Path::new(sqlite_path)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] shadow-log open failed: {e} (dropped)");
            return;
        }
    };
    if let Err(e) = conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS prismd_shadow_log (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             tick INTEGER NOT NULL,
             decision TEXT NOT NULL,
             created_at INTEGER NOT NULL
         );",
    ) {
        eprintln!("[prismd] shadow-log create failed: {e} (dropped)");
        return;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if let Err(e) = conn.execute(
        "INSERT INTO prismd_shadow_log (tick, decision, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![tick as i64, decision, now_ms],
    ) {
        eprintln!("[prismd] shadow-log insert failed: {e} (dropped)");
    }
}
/// Native half of the evolution shadow: mean-normalized winner-vs-loser lift
/// for one signal. Mirrors `engine/strategy-service.ts` `computeSignalLift`
/// (winners pnl>0 vs losers pnl≤0; 0 when either side empty; range-normalized
/// by max(|winMean|,|loseMean|,1e-9)). `None` on empty/non-finite — the Bend
/// `evolve_thr up` flag simply stays false and the leg holds.
fn signal_lift(signals: &[(f64, f64)]) -> Option<f64> {
    let (mut sw, mut nw, mut sl, mut nl) = (0.0, 0i64, 0.0, 0i64);
    for (v, pnl) in signals {
        if !v.is_finite() || !pnl.is_finite() {
            return None;
        }
        if *pnl > 0.0 {
            sw += v;
            nw += 1;
        } else {
            sl += v;
            nl += 1;
        }
    }
    if nw == 0 || nl == 0 {
        return None;
    }
    let (wm, lm) = (sw / nw as f64, sl / nl as f64);
    Some((wm - lm) / wm.abs().max(lm.abs()).max(1e-9))
}

/// predicate in `engine/program.ts` `checkFeeIlExit` (program.ts:10788-10792)
/// — NOT its hold-bias override, which stays TS-only. `ratio` comes from the
/// tick's HOST-COMPUTED `ratios` map (wave 100: chain BinArray concentration,
/// stats-map fees/TVL, and the host's own price-history drift anchor via
/// `compute_fee_il_ratio`; `None` when any input is cold, exactly TS's
/// fall-throughs). TS-written `signal_snapshots.fee_il_ratio` is no longer
/// read. `known` comes from the tick's live
/// datapi `stats_by_pool` map — presence = datapi answered this tick — and the
/// host observes its own statsSource, never
/// TS-persisted `pool_snapshots.stats_source` (wave 94).
struct FeeIlShadow {
    position_id: String,
    pool_address: String,
    /// "datapi answered for this pool THIS tick" — the measured-fee flag
    /// (`feeIlRatioKnown`/the accrual gate are datapi-only in TS; absent
    /// from the map → false, unknown).
    known: bool,
    mature: bool,
    ratio: Option<f64>,
    /// `position_pubkey IS NOT NULL` — mirrors `pos.positionPubKey != null`,
    /// the "onchain" leg of the paper-accrual guard (program.ts:10197-10202).
    onchain: bool,
    /// Net active-bin drift in bins (last − first over the pool's chain-fed
    /// ring); `None` when the ring is absent or has fewer than 2 samples
    /// (cold start → TS `netDriftBins = 0`, never rejects). Exact mirror of
    /// `resolvePoolDriftMetrics` (program.ts:9811-9832): TS's in-memory
    /// binHistory — wave 95 retired the persisted-snapshot proxy.
    net_drift_bins: Option<f64>,
    /// Ledger mark-PnL inputs for the loss-cap shadow (all `None` when the
    /// row lacks them → `danger=None`, never fires). Mirrors
    /// `engine/position-loss-cap.ts` `positionMarkPnlUsd` (current + claimed
    /// fees + rewards − deposited; deposited must be > 0).
    deposited_usd: Option<f64>,
    current_value_usd: Option<f64>,
    fees_claimed_usd: Option<f64>,
    rewards_claimed_usd: Option<f64>,
    /// IL-dominance shadow inputs (program.ts:10264-10297): entry X/Y USD +
    /// entry price (HODL benchmark legs) + OOR clock. `None` when the row
    /// lacks them → skip (fail-open, never fires).
    entry_amount_x_usd: Option<f64>,
    entry_amount_y_usd: Option<f64>,
    entry_price_usd: Option<f64>,
    out_of_range_since: Option<i64>,
    /// Band legs for the band-health shadow (gate-7 shape without a
    /// proposal): stored `lower_bin_id` / `upper_bin_id` per open position
    /// (`None` when the row lacks them → skipped). The ACTIVE side of every
    /// containment/drift check comes from the chain-fed ring at the tick
    /// (TS `pool.activeBinId`), never from the position row — its stored
    /// `active_bin_id` was set once at entry/rebalance and never refreshed.
    lower_bin_id: Option<i64>,
    upper_bin_id: Option<i64>,
    /// Gas-gate shadow inputs (F1): pool TVL + 24h fees from the tick's
    /// datapi map (wave 97 — same measured read that drives `known`;
    /// `None` when the fetch failed → `daily=None`, never flags; TS would
    /// fall through to gecko here, wave 98). Position share × pool fees =
    /// position daily fees, mirroring program.ts:11494-11500.
    pool_tvl_usd: Option<f64>,
    pool_fees_24h_usd: Option<f64>,
    /// Range-width shadow inputs: `pool_config.bin_step` + `current_price`
    /// from the same datapi map (wave 97; `None`/absent → tier/coverage
    /// fall back, never acts) — measured, not the persisted latest row.
    pool_bin_step: Option<i64>,
    pool_current_price: Option<f64>,
    /// TA-exhaustion shadow input: up to 35 newest HOST-history
    /// `prismd_pool_history.current_price` closes, newest-first
    /// (RSI/BB/MACD need ordered history; short/empty → TA no-vote,
    /// fail-open like TS's TA_EXHAUSTION_MIN_POINTS floor). Host-owned
    /// since wave 99 (PRISMD_HOST_LEDGER-gated writes) — the last builder
    /// read of TS-written `pool_snapshots` retired here.
    ta_closes_newest_first: Option<Vec<f64>>,
    /// Recovery-gate shadow input (F4): up to `oor_recovery_lookback` newest
    /// chain-sampled bins for the position's pool, newest-first → reversed to
    /// oldest-first at the tick (matches TS push order). `None`/short →
    /// prob 0.5, never holds alone (fail-open). Windowed from the same
    /// chain-fed ring as drift (program.ts:11670-11678).
    recovery_bins_newest_first: Option<Vec<i64>>,
    /// Vol-window shadow input: up to the `volatilityLookback` newest
    /// chain-sampled bins for the position's pool, newest-first (stddev is
    /// order-free; its FIRST element is also this tick's live active bin).
    /// `None`/short → stddev 0.0, never fires alone (fail-open). Same ring
    /// as drift, sliced to max(2, volatilityLookback) like TS
    /// (program.ts:9824-9828).
    vol_bins_newest_first: Option<Vec<i64>>,
    /// per open position (grace = count >= OOR_GRACE_PERIOD_CYCLES, like TS
    /// program.ts:11628). `None`/0-clock → cold start, never blocks.
    last_rebalance_at_ms: Option<i64>,
    oor_cycle_count: Option<i64>,
}
/// `bin_rings`: the tick's chain-fed per-pool binHistory rings (chrono,
/// pre-capped at TS `binHistoryCap = max(volatilityLookback, oorRecovery, 2)`
/// — program.ts:5931-5935 — at push). Wave 95 replaced the three
/// `pool_snapshots.active_bin_id` queries: every bin-history leg now derives
/// from the host's OWN live samples, TS's in-memory mechanism. Absent pool /
/// short ring → `None` = cold start (TS matches: <2 points → no drift,
/// empty → no windows → fail-open defaults).
fn fee_il_shadows_capped(
    sqlite_path: &str,
    min_yield_exit_age_ms: i64,
    bin_rings: &std::collections::HashMap<String, Vec<i64>>,
    recovery_lookback: i64,
    vol_lookback: i64,
    stats_by_pool: &std::collections::HashMap<String, PoolStatEntry>,
    ratios: &std::collections::HashMap<String, f64>,
) -> Vec<FeeIlShadow> {
    let conn = match rusqlite::Connection::open_with_flags(
        Path::new(sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] sqlite open {sqlite_path} failed: {e}; fee_il_shadows=[]");
            return Vec::new();
        }
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut stmt = match conn.prepare(
        "SELECT position_id, pool_address, timestamp, position_pubkey, deposited_usd, current_value_usd, cumulative_fees_claimed_usd, cumulative_rewards_claimed_usd, lower_bin_id, upper_bin_id, last_rebalance_at, oor_cycle_count FROM positions WHERE closed_at IS NULL",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[prismd] fee_il_shadows query prep failed: {e}; fee_il_shadows=[]");
            return Vec::new();
        }
    };
    let rows = match stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<f64>>(4)?,
            r.get::<_, Option<f64>>(5)?,
            r.get::<_, Option<f64>>(6)?,
            r.get::<_, Option<f64>>(7)?,
            r.get::<_, Option<i64>>(8)?,
            r.get::<_, Option<i64>>(9)?,
            r.get::<_, Option<i64>>(10)?,
            r.get::<_, Option<i64>>(11)?,
        ))
    }) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[prismd] fee_il_shadows query failed: {e}; fee_il_shadows=[]");
            return Vec::new();
        }
    };
    rows.flatten()
        .map(
            |(position_id, pool_address, ts, position_pubkey, deposited_usd, current_value_usd, fees_claimed_usd, rewards_claimed_usd, lower_bin_id, upper_bin_id, last_rebalance_at_ms, oor_cycle_count)| {
            // Host-computed ratio (wave 100) — no signal_snapshots read.
            let ratio = ratios.get(&pool_address).copied();
            // IL-dominance legs (program.ts:10264-10297): entry X/Y + entry
            // price + OOR clock, tolerant side query — pre-v16 rows or old DBs
            // without the columns read NULL → None legs, never break the tick.
            let (entry_amount_x_usd, entry_amount_y_usd, entry_price_usd, out_of_range_since): (
                Option<f64>,
                Option<f64>,
                Option<f64>,
                Option<i64>,
            ) = conn
                .query_row(
                    "SELECT entry_amount_x_usd, entry_amount_y_usd, entry_price_usd, out_of_range_since FROM positions WHERE position_id = ?1",
                    [&position_id],
                    |r| {
                        Ok((
                            r.get(0).ok(),
                            r.get(1).ok(),
                            r.get(2).ok(),
                            r.get(3).ok(),
                        ))
                    },
                )
                .unwrap_or((None, None, None, None));
            // Tolerant: empty on DB error → TA no-vote (fail-open).
            // TA closes: the HOST's own price history since wave 99 (written
            // under the PRISMD_HOST_LEDGER gate; a direct/unflagged run has
            // no rows → None → TA no-vote, fail-open like TS's short-floor).
            // Retired the last builder read of TS-written `pool_snapshots` —
            // the flag-gated host ledger is the cutover-contract source.
            let ta_closes_newest_first: Option<Vec<f64>> = (|| {
                let mut stmt = conn
                    .prepare(
                        "SELECT current_price FROM prismd_pool_history WHERE pool_address = ?1 ORDER BY timestamp DESC LIMIT 35",
                    )
                    .ok()?;
                let closes: Vec<f64> = stmt
                    .query_map(rusqlite::params![pool_address], |r| r.get(0))
                    .ok()?
                    .flatten()
                    .collect();
                if closes.is_empty() { None } else { Some(closes) }
            })();
            // Bin-history legs derive from the host's OWN chain-fed rings
            // (wave 95) — TS's in-memory binHistory mechanism, pre-capped at
            // push. Absent/short → None = cold start (TS matches: <2 points
            // → no drift; empty → no windows → fail-open defaults).
            let ring: Option<&Vec<i64>> = bin_rings.get(&pool_address);
            let net_drift_bins: Option<f64> = ring.and_then(|r| {
                if r.len() >= 2 {
                    Some((r[r.len() - 1] - r[0]) as f64)
                } else {
                    None
                }
            });
            let window = |n: i64| -> Option<Vec<i64>> {
                let r = ring?;
                if r.is_empty() {
                    return None;
                }
                let start = r.len().saturating_sub(n.max(2) as usize);
                Some(r[start..].iter().rev().copied().collect())
            };
            let recovery_bins_newest_first = window(recovery_lookback);
            let vol_bins_newest_first = window(vol_lookback);
            // Precomputed: field-init order would move `pool_address` into
            // the struct before later fields could borrow it. One map read
            // feeds EVERY stat leg — `known` requires `measured` (datapi
            // presence ONLY: a gecko-overlay entry carries legs but must
            // never set the datapi-only flag), legs fail open on absent
            // pools. bin_step prefers the chain value (TS's source).
            let stats = stats_by_pool.get(&pool_address);
            let known = stats.is_some_and(|e| e.measured);
            let pool_tvl_usd = stats.map(|s| s.tvl_usd);
            let pool_fees_24h_usd = stats.map(|s| s.fees_24h_usd);
            let pool_bin_step = stats.and_then(|s| s.bin_step);
            let pool_current_price = stats.and_then(|s| s.current_price);
            FeeIlShadow {
                position_id,
                pool_address,
                known,
                mature: now_ms - ts >= min_yield_exit_age_ms,
                onchain: position_pubkey.is_some(),
                ratio,
                net_drift_bins,
                deposited_usd,
                current_value_usd,
                fees_claimed_usd,
                rewards_claimed_usd,
                entry_amount_x_usd,
                entry_amount_y_usd,
                entry_price_usd,
                out_of_range_since,
                lower_bin_id,
                upper_bin_id,
                pool_tvl_usd,
                pool_fees_24h_usd,
                pool_bin_step,
                pool_current_price,
                ta_closes_newest_first,
                recovery_bins_newest_first,
                vol_bins_newest_first,
                last_rebalance_at_ms,
                oor_cycle_count,
            }
        })
        .collect()
}

fn tick(cfg: &config::Config, n: u64) {
    use crate::jev::JevClient;
    let count = positions_count(&cfg.sqlite_path);
    // Jev soft consult via stub transport (fail-open None until HTTP lands).
    let jev: Option<f64> = jev::StubJev {
        enabled: cfg.jev_enabled,
    }
    .consult(count);
    // EXIT path stays ungated regardless of soft signals.
    debug_assert!(exit_approved());
    println!("[prismd] tick={n} positions={count} jev={jev:?} exit_free=true");
    // Rolling-PnL halt shadow (gate 2a): computed ONCE per tick from the
    // closed-position ledger like TS `evaluateCycleRealizedPnlHalt` — while
    // halted, TS pauses every new-capital ENTER (EXIT/REBALANCE stay free).
    // Fail-open: disabled flag → false; DB failure → empty → false (cold
    // start never freezes). Observational only — never blocks.
    let halt_values = read_closed_realized_pnl(&cfg.sqlite_path);
    let halted = cfg.realized_pnl_halt_enabled
        && rolling_realized_pnl_halted(
            &halt_values,
            cfg.realized_pnl_halt_window,
            cfg.realized_pnl_halt_threshold_usd,
        );
    println!(
        "[prismd] halt enabled={} window={} threshold_usd={} closed={} halted={halted} (observational)",
        cfg.realized_pnl_halt_enabled, cfg.realized_pnl_halt_window, cfg.realized_pnl_halt_threshold_usd, halt_values.len()
    );
    // Open-capacity shadow: would TS admit one more ENTER this tick? `open`
    // counts only `closed_at IS NULL` (the same rows the TS cap enforces
    // against); `at_capacity = open >= max`. Observational only — the host
    // admits no candidates yet, so this never blocks anything.
    let open = open_positions_count(&cfg.sqlite_path);
    let at_capacity = open >= cfg.max_open_positions;
    println!(
        "[prismd] capacity open={open} max={} at_capacity={at_capacity} (observational)",
        cfg.max_open_positions
    );
    // Per-pool capacity shadow: the fullest pool answers headroom the same
    // way TS enforces MAX_POSITIONS_PER_POOL (at most one ENTER per pool per
    // cycle, up to the per-pool cap). Observational only — never blocks.
    let mut per_pool = open_positions_per_pool(&cfg.sqlite_path);
    per_pool.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    // Aggregates over ALL pools (not just the fullest): `pools` answers how
    // many distinct pools hold open positions, `capped` how many sit at the
    // per-pool cap — the pass-bar's pool-level compare without grepping
    // per-pool lines. Observational only — never blocks.
    let pools = per_pool.len() as i64;
    let capped = per_pool
        .iter()
        .filter(|(_, c)| *c >= cfg.max_positions_per_pool)
        .count() as i64;
    if let Some((pool, n)) = per_pool.first() {
        println!(
            "[prismd] pool-capacity pools={pools} capped={capped} pool={pool} open={n} max={} at_capacity={} (observational)",
            cfg.max_positions_per_pool,
            *n >= cfg.max_positions_per_pool
        );
    }
    // Per-pool allocation shadow: mirrors gate 6's aggregate exposure check
    // (checkPositionSizeGate: existingPoolExposureUsd vs portfolio × pct).
    // Answers the fullest pool's share and headroom for a MAX_ENTRY_SIZE_USD
    // ENTER — the same `maxSize` math TS clamps sizing with. Observational
    // only — never blocks (TS owns sizing until parity green).
    let exposure = open_exposure_per_pool(&cfg.sqlite_path);
    if let Some((pool, pool_exposure)) = exposure
        .iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
    {
        let cap_value = cfg.paper_portfolio_usd * cfg.max_per_pool_allocation_pct;
        let headroom = (cap_value - pool_exposure).max(0.0);
        let share = if cfg.paper_portfolio_usd > 0.0 {
            pool_exposure / cfg.paper_portfolio_usd
        } else {
            0.0
        };
        println!(
            "[prismd] allocation pool={pool} exposure_usd={pool_exposure:.2} share={share:.4} cap_pct={} cap_usd={cap_value:.2} headroom_usd={headroom:.2} max_entry_usd={} (observational)",
            cfg.max_per_pool_allocation_pct, cfg.max_entry_size_usd
        );
    }
    // Pool-cooldown shadow (F7): ENTER may proceed iff no cooldown row OR
    // now >= cooldown_until (program.ts:11870-11906). Read once per tick;
    // per-pool verdicts logged, cooled count rolled into the decision line.
    // Observational only — never blocks (TS owns ENTER until parity green).
    let tick_now_cool_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let cooldowns = read_pool_cooldowns(&cfg.sqlite_path);
    let mut cooldown_hold_shadow = 0i64;
    for (pool, until, reason) in &cooldowns {
        let free = pool_cooldown_free(Some(*until), Some(tick_now_cool_ms));
        println!(
            "[prismd] cooldown pool={pool} until={until} reason={reason} free={free:?} (observational)"
        );
        if free == Some(false) {
            cooldown_hold_shadow += 1;
        }
    }
    // Discovery/screener (wave 101): the host builds its OWN candidate
    // universe per tick — TS `loadDiscoveryPools` runs once per cycle before
    // the per-pool loop (program.ts:6140), same relative position here.
    // Shadow-only: the top-3 candidates are logged (TS's exact console
    // lines); the ENTER gate chain does not consume them yet (next wave).
    if discovery::should_discover(cfg.enable_pool_discovery, cfg.paper_trading) {
        discovery::run(cfg);
    }
    // Fee/IL EXIT + paper-accrual + ENTER-floor + drift shadows:
    // observational only, mirror checkFeeIlExit / accruePaperPositionFees /
    // feeIlHardFloorReason / driftHardFloorReason core predicates against
    // real SQLite data (positions + latest snapshots). Never acts — this
    // host admits no candidates yet.
    // Drift ring cap mirrors TS binHistoryCap = max(volatilityLookback,
    // oorRecovery, 2) (program.ts:5931-5935); normal-lane only (runner/launch
    // exempt at the TS call site).
    let bin_history_cap = cfg
        .volatility_lookback_snapshots
        .max(cfg.oor_recovery_lookback_cycles)
        .max(2);
    // Decision-summary counters: how many open positions would each shadow
    // leg flag this tick? Option legs count only Some(true) (None =
    // unknown/absent → not counted).
    let mut exit_shadow = 0i64;
    let mut enter_blocked_shadow = 0i64;
    let mut danger_shadow = 0i64;
    let mut drift_rejects_shadow = 0i64;
    let mut capital_exits_shadow = 0i64;
    let mut stop_loss_shadow = 0i64;
    let mut band_health_shadow = 0i64;
    let mut gas_hold_shadow = 0i64;
    let mut recovery_hold_shadow = 0i64;
    let mut interval_hold_shadow = 0i64;
    let mut vol_exit_shadow = 0i64;
    let mut exit_order_loss_shadow = 0i64;
    let mut il_dominance_shadow = 0i64;
    // StatsSource tier (wave 94): the host observes its OWN measured-stats
    // flag per open pool through the memoized datapi read (30s cache, retry +
    // backoff inside) instead of trusting TS-persisted
    // `pool_snapshots.stats_source`. `known` = "datapi answered THIS tick" —
    // exactly TS's datapi-only condition (geckoterminal/heuristic never set
    // `feeIlRatioKnown` nor the accrual gate); outage → false, the same
    // fall-through TS reports below datapi. One distinct-pool query + one
    // HTTP per pool per tick; a pool absent from the map reads unknown.
    let open_pools: Vec<String> = match rusqlite::Connection::open_with_flags(
        Path::new(&cfg.sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(conn) => conn
            .prepare("SELECT DISTINCT pool_address FROM positions WHERE closed_at IS NULL")
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_else(|e| {
                eprintln!("[prismd] open-pool query failed: {e}; measured flags unknown");
                Vec::new()
            }),
        Err(e) => {
            eprintln!(
                "[prismd] sqlite open for statsSource tier failed: {e}; measured flags unknown"
            );
            Vec::new()
        }
    };
    // Chain state per open pool (waves 95 + 98): ONE `getAccountInfo` →
    // `(active_id, bin_step)`. active_id feeds the host's OWN binHistory
    // ring — TS's in-memory Map mechanism (program.ts:5937/5973), same
    // per-process semantics (cold start, never seeded from persisted rows);
    // bin_step is TS's actual binStep source (adapter-service.ts:3729) and
    // the base of the gecko tier's modeled fee. A failed read skips this
    // tick's sample (warned) but keeps the pool's prior history.
    let mut chain_bin_steps: std::collections::HashMap<String, Option<i64>> =
        std::collections::HashMap::new();
    let bin_rings: std::collections::HashMap<String, Vec<i64>> = {
        let mut out = std::collections::HashMap::new();
        match BIN_HISTORY.lock() {
            Ok(mut history) => {
                for p in &open_pools {
                    match rpc::get_lb_pair_state(&cfg.solana_rpc_url, p, Duration::from_secs(10)) {
                        Ok((id, bin_step)) => {
                            push_bin_history(
                                history.entry(p.clone()).or_default(),
                                i64::from(id),
                                bin_history_cap as usize,
                            );
                            chain_bin_steps.insert(p.clone(), Some(i64::from(bin_step)));
                        }
                        Err(e) => {
                            eprintln!(
                                "[prismd] lbPair read failed for {p}: {e} (ring keeps prior samples)"
                            );
                            chain_bin_steps.insert(p.clone(), None);
                        }
                    }
                    if let Some(r) = history.get(p.as_str()) {
                        out.insert(p.clone(), r.clone());
                    }
                }
            }
            Err(_) => eprintln!("[prismd] bin-history lock poisoned; rings unavailable"),
        }
        out
    };
    // Stats pipeline (waves 94/97/98): datapi → gecko → none, one memoized
    // GET each (datapi 30s cache + retry; gecko 2.1s claim-slot paced).
    // `PoolStatEntry.measured` is DATAPI PRESENCE ONLY — `known`/accrual are
    // datapi-only in TS, so the gecko overlay feeds the gas/shape legs but
    // can never set measured. Gecko needs the chain bin_step (fee model +
    // TS's binStep source); a chain-failed pool gets no gecko either (both
    // warned above). Total outage → legs None = fail-open (TS fabricates a
    // heuristic here — documented divergence; never a fabricated verdict).
    let stats_by_pool: std::collections::HashMap<String, PoolStatEntry> = open_pools
        .iter()
        .filter_map(|p| {
            let chain_bs = chain_bin_steps.get(p).copied().flatten();
            if let Some(s) =
                datapi::get_pool_stats(&cfg.meteora_data_api_url, p, Duration::from_secs(10))
            {
                return Some((p.clone(), PoolStatEntry::from_datapi(s, chain_bs)));
            }
            if !cfg.gecko_terminal_enabled {
                return None;
            }
            match chain_bs {
                Some(bs) => {
                    let base_fee_rate = 0.0025 + (bs as f64) / 10_000.0;
                    gecko::get_pool_stats(
                        &cfg.gecko_base_url,
                        p,
                        base_fee_rate,
                        Duration::from_secs(10),
                    )
                    .map(|g| (p.clone(), PoolStatEntry::from_gecko(g, chain_bs)))
                }
                None => {
                    eprintln!("[prismd] gecko skipped for {p}: chain bin_step unknown (fee model)");
                    None
                }
            }
        })
        .collect();
    // Fee/IL ratio is HOST-COMPUTED since wave 100 — chain BinArray
    // (concentration) + stats map (tvl/fees/price) + the host's own price
    // history (24h fee-window drift anchor). Runs BEFORE this tick's price
    // row is written so the window ends at the PREVIOUS cycle, exactly TS's
    // `previousSnapshot` (scan-set.ts:22). Cold inputs fall where TS does:
    // no stats → no ratio; no bin array → concentration 1; window < 1h →
    // binStep proxy. The builder's last `signal_snapshots.fee_il_ratio`
    // read retires here (outcome rows stay TS-written for signal-lift).
    let now_ms_tick = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut ratios: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for p in &open_pools {
        let Some(entry) = stats_by_pool.get(p.as_str()) else {
            continue;
        };
        let active_id = bin_rings.get(p.as_str()).and_then(|r| r.last().copied());
        let slots = active_id.and_then(|a| {
            rpc::get_bin_array(&cfg.solana_rpc_url, p, a, Duration::from_secs(10)).map(|(_, s)| s)
        });
        // Unknown array (TS reservesKnown=false) → empty → concentration 1.
        let concentration =
            concentration_multiplier(slots.as_deref().unwrap_or(&[]), active_id.unwrap_or(0));
        let window = read_pool_price_window(&cfg.sqlite_path, p, now_ms_tick);
        let drift = snapshot_price_drift(&window).map(|(price, ts)| PriceDrift {
            previous_price: price,
            previous_timestamp_ms: ts,
        });
        // TS: binArray.binStep ?? pool.binStep ?? 10; price 0 suppresses the
        // drift arm (host None → 0.0 → same guard).
        let bin_step = entry.bin_step.unwrap_or(10);
        ratios.insert(
            p.clone(),
            compute_fee_il_ratio(
                entry.tvl_usd,
                entry.fees_24h_usd,
                entry.current_price.unwrap_or(0.0),
                now_ms_tick,
                bin_step,
                concentration,
                drift,
            ),
        );
    }
    // Host-ledger writes (wave 99, flag-gated): append this tick's price
    // rows BEFORE the builder reads them — the TA window's source since this
    // wave. Gated so direct `prismd --ticks` stays byte-identical; pools
    // without a price this tick produce no row (window tolerates gaps).
    if host_ledger_writes_enabled() {
        let price_rows: Vec<(String, f64)> = stats_by_pool
            .iter()
            .filter_map(|(p, e)| e.current_price.map(|price| (p.clone(), price)))
            .collect();
        if !price_rows.is_empty() {
            write_pool_history(&cfg.sqlite_path, &price_rows, cfg.snapshot_retention_days);
        }
    }
    let shadows = fee_il_shadows_capped(
        &cfg.sqlite_path,
        cfg.min_yield_exit_age_ms,
        &bin_rings,
        cfg.oor_recovery_lookback_cycles,
        cfg.volatility_lookback_snapshots,
        &stats_by_pool,
        &ratios,
    );
    // Drawdown inputs: spot legs per open position (deposited/current only —
    // `toRiskPosition` is spot-only). Collected up front so the book-level
    // veto sees every row even though the per-position loop borrows `shadows`.
    let drawdown_legs: Vec<(Option<f64>, Option<f64>)> = shadows
        .iter()
        .map(|s| (s.deposited_usd, s.current_value_usd))
        .collect();
    // Live-mode wallet value: TS `readWalletSnapshot` semantics
    // (adapter-service.ts:2890-2980), once per tick — native lamports + every
    // SPL holding across BOTH token programs, valued in ONE Jupiter v3 batch.
    // Paper mode skips the RPC entirely — TS uses `paperPortfolioUsd` there.
    // Failure ladder mirrors TS modulo the host's no-retain divergence: a
    // failed lamports read → `None` (config portfolio); SPL enumeration
    // failure degrades to native-only + one warn per tick (TS :2921-2934 — a
    // degraded read under-reports, never over-reports); a price outage yields
    // an empty map → skip-everything → measured $0 (TS `catch → {}` :2549).
    // `Some(0.0)` is therefore MEASURED in both the empty-wallet and
    // price-outage cases — never the config figure. Walletless live skips the
    // chain read exactly like paper mode (TS uses `paperPortfolioUsd` for both
    // and never touches the chain — AGENTS "Wallet balance").
    let wallet_value_usd: Option<f64> = if cfg.paper_trading || cfg.wallet_pubkey.is_empty() {
        None
    } else {
        match rpc::get_balance_lamports(
            &cfg.solana_rpc_url,
            &cfg.wallet_pubkey,
            Duration::from_secs(10),
        ) {
            Ok(lamports) => {
                let holdings = match rpc::get_spl_holdings(
                    &cfg.solana_rpc_url,
                    &cfg.wallet_pubkey,
                    rpc::TOKEN_PROGRAM_ID,
                    Duration::from_secs(10),
                )
                .and_then(|legacy| {
                    rpc::get_spl_holdings(
                        &cfg.solana_rpc_url,
                        &cfg.wallet_pubkey,
                        rpc::TOKEN_2022_PROGRAM_ID,
                        Duration::from_secs(10),
                    )
                    .map(|new| {
                        let mut all = legacy;
                        all.extend(new);
                        all
                    })
                }) {
                    Ok(h) => h,
                    Err(e) => {
                        eprintln!(
                            "[prismd] SPL enumeration failed — wallet degrades to native SOL only: {e}"
                        );
                        Vec::new()
                    }
                };
                let mut mints: Vec<String> = holdings.iter().map(|h| h.mint.clone()).collect();
                if lamports > 0 {
                    mints.push(rpc::SOL_MINT.to_string());
                }
                mints.sort();
                mints.dedup();
                let prices =
                    rpc::get_jupiter_prices(&cfg.jupiter_api_key, &mints, Duration::from_secs(10));
                let (value, skipped) = wallet_total_usd(lamports, &holdings, &prices);
                for mint in &skipped {
                    warn_unpriced_wallet_mint_once(mint);
                }
                Some(value)
            }
            Err(e) => {
                // One warn per tick, same as the datapi tier. A failed read
                // keeps the configured portfolio — an under-sized denominator
                // pauses new entries; EXITs stay free, so capital is protected.
                eprintln!("[prismd] wallet balance read failed: {e} (drawdown gate keeps config portfolio)");
                None
            }
        }
    };

    for s in &shadows {
        let fires = s
            .ratio
            .and_then(|r| bend::fee_exit_fires(&cfg.bend_bin, s.known, s.mature, r));
        let accrual = bend::accrual_allowed(&cfg.bend_bin, cfg.paper_trading, s.onchain, s.known);
        // ENTER floor uses the banded floor: TS consults evolvedThresholds
        // (banded into [0.3,3.0]) here, not the raw config floor; the host
        // has no evolution state, so it shadows against its own native clamp
        // of the same config value (host clamp = Bend clamp_thr, LAWS-proven).
        let floor = clamp_fee_il(cfg.min_fee_il_ratio);
        let blocked = s.ratio.and_then(|r| {
            bend::enter_blocked(&cfg.bend_bin, cfg.il_protection_enabled, s.known, r, floor)
        });
        // Drift shadow: TS consults the in-memory binHistory ring (last -
        // first); the host reads the same values from persisted snapshots.
        // Cold start (None) -> 0.0, matching TS, never rejects.
        let drift = s.net_drift_bins.unwrap_or(0.0);
        let drift_rejects = bend::drift_rejects(&cfg.bend_bin, drift, cfg.max_negative_drift_bins);
        // Loss-cap shadow: native danger from the ledger + proven kernel
        // proving confidence can never veto it (LAWS capital_exit_free /
        // capital_exit_quiet). Observational only — never exits.
        let danger = loss_cap_danger(
            s.deposited_usd,
            s.current_value_usd,
            s.fees_claimed_usd,
            s.rewards_claimed_usd,
            cfg.max_position_loss_pct,
        );
        // Tighter-cap truncation probe (shadow-only): same ledger at half the
        // live cap — would a tighter stop have flagged this position earlier?
        // Observational only; never exits.
        let danger_tighter = loss_cap_danger(
            s.deposited_usd,
            s.current_value_usd,
            s.fees_claimed_usd,
            s.rewards_claimed_usd,
            cfg.max_position_loss_pct / 2.0,
        );
        // Confidence 1.0 matches TS conf1PositionExit (program.ts:10595-10603);
        // the kernel drops it either way (LAWS capital_exit_free/quiet).
        let capital = danger.and_then(|d| bend::capital_exit(&cfg.bend_bin, d, 1.0));
        // Proven loss-magnitude floor (2026-09-20 URANUS-SOL wave): the kernel
        // twin of the SAME native predicate above (mark PnL ≤ -(deposited ×
        // min(pct,1))), so the at-or-below direction is pinned by law rather
        // than by two Rust call sites. Agreement check only — host `danger`
        // stays the voter, exactly like `bend_known` below; a mismatch is
        // logged and the host wins (fail-open), never acted on.
        // PnL legs mirror positionMarkPnlUsd (position-loss-cap.ts:22-40);
        // missing/non-finite legs → None (no consult).
        let loss_mark_pnl = match (
            s.deposited_usd,
            s.current_value_usd,
            s.fees_claimed_usd,
            s.rewards_claimed_usd,
        ) {
            (Some(d), Some(c), Some(f), Some(r))
                if d.is_finite()
                    && d > 0.0
                    && c.is_finite()
                    && f.is_finite()
                    && r.is_finite()
                    && f >= 0.0
                    && r >= 0.0 =>
            {
                Some(c + f + r - d)
            }
            _ => None,
        };
        let loss_magnitude_kernel = bend::loss_magnitude_fires(
            &cfg.bend_bin,
            loss_mark_pnl,
            s.deposited_usd,
            cfg.max_position_loss_pct,
        );
        if let (Some(native), Some(kernel)) = (danger, loss_magnitude_kernel) {
            if native != kernel {
                eprintln!(
                    "[prismd] bend loss_magnitude_fires DISAGREES with native danger: native={native} kernel={kernel} (host wins, fail-open)"
                );
            }
        }
        // Known-flag shadow: K.fee_known is a pure bool passthrough of the
        // host's own datapi comparison — the kernel call proves the wiring,
        // never votes. A mismatch would mean host/kernel disagree on the
        // measured-vs-modeled split, so log it (fail-open: host wins, no panic).
        let bend_known = bend::fee_known(&cfg.bend_bin, s.known);
        if bend_known.is_some_and(|b| b != s.known) {
            eprintln!(
                "[prismd] fee_known mismatch: host={} bend={bend_known:?} (observational, host wins)",
                s.known
            );
        }
        // Band-health shadow: gate-7 shape without a proposal — no PROPOSED
        // newLower/newUpper exists on the host (positions store the CURRENT
        // band), so this audits the live band: width-invalid (upper<=lower or
        // width>max) or active-outside-band flags unhealthy. Runner scale-ins
        // anchor below active by design (risk-service.ts:278-280 exempts them
        // from containment), so the host counts width-only as unhealthy and
        // logs containment separately — never vetoes (TS owns REBALANCE).
        let width_bad =
            rebalance_range_invalid(s.lower_bin_id, s.upper_bin_id, cfg.max_rebalance_range_bins);
        // Live pool bin from the chain-fed ring (this tick's sample; TS
        // `pool.activeBinId` at the same legs). Absent = cold ring or RPC
        // miss → None → fail-open (never a stored-position fallback: that
        // row's `active_bin_id` was set once at entry/rebalance).
        let live_active: Option<i64> = bin_rings
            .get(&s.pool_address)
            .and_then(|r| r.last().copied());
        let contained = match (live_active, s.lower_bin_id, s.upper_bin_id) {
            (Some(a), Some(lo), Some(hi)) => Some(a >= lo && a <= hi),
            _ => None,
        };
        let stop_loss = stop_loss_veto(s.deposited_usd, s.current_value_usd, cfg.stop_loss_pct);
        // Gas shadow (F1): REBALANCE justified iff gas <= N days of position
        // fees. Position daily fees = pool fees24h × share (current/tvl,
        // capped 100%, 0 when unmeasurable — program.ts:11494-11500); gas =
        // rebalance_gas_cost_sol × sol_price_usd. Unknown snapshot legs →
        // None, never flags (fail-open). Observational only — never holds.
        let gas_cost_usd = cfg.rebalance_gas_cost_sol * cfg.sol_price_usd;
        let daily_fees_usd = match (s.pool_fees_24h_usd, s.pool_tvl_usd, s.current_value_usd) {
            (Some(f), Some(t), Some(c)) => Some(f * position_share_pct(t, c)),
            _ => None,
        };
        let gas_ok =
            gas_rebalance_justified(Some(gas_cost_usd), daily_fees_usd, cfg.gas_aware_min_days);
        // Recovery shadow (F4): HOLD in expectation of mean-reversion iff
        // prob >= hold threshold. Bins newest-first → reverse to oldest-first
        // (TS push order); drift = |active − center| (program.ts:11532-11534);
        // force leg logged when prob <= force threshold (program.ts:11576).
        // Cold start (no/short history) → 0.5, never holds alone. Never acts.
        let center = match (s.lower_bin_id, s.upper_bin_id) {
            (Some(lo), Some(hi)) => Some((lo + hi) as f64 / 2.0),
            _ => None,
        };
        let drift_dist = match (live_active, center) {
            (Some(a), Some(c)) => Some((a as f64 - c).abs()),
            _ => None,
        };
        let bins_oldest_first: Vec<i64> = s
            .recovery_bins_newest_first
            .clone()
            .unwrap_or_default()
            .into_iter()
            .rev()
            .collect();
        let rec_prob = drift_dist.and_then(|d| recovery_probability(&bins_oldest_first, d));
        let rec_hold = drift_dist
            .and_then(|d| recovery_hold(&bins_oldest_first, d, cfg.oor_recovery_hold_threshold));
        let rec_force = rec_prob.map(|p| p <= cfg.oor_recovery_force_threshold);
        // Min-interval shadow: REBALANCE cooled iff now-last >= min OR grace
        // (count >= OOR_GRACE_PERIOD_CYCLES, program.ts:11628). Tick clock =
        // fee_il SELECT's now_ms is out of scope — recompute here (same ms).
        // Cold start (last 0/None) → elapsed huge → cooled (like TS: epoch
        // last always passes unless grace logic says otherwise). Never blocks.
        let tick_now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let grace = s
            .oor_cycle_count
            .is_some_and(|c| c >= cfg.oor_grace_period_cycles);
        let cooled = rebalance_interval_cooled(
            Some(tick_now_ms),
            s.last_rebalance_at_ms,
            cfg.min_rebalance_interval_ms,
            grace,
        );
        // Vol-EXIT shadow: native twin of TS `decidePhase2Exit` vol arm
        // (program.ts:11364-11398) — high-vol AND drifted AND cooled.
        // No runner/launch flag exists in the host schema yet (positions
        // expose no `launch_runner`/`position_mode` columns), so the twin's
        // `is_runner=false` arm is the only reachable shape here: runner
        // positions report as normal-lane (fail-open note, never exits).
        // Shadow-only: logs + counter, TS owns the EXIT.
        let vol_bins: Vec<i64> = s.vol_bins_newest_first.clone().unwrap_or_default();
        let vol_stddev = bin_volatility_stddev(&vol_bins);
        // Live pool bin: vol_bins[0] (newest-first) IS this tick's CHAIN
        // sample since wave 95 — TS `pool.activeBinId` (program.ts:11626),
        // same mechanism. Shape: |active−center| / (halfWidth || 1).
        let vol_drift_pct = match (vol_bins.first(), s.lower_bin_id, s.upper_bin_id) {
            (Some(&a), Some(lo), Some(hi)) => {
                let half = (hi - lo) as f64 / 2.0;
                Some(
                    ((a as f64 - (lo + hi) as f64 / 2.0).abs())
                        / (if half != 0.0 { half } else { 1.0 }),
                )
            }
            _ => None,
        };
        let vol_fires = vol_exit_fires(
            false,
            Some(vol_stddev),
            cfg.volatility_exit_stddev,
            vol_drift_pct,
            cooled,
            grace,
        );
        // Entry-shape shadow: the `auto` regime pick from stored legs —
        // σ over the vol window, drift = last−first over the same ring
        // (TS `resolvePoolDriftMetrics` netDriftBins; cold start → 0).
        // Non-auto ENTRY_STRATEGY_TYPE stays TS-owned (returned as-is).
        let shape_drift = s.net_drift_bins.unwrap_or(0.0);
        let entry_shape =
            recommend_entry_strategy(vol_stddev, cfg.volatility_exit_stddev, shape_drift);
        // Range-width shadow: twin of TS `resolveRangeHalfWidth` fed from the
        // stored bin_step + vol-window σ legs (base 0 → tier, adaptive on,
        // cap = MAX_REBALANCE_RANGE_BINS, floor 5). current_price logged for
        // provenance only (the twin prices via binStep, not spot).
        // Shadow-only: logs + legs, TS owns entries/rebalances.
        let range_half_width = resolve_range_half_width(
            s.pool_bin_step,
            0,
            true,
            vol_stddev,
            cfg.max_rebalance_range_bins,
            5.0,
        );
        // TA-exhaustion shadow: native indicator triple over stored closes
        // (newest-first) → proven `K.ta_exhausted` confluence. Short/junk →
        // None (fail-open no-vote, mirrors TS TA_EXHAUSTION_MIN_POINTS).
        // Shadow-only: logs + exit_order ta_hit, TS owns the EXIT.
        let ta_depth = s
            .ta_closes_newest_first
            .as_ref()
            .map(|c| c.len())
            .unwrap_or(0);
        let ta_bools: Option<(bool, bool, bool)> =
            s.ta_closes_newest_first.as_ref().and_then(|closes| {
                let rsi = ta_rsi2(closes)?;
                let upper = ta_bb_upper(closes)?;
                let (hist, prev) = ta_macd_hist(closes)?;
                let close = *closes.first()?;
                if !close.is_finite() {
                    return None;
                }
                Some((rsi > 90.0, close > upper, hist > 0.0 && prev <= 0.0))
            });
        let ta_vote: Option<bool> = match ta_bools {
            Some((rsi_ob, above_bb, first_green)) => {
                bend::ta_exhausted(&cfg.bend_bin, rsi_ob, above_bb, first_green)
            }
            None => None,
        };
        // Exit-order dry-run: tp stubbed + ta-live + stored loss legs.
        let loss_hit = danger == Some(true) || stop_loss == Some(true);
        let exit_order_pick =
            bend::exit_order(&cfg.bend_bin, false, ta_vote.unwrap_or(false), loss_hit);
        // IL-dominance shadow (program.ts:10264-10297): fires only when IL
        // protection is on AND the position is OOR (fees stopped → pure bleed)
        // AND entry legs price a HODL benchmark AND il > fees × factor + floor.
        // Host-native floats (no Bend F32 kernel). Fail-open None on any
        // missing leg → never fires. Shadow-only: logs + counter, TS owns EXIT.
        // DIVERGENCE (documented): TS prices HODL off live pool.currentPrice
        // (program.ts:10279) + heuristic currentValueUsd mark; the host uses
        // the latest persisted pool_current_price snapshot + stored
        // current_value_usd — same class as the vol_drift proxy, shape match
        // not tick-exact.
        let il_gated = cfg.il_protection_enabled && s.out_of_range_since.is_some();
        let hodl = hodl_value_usd(
            s.entry_amount_x_usd,
            s.entry_amount_y_usd,
            s.entry_price_usd,
            s.pool_current_price,
        );
        let il_usd = hodl.and_then(|h| s.current_value_usd.map(|c| h - c));
        let il_fires = if il_gated {
            il_dominant(
                il_usd,
                s.fees_claimed_usd,
                cfg.il_dominance_exit_factor,
                cfg.il_dominance_min_usd,
            )
        } else {
            Some(false)
        };
        println!(
            "[prismd] shadow il_dominance position={} pool={} gated={il_gated} hodl_usd={hodl:?} il_usd={il_usd:?} fees_usd={:?} factor={} min_usd={} fires={il_fires:?} (observational)",
            s.position_id, s.pool_address, s.fees_claimed_usd, cfg.il_dominance_exit_factor, cfg.il_dominance_min_usd
        );
        // Dust-cleanup arm (program.ts:4384-4386): real mark strictly below
        // the threshold, threshold > 0. Host kernel twin; observational only.
        let dust_fires = bend::dust_exit_fires(
            &cfg.bend_bin,
            cfg.dust_exit_usd > 0.0,
            s.current_value_usd,
            Some(cfg.dust_exit_usd),
        );
        // Loss-magnitude kernel verdict + the dust arm it shares the ledger
        // with — one grep-able line answering "would the proven floor have
        // fired this tick, and does the host agree?" (observational).
        println!(
            "[prismd] shadow loss_magnitude position={} pool={} pnl_usd={loss_mark_pnl:?} deposited_usd={:?} cap_pct={} native_danger={danger:?} kernel_fires={loss_magnitude_kernel:?} dust_mark_usd={:?} dust_fires={:?} (observational)",
            s.position_id, s.pool_address, s.deposited_usd, cfg.max_position_loss_pct, s.current_value_usd, dust_fires
        );
        println!(
            "[prismd] shadow fee_il_exit position={} pool={} known={} bend_known={bend_known:?} mature={} ratio={:?} bend_fires={fires:?} accrual_allowed={accrual:?} enter_blocked={blocked:?} floor={floor} drift={drift} drift_rejects={drift_rejects:?} drift_floor={} loss_danger={danger:?} danger_tighter={danger_tighter:?} capital_exit={capital:?} stop_loss_veto={stop_loss:?} band_width_invalid={width_bad:?} band_contains_active={contained:?} band_width={:?} gas_cost_usd={gas_cost_usd:.4} daily_fees_usd={daily_fees_usd:?} gas_justified={gas_ok:?} rec_prob={rec_prob:?} rec_hold={rec_hold:?} rec_force={rec_force:?} interval_cooled={cooled:?} oor_grace={grace} last_rebal_ms={:?} vol_stddev={vol_stddev:.2} vol_drift_pct={vol_drift_pct:?} vol_thr={} vol_fires={vol_fires:?} entry_shape={entry_shape} shape_drift={shape_drift} range_half_width={range_half_width} pool_bin_step={:?} pool_current_price={:?} loss_hit={loss_hit} exit_order={exit_order_pick:?} ta_depth={ta_depth} ta_rsi_ob={ta_bools:?} ta_vote={ta_vote:?} (observational)",
            s.position_id, s.pool_address, s.known, s.mature, s.ratio, cfg.max_negative_drift_bins, s.upper_bin_id.zip(s.lower_bin_id).map(|(hi, lo)| hi - lo), s.last_rebalance_at_ms, cfg.volatility_exit_stddev, s.pool_bin_step, s.pool_current_price
        );
        if fires == Some(true) {
            exit_shadow += 1;
        }
        if blocked == Some(true) {
            enter_blocked_shadow += 1;
        }
        if danger == Some(true) {
            danger_shadow += 1;
        }
        if drift_rejects == Some(true) {
            drift_rejects_shadow += 1;
        }
        if capital == Some(true) {
            capital_exits_shadow += 1;
        }
        // (veto computed above, next to the per-position log).
        if stop_loss == Some(true) {
            stop_loss_shadow += 1;
        }
        if width_bad == Some(true) {
            band_health_shadow += 1;
        }
        if gas_ok == Some(false) {
            gas_hold_shadow += 1;
        }
        if rec_hold == Some(true) {
            recovery_hold_shadow += 1;
        }
        if cooled == Some(false) {
            interval_hold_shadow += 1;
        }
        if vol_fires == Some(true) {
            vol_exit_shadow += 1;
        }
        if exit_order_pick == Some(3) {
            exit_order_loss_shadow += 1;
        }
        if il_fires == Some(true) {
            il_dominance_shadow += 1;
        }
    }

    // Observational only — never blocks ENTER (TS owns risk until parity).
    // Portfolio leg: TS uses live `portfolioValueUsd = walletBalanceUsd + Σ
    // openPositions.currentValueUsd`; the host has no live wallet value in
    // paper mode, so it shadows against `paper_portfolio_usd` (documented
    // DIVERGENCE, allocation bullet). In live mode the chain read feeds the
    // same formula when it succeeded.
    // `Some(0.0)` semantics (measured — empty wallet or price outage, never
    // config fallback) live on `drawdown_portfolio_usd` — see its doc.
    let open_value_usd: f64 = shadows
        .iter()
        .filter_map(|s| s.current_value_usd)
        .filter(|v| v.is_finite())
        .sum();
    let portfolio_usd =
        drawdown_portfolio_usd(wallet_value_usd, open_value_usd, cfg.paper_portfolio_usd);
    let drawdown = drawdown_veto(&drawdown_legs, portfolio_usd);
    // F6 paper-validation shadow: live ENTER needs paper days (program.ts:7562).
    // Paper mode → pass; days>=min → pass; !enforce → warn-pass; else block.
    // Observational only — never blocks (TS owns ENTER until parity green).
    let paper_days = read_paper_days(&cfg.sqlite_path);
    let paper_pass = paper_validation_pass(
        cfg.paper_trading,
        paper_days,
        cfg.paper_validation_min_days,
        cfg.paper_validation_enforce,
    );
    println!(
        "[prismd] decision open={open} exit_shadow={exit_shadow} enter_blocked_shadow={enter_blocked_shadow} danger_shadow={danger_shadow} drift_rejects_shadow={drift_rejects_shadow} capital_exits_shadow={capital_exits_shadow} stop_loss_shadow={stop_loss_shadow} band_health_shadow={band_health_shadow} gas_hold_shadow={gas_hold_shadow} recovery_hold_shadow={recovery_hold_shadow} interval_hold_shadow={interval_hold_shadow} vol_exit_shadow={vol_exit_shadow} exit_order_loss_shadow={exit_order_loss_shadow} il_dominance_shadow={il_dominance_shadow} paper_days={paper_days:?} paper_pass={paper_pass:?} cooldown_holds={cooldown_hold_shadow} wallet_value_usd={wallet_value_usd:?} drawdown_veto={drawdown:?} at_capacity={at_capacity} (observational)",
    );

    // Evolution shadow: what WOULD one evolveThresholds round do to the live
    // banded floors? Observational only — never writes metadata (TS owns
    // evolution until parity green). Skips quietly below evolutionInterval
    // outcomes, matching the TS early-return (program.ts:6032-6042).
    evolve_shadow(cfg);
    // Write seam: persist this tick's verdict to the host-owned
    // `prismd_shadow_log` table (TS never reads it). Shadow-only — the row is
    // an audit trail for the cutover compare, not a decision input.
    // Gated on PRISMD_HOST_LEDGER (default OFF; renamed from
    // PRISMD_SHADOW_LOG in wave 99 when the flag outgrew its first job — it
    // now gates EVERY host-owned ledger write: decision rows + price
    // history). A plain `prismd --ticks N` against a live book stays
    // byte-identical: every other host handle is READ_ONLY, and the
    // twin-copy discipline only holds if direct invocation stays
    // non-mutating. Non-empty value required, so `PRISMD_HOST_LEDGER=""`
    // does not silently enable writes (same fail-closed shape as the other
    // env flags in this file).
    if host_ledger_writes_enabled() {
        let shadow_decision = format!(
            "open={open} exit_shadow={exit_shadow} enter_blocked_shadow={enter_blocked_shadow} \
             danger_shadow={danger_shadow} drift_rejects_shadow={drift_rejects_shadow} \
             capital_exits_shadow={capital_exits_shadow} stop_loss_shadow={stop_loss_shadow} \
             band_health_shadow={band_health_shadow} gas_hold_shadow={gas_hold_shadow} \
             recovery_hold_shadow={recovery_hold_shadow} interval_hold_shadow={interval_hold_shadow} \
             vol_exit_shadow={vol_exit_shadow} exit_order_loss_shadow={exit_order_loss_shadow} \
             il_dominance_shadow={il_dominance_shadow} at_capacity={at_capacity}"
        );
        write_shadow_observation(&cfg.sqlite_path, n, &shadow_decision);
    }
}

/// One `tryEvolveThresholds` round as a shadow: current banded floors (live
/// metadata or config fallback) × outcome lift → proven kernel → logged
/// would-be floors. Mirrors `engine/strategy-service.ts` `evolveThresholds`
/// (lift target → ±20% nudge → absolute band pin).
fn evolve_shadow(cfg: &config::Config) {
    let st = read_evolve_state(&cfg.sqlite_path);
    if st.outcome_count < cfg.evolution_interval {
        return;
    }
    let conn = match rusqlite::Connection::open_with_flags(
        std::path::Path::new(&cfg.sqlite_path),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] evolve shadow: sqlite open failed: {e}");
            return;
        }
    };
    // Outcome pairs for lift: (signal, pnl). Fail-open → skip the round.
    let load = |col: &str| -> Option<Vec<(f64, f64)>> {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {col}, outcome_pnl_usd FROM signal_snapshots WHERE outcome_recorded_at IS NOT NULL AND outcome_pnl_usd IS NOT NULL AND (action = 'ENTER' OR action = 'HOLD') ORDER BY outcome_recorded_at DESC LIMIT 1000"
            ))
            .ok()?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, f64>(0)?, r.get::<_, f64>(1)?)))
            .ok()?;
        rows.collect::<Result<Vec<_>, _>>().ok()
    };
    let (fee_rows, auth_rows, util_rows) = match (
        load("fee_il_ratio"),
        load("volume_authenticity"),
        load("bin_utilization"),
    ) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => return,
    };
    let (fee_lift, auth_lift, util_lift) = match (
        signal_lift(&fee_rows),
        signal_lift(&auth_rows),
        signal_lift(&util_rows),
    ) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => return,
    };
    // Current floors: live metadata or config fallback (TS seeds from config
    // on first run: program.ts:6017-6021). Auth/util fallbacks are the
    // config defaults (volume_auth_threshold 0.7, min_bin_utilization 0.3).
    let (cur_fee, cur_auth, cur_util) = (
        st.fee_floor.unwrap_or(cfg.min_fee_il_ratio),
        st.auth_floor.unwrap_or(cfg.volume_auth_threshold),
        st.util_floor.unwrap_or(cfg.min_bin_utilization),
    );
    // Bands mirror the TS absolute bands (strategy-service.ts:543-548).
    let legs = [
        ("feeIl", cur_fee, fee_lift, 0.3, 3.0),
        ("auth", cur_auth, auth_lift, 0.1, 0.9),
        ("util", cur_util, util_lift, 0.05, 0.8),
    ];
    for (name, cur, lift, lo, hi) in legs {
        let next = bend::evolve_thr(
            &cfg.bend_bin,
            cur,
            lift > 0.0,
            lift.abs(),
            1.0,
            cfg.evolution_max_change_pct,
            lo,
            hi,
        );
        println!(
            "[prismd] shadow evolve leg={name} cur={cur:.3} lift={lift:+.3} next={next:?} outcomes={} (observational)",
            st.outcome_count
        );
    }
}

/// One-shot startup health probe: confirm the deployed `bend` binary agrees
/// with the proven `band_runaway` law (1392n -> 300n, the 2026-09 evolution
/// runaway) before trusting it on the scan path. Non-fatal either way — a
/// missing/mismatched `bend` only means kernel consults stay fail-open to
/// the host's native `clamp_fee_il`, exactly as they already do.
fn bend_health_check(bend_bin: &str) {
    match bend::clamp_fee_il(bend_bin, 13.92) {
        Some(v) if v == FEE_IL_MAX => {
            println!("[prismd] bend={bend_bin} healthy: band_runaway clamp={v}");
        }
        Some(v) => {
            eprintln!(
                "[prismd] bend={bend_bin} DISAGREES with native clamp: got={v} want={FEE_IL_MAX}"
            );
        }
        None => {
            println!(
                "[prismd] bend={bend_bin} unavailable at startup; kernel consults will fail open"
            );
        }
    }
}

/// CLI argv classifier: `Ok(None)` = `--help` (print usage, exit 0);
/// `Err` = unknown `--flag` or malformed `--ticks` (exit 2, fail-closed);
/// `Ok(ticks)` otherwise. Non-flag positionals are profile env-file paths
/// (loaded by the caller). Regression: `--help` used to fall through to an
/// infinite scan loop, `--bogus` was silently ignored, and a lone/unparsable
/// `--ticks` collapsed to `None` (also infinite) — all now exit early / fail
/// closed, matching the numeric config parsers.
fn parse_cli_ticks(args: &[String]) -> Result<Option<u64>, String> {
    let mut ticks: Option<u64> = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--ticks" {
            let raw = args
                .get(i + 1)
                .ok_or("--ticks requires a value".to_string())?;
            let v: u64 = raw
                .parse()
                .map_err(|_| format!("--ticks {raw:?} is not a number"))?;
            if v == 0 {
                return Err("--ticks must be >= 1".to_string());
            }
            ticks = Some(v);
            i += 2;
        } else {
            i += 1;
        }
    }
    Ok(ticks)
}

fn classify_args(args: &[String], ticks: Option<u64>) -> Result<Option<u64>, String> {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        return Ok(None);
    }
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--ticks" {
            // Skip flag + its value by index: exact, unlike comparing the
            // value text (a profile file literally named e.g. `3` must load,
            // and `--ticks 3 --ticks 3` must not confuse value for flag).
            i += 2;
            continue;
        }
        if args[i].starts_with("--") {
            return Err(format!("unknown flag {}", args[i]));
        }
        i += 1;
    }
    Ok(ticks)
}

/// Meteora Data API read tier — the FIRST of the three stats sources the TS
/// engine tries, and the only one that supplies MEASURED per-pool fees
/// (`fees24hUsd`). Mirrors `engine/meteora-datapi-service.ts`: one GET to
/// `{base}/pools/{address}`, strict field typing, `null` on every failure
/// class (transport, non-200, unparseable, schema drift) so callers fall
/// through to geckoterminal then the heuristic exactly like TS does.
///
/// Deliberately NOT a Solana RPC client: the Data API is plain HTTPS JSON
/// and carries every stat the shadows need (tvl/volume/fees/apr/price/
/// base_fee_pct/has_farm/farm_apr/blacklist/freeze flags), so the read tier
/// needs no borsh, no LbPair layout, and no wallet. Pool-state-on-chain
/// (active bin, bin reserves) stays a later, separate wave.
mod datapi {
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};
    use std::time::{Duration, Instant};

    pub const DEFAULT_BASE_URL: &str = "https://dlmm.datapi.meteora.ag";
    /// Mirrors `POOL_STATS_CACHE_TTL_MS = 30_000` (meteora-datapi-service.ts:215):
    /// the pool's TVL/volume/fees move on swap cadence, so a short TTL
    /// collapses within-cycle duplicates without going stale across cycles.
    /// A failed fetch is NOT cached (fail-open retries next read), and the
    /// map is pruned on insert so dropped pools don't accumulate.
    pub const CACHE_TTL: Duration = Duration::from_secs(30);
    /// Mirrors `MAX_RETRIES = 2` (meteora-datapi-service.ts:11): up to two
    /// extra attempts on retriable errors only.
    pub const MAX_RETRIES: u32 = 2;
    /// Exponential base mirroring `baseDelayMs: 1000` (adapter-retry.ts:244):
    /// attempt n waits base × 2^n before retrying.
    pub const RETRY_BASE_DELAY: Duration = Duration::from_secs(1);
    /// Rate-limit base mirroring `rateLimitBaseDelayMs: 5_000`
    /// (adapter-retry.ts:246): a 429 pays the longer base, everything else
    /// the short one.
    pub const RETRY_RATE_LIMIT_DELAY: Duration = Duration::from_secs(5);

    static STATS_CACHE: LazyLock<Mutex<HashMap<String, (PoolStats, Instant)>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn cache_len_for_test() -> usize {
        STATS_CACHE.lock().map(|m| m.len()).unwrap_or(0)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn cache_clear_for_test() {
        if let Ok(mut m) = STATS_CACHE.lock() {
            m.clear();
        }
    }

    /// Seed exactly what a successful fetch stores, for the memo test. The
    /// production write leg lives inside `get_pool_stats`; this is only the
    /// seam the test needs to prove a hit short-circuits without a fetch.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn cache_insert_for_test(pool_address: String, stats: PoolStats) {
        if let Ok(mut m) = STATS_CACHE.lock() {
            m.insert(pool_address, (stats, Instant::now()));
        }
    }

    /// TS `isRetriableError` (adapter-retry.ts:132-142) narrowed to what an
    /// HTTP GET can actually surface: 429 / "rate limit" / "too many
    /// requests" are always retriable, plus transport timeouts (the
    /// "rpc request timeout" arm). Parse failures and non-429 statuses fail
    /// immediately — retrying a 404 or a schema-drift payload is pure waste.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_retriable_pub(msg: &str) -> bool {
        is_retriable(msg)
    }

    fn is_retriable(msg: &str) -> bool {
        let m = msg.to_lowercase();
        m.contains("429")
            || m.contains("rate limit")
            || m.contains("too many requests")
            || m.contains("timed out")
            || m.contains("timeout")
    }

    fn is_rate_limited(msg: &str) -> bool {
        let m = msg.to_lowercase();
        m.contains("429") || m.contains("rate limit") || m.contains("too many requests")
    }

    /// Measured pool stats. Nullable legs match `MeteoraPoolStats` in
    /// engine/services.ts: absent means "the API omitted it", which is NOT
    /// the same as zero and must not be fabricated into one.
    #[derive(Debug, Default, Clone, PartialEq)]
    pub struct PoolStats {
        pub address: String,
        pub name: String,
        pub tvl_usd: f64,
        pub volume_24h_usd: f64,
        pub fees_24h_usd: f64,
        pub apr: f64,
        pub apy: f64,
        pub current_price: f64,
        pub fee_tvl_ratio_24h: Option<f64>,
        pub dynamic_fee_pct: Option<f64>,
        pub base_fee_pct: Option<f64>,
        /// `pool_config.bin_step` — feeds the entry-shape/range-width legs
        /// (wave 97), replacing the persisted pool_snapshots read. `None`
        /// when the payload omits it → tier/coverage fall back.
        pub bin_step: Option<i64>,
        pub has_farm: Option<bool>,
        pub farm_apr: Option<f64>,
        pub farm_apy: Option<f64>,
        pub is_blacklisted: Option<bool>,
        pub token_x_freeze_authority_disabled: Option<bool>,
        pub token_y_freeze_authority_disabled: Option<bool>,
    }

    fn num(v: Option<&Value>) -> Option<f64> {
        match v {
            Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()),
            _ => None,
        }
    }

    fn boolean(v: Option<&Value>) -> Option<bool> {
        match v {
            Some(Value::Bool(b)) => Some(*b),
            _ => None,
        }
    }

    fn str(v: Option<&Value>) -> Option<String> {
        match v {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        }
    }

    /// Window map lookup (`"24h"` / `"12h"` / `"1h"`). Absent key or absent
    /// window is `None` — TS treats a missing window as unknown, never 0.
    fn window<'a>(map: Option<&'a Value>, key: &str) -> Option<&'a Value> {
        map?.get(key)
    }

    /// Strict parse of one Data API pool payload. Returns `None` on any
    /// schema drift so the caller falls through to the next stats tier —
    /// the host never guesses a field TS would have rejected.
    pub fn parse_pool_stats(raw: &str, expected_address: &str) -> Option<PoolStats> {
        let v: Value = serde_json::from_str(raw).ok()?;
        let obj = v.as_object()?;

        let address = str(obj.get("address"))?;
        // Address mismatch means we parsed a different pool's payload.
        if address != expected_address {
            return None;
        }
        let name = str(obj.get("name"))?;
        let tvl_usd = num(obj.get("tvl"))?;
        let volume_24h_usd = num(window(obj.get("volume"), "24h"))?;
        let fees_24h_usd = num(window(obj.get("fees"), "24h"))?;
        let apr = num(obj.get("apr"))?;
        // TS requires only tvl/volume24h/fees24h/apr (meteora-datapi-service.ts:103)
        // and falls back to 0 for apy/current_price (:154-155). Match that
        // exactly: a host that required them would drop pools TS accepts.
        let apy = num(obj.get("apy")).unwrap_or(0.0);
        let current_price = num(obj.get("current_price")).unwrap_or(0.0);

        let token_x = obj.get("token_x");
        let token_y = obj.get("token_y");

        Some(PoolStats {
            address,
            name,
            tvl_usd,
            volume_24h_usd,
            fees_24h_usd,
            apr,
            apy,
            current_price,
            fee_tvl_ratio_24h: num(window(obj.get("fee_tvl_ratio"), "24h")),
            dynamic_fee_pct: num(obj.get("dynamic_fee_pct")),
            base_fee_pct: num(obj.get("pool_config").and_then(|c| c.get("base_fee_pct"))),
            bin_step: obj
                .get("pool_config")
                .and_then(|c| c.get("bin_step"))
                .and_then(Value::as_i64),
            has_farm: boolean(obj.get("has_farm")),
            farm_apr: num(obj.get("farm_apr")),
            farm_apy: num(obj.get("farm_apy")),
            is_blacklisted: boolean(obj.get("is_blacklisted")),
            token_x_freeze_authority_disabled: boolean(
                token_x.and_then(|t| t.get("freeze_authority_disabled")),
            ),
            token_y_freeze_authority_disabled: boolean(
                token_y.and_then(|t| t.get("freeze_authority_disabled")),
            ),
        })
    }

    /// Cached read: prune-then-check the 30s memo, fall through to
    /// `fetch_pool_stats` on a miss. Mirrors TS's `getPoolData` cache leg
    /// (meteora-datapi-service.ts:224-228). Lock poisoning (a panicked tick
    /// holding the mutex) degrades to a direct fetch, never a blocked cycle.
    /// Consumed by the tick's live stats tiers (waves 94 + 97): its `Some`
    /// is the pool's `known` flag AND the source of the gas/entry-shape
    /// stat legs (tvl, fees24h, bin_step, current price).
    pub fn get_pool_stats(
        base_url: &str,
        pool_address: &str,
        timeout: Duration,
    ) -> Option<PoolStats> {
        if let Ok(guard) = STATS_CACHE.lock() {
            if let Some((stats, at)) = guard.get(pool_address) {
                if at.elapsed() < CACHE_TTL {
                    return Some(stats.clone());
                }
            }
        }
        let stats = fetch_pool_stats(base_url, pool_address, timeout)?;
        if let Ok(mut guard) = STATS_CACHE.lock() {
            let now = Instant::now();
            guard.retain(|_, (_, at)| now.duration_since(*at) < CACHE_TTL);
            guard.insert(pool_address.to_string(), (stats.clone(), Instant::now()));
        }
        Some(stats)
    }

    /// HTTP GET with up-to-`MAX_RETRIES` extra attempts on retriable errors
    /// only. Approximates TS's `retryEffectWithBackoff({ maxRetries: 2 })` leg
    /// (meteora-datapi-service.ts:231-246): exponential `base × 2^n` wait
    /// (rate-limit errors pay the 5s base, everything else the 1s base), NOT
    /// an exact port — TS also adds 0-50% jitter and floors at the Retry-After
    /// header. Deferred deliberately: at one request per pool per tick the
    /// burst shape that jitter protects against cannot occur, and the Data
    /// API is keyless with no Retry-After convention. Revisit if the tier
    /// ever fans out beyond one-pool-at-a-time.
    /// non-retriable errors fail immediately. `None` on every failure class —
    /// the host mirrors TS's fail-through-to-the-next-tier behaviour rather
    /// than blocking a cycle.
    pub fn fetch_pool_stats(
        base_url: &str,
        pool_address: &str,
        timeout: Duration,
    ) -> Option<PoolStats> {
        match fetch_pool_stats_retry(base_url, pool_address, timeout) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[prismd] datapi fetch failed: {e}");
                None
            }
        }
    }

    fn fetch_pool_stats_retry(
        base_url: &str,
        pool_address: &str,
        timeout: Duration,
    ) -> Result<Option<PoolStats>, String> {
        let mut attempt: u32 = 0;
        loop {
            match fetch_pool_stats_err(base_url, pool_address, timeout) {
                ok @ Ok(_) => return ok,
                Err(e) if attempt < MAX_RETRIES && is_retriable(&e) => {
                    let base = if is_rate_limited(&e) {
                        RETRY_RATE_LIMIT_DELAY
                    } else {
                        RETRY_BASE_DELAY
                    };
                    std::thread::sleep(base.saturating_mul(1 << attempt.min(10)));
                    attempt += 1;
                }
                Err(e) => return Err(e),
            }
        }
    }
    /// Same as `fetch_pool_stats` but keeps the failure reason so the probe
    /// can print it. Callers that only need the fall-through signal should use
    /// `fetch_pool_stats`.
    pub fn fetch_pool_stats_err(
        base_url: &str,
        pool_address: &str,
        timeout: Duration,
    ) -> Result<Option<PoolStats>, String> {
        let url = format!("{}/pools/{}", base_url.trim_end_matches('/'), pool_address);
        // The provider must be installed before ANY Client build.
        // `main()` installs it at startup, but unit tests reach this path
        // without going through main — and `install_default()` is Err-safe
        // when one is already installed, so this keeps every entry point
        // correct by construction.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| format!("client build: {e}"))?;
        let res = client.get(&url).send().map_err(|e| format!("{url}: {e}"))?;
        if !res.status().is_success() {
            if res.status().as_u16() == 429 {
                // 429 text carries the rate-limit token so the retry leg
                // pays the long base; other statuses fail immediately.
                return Err(format!("{url}: rate limit 429"));
            }
            return Ok(None);
        }
        let body = res.text().map_err(|e| format!("{url}: body: {e}"))?;
        Ok(parse_pool_stats(&body, pool_address))
    }
}

fn main() {
    // reqwest with `rustls-no-provider` has no default crypto provider: without
    // this, the first `Client::builder().build()` PANICS (reqwest's own client
    // construction asserts it). `install_default` returns Err if one is
    // already installed — harmless here, main runs once per process.
    let _ = rustls::crypto::ring::default_provider().install_default();

    load_env_file(Path::new(".env"));
    // argv: [profile_env_path] [--ticks N]
    let args: Vec<String> = env::args().skip(1).collect();

    // `--datapi-probe <pool>`: one-shot live read-tier smoke test. Prints the
    // parsed measured legs or `none` (every failure class collapses to the
    // same fall-through-to-next-tier signal, matching TS). Not a scan mode —
    // it exists so the rustls/ring wiring can be verified against the real API
    // rather than assumed.
    if let Some(pos) = args.iter().position(|a| a == "--datapi-probe") {
        let Some(pool) = args.get(pos + 1) else {
            eprintln!("[prismd] --datapi-probe needs a pool address");
            std::process::exit(2);
        };
        let base = env::var("METEORA_DATA_API_URL")
            .unwrap_or_else(|_| datapi::DEFAULT_BASE_URL.to_string());
        match datapi::fetch_pool_stats(&base, pool, Duration::from_secs(10)) {
            Some(s) => println!(
                "[prismd] datapi probe {} name={} tvl={:.0} vol24={:.0} fees24={:.2} apr={:.4} price={:.6} base_fee_pct={:?} has_farm={:?} farm_apr={:?} blacklisted={:?}",
                s.address, s.name, s.tvl_usd, s.volume_24h_usd, s.fees_24h_usd,
                s.apr, s.current_price, s.base_fee_pct, s.has_farm, s.farm_apr, s.is_blacklisted
            ),
            None => {
                eprintln!("[prismd] datapi probe {pool}: none (transport/parse failure — falls through)");
                std::process::exit(1);
            }
        }
        return;
    }
    let cli_ticks = match parse_cli_ticks(&args).and_then(|t| classify_args(&args, t)) {
        Ok(None) => {
            println!("prismd — paper-first Rust host (shadow only until parity green)");
            println!("usage: prismd [profile_env_path] [--ticks N]");
            return;
        }
        Ok(t) => t,
        Err(e) => {
            eprintln!("[prismd] {e}; usage: prismd [profile_env_path] [--ticks N]");
            std::process::exit(2);
        }
    };
    // Index-based skip (same as classify_args): a profile file literally
    // named e.g. `3` must still load under `--ticks 3`.
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--ticks" {
            i += 2;
            continue;
        }
        load_env_file(Path::new(&args[i]));
        i += 1;
    }
    let mut cfg = match config::Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[prismd] bad config: {e}");
            std::process::exit(2);
        }
    };
    cfg.ticks = cli_ticks;
    // Key passthrough: report set/unset only, never values.
    let helius = if env::var_os("HELIUS_API_KEY").is_some() {
        "set"
    } else {
        "unset"
    };
    let jev_key =
        if env::var_os("TYPESAFE_API_KEY").is_some() || env::var_os("TYPESAFEAI_API").is_some() {
            "set"
        } else {
            "unset"
        };
    let jup_key = if cfg.jupiter_api_key.is_empty() {
        "unset"
    } else {
        "set"
    };
    println!(
        "[prismd] paper shadow: sqlite={} interval_ms={} paper_usd={} jev={} bend={} helius={helius} jev_key={jev_key} jup_key={jup_key}",
        cfg.sqlite_path,
        cfg.scan_interval_ms,
        cfg.paper_portfolio_usd,
        cfg.jev_enabled,
        cfg.bend_bin
    );
    bend_health_check(&cfg.bend_bin);
    if cfg.agent_http_port != 0 {
        let port = cfg.agent_http_port;
        std::thread::Builder::new()
            .name("prismd-status".into())
            .spawn(move || {
                let listener = match std::net::TcpListener::bind(("127.0.0.1", port)) {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("[prismd] status listener bind 127.0.0.1:{port} failed: {e}");
                        return;
                    }
                };
                eprintln!("[prismd] status listening on 127.0.0.1:{port} (loopback only)");
                for stream in listener.incoming() {
                    let mut stream = match stream {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    // ponytail: fixed 8KB peek, no httparse dep — path match only.
                    let mut buf = [0u8; 8192];
                    #[allow(clippy::needless_borrow)]
                    let n = match std::io::Read::read(&mut stream, &mut buf) {
                        Ok(n) => n,
                        Err(_) => continue,
                    };
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let path = req.split_whitespace().nth(1).unwrap_or("/");
                    let (code, reason, body) = if path == "/health" || path.starts_with("/health?") {
                        ("200", "OK", r#"{"ok":true,"service":"prismd"}"#.to_string())
                    } else if path == "/status" || path.starts_with("/status?") {
                        (crate::status_json_body().0, crate::status_json_body().1, crate::status_json_body().2)
                    } else {
                        ("404", "Not Found", r#"{"ok":false,"error":"not found"}"#.to_string())
                    };
                    let _ = std::io::Write::write_all(
                        &mut stream,
                        format!(
                            "HTTP/1.1 {code} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    );
                }
            })
            .ok();
    }
    let mut n = 0u64;
    loop {
        n += 1;
        tick(&cfg, n);
        if cfg.ticks.is_some_and(|t| n >= t) {
            break;
        }
        thread::sleep(Duration::from_millis(cfg.scan_interval_ms));
    }
}

/// GeckoTerminal stats tier (wave 98): the TS pipeline's SECOND source —
/// datapi miss falls through to here, gecko miss falls to heuristic (the
/// host reads legs None = fail-open; TS fabricates — documented
/// divergence). Mirrors engine/gecko-terminal-service.ts: the same 2.1s
/// claim-slot pacing (30 req/min keyless), the same numeric tolerance (GT
/// mixes JSON numbers and numeric strings), volume24 required > 0, reserve
/// REQUIRED (null reserve → unavailable, :220), fees = volume ×
/// (pool_fee_percentage/100 when present, else the binStep-modeled
/// `0.0025 + binStep/1e4` base rate — CL pools report null, live-verified).
/// NEVER a measured source: `feeIlRatioKnown`/accrual stay datapi-only
/// (gecko overlay in TS leaves farm/verification/freeze null).
mod gecko {
    use serde_json::Value;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    pub const DEFAULT_BASE_URL: &str = "https://api.geckoterminal.com/api/v2";
    /// 30 req/min keyless → ≥2.1s between requests (28/min) — TS
    /// `DEFAULT_REQUEST_INTERVAL_MS` (gecko-terminal-service.ts:55).
    const REQUEST_INTERVAL: Duration = Duration::from_millis(2_100);
    /// Absolute instant the next request may start (TS nextGeckoRequestAt).
    static NEXT_SLOT: Mutex<Option<Instant>> = Mutex::new(None);

    /// Claim-slot arithmetic (TS claimGeckoRequestSlot, :182): wait until
    /// the reserved slot (or now), then push the slot one interval past
    /// max(now, slot). Pure so the test feeds (next, now) directly.
    pub fn reserve_slot(next: Option<Instant>, now: Instant) -> (Instant, Instant) {
        let start = match next {
            Some(t) if t > now => t,
            _ => now,
        };
        (start, start + REQUEST_INTERVAL)
    }

    /// Block until this request's slot arrives (tick is sync; sleeping under
    /// the mutex serializes callers — the desired pacing behavior).
    fn claim_slot() {
        let mut next = NEXT_SLOT.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        let (start, new_next) = reserve_slot(*next, now);
        *next = Some(new_next);
        if start > now {
            std::thread::sleep(start - now);
        }
    }

    /// TS `readFiniteNumber` parity (:118): JSON number OR non-empty
    /// numeric string → finite f64; everything else → None.
    fn finite(v: Option<&Value>) -> Option<f64> {
        let n = match v {
            Some(Value::Number(n)) => n.as_f64(),
            Some(Value::String(s)) => {
                let t = s.trim();
                if t.is_empty() {
                    None
                } else {
                    t.parse::<f64>().ok()
                }
            }
            _ => None,
        };
        n.filter(|f| f.is_finite())
    }

    /// Usable GeckoTerminal pool stats (TS GeckoPoolStats): reserve and
    /// volume are non-null here because the parser rejects their absence.
    pub struct GeckoStats {
        pub tvl_usd: f64,
        /// Carried for the fee-math proof in tests (fees derive from it);
        /// the tick consumes only tvl/fees/price.
        #[cfg_attr(not(test), allow(dead_code))]
        pub volume_24h_usd: f64,
        pub fees_24h_usd: f64,
        pub current_price: Option<f64>,
    }

    /// TS `parseGeckoPoolStats` (:196) plus `getPoolStats`'s reserve
    /// rejection (:220): unusable shape / volume ≤ 0 / reserve missing →
    /// None (the caller logs once). `base_fee_rate` is the binStep-modeled
    /// base-fee fraction used only when the payload reports no fee.
    pub fn parse_pool_stats(raw: &Value, base_fee_rate: f64) -> Option<GeckoStats> {
        let attrs = raw.get("data")?.get("attributes")?;
        let volume = finite(attrs.get("volume_usd").and_then(|v| v.get("h24")))?;
        if volume <= 0.0 {
            return None;
        }
        let reserve = finite(attrs.get("reserve_in_usd"))?;
        if reserve <= 0.0 {
            return None;
        }
        // TS parseFeePercentageFraction: finite, ≥0 → percent/100; null or
        // junk → the binStep-modeled rate (CL pools: field is null).
        let fee_rate = finite(attrs.get("pool_fee_percentage"))
            .filter(|p| *p >= 0.0)
            .map(|p| p / 100.0)
            .unwrap_or(base_fee_rate);
        Some(GeckoStats {
            tvl_usd: reserve,
            volume_24h_usd: volume,
            fees_24h_usd: volume * fee_rate,
            current_price: finite(attrs.get("base_token_price_usd")),
        })
    }

    /// One paced GET. Any failure → None with a warn, never an error the
    /// tick must handle — the fail-through shape of TS getGeckoPoolStats.
    pub fn get_pool_stats(
        base_url: &str,
        pool: &str,
        base_fee_rate: f64,
        timeout: Duration,
    ) -> Option<GeckoStats> {
        claim_slot();
        let url = format!(
            "{}/networks/solana/pools/{}",
            base_url.trim_end_matches('/'),
            pool
        );
        match crate::rpc::get_json(&url, timeout, None) {
            Ok(v) => {
                let parsed = parse_pool_stats(&v, base_fee_rate);
                if parsed.is_none() {
                    eprintln!("[prismd] gecko payload unusable for {pool} (volume/reserve)");
                }
                parsed
            }
            Err(e) => {
                eprintln!("[prismd] gecko fetch failed for {pool}: {e} (stats fall through)");
                None
            }
        }
    }
}

// ─── Discovery + screener: the host builds the ENTER candidate universe ───
// Port of TS adapter.discoverPools (adapter-service.ts:5605) + the private
// envelope/row validators (:836-1016) + ScreenerLive (screener-service.ts)
// + loadDiscoveryPools' top-3 consumption (program.ts:5549-5592). One wave,
// exact chain: envelope + pagination validity → row-shape validity →
// launchpad truthy-filter → mapper → adapter TVL floor + top-50 → four
// screener gates (TVL re-check, volume authenticity feesMeasured=true,
// annualized fee/TVL floor, bounded top-10 on-chain bin-utilization probe)
// → STABLE fee/TVL DESC sort → enrichment split → top-3 candidates.
// Shadow-only: the tick logs the candidates; consuming them (the ENTER
// gate chain) is the next wave — TS still owns every decision.
mod discovery {
    use serde_json::Value;
    use std::time::Duration;

    /// TS `MAX_BIN_UTILIZATION_CHECKS` (screener-service.ts:24): only the
    /// top 10 by fee/TVL get the on-chain bin probe; the rest pass through
    /// unfiltered (the per-pool scan loop re-applies the gate with full data
    /// before any ENTER).
    pub const MAX_BIN_UTILIZATION_CHECKS: usize = 10;
    /// TS adapter tail: `discovery.pools.filter(tvl >= min).slice(0, 50)`.
    pub const ADAPTER_TOP_POOLS: usize = 50;
    /// TS loadDiscoveryPools: `screened.slice(0, 3)` extend the scan set.
    pub const TOP_CANDIDATES: usize = 3;

    #[derive(Debug, Clone, PartialEq)]
    pub struct DiscoveredPool {
        pub address: String,
        pub tvl_usd: f64,
        pub volume24h_usd: f64,
        pub fees24h_usd: f64,
        pub apr: f64,
        pub bin_step: f64,
        pub token_x: String,
        pub token_y: String,
        pub created_at_ms: Option<f64>,
    }

    /// TS `ScreenedPool` (services.ts:877) — note: no binStep (TS drops it
    /// at the gate seam too).
    #[derive(Debug, Clone, PartialEq)]
    pub struct ScreenedPool {
        pub address: String,
        pub tvl_usd: f64,
        pub volume24h_usd: f64,
        pub fees24h_usd: f64,
        pub apr: f64,
        pub fee_il_ratio: f64,
        pub volume_auth: f64,
        pub bin_utilization: f64,
        pub token_x: String,
        pub token_y: String,
        pub created_at_ms: Option<f64>,
    }

    /// `ScreenerConfig` (screener-service.ts:9) — built from the SAME config
    /// values as TS's `screenerLayerConfig` (program.ts:1437).
    #[derive(Debug, Clone, Copy)]
    pub struct ScreenerCfg {
        pub min_tvl_usd: f64,
        pub min_fee_ratio: f64,
        pub volume_auth_threshold: f64,
        pub min_bin_utilization: f64,
    }

    // ── JSON predicates, exact ports of adapter-service.ts:723-740 ────────
    // serde_json keeps payload text order (preserve_order feature), so
    // `describe` matches TS `Object.keys().slice(0,5)` byte-for-byte.

    fn is_number_value(v: &Value) -> bool {
        // TS: typeof number && Number.isFinite — JSON carries no NaN/Inf,
        // but an out-of-range literal (1e400) parses to a non-finite f64 in
        // both languages, so the finiteness check is real.
        v.is_number() && v.as_f64().is_some_and(f64::is_finite)
    }

    fn is_string_value(v: &Value) -> bool {
        v.is_string()
    }

    fn describe(v: &Value) -> String {
        match v {
            Value::Null => "null".to_string(),
            Value::Array(a) => format!("array(length={})", a.len()),
            Value::Object(o) => format!(
                "object(keys={})",
                o.keys().take(5).cloned().collect::<Vec<_>>().join(",")
            ),
            Value::String(_) => "string".to_string(),
            Value::Number(_) => "number".to_string(),
            Value::Bool(_) => "boolean".to_string(),
        }
    }

    fn is_ts_truthy(v: &Value) -> bool {
        match v {
            Value::Null | Value::Bool(false) => false,
            Value::String(s) => !s.is_empty(),
            Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
            _ => true,
        }
    }

    // ── Envelope + pagination (adapter-service.ts:836-897) ────────────────

    fn envelope_parts(v: &Value) -> Option<(f64, f64, f64, f64, &Vec<Value>)> {
        let o = v.as_object()?;
        let total = o.get("total")?;
        let pages = o.get("pages")?;
        let current = o.get("current_page")?;
        let page_size = o.get("page_size")?;
        if !is_number_value(total)
            || !is_number_value(pages)
            || !is_number_value(current)
            || !is_number_value(page_size)
        {
            return None;
        }
        let data = o.get("data")?.as_array()?;
        Some((
            total.as_f64()?,
            pages.as_f64()?,
            current.as_f64()?,
            page_size.as_f64()?,
            data,
        ))
    }

    fn is_safe_int(n: f64) -> bool {
        n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
    }

    fn pagination_numbers_valid(
        total: f64,
        pages: f64,
        current: f64,
        response_page_size: f64,
    ) -> bool {
        is_safe_int(total)
            && total >= 0.0
            && is_safe_int(pages)
            && pages >= 0.0
            && is_safe_int(current)
            && current >= 1.0
            && is_safe_int(response_page_size)
            && response_page_size >= 0.0
    }

    fn pagination_range_valid(
        total: f64,
        pages: f64,
        current: f64,
        response_page_size: f64,
        requested_page: Option<i64>,
        page_size: i64,
    ) -> bool {
        if total == 0.0 {
            return requested_page.is_none()
                || requested_page.is_some_and(|r| {
                    current == r as f64 && response_page_size == page_size as f64
                });
        }
        if pages < 1.0 || response_page_size < 1.0 || current > pages {
            return false;
        }
        let Some(r) = requested_page else {
            return true;
        };
        current == r as f64 && response_page_size == page_size as f64
    }

    fn discovery_pagination_valid(
        total: f64,
        pages: f64,
        current: f64,
        response_page_size: f64,
        requested_page: Option<i64>,
        page_size: i64,
    ) -> bool {
        pagination_numbers_valid(total, pages, current, response_page_size)
            && pagination_range_valid(
                total,
                pages,
                current,
                response_page_size,
                requested_page,
                page_size,
            )
    }

    // ── Row validity (adapter-service.ts:978-1016) — the exact 7 checks ───

    fn has_pool_scalars(o: &serde_json::Map<String, Value>) -> bool {
        is_string_value(o.get("address").unwrap_or(&Value::Null))
            && is_number_value(o.get("tvl").unwrap_or(&Value::Null))
            && is_number_value(o.get("apr").unwrap_or(&Value::Null))
    }

    fn has_pool_token_leg(v: Option<&Value>) -> bool {
        v.and_then(Value::as_object)
            .is_some_and(|leg| is_string_value(leg.get("address").unwrap_or(&Value::Null)))
    }

    fn is_valid_pool_row(v: &Value) -> bool {
        let Some(o) = v.as_object() else {
            return false;
        };
        if !has_pool_scalars(o) {
            return false;
        }
        if !has_pool_token_leg(o.get("token_x")) || !has_pool_token_leg(o.get("token_y")) {
            return false;
        }
        let config_ok = o
            .get("pool_config")
            .and_then(Value::as_object)
            .is_some_and(|c| is_number_value(c.get("bin_step").unwrap_or(&Value::Null)));
        if !config_ok {
            return false;
        }
        let volume_ok = o
            .get("volume")
            .and_then(Value::as_object)
            .is_some_and(|vol| is_number_value(vol.get("24h").unwrap_or(&Value::Null)));
        if !volume_ok {
            return false;
        }
        o.get("fees")
            .and_then(Value::as_object)
            .is_some_and(|f| is_number_value(f.get("24h").unwrap_or(&Value::Null)))
    }

    // ── Mapper (adapter-service.ts:1092 `toDiscoveredPool`) ───────────────
    // Only the fields the discovery→screener→candidate chain consumes are
    // ported; the radar/launch extras (1h windows, curves, safety metadata)
    // belong to the market-gate/launch paths, not yet ported (honest scope).

    fn to_discovered_pool(row: &Value) -> Option<DiscoveredPool> {
        let address = row.get("address")?.as_str()?.to_string();
        let tvl_usd = row.get("tvl")?.as_f64()?;
        let volume24h_usd = row.get("volume")?.get("24h")?.as_f64()?;
        let fees24h_usd = row.get("fees")?.get("24h")?.as_f64()?;
        let apr = row.get("apr")?.as_f64()?;
        let bin_step = row.get("pool_config")?.get("bin_step")?.as_f64()?;
        let token_x = row.get("token_x")?.get("address")?.as_str()?.to_string();
        let token_y = row.get("token_y")?.get("address")?.as_str()?.to_string();
        // applyPoolCreatedAt: non-finite or <= 0 leaves the field ABSENT;
        // seconds-scale timestamps are promoted to ms.
        let created_at_ms = row
            .get("created_at")
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite() && *c > 0.0)
            .map(|c| {
                if c > 1_000_000_000_000.0 {
                    c
                } else {
                    c * 1000.0
                }
            });
        Some(DiscoveredPool {
            address,
            tvl_usd,
            volume24h_usd,
            fees24h_usd,
            apr,
            bin_step,
            token_x,
            token_y,
            created_at_ms,
        })
    }

    // ── parseDiscoveryResponse (adapter-service.ts:940-976) ───────────────

    pub fn parse_discovery_page(
        v: &Value,
        url: &str,
        requested_page: Option<i64>,
        page_size: i64,
    ) -> Result<Vec<DiscoveredPool>, String> {
        let Some((total, pages, current, response_page_size, data)) = envelope_parts(v) else {
            return Err(format!(
                "Meteora API returned non-envelope payload ({}) from {url}",
                describe(v)
            ));
        };
        if !discovery_pagination_valid(
            total,
            pages,
            current,
            response_page_size,
            requested_page,
            page_size,
        ) {
            return Err(format!(
                "Meteora API returned malformed pagination metadata from {url}"
            ));
        }
        let valid: Vec<&Value> = data.iter().filter(|r| is_valid_pool_row(r)).collect();
        if !data.is_empty() && valid.is_empty() {
            eprintln!(
                "[prismd] Pool discovery: ALL pool objects had invalid shape; treating as a schema error"
            );
            return Err(format!(
                "Meteora API returned {} pool rows but none matched the expected shape. Likely a schema change. Pool discovery disabled for this cycle.",
                data.len()
            ));
        }
        if valid.len() < data.len() {
            eprintln!(
                "[prismd] Pool discovery: some pool objects had invalid shape and were dropped dropped={} kept={} total={total} pages={pages}",
                data.len() - valid.len(),
                valid.len()
            );
        }
        Ok(valid
            .into_iter()
            .filter(|row| !is_ts_truthy(&row["launchpad"]))
            .filter_map(to_discovered_pool)
            .collect())
    }

    /// TS `adapter.discoverPools` tail: TVL floor + `.slice(0, 50)`.
    /// No-arg path: requestedPage is always null (the rotation paths belong
    /// to autonomous/fallen-angel mode, not yet ported), which makes
    /// page_size inert — both `pageSize` arms of TS's
    /// isPaginationRangeValid are behind `requestedPage !== null`; TS still
    /// computes `safeMeteoraPageSize(url) ?? 1000`, mirrored by the 1000.
    pub fn adapter_discover(
        v: &Value,
        url: &str,
        min_tvl_usd: f64,
    ) -> Result<Vec<DiscoveredPool>, String> {
        let mut pools = parse_discovery_page(v, url, None, 1000)?;
        pools.retain(|p| p.tvl_usd >= min_tvl_usd);
        pools.truncate(ADAPTER_TOP_POOLS);
        Ok(pools)
    }

    // ── checkVolumeAuthenticity (strategy-service.ts:195-236), score-only ─
    // feesMeasured=true is the screener's unconditional argument (its data
    // is Data-API-sourced); the host ports the argument for exactness. The
    // TS flag STRINGS are logs-only and not ported.

    pub fn check_volume_authenticity(
        tvl_usd: f64,
        volume24h_usd: f64,
        fees24h_usd: f64,
        fees_measured: bool,
    ) -> f64 {
        if tvl_usd == 0.0 {
            return 0.0;
        }
        let mut score: f64 = 1.0;
        let vol_tvl_ratio = volume24h_usd / tvl_usd;
        if vol_tvl_ratio > 10.0 {
            score -= 0.3;
        } else if vol_tvl_ratio > 5.0 {
            score -= 0.15;
        }
        if fees_measured && volume24h_usd > 0.0 {
            let fee_rate = fees24h_usd / volume24h_usd;
            if fee_rate < 0.0002 || fee_rate > 0.02 {
                score -= 0.2;
            }
        }
        if tvl_usd < 5000.0 && volume24h_usd > 100000.0 {
            score -= 0.5;
        }
        score.max(0.0)
    }

    // ── ScreenerLive.screenPools core (screener-service.ts:48-127) ────────

    pub fn screen_gates(pools: Vec<DiscoveredPool>, cfg: &ScreenerCfg) -> Vec<ScreenedPool> {
        let mut screened = Vec::new();
        for pool in pools {
            if pool.tvl_usd < cfg.min_tvl_usd {
                continue;
            }
            let auth =
                check_volume_authenticity(pool.tvl_usd, pool.volume24h_usd, pool.fees24h_usd, true);
            if auth < cfg.volume_auth_threshold {
                continue;
            }
            // Discovery data is Data-API-sourced → measured fees; the
            // screening heuristic (NOT computeFeeIlRatio — no bin-drift IL
            // here): annualized fee/TVL, 0 when either side is non-positive.
            let fee_to_tvl = if pool.fees24h_usd > 0.0 && pool.tvl_usd > 0.0 {
                (pool.fees24h_usd * 365.0) / pool.tvl_usd
            } else {
                0.0
            };
            if fee_to_tvl < cfg.min_fee_ratio {
                continue;
            }
            screened.push(ScreenedPool {
                fee_il_ratio: fee_to_tvl,
                volume_auth: auth,
                bin_utilization: 0.0,
                address: pool.address,
                tvl_usd: pool.tvl_usd,
                volume24h_usd: pool.volume24h_usd,
                fees24h_usd: pool.fees24h_usd,
                apr: pool.apr,
                token_x: pool.token_x,
                token_y: pool.token_y,
                created_at_ms: pool.created_at_ms,
            });
        }
        // TS `Array.prototype.sort` is stable and the comparator never sees
        // NaN (finite fees/tvl), so ties keep payload order — Rust's
        // `sort_by` is stable; total_cmp keeps the descending arithmetic
        // comparator's order for the ±inf corner (JS would leave it
        // unspecified).
        screened.sort_by(|a, b| b.fee_il_ratio.total_cmp(&a.fee_il_ratio));
        screened
    }

    /// Gates + the bounded top-10 enrichment. `fetch_window` returns the
    /// windowed bin utilization (Ok) or a fetch failure (None → pass-through
    /// unfiltered, exactly TS's `binArray === null || !reservesKnown`
    /// arm — the host collapses both TS shapes into one Err because
    /// known=true + zero window bins is unreachable in production: the
    /// SDK's window always contains the active bin's own account slots).
    pub fn screen<F: FnMut(&str) -> Option<f64>>(
        pools: Vec<DiscoveredPool>,
        cfg: &ScreenerCfg,
        mut fetch_window: F,
    ) -> Vec<ScreenedPool> {
        let mut enriched: Vec<ScreenedPool> = Vec::new();
        for (i, candidate) in screen_gates(pools, cfg).into_iter().enumerate() {
            if i >= MAX_BIN_UTILIZATION_CHECKS {
                enriched.push(candidate);
                continue;
            }
            match fetch_window(&candidate.address) {
                None => enriched.push(candidate),
                Some(utilization) if utilization < cfg.min_bin_utilization => {
                    eprintln!(
                        "[prismd] Candidate filtered by bin utilization pool={} utilization={utilization:.2} min={:.2}",
                        candidate.address, cfg.min_bin_utilization
                    );
                }
                Some(utilization) => {
                    let mut annotated = candidate;
                    annotated.bin_utilization = utilization;
                    enriched.push(annotated);
                }
            }
        }
        enriched
    }

    /// TS net discovery gate (shouldDiscoverPools ∧ autonomous == "off"):
    /// the host models no autonomous mode, so the net condition is exactly
    /// enable ∧ paper — screenPools never runs in autonomous mode in TS
    /// (program.ts:5564 returns first).
    pub fn should_discover(enable_pool_discovery: bool, paper_trading: bool) -> bool {
        enable_pool_discovery && paper_trading
    }

    /// One discovery pass per tick: fetch the LIST page, run the chain,
    /// emit TS's own console lines. Any transport/parse/envelope failure
    /// funnels into TS's single fallback warn (its DiscoverPoolsError
    /// messages are byte-mirrored for the envelope/pagination/schema arms;
    /// the transport arm carries the host's own reqwest wording — different
    /// logger, same diagnostic, never asserted). The top-3 candidates are
    /// NOT yet consumed by the host loop (next wave) — logged only.
    pub fn run(cfg: &crate::config::Config) {
        let timeout = Duration::from_secs(10);
        let url = cfg.meteora_pools_url.as_str();
        let pools = match crate::rpc::get_json(url, timeout, None)
            .and_then(|v| adapter_discover(&v, url, cfg.discovery_min_tvl_usd))
        {
            Ok(p) => p,
            Err(msg) => {
                eprintln!(
                    "[prismd] Pool discovery failed; falling back to watchlist-only mode: {msg}"
                );
                return;
            }
        };
        let screener_cfg = ScreenerCfg {
            min_tvl_usd: cfg.discovery_min_tvl_usd,
            min_fee_ratio: cfg.discovery_min_fee_ratio,
            volume_auth_threshold: cfg.volume_auth_threshold,
            min_bin_utilization: cfg.min_bin_utilization,
        };
        let rpc_url = cfg.solana_rpc_url.as_str();
        let screened = screen(pools, &screener_cfg, |address| {
            match crate::rpc::bin_window_utilization(rpc_url, address, timeout) {
                Ok(u) => Some(u),
                Err(e) => {
                    eprintln!("[prismd] Bin data unavailable for candidate — skipping utilization gate pool={address} error={e}");
                    None
                }
            }
        });
        if screened.is_empty() {
            return;
        }
        // TS's own console lines (program.ts:5583-5586), byte-mirrored:
        // console.info → stdout, toFixed(2) → {:.2}.
        println!("Discovered {} candidate pools", screened.len());
        for candidate in screened.iter().take(TOP_CANDIDATES) {
            println!(
                "  Candidate: {} (fee/IL: {:.2})",
                candidate.address, candidate.fee_il_ratio
            );
        }
    }
}

/// Solana JSON-RPC 2.0 client — the host's ONLY chain read surface.
///
/// Scope deliberately minimal: `getBalance` (native SOL lamports),
/// `getParsedTokenAccountsByOwner` (SPL holdings) and `getAccountInfo`
/// (the `LbPair` state read) are the calls the wallet and stats tiers need
/// before pricing. Pricing (Jupiter `fetchTokenPrices`) is a separate tier,
/// and tx submission is Phase 3's LAST item — paper-first per the plan.
///
/// Fail-closed everywhere: a transport error, a non-2xx status, an RPC-level
/// `error` object, or an unexpected result shape all yield `Err` with the
/// reason. The caller decides how to degrade (TS's `readWalletSnapshot`
/// degrades SPL enumeration to SOL-only; it never degrades the SOL read
/// itself, because native SOL is real capital).
mod rpc {
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::time::Duration;

    /// Both token programs are enumerated by the wallet-valuation path (the
    /// tick reads legacy first, Token-2022 second — TS `readWalletHoldingsRaw`
    /// loop, adapter-service.ts:2866).
    pub const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    pub const TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    /// Wrapped-SOL mint — the price key for the native lamport leg in the
    /// Jupiter batch (TS `SOL_MINT`; native and wSOL are distinct storage,
    /// so the two legs never double-count).
    pub const SOL_MINT: &str = "So11111111111111111111111111111111111111112";
    pub const LAMPORTS_PER_SOL: f64 = 1_000_000_000.0;

    /// A per-call request id. Not a session: the host is single-threaded per
    /// tick, and the id exists only so a mismatched response can be detected.
    fn next_id() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(1);
        SEQ.fetch_add(1, Ordering::Relaxed)
    }

    fn post(url: &str, body: Value, timeout: Duration) -> Result<Value, String> {
        // Same boundary rule as the datapi tier: install the rustls provider
        // here so unit tests reach a working Client without going through
        // main(). `install_default` is Err-safe when already installed.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| format!("client build: {e}"))?;
        let res = client
            .post(url)
            .json(&body)
            .send()
            .map_err(|e| format!("{url}: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("{url}: HTTP {}", res.status().as_u16()));
        }
        let text = res.text().map_err(|e| format!("{url}: body: {e}"))?;
        let parsed: Value = serde_json::from_str(&text).map_err(|e| format!("{url}: json: {e}"))?;
        // An RPC-level error object is a failure even under HTTP 200 — this is
        // how "Method not found" / rate-limit / bad-params arrive.
        if let Some(err) = parsed.get("error") {
            return Err(format!("{url}: rpc error: {err}"));
        }
        Ok(parsed)
    }

    /// Native SOL lamports for `pubkey`. Mirrors `readNativeSolBalance`
    /// (adapter-service.ts:2826-2845) minus the 30s cache (the host reads once
    /// per tick and the cache is a per-process TS concern).
    pub fn get_balance_lamports(url: &str, pubkey: &str, timeout: Duration) -> Result<u64, String> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": next_id(),
            "method": "getBalance",
            "params": [pubkey],
        });
        let res = post(url, body, timeout)?;
        let value = res
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("{url}: getBalance: missing result.value"))?;
        Ok(value)
    }

    /// Anchor discriminator of the DLMM `LbPair` account (sighash of
    /// "account:LbPair", embedded in the IDL shipped with @meteora-ag/dlmm).
    pub const LB_PAIR_DISCRIMINATOR: [u8; 8] = [33, 11, 49, 98, 181, 101, 177, 13];
    /// Byte offset of `active_id` (i32 LE) inside a `LbPair` account:
    /// 8-byte discriminator + repr(C) walk of StaticParameters (size 32,
    /// align 4) + VariableParameters (size 32, align 8) + bump_seed [u8;1] +
    /// bin_step_seed [u8;2] + pair_type u8 → 8+32+32+1+2+1 = 76. `bin_step`
    /// (u16 LE) follows immediately at 80 — both live-validated: the same
    /// account yielded activeId == the TS SDK's `getActiveBin().binId`
    /// (2463 == 2463, 2026-09-22) and bin_step 20 == the Data API's
    /// `pool_config.bin_step`. The IDL marks the type
    /// `serialization: "bytemuck"` (repr(C) POD), so the layout is fixed.
    pub const ACTIVE_ID_OFFSET: usize = 76;
    pub const BIN_STEP_OFFSET: usize = 80;

    /// Pure parse of a raw `LbPair` account: discriminator check, then
    /// `(active_id, bin_step)`. TS reads the same pair off `lbPair`
    /// (adapter-service.ts:3729 for binStep).
    pub fn parse_lb_pair(data: &[u8]) -> Result<(i32, u16), String> {
        if data.len() < BIN_STEP_OFFSET + 2 {
            return Err(format!("lbPair account too short: {} bytes", data.len()));
        }
        if data[..8] != LB_PAIR_DISCRIMINATOR {
            return Err("discriminator mismatch (not a DLMM LbPair account)".to_string());
        }
        let active_id = i32::from_le_bytes([
            data[ACTIVE_ID_OFFSET],
            data[ACTIVE_ID_OFFSET + 1],
            data[ACTIVE_ID_OFFSET + 2],
            data[ACTIVE_ID_OFFSET + 3],
        ]);
        let bin_step = u16::from_le_bytes([data[BIN_STEP_OFFSET], data[BIN_STEP_OFFSET + 1]]);
        Ok((active_id, bin_step))
    }

    /// LIVE `(active_id, bin_step)` for the `lb_pair` account —
    /// `getAccountInfo` (base64) then `parse_lb_pair`. Host twin of TS
    /// `dlmm.getActiveBin()` + `lbPair.binStep` (adapter-service.ts:2200,
    /// :3729): ONE RPC, no SDK.
    pub fn get_lb_pair_state(
        url: &str,
        lb_pair: &str,
        timeout: Duration,
    ) -> Result<(i32, u16), String> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": next_id(),
            "method": "getAccountInfo",
            "params": [lb_pair, {"encoding": "base64", "commitment": "confirmed"}],
        });
        let res = post(url, body, timeout)?;
        use base64::Engine as _;
        let b64 = res
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.get("data"))
            .and_then(|d| d.get(0))
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{url}: getAccountInfo: missing data[0]"))?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("{url}: base64: {e}"))?;
        parse_lb_pair(&data)
    }

    /// Meteora DLMM program — owner of every `LbPair` and `BinArray` account.
    /// LIVE-VALIDATED: a getProgramAccounts with this id returns 31
    /// dataSize-10136 arrays for the captured pool (the look-alike
    /// `LBUZKh…cCzhZhLSW1CzgNbcX` fails `-32602 WrongSize` — not a valid
    /// pubkey). A wrong id degrades LOUDLY: zero arrays → the per-tick
    /// "no BinArray" warn + concentration-1 fail-open, never a
    /// wrong-positive ratio.
    pub const DLMM_PROGRAM_ID: &str = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
    /// `MAX_BIN_PER_ARRAY` (SDK CONSTANTS table, live value "70").
    /// Test-only since the parser derives SIZE from the account itself — its
    /// remaining job is the fixture cross-check (advisory: CONSTANTS never
    /// gate production parsing).
    #[cfg(test)]
    pub const BIN_ARRAY_SIZE: i64 = 70;
    /// Anchor discriminator of a `BinArray` account.
    pub const BIN_ARRAY_DISCRIMINATOR: [u8; 8] = [92, 142, 92, 220, 5, 148, 70, 181];
    /// `lb_pair` pubkey offset — the SDK's own `binArrayLbPairFilter` (8 + 16),
    /// so the getProgramAccounts filter below mirrors the SDK path exactly.
    pub const BIN_ARRAY_LB_PAIR_OFFSET: usize = 24;
    const BIN_ARRAY_BINS_OFFSET: usize = 56; // disc8 + index i64 + version u8 + pad7 + lb_pair 32
    /// One `Bin` slot: repr(C) with u128 fields → 16-byte aligned; on the
    /// CI/host target (aarch64 + x86-64) u128 aligns to 16 → 144 bytes.
    /// Validated against the captured fixture (see `parse_bin_array` tests).
    const BIN_SLOT_SIZE: usize = 144;

    /// One slot of a `BinArray`: `(bin_id, liquidity_supply)`. `bin_id`
    /// derives from the array's index (lower = index × 70, k-th slot =
    /// lower + k — the SDK's `getBinIdIndexInBinArray` inverts exactly
    /// this); `liquidity_supply` is the concentration weight TS's
    /// `computeConcentrationMultiplier` reads.
    pub struct BinSlot {
        pub bin_id: i64,
        /// IDL `Bin.amount_x` (u64 LE, slot bytes 0..8) — the SDK's
        /// `reserveX` (strategy-service.ts:231 reads `b.xAmount`). Parsed
        /// for the screener's bin-utilization OR (x || y || supply); the
        /// concentration weight below is unchanged.
        pub reserve_x: u64,
        /// IDL `Bin.amount_y` (u64 LE, slot bytes 8..16) — the SDK's
        /// `reserveY`.
        pub reserve_y: u64,
        pub liquidity_supply: u128,
    }

    /// Pure parse of a raw `BinArray` account → `(index, slots)`. Fails
    /// closed on a bad discriminator/short buffer; slots are parsed while
    /// full 144-byte records fit (the caller picks the account whose
    /// `[index×70, index×70+69]` range contains the active bin — the same
    /// containment test the SDK's `isBinIdWithinBinArray` performs).
    pub fn parse_bin_array(data: &[u8]) -> Result<(i64, Vec<BinSlot>), String> {
        if data.len() < BIN_ARRAY_BINS_OFFSET + BIN_SLOT_SIZE {
            return Err(format!("bin array account too short: {} bytes", data.len()));
        }
        if data[..8] != BIN_ARRAY_DISCRIMINATOR {
            return Err("discriminator mismatch (not a DLMM BinArray account)".to_string());
        }
        // SIZE derived from the ACCOUNT, not the CONSTANTS table (advisory):
        // version-proof and self-validating — exact division or reject. The
        // SDK's MAX_BIN_PER_ARRAY cross-checks this in the fixture test.
        let payload = data.len() - BIN_ARRAY_BINS_OFFSET;
        if !payload.is_multiple_of(BIN_SLOT_SIZE) {
            return Err(format!(
                "bin payload {payload} is not a multiple of the {BIN_SLOT_SIZE}-byte slot"
            ));
        }
        let size = payload / BIN_SLOT_SIZE;
        let index = i64::from_le_bytes(data[8..16].try_into().expect("8-byte slice"));
        let mut slots = Vec::with_capacity(size);
        for k in 0..size {
            let base = BIN_ARRAY_BINS_OFFSET + k * BIN_SLOT_SIZE;
            let bin_id = index
                .checked_mul(size as i64)
                .and_then(|lower| lower.checked_add(k as i64))
                .ok_or_else(|| "bin id overflow".to_string())?;
            let liq_lo =
                u64::from_le_bytes(data[base + 32..base + 40].try_into().expect("8-byte slice"));
            let liq_hi =
                u64::from_le_bytes(data[base + 40..base + 48].try_into().expect("8-byte slice"));
            let reserve_x =
                u64::from_le_bytes(data[base..base + 8].try_into().expect("8-byte slice"));
            let reserve_y =
                u64::from_le_bytes(data[base + 8..base + 16].try_into().expect("8-byte slice"));
            slots.push(BinSlot {
                bin_id,
                reserve_x,
                reserve_y,
                liquidity_supply: u128::from(liq_lo) | (u128::from(liq_hi) << 64),
            });
        }
        Ok((index, slots))
    }

    /// Does the array at `index` with `size` slots hold `active_id`? The
    /// SDK's `isBinIdWithinBinArray` over `getBinArrayLowerUpperBinId` bounds
    /// (index×size ..= index×size+size−1) — pure comparison, NO division
    /// (the signed-index floor hazard does not apply: the index arrives from
    /// the account itself, never derived from activeId). One definition for
    /// the picker below and the tests; negative indexes mirror the JS BN math
    /// exactly (−1 covers −70..−1).
    pub fn bin_array_contains(index: i64, active_id: i64, size: i64) -> bool {
        let lower = index.wrapping_mul(size);
        active_id >= lower && active_id < lower.wrapping_add(size)
    }

    /// The pool's `BinArray` CONTAINING `active_id` — one
    /// getProgramAccounts with the SDK's own lb_pair memcmp filter (offset
    /// 24), then the SDK's containment test per result. Fail → None with a
    /// warn (the estimator falls to its concentration-1 / binStep-proxy
    /// arms, exactly TS's `reservesKnown: false` path).
    /// Every `BinArray` account of the pool (the SDK's own memcmp filter),
    /// parsed. Query/shape/parse failures print the diagnostic and Err —
    /// `get_bin_array` maps that to its historical `None`, the screener's
    /// window maps it to the pass-through.
    pub fn gpa_bin_arrays(
        url: &str,
        lb_pair: &str,
        timeout: Duration,
    ) -> Result<Vec<(i64, Vec<BinSlot>)>, String> {
        use base64::Engine as _;
        let body = json!({
            "jsonrpc": "2.0",
            "id": next_id(),
            "method": "getProgramAccounts",
            "params": [
                DLMM_PROGRAM_ID,
                {
                    "encoding": "base64",
                    "filters": [{"memcmp": {"offset": BIN_ARRAY_LB_PAIR_OFFSET, "bytes": lb_pair}}]
                }
            ],
        });
        let res = post(url, body, timeout).map_err(|e| {
            eprintln!("[prismd] bin-array query failed for {lb_pair}: {e}");
            e
        })?;
        let Some(accounts) = res.get("result").and_then(Value::as_array) else {
            let e = "unexpected getProgramAccounts result shape".to_string();
            eprintln!("[prismd] bin-array query for {lb_pair}: {e}");
            return Err(e);
        };
        let mut arrays = Vec::new();
        for acct in accounts {
            let Some(b64) = acct
                .get("account")
                .and_then(|a| a.get("data"))
                .and_then(|d| d.get(0))
                .and_then(Value::as_str)
            else {
                continue;
            };
            let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(b64) else {
                continue;
            };
            match parse_bin_array(&raw) {
                Ok((idx, slots)) => arrays.push((idx, slots)),
                Err(e) => {
                    // A parse failure on a memcmp-matched account means a
                    // wrong program/layout: warn loudly and fail the fetch.
                    eprintln!("[prismd] bin-array parse failed: {e}");
                    return Err(e);
                }
            }
        }
        Ok(arrays)
    }

    pub fn get_bin_array(
        url: &str,
        lb_pair: &str,
        active_id: i64,
        timeout: Duration,
    ) -> Option<(i64, Vec<BinSlot>)> {
        let arrays = match gpa_bin_arrays(url, lb_pair, timeout) {
            Ok(a) => a,
            Err(_) => return None,
        };
        for (idx, slots) in arrays {
            if bin_array_contains(idx, active_id, slots.len() as i64) {
                return Some((idx, slots));
            }
        }
        eprintln!("[prismd] no BinArray contains active bin {active_id} for {lb_pair}");
        None
    }

    /// TS adapter `getBinArray` window: `getBinsAroundActiveBin(20, 20)`
    /// filtered INCLUSIVE to `[active-20, active+20]` (adapter-service.ts
    /// :4474 + :2297) — up to 41 ids. The denominator is the ids PRESENT in
    /// the pool's own BinArrays within the span: accounts always carry all
    /// their slots (the SDK's "zero placeholders" are those zero-liquidity
    /// slots), and ids outside every array exist on neither side (the SDK
    /// omits them too — known=true + zero bins is unreachable in TS
    /// production). Err (no coverage / transport / parse) lands as the
    /// screener's pass-through, exactly TS's null/!reservesKnown arm.
    pub const BIN_WINDOW_HALF: i64 = 20;

    /// TS `computeBinUtilization`'s per-bin OR (strategy-service.ts:239):
    /// a bin is active when ANY leg holds value; unknown/empty report 0 and
    /// are screened by the caller (see the window doc above).
    pub fn slot_active(slot: &BinSlot) -> bool {
        slot.reserve_x > 0 || slot.reserve_y > 0 || slot.liquidity_supply > 0
    }

    pub fn window_utilization(
        arrays: &[(i64, Vec<BinSlot>)],
        active_id: i64,
    ) -> Result<f64, String> {
        let lo = active_id - BIN_WINDOW_HALF;
        let hi = active_id + BIN_WINDOW_HALF;
        let mut present = 0usize;
        let mut active = 0usize;
        for (_, slots) in arrays {
            for slot in slots {
                if slot.bin_id >= lo && slot.bin_id <= hi {
                    present += 1;
                    if slot_active(slot) {
                        active += 1;
                    }
                }
            }
        }
        if present == 0 {
            return Err(format!(
                "no BinArray bins in window [{lo}, {hi}] for the active bin {active_id}"
            ));
        }
        Ok(active as f64 / present as f64)
    }

    /// Live windowed utilization for a candidate pool: LbPair active id +
    /// the pool's arrays → the ±20 window. The twin of TS's
    /// `getBinArray(halfRange=20)` at the exact shape the screener needs.
    pub fn bin_window_utilization(
        url: &str,
        lb_pair: &str,
        timeout: Duration,
    ) -> Result<f64, String> {
        let (active_id, _bin_step) = get_lb_pair_state(url, lb_pair, timeout)?;
        let arrays = gpa_bin_arrays(url, lb_pair, timeout)?;
        window_utilization(&arrays, i64::from(active_id))
    }

    /// One mint → atomic amount entry. `decimals` comes from the parsed
    /// account (TS reads it from the same `tokenAmount` object,
    /// `parseHoldingRow`). Zero-amount rent-only ATAs are skipped — the TS
    /// path skips them too (the `amount <= 0` guard in readWalletSnapshot).
    #[derive(Debug, Clone, PartialEq)]
    pub struct Holding {
        pub mint: String,
        pub amount_atomic: u128,
        pub decimals: u8,
    }

    /// SPL holdings for `pubkey` under one token program. Mirrors
    /// `readWalletHoldingsRaw` (adapter-service.ts:2857-2882): unfiltered
    /// token-account enumeration (canonical `getTokenAccountsByOwner` +
    /// `jsonParsed` — the `getParsedTokenAccountsByOwner` alias was dropped by
    /// Agave 4.3, live-verified 2026-09-22: both Helius and mainnet-beta
    /// answer it `-32601 Method not found`), accumulate per mint. A parse miss on
    /// one account skips that account (TS's `isObject` guards do the same) —
    /// it never fails the whole read.
    /// Consumed by the wallet valuation: the tick reads both programs and
    /// prices the union (either call failing degrades to native-only, TS
    /// `readWalletSnapshot` :2921-2934).
    pub fn get_spl_holdings(
        url: &str,
        pubkey: &str,
        program_id: &str,
        timeout: Duration,
    ) -> Result<Vec<Holding>, String> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": next_id(),
            "method": "getTokenAccountsByOwner",
            "params": [
                pubkey,
                { "programId": program_id },
                { "encoding": "jsonParsed" },
            ],
        });
        let res = post(url, body, timeout)?;
        let accounts = res
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{url}: getParsedTokenAccountsByOwner: missing result.value"))?;
        let mut out: Vec<Holding> = Vec::new();
        for account in accounts {
            let Some(info) = account
                .get("account")
                .and_then(|a| a.get("data"))
                .and_then(|d| d.get("parsed"))
                .and_then(|p| p.get("info"))
            else {
                continue;
            };
            let Some(amount_obj) = info.get("tokenAmount") else {
                continue;
            };
            // `amount` is a decimal STRING in the parsed shape — parse as u128
            // rather than f64 so a large balance never loses precision.
            let Some(amount_str) = amount_obj.get("amount").and_then(Value::as_str) else {
                continue;
            };
            let Ok(amount_atomic) = amount_str.parse::<u128>() else {
                continue;
            };
            if amount_atomic == 0 {
                continue;
            }
            let Some(mint) = info.get("mint").and_then(Value::as_str) else {
                continue;
            };
            let decimals = amount_obj
                .get("decimals")
                .and_then(Value::as_u64)
                .and_then(|d| u8::try_from(d).ok())
                .unwrap_or(0);
            if let Some(existing) = out.iter_mut().find(|h| h.mint == mint) {
                existing.amount_atomic += amount_atomic;
            } else {
                out.push(Holding {
                    mint: mint.to_string(),
                    amount_atomic,
                    decimals,
                });
            }
        }
        Ok(out)
    }

    /// Jupiter price v3 row → USD map for exactly the requested mints. Mirrors
    /// `parseJupiterMintPrice` (adapter-service.ts:1409-1415): direct
    /// `usdPrice` first (live-verified numeric, 2026-09-22), else the
    /// v2-shaped nested `data[mint].price`; `isNumberValue` parity — a string,
    /// non-finite or non-positive row yields ABSENT, and the valuation skips
    /// absent mints fail-closed (never a fabricated price).
    pub fn parse_jupiter_prices(json: &Value, mints: &[String]) -> HashMap<String, f64> {
        let mut out = HashMap::new();
        for mint in mints {
            let price = json
                .get(mint.as_str())
                .and_then(|row| row.get("usdPrice"))
                .or_else(|| {
                    json.get("data")
                        .and_then(|d| d.get(mint.as_str()))
                        .and_then(|row| row.get("price"))
                })
                .and_then(Value::as_f64)
                .filter(|p| p.is_finite() && *p > 0.0);
            if let Some(p) = price {
                out.insert(mint.clone(), p);
            }
        }
        out
    }

    /// GET JSON without a JSON-RPC envelope. Same rustls-install boundary as
    /// `post`: unit tests reach a working Client without going through main().
    pub fn get_json(url: &str, timeout: Duration, api_key: Option<&str>) -> Result<Value, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::blocking::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| format!("client build: {e}"))?;
        let mut req = client.get(url);
        if let Some(k) = api_key {
            req = req.header("x-api-key", k);
        }
        let res = req.send().map_err(|e| format!("{url}: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("{url}: HTTP {}", res.status().as_u16()));
        }
        let text = res.text().map_err(|e| format!("{url}: body: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("{url}: json: {e}"))
    }

    /// Mint → USD for the requested mints via Jupiter price v3. Mirrors
    /// `fetchJupiterPrices` (adapter-service.ts:2530-2549): primary
    /// `api.jup.ag` (optional `x-api-key`; live-verified keyless 200), then
    /// the keyless lite host when the primary is non-2xx/unparseable or
    /// priced nothing — same schema. NEVER fails: both hosts down or garbage
    /// returns an EMPTY map, which the TS-faithful valuation turns into
    /// skip-everything (wallet reads measured $0 → entries pause; EXITs stay
    /// free), exactly like TS's `Effect.catch(() => ({}))`.
    pub fn get_jupiter_prices(
        api_key: &str,
        mints: &[String],
        timeout: Duration,
    ) -> HashMap<String, f64> {
        if mints.is_empty() {
            return HashMap::new();
        }
        let ids = mints.join(",");
        let key = (!api_key.is_empty()).then_some(api_key);
        match get_json(
            &format!("https://api.jup.ag/price/v3?ids={ids}"),
            timeout,
            key,
        ) {
            Ok(v) => {
                let priced = parse_jupiter_prices(&v, mints);
                if !priced.is_empty() {
                    return priced;
                }
            }
            Err(e) => eprintln!("[prismd] jupiter primary price read failed: {e} (trying lite)"),
        }
        match get_json(
            &format!("https://lite-api.jup.ag/price/v3?ids={ids}"),
            timeout,
            None,
        ) {
            Ok(v) => parse_jupiter_prices(&v, mints),
            Err(e) => {
                eprintln!("[prismd] jupiter lite price read failed: {e} (unpriced mints skip)");
                HashMap::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::datapi::{parse_pool_stats, PoolStats};

    /// Real captured payload for ZEC-SOL (8eybKAvjKJryVweQLg8SRgwUfdP7wHYJ5yyqgfE82DQA),
    /// fetched 2026-09-21 from the live Data API. Numbers move, so the test
    /// pins the SHAPE and the exact keys the shadows consume, not the values.
    const DATAPI_ZEC_SOL: &str = include_str!("datapi_zec_sol.json");

    fn zec_sol() -> PoolStats {
        parse_pool_stats(
            DATAPI_ZEC_SOL,
            "8eybKAvjKJryVweQLg8SRgwUfdP7wHYJ5yyqgfE82DQA",
        )
        .expect("captured payload parses")
    }

    #[test]
    fn datapi_parses_measured_legs() {
        let s = zec_sol();
        assert_eq!(s.name, "ZEC-SOL");
        // The measured tier: tvl + volume + fees are all present and finite.
        assert!(s.tvl_usd > 0.0);
        assert!(s.volume_24h_usd > 0.0);
        assert!(s.fees_24h_usd > 0.0);
        // base_fee_pct lives under pool_config — the EP lane's fee leg.
        assert_eq!(s.base_fee_pct, Some(0.2));
        // pool_config.bin_step too (wave 97: feeds the shape/range legs).
        assert_eq!(s.bin_step, Some(20));
        assert_eq!(s.has_farm, Some(false));
        assert_eq!(s.farm_apr, Some(0.0));
        assert_eq!(s.is_blacklisted, Some(false));
        // Freeze flags come off token_x/token_y, not the pool root.
        assert_eq!(s.token_x_freeze_authority_disabled, Some(true));
        assert_eq!(s.token_y_freeze_authority_disabled, Some(true));
    }

    #[test]
    fn datapi_matches_ts_required_leg_set() {
        // TS requires only tvl/volume24h/fees24h/apr and defaults apy +
        // current_price to 0 (meteora-datapi-service.ts:103,154-155). A pool
        // with those four present and apy/price absent MUST still parse, or
        // the host drops pools TS would accept.
        let raw =
            r#"{"address":"a","name":"x","tvl":1,"volume":{"24h":1},"fees":{"24h":1},"apr":1}"#;
        let s = parse_pool_stats(raw, "a").expect("TS's four required legs suffice");
        assert_eq!(s.apy, 0.0);
        assert_eq!(s.current_price, 0.0);
        assert_eq!(
            s.bin_step, None,
            "no pool_config → bin_step absent, never guessed"
        );
    }

    #[test]
    fn datapi_rejects_address_mismatch() {
        // A different pool's payload must not be attributed to the caller.
        assert!(
            parse_pool_stats(DATAPI_ZEC_SOL, "SoMeOtHeRpOoLaddRess111111111111111111111").is_none()
        );
    }

    #[test]
    fn datapi_fails_closed_on_drift() {
        // Missing a required leg -> None (fall through to the next tier),
        // never a zero-filled struct.
        for broken in [
            r#"{"name":"x","tvl":1,"apr":1,"apy":1,"current_price":1}"#,
            r#"{"address":"a","name":"x","tvl":1,"volume":{},"fees":{"24h":1},"apr":1,"apy":1,"current_price":1}"#,
            "not json at all",
            "",
        ] {
            assert!(
                parse_pool_stats(broken, "a").is_none(),
                "payload must fail closed: {broken}"
            );
        }
    }

    #[test]
    fn datapi_cache_memo_avoids_second_fetch() {
        use super::datapi::{
            cache_clear_for_test, cache_insert_for_test, cache_len_for_test, get_pool_stats,
            parse_pool_stats,
        };
        // Positive memo proof without network: seed exactly what a successful
        // fetch would store, then assert `get_pool_stats` returns it WITHOUT
        // touching the (unreachable) host. The memo is the whole point of
        // this tier: at N tracked pools and a 10s scan interval, an uncached
        // tier would issue 6× TS's request volume for identical data.
        cache_clear_for_test();
        let seeded = parse_pool_stats(
            r#"{"address":"pool-A","name":"x","tvl":100,"volume":{"24h":10},"fees":{"24h":1},"apr":0.1}"#,
            "pool-A",
        )
        .expect("fixture parses");
        cache_insert_for_test("pool-A".to_string(), seeded.clone());
        assert_eq!(cache_len_for_test(), 1);
        let hit = get_pool_stats(
            "http://127.0.0.1:9",
            "pool-A",
            std::time::Duration::from_millis(50),
        );
        assert_eq!(hit, Some(seeded), "cache hit must return without fetching");
        // Negative leg: an unreachable host yields None and caches NOTHING —
        // failures are never memoized, so fail-open retries next read.
        let miss = get_pool_stats(
            "http://127.0.0.1:9",
            "pool-nonexistent",
            std::time::Duration::from_millis(50),
        );
        assert!(miss.is_none(), "unreachable host must miss");
        assert_eq!(cache_len_for_test(), 1, "failures are never cached");
        cache_clear_for_test();
    }

    #[test]
    fn datapi_is_retriable_matches_ts_arms() {
        use super::datapi::{CACHE_TTL, MAX_RETRIES};
        // 429/rate-limit/too-many-requests always retriable; timeouts too.
        for msg in [
            "https://x/pools/a: rate limit 429",
            "HTTP 429 Too Many Requests",
            "rate limit exceeded",
            "Too many requests",
            "operation timed out",
            "request timeout after 10s",
        ] {
            assert!(super::datapi::is_retriable_pub(msg), "retriable: {msg}");
        }
        // Parse drift, 404s, client-build failures fail immediately.
        for msg in [
            "https://x/pools/a: 404 Not Found",
            "client build: no TLS provider",
            "https://x/pools/a: body: invalid utf-8",
        ] {
            assert!(
                !super::datapi::is_retriable_pub(msg),
                "not retriable: {msg}"
            );
        }
        assert_eq!(MAX_RETRIES, 2);
        assert_eq!(CACHE_TTL, std::time::Duration::from_secs(30));
    }

    #[test]
    fn datapi_optional_legs_absent_not_zero() {
        // A payload with the required legs but no optional ones keeps the
        // optional legs None — an omitted window is unknown, never 0.
        let raw = r#"{"address":"a","name":"x","tvl":1,"volume":{"24h":1},"fees":{"24h":1},"apr":1,"apy":1,"current_price":1}"#;
        let s = parse_pool_stats(raw, "a").expect("required legs present");
        assert_eq!(s.base_fee_pct, None);
        assert_eq!(s.has_farm, None);
        assert_eq!(s.farm_apr, None);
        assert_eq!(s.is_blacklisted, None);
        assert_eq!(s.token_x_freeze_authority_disabled, None);
        assert_eq!(s.fee_tvl_ratio_24h, None);
    }

    use super::*;

    #[test]
    fn fee_il_clamp_mirrors_ts_bands() {
        assert_eq!(clamp_fee_il(0.0), 0.3);
        assert_eq!(clamp_fee_il(0.29), 0.3);
        assert_eq!(clamp_fee_il(0.3), 0.3);
        assert_eq!(clamp_fee_il(1.5), 1.5);
        assert_eq!(clamp_fee_il(3.0), 3.0);
        assert_eq!(clamp_fee_il(3.01), 3.0);
        assert_eq!(clamp_fee_il(13.92), 3.0); // evolution-runaway class
    }

    #[test]
    fn exit_always_approved_never_gated() {
        // Capital protection: no confidence threshold, no Jev veto — always free.
        assert!(exit_approved());
        let jev: Option<f64> = jev_soft_gate(true, Ok(0.01));
        assert!(exit_approved(), "low jev score {jev:?} must not gate EXIT");
        let jev_none: Option<f64> = jev_soft_gate(true, Err("down"));
        assert!(
            exit_approved(),
            "jev outage {jev_none:?} must not gate EXIT"
        );
    }

    #[test]
    fn jev_fail_open() {
        assert_eq!(jev_soft_gate(false, Ok(0.9)), None); // disabled → no opinion
        assert_eq!(jev_soft_gate(true, Err("timeout")), None); // error → no opinion
        assert_eq!(jev_soft_gate(true, Err("not wired")), None);
        assert_eq!(jev_soft_gate(true, Ok(0.72)), Some(0.72)); // pass-through only
    }

    /// Mirrors `bench/bend-parity-harness.ts`'s `isBendAvailable`: skip (do
    /// not fail) subprocess-dependent tests when `bend` is absent, e.g. on a
    /// dev machine or a CI job that does not install it.
    /// Resolved `bend` binary path, or None. Installer moved the binary in
    /// 2.0.21+: probe the current `~/.bend/bend/bin/bend` layout, the legacy
    /// `~/.bend/bin/bend`, then PATH. Gated tests skip (never fail) when none
    /// resolve. Returns the PATH so wrappers don't re-do PATH lookup (which
    /// fails when the installer dir isn't on PATH).
    fn bend_bin() -> Option<String> {
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates = [
            std::env::var("BEND_BIN").ok(),
            Some(format!("{home}/.bend/bend/bin/bend")),
            Some(format!("{home}/.bend/bin/bend")),
            Some("bend".to_string()),
        ];
        candidates.into_iter().flatten().find(|c| {
            !c.is_empty()
                && std::process::Command::new(c)
                    .arg("--help")
                    .output()
                    .is_ok_and(|o| o.status.success())
        })
    }

    #[test]
    fn bend_clamp_none_on_missing_binary() {
        // Fail-open regardless of bend availability: a nonexistent binary
        // path always collapses to None, never a panic or a hang.
        assert_eq!(
            bend::clamp_fee_il("definitely-not-a-real-binary", 13.92),
            None
        );
    }

    #[test]
    fn bend_clamp_none_on_nonfinite() {
        for enabled in ["bend", "definitely-not-a-real-binary"] {
            assert_eq!(bend::clamp_fee_il(enabled, f64::NAN), None);
            assert_eq!(bend::clamp_fee_il(enabled, f64::INFINITY), None);
        }
    }

    #[test]
    fn bend_clamp_matches_native_for_runaway_law() {
        let Some(bend_path) = bend_bin() else {
            eprintln!("skip: bend binary not on PATH");
            return;
        };
        // Golden vector shared with native/bend/LAWS.bend `band_runaway` and
        // bench/bend-parity.test.ts: the 2026-09 evolution runaway (1.2 lift
        // to 13.92) pins to the 3.0 ceiling in both the Bend kernel and the
        // host's own clamp.
        let native = clamp_fee_il(13.92);
        let bend_result = bend::clamp_fee_il(&bend_path, 13.92);
        assert_eq!(bend_result, Some(native));
        assert_eq!(bend_result, Some(FEE_IL_MAX));
    }

    #[test]
    fn bend_clamp_matches_native_for_floor_and_passthrough() {
        let Some(bend_path) = bend_bin() else {
            eprintln!("skip: bend binary not on PATH");
            return;
        };
        for v in [0.0, 0.01, 0.3, 1.5, 3.0, 3.01] {
            assert_eq!(
                bend::clamp_fee_il(&bend_path, v),
                Some(clamp_fee_il(v)),
                "v={v}"
            );
        }
    }
    #[test]
    fn config_defaults_mirror_ts() {
        use super::config::*;
        assert_eq!(parse_scan_interval_ms(None), Ok(600_000));
        assert_eq!(parse_paper_portfolio_usd(None), Ok(10_000.0));
        assert_eq!(resolve_sqlite_path(None, None), "prism.db");
        assert_eq!(resolve_sqlite_path(Some("a.db"), Some("b.db")), "a.db");
        assert_eq!(resolve_sqlite_path(None, Some("b.db")), "b.db");
        assert_eq!(resolve_sqlite_path(Some(""), Some("b.db")), "b.db");
        // Mirrors engine/config-service.ts validatedNumber("MIN_YIELD_EXIT_AGE_MS", 0, 43_200_000, 172_800_000).
        assert_eq!(parse_min_yield_exit_age_ms(None), Ok(43_200_000));
        // Mirrors validatedNumber("MIN_FEE_IL_RATIO", 0, 1.2, 10): absent -> 1.2.
        assert_eq!(parse_min_fee_il_ratio(None), Ok(1.2));
        // Mirrors Config.boolean("IL_PROTECTION_ENABLED").orElseSucceed(true):
        // absent or garbage -> true (fail-safe default).
        assert!(parse_il_protection_enabled(None));
        assert!(parse_il_protection_enabled(Some("garbage")));
        assert!(parse_il_protection_enabled(Some("true")));
        assert!(!parse_il_protection_enabled(Some("false")));
        assert!(!parse_il_protection_enabled(Some("0")));
        // Mirrors validatedNumber("MARKET_SCAN_MAX_NEGATIVE_DRIFT_BINS", -100, -8, 0).
        assert_eq!(parse_max_negative_drift_bins(None), Ok(-8.0));
        // Mirrors validatedNumber("MAX_OPEN_POSITIONS", 1, 3): absent -> 3.
        assert_eq!(parse_max_open_positions(None), Ok(3));
        // Mirrors validatedNumber("MAX_POSITIONS_PER_POOL", 1, 2): absent -> 2.
        assert_eq!(parse_max_positions_per_pool(None), Ok(2));
        // Mirrors validatedNumber("STOP_LOSS_PCT", 0, 0.15): absent -> 0.15.
        assert_eq!(parse_stop_loss_pct(None), Ok(0.15));
        // Mirrors validatedNumber("MAX_PER_POOL_ALLOCATION_PCT", 0, 0.4, 1.0): absent -> 0.4.
        assert_eq!(parse_max_per_pool_allocation_pct(None), Ok(0.4));
        // Mirrors validatedNumber("MAX_ENTRY_SIZE_USD", 10, 500): absent -> 500.
        assert_eq!(parse_max_entry_size_usd(None), Ok(500.0));
        // REALIZED_PNL_HALT_*: boolean defaults false; window 100, threshold -20.
        assert_eq!(parse_realized_pnl_halt_window(None), Ok(100));
        assert_eq!(parse_realized_pnl_halt_threshold_usd(None), Ok(-20.0));
        // Mirrors validatedNumber("IL_DOMINANCE_EXIT_FACTOR", 1, 2) + ("IL_DOMINANCE_MIN_USD", 0, 5).
        assert_eq!(parse_il_dominance_factor(None), Ok(2.0));
        assert_eq!(parse_il_dominance_min(None), Ok(5.0));
    }

    #[test]
    fn config_garbage_fails_closed() {
        use super::config::*;
        for bad in ["", "abc", "30s", "-1", "0", "9999", "9_999_999"] {
            assert!(
                parse_scan_interval_ms(Some(bad)).is_err(),
                "interval {bad:?} must fail closed"
            );
        }
        assert_eq!(parse_scan_interval_ms(Some("10000")), Ok(10_000)); // min edge
        assert_eq!(parse_scan_interval_ms(Some("3600000")), Ok(3_600_000)); // max edge
        for bad in ["", "abc", "0", "-5", "NaN", "inf", "-inf"] {
            assert!(
                parse_paper_portfolio_usd(Some(bad)).is_err(),
                "portfolio {bad:?} must fail closed"
            );
        }
        assert_eq!(parse_paper_portfolio_usd(Some("1")), Ok(1.0)); // min edge
        for bad in ["", "abc", "-1", "172800001"] {
            assert!(
                parse_min_yield_exit_age_ms(Some(bad)).is_err(),
                "min-yield-exit-age {bad:?} must fail closed"
            );
        }
        assert_eq!(parse_min_yield_exit_age_ms(Some("0")), Ok(0)); // min edge
        assert_eq!(
            parse_min_yield_exit_age_ms(Some("172800000")),
            Ok(172_800_000)
        ); // max edge
           // Host fails closed where TS clamps: out-of-band/garbage floor exits 2.
        for bad in ["", "abc", "-0.1", "10.1", "NaN", "inf"] {
            assert!(
                parse_min_fee_il_ratio(Some(bad)).is_err(),
                "min-fee-il-ratio {bad:?} must fail closed"
            );
        }
        assert_eq!(parse_min_fee_il_ratio(Some("0")), Ok(0.0)); // min edge
        assert_eq!(parse_min_fee_il_ratio(Some("10")), Ok(10.0)); // max edge
                                                                  // Mirrors validatedNumber("MARKET_SCAN_MAX_NEGATIVE_DRIFT_BINS", -100, -8, 0).
        assert_eq!(parse_max_negative_drift_bins(None), Ok(-8.0));
        for bad in ["", "abc", "0.1", "-100.1", "NaN", "inf"] {
            assert!(
                parse_max_negative_drift_bins(Some(bad)).is_err(),
                "max-negative-drift {bad:?} must fail closed"
            );
        }
        assert_eq!(parse_max_negative_drift_bins(Some("-100")), Ok(-100.0)); // min edge
        assert_eq!(parse_max_negative_drift_bins(Some("0")), Ok(0.0)); // max edge
                                                                       // VOLATILITY_LOOKBACK_SNAPSHOTS (3, 12) / OOR_RECOVERY (3, 10).
        assert_eq!(parse_volatility_lookback(None), Ok(12));
        assert_eq!(parse_oor_recovery_lookback(None), Ok(10));
        // Evolution/threshold parsers added after the original garbage test:
        // same fail-closed shape (garbage/out-of-band -> Err, edges Ok).
        assert_eq!(parse_evolution_interval(None), Ok(5));
        for bad in ["", "abc", "0", "-1"] {
            assert!(
                parse_evolution_interval(Some(bad)).is_err(),
                "evolution-interval {bad:?} fails closed"
            );
        }
        assert_eq!(parse_evolution_interval(Some("1")), Ok(1)); // min edge
        assert_eq!(parse_evolution_max_change_pct(None), Ok(0.2));
        for bad in ["", "abc", "0", "0.009", "1.1", "NaN", "inf"] {
            assert!(
                parse_evolution_max_change_pct(Some(bad)).is_err(),
                "evolution-max-change {bad:?} fails closed"
            );
        }
        assert_eq!(parse_evolution_max_change_pct(Some("0.01")), Ok(0.01)); // min edge
        assert_eq!(parse_evolution_max_change_pct(Some("1")), Ok(1.0)); // max edge
        assert_eq!(parse_volume_auth_threshold(None), Ok(0.7));
        assert_eq!(parse_min_bin_utilization(None), Ok(0.3));
        for bad in ["", "abc", "-0.1", "1.1", "NaN", "inf"] {
            assert!(
                parse_volume_auth_threshold(Some(bad)).is_err(),
                "volume-auth {bad:?} fails closed"
            );
            assert!(
                parse_min_bin_utilization(Some(bad)).is_err(),
                "min-bin-util {bad:?} fails closed"
            );
        }
        // IL-dominance: min-only (no max arm, matching TS open range).
        for bad in ["", "abc", "0.9", "NaN", "inf"] {
            assert!(
                parse_il_dominance_factor(Some(bad)).is_err(),
                "il-dominance-factor {bad:?} fails closed"
            );
        }
        assert_eq!(parse_il_dominance_factor(Some("1")), Ok(1.0)); // min edge
        for bad in ["", "abc", "-0.1", "NaN", "inf"] {
            assert!(
                parse_il_dominance_min(Some(bad)).is_err(),
                "il-dominance-min {bad:?} fails closed"
            );
        }
        assert_eq!(parse_il_dominance_min(Some("0")), Ok(0.0)); // min edge
        assert_eq!(parse_volume_auth_threshold(Some("0")), Ok(0.0)); // min edge
        assert_eq!(parse_min_bin_utilization(Some("1")), Ok(1.0)); // max edge
        assert_eq!(parse_max_position_loss_pct(None), Ok(0.35));
        for bad in ["", "abc", "1.1", "NaN", "inf"] {
            assert!(
                parse_max_position_loss_pct(Some(bad)).is_err(),
                "max-position-loss {bad:?} fails closed"
            );
        }
        assert_eq!(parse_max_position_loss_pct(Some("1")), Ok(1.0)); // max edge
        assert_eq!(parse_max_position_loss_pct(Some("0")), Ok(0.0)); // disabled edge
        assert_eq!(parse_max_position_loss_pct(Some("-0.5")), Ok(-0.5)); // negative passthrough (caller disables at <=0)
        for bad in ["", "abc", "2", "-1"] {
            assert!(
                parse_volatility_lookback(Some(bad)).is_err(),
                "lookback {bad:?} fails closed"
            );
            assert!(
                parse_oor_recovery_lookback(Some(bad)).is_err(),
                "oor {bad:?} fails closed"
            );
        }
        assert_eq!(parse_max_open_positions(None), Ok(3));
        for bad in ["", "abc", "0", "-1"] {
            assert!(
                parse_max_open_positions(Some(bad)).is_err(),
                "max-open {bad:?} fails closed"
            );
        }
        assert_eq!(parse_max_open_positions(Some("1")), Ok(1)); // min edge
        assert_eq!(parse_max_open_positions(Some("8")), Ok(8)); // soak-unit shape
        assert_eq!(parse_max_positions_per_pool(None), Ok(2));
        for bad in ["", "abc", "0", "-1"] {
            assert!(
                parse_max_positions_per_pool(Some(bad)).is_err(),
                "max-per-pool {bad:?} fails closed"
            );
        }
        assert_eq!(parse_max_positions_per_pool(Some("1")), Ok(1)); // legacy single-position edge
        assert_eq!(parse_max_positions_per_pool(Some("2")), Ok(2)); // default edge
        assert_eq!(parse_stop_loss_pct(None), Ok(0.15));
        for bad in ["", "abc", "-0.1", "NaN", "inf"] {
            assert!(
                parse_stop_loss_pct(Some(bad)).is_err(),
                "stop-loss {bad:?} fails closed"
            );
        }
        assert_eq!(parse_stop_loss_pct(Some("0")), Ok(0.0)); // explicit-zero edge (vetoes any loss)
        assert_eq!(parse_stop_loss_pct(Some("0.15")), Ok(0.15)); // default edge
        assert_eq!(parse_max_per_pool_allocation_pct(None), Ok(0.4));
        for bad in ["", "abc", "-0.1", "1.1", "NaN", "inf"] {
            assert!(
                parse_max_per_pool_allocation_pct(Some(bad)).is_err(),
                "max-alloc {bad:?} fails closed"
            );
        }
        assert_eq!(parse_max_per_pool_allocation_pct(Some("0")), Ok(0.0)); // min edge
        assert_eq!(parse_max_per_pool_allocation_pct(Some("1")), Ok(1.0)); // max edge
        assert_eq!(parse_max_entry_size_usd(None), Ok(500.0));
        for bad in ["", "abc", "9.9", "-5", "NaN", "inf"] {
            assert!(
                parse_max_entry_size_usd(Some(bad)).is_err(),
                "max-entry {bad:?} fails closed"
            );
        }
        assert_eq!(parse_max_entry_size_usd(Some("10")), Ok(10.0)); // floor edge
        assert_eq!(parse_max_entry_size_usd(Some("500")), Ok(500.0)); // default edge
        assert_eq!(parse_realized_pnl_halt_window(None), Ok(100));
        for bad in ["", "abc", "0", "-1"] {
            assert!(
                parse_realized_pnl_halt_window(Some(bad)).is_err(),
                "halt-window {bad:?} fails closed"
            );
        }
        assert_eq!(parse_realized_pnl_halt_window(Some("1")), Ok(1)); // min edge
        assert_eq!(parse_realized_pnl_halt_threshold_usd(None), Ok(-20.0));
        for bad in ["", "abc", "NaN", "inf", "-inf"] {
            assert!(
                parse_realized_pnl_halt_threshold_usd(Some(bad)).is_err(),
                "halt-threshold {bad:?} fails closed"
            );
        }
        assert_eq!(
            parse_realized_pnl_halt_threshold_usd(Some("-20")),
            Ok(-20.0)
        ); // default edge
    }

    #[test]
    fn jev_stub_always_fail_open() {
        use super::jev::*;
        for enabled in [false, true] {
            assert_eq!(StubJev { enabled }.consult(0), None);
            assert_eq!(StubJev { enabled }.consult(42), None);
        }
    }

    /// Minimal schema of `positions`/`pool_snapshots`/`signal_snapshots`
    /// (only the tables `fee_il_shadows` touches) in a real temp file — a
    /// `:memory:` DB would not work here, since `fee_il_shadows` opens its
    /// own read-only connection and each `:memory:` connection is isolated.
    /// `pool_snapshots` carries ONLY the wave-94 precedence pin (a seeded
    /// `'datapi'` `stats_source` row that must never drive `known` again);
    /// its bin history is ring-fed since wave 95 and its other columns are
    /// absent on purpose (tolerant reads fall to None).
    fn make_shadow_test_db(path: &Path) {
        let conn = rusqlite::Connection::open(path).expect("open scratch db");
        conn.execute_batch(
            "CREATE TABLE positions (position_id TEXT, pool_address TEXT, timestamp INTEGER, closed_at INTEGER, position_pubkey TEXT, deposited_usd REAL, current_value_usd REAL, cumulative_fees_claimed_usd REAL, cumulative_rewards_claimed_usd REAL, active_bin_id INTEGER, lower_bin_id INTEGER, upper_bin_id INTEGER, last_rebalance_at INTEGER, oor_cycle_count INTEGER);
             CREATE TABLE pool_snapshots (pool_address TEXT, timestamp INTEGER, stats_source TEXT, active_bin_id INTEGER);
             CREATE TABLE signal_snapshots (pool_address TEXT, timestamp INTEGER, fee_il_ratio REAL);",
        )
        .expect("create scratch schema");
    }

    /// Minimal `PoolStats` for builder tests: the four stat legs the tick
    /// now consumes (wave 97), everything else unknown/None.
    fn stats_fixture(tvl: f64, fees_24h: f64, bin_step: i64, price: f64) -> datapi::PoolStats {
        datapi::PoolStats {
            address: "poolB".to_string(),
            name: "FIXTURE".to_string(),
            tvl_usd: tvl,
            volume_24h_usd: 1.0,
            fees_24h_usd: fees_24h,
            apr: 0.0,
            apy: 0.0,
            current_price: price,
            fee_tvl_ratio_24h: None,
            dynamic_fee_pct: None,
            base_fee_pct: None,
            bin_step: Some(bin_step),
            has_farm: None,
            farm_apr: None,
            farm_apy: None,
            is_blacklisted: None,
            token_x_freeze_authority_disabled: None,
            token_y_freeze_authority_disabled: None,
        }
    }

    #[test]
    fn fee_il_shadows_reads_real_positions_and_latest_snapshots() {
        let path =
            std::env::temp_dir().join(format!("prismd-shadow-test-{}.db", std::process::id()));
        make_shadow_test_db(&path);
        let path_str = path.to_str().unwrap().to_string();
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            // Open, mature (14h old), known+low-ratio, paper (no pubkey)
            // pool: two snapshots so "latest" (ORDER BY timestamp DESC) is
            // exercised, not just any row.
            conn.execute(
                "INSERT INTO positions (position_id, pool_address, timestamp, closed_at, position_pubkey, deposited_usd, current_value_usd, cumulative_fees_claimed_usd, cumulative_rewards_claimed_usd) VALUES ('pos-mature', 'poolA', ?1, NULL, NULL, 1000, 650, 0, 0)",
                [now - 14 * 3_600_000],
            )
            .unwrap();
            // Two ratio snapshots so "latest" (ORDER BY timestamp DESC) is
            // exercised, not just any row.
            //
            // The two `pool_snapshots` rows are the WAVE-94 PRECEDENCE PIN:
            // the latest one says `'datapi'`, so any regression that
            // re-introduces the old `stats_source` SQL flips
            // `mature.known` to true and fails this test. Bin history is
            // NOT read from here (wave 95: chain-fed ring parameter).
            conn.execute(
                "INSERT INTO pool_snapshots (pool_address, timestamp, stats_source, active_bin_id) VALUES ('poolA', ?1, 'heuristic', 100)",
                [now - 3_600_000],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO pool_snapshots (pool_address, timestamp, stats_source, active_bin_id) VALUES ('poolA', ?1, 'datapi', 90)",
                [now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO signal_snapshots VALUES ('poolA', ?1, 5.0)",
                [now - 3_600_000],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO signal_snapshots VALUES ('poolA', ?1, 0.2)",
                [now],
            )
            .unwrap();
            // Open, immature (1h old), onchain (has a pubkey) position on a
            // pool with no snapshots yet.
            conn.execute(
                "INSERT INTO positions (position_id, pool_address, timestamp, closed_at, position_pubkey, deposited_usd, current_value_usd, cumulative_fees_claimed_usd, cumulative_rewards_claimed_usd) VALUES ('pos-fresh', 'poolB', ?1, NULL, 'SomePubkey111', 500, 520, 10, 0)",
                [now - 3_600_000],
            )
            .unwrap();
            // Closed position must never appear.
            conn.execute(
                "INSERT INTO positions (position_id, pool_address, timestamp, closed_at, position_pubkey) VALUES ('pos-closed', 'poolC', ?1, ?2, NULL)",
                [now - 100_000_000, now],
            )
            .unwrap();
        }
        // Wave 94/97: `known` is stats-map PRESENCE — poolA deliberately has
        // NO entry while its LATEST `pool_snapshots` row says `'datapi'` (the
        // seeded precedence pin: presence wins over TS-persisted state), and
        // poolB carries full stats with no row. The stat legs read from the
        // same map (wave 97). Bin history is the chain-fed RING: poolA gets
        // [100, 90] (drift −10), poolB is absent → cold None.
        let stats_by_pool: std::collections::HashMap<String, PoolStatEntry> = [(
            "poolB".to_string(),
            PoolStatEntry::from_datapi(stats_fixture(50_000.0, 250.0, 20, 1.23), None),
        )]
        .into_iter()
        .collect();
        let rings: std::collections::HashMap<String, Vec<i64>> =
            [("poolA".to_string(), vec![100, 90])].into_iter().collect();
        // Wave 100: ratio is HOST-COMPUTED and map-driven — poolA maps 1.7
        // while its seeded signal rows say 0.2/5.0 (any regression back to
        // the signal_snapshots SQL yields Some(0.2) and FAILS below); poolB
        // has no ratio (cold → None).
        let ratios: std::collections::HashMap<String, f64> =
            [("poolA".to_string(), 1.7)].into_iter().collect();
        let mut shadows = fee_il_shadows_capped(
            &path_str,
            config::MIN_YIELD_EXIT_AGE_DEFAULT_MS,
            &rings,
            10,
            12,
            &stats_by_pool,
            &ratios,
        );
        shadows.sort_by(|a, b| a.position_id.cmp(&b.position_id));
        let _ = std::fs::remove_file(&path);

        assert_eq!(shadows.len(), 2, "closed position must be excluded");

        let mature = &shadows[1]; // "pos-mature"
        assert_eq!(mature.position_id, "pos-mature");
        assert_eq!(mature.pool_address, "poolA");
        assert!(mature.mature, "14h old >= 12h default must be mature");
        assert!(
            !mature.known,
            "stats-map absence wins over the seeded stats_source row"
        );
        assert_eq!(
            mature.ratio,
            Some(1.7),
            "ratio from the host-computed map (1.7), not the seeded 0.2 row"
        );
        assert!(
            !mature.onchain,
            "NULL position_pubkey -> paper, not onchain"
        );

        let fresh = &shadows[0]; // "pos-fresh"
        assert_eq!(fresh.position_id, "pos-fresh");
        assert!(!fresh.mature, "1h old < 12h default must not be mature");
        assert!(
            fresh.known,
            "stats presence drives known without any DB row"
        );
        // Wave 97: the stat legs read from the SAME map as `known`.
        assert_eq!(fresh.pool_tvl_usd, Some(50_000.0), "tvl from the stats map");
        assert_eq!(
            fresh.pool_fees_24h_usd,
            Some(250.0),
            "fees from the stats map"
        );
        assert_eq!(fresh.pool_bin_step, Some(20), "bin_step from pool_config");
        assert_eq!(
            fresh.pool_current_price,
            Some(1.23),
            "price from the stats map"
        );
        assert_eq!(
            mature.pool_tvl_usd, None,
            "absent pool → stat legs fail open (None)"
        );
        assert_eq!(mature.pool_bin_step, None, "absent pool → bin_step None");
        assert_eq!(fresh.ratio, None, "no map entry → cold ratio None");
        assert!(fresh.onchain, "non-NULL position_pubkey -> onchain");
        // Wave 99: no host history table in this fixture → TA no-vote,
        // fail-open (the builder's TA source is prismd_pool_history now).
        assert_eq!(
            fresh.ta_closes_newest_first, None,
            "host history table absent → TA window None"
        );
        assert_eq!(
            mature.net_drift_bins,
            Some(-10.0),
            "drift = ring last(90) - first(100)"
        );
        assert_eq!(
            fresh.net_drift_bins, None,
            "no ring -> cold start, TS netDriftBins = 0"
        );
    }

    #[test]
    fn open_positions_count_excludes_closed() {
        // Same scratch schema as the shadow test: 2 open + 1 closed rows.
        // The capacity shadow must count only `closed_at IS NULL` (the rows
        // TS enforces MAX_OPEN_POSITIONS against).
        let path = std::env::temp_dir().join(format!("prismd-open-test-{}.db", std::process::id()));
        make_shadow_test_db(&path);
        let conn = rusqlite::Connection::open(&path).expect("open scratch db");
        let now = 1_700_000_000_000i64;
        for (id, closed) in [("a", None), ("b", None), ("c", Some(now))] {
            conn.execute(
                "INSERT INTO positions (position_id, pool_address, timestamp, closed_at) VALUES (?1, 'poolX', ?2, ?3)",
                rusqlite::params![id, now, closed],
            )
            .unwrap();
        }
        drop(conn);
        let path_str = path.to_str().unwrap().to_string();
        assert_eq!(open_positions_count(&path_str), 2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn open_positions_per_pool_groups_open_only() {
        // poolA: 2 open + 1 closed; poolB: 1 open. Closed rows must not
        // count; the pool-capacity shadow enforces MAX_POSITIONS_PER_POOL
        // against open rows per pool like TS.
        let path =
            std::env::temp_dir().join(format!("prismd-perpool-test-{}.db", std::process::id()));
        make_shadow_test_db(&path);
        let conn = rusqlite::Connection::open(&path).expect("open scratch db");
        let now = 1_700_000_000_000i64;
        for (id, pool, closed) in [
            ("a1", "poolA", None),
            ("a2", "poolA", None),
            ("a3", "poolA", Some(now)),
            ("b1", "poolB", None),
        ] {
            conn.execute(
                "INSERT INTO positions (position_id, pool_address, timestamp, closed_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![id, pool, now, closed],
            )
            .unwrap();
        }
        drop(conn);
        let path_str = path.to_str().unwrap().to_string();
        let mut got = open_positions_per_pool(&path_str);
        got.sort();
        assert_eq!(
            got,
            vec![("poolA".to_string(), 2), ("poolB".to_string(), 1)]
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn open_exposure_per_pool_sums_open_only() {
        // poolA: opens 600 + 400, plus a closed 9999 (must not count);
        // poolB: one open 250 with NULL current (coerced via COALESCE).
        // NULL current_value_usd would NULL the SUM without COALESCE.
        let path =
            std::env::temp_dir().join(format!("prismd-exposure-test-{}.db", std::process::id()));
        make_shadow_test_db(&path);
        let conn = rusqlite::Connection::open(&path).expect("open scratch db");
        let now = 1_700_000_000_000i64;
        for (id, pool, current, closed) in [
            ("a1", "poolA", Some(600.0), None),
            ("a2", "poolA", Some(400.0), None),
            ("a3", "poolA", Some(9999.0), Some(now)),
            ("b1", "poolB", None, None),
        ] {
            conn.execute(
                "INSERT INTO positions (position_id, pool_address, timestamp, closed_at, current_value_usd) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, pool, now, closed, current],
            )
            .unwrap();
        }
        drop(conn);
        let path_str = path.to_str().unwrap().to_string();
        let mut got = open_exposure_per_pool(&path_str);
        got.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, "poolA");
        assert!(
            (got[0].1 - 1000.0).abs() < 1e-9,
            "poolA must sum opens only, got {}",
            got[0].1
        );
        assert_eq!(got[1].0, "poolB");
        assert!(
            (got[1].1 - 0.0).abs() < 1e-9,
            "NULL current must coerce to 0, got {}",
            got[1].1
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rolling_realized_pnl_halted_edges() {
        // Mirrors engine/pnl-halt.ts: window = max(1, floor); empty → false
        // (cold start never freezes); non-finite/None filtered; sum <
        // threshold halts (strict <, exact -20 holds).
        assert!(!rolling_realized_pnl_halted(&[], 100, -20.0)); // empty
        assert!(!rolling_realized_pnl_halted(&[None, None], 100, -20.0)); // all-null
        assert!(rolling_realized_pnl_halted(
            &[Some(-15.0), Some(-10.0)],
            100,
            -20.0
        )); // -25 halts
        assert!(!rolling_realized_pnl_halted(
            &[Some(-15.0), Some(-5.0)],
            100,
            -20.0
        )); // exact -20 holds
        assert!(rolling_realized_pnl_halted(
            &[Some(-100.0), Some(90.0)],
            1,
            -20.0
        )); // window 1 takes newest (-100) only → halts
        assert!(!rolling_realized_pnl_halted(
            &[Some(f64::NAN), Some(-5.0)],
            100,
            -20.0
        )); // NaN filtered
        assert!(rolling_realized_pnl_halted(&[Some(-30.0)], 0, -20.0)); // window 0 → max(1,·), -30 halts
    }

    #[test]
    fn evolve_shadow_reads_live_floors_and_lift() {
        // Live-shaped DB: 3 evolved_* metadata rows + 6 ENTER/HOLD outcome
        // rows (4 winners high-feeIl, 2 losers low-feeIl → positive fee lift).
        // Mirrors db-service getEvolvedThresholds/getClosedPositionOutcomes.
        let path =
            std::env::temp_dir().join(format!("prismd-evolve-test-{}.db", std::process::id()));
        let conn = rusqlite::Connection::open(&path).expect("open scratch db");
        conn.execute_batch(
            "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
             CREATE TABLE signal_snapshots (pool_address TEXT, timestamp INTEGER, fee_il_ratio REAL, volume_authenticity REAL, bin_utilization REAL, action TEXT, outcome_pnl_usd REAL, outcome_recorded_at INTEGER);",
        )
        .expect("create scratch schema");
        for (k, v) in [
            ("evolved_min_fee_il_ratio", "1.5"),
            ("evolved_volume_auth_threshold", "0.8"),
            ("evolved_min_bin_utilization", "0.4"),
        ] {
            conn.execute(
                "INSERT INTO metadata (key, value, updated_at) VALUES (?1, ?2, 0)",
                [k, v],
            )
            .unwrap();
        }
        let rows: [(f64, f64, f64, &str, f64); 6] = [
            (5.0, 0.9, 0.7, "ENTER", 10.0),
            (4.0, 0.8, 0.6, "HOLD", 5.0),
            (6.0, 0.9, 0.7, "ENTER", 8.0),
            (5.5, 0.85, 0.65, "HOLD", 3.0),
            (0.5, 0.2, 0.1, "ENTER", -4.0),
            (0.4, 0.2, 0.1, "HOLD", -2.0),
        ];
        for (i, (fee, auth, util, act, pnl)) in rows.into_iter().enumerate() {
            conn.execute(
                "INSERT INTO signal_snapshots (pool_address, timestamp, fee_il_ratio, volume_authenticity, bin_utilization, action, outcome_pnl_usd, outcome_recorded_at) VALUES ('poolE', ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![1000 + i as i64, fee, auth, util, act, pnl, 2000 + i as i64],
            )
            .unwrap();
        }
        drop(conn);
        let path_str = path.to_str().unwrap().to_string();
        let st = read_evolve_state(&path_str);
        assert_eq!(st.fee_floor, Some(1.5));
        assert_eq!(st.auth_floor, Some(0.8));
        assert_eq!(st.util_floor, Some(0.4));
        assert_eq!(st.outcome_count, 6);
        // Fee lift must be positive (winners ~5.1 mean vs losers ~0.45 mean).
        let fee_rows = vec![
            (5.0, 10.0),
            (4.0, 5.0),
            (6.0, 8.0),
            (5.5, 3.0),
            (0.5, -4.0),
            (0.4, -2.0),
        ];
        let lift = signal_lift(&fee_rows).expect("both sides present");
        assert!(
            lift > 0.0,
            "winners-higher signal must lift positive, got {lift}"
        );
        // One full leg through the real kernel stays banded (LAWS-proven).
        if let Some(bend_path) = bend_bin() {
            let next = bend::evolve_thr(&bend_path, 1.5, true, lift.abs(), 1.0, 0.2, 0.3, 3.0);
            let n = next.expect("bend kernel must answer");
            assert!(
                (0.3..=3.0).contains(&n),
                "evolved leg must stay banded, got {n}"
            );
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cli_flags_exit_early_or_fail_closed() {
        let s = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(classify_args(&s(&["--help"]), None), Ok(None));
        assert_eq!(classify_args(&s(&["-h"]), None), Ok(None));
        assert_eq!(
            classify_args(&s(&["--bogus"]), None),
            Err("unknown flag --bogus".into())
        );
        assert_eq!(classify_args(&s(&["--ticks", "3"]), Some(3)), Ok(Some(3)));
        assert_eq!(classify_args(&s(&["profile.env"]), None), Ok(None));
        // parse_cli_ticks: lone / unparsable --ticks fails closed (exit 2),
        // never collapses to None (which would loop forever).
        assert_eq!(
            parse_cli_ticks(&s(&["--ticks"])),
            Err("--ticks requires a value".into())
        );
        assert!(parse_cli_ticks(&s(&["--ticks", "abc"])).is_err());
        assert_eq!(parse_cli_ticks(&s(&["--ticks", "3"])), Ok(Some(3)));
        assert_eq!(parse_cli_ticks(&s(&[])), Ok(None));
        // --ticks 0 would exit instantly with no tick: fail closed instead.
        assert!(parse_cli_ticks(&s(&["--ticks", "0"])).is_err());
        // Index-based skip: a profile file literally named `3` is NOT a flag
        // value — classify passes it through (main loads it via the same
        // index skip, so both stay in sync).
        assert_eq!(
            classify_args(&s(&["3", "--ticks", "3"]), Some(3)),
            Ok(Some(3))
        );
        assert_eq!(
            classify_args(&s(&["--ticks", "3", "--ticks", "3"]), Some(3)),
            Ok(Some(3))
        );
    }

    #[test]
    fn loss_cap_danger_mirrors_ts_breach() {
        // Mirrors engine/position-loss-cap.ts isPositionLossCapBreached:
        // pnl = current + fees + rewards − deposited ≤ -(deposited × min(pct,1)).
        // 35% down on $1000 (650 + 0 + 0) breaches the 0.35 floor exactly.
        assert_eq!(
            loss_cap_danger(Some(1000.0), Some(650.0), Some(0.0), Some(0.0), 0.35),
            Some(true)
        );
        // Fees cushion: 650 + 60 claimed = 710 > 650 floor → holds.
        assert_eq!(
            loss_cap_danger(Some(1000.0), Some(650.0), Some(60.0), Some(0.0), 0.35),
            Some(false)
        );
        // Disabled at pct ≤ 0, matching TS (never fires).
        assert_eq!(
            loss_cap_danger(Some(1000.0), Some(0.0), Some(0.0), Some(0.0), 0.0),
            Some(false)
        );
        // Missing ledger inputs → None (never fires, fail-open).
        assert_eq!(
            loss_cap_danger(None, Some(650.0), Some(0.0), Some(0.0), 0.35),
            None
        );
        assert_eq!(
            loss_cap_danger(Some(1000.0), Some(650.0), Some(0.0), Some(0.0), f64::NAN),
            Some(false)
        );
    }

    #[test]
    fn ta_exhausted_truth_table() {
        // Fail-open without bend: bogus binary always yields None (meaningful
        // on machines without `bend`); truth table below runs when present.
        assert_eq!(
            bend::ta_exhausted("definitely-not-a-real-binary", true, true, false),
            None
        );
        assert_eq!(
            bend::ta_exhausted("definitely-not-a-real-binary", false, false, false),
            None
        );
        // Pure-bool confluence: RSI AND (BB OR MACD). Kernel probes only run
        // when `bend` is present (bend_available skip like the evolve test).
        if let Some(bend_path) = bend_bin() {
            assert_eq!(bend::ta_exhausted(&bend_path, true, true, true), Some(true));
            assert_eq!(
                bend::ta_exhausted(&bend_path, true, true, false),
                Some(true)
            );
            assert_eq!(
                bend::ta_exhausted(&bend_path, true, false, true),
                Some(true)
            );
            assert_eq!(
                bend::ta_exhausted(&bend_path, true, false, false),
                Some(false)
            );
            assert_eq!(
                bend::ta_exhausted(&bend_path, false, true, true),
                Some(false)
            );
            assert_eq!(
                bend::ta_exhausted(&bend_path, false, false, false),
                Some(false)
            );
        }
    }

    #[test]
    fn exit_order_precedence() {
        // Fail-open without bend: bogus binary always yields None.
        assert_eq!(
            bend::exit_order("definitely-not-a-real-binary", false, true, true),
            None
        );
        assert_eq!(
            bend::exit_order("definitely-not-a-real-binary", false, false, false),
            None
        );
        // TP(1n) > TA(2n) > loss(3n) > none(0n). Kernel-only probes, skipped
        // without `bend` — no tick wiring until ta-exhaustion.ts lands.
        if let Some(bend_path) = bend_bin() {
            assert_eq!(bend::exit_order(&bend_path, true, true, true), Some(1));
            assert_eq!(bend::exit_order(&bend_path, false, true, true), Some(2));
            assert_eq!(bend::exit_order(&bend_path, false, false, true), Some(3));
            assert_eq!(bend::exit_order(&bend_path, false, false, false), Some(0));
            assert_eq!(bend::exit_order(&bend_path, true, false, false), Some(1));
        }
    }

    #[test]
    fn bend_wrappers_fail_closed_on_nonfinite() {
        // Every float-taking wrapper collapses to None on non-finite input
        // without spawning a probe: fee_exit (ratio), enter_blocked
        // (ratio/floor), capital_exit (confidence). Mirrors the TS guards
        // that never feed NaN/Infinity into a gate. Bogus binary on purpose:
        // if the guard regressed, the probe would spawn and this would fail
        // on the missing binary instead of returning None.
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(bend::fee_exit_fires("bend", true, true, bad), None);
            assert_eq!(bend::enter_blocked("bend", true, true, bad, 1.2), None);
            assert_eq!(bend::enter_blocked("bend", true, true, 0.4, bad), None);
            assert_eq!(bend::capital_exit("bend", true, bad), None);
        }
    }

    #[test]
    fn bend_tick_wrappers_match_kernels_when_present() {
        // Per-tick shadow surface vs kernels when `bend` exists: drift
        // strict-below-floor rejects / at-floor passes; fee_exit fires only
        // known+mature+below-0.5; enter_blocked needs il_on+known+below-floor;
        // capital_exit fires on danger alone; fee_known echoes host bool;
        // accrual_allowed needs paper+datapi without on-chain key.
        // Skipped (not failed) without `bend`; fail-open asserts above cover
        // the absent-binary path unconditionally.
        if let Some(bend_path) = bend_bin() {
            assert_eq!(bend::drift_rejects(&bend_path, -9.0, -8.0), Some(true));
            assert_eq!(bend::drift_rejects(&bend_path, -8.0, -8.0), Some(false));
            assert_eq!(bend::drift_rejects(&bend_path, 5.0, -8.0), Some(false));
            assert_eq!(
                bend::fee_exit_fires(&bend_path, true, true, 0.4),
                Some(true)
            );
            assert_eq!(
                bend::fee_exit_fires(&bend_path, true, true, 0.6),
                Some(false)
            );
            assert_eq!(
                bend::fee_exit_fires(&bend_path, true, true, 0.5),
                Some(false)
            );
            assert_eq!(
                bend::fee_exit_fires(&bend_path, true, true, 0.49),
                Some(true)
            );
            assert_eq!(
                bend::fee_exit_fires(&bend_path, false, true, 0.4),
                Some(false)
            );
            assert_eq!(
                bend::fee_exit_fires(&bend_path, true, false, 0.4),
                Some(false)
            );
            assert_eq!(
                bend::enter_blocked(&bend_path, true, true, 0.2, 1.2),
                Some(true)
            );
            assert_eq!(
                bend::enter_blocked(&bend_path, false, true, 0.2, 1.2),
                Some(false)
            );
            assert_eq!(
                bend::enter_blocked(&bend_path, true, false, 0.2, 1.2),
                Some(false)
            );
            assert_eq!(
                bend::enter_blocked(&bend_path, true, true, 2.0, 1.2),
                Some(false)
            );
            assert_eq!(
                bend::enter_blocked(&bend_path, true, true, 1.2, 1.2),
                Some(false)
            );
            assert_eq!(bend::capital_exit(&bend_path, true, 1.0), Some(true));
            assert_eq!(bend::capital_exit(&bend_path, false, 0.85), Some(false));
            assert_eq!(bend::fee_known(&bend_path, true), Some(true));
            assert_eq!(bend::fee_known(&bend_path, false), Some(false));
            assert_eq!(
                bend::accrual_allowed(&bend_path, true, false, true),
                Some(true)
            );
            assert_eq!(
                bend::accrual_allowed(&bend_path, true, false, false),
                Some(false)
            );
            assert_eq!(
                bend::accrual_allowed(&bend_path, true, true, true),
                Some(false)
            );
            assert_eq!(
                bend::accrual_allowed(&bend_path, false, false, true),
                Some(false)
            );
            // Loss-magnitude floor (2026-09-20 URANUS wave): kernel must
            // agree with the native `loss_cap_danger` vectors exactly —
            // at-or-below fires (35.00 loss vs 1000×0.35 floor), one cent
            // above holds, a profit never fires.
            assert_eq!(
                bend::loss_magnitude_fires(&bend_path, Some(-350.0), Some(1000.0), 0.35),
                Some(true)
            );
            assert_eq!(
                bend::loss_magnitude_fires(&bend_path, Some(-349.99), Some(1000.0), 0.35),
                Some(false)
            );
            assert_eq!(
                bend::loss_magnitude_fires(&bend_path, Some(50.0), Some(1000.0), 0.35),
                Some(false)
            );
            // URANUS-SOL legs: $30 deposit, -27.17% mark = -$8.15 → BELOW the
            // 35% floor → the loss-cap class must NOT fire (trailing stop owns
            // it). Guards against a kernel that fires the wrong direction.
            assert_eq!(
                bend::loss_magnitude_fires(&bend_path, Some(-8.15), Some(30.0), 0.35),
                Some(false)
            );
            // pct > 1 clamps like TS `min(pct, 1)`: a 2.0 pct behaves as 1.0,
            // so a -$2000 loss on a $1000 deposit fires (full-wipe floor).
            assert_eq!(
                bend::loss_magnitude_fires(&bend_path, Some(-2000.0), Some(1000.0), 2.0),
                Some(true)
            );
            // A profit never fires even with a huge pct (sign projection).
            assert_eq!(
                bend::loss_magnitude_fires(&bend_path, Some(500.0), Some(1000.0), 1.0),
                Some(false)
            );
            // Dust arm: strictly-below fires, at-floor holds, disabled floor
            // never fires even at a $0 mark.
            assert_eq!(
                bend::dust_exit_fires(&bend_path, true, Some(4.99), Some(5.0)),
                Some(true)
            );
            assert_eq!(
                bend::dust_exit_fires(&bend_path, true, Some(5.0), Some(5.0)),
                Some(false)
            );
            assert_eq!(
                bend::dust_exit_fires(&bend_path, false, Some(0.0), Some(5.0)),
                Some(false)
            );
        }
    }

    #[test]
    fn read_evolve_state_rejects_garbage_floors() {
        // Garbage metadata values (non-numeric / non-finite / empty) must
        // yield None floors, never a panic or a NaN floor downstream.
        let path =
            std::env::temp_dir().join(format!("prismd-evolve-garbage-{}.db", std::process::id()));
        let conn = rusqlite::Connection::open(&path).expect("open scratch db");
        conn.execute_batch(
            "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
             CREATE TABLE signal_snapshots (pool_address TEXT, timestamp INTEGER, fee_il_ratio REAL, volume_authenticity REAL, bin_utilization REAL, action TEXT, outcome_pnl_usd REAL, outcome_recorded_at INTEGER);",
        )
        .expect("create scratch schema");
        for (k, v) in [
            ("evolved_min_fee_il_ratio", "garbage"),
            ("evolved_volume_auth_threshold", "NaN"),
            ("evolved_min_bin_utilization", ""),
        ] {
            conn.execute(
                "INSERT INTO metadata (key, value, updated_at) VALUES (?1, ?2, 0)",
                [k, v],
            )
            .unwrap();
        }
        drop(conn);
        let path_str = path.to_str().unwrap().to_string();
        let st = read_evolve_state(&path_str);
        assert_eq!(st.fee_floor, None);
        assert_eq!(st.auth_floor, None);
        assert_eq!(st.util_floor, None);
        assert_eq!(st.outcome_count, 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn bend_wrappers_none_on_missing_binary() {
        // Fail-open contract for every wrapper: a bogus binary path yields
        // None for fee_known/fee_exit/enter_blocked/capital_exit/ta/exit_order
        // /loss_magnitude/dust (extends bend_clamp_none_on_missing_binary to
        // the full surface). Unconditional (no bend required): the bogus path
        // proves the fail-open contract without a real probe.
        let bogus = "definitely-not-a-real-binary";
        assert_eq!(bend::fee_known(bogus, true), None);
        assert_eq!(bend::fee_exit_fires(bogus, true, true, 0.4), None);
        assert_eq!(bend::enter_blocked(bogus, true, true, 0.4, 1.2), None);
        assert_eq!(bend::capital_exit(bogus, true, 1.0), None);
        assert_eq!(bend::ta_exhausted(bogus, true, true, false), None);
        assert_eq!(bend::exit_order(bogus, false, true, true), None);
        assert_eq!(
            bend::loss_magnitude_fires(bogus, Some(-350.0), Some(1000.0), 0.35),
            None
        );
        assert_eq!(
            bend::dust_exit_fires(bogus, true, Some(4.99), Some(5.0)),
            None
        );
        // Non-finite/missing legs never spawn a probe either.
        assert_eq!(
            bend::loss_magnitude_fires(bogus, Some(f64::NAN), Some(1000.0), 0.35),
            None
        );
        assert_eq!(
            bend::loss_magnitude_fires(bogus, None, Some(1000.0), 0.35),
            None
        );
        assert_eq!(
            bend::loss_magnitude_fires(bogus, Some(-1.0), None, 0.35),
            None
        );
        assert_eq!(bend::dust_exit_fires(bogus, true, None, Some(5.0)), None);
        assert_eq!(
            bend::dust_exit_fires(bogus, true, Some(f64::NAN), Some(5.0)),
            None
        );
        // NOTE: the pct>1 clamp leg (`loss_magnitude_fires(..., 2.0)`) lives in
        // the Bend-gated tick test, not here: with a real `bend` on PATH it
        // consults and returns Some(true) (2000 loss > 1000 clamped floor),
        // so asserting None here would be environment-dependent — exactly the
        // flake the fail-open contract forbids.
    }

    #[test]
    fn ep_supertrend_and_lane_twins_guard() {
        // ATR: Wilder-smoothed |Δclose|. A flat series has TR 0 → ATR 0.
        assert_eq!(supertrend_atr(&[5.0; 30], 14), Some(0.0));
        // A constant-slope ramp has constant TR 1 → ATR converges to 1.
        let ramp: Vec<f64> = (0..40).map(|i| 100.0 + i as f64).collect();
        let atr = supertrend_atr(&ramp, 14).expect("ramp ATR");
        assert!(
            (atr - 1.0).abs() < 1e-9,
            "ramp ATR must converge to TR, got {atr}"
        );
        // Short/junk → None (fail-open no-signal, never an invented entry).
        assert_eq!(supertrend_atr(&[1.0, 2.0], 14), None);
        assert_eq!(supertrend_atr(&[1.0, f64::NAN, 3.0], 2), None);
        // Break-above: closes are NEWEST-FIRST (host order), so build the
        // ramp reversed — oldest at the end, newest (100+39) at index 0.
        // ATR ~1, mid = nf[14] = 125, upper ~128, last 139 → uptrend true.
        let mut ramp: Vec<f64> = (0..40).map(|i| 100.0 + i as f64).collect();
        ramp.reverse();
        assert_eq!(supertrend_break_above(&ramp, 14, 3.0), Some(true));
        // A falling ramp (newest is the lowest close) never breaks above.
        let mut down: Vec<f64> = (0..40).rev().map(|i| 100.0 + i as f64).collect();
        down.reverse();
        assert_eq!(supertrend_break_above(&down, 14, 3.0), Some(false));
        // Non-positive multiplier → None.
        assert_eq!(supertrend_break_above(&ramp, 14, 0.0), None);

        // EP lane: present legs must clear; bootcamp floors vol >= 1, fee >= 1%.
        assert!(ep_lane_admits(Some(2.5), 1.0, Some(1.0), 1.0));
        // Score below floor blocks (the "<1 volatility" rule).
        assert!(!ep_lane_admits(Some(0.5), 1.0, Some(1.0), 1.0));
        // Fee below the 1% floor blocks.
        assert!(!ep_lane_admits(Some(2.5), 1.0, Some(0.5), 1.0));
        // Absent legs never block (fail-open): the fee leg is permanently
        // absent on a ledger-only read, so fail-closed would make this gate
        // admit nothing on any real book. Present non-finite legs still block.
        assert!(ep_lane_admits(None, 1.0, Some(1.0), 1.0));
        assert!(ep_lane_admits(Some(2.5), 1.0, None, 1.0));
        assert!(ep_lane_admits(None, 1.0, None, 1.0));
        assert!(!ep_lane_admits(Some(f64::NAN), 1.0, Some(1.0), 1.0));
        assert!(!ep_lane_admits(Some(2.5), 1.0, Some(f64::NAN), 1.0));
        // Junk floor → disabled (never admit on an unparseable gate).
        assert!(!ep_lane_admits(Some(2.5), f64::NAN, Some(1.0), 1.0));

        // Exit bypass: confluence AND pnl above the -30% floor fires.
        assert_eq!(ep_exit_bypass(Some(true), Some(0.05), 0.30), Some(true));
        assert_eq!(ep_exit_bypass(Some(true), Some(-0.25), 0.30), Some(true));
        // Below the SL floor → holds (the SL arm owns it, not the bypass).
        assert_eq!(ep_exit_bypass(Some(true), Some(-0.35), 0.30), Some(false));
        // No confluence → never fires.
        assert_eq!(ep_exit_bypass(Some(false), Some(0.50), 0.30), Some(false));
        // Missing/non-finite legs or disabled SL → None (fail-open).
        assert_eq!(ep_exit_bypass(None, Some(0.05), 0.30), None);
        assert_eq!(ep_exit_bypass(Some(true), None, 0.30), None);
        assert_eq!(ep_exit_bypass(Some(true), Some(f64::NAN), 0.30), None);
        assert_eq!(ep_exit_bypass(Some(true), Some(0.05), 0.0), None);
    }

    #[test]
    fn shadow_log_write_seam_roundtrips() {
        // First non-shadow host capability: a tick verdict lands in the
        // host-owned `prismd_shadow_log` table. Contract: table created on
        // demand, row round-trips (tick + decision text), and the write is
        // additive — it must not touch TS-owned tables. Uses a scratch DB.
        let path = std::env::temp_dir().join(format!("prismd-shadowlog-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let path_str = path.to_str().unwrap().to_string();

        write_shadow_observation(&path_str, 7, "open=3 exit_shadow=0 at_capacity=true");

        let conn = rusqlite::Connection::open(&path).expect("reopen scratch db");
        let (tick, decision): (i64, String) = conn
            .query_row(
                "SELECT tick, decision FROM prismd_shadow_log WHERE tick = 7",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("row must round-trip");
        assert_eq!(tick, 7);
        assert_eq!(decision, "open=3 exit_shadow=0 at_capacity=true");

        // Additive: a second write appends (AUTOINCREMENT), never replaces.
        write_shadow_observation(&path_str, 8, "open=2 exit_shadow=1 at_capacity=false");
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM prismd_shadow_log", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 2, "second write must append, not replace");

        // TS-owned tables must not exist in a host-only scratch DB.
        let ts_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('positions','audit','metadata','position_events')",
                [],
                |r| r.get(0),
            )
            .expect("table count");
        assert_eq!(ts_tables, 0, "write seam must not create TS-owned tables");
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn shadow_log_write_failure_is_swallowed() {
        // Fail-open contract: a shadow that cannot write must never fail the
        // tick. Point the seam at a path that cannot be opened read-write
        // (an existing DIRECTORY) and assert it returns normally rather than
        // panicking — the happy-path row count above proves nothing here.
        let dir = std::env::temp_dir().join(format!("prismd-shadowlog-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        write_shadow_observation(dir.to_str().unwrap(), 1, "open=1 at_capacity=false");
        // Also a path under a nonexistent parent (open fails on the parent).
        let missing = std::env::temp_dir()
            .join(format!("prismd-nope-{}/twin.db", std::process::id()))
            .to_str()
            .unwrap()
            .to_string();
        write_shadow_observation(&missing, 2, "open=1 at_capacity=false");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn evolve_shadow_skips_below_interval() {
        // TS early-return (program.ts:6032-6042): fewer recorded outcomes
        // than EVOLUTION_INTERVAL -> evolve_shadow must not consult Bend at
        // all. Proved by a bogus binary: with 0 outcomes the shadow skips
        // before any probe, so no "unavailable" path is hit and outcome
        // count stays below interval.
        let path =
            std::env::temp_dir().join(format!("prismd-evolve-skip-{}.db", std::process::id()));
        let conn = rusqlite::Connection::open(&path).expect("open scratch db");
        conn.execute_batch(
            "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);",
        )
        .expect("create scratch schema");
        drop(conn);
        let path_str = path.to_str().unwrap().to_string();
        let st = read_evolve_state(&path_str);
        assert_eq!(st.outcome_count, 0);
        assert!(
            st.outcome_count < 5,
            "0 outcomes must skip a 5-interval shadow"
        );
        // Exercise the real skip path: 0 outcomes < interval must return
        // quietly even with a bogus bend bin (early return before any probe;
        // would spawn a failing probe if the guard regressed).
        let cfg = config::Config {
            sqlite_path: path_str.clone(),
            scan_interval_ms: 10_000,
            paper_portfolio_usd: 10_000.0,
            jev_enabled: false,
            bend_bin: "definitely-not-a-real-binary".to_string(),
            min_yield_exit_age_ms: 43_200_000,
            paper_trading: true,
            il_protection_enabled: true,
            min_fee_il_ratio: 1.2,
            max_negative_drift_bins: -8.0,
            volatility_lookback_snapshots: 12,
            volatility_exit_stddev: 5.0,
            oor_recovery_lookback_cycles: 10,
            max_position_loss_pct: 0.35,
            evolution_interval: 5,
            evolution_max_change_pct: 0.2,
            volume_auth_threshold: 0.7,
            min_bin_utilization: 0.3,
            enable_pool_discovery: false,
            discovery_min_tvl_usd: 1_000_000.0,
            discovery_min_fee_ratio: 1.5,
            meteora_pools_url: config::DEFAULT_METEORA_POOLS_URL.to_string(),
            max_open_positions: 3,
            max_positions_per_pool: 2,
            stop_loss_pct: 0.15,
            max_per_pool_allocation_pct: 0.4,
            max_entry_size_usd: 500.0,
            realized_pnl_halt_enabled: false,
            realized_pnl_halt_window: 100,
            realized_pnl_halt_threshold_usd: -20.0,
            max_rebalance_range_bins: 200,
            rebalance_gas_cost_sol: 0.01,
            sol_price_usd: 150.0,
            solana_rpc_url: "https://example.com".to_string(),
            meteora_data_api_url: "https://datapi.example.test".to_string(),
            snapshot_retention_days: 14,
            gecko_terminal_enabled: true,
            gecko_base_url: "https://gecko.example.test".to_string(),
            wallet_pubkey: String::new(),
            jupiter_api_key: String::new(),
            gas_aware_min_days: 3.0,
            oor_recovery_hold_threshold: 0.6,
            oor_recovery_force_threshold: 0.2,
            min_rebalance_interval_ms: 86_400_000,
            oor_grace_period_cycles: 3,
            paper_validation_min_days: 7.0,
            paper_validation_enforce: false,
            il_dominance_exit_factor: 2.0,
            il_dominance_min_usd: 5.0,
            dust_exit_usd: 5.0,
            agent_http_port: 0,
            ticks: Some(1),
        };
        evolve_shadow(&cfg);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn loss_cap_danger_guards() {
        // NaN/negative ledger inputs never breach: NaN max_loss_pct ->
        // Some(false) (disabled arm); NaN ledger leg -> None (missing arm);
        // negative fees -> None. Mirrors position-loss-cap.ts fail-closed.
        assert_eq!(
            loss_cap_danger(Some(1000.0), Some(650.0), Some(0.0), Some(0.0), f64::NAN),
            Some(false)
        );
        assert_eq!(
            loss_cap_danger(Some(1000.0), Some(f64::NAN), Some(0.0), Some(0.0), 0.35),
            None
        );
        assert_eq!(
            loss_cap_danger(Some(1000.0), Some(650.0), Some(-1.0), Some(0.0), 0.35),
            None
        );
        // Exact 35% breach fires; one cent above holds.
        assert_eq!(
            loss_cap_danger(Some(1000.0), Some(650.0), Some(0.0), Some(0.0), 0.35),
            Some(true)
        );
        assert_eq!(
            loss_cap_danger(Some(1000.0), Some(650.01), Some(0.0), Some(0.0), 0.35),
            Some(false)
        );
    }

    #[test]
    fn il_dominance_guards() {
        // Mirrors program.ts:4285-4292 `isIlDominant` + pnl.ts:71-79 HODL:
        // X leg moves with price ratio, Y constant; null on entry<=0.
        // Live case: 250/250 @ entry 10, now 9 → hodl 475; cur 460 → il 15
        // > 0×2 + 5 floor → fires. Flat price → il 0 → holds.
        let hodl = hodl_value_usd(Some(250.0), Some(250.0), Some(10.0), Some(9.0));
        assert_eq!(hodl, Some(475.0));
        let il = hodl.map(|h| h - 460.0);
        assert_eq!(il_dominant(il, Some(0.0), 2.0, 5.0), Some(true));
        let flat = hodl_value_usd(Some(250.0), Some(250.0), Some(10.0), Some(10.0));
        let il_flat = flat.map(|h| h - 500.0);
        assert_eq!(il_dominant(il_flat, Some(0.0), 2.0, 5.0), Some(false));
        // Fees cushion: il 15 vs fees 10 × 2 = 20 → holds.
        assert_eq!(il_dominant(Some(15.0), Some(10.0), 2.0, 5.0), Some(false));
        // Below floor: il 4 > 0 but < 5 → holds.
        assert_eq!(il_dominant(Some(4.0), Some(0.0), 2.0, 5.0), Some(false));
        // Zero/negative IL → holds (profit or flat, not bleed).
        assert_eq!(il_dominant(Some(0.0), Some(0.0), 2.0, 5.0), Some(false));
        // Missing/non-finite legs → None (fail-open, never fires).
        assert_eq!(il_dominant(None, Some(0.0), 2.0, 5.0), None);
        assert_eq!(il_dominant(Some(15.0), Some(f64::NAN), 2.0, 5.0), None);
        // Live close 2026-09-20 (CTMV/SOL SsJMY5): OOR $6.65 IL vs $0 fees
        // fires at factor 2 / min $5 (the lane that named the 80th-wave gap).
        // Live realized -$4.40 = withdrawn $25.60 − deposit $30 (both legs).
        assert_eq!(il_dominant(Some(6.65), Some(0.0), 2.0, 5.0), Some(true));
        // Strict > on all three arms: exact-boundary holds, never fires.
        assert_eq!(il_dominant(Some(0.0), Some(0.0), 2.0, 5.0), Some(false)); // il>0
        assert_eq!(il_dominant(Some(10.0), Some(5.0), 2.0, 5.0), Some(false)); // il>fees×2
        assert_eq!(il_dominant(Some(5.0), Some(0.0), 2.0, 5.0), Some(false)); // il>min
        assert_eq!(
            hodl_value_usd(Some(250.0), Some(250.0), Some(0.0), Some(9.0)),
            None
        );
        assert_eq!(
            hodl_value_usd(None, Some(250.0), Some(10.0), Some(9.0)),
            None
        );
        // Parsers mirror validatedNumber fallbacks 2 / 5, fail-closed garbage.
        assert_eq!(config::parse_il_dominance_factor(None), Ok(2.0));
        assert_eq!(config::parse_il_dominance_min(None), Ok(5.0));
        assert!(config::parse_il_dominance_factor(Some("garbage")).is_err());
        assert!(config::parse_il_dominance_min(Some("-1")).is_err());
    }
    #[test]
    fn wallet_pubkey_and_rpc_url_guards() {
        // Absent / empty / whitespace -> walletless + public mainnet fallback
        // (TS hasWallet() false, PUBLIC_SOLANA_RPC_URL).
        assert_eq!(config::parse_wallet_pubkey(None), Ok(String::new()));
        assert_eq!(config::parse_wallet_pubkey(Some("")), Ok(String::new()));
        assert_eq!(config::parse_wallet_pubkey(Some("   ")), Ok(String::new()));
        assert_eq!(
            config::parse_solana_rpc_url(None),
            "https://api.mainnet-beta.solana.com"
        );
        assert_eq!(
            config::parse_solana_rpc_url(Some("  ")),
            "https://api.mainnet-beta.solana.com"
        );
        assert_eq!(
            config::parse_solana_rpc_url(Some(" https://rpc.example/x ")),
            "https://rpc.example/x"
        );
        // Valid base58 32-byte addresses round-trip unchanged.
        for good in [
            "11111111111111111111111111111111", // System Program (32 zero bytes)
            "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // random valid
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token Program
        ] {
            assert_eq!(
                config::parse_wallet_pubkey(Some(good)),
                Ok(good.to_string())
            );
        }
        // Rejections: bad alphabet (0/O/I/l), wrong decoded length, too short.
        for bad in [
            "0OIl",                                              // alphabet violations
            "abc",                                               // decodes to < 32 bytes
            "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWMextra", // too long
            "not a pubkey at all!",                              // spaces/punctuation
        ] {
            assert!(
                config::parse_wallet_pubkey(Some(bad)).is_err(),
                "{bad} must be rejected"
            );
        }
    }

    #[test]
    fn stop_loss_veto_guards() {
        // Mirrors checkStopLossGate exactly: `lossPct < -pct`, no disabled
        // arm (pct 0 vetoes any loss); None on missing/non-finite legs,
        // non-positive deposited, or non-finite pct.
        assert_eq!(stop_loss_veto(Some(1000.0), Some(840.0), 0.15), Some(true)); // -16% breaches
        assert_eq!(stop_loss_veto(Some(1000.0), Some(860.0), 0.15), Some(false)); // -14% holds
        assert_eq!(stop_loss_veto(Some(1000.0), Some(850.0), 0.15), Some(false)); // exact -15% holds (strict <)
        assert_eq!(stop_loss_veto(None, Some(840.0), 0.15), None);
        assert_eq!(stop_loss_veto(Some(1000.0), Some(f64::NAN), 0.15), None);
        assert_eq!(stop_loss_veto(Some(0.0), Some(840.0), 0.15), None);
        assert_eq!(stop_loss_veto(Some(1000.0), Some(840.0), 0.0), Some(true)); // pct 0 vetoes any loss
        assert_eq!(stop_loss_veto(Some(1000.0), Some(840.0), f64::NAN), None); // non-finite pct
    }

    #[test]
    fn drawdown_veto_guards() {
        // Mirrors checkDrawdownGate: non-finite portfolio → veto; <=0 →
        // free; else pnl<0 && |pnl|/portfolio > 0.1. Spot legs only;
        // missing legs skipped, non-finite legs → None, d<=0 skipped.
        assert_eq!(
            drawdown_veto(&[(Some(1000.0), Some(800.0))], 1000.0),
            Some(true)
        ); // -20% vetoes
        assert_eq!(
            drawdown_veto(&[(Some(1000.0), Some(950.0))], 1000.0),
            Some(false)
        ); // -5% holds
        assert_eq!(
            drawdown_veto(&[(Some(1000.0), Some(900.0))], 1000.0),
            Some(false)
        ); // exact -10% holds (strict >)
        assert_eq!(
            drawdown_veto(&[(Some(1000.0), Some(1100.0))], 1000.0),
            Some(false)
        ); // profit holds
        assert_eq!(drawdown_veto(&[], 1000.0), Some(false)); // empty book, pnl 0
        assert_eq!(drawdown_veto(&[(None, Some(800.0))], 1000.0), Some(false)); // missing skipped
        assert_eq!(
            drawdown_veto(&[(Some(0.0), Some(800.0))], 1000.0),
            Some(false)
        ); // d<=0 skipped
        assert_eq!(
            drawdown_veto(&[(Some(f64::NAN), Some(800.0))], 1000.0),
            None
        ); // non-finite leg
        assert_eq!(
            drawdown_veto(&[(Some(1000.0), Some(800.0))], f64::NAN),
            Some(true)
        ); // non-finite portfolio
        assert_eq!(
            drawdown_veto(&[(Some(1000.0), Some(800.0))], 0.0),
            Some(false)
        ); // non-positive portfolio
    }

    #[test]
    fn drawdown_portfolio_guards() {
        // A MEASURED zero-balance wallet (`Some(0.0)`) must not fall back to
        // the configured paper portfolio (a fabricated $10k denominator masks
        // a real drawdown and shrinks any measured one). `None` — failed
        // lamports read, or paper mode — is the only config-fallback case.
        assert_eq!(drawdown_portfolio_usd(Some(0.0), 984.46, 10_000.0), 984.46); // measured zero → open legs only
        assert_eq!(drawdown_portfolio_usd(Some(150.0), 0.0, 10_000.0), 150.0); // priced wallet-only value
        assert_eq!(
            drawdown_portfolio_usd(Some(150.0), 984.46, 10_000.0),
            1_134.46
        ); // wallet + open legs
        assert_eq!(drawdown_portfolio_usd(None, 984.46, 10_000.0), 10_000.0); // read failed → config

        // End-to-end: with Some(0.0) + a -20% book the veto MUST fire; under
        // the old lamport-mapping guard this read fell to the $10k config and
        // returned Some(false) — the regression this pins.
        assert_eq!(
            drawdown_veto(
                &[(Some(984.46), Some(787.57))],
                drawdown_portfolio_usd(Some(0.0), 787.57, 10_000.0)
            ),
            Some(true)
        );
        assert_eq!(
            drawdown_veto(
                &[(Some(984.46), Some(787.57))],
                drawdown_portfolio_usd(None, 787.57, 10_000.0)
            ),
            Some(false)
        );
    }

    #[test]
    fn wallet_total_usd_skips_unpriced_fail_closed() {
        // One Jupiter price map values native SOL + both programs' rows; an
        // unpriced asset contributes NOTHING and is reported (TS
        // readWalletSnapshot :2952-2980 — under-report, never a fallback price).
        use std::collections::HashMap;
        let mut prices = HashMap::new();
        prices.insert(rpc::SOL_MINT.to_string(), 150.0);
        prices.insert("MintA".to_string(), 2.0);
        let legacy = rpc::Holding {
            mint: "MintA".to_string(),
            amount_atomic: 1_500_000, // 1.5 tokens @ 6 decimals
            decimals: 6,
        };
        let next = rpc::Holding {
            mint: "MintB".to_string(),
            amount_atomic: 7,
            decimals: 0,
        };
        // 1 SOL × $150 + 1.5 MintA × $2 = $153; MintB unpriced → skipped.
        let (total, skipped) = wallet_total_usd(1_000_000_000, &[legacy, next], &prices);
        assert!((total - 153.0).abs() < 1e-9, "got {total}");
        assert_eq!(skipped, ["MintB".to_string()]);

        // Price outage (empty map): measured $0, every held asset reported —
        // the TS `catch → {}` outcome the tick warns once per mint.
        let empty = HashMap::new();
        let holding = rpc::Holding {
            mint: "MintA".to_string(),
            amount_atomic: 1,
            decimals: 0,
        };
        let (zero, skipped) = wallet_total_usd(1_000_000_000, &[holding], &empty);
        assert_eq!(zero, 0.0);
        assert_eq!(skipped, [rpc::SOL_MINT.to_string(), "MintA".to_string()]);

        // Empty wallet with no price call: measured zero, nothing skipped
        // (lamports == 0 must not demand a SOL price).
        assert_eq!(
            wallet_total_usd(0, &[], &prices),
            (0.0, Vec::<String>::new())
        );
    }

    #[test]
    fn jupiter_price_parse_guards() {
        // Live v3 shape (verified 2026-09-22): numeric `usdPrice` per mint.
        // String rows, non-positive numbers, and absent mints are ABSENT —
        // never parsed into a price (TS isNumberValue parity).
        let mints: Vec<String> = ["A", "B", "C", "D"].iter().map(|s| s.to_string()).collect();
        let v: serde_json::Value = serde_json::json!({
            "A": { "usdPrice": 1.25 },
            "B": { "usdPrice": "2.5" },
            "C": { "usdPrice": -3.0 },
            "data": { "D": { "price": 3.5 } }
        });
        let prices = rpc::parse_jupiter_prices(&v, &mints);
        assert_eq!(prices.len(), 2);
        assert_eq!(prices.get("A"), Some(&1.25)); // direct v3 field
        assert_eq!(prices.get("D"), Some(&3.5)); // nested v2-compat field
        assert!(!prices.contains_key("B")); // string → absent
        assert!(!prices.contains_key("C")); // non-positive → absent
                                            // Unrequested mint ignored; non-object payload → empty, no panic.
        assert_eq!(prices.len(), 2);
        let absent: Vec<String> = vec!["E".to_string()];
        assert!(rpc::parse_jupiter_prices(&serde_json::Value::Null, &absent).is_empty());
    }

    #[test]
    fn data_api_url_defaults_like_the_rpc_url() {
        assert_eq!(
            config::parse_data_api_url(None),
            datapi::DEFAULT_BASE_URL,
            "absent -> TS default"
        );
        assert_eq!(
            config::parse_data_api_url(Some("  ")),
            datapi::DEFAULT_BASE_URL
        );
        assert_eq!(
            config::parse_data_api_url(Some(" https://alt.example ")),
            "https://alt.example",
            "trimmed custom URL wins"
        );
    }

    #[test]
    fn gecko_parse_fixture_and_guards() {
        // Live-captured ZEC-SOL payload (2026-09-23): GT mixes JSON numbers
        // and numeric STRINGS — the parser accepts both (TS readFiniteNumber).
        // `pool_fee_percentage` is null for this CL pool (AGENTS live-verified
        // class), so fees use the binStep-modeled rate: volume × 0.0045
        // (0.0025 + 20/1e4).
        let v: serde_json::Value =
            serde_json::from_str(include_str!("gecko_zec_sol.json")).expect("fixture json");
        assert!(v["data"]["attributes"]["pool_fee_percentage"].is_null());
        let s = gecko::parse_pool_stats(&v, 0.0045).expect("fixture parses");
        assert!(s.tvl_usd > 0.0, "reserve required");
        assert!(s.volume_24h_usd > 0.0, "volume24 required");
        let expected_fees = s.volume_24h_usd * 0.0045;
        assert!(
            (s.fees_24h_usd - expected_fees).abs() < 1e-9,
            "modeled fee = volume × base rate"
        );
        assert!(s.current_price.is_some(), "base price parsed");

        // An explicit percent fee WINS over the modeled rate (TS
        // parseFeePercentageFraction: percent/100).
        let mut custom = v.clone();
        custom["data"]["attributes"]["pool_fee_percentage"] = serde_json::json!("0.5");
        let s2 = gecko::parse_pool_stats(&custom, 0.0045).expect("parsed");
        let expected2 = s2.volume_24h_usd * 0.005;
        assert!((s2.fees_24h_usd - expected2).abs() < 1e-9, "percent → /100");

        // Guards: null reserve → unavailable (TS get rejects), volume missing
        // or non-positive → unusable, shape drift → None.
        let mut no_reserve = v.clone();
        no_reserve["data"]["attributes"]["reserve_in_usd"] = serde_json::Value::Null;
        assert!(
            gecko::parse_pool_stats(&no_reserve, 0.0045).is_none(),
            "null reserve"
        );
        let mut zero_volume = v.clone();
        zero_volume["data"]["attributes"]["volume_usd"] = serde_json::json!({ "h24": "0" });
        assert!(
            gecko::parse_pool_stats(&zero_volume, 0.0045).is_none(),
            "zero volume"
        );
        assert!(
            gecko::parse_pool_stats(&serde_json::Value::Null, 0.0045).is_none(),
            "shape drift"
        );
    }

    #[test]
    fn gecko_reserve_slot_matches_ts_claim() {
        // TS claimGeckoRequestSlot (gecko-terminal-service.ts:182): wait to
        // the reserved slot (or now), then push one interval past max(now,slot).
        let now = std::time::Instant::now();
        // No slot yet → start now, next one interval out.
        let (start, next) = gecko::reserve_slot(None, now);
        assert_eq!(start, now);
        assert_eq!(next, now + Duration::from_millis(2_100));
        // Future slot → wait for it untouched.
        let future = now + Duration::from_millis(500);
        let (start2, next2) = gecko::reserve_slot(Some(future), now);
        assert_eq!(start2, future);
        assert_eq!(next2, future + Duration::from_millis(2_100));
        // Stale (past) slot → restart from now, never sleep backwards.
        let past = now - Duration::from_millis(9_000);
        let (start3, next3) = gecko::reserve_slot(Some(past), now);
        assert_eq!(start3, now);
        assert_eq!(next3, now + Duration::from_millis(2_100));
    }

    #[test]
    fn gecko_config_defaults_like_ts() {
        assert_eq!(
            config::parse_gecko_base_url(None),
            gecko::DEFAULT_BASE_URL,
            "absent -> TS default"
        );
        assert_eq!(
            config::parse_gecko_base_url(Some("  ")),
            gecko::DEFAULT_BASE_URL
        );
        assert_eq!(
            config::parse_gecko_base_url(Some(" https://alt.example/v2/ ")),
            "https://alt.example/v2/",
            "trimmed custom URL wins"
        );
        // Default-ON tier (TS `GECKO_TERMINAL_ENABLED !== false`).
        assert!(config::parse_gecko_enabled(None));
        assert!(config::parse_gecko_enabled(Some("garbage")));
        assert!(!config::parse_gecko_enabled(Some("false")));
        assert!(!config::parse_gecko_enabled(Some("0")));
        assert!(!config::parse_gecko_enabled(Some("NO")));
    }

    #[test]
    fn gecko_entry_feeds_legs_but_never_known() {
        // THE wave-98 semantic split: a geckoterminal overlay entry carries
        // the gas/shape legs but `measured=false`, so `known` (datapi-only
        // in TS — feeIlRatioKnown/accrual) stays FALSE. Absent entry →
        // every leg None, known false.
        let path =
            std::env::temp_dir().join(format!("prismd-gecko-entry-test-{}.db", std::process::id()));
        make_shadow_test_db(&path);
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            conn.execute(
                "INSERT INTO positions (position_id, pool_address, timestamp, closed_at, position_pubkey) VALUES ('pos-geo', 'poolGeo', ?1, NULL, NULL)",
                [now],
            )
            .unwrap();
            drop(conn);
        }
        let path_str = path.to_str().unwrap().to_string();
        let gecko_stats = gecko::GeckoStats {
            tvl_usd: 111_000.0,
            volume_24h_usd: 5_000.0,
            fees_24h_usd: 22.5,
            current_price: Some(1.5),
        };
        let stats: std::collections::HashMap<String, PoolStatEntry> = [(
            "poolGeo".to_string(),
            PoolStatEntry::from_gecko(gecko_stats, Some(64)),
        )]
        .into_iter()
        .collect();
        let shadows = fee_il_shadows_capped(
            &path_str,
            0,
            &std::collections::HashMap::new(),
            10,
            12,
            &stats,
            &std::collections::HashMap::new(),
        );
        let _ = std::fs::remove_file(&path);
        assert_eq!(shadows.len(), 1);
        let s = &shadows[0];
        assert!(!s.known, "gecko NEVER sets the datapi-only flag");
        assert_eq!(s.pool_tvl_usd, Some(111_000.0), "legs survive the overlay");
        assert_eq!(s.pool_fees_24h_usd, Some(22.5));
        assert_eq!(s.pool_bin_step, Some(64), "chain bin_step");
        assert_eq!(s.pool_current_price, Some(1.5));
    }

    #[test]
    fn pool_history_appends_and_windows_ta() {
        // Wave 99: `write_pool_history` appends host-owned price rows (the
        // cutover-contract table nothing in TS reads) and the builder's TA
        // window reads 35 newest DESC from it — the retired pool_snapshots
        // source. Direct inserts pin the window (one write call shares a
        // single timestamp, so the window test needs distinct ones).
        let path = std::env::temp_dir().join(format!(
            "prismd-pool-history-test-{}.db",
            std::process::id()
        ));
        make_shadow_test_db(&path);
        let path_str = path.to_str().unwrap().to_string();
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS prismd_pool_history (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     pool_address TEXT NOT NULL,
                     timestamp INTEGER NOT NULL,
                     current_price REAL NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_prismd_pool_history_pool_ts
                     ON prismd_pool_history(pool_address, timestamp);",
            )
            .unwrap();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            conn.execute(
                "INSERT INTO positions (position_id, pool_address, timestamp, closed_at, position_pubkey) VALUES ('pos-ta', 'poolTA', ?1, NULL, NULL)",
                [now],
            )
            .unwrap();
            // 40 ascending prices → the window keeps the newest 35 DESC.
            for (i, price) in (10..50).enumerate() {
                conn.execute(
                    "INSERT INTO prismd_pool_history (pool_address, timestamp, current_price) VALUES ('poolTA', ?1, ?2)",
                    rusqlite::params![now - 40 + i as i64, price as f64],
                )
                .unwrap();
            }
            drop(conn);
        }
        let shadows = fee_il_shadows_capped(
            &path_str,
            0,
            &std::collections::HashMap::new(),
            10,
            12,
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
        );
        let _ = std::fs::remove_file(&path);
        assert_eq!(shadows.len(), 1);
        let ta = shadows[0]
            .ta_closes_newest_first
            .clone()
            .expect("35 closes");
        assert_eq!(ta.len(), 35, "window caps at 35");
        assert_eq!(ta.first(), Some(&49.0), "newest first");
        assert_eq!(ta.last(), Some(&15.0), "35 newest = 49..=15");

        // The writer itself: create + append + RETENTION semantics (two
        // calls → rows accumulate, values round-trip; an ancient row is
        // swept by the second call's prune — bounded mirror of TS
        // SNAPSHOT_RETENTION_DAYS).
        let wpath = std::env::temp_dir().join(format!(
            "prismd-pool-history-writer-{}.db",
            std::process::id()
        ));
        let wstr = wpath.to_str().unwrap().to_string();
        write_pool_history(
            &wstr,
            &[("poolA".to_string(), 1.5), ("poolB".to_string(), 2.5)],
            14,
        );
        {
            let conn = rusqlite::Connection::open(&wpath).unwrap();
            conn.execute(
                "INSERT INTO prismd_pool_history (pool_address, timestamp, current_price) VALUES ('poolA', 1, 9.9)",
                [],
            )
            .unwrap();
            drop(conn);
        }
        write_pool_history(&wstr, &[("poolA".to_string(), 3.5)], 14);
        {
            let conn = rusqlite::Connection::open(&wpath).unwrap();
            let total: i64 = conn
                .query_row("SELECT COUNT(*) FROM prismd_pool_history", [], |r| r.get(0))
                .unwrap();
            let pool_a: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM prismd_pool_history WHERE pool_address = 'poolA'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let ancient: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM prismd_pool_history WHERE current_price = 9.9",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            let last: f64 = conn
                .query_row(
                    "SELECT current_price FROM prismd_pool_history WHERE pool_address = 'poolA' ORDER BY id DESC LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(total, 3, "appends, never replaces");
            assert_eq!(pool_a, 2, "per-pool rows accumulate");
            assert_eq!(ancient, 0, "retention swept the pre-cutoff row");
            assert_eq!(last, 3.5, "value round-trips");

            // Absurd retention must DEGRADE TO PRUNE-NOTHING, never
            // DELETE-ALL: the sweep saturates (`now − days·86_400_000` →
            // i64::MIN), so `timestamp < cutoff` matches no row. A
            // wrapping/wrong cutoff would wipe everything and fail HERE.
            write_pool_history(&wstr, &[("poolC".to_string(), 4.5)], i64::MAX);
            let total_after: i64 = conn
                .query_row("SELECT COUNT(*) FROM prismd_pool_history", [], |r| r.get(0))
                .unwrap();
            assert_eq!(total_after, 4, "oversized retention pruned nothing");
        }
        let _ = std::fs::remove_file(&wpath);
    }

    #[test]
    fn estimate_daily_il_and_fee_ratio_vectors() {
        // Ported TS vectors (bench/metrics-data-path.test.ts) with reference
        // values captured FROM THE TS ENGINE itself via bun (2026-09-23) —
        // the host must land on the same doubles for the same inputs.
        // Concentrated fixture: 41 bins (active±20), liquidity at |d| <= 1
        // (1e9 each), binStep 10 — TS makeConcentratedBinArray.
        let concentrated: Vec<rpc::BinSlot> = (0..=40)
            .filter_map(|i| {
                let bin_id: i64 = 4980 + i;
                let d = (bin_id - 5000).abs();
                (d <= 1).then_some(rpc::BinSlot {
                    bin_id,
                    reserve_x: 0,
                    reserve_y: 0,
                    liquidity_supply: 1_000_000_000,
                })
            })
            .collect();
        let conc = concentration_multiplier(&concentrated, 5000);
        let t: i64 = 1_800_000_000_000;
        let mk_drift = || {
            Some(PriceDrift {
                previous_price: 150.0,
                previous_timestamp_ms: t - 600_000,
            })
        };

        // (i) low-fee / high-drift < 1.2 floor (TS: not-999 + below-min).
        let low = compute_fee_il_ratio(100_000.0, 50.0, 154.5, t, 10, conc, mk_drift());
        assert!(low < 1.2, "low={low}");
        assert!((low - 0.003_179_533_169_528_944).abs() < 1e-12, "low={low}");
        // (ii) calm fees+small drift beats wild (TS engine exact):
        let calm = compute_fee_il_ratio(100_000.0, 500.0, 150.3, t, 10, conc, mk_drift());
        let wild = compute_fee_il_ratio(100_000.0, 50.0, 157.5, t, 10, conc, mk_drift());
        assert!((calm - 6.958_338_543_726_566).abs() < 1e-12, "calm={calm}");
        assert!(
            (wild - 0.001_167_187_474_173_445).abs() < 1e-15,
            "wild={wild}"
        );
        assert!(calm > wild, "high fees + low drift outranks the reverse");
        // (iv) 24h anchored: calm day > 1.8, crash day < 1.2 (TS engine exact).
        let calm24 = compute_fee_il_ratio(
            100_000.0,
            800.0,
            125.0,
            86_400_000,
            10,
            conc,
            Some(PriceDrift {
                previous_price: 122.5,
                previous_timestamp_ms: 0,
            }),
        );
        let crash24 = compute_fee_il_ratio(
            100_000.0,
            800.0,
            159.25,
            86_400_000,
            10,
            conc,
            Some(PriceDrift {
                previous_price: 122.5,
                previous_timestamp_ms: 0,
            }),
        );
        assert!(
            (calm24 - 15.681_199_989_832_617).abs() < 1e-12,
            "calm24={calm24}"
        );
        assert!(
            (crash24 - 0.093_642_728_492_944_33).abs() < 1e-15,
            "crash24={crash24}"
        );
        // No drift at all → binStep proxy path (TS ii-b: binStep changes the ratio).
        let proxy_narrow = compute_fee_il_ratio(100_000.0, 100.0, 150.0, t, 10, conc, None);
        let proxy_wide = compute_fee_il_ratio(100_000.0, 100.0, 150.0, t, 100, conc, None);
        assert_ne!(proxy_narrow, proxy_wide, "proxy varies with binStep");
        // Unknown reserves (TS reservesKnown=false → concentration 1).
        assert_eq!(concentration_multiplier(&[], 5000), 1.0, "unknown → 1");
        // tvl 0 → 0; NO price move (IL fraction exactly 0) + fees → MAX —
        // the `il <= 0` arm, the only route to it (proxy IL is always > 0);
        // proxy-path IL with no fees → 0.
        assert_eq!(
            compute_fee_il_ratio(0.0, 500.0, 150.0, t, 10, conc, None),
            0.0,
            "tvl 0 → 0"
        );
        let no_move = compute_fee_il_ratio(
            100_000.0,
            500.0,
            150.0,
            t,
            10,
            conc,
            Some(PriceDrift {
                previous_price: 150.0,
                previous_timestamp_ms: t - 600_000,
            }),
        );
        assert_eq!(
            no_move, MAX_FEE_IL_RATIO,
            "zero price move + fees → MAX (the il <= 0 arm)"
        );
        let no_move_no_fees = compute_fee_il_ratio(
            100_000.0,
            0.0,
            150.0,
            t,
            10,
            conc,
            Some(PriceDrift {
                previous_price: 150.0,
                previous_timestamp_ms: t - 600_000,
            }),
        );
        assert_eq!(
            no_move_no_fees, 0.0,
            "zero price move + no fees → 0 (the il <= 0, fees <= 0 arm)"
        );
        assert_eq!(
            compute_fee_il_ratio(100_000.0, 0.0, 150.0, t, 10, conc, None),
            0.0,
            "proxy-path IL with no fees → 0"
        );
    }

    #[test]
    fn parse_bin_array_fixture_and_guards() {
        // Real ZEC-SOL BinArray captured 2026-09-23 via the SDK's own
        // lb_pair memcmp filter: index 35 → range [2450, 2519] contains the
        // active bin 2461; 70/70 bins hold liquidity; disc exact.
        let raw = include_bytes!("binarray_8eyb.bin");
        let (index, slots) = rpc::parse_bin_array(raw).expect("fixture parses");
        assert_eq!(index, 35, "index → lower = index × 70 = 2450");
        assert_eq!(slots.len(), 70, "full BIN_ARRAY_SIZE slots");
        assert_eq!(
            slots[0].bin_id, 2450,
            "lower + 0 (SDK getBinIdIndexInBinArray inverse)"
        );
        assert_eq!(slots[69].bin_id, 2519, "lower + 69");
        assert!(
            slots.iter().all(|s| s.liquidity_supply > 0),
            "70/70 liquid on the live capture"
        );
        // SIZE cross-check (advisory): the ACCOUNT-derived slot count equals
        // the SDK CONSTANTS MAX_BIN_PER_ARRAY — the account is the truth,
        // the constant only cross-pins it.
        assert_eq!(
            (raw.len() - 56) / 144,
            rpc::BIN_ARRAY_SIZE as usize,
            "CONSTANTS cross-check"
        );
        // Containment (the picker's test): 2461 ∈ [2450, 2519]; the neighbor
        // array index 15 → [1050, 1119] does not contain it; and SIGNED index
        // math mirrors the JS BN floor semantics — index −1 covers −70..−1
        // (pure comparison, no division anywhere, so no truncation hazard).
        assert!(
            rpc::bin_array_contains(index, 2461, slots.len() as i64),
            "captured array (index 35) holds the active bin"
        );
        assert!(
            !rpc::bin_array_contains(15, 2461, rpc::BIN_ARRAY_SIZE),
            "neighbor array [1050, 1119] does not contain 2461"
        );
        assert!(
            rpc::bin_array_contains(-1, -1, 70),
            "negative: −1 ∈ [−70, −1] (JS floor semantics)"
        );
        assert!(
            !rpc::bin_array_contains(-1, 0, 70),
            "negative: 0 ∉ [−70, −1]"
        );
        assert!(
            !rpc::bin_array_contains(0, -1, 70),
            "negative: −1 ∉ [0, 69]"
        );
        // Synthetic NEGATIVE index through the full parser: a complete
        // 70-slot account at index −1 floors bin ids exactly like the JS BN
        // math (first bin −70), proving the signed id stride end-to-end.
        let mut neg = vec![0u8; 56 + 70 * 144];
        neg[..8].copy_from_slice(&rpc::BIN_ARRAY_DISCRIMINATOR);
        neg[8..16].copy_from_slice(&(-1i64).to_le_bytes());
        let (nidx, nslots) = rpc::parse_bin_array(&neg).expect("negative parses");
        assert_eq!(nidx, -1);
        assert_eq!(nslots.len(), 70);
        assert_eq!(nslots[0].bin_id, -70, "index −1 × 70 + 0");
        assert_eq!(nslots[69].bin_id, -1, "index −1 × 70 + 69");
        // Guards: wrong discriminator, short buffer, overflow-safe ids.
        let mut bad = raw.to_vec();
        bad[0] ^= 0xff;
        assert!(
            rpc::parse_bin_array(&bad).is_err(),
            "discriminator mismatch"
        );
        assert!(rpc::parse_bin_array(&raw[..10]).is_err(), "short buffer");
        // Real-pool concentration: deep 70-bin liquidity sits near the
        // reference width → multiplier in (1, 10], TS-engine ratio caps at 20
        // for both the drift and proxy arms (cross-checked via bun).
        let real_conc = concentration_multiplier(&slots, 2461);
        assert!(
            real_conc > 1.0 && real_conc <= 10.0,
            "real_conc={real_conc}"
        );
        let t: i64 = 1_800_000_000_000;
        let ratio_drift = compute_fee_il_ratio(
            281889.5393,
            2_164.232_204_510_240_5,
            1_606.797_106_8,
            t,
            20,
            real_conc,
            Some(PriceDrift {
                previous_price: 1_590.0,
                previous_timestamp_ms: t - 86_400_000,
            }),
        );
        assert_eq!(ratio_drift, MAX_FEE_IL_RATIO, "TS engine pins 20 (capped)");
        let ratio_proxy = compute_fee_il_ratio(
            281889.5393,
            2_164.232_204_510_240_5,
            1_606.797_106_8,
            t,
            20,
            real_conc,
            None,
        );
        assert_eq!(ratio_proxy, MAX_FEE_IL_RATIO, "proxy arm also caps at 20");
    }

    #[test]
    fn snapshot_price_drift_anchor_vectors() {
        // Ported TS vectors (bench/scan-set.test.ts): anchor = OLDEST row,
        // None on cold start AND when span < 1h (jitter guard).
        let rows: Vec<(f64, i64)> = vec![
            (100.0, 1_000),
            (101.0, 2_000),
            (102.0, 3_000 + MIN_FEE_WINDOW_SPAN_MS),
        ];
        let drift = snapshot_price_drift(&rows).expect("window spans the floor");
        assert_eq!(drift, (100.0, 1_000), "oldest in-window row anchors");
        assert_eq!(
            snapshot_price_drift(&[]),
            None,
            "cold start → binStep proxy"
        );
        assert_eq!(
            snapshot_price_drift(&[(100.0, 1_000), (101.0, 2_000)]),
            None,
            "span < 1h → jitter guard → proxy"
        );
    }

    #[test]
    fn push_bin_history_cap_evicts_oldest() {
        // TS pushBinHistory (program.ts:5973-5976): chronological append,
        // evict beyond cap — the cap that used to live in the SQL LIMIT.
        let mut ring = Vec::new();
        for id in [100, 90, 80, 70, 60] {
            push_bin_history(&mut ring, id, 3);
        }
        assert_eq!(
            ring,
            vec![80, 70, 60],
            "cap=3 keeps the 3 newest, oldest-first"
        );
        let mut cold = Vec::new();
        push_bin_history(&mut cold, 7, 3);
        assert_eq!(
            cold,
            vec![7],
            "first sample lands; drift stays None until a second"
        );
    }

    #[test]
    fn parse_lb_pair_guards_and_fixture() {
        // Real ZEC-SOL `LbPair` account captured 2026-09-22 — active_id
        // matched the TS SDK's `DLMM.getActiveBin().binId` EXACTLY in the
        // same run (raw@76 == SDK binId == 2463; this file froze at 2461)
        // and bin_step 20 matches the Data API's `pool_config.bin_step`
        // (two independent sources, same value).
        let fixture = include_bytes!("lbpair_8eyb.bin");
        assert_eq!(
            rpc::parse_lb_pair(fixture).expect("fixture parses"),
            (2461, 20),
            "fixture (active_id, bin_step) — offsets 76/80"
        );
        // Synthetic: discriminator + NEGATIVE i32 id + a distinct u16 step.
        let mut raw = vec![0u8; rpc::BIN_STEP_OFFSET + 2];
        raw[..8].copy_from_slice(&rpc::LB_PAIR_DISCRIMINATOR);
        raw[rpc::ACTIVE_ID_OFFSET..][..4].copy_from_slice(&(-7i32).to_le_bytes());
        raw[rpc::BIN_STEP_OFFSET..][..2].copy_from_slice(&250u16.to_le_bytes());
        assert_eq!(rpc::parse_lb_pair(&raw).unwrap(), (-7, 250));
        // Guards: wrong discriminator and a short buffer both fail closed.
        let mut bad = raw.clone();
        bad[0] ^= 0xff;
        assert!(rpc::parse_lb_pair(&bad).is_err(), "discriminator mismatch");
        assert!(
            rpc::parse_lb_pair(&fixture[..rpc::BIN_STEP_OFFSET + 1]).is_err(),
            "short buffer"
        );
    }

    #[test]
    fn loss_cap_tighter_is_monotone_superset() {
        // Halving the cap can only add danger flags, never remove: tighter
        // is a monotone superset of live on every ledger point. Pure fn,
        // no Bend, no DB.
        let legs = [
            (Some(1000.0), Some(650.0), Some(0.0), Some(0.0)),
            (Some(1000.0), Some(700.0), Some(0.0), Some(0.0)),
            (Some(1000.0), Some(950.0), Some(60.0), Some(0.0)),
            (Some(1000.0), Some(990.0), Some(0.0), Some(0.0)),
        ];
        for (d, c, f, r) in legs {
            let live = loss_cap_danger(d, c, f, r, 0.35);
            let tight = loss_cap_danger(d, c, f, r, 0.175);
            match (live, tight) {
                (Some(true), v) => {
                    assert_eq!(v, Some(true), "live breach must stay breached tighter")
                }
                (Some(false), Some(false)) | (Some(false), Some(true)) | (None, None) => {}
                (a, b) => panic!("non-monotone: live={a:?} tighter={b:?}"),
            }
        }
        // Disabled live cap stays disabled-holder: tighter of a disabled
        // (<=0) live pct is still computed independently — here 0.0 live
        // disables, tighter 0.0 also disables.
        assert_eq!(
            loss_cap_danger(Some(1000.0), Some(0.0), Some(0.0), Some(0.0), 0.0),
            Some(false)
        );
    }

    #[test]
    fn signal_lift_edges() {
        // Empty -> None; one-sided (winners-only / losers-only) -> None;
        // non-finite signal or pnl -> None. Mirrors computeSignalLift guards.
        assert_eq!(signal_lift(&[]), None);
        assert_eq!(signal_lift(&[(5.0, 10.0), (4.0, 5.0)]), None);
        assert_eq!(signal_lift(&[(0.5, -4.0), (0.4, -2.0)]), None);
        assert_eq!(signal_lift(&[(f64::NAN, 1.0), (0.5, -1.0)]), None);
        assert_eq!(signal_lift(&[(1.0, f64::INFINITY), (0.5, -1.0)]), None);
        // Zero-spread (winners == losers mean) lifts 0, not None.
        assert_eq!(signal_lift(&[(1.0, 2.0), (1.0, -2.0)]), Some(0.0));
    }

    #[test]
    fn drift_shadow_reads_bin_ring() {
        // Wave 95: drift derives from the chain-fed ring (chrono), NOT
        // persisted snapshots. Full ring [100, 90, 80, 70] → 70-100 = -30;
        // a cap-2 ring [90, 80] → 80-90 = -10 (the cap itself now applies
        // at push — push_bin_history_cap_evicts_oldest pins that).
        let path =
            std::env::temp_dir().join(format!("prismd-drift-cap-test-{}.db", std::process::id()));
        let conn = rusqlite::Connection::open(&path).expect("open scratch db");
        conn.execute_batch(
            "CREATE TABLE positions (position_id TEXT, pool_address TEXT, timestamp INTEGER, closed_at INTEGER, position_pubkey TEXT, deposited_usd REAL, current_value_usd REAL, cumulative_fees_claimed_usd REAL, cumulative_rewards_claimed_usd REAL, active_bin_id INTEGER, lower_bin_id INTEGER, upper_bin_id INTEGER, last_rebalance_at INTEGER, oor_cycle_count INTEGER);
             CREATE TABLE signal_snapshots (pool_address TEXT, timestamp INTEGER, fee_il_ratio REAL);",
        )
        .expect("create scratch schema");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        conn.execute(
            "INSERT INTO positions (position_id, pool_address, timestamp, closed_at, position_pubkey) VALUES ('pos-cap', 'poolCap', ?1, NULL, NULL)",
            [now],
        )
        .unwrap();
        drop(conn);
        let path_str = path.to_str().unwrap().to_string();
        let full: std::collections::HashMap<String, Vec<i64>> =
            [("poolCap".to_string(), vec![100, 90, 80, 70])]
                .into_iter()
                .collect();
        let uncapped = fee_il_shadows_capped(
            &path_str,
            0,
            &full,
            10,
            12,
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
        );
        assert_eq!(
            uncapped[0].net_drift_bins,
            Some(-30.0),
            "full ring sees all 4"
        );
        let sliced: std::collections::HashMap<String, Vec<i64>> =
            [("poolCap".to_string(), vec![90, 80])]
                .into_iter()
                .collect();
        let capped = fee_il_shadows_capped(
            &path_str,
            0,
            &sliced,
            10,
            12,
            &std::collections::HashMap::new(),
            &std::collections::HashMap::new(),
        );
        assert_eq!(
            capped[0].net_drift_bins,
            Some(-10.0),
            "cap-2 ring sees 2 newest only"
        );
        let _ = std::fs::remove_file(&path);
    }
    #[test]
    fn rebalance_range_invalid_guards() {
        // Mirrors checkRebalanceRangeGate width arm (risk-service.ts:264-277):
        // upper<=lower invalid, width>max invalid, boundary holds, missing None.
        assert_eq!(rebalance_range_invalid(Some(10), Some(10), 200), Some(true));
        assert_eq!(rebalance_range_invalid(Some(20), Some(10), 200), Some(true));
        assert_eq!(rebalance_range_invalid(Some(0), Some(201), 200), Some(true));
        assert_eq!(
            rebalance_range_invalid(Some(0), Some(200), 200),
            Some(false)
        );
        assert_eq!(rebalance_range_invalid(Some(0), Some(50), 200), Some(false));
        assert_eq!(rebalance_range_invalid(None, Some(50), 200), None);
        assert_eq!(
            config::parse_max_rebalance_range_bins(Some("0")),
            Err("MAX_REBALANCE_RANGE_BINS=0 outside [1, 200]".to_string())
        );
        assert_eq!(config::parse_max_rebalance_range_bins(None), Ok(200));
    }
    #[test]
    fn gas_rebalance_justified_guards() {
        // Mirrors evaluateGasGate (risk-service.ts:721-769): justified iff
        // gas <= fees*days; non-finite/unknown -> None; non-positive gas or
        // fees -> Some(false) (refuse). Share helper: capped 100%, 0 on junk.
        assert_eq!(
            gas_rebalance_justified(Some(1.5), Some(10.0), 3.0),
            Some(true)
        );
        assert_eq!(
            gas_rebalance_justified(Some(1.5), Some(0.4), 3.0),
            Some(false)
        );
        assert_eq!(
            gas_rebalance_justified(Some(0.0), Some(10.0), 3.0),
            Some(false)
        );
        assert_eq!(
            gas_rebalance_justified(Some(1.5), Some(0.0), 3.0),
            Some(false)
        );
        assert_eq!(gas_rebalance_justified(None, Some(10.0), 3.0), None);
        assert_eq!(gas_rebalance_justified(Some(1.5), None, 3.0), None);
        assert_eq!(
            gas_rebalance_justified(Some(f64::NAN), Some(10.0), 3.0),
            None
        );
        assert_eq!(position_share_pct(1000.0, 500.0), 0.5);
        assert_eq!(position_share_pct(1000.0, 2000.0), 1.0);
        assert_eq!(position_share_pct(0.0, 500.0), 0.0);
        assert_eq!(position_share_pct(1000.0, -5.0), 0.0);
        assert_eq!(position_share_pct(f64::NAN, 500.0), 0.0);
        assert_eq!(config::parse_rebalance_gas_cost_sol(None), Ok(0.01));
        assert_eq!(config::parse_sol_price_usd(None), Ok(150.0));
        assert_eq!(config::parse_gas_aware_min_days(None), Ok(3.0));
        assert_eq!(
            config::parse_sol_price_usd(Some("20000")),
            Err("SOL_PRICE_USD=20000 outside [0, 10000]".to_string())
        );
    }
    #[test]
    fn recovery_hold_guards() {
        // Mirrors estimateRecoveryProbability + shouldHoldForRecovery
        // (strategy-service.ts:678-706): <2 bins → 0.5; flat → drift<=0?1:0;
        // else mean|Δ|/(mean|Δ|+drift) pinned [0,1], hold iff >= threshold.
        assert_eq!(recovery_probability(&[100], 5.0), Some(0.5));
        assert_eq!(recovery_probability(&[100, 100, 100], 5.0), Some(0.0));
        assert_eq!(recovery_probability(&[100, 100, 100], 0.0), Some(1.0));
        assert_eq!(
            recovery_probability(&[100, 110, 100, 110], 5.0),
            Some(10.0 / 15.0)
        );
        assert_eq!(recovery_probability(&[100, 110], f64::NAN), None);
        assert_eq!(recovery_hold(&[100], 5.0, 0.6), Some(false));
        assert_eq!(recovery_hold(&[100, 110, 100, 110], 5.0, 0.6), Some(true));
        assert_eq!(recovery_hold(&[100, 110, 100, 110], 5.0, 0.7), Some(false));
        assert_eq!(recovery_hold(&[100], 5.0, f64::NAN), None);
        assert_eq!(config::parse_oor_recovery_hold(None), Ok(0.6));
        assert_eq!(config::parse_oor_recovery_force(None), Ok(0.2));
        assert_eq!(
            config::parse_oor_recovery_hold(Some("x")),
            Err("OOR_RECOVERY_HOLD_THRESHOLD=\"x\" is not a number".to_string())
        );
    }
    #[test]
    fn interval_paper_guards() {
        // Mirrors capital-gate min-interval arm (risk-service.ts:665-673):
        // grace bypasses; else now-last >= min cools; missing clock → None.
        // F6 (risk-service.ts:950-982): paper → pass; days>=min → pass;
        // !enforce → warn-pass (Some(true)); else Some(false).
        assert_eq!(
            rebalance_interval_cooled(Some(1000), Some(0), 500, false),
            Some(true)
        );
        assert_eq!(
            rebalance_interval_cooled(Some(1000), Some(800), 500, false),
            Some(false)
        );
        assert_eq!(
            rebalance_interval_cooled(Some(1000), Some(800), 500, true),
            Some(true)
        );
        assert_eq!(rebalance_interval_cooled(None, Some(0), 500, false), None);
        assert_eq!(paper_validation_pass(true, None, 7.0, true), Some(true));
        assert_eq!(
            paper_validation_pass(false, Some(7.0), 7.0, true),
            Some(true)
        );
        assert_eq!(
            paper_validation_pass(false, Some(1.0), 7.0, false),
            Some(true)
        );
        assert_eq!(
            paper_validation_pass(false, Some(1.0), 7.0, true),
            Some(false)
        );
        assert_eq!(paper_validation_pass(false, None, 7.0, true), None);
        assert_eq!(
            paper_validation_pass(false, Some(f64::NAN), 7.0, true),
            None
        );
        assert_eq!(
            config::parse_min_rebalance_interval_ms(None),
            Ok(86_400_000)
        );
        assert_eq!(config::parse_oor_grace_period_cycles(None), Ok(3));
        assert_eq!(config::parse_paper_validation_min_days(None), Ok(7.0));
        assert_eq!(
            config::parse_min_rebalance_interval_ms(Some("-1")),
            Err("MIN_REBALANCE_INTERVAL_MS=-1 below min 0".to_string())
        );
    }
    #[test]
    fn pool_cooldown_free_guards() {
        // Mirrors checkEnterCooldownGate (program.ts:11870-11906): no row is
        // handled at the tick (absent = free, not counted); here: now>=until
        // → free, now<until → hold; missing clock → None (never flags).
        assert_eq!(pool_cooldown_free(Some(1000), Some(1000),), Some(true));
        assert_eq!(pool_cooldown_free(Some(2000), Some(1000),), Some(false));
        assert_eq!(pool_cooldown_free(Some(1000), None), None);
        assert_eq!(pool_cooldown_free(None, Some(1000)), None);
    }
    #[test]
    fn compound_approved_guards() {
        // Mirrors evaluateCompoundGate (risk-service.ts:793-838): net clears
        // min+buffer+gas → approve; net<=0 / savings<=0 → refuse; non-finite
        // / unknown → None. PARKED: no tick call (needs per-claim net leg).
        assert_eq!(compound_approved(Some(2.0), 0.5, 0.05, 1.5), Some(false));
        assert_eq!(compound_approved(Some(5.0), 0.5, 0.05, 1.5), Some(true));
        assert_eq!(compound_approved(Some(0.0), 0.5, 0.05, 1.5), Some(false));
        assert_eq!(compound_approved(Some(-1.0), 0.5, 0.05, 1.5), Some(false));
        assert_eq!(compound_approved(None, 0.5, 0.05, 1.5), None);
        assert_eq!(compound_approved(Some(f64::NAN), 0.5, 0.05, 1.5), None);
        assert_eq!(compound_approved(Some(5.0), f64::NAN, 0.05, 1.5), None);
        assert_eq!(config::parse_min_compound_fees_usd(None), Ok(0.5));
        assert_eq!(config::parse_compound_gas_buffer_usd(None), Ok(0.05));
        assert_eq!(
            config::parse_min_compound_fees_usd(Some("-1")),
            Err("MIN_COMPOUND_FEES_USD=-1 must be finite and >= 0".to_string())
        );
    }
    #[test]
    fn vol_exit_and_stddev_guards() {
        // Mirrors decidePhase2Exit vol arm (program.ts:11364-11398) +
        // computeBinVolatilityStddev (strategy-service.ts:299-305): EXIT iff
        // high-vol AND drifted AND cooled; runner exempt; unknown → None.
        assert_eq!(bin_volatility_stddev(&[]), 0.0);
        assert_eq!(bin_volatility_stddev(&[100]), 0.0);
        assert_eq!(bin_volatility_stddev(&[90, 100]), 50.0_f64.sqrt());
        assert_eq!(
            vol_exit_fires(false, Some(5.0), 5.0, Some(0.7), Some(true), false),
            Some(true)
        );
        assert_eq!(
            vol_exit_fires(false, Some(4.9), 5.0, Some(0.7), Some(true), false),
            Some(false)
        );
        assert_eq!(
            vol_exit_fires(true, Some(9.0), 5.0, Some(0.9), Some(true), false),
            Some(false)
        );
        assert_eq!(
            vol_exit_fires(false, Some(9.0), 5.0, Some(0.6), Some(true), false),
            Some(false)
        );
        assert_eq!(
            vol_exit_fires(false, Some(9.0), 5.0, Some(0.7), Some(false), false),
            Some(false)
        );
        assert_eq!(
            vol_exit_fires(false, Some(9.0), 5.0, Some(0.7), Some(false), true),
            Some(true)
        );
        assert_eq!(
            vol_exit_fires(false, Some(9.0), 5.0, Some(0.7), None, true),
            Some(true)
        );
        assert_eq!(
            vol_exit_fires(false, None, 5.0, Some(0.7), Some(true), false),
            None
        );
        assert_eq!(
            vol_exit_fires(false, Some(f64::NAN), 5.0, Some(0.7), Some(true), false),
            None
        );
        assert_eq!(config::parse_volatility_exit_stddev(None), Ok(5.0));
        assert_eq!(
            config::parse_volatility_exit_stddev(Some("-1")),
            Err("VOLATILITY_EXIT_STDDEV=-1 below min 0".to_string())
        );
        assert_eq!(config::parse_agent_http_port(None), Ok(0));
        assert_eq!(config::parse_agent_http_port(Some("8080")), Ok(8080));
        assert_eq!(
            config::parse_agent_http_port(Some("99999")),
            Err("AGENT_HTTP_PORT=99999 outside [0, 65535]".to_string())
        );
    }
    #[test]
    fn recommend_entry_strategy_guards() {
        // Mirrors recommendStrategy (strategy-service.ts:483-492):
        // |drift| >= max(3, 2σ) → bidask; else σ >= thr → spot; else curve.
        // Non-finite → curve (TS falls through both comparisons to curve).
        assert_eq!(recommend_entry_strategy(1.0, 5.0, 0.0), "curve");
        assert_eq!(recommend_entry_strategy(0.0, 5.0, 0.0), "curve");
        assert_eq!(recommend_entry_strategy(6.0, 5.0, 1.0), "spot");
        assert_eq!(recommend_entry_strategy(5.0, 5.0, 1.0), "spot");
        assert_eq!(recommend_entry_strategy(1.0, 5.0, 3.0), "bidask");
        assert_eq!(recommend_entry_strategy(1.0, 5.0, -4.0), "bidask");
        assert_eq!(recommend_entry_strategy(6.0, 5.0, 12.0), "bidask");
        assert_eq!(recommend_entry_strategy(f64::NAN, 5.0, 0.0), "curve");
        assert_eq!(recommend_entry_strategy(1.0, 5.0, f64::NAN), "curve");
    }
    #[test]
    fn ta_indicator_twins_guard() {
        // Mirrors engine/ta-exhaustion.ts: RSI(2) Wilder, BB-upper (20,2sd),
        // MACD(12,26,9) histogram. Short/junk → None (fail-open).
        assert_eq!(ta_rsi2(&[]), None);
        assert_eq!(ta_rsi2(&[1.0, 2.0]), None);
        assert_eq!(ta_rsi2(&[f64::NAN, 2.0, 3.0]), None);
        // Flat series → RSI 50 (no gain, no loss).
        assert_eq!(ta_rsi2(&[5.0; 40]), Some(50.0));
        // Monotone rise → RSI 100; monotone fall → RSI 0.
        let up: Vec<f64> = (0..40).map(|i| i as f64).rev().collect();
        assert_eq!(ta_rsi2(&up), Some(100.0));
        let down: Vec<f64> = (0..40).map(|i| i as f64).collect();
        assert_eq!(ta_rsi2(&down), Some(0.0));
        // BB-upper: short → None; flat-20 → upper == close.
        assert_eq!(ta_bb_upper(&[1.0; 10]), None);
        assert_eq!(ta_bb_upper(&[7.0; 20]), Some(7.0));
        // Ramp newest-first (20..=1): trailing window is the ascending ramp;
        // upper must exceed the latest close (catches oldest-20 slicing).
        let ramp_nf: Vec<f64> = (1..=20).rev().map(|i| i as f64).collect();
        let upper = ta_bb_upper(&ramp_nf).unwrap();
        assert!(upper > 20.0, "ramp upper {upper} must exceed close 20");
        // MACD hist: short → None; junk → None.
        assert_eq!(ta_macd_hist(&[1.0; 20]), None);
        let mut junk = [1.0; 40];
        junk[5] = f64::NAN;
        assert_eq!(ta_macd_hist(&junk), None);
        // Flat-40 → hist (0,0): no first-green.
        let (h, pr) = ta_macd_hist(&[3.0; 40]).unwrap();
        assert!((h.abs() < 1e-9) && (pr.abs() < 1e-9));
    }
    #[test]
    fn resolve_range_half_width_guards() {
        // Mirrors resolveRangeHalfWidth (strategy-service.ts:429-467):
        // tier base (None/0 → 25, 20 → 20, 100 → 15) + coverage floor +
        // sigma clamp(σ/2, 0.5, 2) + half-cap min(maxFull/2, 34) + floor 5.
        assert_eq!(resolve_range_half_width(None, 0, true, 0.0, 200, 5.0), 25);
        assert_eq!(
            resolve_range_half_width(Some(20), 0, false, 0.0, 200, 0.0),
            20
        );
        assert_eq!(
            resolve_range_half_width(Some(100), 0, false, 0.0, 200, 0.0),
            15
        );
        assert_eq!(
            resolve_range_half_width(Some(4), 0, true, 6.0, 200, 5.0),
            34
        );
        assert_eq!(
            resolve_range_half_width(Some(4), 0, true, 0.5, 200, 5.0),
            17
        );
        assert_eq!(
            resolve_range_half_width(Some(4), 0, true, f64::NAN, 200, 5.0),
            34
        );
    }

    // ─── Wave 101: discovery + screener (cross-language gold) ─────────────
    // The SAME fixture feeds bench/screener-discover.test.ts: the TS output
    // persisted under `expected` is the gold these tests reproduce
    // field-for-field (floats included — TS's own chains land on
    // 0.19999999999999996-class doubles no hand-pin would guess).
    // Regenerate: PRISM_WRITE_GOLD=1 bun run test -- bench/screener-discover.test.ts.

    const SCREENER_GOLD: &str = include_str!("../fixtures/screener-page.json");
    const MALFORMED_PAGINATION: &str =
        "Meteora API returned malformed pagination metadata from https://x/pools";

    fn screener_gold() -> serde_json::Value {
        serde_json::from_str(SCREENER_GOLD).expect("fixture json parses")
    }

    fn gold_cfg(v: &serde_json::Value) -> super::discovery::ScreenerCfg {
        let c = &v["config"];
        super::discovery::ScreenerCfg {
            min_tvl_usd: c["minTvlUsd"].as_f64().expect("minTvlUsd"),
            min_fee_ratio: c["minFeeRatio"].as_f64().expect("minFeeRatio"),
            volume_auth_threshold: c["volumeAuthThreshold"]
                .as_f64()
                .expect("volumeAuthThreshold"),
            min_bin_utilization: c["minBinUtilization"].as_f64().expect("minBinUtilization"),
        }
    }

    fn pool_row(address: &str, tvl: f64, volume: f64, fees: f64) -> serde_json::Value {
        serde_json::json!({
            "address": address, "tvl": tvl, "apr": 55.0,
            "name": "SOX/SOY", "created_at": 1_700_000_000_000_u64,
            "token_x": {"address": "X111111111111111111111111111111111111111", "symbol": "SOX"},
            "token_y": {"address": "Y111111111111111111111111111111111111111", "symbol": "SOY"},
            "pool_config": {"bin_step": 25, "base_fee_pct": 1.0},
            "volume": {"24h": volume, "1h": volume / 24.0},
            "fees": {"24h": fees, "1h": fees / 24.0},
            "fee_tvl_ratio": {"24h": 0.02},
        })
    }

    fn page(rows: Vec<serde_json::Value>) -> serde_json::Value {
        serde_json::json!({
            "current_page": 1, "page_size": 1000, "pages": 1,
            "total": rows.len() as i64, "data": rows,
        })
    }

    fn envelope_f(total: f64, pages: f64, current: f64, page_size: f64) -> serde_json::Value {
        serde_json::json!({
            "total": total, "pages": pages, "current_page": current,
            "page_size": page_size, "data": [],
        })
    }

    #[test]
    fn discovery_envelope_and_pagination_errors_mirror_ts() {
        use super::discovery::parse_discovery_page;
        let url = "https://x/pools";
        // describe() variants — serde's preserve_order keeps TS's key order.
        let e = parse_discovery_page(&serde_json::json!({"foo": 1}), url, None, 1000)
            .expect_err("bare object is not an envelope");
        assert_eq!(
            e,
            format!("Meteora API returned non-envelope payload (object(keys=foo)) from {url}")
        );
        let e = parse_discovery_page(&serde_json::json!("hi"), url, None, 1000).unwrap_err();
        assert_eq!(
            e,
            format!("Meteora API returned non-envelope payload (string) from {url}")
        );
        let e = parse_discovery_page(&serde_json::json!([1, 2]), url, None, 1000).unwrap_err();
        assert_eq!(
            e,
            format!("Meteora API returned non-envelope payload (array(length=2)) from {url}")
        );
        let e = parse_discovery_page(
            &serde_json::json!({"total": "7", "pages": 1, "current_page": 1, "page_size": 1000, "data": []}),
            url,
            None,
            1000,
        )
        .unwrap_err();
        assert!(
            e.starts_with("Meteora API returned non-envelope payload"),
            "{e}"
        );
        // Pagination numbers (isSafeInteger + sign bounds):
        assert_eq!(
            parse_discovery_page(&envelope_f(-1.0, 1.0, 1.0, 1000.0), url, None, 1000).unwrap_err(),
            MALFORMED_PAGINATION
        );
        assert_eq!(
            parse_discovery_page(&envelope_f(1.5, 1.0, 1.0, 1000.0), url, None, 1000).unwrap_err(),
            MALFORMED_PAGINATION
        );
        assert_eq!(
            parse_discovery_page(&envelope_f(0.0, 1.0, 0.0, 1000.0), url, None, 1000).unwrap_err(),
            MALFORMED_PAGINATION
        );
        // Range arm (total > 0): current > pages, zero response size,
        // requested-page mismatch (the rotation-path guards — ported even
        // though the host's no-arg path always passes None).
        assert_eq!(
            parse_discovery_page(&envelope_f(1.0, 1.0, 2.0, 1000.0), url, None, 1000).unwrap_err(),
            MALFORMED_PAGINATION
        );
        assert_eq!(
            parse_discovery_page(&envelope_f(1.0, 1.0, 1.0, 0.0), url, None, 1000).unwrap_err(),
            MALFORMED_PAGINATION
        );
        assert_eq!(
            parse_discovery_page(&envelope_f(10.0, 2.0, 1.0, 1000.0), url, Some(2), 1000)
                .unwrap_err(),
            MALFORMED_PAGINATION
        );
        // Range arm (total == 0): requested page/size must still match.
        assert_eq!(
            parse_discovery_page(&envelope_f(0.0, 1.0, 1.0, 500.0), url, Some(1), 1000)
                .unwrap_err(),
            MALFORMED_PAGINATION
        );
        assert_eq!(
            parse_discovery_page(&envelope_f(0.0, 1.0, 1.0, 1000.0), url, Some(2), 1000)
                .unwrap_err(),
            MALFORMED_PAGINATION
        );
        // Valid: no-arg empty page + total==0 without a requested page.
        assert!(parse_discovery_page(&page(vec![]), url, None, 1000).is_ok());
        assert!(parse_discovery_page(&envelope_f(0.0, 0.0, 1.0, 0.0), url, None, 1000).is_ok());
    }

    #[test]
    fn discovery_row_validity_launchpad_and_created_at() {
        use super::discovery::parse_discovery_page;
        let url = "https://x/pools";
        let good = "G111111111111111111111111111111111111111";
        // Each of TS's seven shape checks drops exactly its row.
        type Mutation = (&'static str, Box<dyn FnOnce(&mut serde_json::Value)>);
        let mut mutations: Vec<Mutation> = Vec::new();
        mutations.push((
            "address missing",
            Box::new(|r: &mut _| {
                r.as_object_mut().unwrap().remove("address");
            }),
        ));
        mutations.push((
            "tvl is string",
            Box::new(|r: &mut _| {
                r["tvl"] = serde_json::json!("150000");
            }),
        ));
        mutations.push((
            "apr missing",
            Box::new(|r: &mut _| {
                r.as_object_mut().unwrap().remove("apr");
            }),
        ));
        mutations.push((
            "token_x has no address",
            Box::new(|r: &mut _| {
                r["token_x"] = serde_json::json!({});
            }),
        ));
        mutations.push((
            "token_y missing",
            Box::new(|r: &mut _| {
                r.as_object_mut().unwrap().remove("token_y");
            }),
        ));
        mutations.push((
            "pool_config has no bin_step",
            Box::new(|r: &mut _| {
                r["pool_config"] = serde_json::json!({});
            }),
        ));
        mutations.push((
            "volume has no 24h",
            Box::new(|r: &mut _| {
                r["volume"] = serde_json::json!({"1h": 1.0});
            }),
        ));
        mutations.push((
            "fees has no 24h",
            Box::new(|r: &mut _| {
                r["fees"] = serde_json::json!({"1h": 0.1});
            }),
        ));
        for (label, mutate) in mutations {
            let mut bad = pool_row(
                "B111111111111111111111111111111111111111",
                150_000.0,
                300_000.0,
                500.0,
            );
            mutate(&mut bad);
            let pools = parse_discovery_page(
                &page(vec![bad, pool_row(good, 150_000.0, 300_000.0, 500.0)]),
                url,
                None,
                1000,
            )
            .unwrap_or_else(|e| panic!("{label}: unexpected err {e}"));
            assert_eq!(pools.len(), 1, "{label}: invalid row must be dropped");
            assert_eq!(pools[0].address, good, "{label}: valid row must survive");
        }
        // ALL rows invalid → the schema-change error (fail the cycle loudly).
        let mut bad = pool_row(
            "X111111111111111111111111111111111111111",
            150_000.0,
            300_000.0,
            500.0,
        );
        bad.as_object_mut().expect("row").remove("fees");
        let e = parse_discovery_page(&page(vec![bad]), url, None, 1000).expect_err("all-invalid");
        assert_eq!(
            e,
            "Meteora API returned 1 pool rows but none matched the expected shape. Likely a schema change. Pool discovery disabled for this cycle."
        );
        // Launchpad truthiness (TS `!p.launchpad` filter).
        for kept in [
            serde_json::Value::Null,
            serde_json::json!(""),
            serde_json::json!(0),
            serde_json::json!(false),
        ] {
            let mut row = pool_row(
                "K111111111111111111111111111111111111111",
                150_000.0,
                300_000.0,
                500.0,
            );
            row["launchpad"] = kept.clone();
            let pools = parse_discovery_page(&page(vec![row]), url, None, 1000)
                .unwrap_or_else(|e| panic!("launchpad {kept}: {e}"));
            assert_eq!(pools.len(), 1, "launchpad {kept} must be kept");
        }
        for dropped in [
            serde_json::json!("pump.fun"),
            serde_json::json!(5),
            serde_json::json!(true),
        ] {
            let mut row = pool_row(
                "D111111111111111111111111111111111111111",
                150_000.0,
                300_000.0,
                500.0,
            );
            row["launchpad"] = dropped.clone();
            let pools = parse_discovery_page(&page(vec![row]), url, None, 1000).unwrap();
            assert!(pools.is_empty(), "launchpad {dropped} must be dropped");
        }
        // created_at: ms verbatim, seconds ×1000, non-positive/non-number absent.
        let ms = pool_row(
            "M111111111111111111111111111111111111111",
            150_000.0,
            300_000.0,
            500.0,
        );
        let secs = {
            let mut r = pool_row(
                "S111111111111111111111111111111111111111",
                150_000.0,
                300_000.0,
                500.0,
            );
            r["created_at"] = serde_json::json!(1_730_000_000_u64);
            r
        };
        let zero = {
            let mut r = pool_row(
                "Z111111111111111111111111111111111111111",
                150_000.0,
                300_000.0,
                500.0,
            );
            r["created_at"] = serde_json::json!(0);
            r
        };
        let stringy = {
            let mut r = pool_row(
                "T111111111111111111111111111111111111111",
                150_000.0,
                300_000.0,
                500.0,
            );
            r["created_at"] = serde_json::json!("soon");
            r
        };
        let pools =
            parse_discovery_page(&page(vec![ms, secs, zero, stringy]), url, None, 1000).unwrap();
        assert_eq!(pools.len(), 4);
        assert_eq!(pools[0].created_at_ms, Some(1_700_000_000_000.0));
        assert_eq!(pools[1].created_at_ms, Some(1_730_000_000_000.0));
        assert_eq!(pools[2].created_at_ms, None);
        assert_eq!(pools[3].created_at_ms, None);
    }

    #[test]
    fn discovery_gold_parity() {
        use super::discovery::{adapter_discover, screen};
        let gold = screener_gold();
        let cfg = gold_cfg(&gold);
        let url = gold["url"].as_str().expect("url");

        // 1) adapter chain: envelope + validity + launchpad + TVL floor + top-50.
        let pools =
            adapter_discover(&gold["payload"], url, cfg.min_tvl_usd).expect("fixture parses");
        let expected_discovered: Vec<super::discovery::DiscoveredPool> = gold["expected"]
            ["discovered"]
            .as_array()
            .expect("gold discovered")
            .iter()
            .map(|e| super::discovery::DiscoveredPool {
                address: e["address"].as_str().expect("address").to_string(),
                tvl_usd: e["tvlUsd"].as_f64().expect("tvlUsd"),
                volume24h_usd: e["volume24hUsd"].as_f64().expect("volume24hUsd"),
                fees24h_usd: e["fees24hUsd"].as_f64().expect("fees24hUsd"),
                apr: e["apr"].as_f64().expect("apr"),
                bin_step: e["binStep"].as_f64().expect("binStep"),
                token_x: e["tokenX"].as_str().expect("tokenX").to_string(),
                token_y: e["tokenY"].as_str().expect("tokenY").to_string(),
                created_at_ms: e["createdAtMs"].as_f64(),
            })
            .collect();
        assert_eq!(pools, expected_discovered, "adapter chain vs TS gold");

        // 2) screener: gates + stable sort + top-10 enrichment (fixture windows).
        let windows = gold["bin_windows"].as_object().expect("windows");
        let mut fetches = 0usize;
        let screened = screen(pools, &cfg, |address| {
            fetches += 1;
            let w = windows.get(address)?;
            let parts = w.as_array()?;
            if !parts[0].as_bool()? {
                return None; // known=false → TS pass-through
            }
            Some(parts[1].as_f64()? / parts[2].as_f64()?)
        });
        assert_eq!(
            fetches,
            gold["fetch_count_expected"].as_u64().expect("count") as usize,
            "bin-window fetches bounded to the top 10"
        );
        let expected_screened: Vec<super::discovery::ScreenedPool> = gold["expected"]["screened"]
            .as_array()
            .expect("gold screened")
            .iter()
            .map(|e| super::discovery::ScreenedPool {
                address: e["address"].as_str().expect("address").to_string(),
                tvl_usd: e["tvlUsd"].as_f64().expect("tvlUsd"),
                volume24h_usd: e["volume24hUsd"].as_f64().expect("volume24hUsd"),
                fees24h_usd: e["fees24hUsd"].as_f64().expect("fees24hUsd"),
                apr: e["apr"].as_f64().expect("apr"),
                fee_il_ratio: e["feeIlRatio"].as_f64().expect("feeIlRatio"),
                volume_auth: e["volumeAuth"].as_f64().expect("volumeAuth"),
                bin_utilization: e["binUtilization"].as_f64().expect("binUtilization"),
                token_x: e["tokenX"].as_str().expect("tokenX").to_string(),
                token_y: e["tokenY"].as_str().expect("tokenY").to_string(),
                created_at_ms: e["createdAtMs"].as_f64(),
            })
            .collect();
        assert_eq!(screened, expected_screened, "screen chain vs TS gold");

        // 3) the top-3 candidate lines.
        let candidates: Vec<&str> = screened
            .iter()
            .take(3)
            .map(|p| p.address.as_str())
            .collect();
        let expected_candidates: Vec<&str> = gold["expected"]["candidates"]
            .as_array()
            .expect("candidates")
            .iter()
            .map(|c| c.as_str().expect("candidate"))
            .collect();
        assert_eq!(candidates, expected_candidates);

        // 4) volume-authenticity gold: every leg, TS's own float chains.
        for (i, expected) in gold["expected"]["auth"]
            .as_array()
            .expect("auth gold")
            .iter()
            .enumerate()
        {
            let v = &gold["auth_vectors"][i];
            let score = super::discovery::check_volume_authenticity(
                v["tvl"].as_f64().expect("tvl"),
                v["volume"].as_f64().expect("volume"),
                v["fees"].as_f64().expect("fees"),
                v["measured"].as_bool().expect("measured"),
            );
            assert_eq!(
                score,
                expected["score"].as_f64().expect("score"),
                "{}",
                v["name"]
            );
        }

        // 5) bin-utilization gold: TS computeBinUtilization over fixture bins
        //    (the known-false/empty arms are structural: the host collapses
        //    both into the fetch-Err pass-through pinned in top10 below).
        for c in gold["util_vectors"].as_array().expect("util vectors") {
            let slots: Vec<super::rpc::BinSlot> = c["bins"]
                .as_array()
                .expect("bins")
                .iter()
                .enumerate()
                .map(|(i, b)| super::rpc::BinSlot {
                    bin_id: i as i64,
                    reserve_x: b[0].as_str().expect("rx").parse().expect("rx int"),
                    reserve_y: b[1].as_str().expect("ry").parse().expect("ry int"),
                    liquidity_supply: b[2].as_str().expect("liq").parse().expect("liq int"),
                })
                .collect();
            let known = c["known"].as_bool().expect("known");
            let active = slots.iter().filter(|s| super::rpc::slot_active(s)).count();
            let util = if !known || slots.is_empty() {
                0.0
            } else {
                active as f64 / slots.len() as f64
            };
            assert_eq!(util, c["expect"].as_f64().expect("expect"), "{}", c["name"]);
        }
    }

    #[test]
    fn screener_gate_boundaries() {
        use super::discovery::{
            check_volume_authenticity, screen_gates, DiscoveredPool, ScreenerCfg,
        };
        let pool = |address: &str, tvl: f64, volume: f64, fees: f64| DiscoveredPool {
            address: address.to_string(),
            tvl_usd: tvl,
            volume24h_usd: volume,
            fees24h_usd: fees,
            apr: 55.0,
            bin_step: 25.0,
            token_x: "X".to_string(),
            token_y: "Y".to_string(),
            created_at_ms: Some(1_700_000_000_000.0),
        };
        let cfg = ScreenerCfg {
            min_tvl_usd: 100_000.0,
            min_fee_ratio: 1.5,
            volume_auth_threshold: 0.7,
            min_bin_utilization: 0.3,
        };
        // TVL floor is inclusive (TS: `pool.tvlUsd < minTvlUsd` → null).
        assert_eq!(
            screen_gates(vec![pool("T1", 100_000.0, 300_000.0, 600.0)], &cfg).len(),
            1
        );
        assert!(screen_gates(vec![pool("T2", 99_999.99, 300_000.0, 600.0)], &cfg).is_empty());
        // Auth boundary: vol/tvl 11× loses exactly 0.3 → score == threshold → KEPT.
        let gated = screen_gates(vec![pool("A1", 1_000_000.0, 11_000_000.0, 11_000.0)], &cfg);
        assert_eq!(gated.len(), 1, "auth == threshold must keep");
        assert_eq!(gated[0].volume_auth, 0.7);
        // One more penalty (fee-rate outlier below the band) → 0.5 → DROPPED.
        assert!(screen_gates(vec![pool("A2", 1_000_000.0, 6_000_000.0, 300.0)], &cfg).is_empty());
        // Fee/TVL floor is inclusive; the f64 chain is exact (1.5*365/365).
        let loose = ScreenerCfg {
            min_tvl_usd: 0.0,
            ..cfg
        };
        let kept = screen_gates(vec![pool("F1", 365.0, 0.0, 1.5)], &loose);
        assert_eq!(kept.len(), 1, "feeToTvl == minFeeRatio must keep");
        assert_eq!(kept[0].fee_il_ratio, 1.5);
        assert!(screen_gates(vec![pool("F2", 365.0, 0.0, 1.49)], &loose).is_empty());
        // Non-positive fees → ratio 0 → dropped.
        assert!(screen_gates(vec![pool("F3", 1_000_000.0, 300_000.0, 0.0)], &loose).is_empty());
        // Zero TVL fails authenticity first (score 0), never a divide panic.
        assert!(screen_gates(vec![pool("Z1", 0.0, 300_000.0, 500.0)], &loose).is_empty());
        assert_eq!(check_volume_authenticity(0.0, 300_000.0, 500.0, true), 0.0);
        // Stable ties: equal fee/TVL keeps payload order (TS Array.sort).
        let ties = vec![
            pool("C3", 1_000_000.0, 500_000.0, 100_000.0),
            pool("A3", 1_000_000.0, 500_000.0, 100_000.0),
            pool("B3", 1_000_000.0, 500_000.0, 100_000.0),
        ];
        let gated_ties = screen_gates(ties, &cfg);
        let order: Vec<&str> = gated_ties.iter().map(|p| p.address.as_str()).collect();
        assert_eq!(order, ["C3", "A3", "B3"]);
    }

    #[test]
    fn screener_top10_bound_and_pass_through() {
        use super::discovery::{screen, DiscoveredPool, ScreenerCfg, MAX_BIN_UTILIZATION_CHECKS};
        let pools: Vec<DiscoveredPool> = (0..11)
            .map(|i| DiscoveredPool {
                address: format!("P{i}"),
                tvl_usd: 1_000_000.0,
                volume24h_usd: 500_000.0,
                fees24h_usd: 100_000.0,
                apr: 55.0,
                bin_step: 25.0,
                token_x: "X".to_string(),
                token_y: "Y".to_string(),
                created_at_ms: None,
            })
            .collect();
        let cfg = ScreenerCfg {
            min_tvl_usd: 100_000.0,
            min_fee_ratio: 1.5,
            volume_auth_threshold: 0.7,
            min_bin_utilization: 0.3,
        };
        // Equal fee/TVL → payload order; probe outcomes by call index:
        // 0 annotated (0.9), 1 fetch-fail → pass-through, 2 dropped (0.1),
        // 3.. annotated (0.5); the 11th survivor must never be fetched.
        let mut fetches = 0usize;
        let screened = screen(pools, &cfg, |_address| {
            let i = fetches;
            fetches += 1;
            match i {
                0 => Some(0.9),
                1 => None,
                2 => Some(0.1),
                _ => Some(0.5),
            }
        });
        assert_eq!(fetches, MAX_BIN_UTILIZATION_CHECKS, "only the top 10 probe");
        let addrs: Vec<&str> = screened.iter().map(|p| p.address.as_str()).collect();
        assert_eq!(
            addrs,
            ["P0", "P1", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"],
            "P2 dropped by the util gate; P10 appended unenriched"
        );
        assert_eq!(screened[0].bin_utilization, 0.9, "annotated");
        assert_eq!(
            screened[1].bin_utilization, 0.0,
            "fetch fail → pass-through at 0"
        );
        assert_eq!(screened[2].bin_utilization, 0.5, "mid-range annotated");
        assert_eq!(
            screened.last().expect("rest").bin_utilization,
            0.0,
            "beyond the top 10 the candidate is appended untouched"
        );
    }

    #[test]
    fn bin_window_core_and_slot_active() {
        use super::rpc::{slot_active, window_utilization, BinSlot};
        let slot = |bin_id: i64, reserve_x: u64, reserve_y: u64, liquidity_supply: u128| BinSlot {
            bin_id,
            reserve_x,
            reserve_y,
            liquidity_supply,
        };
        // A covers 2450..=2519 (all liquid); B covers 2520..=2589 (only
        // 2520..=2525 liquid). active 2515 → window [2495, 2535]:
        // present 25+16 = 41 (inclusive both ends), active 25+6 = 31.
        let make_a = || -> Vec<BinSlot> { (2450..=2519).map(|id| slot(id, 1, 0, 0)).collect() };
        let b: Vec<BinSlot> = (2520..=2589)
            .map(|id| slot(id, if id <= 2525 { 1 } else { 0 }, 0, 0))
            .collect();
        let arrays = vec![(35i64, make_a()), (36i64, b)];
        assert_eq!(
            window_utilization(&arrays, 2515).expect("crossing window"),
            31.0 / 41.0,
            "crossing-array window: inclusive ±20 span over both arrays"
        );
        // Coverage shrinks to what the pool's arrays hold (the SDK's
        // account-derived bins — ids outside every array exist nowhere):
        // only A here, active 2510 → [2490, 2530] ∩ A = 30 slots.
        assert_eq!(
            window_utilization(&[(35, make_a())], 2510).expect("single array"),
            1.0
        );
        // No coverage at all → Err (the screener's pass-through arm).
        assert!(window_utilization(&[(35, make_a())], 99_999).is_err());
        assert!(window_utilization(&[], 2461).is_err());
        // slot_active = TS's per-bin OR (reserveX || reserveY || supply).
        assert!(slot_active(&slot(0, 1, 0, 0)), "reserve_x alone is active");
        assert!(slot_active(&slot(0, 0, 1, 0)), "reserve_y alone is active");
        assert!(slot_active(&slot(0, 0, 0, 1)), "supply alone is active");
        assert!(!slot_active(&slot(0, 0, 0, 0)), "all-zero is inactive");
        assert!(slot_active(&slot(0, u64::MAX, 0, 0)), "u64 max is active");
    }

    #[test]
    fn discovery_config_parsers_mirror_ts() {
        use super::config::{
            parse_discovery_min_fee_ratio, parse_discovery_min_tvl_usd, parse_meteora_pools_url,
            DEFAULT_METEORA_POOLS_URL,
        };
        use super::discovery::should_discover;
        // DISCOVERY_MIN_TVL_USD: absent = 1,000,000; 0 is a legal floor;
        // garbage/negative/∞ fail closed (the house divergence from TS's
        // clamp-and-warn, documented at the consts).
        assert_eq!(parse_discovery_min_tvl_usd(None), Ok(1_000_000.0));
        assert_eq!(parse_discovery_min_tvl_usd(Some("0")), Ok(0.0));
        assert_eq!(parse_discovery_min_tvl_usd(Some("250000")), Ok(250_000.0));
        assert_eq!(parse_discovery_min_tvl_usd(Some("1e6")), Ok(1_000_000.0));
        assert!(parse_discovery_min_tvl_usd(Some("-1")).is_err());
        assert!(parse_discovery_min_tvl_usd(Some("abc")).is_err());
        assert!(parse_discovery_min_tvl_usd(Some("inf")).is_err());
        // DISCOVERY_MIN_FEE_RATIO: absent = 1.5, open range above.
        assert_eq!(parse_discovery_min_fee_ratio(None), Ok(1.5));
        assert_eq!(parse_discovery_min_fee_ratio(Some("0")), Ok(0.0));
        assert_eq!(parse_discovery_min_fee_ratio(Some("0.5")), Ok(0.5));
        assert!(parse_discovery_min_fee_ratio(Some("-0.1")).is_err());
        assert!(parse_discovery_min_fee_ratio(Some("x")).is_err());
        // METEORA_POOLS_URL: default only on absence; verbatim otherwise.
        assert_eq!(parse_meteora_pools_url(None), DEFAULT_METEORA_POOLS_URL);
        assert_eq!(parse_meteora_pools_url(Some("")), "");
        assert_eq!(
            parse_meteora_pools_url(Some("https://custom/pools?x=1")),
            "https://custom/pools?x=1"
        );
        // Net TS gate: enable ∧ paper (autonomous mode is never on here).
        assert!(should_discover(true, true));
        assert!(!should_discover(true, false));
        assert!(!should_discover(false, true));
        assert!(!should_discover(false, false));
    }
}
