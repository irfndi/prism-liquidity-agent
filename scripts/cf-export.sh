#!/usr/bin/env bash
# Export Cloudflare data resources to a dated local archive (read-only on CF side).
# Usage: ./scripts/cf-export.sh [OUT_DIR]
# Archive layout: <OUT_DIR>/cf-export-<YYYYMMDD-HHMMSS>/{prism-db.sql,backups/,telemetry/,MANIFEST.sha256}
# R2 sync needs S3-compatible credentials: R2_ENDPOINT (+ AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY).

set -euo pipefail

OUT_DIR="${1:-docs/plan/cf-export}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$OUT_DIR/cf-export-$STAMP"
mkdir -p "$DEST/backups" "$DEST/telemetry"

# D1 export (prism-db) — read-only dump. --remote is required: `wrangler d1
# export` silently exports the empty local wrangler-dev replica otherwise
# (its `remote` flag has no yargs default, and the handler branches
# `if (remote) exportRemotely(); else exportLocal();` — confirmed by reading
# wrangler-dist/cli.js). --skip-confirmation suppresses the interactive
# "database will be unavailable" prompt so this stays scriptable.
wrangler d1 export prism-db --remote --skip-confirmation --output "$DEST/prism-db.sql"

# R2 object listing + content sync both need S3-compatible credentials —
# wrangler's CLI has no bucket-listing subcommand (only object get/put/delete
# at the object level: https://developers.cloudflare.com/r2/reference/wrangler-commands/),
# so both steps live behind the same R2_ENDPOINT gate via the S3 API.
if [ -n "${R2_ENDPOINT:-}" ]; then
  aws s3 ls "s3://prism-backups" --recursive --endpoint-url "$R2_ENDPOINT" > "$DEST/backups-list.txt"
  aws s3 ls "s3://prism-telemetry" --recursive --endpoint-url "$R2_ENDPOINT" > "$DEST/telemetry-list.txt"
  aws s3 sync "s3://prism-backups" "$DEST/backups" --endpoint-url "$R2_ENDPOINT"
  aws s3 sync "s3://prism-telemetry" "$DEST/telemetry" --endpoint-url "$R2_ENDPOINT"
else
  echo "R2_ENDPOINT unset — R2 object listing and sync both skipped (need S3-compatible creds)" >&2
fi

# Checksummed manifest of everything captured.
(cd "$DEST" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256.tmp && mv MANIFEST.sha256.tmp MANIFEST.sha256)

echo "archive: $DEST"
