#!/usr/bin/env bash
# Railway setup for Poultry RotemNet n8n workflow.
#
# Prerequisites:
#   railway login
#
# Usage:
#   ./railway/setup.sh           # link project, deploy, configure
#   ./railway/setup.sh --deploy  # same (alias)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WORKSPACE_ID="${RAILWAY_WORKSPACE:-45ce364a-5da8-4698-986f-739379779a78}"
PROJECT_NAME="${RAILWAY_PROJECT:-rotem-poultry-n8n}"
SERVICE_NAME="${RAILWAY_SERVICE:-rotem-poultry-n8n}"

if ! command -v railway >/dev/null 2>&1; then
  echo "Install Railway CLI: https://docs.railway.com/guides/cli"
  exit 1
fi

if ! railway whoami >/dev/null 2>&1; then
  echo "Not logged in. Run: railway login"
  exit 1
fi

echo "Logged in as: $(railway whoami)"

if [ ! -f .railway/project.json ]; then
  echo "Creating project ${PROJECT_NAME}..."
  railway init -n "$PROJECT_NAME" -w "$WORKSPACE_ID"
fi

echo "Deploying n8n service (creates service if new)..."
railway up --detach -m "Deploy rotem n8n"

echo "Linking service ${SERVICE_NAME}..."
railway service link "$SERVICE_NAME" 2>/dev/null || railway service link

echo "Adding PostgreSQL..."
if ! railway add -d postgres 2>/dev/null; then
  echo ""
  echo "Could not add Postgres via CLI (sometimes needs dashboard)."
  echo "In Railway project, click '+ New' → Database → PostgreSQL, then re-run this script."
  echo "Project: https://railway.com/project/$(jq -r .project .railway/project.json 2>/dev/null || echo '<see dashboard>')"
  echo ""
fi

N8N_KEY="${N8N_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
N8N_JWT="${N8N_USER_MANAGEMENT_JWT_SECRET:-$(openssl rand -hex 32)}"

echo "Setting environment variables..."
railway variable set \
  DB_TYPE=postgresdb \
  'DB_POSTGRESDB_HOST=${{Postgres.PGHOST}}' \
  'DB_POSTGRESDB_PORT=${{Postgres.PGPORT}}' \
  'DB_POSTGRESDB_DATABASE=${{Postgres.PGDATABASE}}' \
  'DB_POSTGRESDB_USER=${{Postgres.PGUSER}}' \
  'DB_POSTGRESDB_PASSWORD=${{Postgres.PGPASSWORD}}' \
  "N8N_ENCRYPTION_KEY=${N8N_KEY}" \
  "N8N_USER_MANAGEMENT_JWT_SECRET=${N8N_JWT}" \
  N8N_DIAGNOSTICS_ENABLED=false \
  N8N_PERSONALIZATION_ENABLED=false \
  EXECUTIONS_TIMEOUT=3600 \
  EXECUTIONS_TIMEOUT_MAX=3600 \
  NODE_FUNCTION_ALLOW_BUILTIN=fs,path,crypto,http,https,buffer,zlib,url \
  NODE_FUNCTION_ALLOW_EXTERNAL='*' \
  'NODES_EXCLUDE=[]' \
  N8N_RESTRICT_FILE_ACCESS_TO=/data/shared \
  ROTEM_HOUSE_CONCURRENCY=4 \
  N8N_HOST=0.0.0.0 \
  N8N_PROTOCOL=https \
  'WEBHOOK_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}/' \
  'N8N_EDITOR_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}/' \
  -s "$SERVICE_NAME"

if [ -f shared/rotem/farms.json ]; then
  echo "Setting ROTEM_FARMS_JSON..."
  cat shared/rotem/farms.json | railway variable set ROTEM_FARMS_JSON --stdin
fi

echo "Ensuring volume at /data/shared..."
railway volume list 2>/dev/null | grep -q /data/shared || railway volume add --mount-path /data/shared

echo "Ensuring public domain..."
railway domain 2>/dev/null || true

echo "Redeploying with final config..."
railway redeploy --yes 2>/dev/null || railway up --detach -m "Redeploy with postgres and volume"

echo ""
echo "Done."
echo "  URL: run 'railway domain' to show public URL"
echo "  Logs: railway logs"
echo "  Open n8n → activate 'Poultry RotemNet Daily Overview' → Manual Test Trigger"
