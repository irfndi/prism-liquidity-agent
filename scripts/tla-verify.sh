#!/usr/bin/env bash
# TLA+ verification: the ledger/halt model, and the negative control proving
# the model still detects the rent regression it was written for.
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

echo "== TLA+ buggy ledger model (must fail) =="
set +e
(cd "$TLA_DIR" && "${TLC[@]}" -config LedgerBuggy.cfg Ledger.tla > "$WORK/tlc-buggy.log" 2>&1)
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "FAIL: the buggy ledger model passed — the model cannot detect the regression it was written for"
  exit 1
fi
if ! grep -q "Invariant LedgerMatchesTruePnl is violated" "$WORK/tlc-buggy.log"; then
  echo "FAIL: the buggy ledger model failed for the wrong reason (exit $rc)"
  tail -n 30 "$WORK/tlc-buggy.log"
  exit 1
fi
echo "ok: buggy ledger violates LedgerMatchesTruePnl (the 2026-11 incident, model-checked)"

echo "== TLA+ policy model (must pass) =="
(cd "$TLA_DIR" && "${TLC[@]}" -config PolicyFixed.cfg Policy.tla > "$WORK/policy-fixed.log" 2>&1) || {
  echo "FAIL: policy model violated an invariant"
  tail -n 30 "$WORK/policy-fixed.log"
  exit 1
}
echo "ok: PolicyFixed holds safety precedence, no positive-carry exit, rotation gating"

echo "== TLA+ buggy policy model (must fail) =="
set +e
(cd "$TLA_DIR" && "${TLC[@]}" -config PolicyBuggy.cfg Policy.tla > "$WORK/policy-buggy.log" 2>&1)
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  echo "FAIL: the buggy policy model passed — hold-bias regression is not detected"
  exit 1
fi
if ! grep -q "Invariant NoEconomicExitOnPositiveCarry is violated" "$WORK/policy-buggy.log"; then
  echo "FAIL: the buggy policy model failed for the wrong reason (exit $rc)"
  tail -n 30 "$WORK/policy-buggy.log"
  exit 1
fi
echo "ok: buggy policy exits a positive-carry position (the 2026-11 hold-bias defect)"
