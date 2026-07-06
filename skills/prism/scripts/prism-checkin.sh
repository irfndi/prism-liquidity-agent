#!/usr/bin/env bash
set -euo pipefail

# Universal helper script for the Prism skill.
# Returns a short markdown summary suitable for Telegram/Discord/Slack/WhatsApp.

if ! command -v prism >/dev/null 2>&1; then
  echo "🔺 Prism CLI not found on PATH. Install Prism first." >&2
  exit 1
fi

prism status --message
