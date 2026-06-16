FROM n8nio/n8n:latest

USER root

# Rotem workflow libs and config (credentials written at startup from ROTEM_FARMS_JSON)
COPY shared/rotem/lib /data/shared/rotem/lib
COPY shared/rotem/thresholds.json /data/shared/rotem/thresholds.json
COPY shared/rotem/history/.gitkeep /data/shared/rotem/history/.gitkeep
COPY shared/rotem/outbox/.gitkeep /data/shared/rotem/outbox/.gitkeep
COPY shared/rotem/logs/.gitkeep /data/shared/rotem/logs/.gitkeep

COPY n8n/demo-data/workflows /demo-data/workflows
COPY n8n/n8n-task-runners.json /etc/n8n-task-runners.json

COPY railway/entrypoint.sh /entrypoint.sh
COPY railway/import-smtp-credential.js /import-smtp-credential.js
RUN chmod +x /entrypoint.sh \
  && mkdir -p /data/shared/rotem/history /data/shared/rotem/outbox /data/shared/rotem/logs \
  && chown -R node:node /data/shared /demo-data /entrypoint.sh /import-smtp-credential.js

USER node

ENTRYPOINT ["/entrypoint.sh"]
