# GovChat-NL monorepo migration

## Migration plan and ownership map

| Source | Destination | Ownership / rationale |
|---|---|---|
| Current local stack checkout root (`GovChat-NL-LibreChat/`) | `GovChat-NL` repository root | Kept in place: Compose entrypoints, LibreChat config, Nginx, stack overlay, LiteLLM, n8n runtime settings, tests, fixtures, scripts and deployment docs retain root-relative paths. |
| `GovChat-NL-Agents` repository | [`agents/`](../agents/) | Workflow exports and agent documentation. Bootstrap reads `agents/n8n/workflows` from the monorepo. |
| `GovChat-AdminOverlay` repository | [`services/admin-overlay/`](../services/admin-overlay/) | Keeps standalone source and provenance. Compose builds `services/admin-overlay/admin` only when the `admin-overlay` profile is enabled; it is WIP and off by default. Beleidskompas needs it, because it keeps the Beleidskompas cases, so start the stack with `--profile admin-overlay` when Beleidskompas is used. |
| Stack-owned bridge model configuration | [`bridge/models.json`](../bridge/models.json) | Deployment config only, not bridge service source. |
| `n8n-openai-bridge` repository | External repository | Separate GovChat-NL-maintained service with its own releases and tests. Standard Compose builds its `main` branch directly. |

### Admin Overlay ownership audit

The optional `govchat-overlay-admin` Compose service builds `services/admin-overlay/admin` only under profile `admin-overlay`; it is WIP and disabled by default. When enabled, it mounts the monorepo's `overlay/defaults/` at `/app/defaults`. Its admin server/views and API endpoints (including image jobs, crawler, transcript sessions and policy editor features) are distinct from the always-on LibreChat overlay assets served by Nginx. Nginx resolves this optional API upstream at request time, so the proxy itself can start while the profile is disabled.

The imported Admin Overlay project also contains standalone Open WebUI deployment artifacts: root-level `loader.js`, `custom.css`, `apps.json`, `help-content.json`, Open WebUI Compose examples, and `admin/defaults/`. Those files are preserved for provenance/standalone use, but are **not** the active LibreChat defaults: Compose bind-mounts the stack's `overlay/defaults` over `/app/defaults`. Similar names do not make these assets interchangeable.

## Paths and architecture decisions

- Root Compose files remain at repository root to avoid changing deployment entrypoints and the existing `/opt/librechat` host mounts.
- [`n8n/bootstrap.js`](../n8n/bootstrap.js) is mounted into the n8n image and run as the one-shot bootstrap. It scans sorted `*.json` exports from `./agents/n8n/workflows` and its subfolders and derives workflow IDs from each export; a per-file environment list and external workflow source are not needed.
- Admin build context is `./services/admin-overlay/admin`; LibreChat runtime defaults stay at `./overlay/defaults`.
- Bridge config moved from a directory whose name resembled the external bridge checkout to `bridge/models.json`.
- Clone the bridge repository beside this checkout on `main`, then start the standard stack:

  ```sh
  git clone --depth 1 --branch main https://github.com/GovChat-NL/n8n-openai-bridge.git ../n8n-openai-bridge-main
  docker compose --env-file .env up -d
  ```

  The standard [`docker-compose.yml`](../docker-compose.yml) builds from that local sibling clone if the image is not present locally; no extra Compose override is needed. Rebuild after bridge source changes with `docker compose --env-file .env build n8n-openai-bridge`.
- The request flow remains LibreChat → bridge → n8n webhook; n8n calls LiteLLM directly; the stream and tool-lifecycle events return through the bridge to LibreChat's native tool cards.

## Bridge source and compatibility record

The standard Compose configuration builds from `../n8n-openai-bridge-main` and tags the resulting local image `govchat-nl/n8n-openai-bridge:main`. Clone that checkout from GovChat-NL's `main` branch; it includes the bridge sideband events used for native tool cards. The older upstream integration digest is historical only and is no longer used by Compose.

