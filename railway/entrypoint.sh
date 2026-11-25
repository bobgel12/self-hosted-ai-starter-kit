#!/bin/sh
set -e

# Railway injects PORT; n8n listens on N8N_PORT
export N8N_PORT="${PORT:-5678}"

# Always overwrite. n8n's default task-runner timeout is 300s. A value of 600
# used to survive the old "< 600" clamp, and bobby-angel on current main was
# measured at ~9 minutes. Code nodes that remain still need the full hour.
export N8N_RUNNERS_TASK_TIMEOUT=3600
export EXECUTIONS_TIMEOUT=3600
export EXECUTIONS_TIMEOUT_MAX=3600
export ROTEM_REPORT_PORT="${ROTEM_REPORT_PORT:-8791}"
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
if [ ! -f /data/shared/rotem/lib/report-server.js ]; then
  echo "ERROR: report-server.js missing after image refresh" >&2
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

# Long Rotem fetches run here, not in the JS task runner (default 300s abort).
echo "Starting Rotem report server..."
nohup node /data/shared/rotem/lib/report-server.js >> /data/shared/rotem/logs/report-server.log 2>&1 &
server_ok=0
server_try=0
while [ "$server_try" -lt 50 ]; do
  if node -e 'require("http").get("http://127.0.0.1:'"$ROTEM_REPORT_PORT"'/health",(r)=>{r.resume();process.exit(r.statusCode===200?0:1)}).on("error",()=>process.exit(1))'; then
    server_ok=1
    break
  fi
  server_try=$((server_try + 1))
  sleep 0.2
done
if [ "$server_ok" -ne 1 ]; then
  echo "ERROR: Rotem report server did not become healthy on 127.0.0.1:${ROTEM_REPORT_PORT}" >&2
  cat /data/shared/rotem/logs/report-server.log >&2 || true
  exit 1
fi

# import:workflow without --activeState=fromJson deactivates a published
# workflow. --activeState=fromJson throws unless executions mode is queue.
# Unpublish, import the new draft, then publish. Fail the boot if publish
# fails — `|| true` used to leave the previous published snapshot running.
echo "Importing n8n workflows..."
n8n unpublish:workflow --id=R7rzl5TsKVrVR7gg || true
n8n unpublish:workflow --id=rotemImageStamp001 || true
n8n import:workflow --separate --input=/demo-data/workflows
echo "Publishing Poultry RotemNet Daily Overview workflow..."
n8n publish:workflow --id=R7rzl5TsKVrVR7gg
n8n publish:workflow --id=rotemImageStamp001

echo "Importing SMTP credential (optional, for local SMTP only)..."
node /import-smtp-credential.js || true

exec n8n start
