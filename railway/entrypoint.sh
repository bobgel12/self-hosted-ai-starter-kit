#!/bin/sh
set -e

# Railway injects PORT; n8n listens on N8N_PORT
export N8N_PORT="${PORT:-5678}"

mkdir -p /data/shared/rotem/history /data/shared/rotem/outbox /data/shared/rotem/logs

if [ -n "$ROTEM_FARMS_JSON" ]; then
  printf '%s' "$ROTEM_FARMS_JSON" > /data/shared/rotem/farms.json
elif [ ! -f /data/shared/rotem/farms.json ]; then
  echo "ERROR: Set ROTEM_FARMS_JSON or mount farms.json on /data/shared/rotem/farms.json" >&2
  exit 1
fi

if [ -z "$(n8n list:workflow --onlyId 2>/dev/null || true)" ]; then
  echo "Importing n8n workflows..."
  n8n import:workflow --separate --input=/demo-data/workflows || true
else
  echo "Updating n8n workflows..."
  n8n import:workflow --separate --input=/demo-data/workflows || true
fi

echo "Importing SMTP credential (optional, for local SMTP only)..."
node /import-smtp-credential.js || true

exec n8n start