The GovChat-NL bridge `main` branch contains the promotion of the live tool-calling protocol. Compose now builds that maintained source branch rather than consuming the legacy upstream `pr-72` artifact; the exact source revision follows the local clone's checked-out commit rather than a pinned digest.

Reference configuration baseline from the LibreChat checkout: LibreChat image `v0.8.7`; n8n default `2.25.7`; GovChat-NL bridge main source; LibreChat stack/overlay source commit `a4b9e67`. This is a configuration record, **not evidence of completed end-to-end or production acceptance testing**. Native tool cards require a compatible bridge, streaming n8n workflow, and LibreChat runtime overlay tested together.

## Repository ownership and rename cutover

The LibreChat Compose stack and its deployment documentation are maintained in the GovChat-NL main repository. The former OpenWebUI files remain in the separate legacy repository. Workflow assets are maintained under `agents/`; the GovChat bridge remains a separate repository and is built by Compose from its `main` branch.

The GitHub repository names have been changed. The old OpenWebUI repository is now `GovChat-NL/GovChat-NL-legacy`, and the LibreChat stack is now `GovChat-NL/GovChat-NL`. The local stack checkout's `origin` should point to `https://github.com/GovChat-NL/GovChat-NL.git`; the legacy checkout should point to `https://github.com/GovChat-NL/GovChat-NL-legacy.git`.

The old `GovChat-NL/GovChat-NL` URL is now occupied by the LibreChat stack, so do not rely on a GitHub rename redirect to lead users to the legacy OpenWebUI files. The README in `GovChat-NL-legacy` is the user-facing pointer for existing deployments.

The live tool-calling producer is maintained in the separate bridge repository. The matching LibreChat and n8n runtime overlays are enabled by the standard Compose stack.

Only `.env.example` and tracked configuration belong in source control. Keep real `.env` files, credentials, database volumes, uploads/user data, runtime logs and build products local. The stack root ignore rules cover `.env` and `.env.*`; recheck staged files and secrets before any future commit.

## Verification checklist

From a clean monorepo clone:

```sh
docker compose --env-file .env.example config --quiet
node tests/agents/validate-workflows.js
node --check n8n/bootstrap.js
node --check services/admin-overlay/admin/server.js
```

The existing orchestrator and transcript validation scripts require a running stack and provider credentials. After startup, run `node tests/orchestrator/run-validation.js` (or `--only-text`) and `node tests/transcript/run-validation.js`. The imported Admin project defines no standalone test script; syntax/build and service-route checks are required. A real deployment also requires environment-specific host paths under `/opt/librechat` and secrets copied into the ignored `.env` from `.env.example`.

### Results from this migration session

| Check | Result |
|---|---|
| Standard Compose and local bridge override using `.env.example` | Passed (`docker compose ... config --quiet`, without unresolved-variable warnings). |
| Local workflow import tree | Passed: 11 configured exports present, valid JSON/workflow structure, 11 unique stable IDs. |
| Admin Overlay and changed JavaScript syntax | Passed with Node 20 in a disposable container. |
| Admin Overlay Docker build | Passed; `govchat-overlay-admin:local` image was created. |
| Compose bind/build paths | Required component paths checked. Removed the stale `./n8n/bootstrap` mount; the maintained one-shot bootstrap now lives in `n8n/bootstrap.js` and is bind-mounted explicitly. |
| Secret scan/status | No common key/private-key patterns found in tracked content; `.env`/`.env.local` are ignored and no local `.env` or staged source changes were present. This pattern check is not a substitute for an organizational secret scanner. |
| Subtree history | Passed: both source HEADs are ancestors of the monorepo branch; checkpoint branch retained. |
| Bridge protocol unit tests | Blocked: npm registry certificate validation failed in the disposable Node container (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`), so Jest dependencies were unavailable. No bridge source checkout was altered. |
| Live orchestrator, transcript and native tool-card E2E | Not run: no configured provider credentials/live test deployment. The checkout also contains no `LCSTEP` runtime parser or dedicated live-card test; this compatibility gap remains documented. |

Do not force-push, create a remote repository, archive or delete old source repositories without explicit review and approval.
