#!/bin/sh
set -e

# Railway injects PORT; n8n listens on N8N_PORT
export N8N_PORT="${PORT:-5678}"

# Belt-and-suspenders: bobby-angel needs ~6–8 minutes; n8n's default runner
# timeout is 300s. Raise empty/too-low dashboard overrides at boot.
if [ -z "${N8N_RUNNERS_TASK_TIMEOUT}" ] || [ "${N8N_RUNNERS_TASK_TIMEOUT}" -lt 600 ] 2>/dev/null; then
  export N8N_RUNNERS_TASK_TIMEOUT=3600
fi
if [ -z "${EXECUTIONS_TIMEOUT}" ] || [ "${EXECUTIONS_TIMEOUT}" -lt 600 ] 2>/dev/null; then
  export EXECUTIONS_TIMEOUT=3600
fi
if [ -z "${EXECUTIONS_TIMEOUT_MAX}" ] || [ "${EXECUTIONS_TIMEOUT_MAX}" -lt 600 ] 2>/dev/null; then
  export EXECUTIONS_TIMEOUT_MAX=3600
fi
export ROTEM_DATA_ROOT="${ROTEM_DATA_ROOT:-/data/shared/rotem}"
export ROTEM_HOUSE_CONCURRENCY="${ROTEM_HOUSE_CONCURRENCY:-4}"
echo "Timeouts: N8N_RUNNERS_TASK_TIMEOUT=${N8N_RUNNERS_TASK_TIMEOUT} EXECUTIONS_TIMEOUT=${EXECUTIONS_TIMEOUT} ROTEM_HOUSE_CONCURRENCY=${ROTEM_HOUSE_CONCURRENCY}"

mkdir -p /data/shared/rotem/history /data/shared/rotem/outbox /data/shared/rotem/logs /data/shared/rotem/lib

# Volume at /data/shared would otherwise keep stale libs from the first deploy.
# Always refresh code + thresholds from the image — and refuse to boot if the
# bake is missing (that used to silently leave old ConnectionToken bugs live).
if [ ! -d /opt/rotem/lib ] || [ ! -f /opt/rotem/lib/rotem-client.js ]; then
  echo "ERROR: /opt/rotem/lib missing from image. Dockerfile bake failed; refusing to start with possibly stale volume libs." >&2
  exit 1
fi

echo "Refreshing Rotem libs from image..."
cp -a /opt/rotem/lib/. /data/shared/rotem/lib/
if [ -f /opt/rotem/thresholds.json ]; then
  cp -a /opt/rotem/thresholds.json /data/shared/rotem/thresholds.json
fi
if [ -f /opt/rotem/IMAGE_STAMP.txt ]; then
  cp -a /opt/rotem/IMAGE_STAMP.txt /data/shared/rotem/IMAGE_STAMP.txt
fi

if ! grep -q 'resolveGatewayFromAccounts' /data/shared/rotem/lib/rotem-client.js; then
  echo "ERROR: volume lib still missing resolveGatewayFromAccounts after image refresh" >&2
  exit 1
fi
if ! grep -q 'GATEWAY_DISCONNECTED' /data/shared/rotem/lib/rotem-client.js; then
  echo "ERROR: volume lib still missing GATEWAY_DISCONNECTED handling after image refresh" >&2
  exit 1
fi

echo "Rotem lib stamp:"
sed -n '1,5p' /data/shared/rotem/IMAGE_STAMP.txt 2>/dev/null || echo "(no IMAGE_STAMP.txt)"

if [ -n "$ROTEM_FARMS_JSON" ]; then
  printf '%s' "$ROTEM_FARMS_JSON" > /data/shared/rotem/farms.json
elif [ ! -f /data/shared/rotem/farms.json ]; then
  echo "ERROR: Set ROTEM_FARMS_JSON or mount farms.json on /data/shared/rotem/farms.json" >&2
  exit 1
fi

# Soft-check gateway codes so bobby-angel empty-house regressions are obvious in logs.
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync("/data/shared/rotem/farms.json", "utf8"));
    for (const farm of cfg.farms || []) {
      if (!farm.rotemGatewayCode) {
        console.warn("WARN: farm", farm.id, "missing rotemGatewayCode in farms.json / ROTEM_FARMS_JSON");
      }
      if (!farm.rotemUsername || !farm.rotemPassword) {
        console.error("ERROR: farm", farm.id, "missing Rotem credentials");
        process.exit(1);
      }
    }
  '
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
