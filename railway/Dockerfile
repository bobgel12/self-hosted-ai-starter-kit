FROM n8nio/n8n:latest

USER root

# Bake timeouts into the image so Railway still works even when dashboard
# env vars were never updated after setup.sh (default runner timeout is 300s;
# bobby-angel needs ~6–8 minutes for 8 houses).
ENV N8N_RUNNERS_TASK_TIMEOUT=3600 \
    EXECUTIONS_TIMEOUT=3600 \
    EXECUTIONS_TIMEOUT_MAX=3600 \
    NODE_FUNCTION_ALLOW_BUILTIN=fs,path,crypto,http,https,buffer,zlib,url \
    NODE_FUNCTION_ALLOW_EXTERNAL=* \
    N8N_RESTRICT_FILE_ACCESS_TO=/data/shared \
    ROTEM_DATA_ROOT=/data/shared/rotem \
    ROTEM_HOUSE_CONCURRENCY=4

# Bake Rotem libs outside the persistent volume so deploys always refresh code.
# Entrypoint copies them onto /data/shared/rotem at startup.
COPY shared/rotem/lib /opt/rotem/lib
COPY shared/rotem/thresholds.json /opt/rotem/thresholds.json
COPY shared/rotem/history/.gitkeep /opt/rotem/history/.gitkeep
COPY shared/rotem/outbox/.gitkeep /opt/rotem/outbox/.gitkeep
COPY shared/rotem/logs/.gitkeep /opt/rotem/logs/.gitkeep

# Fingerprint baked libs so entrypoint can refuse to start on a stale volume.
ARG ROTEM_IMAGE_SHA=unknown
ARG RAILWAY_GIT_COMMIT_SHA=unknown
RUN set -eu; \
  marker_count="$(grep -c resolveGatewayFromAccounts /opt/rotem/lib/rotem-client.js || true)"; \
  if [ "$marker_count" -lt 1 ]; then \
    echo "ERROR: baked rotem-client.js is missing resolveGatewayFromAccounts" >&2; \
    exit 1; \
  fi; \
  image_sha="${ROTEM_IMAGE_SHA}"; \
  if [ "$image_sha" = "unknown" ] && [ "${RAILWAY_GIT_COMMIT_SHA}" != "unknown" ] && [ -n "${RAILWAY_GIT_COMMIT_SHA}" ]; then \
    image_sha="${RAILWAY_GIT_COMMIT_SHA}"; \
  fi; \
  { \
    echo "imageSha=${image_sha}"; \
    echo "builtAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; \
    echo "resolveGatewayFromAccounts=${marker_count}"; \
    md5sum /opt/rotem/lib/*.js; \
  } > /opt/rotem/IMAGE_STAMP.txt

COPY n8n/demo-data/workflows /demo-data/workflows
COPY n8n/n8n-task-runners.json /etc/n8n-task-runners.json

COPY railway/entrypoint.sh /entrypoint.sh
COPY railway/import-smtp-credential.js /import-smtp-credential.js
RUN chmod +x /entrypoint.sh \
  && mkdir -p /data/shared/rotem/history /data/shared/rotem/outbox /data/shared/rotem/logs \
  && chown -R node:node /opt/rotem /data/shared /demo-data /entrypoint.sh /import-smtp-credential.js

USER node

ENTRYPOINT ["/entrypoint.sh"]
