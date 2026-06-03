#!/usr/bin/env bash
# One-liner installer for prism-liquidity-agent.
# Usage: curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
set -euo pipefail

REPO="${PRISM_REPO:-irfndi/prism-liquidity-agent}"
INSTALL_DIR="${PRISM_INSTALL_DIR:-$HOME/.prism}"
BIN_DIR="${PRISM_BIN_DIR:-$HOME/.local/bin}"

echo "→ Installing prism to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"

# Detect or install Bun
if ! command -v bun >/dev/null 2>&1; then
  echo "→ Bun not found; installing to $HOME/.bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Clone or update the source
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "→ Updating existing install"
  (cd "$INSTALL_DIR" && git pull --ff-only)
else
  echo "→ Cloning $REPO"
  git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

# Install dependencies and run postinstall setup
echo "→ Installing dependencies"
(cd "$INSTALL_DIR" && bun install --frozen-lockfile)

echo "→ Running postinstall setup"
(cd "$INSTALL_DIR" && bun run setup:env || true)

# Symlink the prism command
if [ -w "$BIN_DIR" ]; then
  ln -sf "$INSTALL_DIR/cli/index.ts" "$BIN_DIR/prism"
  echo "→ Linked $BIN_DIR/prism → $INSTALL_DIR/cli/index.ts"
else
  echo "→ $BIN_DIR is not writable; add $INSTALL_DIR/cli to your PATH manually"
fi

echo ""
echo "✓ Install complete."
echo "  - Source: $INSTALL_DIR"
echo "  - Run:    $BIN_DIR/prism --version"
echo ""
echo "Next steps:"
echo "  1. Add to PATH if needed:  export PATH=\"$BIN_DIR:\$PATH\""
echo "  2. Register an account:    prism register"
echo "  3. Configure:              prism setup"
echo "  4. Start trading:          prism dev"
