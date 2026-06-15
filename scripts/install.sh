#!/usr/bin/env bash
# One-liner installer for prism-liquidity-agent.
# Usage: curl -fsSL https://raw.githubusercontent.com/irfndi/prism-liquidity-agent/main/scripts/install.sh | bash
# Or with a pinned release tarball (faster, no git history):
#   PRISM_TARBALL_URL=<url> curl -fsSL .../install.sh | bash
set -euo pipefail

# Minimum Bun version required by bun.lock v2.
MIN_BUN_VERSION="${PRISM_MIN_BUN_VERSION:-1.4.0}"

REPO="${PRISM_REPO:-irfndi/prism-liquidity-agent}"
HOME="${HOME:-/tmp}"
SHELL_NAME="${SHELL##*/}"
SHELL_NAME="${SHELL_NAME:-sh}"
INSTALL_DIR="${PRISM_INSTALL_DIR:-$HOME/.prism}"
BIN_DIR="${PRISM_BIN_DIR:-$HOME/.local/bin}"
TARBALL_URL="${PRISM_TARBALL_URL:-}"

# Defensive env reads: every ${PRISM_*} / user-supplied var must use
# ${VAR:-} so `set -u` does not abort the one-liner on a clean shell
# (issue #1 — previously crashed on unset PRISM_SKIP_AUTO_TARBALL).
PRISM_SKIP_AUTO_TARBALL="${PRISM_SKIP_AUTO_TARBALL:-}"
STASH_COUNT=""
IS_OPTED_OUT=0
case "$(printf '%s' "${PRISM_FEEDBACK_OPT_OUT:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) IS_OPTED_OUT=1 ;;
esac

log_step()  { printf "→ %s\n" "$*"; }
log_warn()  { printf "⚠ %s\n" "$*"; }
log_error() { printf "✘ %s\n" "$*" >&2; }
log_done()  { printf "✓ %s\n" "$*"; }

# Print a version string in a form that can be compared with -ge / sort -V.
# Strips any pre-release suffix (e.g. "1.4.0-rc.1" -> "1.4.0") and pads to
# three numeric components.
normalize_version() {
  printf '%s' "$1" \
    | sed -E 's/^v//; s/-[A-Za-z0-9.+].*$//' \
    | awk -F. '{ printf("%d.%d.%d\n", $1+0, ($2 ? $2 : 0)+0, ($3 ? $3 : 0)+0) }'
}

version_gte() {
  # version_gte <installed> <minimum>; returns 0 if installed >= minimum.
  local installed min
  installed="$(normalize_version "$1")"
  min="$(normalize_version "$2")"
  [ "$(printf '%s\n%s\n' "$installed" "$min" | sort -V | head -n1)" = "$min" ]
}

# ensure_bun: install Bun if missing, verify version, expose to subshells.
# Returns 0 on success, non-zero on failure. On any failure, prints an
# actionable error message — never silently aborts.
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  else
    log_step "Bun not found; installing to \$HOME/.bun"
    if ! curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1; then
      log_error "Failed to install Bun from bun.sh. Install it manually:"
      log_error "  curl -fsSL https://bun.sh/install | bash"
      return 1
    fi
    # The official installer writes to $HOME/.bun/bin. Refresh PATH/BUN_INSTALL
    # in the current shell so subsequent commands in this script can find
    # `bun` (issue #2 — exported PATH must propagate to subshells below).
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    if ! command -v bun >/dev/null 2>&1; then
      log_error "Bun installer completed but 'bun' is still not on PATH."
      log_error "Check that \$HOME/.bun/bin is writable and try:"
      log_error "  export BUN_INSTALL=\"\$HOME/.bun\""
      log_error "  export PATH=\"\$BUN_INSTALL/bin:\$PATH\""
      return 1
    fi
    BUN_BIN="$(command -v bun)"
  fi

  local current
  current="$("$BUN_BIN" --version 2>/dev/null || echo "unknown")"
  if ! version_gte "$current" "$MIN_BUN_VERSION"; then
    log_error "Bun $current is installed but >= $MIN_BUN_VERSION is required."
    log_error "The bun.lock file uses lockfileVersion: 2, which older Bun"
    log_error "versions cannot parse. Upgrade with:"
    log_error "  curl -fsSL https://bun.sh/install | bash"
    return 1
  fi
  log_step "Bun $current (>= $MIN_BUN_VERSION) at $BUN_BIN"
  return 0
}

# Auto-detect latest release tarball from GitHub if not explicitly provided.
# Reads PRISM_SKIP_AUTO_TARBALL defensively under set -u.
if [ -z "$TARBALL_URL" ] && [ -z "$PRISM_SKIP_AUTO_TARBALL" ]; then
  log_step "Detecting latest release..."
  LATEST_TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | grep '"tag_name":' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || true)
  if [ -n "${LATEST_TAG:-}" ]; then
    TARBALL_URL="https://github.com/$REPO/releases/download/$LATEST_TAG/prism-$LATEST_TAG.tar.gz"
    log_step "Latest release: $LATEST_TAG"
  fi
