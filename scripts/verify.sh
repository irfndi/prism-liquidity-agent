#!/usr/bin/env bash
# The verification gate. Anything that claims to work must pass ALL of it:
#
#   1. typecheck + lint + format   — the code is well-formed
#   2. unit/property tests         — the accounting identities hold
#   3. Bend proofs                 — the PnL/strategy laws are proved, not sampled
#   4. TLA+ (fixed model)          — every invariant holds and the halt arms
#   5. TLA+ (buggy model)          — MUST fail, proving the model detects the
#                                    regression it was written for
#
# Step 5 is the negative control. A verification suite that cannot fail is
# decoration; it is checked on every run, by construction.
set -euo pipefail
cd "$(dirname "$0")/.."

BEND="${BEND_BIN:-$HOME/.bend/bin/bend}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TLA_JAR="$ROOT/native/tla/tla2tools.jar"
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar"
TLC=(java -XX:+UseParallelGC -cp "$TLA_JAR" tlc2.TLC -workers auto)

if [ ! -f "$TLA_JAR" ]; then
  echo "== fetching TLC ($TLA_URL) =="
  curl -fsSL -o "$TLA_JAR" "$TLA_URL"
fi

echo "== 1/5 typecheck =="
bunx tsc --noEmit

echo "== 1/5 lint =="
bun run lint

echo "== 1/5 format =="
bun run format:check

echo "== 2/5 tests =="
bun run test

echo "== 3/5 Bend proofs =="
if [ ! -x "$BEND" ]; then
  echo "FAIL: bend not found at $BEND (install: curl -fsSL https://bend-lang.com/install.sh | sh)"
  exit 1
fi
(cd native/bend && "$BEND" PROOF.bend)

echo "== 4/5 TLA+ fixed model (must pass) =="
(cd native/tla && "${TLC[@]}" -config LedgerFixed.cfg Ledger.tla > /tmp/tlc-fixed.log 2>&1) || {
  echo "FAIL: fixed model violated an invariant"
  tail -n 30 /tmp/tlc-fixed.log
  exit 1
}
echo "ok: LedgerFixed holds every invariant and the halt arms"

echo "== 5/5 TLA+ buggy model (must fail) =="
set +e
(cd native/tla && "${TLC[@]}" -config LedgerBuggy.cfg Ledger.tla > /tmp/tlc-buggy.log 2>&1)
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "FAIL: the buggy model passed — the model cannot detect the regression it was written for"
  exit 1
fi
if ! grep -q "Invariant LedgerMatchesTruePnl is violated" /tmp/tlc-buggy.log; then
  echo "FAIL: the buggy model failed for the wrong reason (exit $rc)"
  tail -n 30 /tmp/tlc-buggy.log
  exit 1
fi
echo "ok: buggy model violates LedgerMatchesTruePnl (the 2026-11 incident, model-checked)"

echo
echo "VERIFIED: all five gates passed."
