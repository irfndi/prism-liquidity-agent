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
BUN_INSTALLED=0
if ! command -v bun >/dev/null 2>&1; then
  echo "→ Bun not found; installing to $HOME/.bun"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  BUN_INSTALLED=1
fi

# Clone or update the source
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "→ Updating existing install"
  # Local modifications abort a plain --ff-only. Try a non-destructive path
  # first, then fall back to a hard reset against origin/<default-branch>.
  if ! (cd "$INSTALL_DIR" && git pull --ff-only 2>/dev/null); then
    echo "⚠ Local changes blocked fast-forward; stashing and retrying"
    if (cd "$INSTALL_DIR" && git stash && git pull --ff-only && git stash pop); then
      :
    else
      echo "→ Stash failed; resetting to origin/$(git -C "$INSTALL_DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|origin/||' || echo main)"
      (cd "$INSTALL_DIR" && git fetch origin && git reset --hard "origin/$(git -C "$INSTALL_DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|origin/||' || echo main)")
    fi
  fi
elif [ -d "$INSTALL_DIR" ]; then
  # Exists but not a git repo (e.g. partial previous install). Nuke and reclone.
  echo "→ $INSTALL_DIR exists but is not a git repo; re-cloning"
  rm -rf "$INSTALL_DIR"
  git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
else
  echo "→ Cloning $REPO"
  git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

# No --frozen-lockfile: an older Bun may fail to parse the current bun.lock
# and abort the install before dependencies land.
echo "→ Installing dependencies"
(cd "$INSTALL_DIR" && bun install)

echo "→ Running postinstall setup"
(cd "$INSTALL_DIR" && bun run setup:env || true)

# Symlink the prism command
if [ -w "$BIN_DIR" ]; then
  # git does not always preserve the executable bit
  chmod +x "$INSTALL_DIR/cli/index.ts"
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
if [ "$BUN_INSTALLED" -eq 1 ]; then
  echo "  1. Add to PATH (new shell):  export PATH=\"\$HOME/.bun/bin:$BIN_DIR:\$PATH\""
else
  echo "  1. Add to PATH if needed:    export PATH=\"$BIN_DIR:\$PATH\""
fi
echo "  2. Register an account:      prism register"
echo "  3. Configure:                prism setup --non-interactive --helius-key=your-helius-key"
echo "  4. Start trading:            prism dev"
