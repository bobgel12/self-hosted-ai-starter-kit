#!/bin/sh
set -e

# Railway injects PORT; n8n listens on N8N_PORT
export N8N_PORT="${PORT:-5678}"

mkdir -p /data/shared/rotem/history /data/shared/rotem/outbox /data/shared/rotem/logs /data/shared/rotem/lib

# Volume at /data/shared would otherwise keep stale libs from the first deploy.
# Always refresh code + thresholds from the image.
if [ -d /opt/rotem/lib ]; then
  echo "Refreshing Rotem libs from image..."
  cp -a /opt/rotem/lib/. /data/shared/rotem/lib/
fi
if [ -f /opt/rotem/thresholds.json ]; then
  cp -a /opt/rotem/thresholds.json /data/shared/rotem/thresholds.json
fi

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

# Ensure the Rotem overview workflow is published so webhooks + schedule run.
echo "Publishing Poultry RotemNet Daily Overview workflow..."
n8n publish:workflow --id=R7rzl5TsKVrVR7gg || true

echo "Importing SMTP credential (optional, for local SMTP only)..."
node /import-smtp-credential.js || true

exec n8n start
