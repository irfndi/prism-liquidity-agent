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

cd "$PACKAGE_ROOT"
export PRISM_INSTALL_DIR="$PACKAGE_ROOT"

# The Bun installer (bun.sh/install) puts bun under ~/.bun/bin but does not
# always persist it to a shell rc, so a fresh shell or systemd unit may not have
# it on PATH. Resolve PATH first, then the standard install location.
BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi
if [ -z "$BUN_BIN" ]; then
  echo "ERROR: bun not found on PATH or at \$HOME/.bun/bin/bun" >&2
  echo "Install it with: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
exec "$BUN_BIN" "$PACKAGE_ROOT/cli/index.ts" "$@"

