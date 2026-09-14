#!/bin/bash
# Rental stage sync check, on demand. The check itself lives in the app
# (artifacts/api-server/src/lib/stage-sync-check.ts) — ONE implementation —
# and also runs by itself daily at 09:00 Bali, pushing the owner on failure.
#
#   bash /opt/whatcan/scripts/rental-stage-sync-check.sh          # last 24 h
#   bash /opt/whatcan/scripts/rental-stage-sync-check.sh 72       # last 72 h
#
# Exit code 1 when any check fails: a card below its floor, a stage_events row
# amoCRM never received, or a reply typed on the broker's phone with no stage
# decision within 10 minutes.
set -euo pipefail
cd /opt/whatcan
TOKEN=$(grep -E '^ADMIN_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d "\"'")
PORT=$(grep -E '^PORT=' .env | head -1 | cut -d= -f2- | tr -d "\"'" || true)
OUT=$(curl -sS --max-time 900 -H "x-admin-token: ${TOKEN}" \
  "http://127.0.0.1:${PORT:-3000}/api/admin/rental-stage-sync-check?hours=${1:-24}")
echo "$OUT" | python3 -m json.tool
echo "$OUT" | python3 -c 'import sys, json; sys.exit(0 if json.load(sys.stdin).get("ok") else 1)'
