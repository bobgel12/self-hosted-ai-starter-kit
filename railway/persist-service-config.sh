#!/bin/sh
# Copy the settings that used to live in railway.toml onto the Railway service.
# Config-as-code stops being read on 2026-12-01, and a deleted railway.toml is
# not applied on the next upload until these values are stored on the service.
#
# This patches only those fields. It does not change variables, volumes, or
# other services, and it does not print RAILWAY_TOKEN.
set -eu

SERVICE="${RAILWAY_SERVICE:-rotem-poultry-n8n}"

dashboard_help() {
  cat >&2 <<EOF

The deploy token could not store these settings on ${SERVICE}.
Set them on the service before the next deploy (Railway dashboard →
${SERVICE} → Settings). Config-as-code overrides the dashboard until the
Railway Config File path is empty and railway.toml is gone, and after
2026-12-01 Railway stops reading that file.

  Builder: Dockerfile
  Dockerfile path: railway/Dockerfile
  Healthcheck path: /healthz
  Healthcheck timeout: 300
  Restart policy: On failure
  Max restart retries: 5
  Railway Config File: empty

Do not set a start command. railway.toml had none; the image starts at
/entrypoint.sh. Leave /data/shared mounted.

A project token sometimes cannot commit service settings. After the fields
above are saved, set the GitHub Actions variable RAILWAY_SERVICE_CONFIG_SAVED
to true and re-run the deploy. That skips this write. Do not set the variable
until the dashboard shows these values.
EOF
}

if [ "${PERSIST_INNER:-}" != "1" ]; then
  case "$(printf '%s' "${RAILWAY_SERVICE_CONFIG_SAVED:-}" | tr '[:upper:]' '[:lower:]')" in
    true|yes|1)
      echo "RAILWAY_SERVICE_CONFIG_SAVED is set; not writing service settings."
      echo "Confirm ${SERVICE} still has the Dockerfile path, /healthz, and the on-failure restart policy."
      exit 0
      ;;
  esac

  if [ -z "${RAILWAY_TOKEN:-}" ]; then
    if ! railway whoami >/dev/null 2>&1; then
      echo "Railway auth missing. Set RAILWAY_TOKEN or run railway login." >&2
      dashboard_help
      exit 1
    fi
  fi

  # railway environment edit ignores --service-config when stdin is not a TTY
  # and tries to read a JSON patch instead. Re-run under a pty so the flags apply.
  if [ ! -t 0 ]; then
    if ! command -v script >/dev/null 2>&1; then
      echo "script(1) is required to save Railway settings when stdin is not a terminal." >&2
      dashboard_help
      exit 1
    fi
    typescript="$(mktemp)"
    set +e
    PERSIST_INNER=1 script -q -e -c "sh \"$0\"" "$typescript"
    status=$?
    set -e
    rm -f "$typescript"
    if [ "$status" -ne 0 ]; then
      dashboard_help
      exit "$status"
    fi
    exit 0
  fi
fi

echo "Saving Dockerfile builder, healthcheck, and restart policy on ${SERVICE}."
output="$(mktemp)"
set +e
railway environment edit \
  --service-config "$SERVICE" build.builder DOCKERFILE \
  --service-config "$SERVICE" build.dockerfilePath railway/Dockerfile \
  --service-config "$SERVICE" deploy.healthcheckPath /healthz \
  --service-config "$SERVICE" deploy.healthcheckTimeout 300 \
  --service-config "$SERVICE" deploy.restartPolicyType ON_FAILURE \
  --service-config "$SERVICE" deploy.restartPolicyMaxRetries 5 \
  --service-config "$SERVICE" configFile "" \
  --message "Persist railway.toml settings onto ${SERVICE}" \
  --json >"$output" 2>&1
status=$?
set -e
cat "$output"
if [ "$status" -ne 0 ]; then
  rm -f "$output"
  exit "$status"
fi
if ! grep -q '"committed": true' "$output"; then
  echo "Railway did not commit the service settings." >&2
  rm -f "$output"
  exit 1
fi
rm -f "$output"
echo "Service settings committed for ${SERVICE}."
