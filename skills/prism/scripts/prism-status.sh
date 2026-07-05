#!/usr/bin/env bash
set -euo pipefail

# Helper script for the Prism skill.
# Returns a JSON summary of current status, positions, and recent decisions.

if ! command -v prism >/dev/null 2>&1; then
  echo '{"error":"prism CLI not found on PATH"}' >&2
  exit 1
fi

prism status --json
