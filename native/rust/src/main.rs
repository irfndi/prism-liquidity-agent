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

/// SHADOW-only portfolio-drawdown veto: mirrors `checkDrawdownGate`
/// (risk-service.ts:133-154) — ENTER vetoes when unrealized book PnL is
/// negative and `|pnl| / portfolio` exceeds 10% (hardcoded in TS, no config).
/// Exact TS semantics: non-finite portfolio/pnl → veto (fail-closed pause);
/// portfolio <= 0 → no veto (guard); otherwise `pnl < 0 && |pnl|/portfolio >
/// 0.1`. Portfolio here shadows against `paper_portfolio_usd` (TS uses live
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
/// Pure twin of the F7 pool-cooldown ENTER gate: ENTER may proceed iff no
/// cooldown row exists for the pool OR now >= cooldown_until. Mirrors
/// `checkEnterCooldownGate` (program.ts:11870-11906): active cooldown →
/// skip ENTER (observational hold here). `None` on missing clock leg →
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
/// driftPct>0.6 && (cooled||grace)`. Stddev = sample stddev over persisted
/// snapshot bins (same math as `computeBinVolatilityStddev`,
/// strategy-service.ts:299-305); driftPct = |newest-snapshot-bin−center| /
/// halfWidth (DIVERGENCE: TS uses live pool.activeBinId — host proxies with
/// the newest persisted bin, shape-identical); cooled/grace reuse the
/// interval legs with grace-first short-circuit (cooled=None+grace=true
/// fires, matching TS `||`). `None` on missing/non-finite → never flags.
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
    let half_cap = (max_full_range_bins.max(1) / 2).min(34).max(1);
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
/// Tighter-cap probe pct is inline at the tick (`max_position_loss_pct / 2.0`);
/// no helper — `loss_cap_danger` called twice, live + tighter.

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
    /// TS clamps out-of-band to min with a warn; host fails closed on
    /// garbage/non-finite (absent -> fallback).
    /// + validatedNumber("COMPOUND_GAS_BUFFER_USD", 0, 0.05) — same clamp shape.
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
    /// TS clamps out-of-band to min with a warn; host fails closed on
    /// garbage/non-finite (absent -> fallback).
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
    /// TS clamps below-min to min and above-max to max with a warn (absent ->
    /// fallback); the host fails closed on garbage/non-finite instead.
    pub const REBALANCE_GAS_COST_DEFAULT_SOL: f64 = 0.01;
    pub const REBALANCE_GAS_COST_MIN_SOL: f64 = 0.0;
    pub const SOL_PRICE_DEFAULT_USD: f64 = 150.0;
    pub const SOL_PRICE_MIN_USD: f64 = 0.0;
    pub const SOL_PRICE_MAX_USD: f64 = 10_000.0;
    pub const GAS_AWARE_MIN_DAYS_DEFAULT: f64 = 3.0;
    pub const GAS_AWARE_MIN_DAYS_MIN: f64 = 0.0;
    /// Mirrors engine/config-service.ts validatedNumber("MAX_POSITION_LOSS_PCT", 0, 0.35, 1).
    /// NOTE: TS clamps to [0,1] with a warn and disables at ≤0; the host fails
    /// closed on garbage/non-finite instead (absent -> 0.35, same fallback).
    pub const MAX_POSITION_LOSS_DEFAULT_PCT: f64 = 0.35;
    pub const MAX_POSITION_LOSS_MAX_PCT: f64 = 1.0;
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
        pub agent_http_port: u16,
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
        match raw.map(str::trim).map(str::to_lowercase).as_deref() {
            Some("false") | Some("0") | Some("no") => false,
            _ => true,
        }
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
        match raw.map(str::trim).map(str::to_lowercase).as_deref() {
            Some("false") | Some("0") | Some("no") => false,
            _ => true,
        }
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
/// — NOT its hold-bias override, which stays TS-only. `ratio`/`known` come
/// from the most recent `signal_snapshots.fee_il_ratio` /
/// `pool_snapshots.stats_source` row for the position's pool; either can be
/// absent (`None`) if no snapshot has landed yet.
struct FeeIlShadow {
    position_id: String,
    pool_address: String,
    known: bool,
    mature: bool,
    ratio: Option<f64>,
    /// `position_pubkey IS NOT NULL` — mirrors `pos.positionPubKey != null`,
    /// the "onchain" leg of the paper-accrual guard (program.ts:10197-10202).
    onchain: bool,
    /// Net active-bin drift in bins (last - first `active_bin_id` over the
    /// recent `pool_snapshots` ring); `None` when fewer than 2 snapshots
    /// exist (cold start → TS `netDriftBins = 0`, never rejects). Mirrors
    /// `resolvePoolDriftMetrics` (program.ts:9811-9832) minus the in-memory
    /// ring: snapshots ARE the persisted ring.
    net_drift_bins: Option<f64>,
    /// Ledger mark-PnL inputs for the loss-cap shadow (all `None` when the
    /// row lacks them → `danger=None`, never fires). Mirrors
    /// `engine/position-loss-cap.ts` `positionMarkPnlUsd` (current + claimed
    /// fees + rewards − deposited; deposited must be > 0).
    deposited_usd: Option<f64>,
    current_value_usd: Option<f64>,
    fees_claimed_usd: Option<f64>,
    rewards_claimed_usd: Option<f64>,
    /// Live band legs for the band-health shadow (gate-7 shape without a
    /// proposal): stored `active_bin_id` / `lower_bin_id` / `upper_bin_id`
    /// per open position (`None` when the row lacks them → skipped).
    active_bin_id: Option<i64>,
    lower_bin_id: Option<i64>,
    upper_bin_id: Option<i64>,
    /// Gas-gate shadow inputs (F1): pool TVL + 24h fees from the latest
    /// `pool_snapshots` row for the position's pool (`None` when no snapshot
    /// has landed yet → `daily=None`, never flags). Position share × pool
    /// fees = position daily fees, mirroring program.ts:11494-11500.
    pool_tvl_usd: Option<f64>,
    pool_fees_24h_usd: Option<f64>,
    /// Range-width shadow inputs: latest `pool_snapshots.bin_step` /
    /// `current_price` for the position's pool (`None` when no snapshot has
    /// landed yet or the column is absent → tier/coverage fall back, never
    /// acts). Same latest-row source as the TVL/fee legs.
    pool_bin_step: Option<i64>,
    pool_current_price: Option<f64>,
    /// TA-exhaustion shadow input: up to 35 newest `current_price` closes
    /// for the position's pool, newest-first (RSI/BB/MACD need ordered
    /// history; short/empty → TA no-vote, fail-open like TS
    /// TA_EXHAUSTION_MIN_POINTS floor). Same source as the bin ring.
    ta_closes_newest_first: Option<Vec<f64>>,
    /// Recovery-gate shadow input (F4): up to `oor_recovery_lookback` newest
    /// `active_bin_id`s for the position's pool, oldest-last → reversed to
    /// oldest-first at the tick (matches TS push order). `None`/short →
    /// prob 0.5, never holds alone (fail-open). Same source as the drift
    /// ring, sliced to the recovery window (program.ts:11670-11678).
    recovery_bins_newest_first: Option<Vec<i64>>,
    /// Vol-window shadow input: up to the `volatilityLookback` newest
    /// `active_bin_id`s for the position's pool, newest-first (stddev is
    /// order-free; tick keeps stored order). `None`/short → stddev 0.0,
    /// never fires alone (fail-open). Same source as drift, sliced to
    /// max(2, volatilityLookback) like TS (program.ts:9824-9828).
    vol_bins_newest_first: Option<Vec<i64>>,
    /// per open position (grace = count >= OOR_GRACE_PERIOD_CYCLES, like TS
    /// program.ts:11628). `None`/0-clock → cold start, never blocks.
    last_rebalance_at_ms: Option<i64>,
    oor_cycle_count: Option<i64>,
}
/// `ring_cap`: TS `binHistoryCap = max(volatilityLookback, oorRecovery, 2)`
/// (program.ts:5931-5935). `None` = uncapped (tests); `Some(c)` reads at most
/// the `c` newest `pool_snapshots` rows per pool so drift converges to the TS
/// ring once history exceeds the cap instead of diverging over all rows.
fn fee_il_shadows_capped(
    sqlite_path: &str,
    min_yield_exit_age_ms: i64,
    ring_cap: Option<i64>,
    recovery_lookback: i64,
    vol_lookback: i64,
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
        "SELECT position_id, pool_address, timestamp, position_pubkey, deposited_usd, current_value_usd, cumulative_fees_claimed_usd, cumulative_rewards_claimed_usd, active_bin_id, lower_bin_id, upper_bin_id, last_rebalance_at, oor_cycle_count FROM positions WHERE closed_at IS NULL",
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
            r.get::<_, Option<i64>>(12)?,
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
            |(position_id, pool_address, ts, position_pubkey, deposited_usd, current_value_usd, fees_claimed_usd, rewards_claimed_usd, active_bin_id, lower_bin_id, upper_bin_id, last_rebalance_at_ms, oor_cycle_count)| {
            let ratio: Option<f64> = conn
                .query_row(
                    "SELECT fee_il_ratio FROM signal_snapshots WHERE pool_address = ?1 ORDER BY timestamp DESC LIMIT 1",
                    [&pool_address],
                    |r| r.get(0),
                )
                .ok();
            let stats_source: Option<String> = conn
                .query_row(
                    "SELECT stats_source FROM pool_snapshots WHERE pool_address = ?1 ORDER BY timestamp DESC LIMIT 1",
                    [&pool_address],
                    |r| r.get(0),
                )
                .ok();
            let (pool_tvl_usd, pool_fees_24h_usd): (Option<f64>, Option<f64>) = conn
                .query_row(
                    "SELECT tvl_usd, fees_24h_usd FROM pool_snapshots WHERE pool_address = ?1 ORDER BY timestamp DESC LIMIT 1",
                    [&pool_address],
                    |r| Ok((r.get(0).ok(), r.get(1).ok())),
                )
                .unwrap_or((None, None));
            // ponytail: named columns, not SELECT * — old DBs without them fall
            // back to None legs, never break the tick.
            // TA closes window: up to 35 newest closes, newest-first.
            // Tolerant: empty on DB error → TA no-vote (fail-open).
            let ta_closes_newest_first: Option<Vec<f64>> = (|| {
                let mut stmt = conn
                    .prepare(
                        "SELECT current_price FROM pool_snapshots WHERE pool_address = ?1 ORDER BY timestamp DESC LIMIT 35",
                    )
                    .ok()?;
                let closes: Vec<f64> = stmt
                    .query_map(rusqlite::params![pool_address], |r| r.get(0))
                    .ok()?
                    .flatten()
                    .collect();
                if closes.is_empty() { None } else { Some(closes) }
            })();
            let (pool_bin_step, pool_current_price): (Option<i64>, Option<f64>) = conn
                .query_row(
                    "SELECT bin_step, current_price FROM pool_snapshots WHERE pool_address = ?1 ORDER BY timestamp DESC LIMIT 1",
                    [&pool_address],
                    |r| Ok((r.get(0).ok(), r.get(1).ok())),
                )
                .unwrap_or((None, None));
            // Net drift over at most the `ring_cap` newest snapshots (TS: the
            // in-memory binHistory ring, last - first; snapshots are the
            // persisted ring). Cold start (<2 rows) -> None -> 0, never
            // rejects. Uncapped (`None`) only in tests; the live tick always
            // passes `Some(bin_history_cap)`.
            let net_drift_bins: Option<f64> = (|| {
                let cap = ring_cap.unwrap_or(i64::MAX);
                let mut stmt = conn
                    .prepare(
                        "SELECT active_bin_id FROM pool_snapshots WHERE pool_address = ?1 ORDER BY timestamp DESC LIMIT ?2",
                    )
                    .ok()?;
                let bins: Vec<i64> = stmt
                    .query_map(rusqlite::params![pool_address, cap], |r| r.get(0))
                    .ok()?
                    .flatten()
                    .collect();
                if bins.len() >= 2 {
                    Some((bins[0] - bins[bins.len() - 1]) as f64)
                } else {
                    None
                }
            })();
            // Recovery window: up to `recovery_lookback` newest bins, newest-
            // first (reversed to oldest-first at the tick). Same source as
            // drift, sliced to max(2, oorRecoveryLookback) like TS
            // (program.ts:11670-11678). Empty on DB error → 0.5, never holds.
            let recovery_bins_newest_first: Option<Vec<i64>> = (|| {
                let lookback = recovery_lookback.max(2);
                let mut stmt = conn
                    .prepare(
                        "SELECT active_bin_id FROM pool_snapshots WHERE pool_address = ?1 ORDER BY timestamp DESC LIMIT ?2",
                    )
                    .ok()?;
                let bins: Vec<i64> = stmt
                    .query_map(rusqlite::params![pool_address, lookback], |r| r.get(0))
                    .ok()?
                    .flatten()
                    .collect();
                if bins.is_empty() { None } else { Some(bins) }
            })();
            // Vol window: up to `vol_lookback` newest bins, newest-first
            // (stddev order-free). Same source as drift, sliced to
            // max(2, volatilityLookback) like TS (program.ts:9824-9828).
            let vol_bins_newest_first: Option<Vec<i64>> = (|| {
                let lookback = vol_lookback.max(2);
                let mut stmt = conn
                    .prepare(
                        "SELECT active_bin_id FROM pool_snapshots WHERE pool_address = ?1 ORDER BY timestamp DESC LIMIT ?2",
                    )
                    .ok()?;
                let bins: Vec<i64> = stmt
                    .query_map(rusqlite::params![pool_address, lookback], |r| r.get(0))
                    .ok()?
                    .flatten()
                    .collect();
                if bins.is_empty() { None } else { Some(bins) }
            })();
            FeeIlShadow {
                position_id,
                pool_address,
                known: stats_source.as_deref() == Some("datapi"),
                mature: now_ms - ts >= min_yield_exit_age_ms,
                onchain: position_pubkey.is_some(),
                ratio,
                net_drift_bins,
                deposited_usd,
                current_value_usd,
                fees_claimed_usd,
                rewards_claimed_usd,
                active_bin_id,
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
    let shadows = fee_il_shadows_capped(
        &cfg.sqlite_path,
        cfg.min_yield_exit_age_ms,
        Some(bin_history_cap),
        cfg.oor_recovery_lookback_cycles,
        cfg.volatility_lookback_snapshots,
    );
    // Drawdown inputs: spot legs per open position (deposited/current only —
    // `toRiskPosition` is spot-only). Collected up front so the book-level
    // veto sees every row even though the per-position loop borrows `shadows`.
    let drawdown_legs: Vec<(Option<f64>, Option<f64>)> = shadows
        .iter()
        .map(|s| (s.deposited_usd, s.current_value_usd))
        .collect();
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
        let contained = match (s.active_bin_id, s.lower_bin_id, s.upper_bin_id) {
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
        let drift_dist = match (s.active_bin_id, center) {
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
        // DIVERGENCE (documented): TS uses the LIVE pool.activeBinId
        // (program.ts:11626); the host has no live pool feed, so the newest
        // persisted snapshot bin (vol_bins[0], newest-first) proxies it.
        // Shape matches TS exactly: |active−center| / (halfWidth || 1).
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
        // Exit-order dry-run: proven `K.exit_order` fed with stored loss legs
        // only — tp_hit=false + ta_hit=false are documented stubs (TP needs
        // the live ladder evaluator, TA needs `ta-exhaustion.ts` price
        // history; neither is stored). loss_hit reuses the already-computed
        // loss legs. DRY-RUN: logs + counter, never acts; when TA lands the
        // same line takes real bools with zero structural change.
        let loss_hit = danger == Some(true) || stop_loss == Some(true);
        // TA-exhaustion shadow: closes depth logged; bools stay stubbed
        // false until the host ports RSI2/BB/MACD math (closes ARE stored —
        // ta_closes_newest_first — but indicator computation lives TS-side).
        // Fail-open: short history → None (no-vote, like TS MIN_POINTS).
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
        let exit_order_pick =
            bend::exit_order(&cfg.bend_bin, false, ta_vote.unwrap_or(false), loss_hit);
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
    }

    // Book-level drawdown veto (gate 4): one verdict per tick over all opens.
    // Observational only — never blocks ENTER (TS owns risk until parity).
    let drawdown = drawdown_veto(&drawdown_legs, cfg.paper_portfolio_usd);
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
        "[prismd] decision open={open} exit_shadow={exit_shadow} enter_blocked_shadow={enter_blocked_shadow} danger_shadow={danger_shadow} drift_rejects_shadow={drift_rejects_shadow} capital_exits_shadow={capital_exits_shadow} stop_loss_shadow={stop_loss_shadow} band_health_shadow={band_health_shadow} gas_hold_shadow={gas_hold_shadow} recovery_hold_shadow={recovery_hold_shadow} interval_hold_shadow={interval_hold_shadow} vol_exit_shadow={vol_exit_shadow} exit_order_loss_shadow={exit_order_loss_shadow} paper_days={paper_days:?} paper_pass={paper_pass:?} cooldown_holds={cooldown_hold_shadow} drawdown_veto={drawdown:?} at_capacity={at_capacity} (observational)",
    );

    // Evolution shadow: what WOULD one evolveThresholds round do to the live
    // banded floors? Observational only — never writes metadata (TS owns
    // evolution until parity green). Skips quietly below evolutionInterval
    // outcomes, matching the TS early-return (program.ts:6032-6042).
    evolve_shadow(cfg);
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

fn main() {
    load_env_file(Path::new(".env"));
    // argv: [profile_env_path] [--ticks N]
    let args: Vec<String> = env::args().skip(1).collect();
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
    println!(
        "[prismd] paper shadow: sqlite={} interval_ms={} paper_usd={} jev={} bend={} helius={helius} jev_key={jev_key}",
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

#[cfg(test)]
mod tests {
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
    fn bend_available() -> bool {
        std::process::Command::new("bend")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
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
        if !bend_available() {
            eprintln!("skip: bend binary not on PATH");
            return;
        }
        // Golden vector shared with native/bend/LAWS.bend `band_runaway` and
        // bench/bend-parity.test.ts: the 2026-09 evolution runaway (1.2 lift
        // to 13.92) pins to the 3.0 ceiling in both the Bend kernel and the
        // host's own clamp.
        let native = clamp_fee_il(13.92);
        let bend_result = bend::clamp_fee_il("bend", 13.92);
        assert_eq!(bend_result, Some(native));
        assert_eq!(bend_result, Some(FEE_IL_MAX));
    }

    #[test]
    fn bend_clamp_matches_native_for_floor_and_passthrough() {
        if !bend_available() {
            eprintln!("skip: bend binary not on PATH");
            return;
        }
        for v in [0.0, 0.01, 0.3, 1.5, 3.0, 3.01] {
            assert_eq!(
                bend::clamp_fee_il("bend", v),
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
    /// (only the columns `fee_il_shadows` reads) in a real temp file — a
    /// `:memory:` DB would not work here, since `fee_il_shadows` opens its
    /// own read-only connection and each `:memory:` connection is isolated.
    fn make_shadow_test_db(path: &Path) {
        let conn = rusqlite::Connection::open(path).expect("open scratch db");
        conn.execute_batch(
            "CREATE TABLE positions (position_id TEXT, pool_address TEXT, timestamp INTEGER, closed_at INTEGER, position_pubkey TEXT, deposited_usd REAL, current_value_usd REAL, cumulative_fees_claimed_usd REAL, cumulative_rewards_claimed_usd REAL, active_bin_id INTEGER, lower_bin_id INTEGER, upper_bin_id INTEGER, last_rebalance_at INTEGER, oor_cycle_count INTEGER);
             CREATE TABLE pool_snapshots (pool_address TEXT, timestamp INTEGER, stats_source TEXT, active_bin_id INTEGER);
             CREATE TABLE signal_snapshots (pool_address TEXT, timestamp INTEGER, fee_il_ratio REAL);",
        )
        .expect("create scratch schema");
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
        let mut shadows = fee_il_shadows_capped(
            &path_str,
            config::MIN_YIELD_EXIT_AGE_DEFAULT_MS,
            None,
            10,
            12,
        );
        shadows.sort_by(|a, b| a.position_id.cmp(&b.position_id));
        let _ = std::fs::remove_file(&path);

        assert_eq!(shadows.len(), 2, "closed position must be excluded");

        let mature = &shadows[1]; // "pos-mature"
        assert_eq!(mature.position_id, "pos-mature");
        assert_eq!(mature.pool_address, "poolA");
        assert!(mature.mature, "14h old >= 12h default must be mature");
        assert!(mature.known, "latest stats_source is 'datapi'");
        assert_eq!(
            mature.ratio,
            Some(0.2),
            "must read the latest (not first) snapshot"
        );
        assert!(
            !mature.onchain,
            "NULL position_pubkey -> paper, not onchain"
        );

        let fresh = &shadows[0]; // "pos-fresh"
        assert_eq!(fresh.position_id, "pos-fresh");
        assert!(!fresh.mature, "1h old < 12h default must not be mature");
        assert!(!fresh.known, "no snapshot yet -> unknown");
        assert_eq!(fresh.ratio, None, "no snapshot yet -> no ratio");
        assert!(fresh.onchain, "non-NULL position_pubkey -> onchain");
        assert_eq!(
            mature.net_drift_bins,
            Some(-10.0),
            "drift = last(90) - first(100) active_bin_id"
        );
        assert_eq!(
            fresh.net_drift_bins, None,
            "no snapshots -> cold start, TS netDriftBins = 0"
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
        if bend_available() {
            let next = bend::evolve_thr("bend", 1.5, true, lift.abs(), 1.0, 0.2, 0.3, 3.0);
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
        if bend_available() {
            assert_eq!(bend::ta_exhausted("bend", true, true, true), Some(true));
            assert_eq!(bend::ta_exhausted("bend", true, true, false), Some(true));
            assert_eq!(bend::ta_exhausted("bend", true, false, true), Some(true));
            assert_eq!(bend::ta_exhausted("bend", true, false, false), Some(false));
            assert_eq!(bend::ta_exhausted("bend", false, true, true), Some(false));
            assert_eq!(bend::ta_exhausted("bend", false, false, false), Some(false));
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
        if bend_available() {
            assert_eq!(bend::exit_order("bend", true, true, true), Some(1));
            assert_eq!(bend::exit_order("bend", false, true, true), Some(2));
            assert_eq!(bend::exit_order("bend", false, false, true), Some(3));
            assert_eq!(bend::exit_order("bend", false, false, false), Some(0));
            assert_eq!(bend::exit_order("bend", true, false, false), Some(1));
        }
    }

    #[test]
    fn bend_wrappers_fail_closed_on_nonfinite() {
        // Every float-taking wrapper collapses to None on non-finite input
        // without spawning a probe: fee_exit (ratio), enter_blocked
        // (ratio/floor), capital_exit (confidence). Mirrors the TS guards
        // that never feed NaN/Infinity into a gate.
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
        if bend_available() {
            assert_eq!(bend::drift_rejects("bend", -9.0, -8.0), Some(true));
            assert_eq!(bend::drift_rejects("bend", -8.0, -8.0), Some(false));
            assert_eq!(bend::drift_rejects("bend", 5.0, -8.0), Some(false));
            assert_eq!(bend::fee_exit_fires("bend", true, true, 0.4), Some(true));
            assert_eq!(bend::fee_exit_fires("bend", true, true, 0.6), Some(false));
            assert_eq!(bend::fee_exit_fires("bend", true, true, 0.5), Some(false));
            assert_eq!(bend::fee_exit_fires("bend", true, true, 0.49), Some(true));
            assert_eq!(bend::fee_exit_fires("bend", false, true, 0.4), Some(false));
            assert_eq!(bend::fee_exit_fires("bend", true, false, 0.4), Some(false));
            assert_eq!(
                bend::enter_blocked("bend", true, true, 0.2, 1.2),
                Some(true)
            );
            assert_eq!(
                bend::enter_blocked("bend", false, true, 0.2, 1.2),
                Some(false)
            );
            assert_eq!(
                bend::enter_blocked("bend", true, false, 0.2, 1.2),
                Some(false)
            );
            assert_eq!(
                bend::enter_blocked("bend", true, true, 2.0, 1.2),
                Some(false)
            );
            assert_eq!(
                bend::enter_blocked("bend", true, true, 1.2, 1.2),
                Some(false)
            );
            assert_eq!(bend::capital_exit("bend", true, 1.0), Some(true));
            assert_eq!(bend::capital_exit("bend", false, 0.85), Some(false));
            assert_eq!(bend::fee_known("bend", true), Some(true));
            assert_eq!(bend::fee_known("bend", false), Some(false));
            assert_eq!(bend::accrual_allowed("bend", true, false, true), Some(true));
            assert_eq!(
                bend::accrual_allowed("bend", true, false, false),
                Some(false)
            );
            assert_eq!(bend::accrual_allowed("bend", true, true, true), Some(false));
            assert_eq!(
                bend::accrual_allowed("bend", false, false, true),
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
        // (extends bend_clamp_none_on_missing_binary to the full surface).
        let bogus = "definitely-not-a-real-binary";
        assert_eq!(bend::fee_known(bogus, true), None);
        assert_eq!(bend::fee_exit_fires(bogus, true, true, 0.4), None);
        assert_eq!(bend::enter_blocked(bogus, true, true, 0.4, 1.2), None);
        assert_eq!(bend::capital_exit(bogus, true, 1.0), None);
        assert_eq!(bend::ta_exhausted(bogus, true, true, false), None);
        assert_eq!(bend::exit_order(bogus, false, true, true), None);
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
            gas_aware_min_days: 3.0,
            oor_recovery_hold_threshold: 0.6,
            oor_recovery_force_threshold: 0.2,
            min_rebalance_interval_ms: 86_400_000,
            oor_grace_period_cycles: 3,
            paper_validation_min_days: 7.0,
            paper_validation_enforce: false,
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
    fn drift_shadow_honors_ring_cap() {
        // 4 snapshots: bins 100, 90, 80, 70 (oldest->newest). Uncapped drift
        // = 70-100 = -30; cap=2 sees only the 2 newest (70-80) = -10,
        let path =
            std::env::temp_dir().join(format!("prismd-drift-cap-test-{}.db", std::process::id()));
        let conn = rusqlite::Connection::open(&path).expect("open scratch db");
        conn.execute_batch(
            "CREATE TABLE positions (position_id TEXT, pool_address TEXT, timestamp INTEGER, closed_at INTEGER, position_pubkey TEXT, deposited_usd REAL, current_value_usd REAL, cumulative_fees_claimed_usd REAL, cumulative_rewards_claimed_usd REAL, active_bin_id INTEGER, lower_bin_id INTEGER, upper_bin_id INTEGER, last_rebalance_at INTEGER, oor_cycle_count INTEGER);
             CREATE TABLE pool_snapshots (pool_address TEXT, timestamp INTEGER, stats_source TEXT, active_bin_id INTEGER);
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
        for (i, bin) in [100, 90, 80, 70].into_iter().enumerate() {
            conn.execute(
                "INSERT INTO pool_snapshots (pool_address, timestamp, stats_source, active_bin_id) VALUES ('poolCap', ?1, 'datapi', ?2)",
                [now - 300 + i as i64, bin],
            )
            .unwrap();
        }
        drop(conn);
        let path_str = path.to_str().unwrap().to_string();
        let uncapped = fee_il_shadows_capped(&path_str, 0, None, 10, 12);
        assert_eq!(
            uncapped[0].net_drift_bins,
            Some(-30.0),
            "uncapped sees all 4"
        );
        let capped = fee_il_shadows_capped(&path_str, 0, Some(2), 10, 12);
        assert_eq!(
            capped[0].net_drift_bins,
            Some(-10.0),
            "cap=2 sees 2 newest only"
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
}
