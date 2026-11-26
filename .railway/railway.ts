import { defineRailway, project, service } from "railway/iac";

// Settings that used to live in railway.toml for rotem-poultry-n8n.
// This partial does not declare Postgres, variables, or the /data/shared volume.
// Do not `railway config apply` a plan that detaches or deletes that volume.
// Deploys write these fields with railway/persist-service-config.sh.
export const partial = "rotem-poultry-n8n";

export default defineRailway(() => {
  const n8n = service("rotem-poultry-n8n", {
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "railway/Dockerfile",
    },
    healthcheck: "/healthz",
    healthcheckTimeout: 300,
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
  });

  return project("rotem-poultry-n8n", {
    resources: [n8n],
  });
});
