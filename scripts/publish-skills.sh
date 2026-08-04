#!/usr/bin/env bash
# Publish Prism skills to npm and PyPI registries.
# Usage: ./scripts/publish-skills.sh [--dry-run]

set -euo pipefail

# Reject any invocation with more than one positional argument so an extra
# argument can never silently switch the run from dry-run to real publishing.
if [ "$#" -gt 1 ]; then
  echo "ERROR: unexpected extra arguments" >&2
  echo "Usage: ./scripts/publish-skills.sh [--dry-run]" >&2
  exit 2
fi

# Validate the single positional argument: only an empty value or --dry-run is
# accepted. Anything else is a usage error — a typo must never silently switch
# the run from dry-run to real publishing.
case "${1:-}" in
  "" | "--dry-run") DRY_RUN="${1:-}" ;;
  *)
    echo "ERROR: unknown argument '$1' (expected nothing or --dry-run)" >&2
    echo "Usage: ./scripts/publish-skills.sh [--dry-run]" >&2
    exit 2
    ;;
esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}→${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_error() { echo -e "${RED}✘${NC} $1"; }

dry_run_prefix() {
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "[DRY-RUN] "
  else
    echo ""
  fi
}

# ---------------------------------------------------------------------------
# Publish MCP server to npm
# ---------------------------------------------------------------------------

publish_mcp() {
  log_info "Publishing MCP server to npm..."
  cd "$REPO_ROOT/mcp-server"

  if [ ! -f "dist/index.js" ]; then
    log_warn "MCP server not built. Running npm run build..."
    if [ "$DRY_RUN" != "--dry-run" ]; then
      npm run build
    fi
  fi

  if [ "$DRY_RUN" = "--dry-run" ]; then
    log_info "$(dry_run_prefix)npm publish --access public"
  else
    npm publish --access public
  fi

  log_info "MCP server published."
}

# ---------------------------------------------------------------------------
# Publish Python packages to PyPI
# ---------------------------------------------------------------------------

publish_python_pkg() {
  local pkg_dir="$1"
  local pkg_name="$2"

  log_info "Publishing $pkg_name to PyPI..."
  cd "$pkg_dir"

  if [ ! -d "dist" ] || [ -z "$(ls -A dist 2>/dev/null)" ]; then
    log_warn "$pkg_name not built. Running python3 -m build..."
    if [ "$DRY_RUN" != "--dry-run" ]; then
      python3 -m build
    fi
  fi

  # Fail fast on an empty dist instead of passing a literal glob to twine.
  shopt -s nullglob
  local dist_files=(dist/*)
  shopt -u nullglob
  if [ "${#dist_files[@]}" -eq 0 ]; then
    log_error "$pkg_name dist is empty after build; aborting."
    exit 1
  fi

  if [ "$DRY_RUN" = "--dry-run" ]; then
    log_info "$(dry_run_prefix)python3 -m twine upload ${dist_files[*]}"
  else
    python3 -m twine upload "${dist_files[@]}"
  fi

  log_info "$pkg_name published."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  echo "Prism Skills Publisher"
  echo "======================"
  echo ""

  if [ "$DRY_RUN" = "--dry-run" ]; then
    log_warn "Running in DRY-RUN mode. No actual publishing will occur."
    echo ""
  fi

  # Check prerequisites
  if ! command -v npm &>/dev/null; then
    log_error "npm is required but not installed."
    exit 1
  fi

  if ! command -v python3 &>/dev/null; then
    log_error "python3 is required but not installed."
    exit 1
  fi

  # Preflight the Python build/publish toolchain before any publish runs so a
  # mid-run failure does not leave a partial release.
  if ! python3 -m build --version &>/dev/null; then
    log_error "python3 -m build is required but not available (pip install build)."
    exit 1
  fi
  if ! python3 -m twine --version &>/dev/null; then
    log_error "python3 -m twine is required but not available (pip install twine)."
    exit 1
  fi

  # Publish MCP server
  publish_mcp
  echo ""

  # Publish LangChain tool
  publish_python_pkg "$REPO_ROOT/packages/langchain-prism" "langchain-prism"
  echo ""

  # Publish AutoGPT plugin
  publish_python_pkg "$REPO_ROOT/packages/autogpt-prism" "autogpt-prism"
  echo ""

  cd "$REPO_ROOT"

  log_info "All packages published successfully!"
  echo ""
  echo "Next steps:"
  echo "  1. Verify packages on npmjs.com and pypi.org"
  echo "  2. Update marketplaces/README.md with published versions"
  echo "  3. Tag release: git tag -a v$(node -p 'require("./package.json").version') -m \"Release v$(node -p 'require("./package.json").version')\""
}

main "$@"
