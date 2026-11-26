# Railway service settings

`railway.toml` config-as-code is deprecated. Railway stops reading it on
2026-12-01. This file is the replacement description for
`rotem-poultry-n8n`.

Deploys do not apply this file automatically. `.github/workflows/deploy-railway.yml`
runs `railway/persist-service-config.sh` before `railway up`, which commits the
same values onto the service with `railway environment edit`. That patch does
not change variables or the `/data/shared` volume.

`railway config apply` can detach a volume this file does not mention. Read
`railway config plan` before any apply, and do not apply a plan that removes
`/data/shared`.

Install the SDK before a local plan (`npm install railway` from the repo root).
There is no start command. The image entrypoint is `/entrypoint.sh`.

## Dashboard fields

If the deploy token cannot commit service settings, set these on
`rotem-poultry-n8n` → Settings before the next deploy:

| Field | Value |
| --- | --- |
| Builder | Dockerfile |
| Dockerfile path | `railway/Dockerfile` |
| Healthcheck path | `/healthz` |
| Healthcheck timeout | `300` |
| Restart policy | On failure |
| Max restart retries | `5` |
| Railway Config File | empty |
| Start command | empty |

Leave the `/data/shared` volume mounted. After those fields are saved, set the
GitHub Actions variable `RAILWAY_SERVICE_CONFIG_SAVED` to `true` and re-run the
deploy. Do not set that variable first.
