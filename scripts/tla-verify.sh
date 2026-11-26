#!/usr/bin/env bash
# TLA+ verification: the ledger/halt model and the TA-exhaustion gate model,
# plus the negative controls proving each model still detects the regression it
# was written for.
#
# Standalone (`bun run verify:tla`) and called by scripts/verify.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
TLA_DIR="$ROOT/native/tla"
TLA_JAR="$TLA_DIR/tla2tools.jar"
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar"
# Pinned digest: TLC runs as you, so a substituted jar is arbitrary code.
# Re-pin deliberately when bumping the version.
TLA_SHA256="67f9575c3b9ef7a0787b1bded34812862ffe79d711298e5a75b1a77720b19928"
TLC=(java -XX:+UseParallelGC -cp "$TLA_JAR" tlc2.TLC -workers auto)

# Private scratch dir: predictable /tmp paths let a local user plant a symlink
# that a more-privileged verifier would follow and truncate.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ ! -f "$TLA_JAR" ]; then
  echo "== fetching TLC ($TLA_URL) =="
  curl -fsSL -o "$TLA_JAR" "$TLA_URL"
fi
actual="$(shasum -a 256 "$TLA_JAR" | awk '{print $1}')"
if [ "$actual" != "$TLA_SHA256" ]; then
  echo "FAIL: $TLA_JAR digest mismatch (expected $TLA_SHA256, got $actual)"
  exit 1
fi

echo "== TLA+ fixed model (must pass) =="
(cd "$TLA_DIR" && "${TLC[@]}" -config LedgerFixed.cfg Ledger.tla > "$WORK/tlc-fixed.log" 2>&1) || {
  echo "FAIL: fixed model violated an invariant"
  tail -n 30 "$WORK/tlc-fixed.log"
  exit 1
}
echo "ok: LedgerFixed holds every invariant and the halt arms"

echo "== TLA+ buggy model (must fail) =="
set +e
(cd "$TLA_DIR" && "${TLC[@]}" -config LedgerBuggy.cfg Ledger.tla > "$WORK/tlc-buggy.log" 2>&1)
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "FAIL: the buggy model passed — the model cannot detect the regression it was written for"
  exit 1
fi
if ! grep -q "Invariant LedgerMatchesTruePnl is violated" "$WORK/tlc-buggy.log"; then
  echo "FAIL: the buggy model failed for the wrong reason (exit $rc)"
  tail -n 30 "$WORK/tlc-buggy.log"
  exit 1
fi
echo "ok: buggy model violates LedgerMatchesTruePnl (the 2026-11 incident, model-checked)"

# ── TA-exhaustion gate (#237) ───────────────────────────────────────────────
run_ta_pass() {
  local cfg="$1"
  local label="$2"
  local log="$WORK/tlc-ta-${cfg%.cfg}.log"
  echo "== TLA+ TA-exhaustion ${label} (must pass) =="
  if ! (cd "$TLA_DIR" && "${TLC[@]}" -config "$cfg" TaExhaustion.tla > "$log" 2>&1); then
    echo "FAIL: TA-exhaustion ${label} violated an invariant or liveness property"
    tail -n 30 "$log"
    exit 1
  fi
  echo "ok: TA-exhaustion ${label} holds"
}

run_ta_pass TaExhaustionFixed.cfg "fixed losing gate"
run_ta_pass TaExhaustionWin.cfg "profitable liveness"
run_ta_pass TaExhaustionToxic.cfg "measured fee/IL alternative"

echo "== TLA+ TA-exhaustion buggy model (must fail) =="
set +e
(cd "$TLA_DIR" && "${TLC[@]}" -config TaExhaustionBuggy.cfg TaExhaustion.tla > "$WORK/tlc-ta-buggy.log" 2>&1)
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "FAIL: the buggy TA-exhaustion model passed — the model cannot detect the #237 regression"
  exit 1
fi
if ! grep -q "Invariant NoLossTaClose is violated" "$WORK/tlc-ta-buggy.log"; then
  echo "FAIL: the buggy TA-exhaustion model failed for the wrong reason (exit $rc)"
  tail -n 30 "$WORK/tlc-ta-buggy.log"
  exit 1
fi
echo "ok: buggy TA-exhaustion model violates NoLossTaClose (the #237 regression, model-checked)"
