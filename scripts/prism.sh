#!/usr/bin/env bash
# Wrapper for the prism CLI — always runs from the package install root.
# Symlinking cli/index.ts would let prism setup / dev operate on the
# caller's CWD (path.resolve('.env') / no cwd override respectively).
# This is the value of package.json's "bin" entry.
set -euo pipefail

# Follow symlinks so the wrapper works via global bin symlinks too.
SOURCE="${BASH_SOURCE[0]}"
hops=0
while [ -L "$SOURCE" ] && [ $hops -lt 40 ]; do
  DIR=$(dirname -- "$SOURCE")
  SOURCE=$(readlink "$SOURCE")
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
  hops=$((hops + 1))
done
if [ $hops -ge 40 ]; then
  echo "ERROR: Too many symlink levels" >&2
  exit 1
fi
PACKAGE_ROOT=$(cd -- "$(dirname -- "$SOURCE")/.." && pwd)

# Preserve the caller's directory so the CLI can resolve relative paths (e.g.
# `prism wallet import ./kp.json`) against it after we cd into the package root.
export PRISM_CALLER_CWD="$PWD"

cd "$PACKAGE_ROOT"
export PRISM_INSTALL_DIR="$PACKAGE_ROOT"

# The Bun installer (bun.sh/install) puts bun under ~/.bun/bin but does not
# always persist it to a shell rc, so a fresh shell or systemd unit may not have
# it on PATH. Resolve PATH first, then the standard install location.
BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ] && [ -n "${HOME:-}" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi
if [ -z "$BUN_BIN" ]; then
  echo "ERROR: bun not found on PATH or at \$HOME/.bun/bin/bun" >&2
  echo "Install it with: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

# Enforce the declared engines.bun >= 1.4.0-canary.1 constraint so an old bun
# fails with an actionable message instead of a confusing runtime error.
MIN_BUN_VERSION="1.4.0-canary.1"
BUN_VERSION_RAW="$("$BUN_BIN" --version 2>/dev/null || true)"
if [ -z "$BUN_VERSION_RAW" ]; then
  echo "ERROR: could not determine bun version from '$BUN_BIN'" >&2
  exit 1
fi
# Portable dotted-version comparison (awk, no GNU sort -V on macOS).
# Prerelease-aware: X.Y.Z compares numerically; when equal, a version with a
# prerelease is lower than one without, and prerelease labels compare
# lexicographically (canary.1 >= canary.0).
if ! awk -v a="$BUN_VERSION_RAW" -v b="$MIN_BUN_VERSION" 'BEGIN {
  split(a, A, "."); split(b, B, ".");
  for (i = 1; i <= 3; i++) {
    na = (i in A) ? A[i] + 0 : 0;
    nb = (i in B) ? B[i] + 0 : 0;
    if (na < nb) exit 1;
    if (na > nb) exit 0;
  }
  pa = (index(a, "-") > 0) ? substr(a, index(a, "-") + 1) : "";
  pb = (index(b, "-") > 0) ? substr(b, index(b, "-") + 1) : "";
  if (pa == "" && pb != "") exit 0;
  if (pa != "" && pb == "") exit 1;
  if (pa < pb) exit 1;
  if (pa > pb) exit 0;
  exit 0;
}'; then
  echo "ERROR: bun $BUN_VERSION_RAW is too old; prism requires bun >= $MIN_BUN_VERSION" >&2
  echo "Upgrade it with: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

exec "$BUN_BIN" "$PACKAGE_ROOT/cli/index.ts" ${1+"$@"}

