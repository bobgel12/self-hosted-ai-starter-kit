FROM n8nio/n8n:latest

USER root

# Bake Rotem libs outside the persistent volume so deploys always refresh code.
# Entrypoint copies them onto /data/shared/rotem at startup.
COPY shared/rotem/lib /opt/rotem/lib
COPY shared/rotem/thresholds.json /opt/rotem/thresholds.json
COPY shared/rotem/history/.gitkeep /opt/rotem/history/.gitkeep
COPY shared/rotem/outbox/.gitkeep /opt/rotem/outbox/.gitkeep
COPY shared/rotem/logs/.gitkeep /opt/rotem/logs/.gitkeep

COPY n8n/demo-data/workflows /demo-data/workflows
COPY n8n/n8n-task-runners.json /etc/n8n-task-runners.json

COPY railway/entrypoint.sh /entrypoint.sh
COPY railway/import-smtp-credential.js /import-smtp-credential.js
RUN chmod +x /entrypoint.sh \
  && mkdir -p /data/shared/rotem/history /data/shared/rotem/outbox /data/shared/rotem/logs \
  && chown -R node:node /opt/rotem /data/shared /demo-data /entrypoint.sh /import-smtp-credential.js

USER node

ENTRYPOINT ["/entrypoint.sh"]
