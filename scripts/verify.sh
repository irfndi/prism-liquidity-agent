#!/usr/bin/env bash
# The verification gate. Anything that claims to work must pass ALL of it:
#
#   1. typecheck + lint + format   — the code is well-formed
#   2. unit/property tests         — the accounting identities hold
#   3. Bend proofs                 — the PnL/strategy laws are proved, not sampled
#   4. TLA+ (fixed models)         — ledger + TA-exhaustion invariants/liveness hold
#   5. TLA+ (buggy models)         — MUST fail, proving each model detects its regression
#
# Step 5 is the negative control. A verification suite that cannot fail is
# decoration; it is checked on every run, by construction.
set -euo pipefail
cd "$(dirname "$0")/.."

BEND="${BEND_BIN:-$HOME/.bend/bin/bend}"
echo "== 1/5 typecheck + lint =="
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

echo "== 4-5/5 TLA+ models =="
bash scripts/tla-verify.sh

echo
echo "VERIFIED: all five gates passed."
