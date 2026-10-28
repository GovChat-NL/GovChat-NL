# GovChat-NL monorepo migration

## Migration plan and ownership map

| Source | Destination | Ownership / rationale |
|---|---|---|
| `GovChat-NL-LibreChat` repository root | Monorepo root | Kept in place: Compose entrypoints, LibreChat config, Nginx, stack overlay, LiteLLM, n8n runtime settings, tests, fixtures, scripts and deployment docs retain root-relative paths. |
| `GovChat-NL-Agents` repository | [`agents/`](../agents/) | Workflow exports and agent documentation. Bootstrap reads `agents/n8n/workflows` from the monorepo. |
| `GovChat-AdminOverlay` repository | [`services/admin-overlay/`](../services/admin-overlay/) | Keeps standalone source and provenance. Compose builds `services/admin-overlay/admin`; the Admin service provides LibreChat integration endpoints. |
| Stack-owned bridge model configuration | [`bridge/models.json`](../bridge/models.json) | Deployment config only, not bridge service source. |
| `n8n-openai-bridge` repository | External repository | Separate upstream-derived service with its own releases and tests. Stack consumes a digest-pinned image. |

### Admin Overlay ownership audit

The LibreChat Compose service builds only `services/admin-overlay/admin` and mounts the monorepo's `overlay/defaults/` at `/app/defaults`. The admin server/views and API endpoints (including image jobs, crawler, transcript sessions and policy editor features) are used by the LibreChat deployment. The LibreChat overlay's `overlay/defaults/{loader.js,custom.css,apps.json,help-content.json}` remains a distinct component served by Nginx.

The imported Admin Overlay project also contains standalone Open WebUI deployment artifacts: root-level `loader.js`, `custom.css`, `apps.json`, `help-content.json`, Open WebUI Compose examples, and `admin/defaults/`. Those files are preserved for provenance/standalone use, but are **not** the active LibreChat defaults: Compose bind-mounts the stack's `overlay/defaults` over `/app/defaults`. Similar names do not make these assets interchangeable.

## Paths and architecture decisions

- Root Compose files remain at repository root to avoid changing deployment entrypoints and the existing `/opt/librechat` host mounts.
- [`n8n/bootstrap.js`](../n8n/bootstrap.js) is mounted into the n8n image and run as the one-shot bootstrap. It scans sorted `*.json` exports from `./agents/n8n/workflows` and its subfolders and derives workflow IDs from each export; a per-file environment list and external workflow source are not needed.
- Admin build context is `./services/admin-overlay/admin`; LibreChat runtime defaults stay at `./overlay/defaults`.
- Bridge config moved from a directory whose name resembled the external bridge checkout to `bridge/models.json`.
- Optional bridge development is configured in [`docker-compose.bridge-dev.yml`](../docker-compose.bridge-dev.yml). With the external source checkout at sibling path `../n8n-openai-bridge`, run:

  ```sh
  docker compose -f docker-compose.yml -f docker-compose.bridge-dev.yml --env-file .env up -d --build n8n-openai-bridge
  ```

  This is development-only and is not required for a clean checkout. Bridge source remains outside the monorepo Git tree.
- The request flow remains LibreChat → bridge → n8n webhook; n8n calls LiteLLM directly; the stream and tool-lifecycle events return through the bridge to LibreChat's native tool cards.

## Bridge pin and compatibility record

The standard Compose image uses OCI index digest `sha256:d61947deaa1b094d03fbdb268fbaf9f35766a792c8776d8014bf7d1188f0232d`, resolved from the existing integration tag `ghcr.io/sveneisenschmidt/n8n-openai-bridge:pr-72`. `docker buildx imagetools inspect` reported this index and amd64/arm64 platform manifests. The deployment does not rely on mutable `latest`.

The separate GovChat-NL bridge checkout audited here is commit `8003d03` on `main`. The publisher/source revision for the existing `pr-72` artifact could not be tied independently to that fork commit during the migration. Do not claim the checkout and artifact are byte-for-byte identical. Before switching to a GovChat-NL release image, verify package visibility and compatibility with the live tool lifecycle protocol, update the pinned digest, and rerun integration tests.

Reference configuration baseline from the LibreChat checkout: LibreChat image `v0.8.7`; n8n default `2.25.7`; bridge digest above; LibreChat stack/overlay source commit `a4b9e67`. This is a reproducible configuration record, **not evidence of completed end-to-end or production acceptance testing**. Native tool cards require a compatible bridge, streaming n8n workflow, and LibreChat runtime overlay tested together.

## Git provenance, source of truth and migration safety

| Repository | Remote / default branch | HEAD at audit | Worktree |
|---|---|---|---|
| LibreChat stack | `https://github.com/GovChat-NL/GovChat-NL-LibreChat.git`; local branch `feature/monorepo-migration`, remote default `main` | `a4b9e67` | Clean; feature branch tracked its origin branch. |
| Agents | `https://github.com/GovChat-NL/GovChat-NL-Agents.git`; default `main` | `58319d0` | Clean. The workspace description said this was not a Git checkout, but audit found a valid Git repository and the full workflow tree. |
| Admin Overlay | `https://github.com/GovChat-NL/GovChat-AdminOverlay.git`; default `main` | `8d36b5e` | Clean. |
| Bridge | `https://github.com/GovChat-NL/n8n-openai-bridge.git`; default `main` | `8003d03` | Clean; remains separate. |

Agents and Admin Overlay were imported with non-squashed Git subtree imports at `agents/` and `services/admin-overlay/`; their source commit histories remain reachable. Local recovery checkpoint: `backup/pre-monorepo-migration-20261022` at `a4b9e67`. From migration review/merge onward, this monorepo is the source of truth for deployment, workflows and the integrated Admin service. No push, remote repository creation, source-repository archival or deletion was performed.

The task described two uncommitted edits in the LibreChat Compose and Nginx files. `git status`, `git diff` and `git diff --cached` showed the checkout clean at audit time, so those edits were not present to preserve. The checkpoint retains the audited original HEAD. Reconcile against any other checkout before synchronizing it.

The separate `feature/live-tool-calling` branch was not checked out, merged, or committed into this migration. Its live-card implementation remains a separate feature decision; this branch records the request-flow boundary and explicitly notes that its runtime patches are not active here.

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
