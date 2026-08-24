import sqlite3
db = sqlite3.connect("/root/.local/share/prism/prism.db")

# 1. Ledger integrity: realized PnL should equal (value + fees + rewards - deposits)
#    summed across ALL closed rows (open rows excluded; their PnL is unrealized).
print("=== LEDGER INTEGRITY ===")
row = db.execute("""
SELECT
  COUNT(*) n,
  ROUND(SUM(realized_pnl_usd),2) sum_realized,
  ROUND(SUM(COALESCE(current_value_usd,0) + cumulative_fees_claimed_usd + cumulative_rewards_claimed_usd - COALESCE(deposited_usd,0)),2) sum_implied,
  SUM(CASE WHEN realized_pnl_usd IS NULL THEN 1 ELSE 0 END) null_pnl,
  SUM(CASE WHEN deposited_usd IS NULL OR deposited_usd<=0 THEN 1 ELSE 0 END) bad_deposit,
  ROUND(AVG(COALESCE(deposited_usd,0)),2) avg_dep,
  ROUND(MIN(COALESCE(deposited_usd,0)),2) min_dep,
  ROUND(MAX(COALESCE(deposited_usd,0)),2) max_dep
FROM positions WHERE closed_at IS NOT NULL
""").fetchone()
print(f"closed={row[0]} realized={row[1]} implied={row[2]} nullPnl={row[3]} badDep={row[4]} avgDep={row[5]} minDep={row[6]} maxDep={row[7]}")

# 2. NULL-realized closes: money went somewhere but wasn't booked.
print("\n=== NULL-REALIZED CLOSES ===")
for r in db.execute("""
SELECT date(closed_at/1000,'unixepoch','+7 hours') d, COUNT(*) n, ROUND(SUM(COALESCE(current_value_usd,0)),2) marks, ROUND(SUM(COALESCE(deposited_usd,0)),2) deps
FROM positions WHERE closed_at IS NOT NULL AND realized_pnl_usd IS NULL GROUP BY d ORDER BY d DESC LIMIT 6
"""):
    print(f"  {r[0]}: n={r[1]} marks=${r[2]} deposits=${r[3]}")

# 3. Fee accounting sanity: total fees claimed vs fee events.
print("\n=== FEE EVENTS ===")
row = db.execute("""
SELECT COUNT(*), ROUND(SUM(fees_usd),2), SUM(CASE WHEN fees_usd IS NULL THEN 1 ELSE 0 END)
FROM position_events WHERE event='CLAIM'
""").fetchone()
print(f"claim events={row[0]} feesUsd={row[1]} nullFeeEvents={row[2]}")

# 4. Deposit-size distribution — are entries actually $20-30?
print("\n=== DEPOSIT DISTRIBUTION (closed) ===")
for r in db.execute("""
SELECT CASE WHEN deposited_usd>=50 THEN '50+' WHEN deposited_usd>=30 THEN '30-49'
            WHEN deposited_usd>=15 THEN '15-29' WHEN deposited_usd>=5 THEN '5-14'
            ELSE '<5' END band, COUNT(*) n, ROUND(SUM(realized_pnl_usd),2) net
FROM positions WHERE closed_at IS NOT NULL GROUP BY band ORDER BY net
"""):
    print(f"  {r[0]:>6}: n={r[1]} net=${r[2]}")

# 5. Win/loss asymmetry all-time vs recent.
print("\n=== EXPECTANCY WINDOWS ===")
for label, cond in [("all-time", "1=1"), ("since Aug-8", "closed_at >= (strftime('%s','2026-08-08')*1000)")]:
    row = db.execute(f"""
    SELECT COUNT(*),
      SUM(CASE WHEN realized_pnl_usd>0 THEN 1 ELSE 0 END),
      ROUND(AVG(CASE WHEN realized_pnl_usd>0 THEN realized_pnl_usd END),3),
      ROUND(AVG(CASE WHEN realized_pnl_usd<=0 THEN realized_pnl_usd END),3),
      ROUND(SUM(realized_pnl_usd),2)
    FROM positions WHERE closed_at IS NOT NULL AND realized_pnl_usd IS NOT NULL AND {cond}
    """).fetchone()
    if row[0]:
        print(f"  {label}: n={row[0]} win%={100.0*row[1]/row[0]:.1f} avgWin=${row[2]} avgLoss=${row[3]} net=${row[4]}")