fi

log_step "Installing prism to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"

# Detect or install Bun (issue #2 + #3 — version check is now mandatory).
if ! ensure_bun; then
  log_error "Bun is required to install prism. Aborting."
  exit 1
fi

if [ -n "$TARBALL_URL" ]; then
  log_step "Downloading tarball: $TARBALL_URL"
  TMP_TARBALL="$(mktemp -t prism-install-XXXXXX.tar.gz)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$TARBALL_URL" -o "$TMP_TARBALL"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$TARBALL_URL" -O "$TMP_TARBALL"
  else
    log_error "Neither curl nor wget found; install one and retry"
    exit 1
  fi
  log_step "Extracting to $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -xzf "$TMP_TARBALL" -C "$INSTALL_DIR"
  rm -f "$TMP_TARBALL"
  # Marker so 'prism update' / 'prism --version' can detect a non-git install.
  touch "$INSTALL_DIR/.tarball-install"
elif [ -d "$INSTALL_DIR/.git" ]; then
  log_step "Updating existing install"
  # Resolve the default branch once; the symbolic ref can shift between
  # invocations and we want a single consistent value.
  DEFAULT_BRANCH=$(git -C "$INSTALL_DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|origin/||' || echo main)
  # Local modifications abort a plain --ff-only. Try a non-destructive path
  # first, then fall back to a hard reset against origin/<default-branch>.
  if (cd "$INSTALL_DIR" && git pull --ff-only 2>/dev/null); then
    :
  else
    log_warn "Local changes blocked fast-forward; stashing and retrying"
    if (cd "$INSTALL_DIR" && git stash && git pull --ff-only && git stash pop); then
      :
    else
      # Count stash entries before the reset so we can warn if any were
      # orphaned by a partial stash/pull/pop chain.
      STASH_COUNT=$(cd "$INSTALL_DIR" && git stash list 2>/dev/null | wc -l | tr -d ' ')
      log_step "Update failed; resetting to origin/${DEFAULT_BRANCH}"
      (cd "$INSTALL_DIR" && git fetch origin && git reset --hard "origin/${DEFAULT_BRANCH}")
      if [ "${STASH_COUNT:-0}" -gt 0 ]; then
        log_step "${STASH_COUNT} stash entry/entries preserved (use 'git stash list' to inspect)"
      fi
    fi
  fi
elif [ -d "$INSTALL_DIR" ]; then
  # Exists but not a git repo (e.g. partial previous install). Nuke and reclone.
  log_step "$INSTALL_DIR exists but is not a git repo; re-cloning"
  rm -rf "$INSTALL_DIR"
  git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
else
  log_step "Cloning $REPO"
  git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

# No --frozen-lockfile: an older Bun may fail to parse the current bun.lock
# and abort the install before dependencies land. ensure_bun() above already
# rejected Bun < $MIN_BUN_VERSION, so this is safe on supported Bun.
log_step "Installing dependencies"
(cd "$INSTALL_DIR" && bun install)

log_step "Running postinstall setup"
(cd "$INSTALL_DIR" && bun run setup:env || true)

# Write a wrapper script (not a symlink) so `prism` always runs from
# $INSTALL_DIR. Symlinking cli/index.ts directly would let prism setup
# write .env to the caller's cwd (it uses path.resolve('.env')) and let
# prism dev run `bun run dev` in the wrong directory.
WRAPPER="$BIN_DIR/prism"
if [ -w "$BIN_DIR" ]; then
  # Use a plain `cd` rather than `env -C` for portability (env -C is a
  # non-standard extension, not present on every POSIX env).
  cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
# Auto-generated by scripts/install.sh — always runs from the install root.
cd "$INSTALL_DIR" || exit 1
exec bun "$INSTALL_DIR/cli/index.ts" "\$@"
EOF
  chmod +x "$WRAPPER"
  log_step "Wrote wrapper $BIN_DIR/prism (always runs in $INSTALL_DIR)"
else
  log_warn "$BIN_DIR is not writable; add $INSTALL_DIR/cli to your PATH manually"
fi

# Issue #4: PATH reminder. Detect whether the wrapper directory is on
# PATH in the current shell. If not, print a concrete one-liner the
# user can copy-paste. We test the literal BIN_DIR path so the hint
# matches the actual install.
PATH_HAS_BIN_DIR=0
IFS=':' read -r -a _path_entries <<<"${PATH:-}"
for _entry in "${_path_entries[@]}"; do
  if [ "$_entry" = "$BIN_DIR" ]; then
    PATH_HAS_BIN_DIR=1
    break
  fi
done

echo ""
log_done "Install complete."
if [ -n "$TARBALL_URL" ]; then
  echo "  - Source:   $INSTALL_DIR (tarball install — upgrade via 'prism update')"
else
  echo "  - Source:   $INSTALL_DIR (git install — upgrade via 'prism update' or rerun this script)"
fi
echo "  - Run:      $BIN_DIR/prism --version"
echo ""
echo "Next steps:"
if [ "${BUN_INSTALLED_BUN_SH:-0}" -eq 1 ]; then
  echo "  1. Add to PATH (new shell):  export PATH=\"\$HOME/.bun/bin:$BIN_DIR:\$PATH\""
else
  echo "  1. Add to PATH if needed:    export PATH=\"$BIN_DIR:\$PATH\""
fi
echo "  2. Register an account:      prism register"
echo "  3. Configure:                prism setup --non-interactive --helius-key=your-helius-key"
echo "  4. Start trading:            prism dev"

if [ "$PATH_HAS_BIN_DIR" -eq 0 ]; then
  echo ""
  log_warn "$BIN_DIR is not on your current PATH."
  log_warn "Run this in a new shell, or persist it in your shell rc:"
  echo "    echo 'export PATH=\"\$PATH:$BIN_DIR\"' >> \"\$HOME/.$SHELL_NAMERC\""
  echo "    export PATH=\"\$PATH:$BIN_DIR\""
fi

# Issue #5: end-of-install verification. Run the two version checks the
# user actually cares about and surface a friendly error on non-zero.
echo ""
log_step "Verifying installation..."
VERIFY_FAILED=0
if ! bun --version; then
  log_error "bun --version failed. PATH may not be set for new shells."
  log_error "Try:  export PATH=\"\$HOME/.bun/bin:\$PATH\""
  VERIFY_FAILED=1
fi
if [ -x "$WRAPPER" ]; then
  if ! "$WRAPPER" --version; then
    log_error "$WRAPPER --version failed. The wrapper exists but prism did not respond."
    log_error "Try invoking directly:  bun $INSTALL_DIR/cli/index.ts --version"
    VERIFY_FAILED=1
  fi
else
  log_warn "Wrapper $WRAPPER is not executable; skipping 'prism --version' check."
fi
if [ "$VERIFY_FAILED" -ne 0 ]; then
  log_error "Install completed but verification failed. See messages above."
  exit 1
fi
log_done "Verification passed."

# Anonymous install telemetry (opt-out via PRISM_FEEDBACK_OPT_OUT).
INSTALL_ID_FILE="$HOME/.config/prism/install-id"
mkdir -p "$(dirname "$INSTALL_ID_FILE")"
if [ ! -s "$INSTALL_ID_FILE" ]; then
  INSTALL_ID="$(bun -e 'console.log(crypto.randomUUID())' 2>/dev/null || echo "")"
  if [ -z "$INSTALL_ID" ]; then
    UUID_HEX="$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \n')"
    if [ "${#UUID_HEX}" -eq 32 ]; then
      INSTALL_ID="${UUID_HEX:0:8}-${UUID_HEX:8:4}-${UUID_HEX:12:4}-${UUID_HEX:16:4}-${UUID_HEX:20:12}"
    fi
  fi
  if [ -n "$INSTALL_ID" ]; then
    echo "$INSTALL_ID" > "$INSTALL_ID_FILE"
    chmod 600 "$INSTALL_ID_FILE" 2>/dev/null || true
  fi
fi
INSTALL_ID="$(cat "$INSTALL_ID_FILE" 2>/dev/null || echo "")"
if [ -n "$INSTALL_ID" ] && [ "$IS_OPTED_OUT" -eq 0 ]; then
  PRISM_VERSION="$(bun -e "console.log(require('$INSTALL_DIR/package.json').version)" 2>/dev/null || echo "")"
  PRISM_PLATFORM="$(uname -s | tr A-Z a-z)"
  PRISM_PAYLOAD="{\"installId\":\"$INSTALL_ID\",\"event\":\"install\",\"channel\":\"stable\",\"platform\":\"$PRISM_PLATFORM\""
  if [ -n "$PRISM_VERSION" ]; then
    PRISM_PAYLOAD="$PRISM_PAYLOAD,\"version\":\"$PRISM_VERSION\""
  fi
  PRISM_PAYLOAD="$PRISM_PAYLOAD}"
  curl -fsS --max-time 5 -X POST "${PRISM_API_URL:-https://prism-api.irfndi.workers.dev}/v1/installs/ping" \
    -H "Content-Type: application/json" \
    -d "$PRISM_PAYLOAD" >/dev/null 2>&1 &
fi
